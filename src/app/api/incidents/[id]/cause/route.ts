import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { confirmCause } from "@/server/incidents/actions";
export const POST = route({ perm: "incident.confirm_cause", body: z.object({ causeKey: z.string().max(64), expectedVersion: z.number().int(), note: z.string().max(500).optional() }) },
  async ({ params, body, actor }) => confirmCause(getDb(), actor, { incidentId: params.id, ...body }));
