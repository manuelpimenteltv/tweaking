# Configuration

All server configuration is read from environment variables and validated at startup (`src/server/env.ts`). No secret is ever sent to the browser: the client only receives short-lived presigned URLs.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `APP_URL` | yes (prod) | `http://localhost:3000` | Public origin. Used for invitation links, CSRF origin checks and bucket CORS |
| `DATABASE_URL` | yes | — | **Restricted** login role (member of `loupe_app`). RLS applies |
| `DATABASE_URL_SYSTEM` | yes | — | Schema owner: migrations and the narrow system path (auth, token lookups, job queue) |
| `DATABASE_POOL_MAX` | no | `10` | Per-process pool size |
| `SESSION_TTL_DAYS` | no | `30` | Sliding session lifetime |
| `COOKIE_SECURE` | no | auto (`https` in `APP_URL`) | Force the `Secure` cookie flag |
| `S3_ENDPOINT` | for non-AWS | — | S3 API endpoint (MinIO, R2: `https://<account>.r2.cloudflarestorage.com`) |
| `S3_PUBLIC_ENDPOINT` | no | `S3_ENDPOINT` | Endpoint the **browser** uses when it differs from the internal one |
| `S3_REGION` | no | `auto` | `auto` for R2, the bucket region for AWS |
| `S3_BUCKET` | yes | — | Platform bucket (private; never public) |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | yes | — | Credentials scoped to this bucket only |
| `S3_FORCE_PATH_STYLE` | no | `false` | `true` for MinIO |
| `S3_PART_CHECKSUMS` | no | `true` | Signed per-part SHA-256 verification. Disable only if the provider lacks `x-amz-checksum-sha256` |
| `UPLOAD_MAX_BYTES` | no | 500 GiB | Per-file limit (S3 maximum object size is 5 TiB) |
| `UPLOAD_SESSION_TTL_HOURS` | no | `72` | Unfinished multipart uploads are aborted after this |
| `SIGNED_URL_TTL_SECONDS` | no | `3600` | Preview/playback URL lifetime (downloads use 300 s) |
| `FFPROBE_PATH` / `FFMPEG_PATH` | no | on `PATH` | Worker media tools |
| `WORKER_CONCURRENCY` | no | `2` | Jobs per worker process |
| `WORKER_JOB_TIMEOUT_SECONDS` | no | `1800` | Hard per-job timeout (child processes are killed) |
| `CSP_STORAGE_ORIGINS` | no | derived | Space-separated origins allowed in the CSP for storage/CDN |

### Bucket CORS

Browsers upload parts directly, so the bucket must allow `PUT`/`GET`/`HEAD` from `APP_URL` and **expose the `ETag` header**. `pnpm storage:setup` applies this on S3/R2. MinIO uses `MINIO_API_CORS_ALLOW_ORIGIN`.

### Not yet configurable (integration boundaries)

- **Email** (`MAIL_PROVIDER`, SMTP/Postmark credentials): `src/server/mail/mailer.ts` defines the interface. Only the console mailer exists.
- **External storage OAuth** (Google, Dropbox) and **KMS** for credential encryption: Phase 5.
