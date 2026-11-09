import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { workspaceSchema, uuid } from "@/lib/validation";
import { authorize, type AuthContext } from "../authz/context";
import { projects, workspaces } from "../db/schema";
import { withTenant } from "../db/tenant";
import { conflict, isUniqueViolation, notFound } from "../errors";
import { parse } from "../lib/validate";
import { accessibleProjectIds } from "../authz/project-access";
import { auditFromCtx, recordAudit } from "./audit";
import { recordActivity } from "./activity";

export async function listWorkspaces(ctx: AuthContext) {
  authorize(ctx, "org.view_internal");
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        description: workspaces.description,
        createdAt: workspaces.createdAt,
        projectCount: sql<number>`(select count(*)::int from ${projects} where ${projects.workspaceId} = ${workspaces.id}
          and ${projects.deletedAt} is null and ${accessibleProjectIds(ctx)})`,
      })
      .from(workspaces)
      .where(eq(workspaces.organizationId, ctx.orgId))
      .orderBy(asc(workspaces.name)),
  );
}

export async function createWorkspace(ctx: AuthContext, input: unknown) {
  authorize(ctx, "project.create");
  const data = parse(workspaceSchema, input);
  try {
    return await withTenant(ctx, async (tx) => {
      const [ws] = await tx
        .insert(workspaces)
        .values({ organizationId: ctx.orgId, name: data.name, description: data.description, createdBy: ctx.userId })
        .returning();
      await recordActivity(tx, ctx, { verb: "workspace.created", subjectType: "workspace", subjectId: ws.id, subjectName: ws.name });
      return ws;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A workspace with this name already exists.", { name: "Name already in use." });
    throw err;
  }
}

export async function updateWorkspace(ctx: AuthContext, id: string, input: unknown) {
  authorize(ctx, "project.create");
  parse(uuid, id);
  const data = parse(workspaceSchema, input);
  try {
    return await withTenant(ctx, async (tx) => {
      const [ws] = await tx
        .update(workspaces)
        .set({ name: data.name, description: data.description, updatedAt: new Date() })
        .where(eq(workspaces.id, id))
        .returning();
      if (!ws) throw notFound("Workspace");
      return ws;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("A workspace with this name already exists.", { name: "Name already in use." });
    throw err;
  }
}

export async function deleteWorkspace(ctx: AuthContext, id: string) {
  authorize(ctx, "org.manage_settings");
  parse(uuid, id);
  return withTenant(ctx, async (tx) => {
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(projects)
      .where(and(eq(projects.workspaceId, id), isNull(projects.deletedAt)));
    if (n > 0) throw conflict("Move or delete this workspace's projects first.");
    const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(workspaces);
    if (total <= 1) throw conflict("An organization needs at least one workspace.");
    // Soft-deleted projects keep their workspace reference; reassign them to another workspace.
    const [other] = await tx.select({ id: workspaces.id }).from(workspaces).where(sql`${workspaces.id} <> ${id}`).limit(1);
    await tx.update(projects).set({ workspaceId: other.id }).where(eq(projects.workspaceId, id));
    const [ws] = await tx.delete(workspaces).where(eq(workspaces.id, id)).returning();
    if (!ws) throw notFound("Workspace");
    await recordAudit(tx, auditFromCtx(ctx, "workspace.deleted", { type: "workspace", id }, { name: ws.name }));
  });
}
