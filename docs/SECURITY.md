# Security

## Controls implemented (Phase 1)

| Area | Control | Where |
|---|---|---|
| Authentication | Argon2id (m=19 MiB, t=2), timing-equalized unknown-user path, generic error messages | `src/server/auth/password.ts`, `modules/auth.ts` |
| Sessions | 256-bit opaque tokens, only SHA-256 stored, HttpOnly + SameSite=Lax + Secure cookies, sliding expiry, server-side revocation, disabled users are logged out | `src/server/auth/sessions.ts` |
| Brute force | PostgreSQL fixed-window rate limits per IP and per email on sign-in and sign-up | `src/server/auth/rate-limit.ts` |
| Authorization | Code-defined permission catalog. Every service call authorizes against the caller's org role and project role. Project roles capped by studio role. 404 (not 403) for inaccessible resources | `src/server/authz/*` |
| Tenant isolation | **PostgreSQL RLS** on every tenant table, using a transaction-local `app.org_id`. The app connects as a non-owner role. Integration tests prove unfiltered queries can't cross tenants | `drizzle/0002_security.sql`, `tests/integration/tenancy-auth.test.ts` |
| Least privilege | Column-level grants (`users.password_hash` unreadable by the app role). `sessions` and `rate_limits` not granted at all | `drizzle/0002_security.sql` |
| CSRF | Server actions: framework origin check. JSON API: explicit `Origin` check plus a JSON content-type requirement | `src/server/next/api.ts` |
| Open redirects | Post-login `next` only accepts same-site relative paths | `src/server/actions/auth.ts` |
| Storage | Private bucket. Credentials stay server-side. Short-lived presigned URLs issued only after authorization. Downloads are audited and use `attachment` disposition with sanitized RFC 6266 filenames | `src/server/storage/s3.ts`, `modules/assets.ts` |
| Upload integrity | Per-part SHA-256 bound into the presigned signature (storage rejects altered bytes). Size verified on completion. Whole-file SHA-256 recomputed by the worker | `modules/uploads.ts`, `jobs/ingest.ts` |
| File validation | Extension denylist (executables, scripts, HTML), declared-MIME plausibility, size limits, magic-byte verification against the extension's family | `src/lib/file-types.ts`, `jobs/ingest.ts` |
| Untrusted documents | LibreOffice runs headless with a throwaway profile per conversion and a timeout. Macros don't run in headless conversion. The original is copied to a scratch directory under a fixed name, so user filenames never reach a command line. PDFs render in the browser with PDF.js, with links, forms and scripting disabled. Spreadsheets are parsed into data (never executed), and formulas are shown as text | `src/server/jobs/documents.ts`, `sheets.ts`, `components/review/document-viewer.tsx` |
| Untrusted media | Worker is a separate process/image running as a non-root user. FFmpeg invoked with argument arrays (no shell), timeouts and output caps. libvips pixel limits | `src/server/media/process.ts`, `Dockerfile` |
| Audit | Append-only `audit_logs` (trigger rejects UPDATE/DELETE): logins, failed logins, role changes, invitations, downloads, deletions, retries | `modules/audit.ts` |
| Headers | CSP (storage origins allow-listed, `frame-ancestors 'none'`, `object-src 'none'`), HSTS, nosniff, Referrer-Policy, Permissions-Policy | `next.config.ts` |
| Invitations | Single use, 7-day expiry, bound to the invited email, token stored hashed | `modules/members.ts` |

## Known gaps / planned

- **LibreOffice can fetch remote resources referenced by a document** (e.g. linked images). Run workers with egress limited to PostgreSQL and object storage (see DEPLOYMENT.md).
- **CSP allows `'wasm-unsafe-eval'`** so PDF.js can compile its WebAssembly image decoders. It does not permit JavaScript `eval`.
- **CSP uses `'unsafe-inline'` for scripts** (Next.js bootstrap). Planned: a nonce-based CSP via `proxy.ts` (Phase 6).
- **Client IP** comes from the first `X-Forwarded-For` hop. Deploy behind a proxy that overwrites the header, or rate limits can be evaded by spoofing it.
- **Malware scanning** (ClamAV stage) is designed but not implemented (Phase 6). Media files are never executed or served inline except verified audio/video.
- **Email verification, MFA, SSO**: not yet. The schema has `email_verified_at`; SSO plugs into the session layer.
- **Encryption at rest**: provided by the managed PostgreSQL and object storage (enable SSE on the bucket). OAuth tokens for Phase 5 will use envelope encryption with a KMS (`storage_connections.encrypted_credentials`).
- Security testing (penetration test, dependency audit in CI) is in Phase 6.

## Reporting

Treat the audit log and application logs as security evidence. Rotate `S3_*` credentials and database passwords through the secret manager. Changing them requires no code change.
