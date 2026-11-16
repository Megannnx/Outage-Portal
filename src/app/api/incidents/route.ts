import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { listIncidents } from "@/server/queries";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "incident.view" }, async ({ req, user }) => {
  const u = new URL(req.url);
  const scope = (u.searchParams.get("scope") ?? undefined) as "open" | "mine" | "rfo" | "recent" | undefined;
  return { incidents: await listIncidents(getDb(), user.role, { scope, q: u.searchParams.get("q") ?? undefined }) };
});
