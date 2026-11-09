import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { resolveOrgContext, type AuthContext } from "../authz/context";
import { revokeSessionToken, validateSessionToken, type SessionUser } from "../auth/sessions";
import { cookieSecure } from "../env";
import { getRequestMeta } from "./request";

export const SESSION_COOKIE = "loupe_session";

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await revokeSessionToken(token);
  jar.delete(SESSION_COOKIE);
}

/** Current user or null. Memoized per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await validateSessionToken(token);
  return session?.user ?? null;
});

export async function requireUser(next?: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  return user;
}

/**
 * Authorization context for an org route. Unknown org or no membership → 404,
 * so the existence of other studios is never revealed.
 */
export const requireOrg = cache(async (slug: string): Promise<AuthContext> => {
  const user = await requireUser(`/o/${slug}`);
  const ctx = await resolveOrgContext(user, slug, await getRequestMeta());
  if (!ctx) notFound();
  return ctx;
});
