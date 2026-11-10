import { NextResponse, type NextRequest } from "next/server";
import { orgApi } from "@/server/next/api";
import { getSheetChunkUrl } from "@/server/modules/assets";

type P = { params: Promise<{ org: string; versionId: string; sheet: string; chunk: string }> };

/** One block of spreadsheet rows: authorizes, then redirects to a short-lived signed URL. */
export const GET = (req: NextRequest, p: P) =>
  orgApi(async (_r, ctx) => {
    const { versionId, sheet, chunk } = await p.params;
    const url = await getSheetChunkUrl(ctx, versionId, Number(sheet), Number(chunk));
    return NextResponse.redirect(url, { status: 302, headers: { "cache-control": "private, max-age=300" } });
  })(req, p);
