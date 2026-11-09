# Development

## Prerequisites

- Node.js 22+, pnpm 10+
- PostgreSQL 16+ and an S3-compatible store: `docker compose up -d` starts both
- FFmpeg/ffprobe on `PATH` (needed by the worker and the integration tests)

Without Docker, install PostgreSQL locally, run `psql -U postgres -f scripts/db-bootstrap.sql`,
and start MinIO with `scripts/dev-minio.sh` (it expects a MinIO binary at `.dev/minio`, or set `MINIO_BIN`).

## Setup

```bash
cp .env.example .env                 # defaults match docker-compose.yml
pnpm install
pnpm db:migrate                      # migrations + system roles + providers
pnpm storage:setup                   # bucket + CORS
pnpm dev                             # http://localhost:3000
pnpm worker                          # second terminal
```

## Layout

```
src/
  app/                 Next.js routes (pages, server-rendered; API under app/api/v1)
  components/ui/       design-system primitives
  components/app/      domain components (uploader, asset browser, …)
  lib/                 code shared by client and server (validation, file policy, formatting)
  server/
    db/                schema, pools, tenant transactions (RLS context)
    auth/ authz/       sessions, passwords, rate limiting, permissions, project access
    modules/           domain services (business logic, authorization, validation)
    storage/           provider-independent storage interface + S3 adapter
    jobs/ media/       job queue, ingest pipeline, ffprobe/ffmpeg helpers
    actions/           server actions (thin: context → service → refresh)
    next/              Next.js glue (cookies, API wrapper, error mapping)
  worker/              worker entrypoint
drizzle/               SQL migrations (0002_security.sql = RLS + grants)
tests/unit, tests/integration, tests/e2e
```

Rules of thumb: UI never queries the database. Every service receives an `AuthContext`, authorizes, and runs its queries inside `withTenant()`.

## Database changes

1. Edit `src/server/db/schema.ts`.
2. `pnpm db:generate` creates a migration in `drizzle/`.
3. For every **new tenant table**, add to a migration: `ENABLE ROW LEVEL SECURITY`, a `tenant_isolation` policy, and explicit `GRANT`s to `loupe_app` (deny by default).
4. `pnpm db:migrate` and `pnpm db:migrate:test`.

## Tests

```bash
pnpm db:migrate:test                  # once: prepares loupe_test
pnpm test                             # unit + integration (real PostgreSQL, MinIO, FFmpeg)
pnpm build && pnpm start & pnpm worker &
pnpm test:e2e                         # Playwright: full studio workflow in Chromium
```

Integration tests cover tenant isolation (including RLS with deliberately unfiltered queries), role and ceiling enforcement, invitations, search permissions, multipart upload and resume, checksum rejection by storage, content-type mismatch, video probing and versioning.

Note: with Cache Components, Next.js keeps recently visited routes mounted but hidden, so e2e locators for dialogs should be scoped to `getByRole("dialog")`.
