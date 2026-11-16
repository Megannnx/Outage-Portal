/**
 * Runtime secrets. Each one comes from the environment when set; otherwise the
 * portal generates a strong random value once and keeps it in the database
 * (settings key "secret.*", never returned by the settings API).
 *
 * This lets a hosted deployment start without anyone copying keys around.
 * Production hardening: set APP_ENCRYPTION_KEY in the environment so the MFA
 * encryption key is not stored next to the data it protects.
 */
import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { settings } from "../db/schema";

export const SECRETS = {
  appEncryptionKey: { env: "APP_ENCRYPTION_KEY", gen: () => crypto.randomBytes(32).toString("base64") },
  tickToken: { env: "CRON_SECRET", gen: () => crypto.randomBytes(32).toString("hex") },
  ingestNetxms: { env: "INGEST_TOKEN_NETXMS", gen: () => crypto.randomBytes(32).toString("hex") },
  ingestGeneric: { env: "INGEST_TOKEN_GENERIC", gen: () => crypto.randomBytes(32).toString("hex") },
  bounceWebhook: { env: "BOUNCE_WEBHOOK_TOKEN", gen: () => crypto.randomBytes(32).toString("hex") },
} as const;
export type SecretName = keyof typeof SECRETS;

const cache = new Map<SecretName, { v: string; at: number }>();

export function secretSource(name: SecretName): "environment" | "database" {
  return process.env[SECRETS[name].env] ? "environment" : "database";
}

export async function getSecret(name: SecretName): Promise<string> {
  const env = process.env[SECRETS[name].env];
  if (env) return env;
  const c = cache.get(name);
  if (c && Date.now() - c.at < 60_000) return c.v;
  const db = getDb();
  const key = `secret.${name}`;
  await db.insert(settings).values({ key, value: SECRETS[name].gen() }).onConflictDoNothing();
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  const v = String(row.value);
  cache.set(name, { v, at: Date.now() });
  return v;
}

export async function rotateSecret(name: SecretName): Promise<void> {
  if (process.env[SECRETS[name].env]) throw new Error(`${SECRETS[name].env} is set in the environment — rotate it there`);
  await getDb().update(settings).set({ value: SECRETS[name].gen(), updatedAt: new Date() }).where(eq(settings.key, `secret.${name}`));
  cache.delete(name);
}
void sql;
