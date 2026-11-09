import type { NextRequest } from "next/server";
import { orgApi, readJson } from "@/server/next/api";
import { completeUpload } from "@/server/modules/uploads";

export const POST = (req: NextRequest, p: { params: Promise<{ org: string; uploadId: string }> }) =>
  orgApi(async (r, ctx) => completeUpload(ctx, (await p.params).uploadId, await readJson(r)))(req, p);
