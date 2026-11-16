import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { previewCause } from "@/server/incidents/actions";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "incident.view" }, async ({ req, params }) => previewCause(getDb(), params.id, new URL(req.url).searchParams.get("causeKey") ?? ""));
