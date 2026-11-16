import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { createDraft, disableTemplate } from "@/server/comms/templates";
/** POST = new draft version for this template; DELETE = disable (retire published version). */
export const POST = route({ perm: "admin.templates", body: z.object({ subject: z.string().max(300), body: z.string().max(5000), changeNote: z.string().max(300).optional() }) },
  async ({ params, body, actor }) => createDraft(getDb(), actor, { templateId: params.id, ...body }));
export const DELETE = route({ perm: "admin.templates" }, async ({ params, req, actor }) => disableTemplate(getDb(), actor, params.id, new URL(req.url).searchParams.get("reason") ?? ""));
