import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { email as emailSchema, inviteSchema, uuid } from "@/lib/validation";
import { authorize, can, type AuthContext } from "../authz/context";
import { PROJECT_ROLE_CEILING } from "../authz/permissions";
import { requireProject } from "../authz/project-access";
import { getSystemRole, listRoles } from "../authz/roles";
import { systemDb, type Tx } from "../db/client";
import {
  invitations,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  roles,
  users,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { env } from "../env";
import { AppError, conflict, forbidden, invalid, notFound } from "../errors";
import { randomToken, sha256Hex } from "../lib/crypto";
import { parse } from "../lib/validate";
import { getMailer } from "../mail/mailer";
import { auditFromCtx, recordAudit } from "./audit";
import { recordActivity } from "./activity";

const INVITE_TTL_DAYS = 7;

export async function listMembers(ctx: AuthContext) {
  authorize(ctx, "org.view_internal");
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: organizationMembers.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        status: organizationMembers.status,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        joinedAt: organizationMembers.createdAt,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(eq(organizationMembers.organizationId, ctx.orgId))
      .orderBy(desc(roles.rank), asc(users.name)),
  );
}

export async function listOrgRoles(ctx: AuthContext) {
  return withTenant(ctx, (tx) => listRoles(tx, ctx.orgId, "organization"));
}

export async function listProjectRoles(ctx: AuthContext) {
  return withTenant(ctx, (tx) => listRoles(tx, ctx.orgId, "project"));
}

async function ownerCount(tx: Tx, orgId: string) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(and(eq(organizationMembers.organizationId, orgId), eq(roles.key, "owner"), isNull(roles.organizationId)));
  return r?.n ?? 0;
}

async function loadMember(tx: Tx, ctx: AuthContext, memberId: string) {
  const [m] = await tx
    .select({ id: organizationMembers.id, userId: organizationMembers.userId, roleKey: roles.key, name: users.name })
    .from(organizationMembers)
    .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.id, memberId), eq(organizationMembers.organizationId, ctx.orgId)))
    .limit(1);
  if (!m) throw notFound("Member");
  return m;
}

async function loadOrgRole(tx: Tx, ctx: AuthContext, roleId: string) {
  const [role] = await tx
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.scope, "organization")))
    .limit(1);
  if (!role || (role.organizationId && role.organizationId !== ctx.orgId)) throw invalid("Unknown role.", { roleId: "Unknown role." });
  return role;
}

/** Only owners may grant or revoke the owner role. */
function assertCanAssign(ctx: AuthContext, roleKey: string) {
  if (roleKey === "owner" && ctx.role.key !== "owner") throw forbidden("Only a Studio Owner can grant the owner role.");
}

export async function changeMemberRole(ctx: AuthContext, input: { memberId: string; roleId: string }) {
  authorize(ctx, "org.manage_members");
  const { memberId, roleId } = parse(z.object({ memberId: uuid, roleId: uuid }), input);
  return withTenant(ctx, async (tx) => {
    const member = await loadMember(tx, ctx, memberId);
    const role = await loadOrgRole(tx, ctx, roleId);
    assertCanAssign(ctx, role.key);
    if (member.roleKey === "owner") {
      if (ctx.role.key !== "owner") throw forbidden("Only a Studio Owner can change another owner's role.");
      if (role.key !== "owner" && (await ownerCount(tx, ctx.orgId)) <= 1) {
        throw conflict("An organization needs at least one Studio Owner.");
      }
    }
    await tx
      .update(organizationMembers)
      .set({ roleId: role.id, updatedAt: new Date() })
      .where(eq(organizationMembers.id, member.id));

    // Clamp project roles that now exceed the member's org-role ceiling.
    const allowed = PROJECT_ROLE_CEILING[role.key] ?? ["guest"];
    const fallback = await getSystemRole(tx, "project", allowed[0]);
    const clamped = await tx
      .update(projectMembers)
      .set({ roleId: fallback.id })
      .where(
        and(
          eq(projectMembers.organizationId, ctx.orgId),
          eq(projectMembers.userId, member.userId),
          sql`${projectMembers.roleId} in (select id from roles where scope = 'project' and key <> all(${`{${allowed.join(",")}}`}::text[]))`,
        ),
      )
      .returning({ id: projectMembers.id });

    await recordAudit(
      tx,
      auditFromCtx(ctx, "member.role_changed", { type: "user", id: member.userId }, {
        from: member.roleKey,
        to: role.key,
        projectRolesClamped: clamped.length,
      }),
    );
  });
}

export async function removeMember(ctx: AuthContext, memberId: string) {
  authorize(ctx, "org.manage_members");
  parse(uuid, memberId);
  return withTenant(ctx, async (tx) => {
    const member = await loadMember(tx, ctx, memberId);
    if (member.roleKey === "owner") {
      if (ctx.role.key !== "owner") throw forbidden("Only a Studio Owner can remove an owner.");
      if ((await ownerCount(tx, ctx.orgId)) <= 1) throw conflict("An organization needs at least one Studio Owner.");
    }
    await tx
      .delete(projectMembers)
      .where(and(eq(projectMembers.organizationId, ctx.orgId), eq(projectMembers.userId, member.userId)));
    await tx.delete(organizationMembers).where(eq(organizationMembers.id, member.id));
    await recordAudit(tx, auditFromCtx(ctx, "member.removed", { type: "user", id: member.userId }, { name: member.name }));
  });
}

// ── Invitations ─────────────────────────────────────────────────────────────

export function invitationUrl(token: string) {
  return `${env().APP_URL.replace(/\/$/, "")}/invite/${token}`;
}

async function issueInvitation(
  tx: Tx,
  ctx: AuthContext,
  args: { email: string; roleId: string; roleName: string; projectId?: string; projectRoleId?: string; projectName?: string },
) {
  const [existingMember] = await tx
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.organizationId, ctx.orgId), eq(users.email, args.email)))
    .limit(1);
  if (existingMember && !args.projectId) {
    throw conflict("This person is already a member.", { email: "Already a member of this organization." });
  }
  // Replace any pending invitation for the same email.
  await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.organizationId, ctx.orgId),
        eq(invitations.email, args.email),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    );
  const token = randomToken(32);
  const [inv] = await tx
    .insert(invitations)
    .values({
      organizationId: ctx.orgId,
      email: args.email,
      roleId: args.roleId,
      projectId: args.projectId ?? null,
      projectRoleId: args.projectRoleId ?? null,
      tokenHash: sha256Hex(token),
      invitedBy: ctx.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    })
    .returning();
  await recordAudit(
    tx,
    auditFromCtx(ctx, "invitation.created", { type: "invitation", id: inv.id }, {
      email: args.email,
      role: args.roleName,
      projectId: args.projectId,
    }),
  );
  const url = invitationUrl(token);
  const where = args.projectName ? `the project "${args.projectName}" at ${ctx.orgName}` : ctx.orgName;
  await getMailer().send({
    to: args.email,
    subject: `${ctx.userName} invited you to ${where}`,
    text: `${ctx.userName} invited you to join ${where} on Loupe as ${args.roleName}.\n\nAccept: ${url}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
  });
  return { invitation: inv, url, emailSent: getMailer().configured };
}

export async function createInvitation(ctx: AuthContext, input: unknown) {
  authorize(ctx, "org.manage_members");
  const data = parse(inviteSchema, input);
  return withTenant(ctx, async (tx) => {
    const role = await loadOrgRole(tx, ctx, data.roleId);
    assertCanAssign(ctx, role.key);
    return issueInvitation(tx, ctx, { email: data.email, roleId: role.id, roleName: role.name });
  });
}

/**
 * Project-scoped invitation (Project Managers inviting collaborators and clients).
 * Grants the org role with the same key as the project role (never above Editor
 * without org.manage_members), plus the project membership.
 */
export async function inviteToProject(ctx: AuthContext, input: unknown) {
  const data = parse(z.object({ projectId: uuid, email: emailSchema, projectRoleKey: z.enum(["project_manager", "editor", "reviewer", "client", "guest"]) }), input);
  return withTenant(ctx, async (tx) => {
    const access = await requireProject(tx, ctx, data.projectId, "project.manage_members");
    if (data.projectRoleKey === "project_manager" && !can(ctx, "org.manage_members")) {
      throw forbidden("Only administrators can invite new Project Managers.");
    }
    const orgRole = await getSystemRole(tx, "organization", data.projectRoleKey);
    const projectRole = await getSystemRole(tx, "project", data.projectRoleKey);
    return issueInvitation(tx, ctx, {
      email: data.email,
      roleId: orgRole.id,
      roleName: projectRole.name,
      projectId: access.project.id,
      projectRoleId: projectRole.id,
      projectName: access.project.name,
    });
  });
}

export async function listPendingInvitations(ctx: AuthContext) {
  authorize(ctx, "org.view_internal");
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: invitations.id,
        email: invitations.email,
        roleName: roles.name,
        projectName: projects.name,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .innerJoin(roles, eq(roles.id, invitations.roleId))
      .leftJoin(projects, eq(projects.id, invitations.projectId))
      .where(
        and(
          eq(invitations.organizationId, ctx.orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(invitations.createdAt)),
  );
}

export async function revokeInvitation(ctx: AuthContext, invitationId: string) {
  authorize(ctx, "org.manage_members");
  parse(uuid, invitationId);
  return withTenant(ctx, async (tx) => {
    const [inv] = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt)))
      .returning();
    if (!inv) throw notFound("Invitation");
    await recordAudit(tx, auditFromCtx(ctx, "invitation.revoked", { type: "invitation", id: inv.id }, { email: inv.email }));
  });
}

export type InvitationPreview = {
  orgName: string;
  email: string;
  roleName: string;
  projectName: string | null;
  status: "valid" | "expired" | "revoked" | "accepted";
};

/** Token lookup happens before any tenant context exists: system path. */
export async function previewInvitation(token: string): Promise<InvitationPreview | null> {
  if (!token || token.length > 128) return null;
  const [row] = await systemDb()
    .select({
      orgName: organizations.name,
      email: invitations.email,
      roleName: roles.name,
      projectName: projects.name,
      expiresAt: invitations.expiresAt,
      revokedAt: invitations.revokedAt,
      acceptedAt: invitations.acceptedAt,
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .innerJoin(roles, eq(roles.id, invitations.roleId))
    .leftJoin(projects, eq(projects.id, invitations.projectId))
    .where(eq(invitations.tokenHash, sha256Hex(token)))
    .limit(1);
  if (!row) return null;
  const status = row.acceptedAt ? "accepted" : row.revokedAt ? "revoked" : row.expiresAt < new Date() ? "expired" : "valid";
  return { orgName: row.orgName, email: row.email, roleName: row.roleName, projectName: row.projectName, status };
}

export async function acceptInvitation(
  user: { id: string; email: string },
  token: string,
  meta: { ip: string | null; userAgent: string | null },
) {
  return systemDb().transaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, sha256Hex(token)))
      .for("update")
      .limit(1);
    if (!inv || inv.revokedAt || inv.acceptedAt) throw new AppError("not_found", "This invitation is no longer valid.");
    if (inv.expiresAt < new Date()) throw new AppError("not_found", "This invitation has expired.");
    if (inv.email !== user.email) {
      throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that address to accept it.`);
    }
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, inv.organizationId)).limit(1);

    const [existing] = await tx
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, inv.organizationId), eq(organizationMembers.userId, user.id)))
      .limit(1);
    if (!existing) {
      await tx
        .insert(organizationMembers)
        .values({ organizationId: inv.organizationId, userId: user.id, roleId: inv.roleId, invitedBy: inv.invitedBy });
    }
    if (inv.projectId && inv.projectRoleId) {
      await tx
        .insert(projectMembers)
        .values({
          organizationId: inv.organizationId,
          projectId: inv.projectId,
          userId: user.id,
          roleId: inv.projectRoleId,
          addedBy: inv.invitedBy,
        })
        .onConflictDoNothing();
    }
    await tx.update(invitations).set({ acceptedAt: new Date(), acceptedBy: user.id }).where(eq(invitations.id, inv.id));
    await recordAudit(tx, {
      orgId: inv.organizationId,
      actorUserId: user.id,
      action: "invitation.accepted",
      targetType: "invitation",
      targetId: inv.id,
      request: meta,
    });
    await recordActivity(tx, { orgId: inv.organizationId, userId: user.id }, {
      projectId: inv.projectId,
      verb: "member.joined",
      subjectType: "user",
      subjectId: user.id,
    });
    return { orgSlug: org.slug, projectId: inv.projectId };
  });
}

/** Members of the org who could be added to a project, with their org role (for ceilings). */
export async function listAssignableMembers(ctx: AuthContext, projectId: string) {
  return withTenant(ctx, async (tx) => {
    await requireProject(tx, ctx, projectId, "project.manage_members");
    const existing = tx.select({ id: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, projectId));
    return tx
      .select({ userId: users.id, name: users.name, email: users.email, orgRoleKey: roles.key })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .where(
        and(
          eq(organizationMembers.organizationId, ctx.orgId),
          eq(organizationMembers.status, "active"),
          sql`${users.id} not in (${existing})`,
        ),
      )
      .orderBy(asc(users.name));
  });
}

