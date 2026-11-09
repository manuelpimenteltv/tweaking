import { orgApi, readJson } from "@/server/next/api";
import { initiateUpload, listMyActiveUploads } from "@/server/modules/uploads";

/** Start a direct-to-storage multipart upload (new asset or new version). */
export const POST = orgApi(async (req, ctx) => initiateUpload(ctx, await readJson(req)));

/** The caller's unfinished uploads (resume tray). */
export const GET = orgApi(async (_req, ctx) => ({ uploads: await listMyActiveUploads(ctx) }));
