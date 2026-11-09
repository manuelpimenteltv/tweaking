import { and, asc, desc, eq, ilike, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { projectSchema, projectStatusValues, uuid } from "@/lib/validation";
import { authorize, type AuthContext } from "../authz/context";
import { PROJECT_ROLE_CEILING } from "../authz/permissions";
import { accessibleProjectIds, requireProject } from "../authz/project-access";
import { getSystemRole } from "../authz/roles";
import type { Tx } from "../db/client";
import {
  assets,
  organizationMembers,
  projectFavorites,
  projectMembers,
  projects,
  roles,
  users,
  workspaces,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { forbidden, invalid, notFound } from "../errors";
import { parse } from "../lib/validate";
import { auditFromCtx, recordAudit } from "./audit";
import { recordActivity } from "./activity";
import { signPreview } from "./previews";

export const listProjectsSchema = z.object({
  status: z.enum(projectStatusValues).optional(),
  workspaceId: uuid.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["updated", "name", "created"]).default("updated"),
  scope: z.enum(["all", "mine", "favorites"]).default("all"),
  limit: z.number().int().min(1).max(200).default(100),
});

const coverKey = sql<string | null>`(
  select sl.object_key from assets a
  join previews p on p.asset_version_id = a.current_version_id and p.kind = 'thumbnail'
  join storage_locations sl on sl.id = p.storage_location_id
  where a.project_id = ${projects.id} and a.deleted_at is null
  order by (a.id = ${projects.coverAssetId}) desc nulls last, a.created_at desc
  limit 1)`;

export async function listProjects(ctx: AuthContext, input: Partial<z.input<typeof listProjectsSchema>> = {}) {
  const opts = parse(listProjectsSchema, input);
  const rows = await withTenant(ctx, (tx) => {
    const conditions: (SQL | undefined)[] = [
      isNull(projects.deletedAt),
      accessibleProjectIds(ctx),
      opts.status ? eq(projects.status, opts.status) : opts.scope === "all" ? sql`${projects.status} <> 'archived'` : undefined,
      opts.workspaceId ? eq(projects.workspaceId, opts.workspaceId) : undefined,
      opts.q ? ilike(projects.name, `%${escapeLike(opts.q)}%`) : undefined,
      opts.scope === "mine"
        ? sql`${projects.id} in (select project_id from project_members where user_id = ${ctx.userId})`
        : undefined,
      opts.scope === "favorites"
        ? sql`${projects.id} in (select project_id from project_favorites where user_id = ${ctx.userId})`
        : undefined,
    ];
    const order =
      opts.sort === "name" ? [asc(projects.name)] : opts.sort === "created" ? [desc(projects.createdAt)] : [desc(projects.updatedAt)];
    return tx
      .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        clientName: projects.clientName,
        workspaceId: projects.workspaceId,
        workspaceName: workspaces.name,
        updatedAt: projects.updatedAt,
        createdAt: projects.createdAt,
        assetCount: sql<number>`(select count(*)::int from assets a where a.project_id = ${projects.id} and a.deleted_at is null)`,
        isFavorite: sql<boolean>`exists (select 1 from project_favorites f where f.project_id = ${projects.id} and f.user_id = ${ctx.userId})`,
        coverKey,
      })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(and(...conditions))
      .orderBy(...order)
      .limit(opts.limit);
  });
  return Promise.all(rows.map(async ({ coverKey: key, ...r }) => ({ ...r, coverUrl: await signPreview(key) })));
}

export function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function getProject(ctx: AuthContext, projectId: string) {
  parse(uuid, projectId);
  return withTenant(ctx, async (tx) => {
    const access = await requireProject(tx, ctx, projectId);
    const [extra] = await tx
      .select({
        workspaceName: workspaces.name,
        managerName: users.name,
        isFavorite: sql<boolean>`exists (select 1 from project_favorites f where f.project_id = ${projects.id} and f.user_id = ${ctx.userId})`,
        assetCount: sql<number>`(select count(*)::int from assets a where a.project_id = ${projects.id} and a.deleted_at is null)`,
        totalBytes: sql<string>`(select coalesce(sum(v.size_bytes),0)::text from asset_versions v join assets a on a.id = v.asset_id
          where a.project_id = ${projects.id} and a.deleted_at is null)`,
      })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .leftJoin(users, eq(users.id, projects.managerUserId))
      .where(eq(projects.id, projectId));
    return {
      ...access.project,
      ...extra,
      totalBytes: Number(extra.totalBytes),
      permissions: [...access.permissions],
      projectRoleKey: access.projectRoleKey,
    };
  });
}

async function assertManagerIsMember(tx: Tx, userId: string) {
  const [m] = await tx
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, "active")))
    .limit(1);
  if (!m) throw invalid("The project manager must be an active member.", { managerUserId: "Not a member of this organization." });
}

async function assertWorkspace(tx: Tx, workspaceId: string) {
  const [ws] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw invalid("Choose a workspace.", { workspaceId: "Unknown workspace." });
}

function toMetadata(entries: { key: string; value: string }[]) {
  return Object.fromEntries(entries.filter((e) => e.key).map((e) => [e.key, e.value]));
}

export async function createProject(ctx: AuthContext, input: unknown) {
  authorize(ctx, "project.create");
  const data = parse(projectSchema, input);
  return withTenant(ctx, async (tx) => {
    await assertWorkspace(tx, data.workspaceId);
    const managerUserId = data.managerUserId || ctx.userId;
    if (managerUserId !== ctx.userId) await assertManagerIsMember(tx, managerUserId);
    const [project] = await tx
      .insert(projects)
      .values({
        organizationId: ctx.orgId,
        workspaceId: data.workspaceId,
        name: data.name,
        description: data.description,
        status: data.status,
        clientName: data.clientName || null,
        clientEmail: data.clientEmail || null,
        managerUserId,
        metadata: toMetadata(data.metadata),
        createdBy: ctx.userId,
      })
      .returning();
    // The creator always becomes a project manager on the project (so non-admin PMs keep access).
    const pmRole = await getSystemRole(tx, "project", "project_manager");
    const members = new Set([ctx.userId, managerUserId]);
    for (const userId of members) {
      await tx
        .insert(projectMembers)
        .values({ organizationId: ctx.orgId, projectId: project.id, userId, roleId: pmRole.id, addedBy: ctx.userId })
        .onConflictDoNothing();
    }
    await recordActivity(tx, ctx, { projectId: project.id, verb: "project.created", subjectType: "project", subjectId: project.id, subjectName: project.name });
    await recordAudit(tx, auditFromCtx(ctx, "project.created", { type: "project", id: project.id }, { name: project.name }));
    return project;
  });
}

export async function updateProject(ctx: AuthContext, projectId: string, input: unknown) {
  parse(uuid, projectId);
  const data = parse(projectSchema, input);
  return withTenant(ctx, async (tx) => {
    const { project: before } = await requireProject(tx, ctx, projectId, "project.edit");
    await assertWorkspace(tx, data.workspaceId);
    if (data.managerUserId && data.managerUserId !== before.managerUserId) await assertManagerIsMember(tx, data.managerUserId);
    const [project] = await tx
      .update(projects)
      .set({
        workspaceId: data.workspaceId,
        name: data.name,
        description: data.description,
        status: data.status,
        clientName: data.clientName || null,
        clientEmail: data.clientEmail || null,
        managerUserId: data.managerUserId || null,
        metadata: toMetadata(data.metadata),
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId))
      .returning();
    const changes: Record<string, unknown> = {};
    if (before.status !== project.status) changes.status = { from: before.status, to: project.status };
    if (before.name !== project.name) changes.name = { from: before.name, to: project.name };
    await recordActivity(tx, ctx, { projectId, verb: "project.updated", subjectType: "project", subjectId: projectId, subjectName: project.name, data: changes });
    return project;
  });
}

export async function deleteProject(ctx: AuthContext, projectId: string) {
  parse(uuid, projectId);
  return withTenant(ctx, async (tx) => {
    const { project } = await requireProject(tx, ctx, projectId, "project.delete");
    await tx.update(projects).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(projects.id, projectId));
    await recordAudit(tx, auditFromCtx(ctx, "project.deleted", { type: "project", id: projectId }, { name: project.name }));
    await recordActivity(tx, ctx, { verb: "project.deleted", subjectType: "project", subjectId: projectId, subjectName: project.name });
  });
}

export async function setFavorite(ctx: AuthContext, projectId: string, favorite: boolean) {
  parse(uuid, projectId);
  return withTenant(ctx, async (tx) => {
    await requireProject(tx, ctx, projectId);
    if (favorite) {
      await tx.insert(projectFavorites).values({ organizationId: ctx.orgId, userId: ctx.userId, projectId }).onConflictDoNothing();
    } else {
      await tx.delete(projectFavorites).where(and(eq(projectFavorites.userId, ctx.userId), eq(projectFavorites.projectId, projectId)));
    }
  });
}

export async function setProjectCover(ctx: AuthContext, projectId: string, assetId: string) {
  parse(uuid, projectId);
  parse(uuid, assetId);
  return withTenant(ctx, async (tx) => {
    await requireProject(tx, ctx, projectId, "project.edit");
    const [asset] = await tx
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.projectId, projectId), isNull(assets.deletedAt)));
    if (!asset) throw notFound("Asset");
    await tx.update(projects).set({ coverAssetId: assetId, updatedAt: new Date() }).where(eq(projects.id, projectId));
  });
}

// ── Project members ─────────────────────────────────────────────────────────

export async function listProjectMembers(ctx: AuthContext, projectId: string) {
  parse(uuid, projectId);
  return withTenant(ctx, async (tx) => {
    await requireProject(tx, ctx, projectId);
    const orgRoles = tx
      .select({ userId: organizationMembers.userId, key: roles.key, name: roles.name })
      .from(organizationMembers)
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .as("org_roles");
    return tx
      .select({
        id: projectMembers.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        orgRoleKey: orgRoles.key,
        orgRoleName: orgRoles.name,
        addedAt: projectMembers.createdAt,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .innerJoin(roles, eq(roles.id, projectMembers.roleId))
      .leftJoin(orgRoles, eq(orgRoles.userId, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId))
      .orderBy(desc(roles.rank), asc(users.name));
  });
}

const memberInput = z.object({ projectId: uuid, userId: uuid, roleKey: z.enum(["project_manager", "editor", "reviewer", "client", "guest"]) });

async function orgRoleKeyOf(tx: Tx, userId: string) {
  const [m] = await tx
    .select({ key: roles.key, status: organizationMembers.status })
    .from(organizationMembers)
    .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(eq(organizationMembers.userId, userId))
    .limit(1);
  if (!m || m.status !== "active") throw invalid("That person is not an active member of this organization.");
  return m.key;
}

function assertCeiling(orgRoleKey: string, projectRoleKey: string) {
  const allowed = PROJECT_ROLE_CEILING[orgRoleKey] ?? ["guest"];
  if (!allowed.includes(projectRoleKey)) {
    throw forbidden(`A member with this organization role can be at most ${allowed[0].replace("_", " ")} on a project.`);
  }
}

export async function upsertProjectMember(ctx: AuthContext, input: unknown) {
  const data = parse(memberInput, input);
  return withTenant(ctx, async (tx) => {
    const { project } = await requireProject(tx, ctx, data.projectId, "project.manage_members");
    assertCeiling(await orgRoleKeyOf(tx, data.userId), data.roleKey);
    const role = await getSystemRole(tx, "project", data.roleKey);
    await tx
      .insert(projectMembers)
      .values({ organizationId: ctx.orgId, projectId: data.projectId, userId: data.userId, roleId: role.id, addedBy: ctx.userId })
      .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { roleId: role.id } });
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, data.userId));
    await recordActivity(tx, ctx, {
      projectId: data.projectId,
      verb: "project.member_set",
      subjectType: "user",
      subjectId: data.userId,
      subjectName: u?.name ?? "",
      data: { role: role.name },
    });
    await recordAudit(tx, auditFromCtx(ctx, "project.member_set", { type: "project", id: project.id }, { userId: data.userId, role: data.roleKey }));
  });
}

export async function removeProjectMember(ctx: AuthContext, input: unknown) {
  const data = parse(z.object({ projectId: uuid, userId: uuid }), input);
  return withTenant(ctx, async (tx) => {
    await requireProject(tx, ctx, data.projectId, "project.manage_members");
    const removed = await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, data.projectId), eq(projectMembers.userId, data.userId)))
      .returning({ id: projectMembers.id });
    if (!removed.length) throw notFound("Project member");
    await recordAudit(tx, auditFromCtx(ctx, "project.member_removed", { type: "project", id: data.projectId }, { userId: data.userId }));
  });
}

/** Bumps a project's updated_at so recently active projects sort first. */
export async function touchProject(tx: Tx, projectId: string) {
  await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
}

