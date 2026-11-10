import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { createThreadSchema, replySchema, threadFilterSchema, type ThreadFilter } from "@/lib/review";
import { frameCount, frameToTimecode, type Fps } from "@/lib/timecode";
import type { AuthContext } from "../authz/context";
import { requireProject } from "../authz/project-access";
import type { Tx } from "../db/client";
import {
  annotations,
  assetVersions,
  assets,
  commentMentions,
  commentThreads,
  comments,
  organizationMembers,
  projectMembers,
  roles,
  users,
  type AnnotationShape,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { forbidden, invalid, notFound } from "../errors";
import { parse } from "../lib/validate";
import { recordActivity } from "./activity";

/** Loads a version with its asset/project and checks the caller's project permission. */
async function requireVersion(tx: Tx, ctx: AuthContext, versionId: string, permission: "project.view" | "comment.create" = "project.view") {
  const [row] = await tx
    .select({
      versionId: assetVersions.id,
      versionNumber: assetVersions.versionNumber,
      mediaInfo: assetVersions.mediaInfo,
      assetId: assets.id,
      assetName: assets.name,
      projectId: assets.projectId,
    })
    .from(assetVersions)
    .innerJoin(assets, eq(assets.id, assetVersions.assetId))
    .where(and(eq(assetVersions.id, versionId), isNull(assets.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Version");
  const access = await requireProject(tx, ctx, row.projectId, permission);
  return { ...row, access };
}

async function requireThread(tx: Tx, ctx: AuthContext, threadId: string) {
  const [thread] = await tx.select().from(commentThreads).where(eq(commentThreads.id, threadId)).limit(1);
  if (!thread) throw notFound("Comment");
  const version = await requireVersion(tx, ctx, thread.assetVersionId);
  return { thread, version };
}

/**
 * Users who can be @mentioned in a project: its members plus everyone whose
 * org role grants access to all projects. Mentions of anyone else are rejected,
 * so a comment can never notify someone who cannot see it.
 */
async function mentionableIds(tx: Tx, projectId: string): Promise<Set<string>> {
  const members = await tx.select({ id: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, projectId));
  const admins = await tx
    .select({ id: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
    .where(and(eq(organizationMembers.status, "active"), sql`'project.access_all' = any(${roles.permissions})`));
  return new Set([...members, ...admins].map((m) => m.id));
}

export async function listMentionable(ctx: AuthContext, versionId: string) {
  return withTenant(ctx, async (tx) => {
    const v = await requireVersion(tx, ctx, versionId);
    const ids = [...(await mentionableIds(tx, v.projectId))];
    if (!ids.length) return [];
    return tx.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)).orderBy(asc(users.name));
  });
}

async function insertComment(tx: Tx, ctx: AuthContext, projectId: string, threadId: string, body: string, mentions: string[]) {
  const [comment] = await tx.insert(comments).values({ organizationId: ctx.orgId, threadId, authorUserId: ctx.userId, body }).returning();
  const unique = [...new Set(mentions)].filter((id) => id !== ctx.userId);
  if (unique.length) {
    const allowed = await mentionableIds(tx, projectId);
    const bad = unique.filter((id) => !allowed.has(id));
    if (bad.length) throw invalid("You can only mention people who have access to this project.");
    await tx.insert(commentMentions).values(unique.map((userId) => ({ organizationId: ctx.orgId, commentId: comment.id, userId })));
  }
  return comment;
}

export async function createThread(ctx: AuthContext, input: unknown) {
  const data = parse(createThreadSchema, input);
  return withTenant(ctx, async (tx) => {
    const v = await requireVersion(tx, ctx, data.versionId, "comment.create");
    const fps: Fps = v.mediaInfo.fps ?? { num: 24, den: 1 };
    const total = frameCount(v.mediaInfo.durationSec, fps);
    if (data.frame != null && total != null && data.frame >= total) throw invalid("That frame is outside the clip.");
    if (data.shapes.length && data.frame == null && (v.mediaInfo.durationSec ?? 0) > 0) {
      throw invalid("Drawings on video must be attached to a frame.");
    }
    const [thread] = await tx
      .insert(commentThreads)
      .values({
        organizationId: ctx.orgId,
        assetId: v.assetId,
        assetVersionId: v.versionId,
        anchorType: data.frame == null ? "none" : "frame",
        frame: data.frame,
        anchor:
          data.frame == null
            ? {}
            : {
                fpsNum: fps.num,
                fpsDen: fps.den,
                seconds: (data.frame * fps.den) / fps.num,
                timecode: frameToTimecode(data.frame, fps, v.mediaInfo.startTimecode),
              },
        createdBy: ctx.userId,
      })
      .returning();
    const comment = await insertComment(tx, ctx, v.projectId, thread.id, data.body, data.mentions);
    if (data.shapes.length) {
      await tx.insert(annotations).values({
        organizationId: ctx.orgId,
        assetVersionId: v.versionId,
        commentId: comment.id,
        frame: data.frame,
        shapes: data.shapes as AnnotationShape[],
        createdBy: ctx.userId,
      });
    }
    await recordActivity(tx, ctx, {
      projectId: v.projectId,
      verb: "comment.created",
      subjectType: "asset",
      subjectId: v.assetId,
      subjectName: v.assetName,
      data: { version: v.versionNumber, frame: data.frame, mentions: data.mentions.length },
    });
    return { threadId: thread.id, commentId: comment.id };
  });
}

export async function replyToThread(ctx: AuthContext, input: unknown) {
  const data = parse(replySchema, input);
  return withTenant(ctx, async (tx) => {
    const { thread, version } = await requireThread(tx, ctx, data.threadId);
    if (!version.access.permissions.has("comment.create")) throw forbidden();
    const comment = await insertComment(tx, ctx, version.projectId, thread.id, data.body, data.mentions);
    await tx.update(commentThreads).set({ updatedAt: new Date() }).where(eq(commentThreads.id, thread.id));
    await recordActivity(tx, ctx, {
      projectId: version.projectId,
      verb: "comment.replied",
      subjectType: "asset",
      subjectId: version.assetId,
      subjectName: version.assetName,
      data: { version: version.versionNumber },
    });
    return { commentId: comment.id };
  });
}

/** Resolve or reopen. Allowed for comment.resolve holders and for the thread's author. */
export async function setThreadStatus(ctx: AuthContext, input: unknown) {
  const data = parse(z.object({ threadId: z.uuid(), status: z.enum(["open", "resolved"]) }), input);
  return withTenant(ctx, async (tx) => {
    const { thread, version } = await requireThread(tx, ctx, data.threadId);
    const isAuthor = thread.createdBy === ctx.userId;
    if (!isAuthor && !version.access.permissions.has("comment.resolve")) throw forbidden("Only editors, managers or the author can resolve feedback.");
    if (thread.status === data.status) return;
    await tx
      .update(commentThreads)
      .set(
        data.status === "resolved"
          ? { status: "resolved", resolvedBy: ctx.userId, resolvedAt: new Date(), updatedAt: new Date() }
          : { status: "open", resolvedBy: null, resolvedAt: null, updatedAt: new Date() },
      )
      .where(eq(commentThreads.id, thread.id));
    await recordActivity(tx, ctx, {
      projectId: version.projectId,
      verb: data.status === "resolved" ? "comment.resolved" : "comment.reopened",
      subjectType: "asset",
      subjectId: version.assetId,
      subjectName: version.assetName,
      data: { version: version.versionNumber, frame: thread.frame },
    });
  });
}

/** Authors can delete their own comments (soft delete; the thread keeps its place). */
export async function deleteComment(ctx: AuthContext, commentId: string) {
  parse(z.uuid(), commentId);
  return withTenant(ctx, async (tx) => {
    const [c] = await tx.select().from(comments).where(eq(comments.id, commentId)).limit(1);
    if (!c || c.deletedAt) throw notFound("Comment");
    await requireThread(tx, ctx, c.threadId);
    if (c.authorUserId !== ctx.userId) throw forbidden("You can only delete your own comments.");
    await tx.update(comments).set({ deletedAt: new Date(), body: "[deleted]" }).where(eq(comments.id, commentId));
    await tx.delete(annotations).where(eq(annotations.commentId, commentId));
  });
}

export type ReviewComment = {
  id: string;
  authorId: string | null;
  authorName: string;
  body: string;
  deleted: boolean;
  createdAt: string;
  mentions: { id: string; name: string }[];
  annotation: { id: string; frame: number | null; shapes: AnnotationShape[] } | null;
};

export type ReviewThread = {
  id: string;
  frame: number | null;
  timecode: string | null;
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
  resolvedByName: string | null;
  resolvedAt: string | null;
  canResolve: boolean;
  comments: ReviewComment[];
};

/** Threads of one version, filtered and sorted. Never includes other versions' feedback. */
export async function listThreads(ctx: AuthContext, versionId: string, filter: ThreadFilter = {}) {
  parse(z.uuid(), versionId);
  const f = parse(threadFilterSchema, filter);
  return withTenant(ctx, async (tx) => {
    const v = await requireVersion(tx, ctx, versionId);
    const canResolveAll = v.access.permissions.has("comment.resolve");

    const conds = [eq(commentThreads.assetVersionId, versionId)];
    if (f.status !== "all") conds.push(eq(commentThreads.status, f.status));
    if (f.authorId) conds.push(sql`exists (select 1 from comments c where c.thread_id = ${commentThreads.id} and c.author_user_id = ${f.authorId} and c.deleted_at is null)`);
    if (f.q) conds.push(sql`exists (select 1 from comments c where c.thread_id = ${commentThreads.id} and c.deleted_at is null and (c.body_tsv @@ plainto_tsquery('simple', ${f.q}) or c.body ilike ${`%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}))`);
    if (f.annotated) conds.push(sql`exists (select 1 from annotations a join comments c on c.id = a.comment_id where c.thread_id = ${commentThreads.id})`);
    const order =
      f.sort === "newest"
        ? [desc(commentThreads.createdAt)]
        : f.sort === "oldest"
          ? [asc(commentThreads.createdAt)]
          : [sql`${commentThreads.frame} asc nulls first`, asc(commentThreads.createdAt)];

    const resolver = sql<string | null>`(select name from users u where u.id = ${commentThreads.resolvedBy})`;
    const threads = await tx
      .select({ t: commentThreads, resolverName: resolver })
      .from(commentThreads)
      .where(and(...conds))
      .orderBy(...order)
      .limit(1000);
    const threadIds = threads.map((t) => t.t.id);
    const rows = threadIds.length
      ? await tx
          .select({ c: comments, authorName: users.name })
          .from(comments)
          .leftJoin(users, eq(users.id, comments.authorUserId))
          .where(inArray(comments.threadId, threadIds))
          .orderBy(asc(comments.createdAt))
      : [];
    const commentIds = rows.map((r) => r.c.id);
    const mentionRows = commentIds.length
      ? await tx
          .select({ commentId: commentMentions.commentId, id: users.id, name: users.name })
          .from(commentMentions)
          .innerJoin(users, eq(users.id, commentMentions.userId))
          .where(inArray(commentMentions.commentId, commentIds))
      : [];
    const annRows = commentIds.length ? await tx.select().from(annotations).where(inArray(annotations.commentId, commentIds)) : [];

    const byThread = new Map<string, ReviewComment[]>();
    for (const r of rows) {
      const list = byThread.get(r.c.threadId) ?? [];
      const ann = annRows.find((a) => a.commentId === r.c.id);
      list.push({
        id: r.c.id,
        authorId: r.c.authorUserId,
        authorName: r.authorName ?? "Former member",
        body: r.c.body,
        deleted: !!r.c.deletedAt,
        createdAt: r.c.createdAt.toISOString(),
        mentions: mentionRows.filter((m) => m.commentId === r.c.id).map((m) => ({ id: m.id, name: m.name })),
        annotation: ann ? { id: ann.id, frame: ann.frame, shapes: ann.shapes } : null,
      });
      byThread.set(r.c.threadId, list);
    }

    const result: ReviewThread[] = threads.map(({ t, resolverName }) => ({
      id: t.id,
      frame: t.frame,
      timecode: t.anchor.timecode ?? null,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      resolvedByName: resolverName,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      canResolve: canResolveAll || t.createdBy === ctx.userId,
      comments: byThread.get(t.id) ?? [],
    }));

    // Feedback on other versions is reported, never moved (frames can't be mapped reliably).
    const otherVersions = await tx
      .select({
        versionNumber: assetVersions.versionNumber,
        open: sql<number>`count(*) filter (where ${commentThreads.status} = 'open')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(commentThreads)
      .innerJoin(assetVersions, eq(assetVersions.id, commentThreads.assetVersionId))
      .where(and(eq(commentThreads.assetId, v.assetId), sql`${commentThreads.assetVersionId} <> ${versionId}`))
      .groupBy(assetVersions.versionNumber)
      .orderBy(desc(assetVersions.versionNumber));

    const [counts] = await tx
      .select({
        open: sql<number>`count(*) filter (where ${commentThreads.status} = 'open')::int`,
        resolved: sql<number>`count(*) filter (where ${commentThreads.status} = 'resolved')::int`,
      })
      .from(commentThreads)
      .where(eq(commentThreads.assetVersionId, versionId));

    return { threads: result, counts, otherVersions };
  });
}
