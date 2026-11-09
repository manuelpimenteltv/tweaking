import { and, desc, eq, or, isNull } from "drizzle-orm";
import type { Tx } from "../db/client";
import { activityEvents, projects, users } from "../db/schema";
import { withTenant } from "../db/tenant";
import type { AuthContext } from "../authz/context";
import { accessibleProjectIds, requireProject } from "../authz/project-access";

export type ActivityInput = {
  projectId?: string | null;
  verb: string;
  subjectType: string;
  subjectId?: string | null;
  subjectName?: string;
  data?: Record<string, unknown>;
};

export async function recordActivity(tx: Tx, ctx: Pick<AuthContext, "orgId" | "userId">, a: ActivityInput) {
  await tx.insert(activityEvents).values({
    organizationId: ctx.orgId,
    projectId: a.projectId ?? null,
    actorUserId: ctx.userId,
    verb: a.verb,
    subjectType: a.subjectType,
    subjectId: a.subjectId ?? null,
    subjectName: a.subjectName ?? "",
    data: a.data ?? {},
  });
}

const selection = {
  id: activityEvents.id,
  verb: activityEvents.verb,
  subjectType: activityEvents.subjectType,
  subjectId: activityEvents.subjectId,
  subjectName: activityEvents.subjectName,
  data: activityEvents.data,
  createdAt: activityEvents.createdAt,
  projectId: activityEvents.projectId,
  projectName: projects.name,
  actorName: users.name,
};

/** Org-wide feed, restricted to projects the user can see (plus org-level events for internal members). */
export async function listOrgActivity(ctx: AuthContext, limit = 30) {
  return withTenant(ctx, (tx) =>
    tx
      .select(selection)
      .from(activityEvents)
      .leftJoin(projects, eq(projects.id, activityEvents.projectId))
      .leftJoin(users, eq(users.id, activityEvents.actorUserId))
      .where(
        or(
          ctx.permissions.has("org.view_internal") ? isNull(activityEvents.projectId) : undefined,
          and(accessibleProjectIds(ctx, activityEvents.projectId), isNull(projects.deletedAt)),
        ),
      )
      .orderBy(desc(activityEvents.createdAt))
      .limit(Math.min(limit, 100)),
  );
}

export async function listProjectActivity(ctx: AuthContext, projectId: string, limit = 50) {
  return withTenant(ctx, async (tx) => {
    await requireProject(tx, ctx, projectId);
    return tx
      .select(selection)
      .from(activityEvents)
      .leftJoin(projects, eq(projects.id, activityEvents.projectId))
      .leftJoin(users, eq(users.id, activityEvents.actorUserId))
      .where(eq(activityEvents.projectId, projectId))
      .orderBy(desc(activityEvents.createdAt))
      .limit(Math.min(limit, 200));
  });
}
