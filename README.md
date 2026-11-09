# Loupe

Review, collaboration and asset management for post-production studios, agencies and their clients.

> **Loupe** is a working codename (see `src/config/brand.ts`).

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Architecture, schema, roadmap, risks | ✅ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATABASE.md](docs/DATABASE.md) |
| 1 | Core platform | ✅ Implemented and tested (details below) |
| 2–6 | Video review, document review, collaboration, hybrid storage, professionalization | Planned ([roadmap](docs/ARCHITECTURE.md#7-phased-development-roadmap)) |

### Phase 1: what works today

- **Accounts and studios**: sign-up/sign-in with Argon2id and revocable DB sessions, studio creation, org switcher, invitations (studio-wide or straight into a project) with email-bound, single-use, expiring links.
- **Roles and permissions**: Owner, Admin, Project Manager, Editor, Reviewer, Client and Guest, with project roles capped by studio role. Enforced in services and backed by **PostgreSQL row-level security** for tenant isolation.
- **Projects and workspaces**: status, client info, manager, custom metadata fields, cover, favorites, members, activity feed, soft delete.
- **Asset management**: nested folders, grid/list views, sort and type filters, multi-select, drag-and-drop moves (onto folders and breadcrumbs), OS file drop to upload, bulk move/delete, rename, keyboard shortcuts.
- **Uploads**: direct browser-to-storage **multipart** uploads, **per-part SHA-256** that the storage service verifies, parallel parts, retries with backoff, **resume after reload or network loss**, upload tray with speed and progress, quota checks, blocked executable types.
- **Versions**: upload a new version onto an asset. History is preserved, and a version becomes current only once complete.
- **Processing worker**: whole-file SHA-256, magic-byte content verification, ffprobe metadata (rational frame rate, VFR detection, start timecode, codecs, color), thumbnails and posters. Status, error and retry are visible in the UI.
- **Asset page**: in-browser playback of verified browser-compatible originals, full metadata, version history, processing history, audited signed downloads.
- **Dashboard, search and storage**: recent, favorite and assigned projects, recent uploads, activity, failure alerts, permission-aware search (names, extensions, clients, metadata, people) with filters, storage analytics by project, user, type and provider.
- **Administration**: studio settings and portal branding, members and roles, invitation management, role/permission matrix, append-only audit log.

### Not yet built (explicitly)

The review player, timecode comments and annotations (Phase 2); document, sheet and slide viewers (Phase 3); approval workflows, client portal, share links and notifications (Phase 4); Google Drive, Dropbox and customer-S3 connectors (Phase 5; the adapter interfaces exist in `src/server/storage/types.ts`). **Email delivery** is an integration boundary (`src/server/mail/mailer.ts`): invitations are shown as copyable links, and nothing is emailed yet.

## Quick start

See **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**. In short:

```bash
docker compose up -d          # PostgreSQL + MinIO
cp .env.example .env
pnpm install
pnpm db:migrate && pnpm storage:setup
pnpm dev                      # web app on :3000
pnpm worker                   # processing worker (separate terminal)
```

## Documentation

- [Architecture and roadmap](docs/ARCHITECTURE.md): stack choices, diagrams, services, costs, risks, permissions
- [Database schema](docs/DATABASE.md): every entity across all phases, plus RLS
- [Development](docs/DEVELOPMENT.md) · [Configuration](docs/CONFIGURATION.md) · [Deployment](docs/DEPLOYMENT.md)
- [Security](docs/SECURITY.md) · [Operations](docs/OPERATIONS.md)
