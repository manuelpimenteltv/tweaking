import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthContext } from "@/server/authz/context";
import { systemDb } from "@/server/db/client";
import { assetVersions } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { createProject, upsertProjectMember } from "@/server/modules/projects";
import { createThread, deleteComment, listMentionable, listThreads, replyToThread, setThreadStatus } from "@/server/modules/review";
import { completeUpload, initiateUpload, signUploadParts } from "@/server/modules/uploads";
import { listWorkspaces } from "@/server/modules/workspaces";
import { createHash } from "node:crypto";
import { addToOrg, ctxFor, makeOrg, makeUser, resetDb } from "../helpers";

const arrow = { tool: "arrow" as const, points: [[0.2, 0.2], [0.6, 0.5]] as [number, number][], color: "#F2A93B", width: 3 };

async function uploadVersion(ctx: AuthContext, projectId: string, assetId?: string) {
  const data = Buffer.from(`fake video ${Math.random()}`);
  const init = await initiateUpload(ctx, { projectId, assetId: assetId ?? null, filename: "cut.mov", size: data.length, mimeType: "video/quicktime" });
  const checksum = createHash("sha256").update(data).digest("base64");
  const [s] = await signUploadParts(ctx, init.uploadId, { parts: [{ partNumber: 1, checksumSha256: checksum }] });
  const res = await fetch(s.url, { method: "PUT", headers: s.headers, body: new Uint8Array(data) });
  await completeUpload(ctx, init.uploadId, { parts: [{ partNumber: 1, etag: res.headers.get("etag")!, checksumSha256: checksum }] });
  // Simulate ingest metadata: 10 s at 23.976 with a start timecode.
  await systemDb()
    .update(assetVersions)
    .set({ processingStatus: "ready", mediaInfo: { durationSec: 10, fps: { num: 24000, den: 1001 }, startTimecode: "01:00:00:00" } })
    .where(sql`id = ${init.versionId}`);
  return init;
}

let owner: AuthContext, editor: AuthContext, client: AuthContext, outsider: AuthContext, other: AuthContext;
let projectId: string;
let users: Record<string, { id: string }>;

beforeEach(async () => {
  await resetDb();
  const o = await makeUser("Owner");
  const org = await makeOrg(o, "review-studio");
  const e = await makeUser("Editor");
  const c = await makeUser("Client");
  const x = await makeUser("Outsider");
  await addToOrg(org.id, e, "editor");
  await addToOrg(org.id, c, "client");
  await addToOrg(org.id, x, "reviewer");
  owner = await ctxFor(o, org.slug);
  editor = await ctxFor(e, org.slug);
  client = await ctxFor(c, org.slug);
  outsider = await ctxFor(x, org.slug);
  const otherUser = await makeUser("Other Studio");
  await makeOrg(otherUser, "other-studio");
  other = await ctxFor(otherUser, "other-studio");
  users = { owner: o, editor: e, client: c, outsider: x };
  const [ws] = await listWorkspaces(owner);
  projectId = (await createProject(owner, { name: "Spot", workspaceId: ws.id })).id;
  await upsertProjectMember(owner, { projectId, userId: e.id, roleKey: "editor" });
  await upsertProjectMember(owner, { projectId, userId: c.id, roleKey: "client" });
});

describe("review comments", () => {
  it("anchors comments to a frame of one version, with timecode and annotations", async () => {
    const v1 = await uploadVersion(owner, projectId);
    const { threadId } = await createThread(client, { versionId: v1.versionId, frame: 48, body: "Logo too small here", shapes: [arrow] });
    const { threads, counts } = await listThreads(editor, v1.versionId);
    expect(counts).toEqual({ open: 1, resolved: 0 });
    expect(threads[0]).toMatchObject({ id: threadId, frame: 48, timecode: "01:00:02:00", status: "open" });
    expect(threads[0].comments[0].annotation?.shapes[0]).toMatchObject({ tool: "arrow" });

    // A new version starts clean; the old feedback is reported, not moved.
    const v2 = await uploadVersion(owner, projectId, v1.assetId);
    const onV2 = await listThreads(editor, v2.versionId);
    expect(onV2.threads).toEqual([]);
    expect(onV2.otherVersions).toEqual([{ versionNumber: 1, open: 1, total: 1 }]);
  });

  it("replies, resolves and reopens with the right permissions", async () => {
    const v = await uploadVersion(owner, projectId);
    const { threadId } = await createThread(client, { versionId: v.versionId, frame: 10, body: "Color shift?" });
    await replyToThread(editor, { threadId, body: "Fixed in the next export" });
    // Clients can resolve their own threads; editors can resolve anyone's.
    await setThreadStatus(client, { threadId, status: "resolved" });
    let t = (await listThreads(owner, v.versionId)).threads[0];
    expect(t.status).toBe("resolved");
    expect(t.resolvedByName).toBe("Client");
    await setThreadStatus(editor, { threadId, status: "open" });
    t = (await listThreads(owner, v.versionId)).threads[0];
    expect(t.status).toBe("open");
    expect(t.comments.map((c) => c.body)).toEqual(["Color shift?", "Fixed in the next export"]);

    const { threadId: editorThread } = await createThread(editor, { versionId: v.versionId, frame: 20, body: "Internal note" });
    await expect(setThreadStatus(client, { threadId: editorThread, status: "resolved" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("only allows mentions of people who can see the project", async () => {
    const v = await uploadVersion(owner, projectId);
    const mentionable = (await listMentionable(editor, v.versionId)).map((u) => u.id);
    expect(mentionable).toEqual(expect.arrayContaining([users.owner.id, users.editor.id, users.client.id]));
    expect(mentionable).not.toContain(users.outsider.id);
    await expect(
      createThread(editor, { versionId: v.versionId, frame: 1, body: "@Outsider look", mentions: [users.outsider.id] }),
    ).rejects.toMatchObject({ code: "validation" });
    await createThread(editor, { versionId: v.versionId, frame: 1, body: "@Client please check", mentions: [users.client.id] });
    const t = (await listThreads(owner, v.versionId)).threads[0];
    expect(t.comments[0].mentions).toEqual([{ id: users.client.id, name: "Client" }]);
  });

  it("filters, searches and sorts", async () => {
    const v = await uploadVersion(owner, projectId);
    const late = await createThread(client, { versionId: v.versionId, frame: 200, body: "Music too loud" });
    await createThread(editor, { versionId: v.versionId, frame: 5, body: "Flash frame", shapes: [arrow] });
    await createThread(editor, { versionId: v.versionId, frame: null, body: "Overall: great pacing" });
    await setThreadStatus(editor, { threadId: late.threadId, status: "resolved" });

    const byTc = (await listThreads(owner, v.versionId)).threads.map((t) => t.frame);
    expect(byTc).toEqual([null, 5, 200]);
    const newest = (await listThreads(owner, v.versionId, { sort: "newest" })).threads.map((t) => t.comments[0].body);
    expect(newest).toEqual(["Overall: great pacing", "Flash frame", "Music too loud"]);
    expect((await listThreads(owner, v.versionId, { status: "open" })).threads).toHaveLength(2);
    expect((await listThreads(owner, v.versionId, { status: "resolved" })).threads).toHaveLength(1);
    expect((await listThreads(owner, v.versionId, { authorId: users.client.id })).threads).toHaveLength(1);
    expect((await listThreads(owner, v.versionId, { q: "loud" })).threads).toHaveLength(1);
    expect((await listThreads(owner, v.versionId, { annotated: true })).threads).toHaveLength(1);
  });

  it("rejects invalid input, out-of-range frames, outsiders and other studios", async () => {
    const v = await uploadVersion(owner, projectId);
    await expect(createThread(client, { versionId: v.versionId, frame: 100_000, body: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(createThread(client, { versionId: v.versionId, frame: 1, body: "   " })).rejects.toMatchObject({ code: "validation" });
    await expect(createThread(client, { versionId: v.versionId, frame: null, body: "x", shapes: [arrow] })).rejects.toMatchObject({ code: "validation" });
    await expect(createThread(outsider, { versionId: v.versionId, frame: 1, body: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(listThreads(other, v.versionId)).rejects.toMatchObject({ code: "not_found" });
    // RLS: another studio sees no review rows even unfiltered.
    await createThread(client, { versionId: v.versionId, frame: 1, body: "secret" });
    const leaked = await withTenant(other, (tx) => tx.execute(sql`select count(*)::int as n from comments`));
    expect(leaked.rows[0].n).toBe(0);
  });

  it("lets authors delete their own comments and removes their drawings", async () => {
    const v = await uploadVersion(owner, projectId);
    const { commentId } = await createThread(client, { versionId: v.versionId, frame: 3, body: "oops", shapes: [arrow] });
    await expect(deleteComment(editor, commentId)).rejects.toMatchObject({ code: "forbidden" });
    await deleteComment(client, commentId);
    const c = (await listThreads(owner, v.versionId)).threads[0].comments[0];
    expect(c).toMatchObject({ deleted: true, body: "[deleted]", annotation: null });
  });
});
