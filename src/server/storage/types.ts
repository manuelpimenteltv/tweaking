import type { Readable } from "node:stream";

/**
 * Provider-independent storage contract. Native object stores (platform bucket,
 * customer S3/R2) implement ObjectStorageProvider. Drive-style providers
 * (Google Drive, Dropbox — Phase 5) implement ExternalConnector instead.
 * See docs/ARCHITECTURE.md §11.
 */
export type StorageCapabilities = {
  presignedUpload: boolean;
  multipart: boolean;
  partChecksums: boolean;
  presignedDownload: boolean;
  rangeReads: boolean;
};

export type SignedRequest = { url: string; method: "PUT" | "GET"; headers: Record<string, string>; expiresAt: string };

export type UploadedPart = { partNumber: number; etag: string; checksumSha256?: string; size?: number };

export type ObjectHead = { size: number; etag: string | null; contentType: string | null };

export interface ObjectStorageProvider {
  readonly id: string;
  readonly capabilities: StorageCapabilities;

  createMultipartUpload(key: string, opts: { contentType: string }): Promise<{ uploadId: string }>;
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    opts: { checksumSha256Base64?: string; contentLength?: number; expiresInSeconds?: number },
  ): Promise<SignedRequest>;
  listUploadedParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<{ etag: string | null }>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  head(key: string): Promise<ObjectHead | null>;
  presignDownload(
    key: string,
    opts: {
      filename?: string;
      contentType?: string;
      disposition?: "inline" | "attachment";
      expiresInSeconds?: number;
      /** Sign for the internal endpoint (workers) instead of the browser-facing one. */
      internal?: boolean;
    },
  ): Promise<string>;
  getStream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  put(key: string, body: Buffer, opts: { contentType: string; cacheControl?: string }): Promise<void>;
  /** Streams a local file (up to 5 GB single PUT) — used for generated proxies. */
  putFile(key: string, path: string, opts: { contentType: string; cacheControl?: string }): Promise<number>;
  delete(key: string): Promise<void>;
}

/** Phase 5 boundary — implemented by Google Drive / Dropbox connectors. */
export interface ExternalConnector {
  readonly id: string;
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<{ credentials: Buffer; accountId: string; accountLabel: string }>;
  refresh(credentials: Buffer): Promise<Buffer>;
  list(folderRef: string | null, cursor?: string): Promise<{ items: ExternalItem[]; nextCursor?: string }>;
  stat(fileRef: string): Promise<ExternalItem | null>;
  openStream(fileRef: string, range?: { start: number; end: number }): Promise<Readable>;
}

export type ExternalItem = {
  id: string;
  name: string;
  isFolder: boolean;
  size?: number;
  mimeType?: string;
  revision?: string;
  modifiedAt?: string;
  path?: string;
};
