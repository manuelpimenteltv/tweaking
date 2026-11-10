# Loupe

Review, collaboration and asset management for post-production studios, agencies and their clients.

> **Loupe** is a working codename (see `src/config/brand.ts`).

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Architecture, schema, roadmap, risks | ✅ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATABASE.md](docs/DATABASE.md) |
| 1 | Core platform | ✅ Implemented and tested (details below) |
| 2 | Video review | ✅ Implemented and tested (details below, and [docs/REVIEW.md](docs/REVIEW.md)) |
| 3 | Document, spreadsheet, presentation and image review | ✅ Implemented and tested (details below) |
| 4–6 | Collaboration and approvals, hybrid storage, professionalization | Planned ([roadmap](docs/ARCHITECTURE.md#7-phased-development-roadmap)) |

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

### Phase 2: video review

- **Two-panel review workspace**: the player is the main area; comments and file details sit in a side panel you can **resize** (drag the divider or use the arrow keys on it) and **collapse**. Both settings are remembered per browser.
- **Frame-accurate player**: SMPTE timecode from the clip's start TC (drop-frame `;` for 29.97/59.94), toggle to frame numbers, previous/next frame, ±1 s, speed (0.25×–2×), volume, fullscreen, resolution (1080p/540p proxies), timeline scrubbing with **thumbnail previews**, comment markers on the timeline, and keyboard shortcuts (press `?`).
- **Review proxies**: the worker converts every video (including ProRes/MXF/HEVC) to constant-frame-rate H.264 with a keyframe every 12 frames. That makes it playable in any browser and lets the player step precisely. Originals are never modified.
- **Timecode comments**: comment at the exact frame (or as a general note), jump to the referenced frame, **reply**, **resolve/reopen**, **@mention** collaborators (only people who can see the project), **filter** by status, author, text and "has drawing", and **sort** by timecode, oldest or newest.
- **Bound to versions**: every comment and drawing belongs to the version it was made on. A new version starts clean, and the panel lists open feedback left on other versions. Nothing is moved automatically.
- **Visual annotations**: freehand, arrows, lines, rectangles, circles/ellipses, text and highlighter, with 6 colors and 3 stroke widths, undo and clear. Stored as vectors in their own table (never burned into the video), shown on their frame, with **show/hide**.

### Phase 3: document, spreadsheet, presentation and image review

Every format uses the same comments, replies, mentions, resolve/reopen, filters, versions and drawing tools as video. The panel is the same two-panel layout.

- **PDF, Word (DOC/DOCX/RTF/ODT/TXT) and PowerPoint (PPT/PPTX/ODP/Keynote)**: the worker renders Office files to a review PDF with LibreOffice. PDFs are shown as-is. The viewer (PDF.js) offers page navigation, zoom (fit width, fit page, 50–300%), fullscreen, page/slide **thumbnails** with comment counts, **text selection** and **find**, plus a **presentation mode** for slides. Comments attach to a **page/slide**, or to an **area** of it when you draw. The original file is never changed, and Office renderings are labelled as such.
- **Excel (XLSX/XLSM/XLS/ODS/Numbers) and CSV/TSV**: sheet tabs (hidden sheets marked), a fast grid that only draws visible cells and loads rows in blocks, values **as Excel displays them** (currency, %, dates…), the **formula** of the selected cell in a formula bar, merged cells, bold/colors/alignment, **hidden rows and columns** (toggle to show them), zoom, and **comments on a cell** (`Summary!B4`) marked in the grid. Formulas, sheets and values are never dropped silently: any size limit is stated on screen.
- **Images (JPG, PNG, WEBP, GIF, AVIF, TIFF, PSD…)**: full resolution when the browser supports the format, otherwise a 4096 px review copy. Fit / 100% / zoom (also Ctrl/⌘ + wheel), drag to pan, and **area comments** drawn with any tool.

### Not yet built (explicitly)

Approval workflows, client portal and review links for external clients, and notifications, including alerts for @mentions (Phase 4); Google Drive, Dropbox and customer-S3 connectors (Phase 5; the adapter interfaces exist in `src/server/storage/types.ts`). **Email delivery** is an integration boundary (`src/server/mail/mailer.ts`): invitations are shown as copyable links, and nothing is emailed yet.

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

Updating an existing installation to a newer version:

```bash
pnpm install && pnpm db:migrate
pnpm media:backfill           # builds review proxies/previews for files uploaded before Phases 2–3
pnpm seed:demo                # optional: adds the Phase 3 sample project to the demo studio
```

## Documentation

- [Video review: frame accuracy, shortcuts, limits](docs/REVIEW.md)
- [Architecture and roadmap](docs/ARCHITECTURE.md): stack choices, diagrams, services, costs, risks, permissions
- [Database schema](docs/DATABASE.md): every entity across all phases, plus RLS
- [Development](docs/DEVELOPMENT.md) · [Configuration](docs/CONFIGURATION.md) · [Deployment](docs/DEPLOYMENT.md)
- [Security](docs/SECURITY.md) · [Operations](docs/OPERATIONS.md)
