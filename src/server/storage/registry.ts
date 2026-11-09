import { env } from "../env";
import { AppError } from "../errors";
import { S3StorageProvider } from "./s3";
import type { ObjectStorageProvider } from "./types";

export type ConnectionLike = { id: string; providerId: string; config: Record<string, string> };

const g = globalThis as unknown as { __loupePlatformStorage?: ObjectStorageProvider };

/** The platform's own bucket, configured from server environment variables. */
export function platformStorage(): ObjectStorageProvider {
  if (!g.__loupePlatformStorage) {
    const e = env();
    g.__loupePlatformStorage = new S3StorageProvider({
      endpoint: e.S3_ENDPOINT,
      publicEndpoint: e.S3_PUBLIC_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      partChecksums: e.S3_PART_CHECKSUMS,
      defaultExpiresInSeconds: e.SIGNED_URL_TTL_SECONDS,
    });
  }
  return g.__loupePlatformStorage;
}

/**
 * Resolves the object-storage adapter for a storage connection.
 * Adding a provider = implementing ObjectStorageProvider/ExternalConnector and registering it here.
 */
export function storageForConnection(conn: ConnectionLike): ObjectStorageProvider {
  switch (conn.providerId) {
    case "platform":
      return platformStorage();
    default:
      // Customer S3 buckets, Google Drive and Dropbox arrive in Phase 5 (encrypted credentials + connectors).
      throw new AppError("storage_error", `Storage provider "${conn.providerId}" is not available yet.`);
  }
}

/** Object key layout. Originals and derivatives never share a prefix. */
export const keys = {
  original: (orgId: string, versionId: string, filename: string) =>
    `orgs/${orgId}/originals/${versionId}/${safeKeySegment(filename)}`,
  derived: (orgId: string, versionId: string, name: string) => `orgs/${orgId}/derived/${versionId}/${name}`,
};

export function safeKeySegment(filename: string): string {
  const cleaned = filename
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return (cleaned || "file").slice(0, 200);
}
