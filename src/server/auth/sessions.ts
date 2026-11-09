import { and, eq, gt, sql } from "drizzle-orm";
import { systemDb } from "../db/client";
import { sessions, users } from "../db/schema";
import { env } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";

const DAY = 86_400_000;

export type SessionUser = { id: string; email: string; name: string; avatarUrl: string | null };
export type ValidatedSession = { sessionId: string; expiresAt: Date; user: SessionUser };

/** Creates a session and returns the raw token (only ever stored in the cookie). */
export async function createSession(userId: string, meta: { ip: string | null; userAgent: string | null }) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_DAYS * DAY);
  await systemDb()
    .insert(sessions)
    .values({ id: sha256Hex(token), userId, expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 512) ?? null });
  return { token, expiresAt };
}

/** Validates a token; slides the expiry forward at most once per day. */
export async function validateSessionToken(token: string): Promise<ValidatedSession | null> {
  if (!token || token.length > 128) return null;
  const id = sha256Hex(token);
  const db = systemDb();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
      user: { id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl },
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, sql`now()`)))
    .limit(1);
  if (!row) return null;
  if (row.disabledAt) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  let expiresAt = row.expiresAt;
  if (Date.now() - row.lastUsedAt.getTime() > DAY) {
    expiresAt = new Date(Date.now() + env().SESSION_TTL_DAYS * DAY);
    await db.update(sessions).set({ lastUsedAt: new Date(), expiresAt }).where(eq(sessions.id, id));
  }
  return { sessionId: row.sessionId, expiresAt, user: row.user };
}

export async function revokeSessionToken(token: string) {
  await systemDb().delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}

export async function revokeAllSessions(userId: string) {
  await systemDb().delete(sessions).where(eq(sessions.userId, userId));
}
