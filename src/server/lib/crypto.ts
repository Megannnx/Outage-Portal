import crypto from "node:crypto";

async function key(): Promise<Buffer> {
  const { getSecret } = await import("./secrets");
  const k = await getSecret("appEncryptionKey");
  const buf = Buffer.from(k, "base64");
  if (buf.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes");
  return buf;
}
/** AES-256-GCM for secrets at rest (MFA seeds). */
export async function encrypt(plain: string): Promise<string> {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", await key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
export async function decrypt(blob: string): Promise<string> {
  const [iv, tag, enc] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", await key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
export function hmacSha256(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/** Deterministic JSON (sorted keys) so hashes survive a round-trip through jsonb. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (x instanceof Date) return x.toISOString();
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as object).sort().filter((k) => (x as any)[k] !== undefined).map((k) => [k, norm((x as any)[k])]));
    return x;
  };
  return JSON.stringify(norm(v));
}
