import { NextResponse, type NextRequest } from "next/server";
import { validateSessionToken } from "@/server/auth/sessions";
import { listMyOrganizations } from "@/server/modules/organizations";
import { SESSION_COOKIE } from "@/server/next/session";

/** Entry point: signed out → /login, no studio yet → /onboarding, else the first studio. */
export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await validateSessionToken(token) : null;
  if (!session) return NextResponse.redirect(new URL("/login", req.url));
  const orgs = await listMyOrganizations(session.user.id);
  const last = req.cookies.get("loupe_last_org")?.value;
  const target = orgs.find((o) => o.slug === last) ?? orgs[0];
  return NextResponse.redirect(new URL(target ? `/o/${target.slug}` : "/onboarding", req.url));
}
