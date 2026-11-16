import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { getSettings, updateSettings, SettingsSchema } from "@/server/domain/settings";
import { audit } from "@/server/audit/audit";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "admin.config" }, async () => ({ settings: await getSettings(getDb()) }));
export const PATCH = route({ perm: "admin.config" }, async ({ req, actor }) => {
  const db = getDb();
  const before = await getSettings(db);
  const patch = SettingsSchema.partial().parse(await req.json());
  for (const k of Object.keys(patch)) if ((patch as any)[k] === undefined) delete (patch as any)[k];
  for (const p of patch.telegramPatterns ?? []) new RegExp(p); // reject invalid regex early
  const after = await updateSettings(db, patch, actor.id);
  await audit(db, actor, "settings.updated", "settings", "global", Object.fromEntries(Object.keys(patch).map((k) => [k, (before as any)[k]])), patch);
  return { settings: after };
});
