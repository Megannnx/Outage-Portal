import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { handover } from "@/server/queries";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "incident.view" }, async () => handover(getDb()));
