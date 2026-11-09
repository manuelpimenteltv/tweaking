import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { resolveOrgContext, type AuthContext } from "../authz/context";
import { validateSessionToken } from "../auth/sessions";
import { env } from "../env";
import { AppError, unauthenticated } from "../errors";
import { SESSION_COOKIE } from "./session";
import { toActionError } from "./result";

type Handler = (req: NextRequest, ctx: AuthContext) => Promise<Response | unknown>;

/**
 * JSON API wrapper for org-scoped route handlers: session auth, same-origin
 * check for state-changing methods (CSRF), org context, uniform errors.
 */
export function orgApi(handler: Handler) {
  return async (req: NextRequest, { params }: { params: Promise<{ org: string }> }) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      const token = req.cookies.get(SESSION_COOKIE)?.value;
      const session = token ? await validateSessionToken(token) : null;
      if (!session) throw unauthenticated();
      const { org } = await params;
      const meta = {
        ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
        userAgent: req.headers.get("user-agent"),
      };
      const ctx = await resolveOrgContext(session.user, org, meta);
      if (!ctx) throw new AppError("not_found", "Organization not found.");
      const result = await handler(req, ctx);
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      const e = toActionError(err);
      const status = err instanceof AppError ? err.status : 500;
      return NextResponse.json({ error: e }, { status, headers: { "cache-control": "no-store" } });
    }
  };
}

export function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  const allowed = new URL(env().APP_URL).origin;
  if (!origin || (origin !== allowed && origin !== req.nextUrl.origin)) {
    throw new AppError("forbidden", "Cross-origin request rejected.");
  }
}

export async function readJson(req: NextRequest): Promise<unknown> {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new AppError("validation", "Expected JSON.");
  try {
    return await req.json();
  } catch {
    throw new AppError("validation", "Malformed JSON.");
  }
}
