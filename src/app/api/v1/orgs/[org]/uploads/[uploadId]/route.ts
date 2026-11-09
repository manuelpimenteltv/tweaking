import type { NextRequest } from "next/server";
import { orgApi } from "@/server/next/api";
import { abortUpload } from "@/server/modules/uploads";

export const DELETE = (req: NextRequest, p: { params: Promise<{ org: string; uploadId: string }> }) =>
  orgApi(async (_req, ctx) => {
    await abortUpload(ctx, (await p.params).uploadId);
    return { ok: true };
  })(req, p);
