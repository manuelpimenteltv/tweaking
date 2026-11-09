import { NextResponse, type NextRequest } from "next/server";
import { orgApi } from "@/server/next/api";
import { getDownloadUrl } from "@/server/modules/assets";

/** Authorizes, audits, then redirects to a 5-minute signed URL. */
export const GET = (req: NextRequest, p: { params: Promise<{ org: string; versionId: string }> }) =>
  orgApi(async (_r, ctx) => {
    const url = await getDownloadUrl(ctx, (await p.params).versionId);
    return NextResponse.redirect(url, { status: 303, headers: { "cache-control": "no-store" } });
  })(req, p);
