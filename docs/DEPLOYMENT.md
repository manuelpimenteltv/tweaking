# Deployment

## Topology

| Component | Runs as | Scales on | Notes |
|---|---|---|---|
| `web` | `docker build --target web` (Next.js, port 3000) | requests / CPU | Stateless. Behind a TLS-terminating load balancer or CDN |
| `worker` | `docker build --target worker` (Node + FFmpeg) | `processing_jobs` queue depth | No inbound traffic. Egress only to PostgreSQL and object storage |
| PostgreSQL 16+ | managed (RDS, Cloud SQL, Neon, Crunchy…) | — | PITR backups on. `pg_trgm` available |
| Object storage | Cloudflare R2 (recommended) or AWS S3 | — | Private bucket, CORS configured, versioning optional |

## First deployment

1. **Database roles** (as an admin, adapting `scripts/db-bootstrap.sql`):
   - `loupe`: schema owner, used only by migrations and `DATABASE_URL_SYSTEM`
   - `loupe_app`: NOLOGIN group role (created by the migrations if missing)
   - `loupe_web`: LOGIN role `IN ROLE loupe_app`, **not** an owner and **not** BYPASSRLS. Used for `DATABASE_URL`
2. **Bucket**: create it private, then run `pnpm storage:setup` with production env (or configure CORS manually: origin = `APP_URL`, methods PUT/GET/HEAD, expose `ETag`). Add a lifecycle rule that aborts incomplete multipart uploads after 7 days, as a backstop to the worker's sweep.
3. **Migrate** as a release step: `pnpm db:migrate` (idempotent; also syncs system roles).
4. Deploy `web` and at least one `worker`. Health check: `GET /login` returns 200.
5. Set `APP_URL` to the public HTTPS origin. Cookies become `Secure` automatically.

## Upgrades

Migrations are forward-only SQL in `drizzle/`. Run them before rolling out new `web`/`worker` versions. Workers finish their current job on `SIGTERM` (lease-based queue: a killed worker's job is reclaimed after its lease expires, in about 2 minutes).

## Sizing (starting point)

- web: 2 × (1 vCPU, 1–2 GB)
- worker: 1–N × (4 vCPU, 8 GB), concurrency 2. Phase 2 HLS transcoding is the dominant cost; see the cost table in ARCHITECTURE.md §6.
- PostgreSQL: 2 vCPU / 8 GB with HA

## Platform notes

- Serverless function platforms are fine for `web` only if they support Node.js with long-enough timeouts for the upload API. The `worker` needs a container platform (FFmpeg, long jobs).
- When the bucket is fronted by a CDN or custom domain, set `S3_PUBLIC_ENDPOINT` and `CSP_STORAGE_ORIGINS`.
