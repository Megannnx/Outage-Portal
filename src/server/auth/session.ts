/**
 * Session authentication. Opaque random tokens in an httpOnly cookie; only a
 * SHA-256 of the token is stored. Sessions expire after inactivity and absolutely.
 */
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { getDb } from "../db/client";
import { roles, sessions, users } from "../db/schema";
import { randomToken, sha256, encrypt, decrypt } from "../lib/crypto";
import { AppError, forbidden } from "../lib/errors";
import { audit } from "../audit/audit";
import { can, type Permission, type Role } from "./permissions";

export const COOKIE = "atec_op_session";
const IDLE_MIN = Number(process.env.SESSION_IDLE_MINUTES ?? 720);
const ABSOLUTE_H = Number(process.env.SESSION_ABSOLUTE_HOURS ?? 24);
const MAX_FAILS = 5;
const LOCK_MIN = 15;
authenticator.options = { window: 1 };
let _dummy: string | null = null;
const dummyHash = () => (_dummy ??= bcrypt.hashSync("timing-equaliser-not-a-password", 12));

export interface SessionUser {
  id: string; email: string; name: string; role: Role; sessionId: string;
  mfaVerified: boolean; mfaEnabled: boolean; mfaRequired: boolean;
}

export async function hashPassword(pw: string) {
  if (pw.length < 12) throw new AppError("weak_password", "Passwords must be at least 12 characters", 400);
  return bcrypt.hash(pw, 12);
}

function clientIp(): string | null {
  const h = headers();
  return h.get("x-forwarded-for")?.split(",")[0].trim() ?? h.get("x-real-ip") ?? null;
}

export async function login(email: string, password: string) {
  const db = getDb();
  const [u] = await db.select().from(users).where(sql`lower(${users.email}) = lower(${email})`);
  const generic = new AppError("invalid_login", "Incorrect email or password", 401);
  if (!u || !u.active) { await bcrypt.compare(password, dummyHash()); throw generic; } // equal timing for unknown users
  if (u.lockedUntil && u.lockedUntil > new Date()) throw new AppError("locked", "Too many failed attempts. Try again in a few minutes.", 429);
  if (!(await bcrypt.compare(password, u.passwordHash))) {
    const fails = u.failedLogins + 1;
    await db.update(users).set({ failedLogins: fails, lockedUntil: fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60_000) : null }).where(eq(users.id, u.id));
    await audit(db, { id: u.id, label: u.email, ip: clientIp() }, "auth.login_failed", "user", u.id);
    throw generic;
  }
  await db.update(users).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, u.id));
  const token = randomToken();
  await db.insert(sessions).values({
    userId: u.id, tokenHash: sha256(token), mfaVerified: !u.mfaEnabled,
    expiresAt: new Date(Date.now() + ABSOLUTE_H * 3600_000), ip: clientIp(), userAgent: headers().get("user-agent")?.slice(0, 300) ?? null,
  });
  cookies().set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production", path: "/", maxAge: ABSOLUTE_H * 3600 });
  await audit(db, { id: u.id, label: u.email, ip: clientIp() }, "auth.login", "user", u.id);
  return { mfaPending: u.mfaEnabled };
}

export async function logout() {
  const t = cookies().get(COOKIE)?.value;
  if (t) await getDb().update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha256(t)));
  cookies().delete(COOKIE);
}

export async function currentUser(): Promise<SessionUser | null> {
  const t = cookies().get(COOKIE)?.value;
  if (!t) return null;
  const db = getDb();
  const now = new Date();
  const [row] = await db.select({ s: sessions, u: users, r: roles }).from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId)).innerJoin(roles, eq(roles.key, users.role))
    .where(and(eq(sessions.tokenHash, sha256(t)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)));
  if (!row || !row.u.active) return null;
  if (now.getTime() - row.s.lastSeenAt.getTime() > IDLE_MIN * 60_000) return null;
  if (now.getTime() - row.s.lastSeenAt.getTime() > 60_000) await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.s.id));
  return {
    id: row.u.id, email: row.u.email, name: row.u.name, role: row.u.role, sessionId: row.s.id,
    mfaVerified: row.s.mfaVerified, mfaEnabled: row.u.mfaEnabled, mfaRequired: row.r.requiresMfa || process.env.MFA_REQUIRED_ALL === "true",
  };
}

/** Fully authenticated: password + (MFA when enrolled) + enrolment done when required. */
export async function requireUser(p?: Permission): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) throw new AppError("unauthenticated", "Please sign in", 401);
  if (u.mfaEnabled && !u.mfaVerified) throw new AppError("mfa_required", "Enter your authenticator code", 401);
  if (u.mfaRequired && !u.mfaEnabled) throw new AppError("mfa_setup_required", "Set up two-factor authentication first", 403);
  if (p && !can(u.role, p)) throw forbidden();
  return u;
}

export async function verifyMfa(code: string) {
  const u = await currentUser();
  if (!u) throw new AppError("unauthenticated", "Please sign in", 401);
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, u.id));
  if (!row.mfaSecretEnc || !authenticator.check(code.replace(/\s/g, ""), await decrypt(row.mfaSecretEnc))) {
    await audit(db, { id: u.id, label: u.email, ip: clientIp() }, "auth.mfa_failed", "user", u.id);
    throw new AppError("bad_code", "That code is not valid", 400);
  }
  await db.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, u.sessionId));
}

export async function beginMfaSetup() {
  const u = await currentUser();
  if (!u) throw new AppError("unauthenticated", "Please sign in", 401);
  if (u.mfaEnabled) throw new AppError("already", "Two-factor is already enabled", 400);
  const secret = authenticator.generateSecret();
  await getDb().update(users).set({ mfaSecretEnc: await encrypt(secret) }).where(eq(users.id, u.id));
  return { secret, otpauth: authenticator.keyuri(u.email, "ATEC Outage Portal", secret) };
}

export async function confirmMfaSetup(code: string) {
  const u = await currentUser();
  if (!u) throw new AppError("unauthenticated", "Please sign in", 401);
  const db = getDb();
  const [row] = await db.select().from(users).where(eq(users.id, u.id));
  if (!row.mfaSecretEnc || !authenticator.check(code.replace(/\s/g, ""), await decrypt(row.mfaSecretEnc))) throw new AppError("bad_code", "That code is not valid", 400);
  await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, u.id));
  await db.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, u.sessionId));
  await audit(db, { id: u.id, label: u.email }, "auth.mfa_enabled", "user", u.id);
}
