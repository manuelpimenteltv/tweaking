import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Tx } from "../db/client";
import { projectMembers, projects, roles } from "../db/schema";
import { forbidden, notFound } from "../errors";
import type { AuthContext } from "./context";
import { PROJECT_PERMISSIONS, isPermission, type Permission, type ProjectPermission } from "./permissions";

export type ProjectAccess = {
  project: typeof projects.$inferSelect;
  permissions: ReadonlySet<Permission>;
  projectRoleKey: string | null;
};

const ALL_PROJECT = new Set<Permission>(PROJECT_PERMISSIONS);

/**
 * Effective permissions inside a project:
 *  - org roles with project.access_all → every project permission;
 *  - otherwise the permissions of the user's project_members role;
 *  - no membership → no access (null, rendered as 404).
 */
export async function getProjectAccess(tx: Tx, ctx: AuthContext, projectId: string): Promise<ProjectAccess | null> {
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (!project) return null;

  const [membership] = await tx
    .select({ key: roles.key, permissions: roles.permissions })
    .from(projectMembers)
    .innerJoin(roles, eq(roles.id, projectMembers.roleId))
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, ctx.userId)))
    .limit(1);

  if (ctx.permissions.has("project.access_all")) {
    return { project, permissions: ALL_PROJECT, projectRoleKey: membership?.key ?? null };
  }
  if (!membership) return null;
  return { project, permissions: new Set(membership.permissions.filter(isPermission)), projectRoleKey: membership.key };
}

export async function requireProject(
  tx: Tx,
  ctx: AuthContext,
  projectId: string,
  permission: ProjectPermission = "project.view",
): Promise<ProjectAccess> {
  const access = await getProjectAccess(tx, ctx, projectId);
  if (!access) throw notFound("Project");
  if (!access.permissions.has(permission)) throw forbidden();
  return access;
}

/** SQL predicate restricting `projects.id` (or a column referencing it) to projects the user can view. */
export function accessibleProjectIds(ctx: AuthContext, column: AnyPgColumn | SQL = projects.id): SQL {
  if (ctx.permissions.has("project.access_all")) return sql`true`;
  return sql`${column} in (select ${projectMembers.projectId} from ${projectMembers} where ${projectMembers.userId} = ${ctx.userId})`;
}
