/**
 * Phase 1 relational schema. See docs/DATABASE.md for the full proposal.
 *
 * Invariants:
 * - Every tenant-owned table carries `organizationId` so RLS policies are a
 *   single indexed equality (policies live in drizzle/0002_security.sql).
 * - No binary content is stored here, only storage_locations pointers.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });
const orgRef = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

// ── Enums ───────────────────────────────────────────────────────────────────
export const projectStatus = pgEnum("project_status", ["active", "on_hold", "completed", "archived"]);
export const assetKind = pgEnum("asset_kind", [
  "video",
  "audio",
  "image",
  "document",
  "spreadsheet",
  "presentation",
  "archive",
  "other",
]);
export const reviewStatus = pgEnum("review_status", [
  "draft",
  "in_progress",
  "ready_for_review",
  "in_review",
  "changes_requested",
  "approved",
  "final",
]);
export const storageSource = pgEnum("storage_source", ["native", "external_import", "external_reference"]);
export const processingStatus = pgEnum("processing_status", ["awaiting_upload", "processing", "ready", "failed"]);
export const uploadStatus = pgEnum("upload_status", ["active", "completed", "aborted"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "cancelled"]);
export const roleScope = pgEnum("role_scope", ["organization", "project"]);
export const memberStatus = pgEnum("member_status", ["active", "suspended"]);
export const connectionStatus = pgEnum("connection_status", ["active", "needs_reauth", "error", "disconnected"]);
export const previewKind = pgEnum("preview_kind", [
  "thumbnail",
  "poster",
  "sprite",
  "hls",
  "proxy",
  "pdf",
  "page_image",
  "waveform",
  "sheet_model",
]);

// ── Identity & tenancy ──────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    avatarUrl: text("avatar_url"),
    emailVerifiedAt: ts("email_verified_at"),
    disabledAt: ts("disabled_at"),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    lastUsedAt: ts("last_used_at").notNull().defaultNow(),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  branding: jsonb("branding").$type<OrgBranding>().notNull().default({}),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" }),
  plan: text("plan").notNull().default("studio"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: ts("deleted_at"),
});

export type OrgBranding = { accentColor?: string; portalTitle?: string };

export const roles = pgTable(
  "roles",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    scope: roleScope("scope").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    permissions: text("permissions").array().notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    rank: integer("rank").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique("roles_org_scope_key_uq").on(t.organizationId, t.scope, t.key).nullsNotDistinct()],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: id(),
    organizationId: orgRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    status: memberStatus("status").notNull().default("active"),
    invitedBy: uuid("invited_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("org_members_org_user_uq").on(t.organizationId, t.userId), index("org_members_user_idx").on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    organizationId: orgRef(),
    email: text("email").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    projectId: uuid("project_id").references((): AnyPgColumn => projects.id, { onDelete: "cascade" }),
    projectRoleId: uuid("project_role_id").references(() => roles.id),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_org_idx").on(t.organizationId, t.createdAt.desc())],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull(),
  count: integer("count").notNull(),
});

// ── Workspaces, projects, folders ───────────────────────────────────────────
export const workspaces = pgTable("workspaces", {
  id: id(),
  organizationId: orgRef(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projects = pgTable(
  "projects",
  {
    id: id(),
    organizationId: orgRef(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    status: projectStatus("status").notNull().default("active"),
    clientName: text("client_name"),
    clientEmail: text("client_email"),
    managerUserId: uuid("manager_user_id").references(() => users.id),
    coverAssetId: uuid("cover_asset_id").references((): AnyPgColumn => assets.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("projects_org_idx").on(t.organizationId, t.updatedAt.desc()).where(sql`deleted_at is null`),
    index("projects_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: id(),
    organizationId: orgRef(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    addedBy: uuid("added_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("project_members_project_user_uq").on(t.projectId, t.userId),
    index("project_members_user_idx").on(t.organizationId, t.userId),
  ],
);

export const projectFavorites = pgTable(
  "project_favorites",
  {
    organizationId: orgRef(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] })],
);

export const folders = pgTable(
  "folders",
  {
    id: id(),
    organizationId: orgRef(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("folders_parent_idx").on(t.organizationId, t.projectId, t.parentId),
    index("folders_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
  ],
);

// ── Storage ─────────────────────────────────────────────────────────────────
export const storageProviders = pgTable("storage_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  capabilities: jsonb("capabilities").$type<Record<string, boolean>>().notNull().default({}),
});

export const storageConnections = pgTable(
  "storage_connections",
  {
    id: id(),
    organizationId: orgRef(),
    providerId: text("provider_id")
      .notNull()
      .references(() => storageProviders.id),
    name: text("name").notNull(),
    status: connectionStatus("status").notNull().default("active"),
    isDefault: boolean("is_default").notNull().default(false),
    config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
    encryptedCredentials: bytea("encrypted_credentials"),
    credentialsKeyId: text("credentials_key_id"),
    externalAccountId: text("external_account_id"),
    externalAccountLabel: text("external_account_label"),
    lastVerifiedAt: ts("last_verified_at"),
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("storage_connections_default_uq").on(t.organizationId).where(sql`is_default`)],
);

export const storageLocations = pgTable(
  "storage_locations",
  {
    id: id(),
    organizationId: orgRef(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => storageConnections.id),
    objectKey: text("object_key"),
    externalId: text("external_id"),
    externalPath: text("external_path"),
    externalRevision: text("external_revision"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    etag: text("etag"),
    checksumSha256: text("checksum_sha256"),
    accessVerifiedAt: ts("access_verified_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("storage_locations_key_uq").on(t.connectionId, t.objectKey).where(sql`object_key is not null`)],
);

// ── Assets & versions ───────────────────────────────────────────────────────
export const assets = pgTable(
  "assets",
  {
    id: id(),
    organizationId: orgRef(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    kind: assetKind("kind").notNull(),
    reviewStatus: reviewStatus("review_status").notNull().default("draft"),
    currentVersionId: uuid("current_version_id"),
    versionCount: integer("version_count").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, string>>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [
    index("assets_folder_idx").on(t.organizationId, t.projectId, t.folderId).where(sql`deleted_at is null`),
    index("assets_recent_idx").on(t.organizationId, t.createdAt.desc()).where(sql`deleted_at is null`),
    index("assets_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
  ],
);

export type MediaInfo = {
  container?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  pixelFormat?: string;
  fps?: { num: number; den: number };
  vfr?: boolean;
  startTimecode?: string;
  bitRate?: number;
  audioChannels?: number;
  sampleRate?: number;
  colorSpace?: string;
  colorTransfer?: string;
  browserPlayable?: boolean;
  /** Non-fatal processing notes shown to users (e.g. preview unavailable). */
  notes?: string[];
};

export const assetVersions = pgTable(
  "asset_versions",
  {
    id: id(),
    organizationId: orgRef(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    originalFilename: text("original_filename").notNull(),
    extension: text("extension").notNull(),
    declaredMimeType: text("declared_mime_type").notNull(),
    detectedMimeType: text("detected_mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentSha256: text("content_sha256"),
    storageSource: storageSource("storage_source").notNull().default("native"),
    storageLocationId: uuid("storage_location_id")
      .notNull()
      .references(() => storageLocations.id),
    processingStatus: processingStatus("processing_status").notNull().default("awaiting_upload"),
    processingError: text("processing_error"),
    mediaInfo: jsonb("media_info").$type<MediaInfo>().notNull().default({}),
    notes: text("notes").notNull().default(""),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    uploadedAt: ts("uploaded_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("asset_versions_asset_number_uq").on(t.assetId, t.versionNumber),
    index("asset_versions_status_idx").on(t.organizationId, t.processingStatus),
  ],
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: id(),
    organizationId: orgRef(),
    assetVersionId: uuid("asset_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    storageLocationId: uuid("storage_location_id")
      .notNull()
      .references(() => storageLocations.id),
    providerUploadId: text("provider_upload_id").notNull(),
    partSize: bigint("part_size", { mode: "number" }).notNull(),
    partCount: integer("part_count").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: uploadStatus("status").notNull().default("active"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    expiresAt: ts("expires_at").notNull(),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("upload_sessions_active_idx").on(t.organizationId, t.createdBy).where(sql`status = 'active'`)],
);

export const processingJobs = pgTable(
  "processing_jobs",
  {
    id: id(),
    organizationId: orgRef(),
    assetVersionId: uuid("asset_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: ts("run_after").notNull().defaultNow(),
    lockedUntil: ts("locked_until"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    requestedBy: uuid("requested_by").references(() => users.id),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("processing_jobs_version_idx").on(t.assetVersionId, t.createdAt.desc()),
    index("processing_jobs_claim_idx").on(t.runAfter).where(sql`status in ('queued','running')`),
  ],
);

export const previews = pgTable(
  "previews",
  {
    id: id(),
    organizationId: orgRef(),
    assetVersionId: uuid("asset_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    kind: previewKind("kind").notNull(),
    storageLocationId: uuid("storage_location_id")
      .notNull()
      .references(() => storageLocations.id),
    mimeType: text("mime_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    pageNumber: integer("page_number"),
    rendition: text("rendition"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("previews_version_idx").on(t.assetVersionId, t.kind)],
);

// ── Activity & audit ────────────────────────────────────────────────────────
export const activityEvents = pgTable(
  "activity_events",
  {
    id: id(),
    organizationId: orgRef(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    verb: text("verb").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id"),
    subjectName: text("subject_name").notNull().default(""),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_org_idx").on(t.organizationId, t.createdAt.desc()),
    index("activity_project_idx").on(t.projectId, t.createdAt.desc()),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_org_idx").on(t.organizationId, t.createdAt.desc())],
);

// ── Review (Phase 2): comments, threads, mentions, annotations ──────────────
export const anchorType = pgEnum("anchor_type", ["none", "frame", "frame_range", "page", "slide", "sheet_cell", "region"]);
export const threadStatus = pgEnum("thread_status", ["open", "resolved"]);

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * A feedback thread is bound to exactly one asset version. It is never moved
 * to another version automatically (frame references can't be mapped reliably).
 */
export const commentThreads = pgTable(
  "comment_threads",
  {
    id: id(),
    organizationId: orgRef(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    assetVersionId: uuid("asset_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    anchorType: anchorType("anchor_type").notNull().default("none"),
    /** Frame number in the version's (proxy) timeline: 0-based, at fps num/den. */
    frame: integer("frame"),
    endFrame: integer("end_frame"),
    /** Anchor context captured at creation: {fpsNum, fpsDen, timecode, region…}. */
    anchor: jsonb("anchor").$type<ThreadAnchor>().notNull().default({}),
    status: threadStatus("status").notNull().default("open"),
    resolvedBy: uuid("resolved_by").references(() => users.id),
    resolvedAt: ts("resolved_at"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("threads_version_idx").on(t.assetVersionId, t.frame),
    index("threads_asset_idx").on(t.organizationId, t.assetId),
  ],
);

export type ThreadAnchor = { fpsNum?: number; fpsDen?: number; timecode?: string; seconds?: number };

export const comments = pgTable(
  "comments",
  {
    id: id(),
    organizationId: orgRef(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => commentThreads.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id),
    body: text("body").notNull(),
    bodyTsv: tsvector("body_tsv").generatedAlwaysAs(sql`to_tsvector('simple', body)`),
    editedAt: ts("edited_at"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("comments_thread_idx").on(t.threadId, t.createdAt), index("comments_fts_idx").using("gin", t.bodyTsv)],
);

export const commentMentions = pgTable(
  "comment_mentions",
  {
    organizationId: orgRef(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.userId] }), index("mentions_user_idx").on(t.userId, t.createdAt.desc())],
);

/** Vector shapes in normalized (0–1) coordinates of the picture. Stored apart from the media. */
export const annotations = pgTable(
  "annotations",
  {
    id: id(),
    organizationId: orgRef(),
    assetVersionId: uuid("asset_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    frame: integer("frame"),
    shapes: jsonb("shapes").$type<AnnotationShape[]>().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("annotations_version_idx").on(t.assetVersionId, t.frame), index("annotations_comment_idx").on(t.commentId)],
);

export type AnnotationTool = "freehand" | "arrow" | "line" | "rect" | "ellipse" | "text" | "highlight";
export type AnnotationShape = {
  tool: AnnotationTool;
  /** freehand/highlight: polyline; arrow/line: [start, end]; rect/ellipse: [corner, opposite corner]; text: [anchor]. */
  points: [number, number][];
  color: string;
  width: number;
  text?: string;
};
