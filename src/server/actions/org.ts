"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import * as assets from "../modules/assets";
import * as members from "../modules/members";
import * as orgs from "../modules/organizations";
import * as processing from "../modules/processing";
import * as projects from "../modules/projects";
import * as workspaces from "../modules/workspaces";
import { attempt, type ActionResult } from "../next/result";
import { requireOrg } from "../next/session";

/**
 * Every action re-resolves the org context from the session and delegates to a
 * service that performs authorization and validation. Nothing here trusts the client.
 */
async function run<T>(slug: string, fn: (ctx: Awaited<ReturnType<typeof requireOrg>>) => Promise<T>): Promise<ActionResult<T>> {
  const res = await attempt(async () => fn(await requireOrg(slug)));
  if (res.ok) refresh();
  return res;
}

// Projects
export async function createProjectAction(slug: string, input: unknown) {
  const res = await attempt(async () => projects.createProject(await requireOrg(slug), input));
  if (!res.ok) return res;
  redirect(`/o/${slug}/projects/${res.data.id}`);
}
export const updateProjectAction = async (slug: string, projectId: string, input: unknown) =>
  run(slug, async (ctx) => {
    await projects.updateProject(ctx, projectId, input);
  });
export async function deleteProjectAction(slug: string, projectId: string) {
  const res = await attempt(async () => projects.deleteProject(await requireOrg(slug), projectId));
  if (!res.ok) return res;
  redirect(`/o/${slug}/projects`);
}
export const setFavoriteAction = async (slug: string, projectId: string, favorite: boolean) =>
  run(slug, (ctx) => projects.setFavorite(ctx, projectId, favorite));
export const setCoverAction = async (slug: string, projectId: string, assetId: string) =>
  run(slug, (ctx) => projects.setProjectCover(ctx, projectId, assetId));
export const upsertProjectMemberAction = async (slug: string, input: unknown) => run(slug, (ctx) => projects.upsertProjectMember(ctx, input));
export const removeProjectMemberAction = async (slug: string, input: unknown) => run(slug, (ctx) => projects.removeProjectMember(ctx, input));
export const inviteToProjectAction = async (slug: string, input: unknown) =>
  run(slug, async (ctx) => {
    const r = await members.inviteToProject(ctx, input);
    return { url: r.url, emailSent: r.emailSent };
  });
export const listAssignableMembersAction = async (slug: string, projectId: string) =>
  attempt(async () => members.listAssignableMembers(await requireOrg(slug), projectId));

// Workspaces
export const createWorkspaceAction = async (slug: string, input: unknown) =>
  run(slug, async (ctx) => {
    await workspaces.createWorkspace(ctx, input);
  });
export const updateWorkspaceAction = async (slug: string, id: string, input: unknown) =>
  run(slug, async (ctx) => {
    await workspaces.updateWorkspace(ctx, id, input);
  });
export const deleteWorkspaceAction = async (slug: string, id: string) => run(slug, (ctx) => workspaces.deleteWorkspace(ctx, id));

// Folders & assets
export const createFolderAction = async (slug: string, input: unknown) =>
  run(slug, async (ctx) => {
    const f = await assets.createFolder(ctx, input);
    return { id: f.id };
  });
export const renameFolderAction = async (slug: string, input: unknown) => run(slug, (ctx) => assets.renameFolder(ctx, input));
export const renameAssetAction = async (slug: string, input: unknown) => run(slug, (ctx) => assets.renameAsset(ctx, input));
export const moveItemsAction = async (slug: string, input: unknown) => run(slug, (ctx) => assets.moveItems(ctx, input));
export const deleteItemsAction = async (slug: string, input: unknown) => run(slug, (ctx) => assets.deleteItems(ctx, input));
export const folderTreeAction = async (slug: string, projectId: string) =>
  attempt(async () => assets.listFolderTree(await requireOrg(slug), projectId));
export const retryProcessingAction = async (slug: string, versionId: string) =>
  run(slug, async (ctx) => {
    await processing.retryProcessing(ctx, versionId);
  });
export async function deleteAssetAction(slug: string, projectId: string, assetId: string) {
  const res = await attempt(async () => assets.deleteItems(await requireOrg(slug), { projectId, assetIds: [assetId] }));
  if (!res.ok) return res;
  redirect(`/o/${slug}/projects/${projectId}`);
}

// Organization & members
export const updateOrgAction = async (slug: string, input: unknown) =>
  run(slug, async (ctx) => {
    await orgs.updateOrganization(ctx, input);
  });
export const inviteMemberAction = async (slug: string, input: unknown) =>
  run(slug, async (ctx) => {
    const r = await members.createInvitation(ctx, input);
    return { url: r.url, emailSent: r.emailSent };
  });
export const revokeInvitationAction = async (slug: string, id: string) => run(slug, (ctx) => members.revokeInvitation(ctx, id));
export const changeMemberRoleAction = async (slug: string, input: { memberId: string; roleId: string }) =>
  run(slug, (ctx) => members.changeMemberRole(ctx, input));
export const removeMemberAction = async (slug: string, memberId: string) => run(slug, (ctx) => members.removeMember(ctx, memberId));
