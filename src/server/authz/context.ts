import { and, eq, isNull } from "drizzle-orm";
import { organizationMembers, organizations, roles } from "../db/schema";
import { withUser } from "../db/tenant";
import { forbidden } from "../errors";
import { isPermission, type Permission } from "./permissions";

export type RequestMeta = { ip: string | null; userAgent: string | null };

/** Everything a service needs to authorize an action. Built once per request. */
export type AuthContext = {
  userId: string;
  userName: string;
  userEmail: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  memberId: string;
  role: { id: string; key: string; name: string };
  permissions: ReadonlySet<Permission>;
  request: RequestMeta;
};

export function can(ctx: Pick<AuthContext, "permissions">, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function authorize(ctx: Pick<AuthContext, "permissions">, permission: Permission): void {
  if (!ctx.permissions.has(permission)) throw forbidden();
}

/**
 * Resolves the user's active membership in the org identified by `slug`.
 * Returns null when the org does not exist or the user is not an active member
 * (callers render 404 so existence is not revealed).
 */
export async function resolveOrgContext(
  user: { id: string; name: string; email: string },
  slug: string,
  request: RequestMeta,
): Promise<AuthContext | null> {
  const row = await withUser(user.id, async (tx) => {
    const [r] = await tx
      .select({
        orgId: organizations.id,
        orgSlug: organizations.slug,
        orgName: organizations.name,
        memberId: organizationMembers.id,
        status: organizationMembers.status,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        permissions: roles.permissions,
      })
      .from(organizations)
      .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(
        and(eq(organizations.slug, slug), eq(organizationMembers.userId, user.id), isNull(organizations.deletedAt)),
      )
      .limit(1);
    return r;
  });
  if (!row || row.status !== "active") return null;
  return {
    userId: user.id,
    userName: user.name,
    userEmail: user.email,
    orgId: row.orgId,
    orgSlug: row.orgSlug,
    orgName: row.orgName,
    memberId: row.memberId,
    role: { id: row.roleId, key: row.roleKey, name: row.roleName },
    permissions: new Set(row.permissions.filter(isPermission)),
    request,
  };
}
