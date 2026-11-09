/**
 * Server configuration, validated once on first access. Never import from client code.
 * See docs/CONFIGURATION.md for every variable.
 */
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url().default("http://localhost:3000"),
  /** Restricted login role (member of loupe_app). Row-level security applies. */
  DATABASE_URL: z.string().min(1),
  /** Schema owner. Used for migrations and the narrow system data path only. */
  DATABASE_URL_SYSTEM: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SECURE: bool.optional(),

  S3_ENDPOINT: z.url().optional(),
  /** Endpoint the *browser* uses for presigned URLs, if different (e.g. behind Docker/CDN). */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(false),
  /** Whether the provider verifies x-amz-checksum-sha256 on UploadPart (S3, MinIO, R2: yes). */
  S3_PART_CHECKSUMS: bool.default(true),

  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(500 * 1024 ** 3),
  UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(72),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),

  FFPROBE_PATH: z.string().default("ffprobe"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_JOB_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server configuration:\n${issues}\nSee docs/CONFIGURATION.md`);
  }
  cached = parsed.data;
  return cached;
}

export function cookieSecure(): boolean {
  const e = env();
  return e.COOKIE_SECURE ?? e.APP_URL.startsWith("https://");
}
