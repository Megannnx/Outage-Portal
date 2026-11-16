import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { previewTechnicalUpdate, FactsSchema } from "@/server/incidents/actions";
export const POST = route({ perm: "incident.technical_update", body: z.object({ text: z.string().max(8000).optional(), facts: FactsSchema.optional() }) },
  async ({ params, body }) => previewTechnicalUpdate(getDb(), { incidentId: params.id, ...body }));
