import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../db/client";
import { roles } from "../db/schema";
import { SYSTEM_ORG_ROLES, SYSTEM_PROJECT_ROLES } from "./permissions";

/** Upserts the code-defined system roles into the roles table. Idempotent. */
export async function syncSystemRoles(exec: Executor) {
  const defs = [
    ...SYSTEM_ORG_ROLES.map((r) => ({ ...r, scope: "organization" as const })),
    ...SYSTEM_PROJECT_ROLES.map((r) => ({ ...r, scope: "project" as const })),
  ];
  for (const r of defs) {
    await exec.execute(sql`
      insert into roles (organization_id, scope, key, name, description, permissions, is_system, rank)
      values (null, ${r.scope}, ${r.key}, ${r.name}, ${r.description}, ${`{${r.permissions.join(",")}}`}::text[], true, ${r.rank})
      on conflict on constraint roles_org_scope_key_uq do update set
        name = excluded.name, description = excluded.description,
        permissions = excluded.permissions, rank = excluded.rank, is_system = true`);
  }
}

export async function getSystemRole(exec: Executor, scope: "organization" | "project", key: string) {
  const [role] = await exec
    .select()
    .from(roles)
    .where(and(isNull(roles.organizationId), eq(roles.scope, scope), eq(roles.key, key)))
    .limit(1);
  if (!role) throw new Error(`System role ${scope}/${key} missing — run migrations (pnpm db:migrate).`);
  return role;
}

/** Roles assignable in the current org (system + org custom), highest rank first. */
export async function listRoles(exec: Executor, orgId: string, scope: "organization" | "project") {
  return exec
    .select()
    .from(roles)
    .where(and(eq(roles.scope, scope), or(isNull(roles.organizationId), eq(roles.organizationId, orgId))))
    .orderBy(sql`${roles.rank} desc`, asc(roles.name));
}
