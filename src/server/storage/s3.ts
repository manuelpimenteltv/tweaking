import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { AppError } from "../errors";
import type { ObjectHead, ObjectStorageProvider, SignedRequest, StorageCapabilities, UploadedPart } from "./types";

export type S3Config = {
  endpoint?: string;
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  partChecksums: boolean;
  defaultExpiresInSeconds: number;
};

const SIGNING_BUCKET_SECONDS = 15 * 60;

/**
 * S3-compatible provider (AWS S3, Cloudflare R2, MinIO, Wasabi, B2).
 * Credentials stay on the server; the browser only ever receives presigned URLs.
 */
export class S3StorageProvider implements ObjectStorageProvider {
  readonly id = "s3";
  readonly capabilities: StorageCapabilities;
  private readonly client: S3Client;
  /** Signs URLs against the browser-facing endpoint (may differ from the internal one). */
  private readonly signer: S3Client;

  constructor(private readonly cfg: S3Config) {
    const base = {
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: cfg.forcePathStyle,
      // Only send checksums we compute ourselves; SDK defaults break some S3-compatible stores.
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
      responseChecksumValidation: "WHEN_REQUIRED" as const,
    };
    this.client = new S3Client({ ...base, endpoint: cfg.endpoint });
    this.signer = new S3Client({ ...base, endpoint: cfg.publicEndpoint ?? cfg.endpoint });
    this.capabilities = {
      presignedUpload: true,
      multipart: true,
      partChecksums: cfg.partChecksums,
      presignedDownload: true,
      rangeReads: true,
    };
  }

  private wrap<T>(op: string, p: Promise<T>): Promise<T> {
    return p.catch((err: unknown) => {
      if (err instanceof AppError) throw err;
      const name = (err as { name?: string })?.name ?? "Error";
      console.error(`[storage] ${op} failed`, err);
      throw new AppError("storage_error", `Storage operation failed (${op}: ${name}).`);
    });
  }

  /** Round signing time down so repeated renders produce identical, browser-cacheable URLs. */
  private signingDate(expiresIn: number) {
    if (expiresIn < SIGNING_BUCKET_SECONDS * 2) return new Date();
    return new Date(Math.floor(Date.now() / (SIGNING_BUCKET_SECONDS * 1000)) * SIGNING_BUCKET_SECONDS * 1000);
  }

  async createMultipartUpload(key: string, opts: { contentType: string }) {
    const res = await this.wrap(
      "createMultipartUpload",
      this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          ContentType: opts.contentType,
          ChecksumAlgorithm: this.cfg.partChecksums ? "SHA256" : undefined,
        }),
      ),
    );
    if (!res.UploadId) throw new AppError("storage_error", "Storage did not return an upload id.");
    return { uploadId: res.UploadId };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    opts: { checksumSha256Base64?: string; contentLength?: number; expiresInSeconds?: number },
  ): Promise<SignedRequest> {
    const expiresIn = opts.expiresInSeconds ?? this.cfg.defaultExpiresInSeconds;
    const useChecksum = this.cfg.partChecksums && !!opts.checksumSha256Base64;
    const command = new UploadPartCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: opts.contentLength,
      ChecksumSHA256: useChecksum ? opts.checksumSha256Base64 : undefined,
      ChecksumAlgorithm: useChecksum ? "SHA256" : undefined,
    });
    const headers: Record<string, string> = {};
    const signableHeaders = new Set<string>();
    if (useChecksum) {
      // Signed header: storage rejects the part unless the body hashes to this value.
      headers["x-amz-checksum-sha256"] = opts.checksumSha256Base64!;
      headers["x-amz-sdk-checksum-algorithm"] = "SHA256";
      signableHeaders.add("x-amz-checksum-sha256");
      signableHeaders.add("x-amz-sdk-checksum-algorithm");
    }
    const url = await this.wrap(
      "presignUploadPart",
      getSignedUrl(this.signer, command, { expiresIn, signableHeaders, unhoistableHeaders: signableHeaders }),
    );
    return { url, method: "PUT", headers, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
  }

  async listUploadedParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await this.wrap(
        "listParts",
        this.client.send(
          new ListPartsCommand({ Bucket: this.cfg.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
        ),
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber && p.ETag) {
          parts.push({ partNumber: p.PartNumber, etag: p.ETag, checksumSha256: p.ChecksumSHA256, size: p.Size });
        }
      }
      marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]) {
    const sorted: CompletedPart[] = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({
        PartNumber: p.partNumber,
        ETag: p.etag,
        ChecksumSHA256: this.cfg.partChecksums ? p.checksumSha256 : undefined,
      }));
    const res = await this.wrap(
      "completeMultipartUpload",
      this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: sorted },
        }),
      ),
    );
    return { etag: res.ETag ?? null };
  }

  async abortMultipartUpload(key: string, uploadId: string) {
    await this.wrap(
      "abortMultipartUpload",
      this.client.send(new AbortMultipartUploadCommand({ Bucket: this.cfg.bucket, Key: key, UploadId: uploadId })),
    ).catch((err) => {
      // Already completed/aborted uploads are not an error for the caller.
      if ((err as AppError).code !== "storage_error") throw err;
    });
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, etag: res.ETag ?? null, contentType: res.ContentType ?? null };
    } catch (err) {
      if (err instanceof NotFound || (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      return this.wrap("head", Promise.reject(err));
    }
  }

  async presignDownload(
    key: string,
    opts: {
      filename?: string;
      contentType?: string;
      disposition?: "inline" | "attachment";
      expiresInSeconds?: number;
      internal?: boolean;
    },
  ) {
    const expiresIn = opts.expiresInSeconds ?? this.cfg.defaultExpiresInSeconds;
    const disposition = opts.disposition ?? "attachment";
    const command = new GetObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ResponseContentDisposition: opts.filename ? contentDisposition(disposition, opts.filename) : disposition,
      ResponseContentType: opts.contentType,
    });
    const client = opts.internal ? this.client : this.signer;
    return this.wrap("presignDownload", getSignedUrl(client, command, { expiresIn, signingDate: this.signingDate(expiresIn) }));
  }

  async getStream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const res = await this.wrap(
      "getObject",
      this.client.send(
        new GetObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      ),
    );
    if (!res.Body) throw new AppError("storage_error", "Empty object body.");
    return res.Body as Readable;
  }

  async put(key: string, body: Buffer, opts: { contentType: string; cacheControl?: string }) {
    await this.wrap(
      "putObject",
      this.client.send(
        new PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          Body: body,
          ContentType: opts.contentType,
          CacheControl: opts.cacheControl,
        }),
      ),
    );
  }

  async putFile(key: string, path: string, opts: { contentType: string; cacheControl?: string }) {
    const { size } = await stat(path);
    await this.wrap(
      "putObject",
      this.client.send(
        new PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: size,
          ContentType: opts.contentType,
          CacheControl: opts.cacheControl,
        }),
      ),
    );
    return size;
  }

  async delete(key: string) {
    await this.wrap("deleteObject", this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key })));
  }
}

/** RFC 6266 Content-Disposition with an ASCII fallback and UTF-8 filename*. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
