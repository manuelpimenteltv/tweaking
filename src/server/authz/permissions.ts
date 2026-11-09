/**
 * Permission catalog and system roles. Single source of truth: system roles are
 * synced into the `roles` table by `scripts/migrate.ts` (syncSystemRoles).
 * See docs/ARCHITECTURE.md §9 for the matrix.
 *
 * This module is pure (no I/O) so it can be shared with client components for
 * UI hints. Enforcement always happens server-side in authorize().
 */

export const ORG_PERMISSIONS = [
  "org.manage_billing",
  "org.manage_settings",
  "org.manage_members",
  "org.manage_roles",
  "org.manage_storage",
  "org.manage_integrations",
  "org.view_audit_log",
  "org.view_internal",
  "project.create",
  "project.access_all",
] as const;

export const PROJECT_PERMISSIONS = [
  "project.view",
  "project.edit",
  "project.delete",
  "project.manage_members",
  "folder.create",
  "folder.edit",
  "folder.delete",
  "asset.upload",
  "asset.edit",
  "asset.delete",
  "asset.version",
  "asset.download",
  "asset.processing_retry",
  // Later phases. Defined now so roles carry them from day one.
  "comment.create",
  "comment.resolve",
  "share.create",
  "review.manage",
  "approval.decide",
] as const;

export type OrgPermission = (typeof ORG_PERMISSIONS)[number];
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];
export type Permission = OrgPermission | ProjectPermission;

export const ALL_PERMISSIONS: readonly Permission[] = [...ORG_PERMISSIONS, ...PROJECT_PERMISSIONS];

export const PERMISSION_LABELS: Record<Permission, string> = {
  "org.manage_billing": "Manage billing and plan",
  "org.manage_settings": "Manage organization settings and branding",
  "org.manage_members": "Invite, remove and change roles of members",
  "org.manage_roles": "Manage roles",
  "org.manage_storage": "Manage storage configuration",
  "org.manage_integrations": "Manage integrations",
  "org.view_audit_log": "View the audit log",
  "org.view_internal": "Access internal studio areas",
  "project.create": "Create projects",
  "project.access_all": "Access every project in the organization",
  "project.view": "View project",
  "project.edit": "Edit project details",
  "project.delete": "Delete project",
  "project.manage_members": "Manage project members",
  "folder.create": "Create folders",
  "folder.edit": "Rename and move folders",
  "folder.delete": "Delete folders",
  "asset.upload": "Upload assets",
  "asset.edit": "Rename and move assets",
  "asset.delete": "Delete assets",
  "asset.version": "Upload new versions",
  "asset.download": "Download originals",
  "asset.processing_retry": "Retry failed processing",
  "comment.create": "Comment",
  "comment.resolve": "Resolve comments",
  "share.create": "Create review links",
  "review.manage": "Manage reviews",
  "approval.decide": "Approve or request changes",
};

export type SystemRoleKey = "owner" | "admin" | "project_manager" | "editor" | "reviewer" | "client" | "guest";
export type ProjectRoleKey = Exclude<SystemRoleKey, "owner" | "admin">;

type RoleDef = {
  key: string;
  name: string;
  description: string;
  rank: number;
  permissions: readonly Permission[];
};

const P = PROJECT_PERMISSIONS;
const without = (list: readonly Permission[], ...drop: Permission[]) => list.filter((p) => !drop.includes(p));

const PM_PROJECT: Permission[] = [...P];
const EDITOR_PROJECT: Permission[] = [
  "project.view",
  "folder.create",
  "folder.edit",
  "folder.delete",
  "asset.upload",
  "asset.edit",
  "asset.delete",
  "asset.version",
  "asset.download",
  "asset.processing_retry",
  "comment.create",
  "comment.resolve",
  "share.create",
];
const REVIEWER_PROJECT: Permission[] = ["project.view", "asset.download", "comment.create"];
const CLIENT_PROJECT: Permission[] = ["project.view", "asset.download", "comment.create", "approval.decide"];
const GUEST_PROJECT: Permission[] = ["project.view", "comment.create"];

export const SYSTEM_ORG_ROLES: readonly RoleDef[] = [
  {
    key: "owner",
    name: "Studio Owner",
    description: "Full access, including billing and administrators.",
    rank: 100,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    key: "admin",
    name: "Administrator",
    description: "Manages projects, people, permissions, storage and integrations.",
    rank: 90,
    permissions: without(ALL_PERMISSIONS, "org.manage_billing"),
  },
  {
    key: "project_manager",
    name: "Project Manager",
    description: "Creates projects, invites collaborators and runs review workflows.",
    rank: 70,
    permissions: ["org.view_internal", "project.create"],
  },
  {
    key: "editor",
    name: "Editor / Creative",
    description: "Uploads assets and versions, reviews and resolves feedback.",
    rank: 50,
    permissions: ["org.view_internal"],
  },
  {
    key: "reviewer",
    name: "Reviewer",
    description: "Reviews and comments on assigned projects.",
    rank: 30,
    permissions: ["org.view_internal"],
  },
  {
    key: "client",
    name: "Client",
    description: "Sees only projects shared with them. Can approve when allowed.",
    rank: 20,
    permissions: [],
  },
  {
    key: "guest",
    name: "Guest",
    description: "Limited access to specifically shared content.",
    rank: 10,
    permissions: [],
  },
];

export const SYSTEM_PROJECT_ROLES: readonly RoleDef[] = [
  { key: "project_manager", name: "Project Manager", description: "Full control of this project.", rank: 70, permissions: PM_PROJECT },
  { key: "editor", name: "Editor", description: "Upload, organize and resolve feedback.", rank: 50, permissions: EDITOR_PROJECT },
  { key: "reviewer", name: "Reviewer", description: "View, download and comment.", rank: 30, permissions: REVIEWER_PROJECT },
  { key: "client", name: "Client", description: "View, comment and approve.", rank: 20, permissions: CLIENT_PROJECT },
  { key: "guest", name: "Guest", description: "View and comment only.", rank: 10, permissions: GUEST_PROJECT },
];

/**
 * Highest project roles each org role may hold. A Client can never be made a
 * project Editor, regardless of who adds them.
 */
export const PROJECT_ROLE_CEILING: Record<string, readonly string[]> = {
  owner: ["project_manager", "editor", "reviewer", "client", "guest"],
  admin: ["project_manager", "editor", "reviewer", "client", "guest"],
  project_manager: ["project_manager", "editor", "reviewer", "client", "guest"],
  editor: ["editor", "reviewer", "guest"],
  reviewer: ["reviewer", "guest"],
  client: ["client", "guest"],
  guest: ["guest"],
};

export function isPermission(v: string): v is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(v);
}
