import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { createDispatch } from "@/server/incidents/actions";
export const POST = route({ perm: "dispatch.create", body: z.object({ notes: z.string().max(2000).optional(), externalRef: z.string().max(100).optional(), expectedVersion: z.number().int().optional() }) },
  async ({ params, body, actor }) => {
    const r = await createDispatch(getDb(), actor, { incidentId: params.id, ...body });
    return { dispatch: r.dispatch, ackUrl: r.ackUrl };
  });
