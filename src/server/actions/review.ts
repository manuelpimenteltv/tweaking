"use server";

import type { ThreadFilter } from "@/lib/review";
import * as review from "../modules/review";
import { attempt } from "../next/result";
import { requireOrg } from "../next/session";

/**
 * Review actions return data instead of refreshing the route: the review panel
 * keeps its own state (playhead, drafts, selection) and re-fetches threads.
 */
export const listThreadsAction = async (slug: string, versionId: string, filter: ThreadFilter) =>
  attempt(async () => review.listThreads(await requireOrg(slug), versionId, filter));

export const mentionableAction = async (slug: string, versionId: string) =>
  attempt(async () => review.listMentionable(await requireOrg(slug), versionId));

export const createThreadAction = async (slug: string, input: unknown) =>
  attempt(async () => review.createThread(await requireOrg(slug), input));

export const replyAction = async (slug: string, input: unknown) => attempt(async () => review.replyToThread(await requireOrg(slug), input));

export const setThreadStatusAction = async (slug: string, input: unknown) =>
  attempt(async () => review.setThreadStatus(await requireOrg(slug), input));

export const deleteCommentAction = async (slug: string, commentId: string) =>
  attempt(async () => review.deleteComment(await requireOrg(slug), commentId));
