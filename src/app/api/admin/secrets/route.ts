import { z } from "zod";
import { route } from "@/server/api";
import { getSecret, rotateSecret, secretSource } from "@/server/lib/secrets";
import { getDb } from "@/server/db/client";
import { audit } from "@/server/audit/audit";
export const dynamic = "force-dynamic";
/** Integration tokens administrators need to configure NetXMS etc. Values are only returned to administrators. */
const NAMES = ["ingestNetxms", "ingestGeneric", "bounceWebhook", "waveApi"] as const;
export const GET = route({ perm: "admin.config" }, async ({ actor }) => {
  await audit(getDb(), actor, "secrets.viewed", "settings", "integration_tokens");
  return { tokens: await Promise.all(NAMES.map(async (n) => ({ name: n, source: secretSource(n), value: await getSecret(n) }))), encryptionKeySource: secretSource("appEncryptionKey") };
});
export const POST = route({ perm: "admin.config", body: z.object({ name: z.enum(NAMES) }) }, async ({ body, actor }) => {
  await rotateSecret(body.name);
  await audit(getDb(), actor, "secrets.rotated", "settings", body.name);
});
