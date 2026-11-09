import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@/server/db/client";
import { getSystemRole } from "@/server/authz/roles";
import { acceptInvitation, changeMemberRole, createInvitation, listMembers, previewInvitation, removeMember } from "@/server/modules/members";
import { createProject, getProject, listProjects, upsertProjectMember } from "@/server/modules/projects";
import { listWorkspaces } from "@/server/modules/workspaces";
import { createFolder } from "@/server/modules/assets";
import { initiateUpload } from "@/server/modules/uploads";
import { search } from "@/server/modules/search";
import { listAuditLog } from "@/server/modules/audit";
import { addToOrg, ctxFor, makeOrg, makeUser, meta, resetDb } from "../helpers";

async function studio() {
  const owner = await makeUser("Owner");
  const org = await makeOrg(owner, "north-post");
  const people = {
    admin: await makeUser("Admin"),
    pm: await makeUser("Pm"),
    editor: await makeUser("Editor"),
    reviewer: await makeUser("Reviewer"),
    client: await makeUser("Client"),
  };
  await addToOrg(org.id, people.admin, "admin");
  await addToOrg(org.id, people.pm, "project_manager");
  await addToOrg(org.id, people.editor, "editor");
  await addToOrg(org.id, people.reviewer, "reviewer");
  await addToOrg(org.id, people.client, "client");
  const ctx = {
    owner: await ctxFor(owner, org.slug),
    admin: await ctxFor(people.admin, org.slug),
    pm: await ctxFor(people.pm, org.slug),
    editor: await ctxFor(people.editor, org.slug),
    reviewer: await ctxFor(people.reviewer, org.slug),
    client: await ctxFor(people.client, org.slug),
  };
  const [ws] = await listWorkspaces(ctx.owner);
  return { org, owner, people, ctx, ws };
}

describe("role-based access", () => {
  beforeEach(resetDb);

  it("only roles with project.create can create projects", async () => {
    const { ctx, ws } = await studio();
    await expect(createProject(ctx.editor, { name: "Nope", workspaceId: ws.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createProject(ctx.client, { name: "Nope", workspaceId: ws.id })).rejects.toMatchObject({ code: "forbidden" });
    const p = await createProject(ctx.pm, { name: "Spot 30s", workspaceId: ws.id });
    expect((await getProject(ctx.pm, p.id)).permissions).toContain("project.manage_members");
  });

  it("scopes project visibility by membership; admins see everything", async () => {
    const { ctx, ws } = await studio();
    const a = await createProject(ctx.owner, { name: "Feature Film", workspaceId: ws.id });
    const b = await createProject(ctx.pm, { name: "Music Video", workspaceId: ws.id });
    expect((await listProjects(ctx.admin)).map((p) => p.name).sort()).toEqual(["Feature Film", "Music Video"]);
    expect((await listProjects(ctx.pm)).map((p) => p.id)).toEqual([b.id]);
    expect(await listProjects(ctx.editor)).toEqual([]);
    await expect(getProject(ctx.editor, a.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("enforces project permissions and org-role ceilings for clients", async () => {
    const { ctx, ws, people } = await studio();
    const p = await createProject(ctx.pm, { name: "Brand Film", workspaceId: ws.id });
    await expect(upsertProjectMember(ctx.pm, { projectId: p.id, userId: people.client.id, roleKey: "editor" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await upsertProjectMember(ctx.pm, { projectId: p.id, userId: people.client.id, roleKey: "client" });
    const seen = await getProject(ctx.client, p.id);
    expect(seen.permissions).toEqual(expect.arrayContaining(["project.view", "approval.decide"]));
    expect(seen.permissions).not.toContain("asset.upload");
    await expect(
      initiateUpload(ctx.client, { projectId: p.id, filename: "x.mov", size: 1000, mimeType: "video/quicktime" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(createFolder(ctx.client, { projectId: p.id, name: "Mine" })).rejects.toMatchObject({ code: "forbidden" });
    // Clients have no access to internal areas like the member directory.
    await expect(listMembers(ctx.client)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("protects the owner role", async () => {
    const { ctx, org } = await studio();
    const owner = await getSystemRole(systemDb(), "organization", "owner");
    const editor = await getSystemRole(systemDb(), "organization", "editor");
    const members = await listMembers(ctx.owner);
    const ownerMember = members.find((m) => m.roleKey === "owner")!;
    const adminMember = members.find((m) => m.roleKey === "admin")!;
    await expect(changeMemberRole(ctx.admin, { memberId: adminMember.id, roleId: owner.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeMemberRole(ctx.admin, { memberId: ownerMember.id, roleId: editor.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeMemberRole(ctx.owner, { memberId: ownerMember.id, roleId: editor.id })).rejects.toMatchObject({ code: "conflict" });
    await expect(removeMember(ctx.owner, ownerMember.id)).rejects.toMatchObject({ code: "conflict" });
    await changeMemberRole(ctx.owner, { memberId: adminMember.id, roleId: owner.id });
    expect((await listMembers(ctx.owner)).filter((m) => m.roleKey === "owner")).toHaveLength(2);
    const log = await listAuditLog(ctx.owner);
    expect(log.some((e) => e.action === "member.role_changed")).toBe(true);
    expect(org.slug).toBe("north-post");
  });

  it("invitations: email must match, single use, role applied", async () => {
    const { ctx, org } = await studio();
    const reviewerRole = await getSystemRole(systemDb(), "organization", "reviewer");
    const { url } = await createInvitation(ctx.admin, { email: "Colorist@Example.com", roleId: reviewerRole.id });
    const token = url.split("/invite/")[1];
    expect(await previewInvitation(token)).toMatchObject({ status: "valid", email: "colorist@example.com", roleName: "Reviewer" });

    const stranger = await makeUser("Stranger");
    await expect(acceptInvitation(stranger, token, meta)).rejects.toMatchObject({ code: "forbidden" });

    const colorist = await makeUser("Colorist");
    const invited = { ...colorist, email: "colorist@example.com" };
    await systemDb().execute(sql`update users set email = 'colorist@example.com' where id = ${colorist.id}`);
    const res = await acceptInvitation(invited, token, meta);
    expect(res.orgSlug).toBe(org.slug);
    expect((await ctxFor(invited, org.slug)).role.key).toBe("reviewer");
    await expect(acceptInvitation(invited, token, meta)).rejects.toMatchObject({ code: "not_found" });
  });

  it("search only returns what the user may see", async () => {
    const { ctx, ws } = await studio();
    await createProject(ctx.owner, { name: "Confidential Launch", workspaceId: ws.id, metadata: [{ key: "PO", value: "PO-7731" }] });
    expect((await search(ctx.admin, { q: "confidential" })).projects).toHaveLength(1);
    expect((await search(ctx.admin, { q: "PO-7731" })).projects).toHaveLength(1);
    expect((await search(ctx.editor, { q: "confidential" })).projects).toHaveLength(0);
    expect((await search(ctx.client, { q: "owner" })).people).toHaveLength(0);
  });
});
