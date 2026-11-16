import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { waiveRfo } from "@/server/incidents/actions";
export const POST = route({ perm: "incident.rfo_waive", body: z.object({ reason: z.string().max(1000), sendFinal: z.boolean(), expectedVersion: z.number().int() }) },
  async ({ params, body, actor }) => waiveRfo(getDb(), actor, { incidentId: params.id, ...body }));
