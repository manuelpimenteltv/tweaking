import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveOrgContext } from "@/server/authz/context";
import { validateSessionToken } from "@/server/auth/sessions";
import { appDb, systemDb } from "@/server/db/client";
import { projects, sessions } from "@/server/db/schema";
import { withTenant } from "@/server/db/tenant";
import { signIn } from "@/server/modules/auth";
import { listWorkspaces } from "@/server/modules/workspaces";
import { createProject, getProject, listProjects } from "@/server/modules/projects";
import { ctxFor, makeOrg, makeUser, meta, resetDb } from "../helpers";

/** Drizzle wraps driver errors; match the underlying PostgreSQL message. */
const pgError = (re: RegExp) => (err: unknown) => re.test(String((err as { cause?: Error }).cause?.message ?? err));

describe("authentication", () => {
  beforeEach(resetDb);

  it("signs in with the right password only, and stores only token hashes", async () => {
    const user = await makeUser("Ana");
    await expect(signIn({ email: user.email, password: "wrong password!" }, meta)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(signIn({ email: "nobody@example.com", password: "whatever123" }, meta)).rejects.toMatchObject({
      code: "unauthenticated",
      message: "Email or password is incorrect.",
    });
    const { token } = await signIn({ email: user.email.toUpperCase(), password: "correct horse battery" }, meta);
    const session = await validateSessionToken(token);
    expect(session?.user.id).toBe(user.id);
    const stored = await systemDb().select({ id: sessions.id }).from(sessions);
    expect(stored.map((s) => s.id)).not.toContain(token);
    expect(await validateSessionToken(token + "x")).toBeNull();
  });

  it("rate limits repeated failed logins per email", async () => {
    const user = await makeUser("Rate");
    for (let i = 0; i < 10; i++) {
      await signIn({ email: user.email, password: "nope-nope-nope" }, meta).catch(() => undefined);
    }
    await expect(signIn({ email: user.email, password: "correct horse battery" }, meta)).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("organization isolation", () => {
  beforeEach(resetDb);

  it("never resolves a context for an org the user doesn't belong to", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Bob");
    await makeOrg(a, "alpha-studio");
    await makeOrg(b, "bravo-studio");
    expect(await resolveOrgContext(a, "bravo-studio", meta)).toBeNull();
    expect(await resolveOrgContext(a, "alpha-studio", meta)).not.toBeNull();
  });

  it("hides other tenants' rows even from unfiltered queries (RLS)", async () => {
    const a = await makeUser("Alice");
    const b = await makeUser("Bob");
    const orgA = await makeOrg(a, "alpha-studio");
    await makeOrg(b, "bravo-studio");
    const ctxA = await ctxFor(a, "alpha-studio");
    const ctxB = await ctxFor(b, "bravo-studio");
    const [ws] = await listWorkspaces(ctxA);
    const project = await createProject(ctxA, { name: "Secret Campaign", workspaceId: ws.id });

    // Deliberately no WHERE clause: RLS must still scope the result.
    const seenByA = await withTenant(ctxA, (tx) => tx.select({ id: projects.id }).from(projects));
    const seenByB = await withTenant(ctxB, (tx) => tx.select({ id: projects.id }).from(projects));
    expect(seenByA.map((p) => p.id)).toEqual([project.id]);
    expect(seenByB).toEqual([]);

    // Outside any tenant context the app role sees nothing at all.
    const raw = await appDb().select({ id: projects.id }).from(projects);
    expect(raw).toEqual([]);

    // Services return 404, not 403, so existence isn't revealed.
    await expect(getProject(ctxB, project.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await listProjects(ctxB)).toEqual([]);

    // Writing into another tenant is rejected by the policy's WITH CHECK.
    const [wsB] = await listWorkspaces(ctxB);
    await expect(
      withTenant(ctxB, (tx) => tx.insert(projects).values({ organizationId: orgA.id, workspaceId: wsB.id, name: "Injected" })),
    ).rejects.toSatisfy(pgError(/row-level security/));
  });

  it("does not expose password hashes or sessions to the application role", async () => {
    const a = await makeUser("Alice");
    await makeOrg(a, "alpha-studio");
    const ctx = await ctxFor(a, "alpha-studio");
    await expect(withTenant(ctx, (tx) => tx.execute(sql`select password_hash from users`))).rejects.toSatisfy(pgError(/permission denied/));
    await expect(withTenant(ctx, (tx) => tx.execute(sql`select id from sessions`))).rejects.toSatisfy(pgError(/permission denied/));
  });
});
