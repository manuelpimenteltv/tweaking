import type { NextRequest } from "next/server";
import { orgApi, readJson } from "@/server/next/api";
import { listUploadedParts, signUploadParts } from "@/server/modules/uploads";

type P = { params: Promise<{ org: string; uploadId: string }> };

/** Presigned PUT URLs for a batch of parts (each bound to its SHA-256). */
export const POST = (req: NextRequest, p: P) =>
  orgApi(async (r, ctx) => ({ parts: await signUploadParts(ctx, (await p.params).uploadId, await readJson(r)) }))(req, p);

/** Parts already stored — used to resume. */
export const GET = (req: NextRequest, p: P) => orgApi(async (_r, ctx) => listUploadedParts(ctx, (await p.params).uploadId))(req, p);
