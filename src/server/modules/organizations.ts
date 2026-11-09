import { and, asc, eq, sql } from "drizzle-orm";
import { createOrgSchema, updateOrgSchema } from "@/lib/validation";
import { authorize, type AuthContext, type RequestMeta } from "../authz/context";
import { getSystemRole } from "../authz/roles";
import { systemDb } from "../db/client";
import { organizationMembers, organizations, roles, storageConnections, workspaces } from "../db/schema";
import { withTenant, withUser } from "../db/tenant";
import { env } from "../env";
import { conflict, isUniqueViolation } from "../errors";
import { parse } from "../lib/validate";
import { recordAudit, auditFromCtx } from "./audit";
import { recordActivity } from "./activity";

/**
 * Bootstraps a studio. Runs on the system path because no tenant context exists
 * yet. Creates: org, owner membership, default workspace, platform storage connection.
 */
export async function createOrganization(user: { id: string }, input: unknown, meta: RequestMeta) {
  const data = parse(createOrgSchema, input);
  const db = systemDb();
  try {
    return await db.transaction(async (tx) => {
      const owner = await getSystemRole(tx, "organization", "owner");
      const [org] = await tx.insert(organizations).values({ name: data.name, slug: data.slug }).returning();
      await tx.insert(organizationMembers).values({ organizationId: org.id, userId: user.id, roleId: owner.id });
      await tx.insert(workspaces).values({ organizationId: org.id, name: "General", createdBy: user.id });
      await tx.insert(storageConnections).values({
        organizationId: org.id,
        providerId: "platform",
        name: "Loupe Cloud Storage",
        isDefault: true,
        config: { bucket: env().S3_BUCKET, prefix: `orgs/${org.id}/` },
        lastVerifiedAt: new Date(),
        createdBy: user.id,
      });
      await recordAudit(tx, { orgId: org.id, actorUserId: user.id, action: "org.created", targetType: "organization", targetId: org.id, data: { slug: org.slug }, request: meta });
      await recordActivity(tx, { orgId: org.id, userId: user.id }, { verb: "org.created", subjectType: "organization", subjectId: org.id, subjectName: org.name });
      return org;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("That address is taken.", { slug: "That address is taken." });
    throw err;
  }
}

export async function isSlugAvailable(slug: string) {
  const [row] = await systemDb().select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
  return !row;
}

/** Organizations the user is an active member of (RLS: own memberships only). */
export async function listMyOrganizations(userId: string) {
  return withUser(userId, (tx) =>
    tx
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, roleName: roles.name })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, "active"), sql`${organizations.deletedAt} is null`))
      .orderBy(asc(organizations.name)),
  );
}

export async function getOrganization(ctx: AuthContext) {
  return withTenant(ctx, async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId)).limit(1);
    return org;
  });
}

export async function updateOrganization(ctx: AuthContext, input: unknown) {
  authorize(ctx, "org.manage_settings");
  const data = parse(updateOrgSchema, input);
  return withTenant(ctx, async (tx) => {
    const [org] = await tx
      .update(organizations)
      .set({
        name: data.name,
        branding: { accentColor: data.accentColor || undefined, portalTitle: data.portalTitle || undefined },
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, ctx.orgId))
      .returning();
    await recordAudit(tx, auditFromCtx(ctx, "org.settings_updated", { type: "organization", id: ctx.orgId }, { name: data.name }));
    return org;
  });
}
