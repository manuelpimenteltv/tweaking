import { sql } from "drizzle-orm";
import { platformStorage } from "../storage/registry";

/**
 * Correlated subquery returning the object key of an asset version's preview.
 * Previews always live in the platform bucket (docs/ARCHITECTURE.md §11).
 */
export function previewKeySql(versionIdColumn: unknown, kind: "thumbnail" | "poster" = "thumbnail") {
  return sql<string | null>`(
    select sl.object_key from previews p
    join storage_locations sl on sl.id = p.storage_location_id
    where p.asset_version_id = ${versionIdColumn} and p.kind = ${kind}
    order by p.created_at desc limit 1)`;
}

/** Short-lived signed URL for an inline preview image; null when there is none. */
export async function signPreview(objectKey: string | null | undefined, contentType = "image/webp"): Promise<string | null> {
  if (!objectKey) return null;
  return platformStorage().presignDownload(objectKey, { disposition: "inline", contentType });
}

export async function signPreviews<T extends { previewKey: string | null }>(rows: T[]): Promise<(T & { previewUrl: string | null })[]> {
  return Promise.all(rows.map(async (r) => ({ ...r, previewUrl: await signPreview(r.previewKey) })));
}
