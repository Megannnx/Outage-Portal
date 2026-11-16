import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { setDispatchStatus } from "@/server/incidents/actions";
export const POST = route({ perm: "dispatch.update", body: z.object({ status: z.enum(["acknowledged", "on_site", "completed", "cancelled"]), note: z.string().max(1000).optional(), externalRef: z.string().max(100).optional() }) },
  async ({ params, body, actor }) => setDispatchStatus(getDb(), actor, { dispatchId: params.id, ...body }));
