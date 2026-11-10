import { eq, sql } from "drizzle-orm";
import { signInSchema, signUpSchema } from "@/lib/validation";
import type { RequestMeta } from "../authz/context";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../auth/password";
import { consumeRateLimit } from "../auth/rate-limit";
import { createSession } from "../auth/sessions";
import { systemDb } from "../db/client";
import { users } from "../db/schema";
import { AppError, conflict, isUniqueViolation } from "../errors";
import { parse } from "../lib/validate";
import { recordAudit } from "./audit";

export async function signUp(input: unknown, meta: RequestMeta) {
  const data = parse(signUpSchema, input);
  await consumeRateLimit(`signup:ip:${meta.ip ?? "unknown"}`, 20, 3600);
  const passwordHash = await hashPassword(data.password);
  const db = systemDb();
  try {
    const user = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: data.email, name: data.name, passwordHash })
        .returning({ id: users.id, email: users.email, name: users.name });
      await recordAudit(tx, { orgId: null, actorUserId: u.id, action: "auth.signup", targetType: "user", targetId: u.id, request: meta });
      return u;
    });
    const session = await createSession(user.id, meta);
    return { user, ...session };
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("An account with this email already exists.", { email: "An account with this email already exists." });
    throw err;
  }
}

export async function signIn(input: unknown, meta: RequestMeta) {
  const data = parse(signInSchema, input);
  await consumeRateLimit(`login:ip:${meta.ip ?? "unknown"}`, 50, 900);
  await consumeRateLimit(`login:email:${data.email}`, 10, 900);

  const db = systemDb();
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.email, data.email))
    .limit(1);

  const fail = () => new AppError("unauthenticated", "Email or password is incorrect.");
  if (!user || !user.passwordHash) {
    await burnPasswordCheck(data.password);
    throw fail();
  }
  const ok = await verifyPassword(user.passwordHash, data.password);
  if (!ok || user.disabledAt) {
    await recordAudit(db, { orgId: null, actorUserId: user.id, action: "auth.login_failed", targetType: "user", targetId: user.id, request: meta });
    throw fail();
  }
  await db.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, user.id));
  await recordAudit(db, { orgId: null, actorUserId: user.id, action: "auth.login", targetType: "user", targetId: user.id, request: meta });
  return { userId: user.id, ...(await createSession(user.id, meta)) };
}
