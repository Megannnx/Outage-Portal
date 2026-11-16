import { safeEqual, hmacSha256 } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { getSecret, type SecretName } from "../lib/secrets";

/** Bearer-token auth for machine-to-machine endpoints, with optional source IP allow-list. */
export async function requireBearer(req: Request, name: SecretName) {
  const expected = await getSecret(name);
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!got || !safeEqual(got, expected)) throw new AppError("unauthorized", "Invalid token", 401);
  const allow = (process.env.INGEST_ALLOWED_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? req.headers.get("x-real-ip") ?? "";
    if (!allow.includes(ip)) throw new AppError("forbidden_ip", "Source address not allowed", 403);
  }
}

export function requireHmac(req: Request, raw: string, envVar: string, header = "x-signature") {
  const secret = process.env[envVar];
  if (!secret) throw new AppError("not_configured", `${envVar} is not configured on the server`, 503);
  const sig = (req.headers.get(header) ?? "").replace(/^sha256=/, "");
  if (!sig || !safeEqual(sig, hmacSha256(secret, raw))) throw new AppError("unauthorized", "Bad signature", 401);
}
