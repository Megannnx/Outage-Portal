import { z } from "zod";
import { route } from "@/server/api";
import { previewWording } from "@/server/comms/templates";
export const POST = route({ perm: "admin.templates", body: z.object({ kind: z.string(), subject: z.string().max(300), body: z.string().max(5000) }) },
  async ({ body }) => previewWording(body.kind, body.subject, body.body));
