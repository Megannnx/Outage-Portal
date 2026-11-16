import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { submitTechnicalUpdate, FactsSchema } from "@/server/incidents/actions";
export const POST = route({
  perm: "incident.technical_update",
  body: z.object({ text: z.string().min(1).max(8000), facts: FactsSchema, expectedVersion: z.number().int(), acknowledgedConflicts: z.array(z.string()).max(20).optional(), internalOnly: z.boolean().optional(), applyToGroup: z.boolean().optional() }),
}, async ({ params, body, actor }) => submitTechnicalUpdate(getDb(), actor, { incidentId: params.id, ...body }));
