import { desc, eq, lt, and } from "drizzle-orm";
import type { Executor } from "../db/client";
import { auditLogs, users } from "../db/schema";
import { withTenant } from "../db/tenant";
import { authorize, type AuthContext, type RequestMeta } from "../authz/context";

export type AuditEntry = {
  orgId: string | null;
  actorUserId: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  data?: Record<string, unknown>;
  request?: RequestMeta;
};

/** Append-only security trail. Call inside the same transaction as the change it records. */
export async function recordAudit(exec: Executor, e: AuditEntry) {
  await exec.insert(auditLogs).values({
    organizationId: e.orgId,
    actorUserId: e.actorUserId,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    data: e.data ?? {},
    ip: e.request?.ip ?? null,
    userAgent: e.request?.userAgent?.slice(0, 512) ?? null,
  });
}

export function auditFromCtx(ctx: AuthContext, action: string, target?: { type: string; id?: string | null }, data?: Record<string, unknown>): AuditEntry {
  return { orgId: ctx.orgId, actorUserId: ctx.userId, action, targetType: target?.type, targetId: target?.id, data, request: ctx.request };
}

export async function listAuditLog(ctx: AuthContext, opts: { before?: Date; limit?: number } = {}) {
  authorize(ctx, "org.view_audit_log");
  const limit = Math.min(opts.limit ?? 50, 200);
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        ip: auditLogs.ip,
        data: auditLogs.data,
        createdAt: auditLogs.createdAt,
        actorName: users.name,
        actorEmail: users.email,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(and(eq(auditLogs.organizationId, ctx.orgId), opts.before ? lt(auditLogs.createdAt, opts.before) : undefined))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit),
  );
}
