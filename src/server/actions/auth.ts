"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signIn, signUp } from "../modules/auth";
import { createOrganization, listMyOrganizations } from "../modules/organizations";
import { acceptInvitation } from "../modules/members";
import { getRequestMeta } from "../next/request";
import { attempt, type ActionResult } from "../next/result";
import { clearSession, requireUser, setSessionCookie } from "../next/session";

/** Only same-site relative paths are allowed as post-login destinations (no open redirects). */
function safeNext(value: FormDataEntryValue | null): string | null {
  const v = typeof value === "string" ? value : "";
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : null;
}

export async function signInAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const res = await attempt(async () => {
    const { token, expiresAt, userId } = await signIn({ email: form.get("email"), password: form.get("password") }, await getRequestMeta());
    await setSessionCookie(token, expiresAt);
    return userId;
  });
  if (!res.ok) return res;
  // Resolve the landing page here: chaining through "/" leaves the client router showing the wrong URL.
  redirect(safeNext(form.get("next")) ?? (await homeFor(res.data)));
}

async function homeFor(userId: string) {
  const orgs = await listMyOrganizations(userId);
  const last = (await cookies()).get("loupe_last_org")?.value;
  const target = orgs.find((o) => o.slug === last) ?? orgs[0];
  return target ? `/o/${target.slug}` : "/onboarding";
}

export async function signUpAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const res = await attempt(async () => {
    const { token, expiresAt } = await signUp(
      { name: form.get("name"), email: form.get("email"), password: form.get("password") },
      await getRequestMeta(),
    );
    await setSessionCookie(token, expiresAt);
  });
  if (!res.ok) return res;
  redirect(safeNext(form.get("next")) ?? "/onboarding");
}

export async function signOutAction() {
  await clearSession();
  redirect("/login");
}

export async function createOrgAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const meta = await getRequestMeta();
  const res = await attempt(() => createOrganization(user, { name: form.get("name"), slug: form.get("slug") }, meta));
  if (!res.ok) return res;
  redirect(`/o/${res.data.slug}`);
}


export async function acceptInviteAction(token: string): Promise<ActionResult> {
  const user = await requireUser(`/invite/${token}`);
  const meta = await getRequestMeta();
  const res = await attempt(() => acceptInvitation(user, token, meta));
  if (!res.ok) return res;
  redirect(res.data.projectId ? `/o/${res.data.orgSlug}/projects/${res.data.projectId}` : `/o/${res.data.orgSlug}`);
}

export async function myOrganizations() {
  const user = await requireUser();
  return listMyOrganizations(user.id);
}
