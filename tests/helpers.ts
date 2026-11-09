import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { resolveOrgContext, type AuthContext } from "@/server/authz/context";
import { systemDb } from "@/server/db/client";
import { getSystemRole, syncSystemRoles } from "@/server/authz/roles";
import { organizationMembers, users } from "@/server/db/schema";
import { signUp } from "@/server/modules/auth";
import { createOrganization } from "@/server/modules/organizations";

export const meta = { ip: "127.0.0.1", userAgent: "vitest" };

/** Wipes all tenant data (keeps reference data: roles, providers). */
export async function resetDb() {
  await systemDb().execute(sql`
    truncate table audit_logs, activity_events, previews, processing_jobs, upload_sessions,
      asset_versions, assets, storage_locations, storage_connections, folders, project_favorites,
      project_members, projects, workspaces, invitations, organization_members, sessions,
      rate_limits, organizations, users cascade`);
  // CASCADE also empties `roles` (FK to organizations); restore the system roles.
  await syncSystemRoles(systemDb());
}

export async function makeUser(name = "User") {
  const email = `${name.toLowerCase().replace(/\W+/g, "")}-${randomUUID().slice(0, 8)}@example.com`;
  const { user } = await signUp({ name, email, password: "correct horse battery" }, meta);
  return user;
}

export async function makeOrg(owner: { id: string; name: string; email: string }, slug?: string) {
  const org = await createOrganization(owner, { name: `${owner.name}'s Studio`, slug: slug ?? `studio-${randomUUID().slice(0, 8)}` }, meta);
  return org;
}

export async function ctxFor(user: { id: string; name: string; email: string }, orgSlug: string): Promise<AuthContext> {
  const ctx = await resolveOrgContext(user, orgSlug, meta);
  if (!ctx) throw new Error(`No context for ${user.email} in ${orgSlug}`);
  return ctx;
}

/** Adds an existing user to an org with a system role (test shortcut for the invitation flow). */
export async function addToOrg(orgId: string, user: { id: string }, roleKey: string) {
  const role = await getSystemRole(systemDb(), "organization", roleKey);
  await systemDb().insert(organizationMembers).values({ organizationId: orgId, userId: user.id, roleId: role.id });
}

export async function userRow(id: string) {
  const [u] = await systemDb().select().from(users).where(sql`id = ${id}`);
  return u;
}
