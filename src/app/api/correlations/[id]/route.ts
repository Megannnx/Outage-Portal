import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { decideCorrelation } from "@/server/incidents/actions";
export const POST = route({ perm: "correlation.decide", body: z.object({ accept: z.boolean() }) }, async ({ params, body, actor }) => decideCorrelation(getDb(), actor, { suggestionId: params.id, accept: body.accept }));
