import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { previewRfo } from "@/server/incidents/actions";
export const POST = route({ perm: "incident.rfo", body: z.object({ rfoText: z.string().max(1500) }) }, async ({ params, body }) => previewRfo(getDb(), params.id, body.rfoText));
