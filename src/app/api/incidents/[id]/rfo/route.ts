import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { submitRfo } from "@/server/incidents/actions";
export const POST = route({ perm: "incident.rfo", body: z.object({ rfoText: z.string(), providerRef: z.string().max(64).optional(), receivedAt: z.string().optional(), internalNotes: z.string().max(4000).optional(), expectedVersion: z.number().int() }) },
  async ({ params, body, actor }) => submitRfo(getDb(), actor, { incidentId: params.id, ...body }));
