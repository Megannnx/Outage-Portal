import { z } from "zod";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { approveVersion, rejectVersion, rollbackTo, submitForApproval, updateDraft } from "@/server/comms/templates";
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), subject: z.string().max(300), body: z.string().max(5000), changeNote: z.string().max(300).optional() }),
  z.object({ action: z.literal("submit") }),
  z.object({ action: z.literal("approve"), comment: z.string().max(500).optional() }),
  z.object({ action: z.literal("reject"), comment: z.string().min(3).max(500) }),
  z.object({ action: z.literal("rollback") }),
]);
export const POST = route({ perm: "admin.templates", body: Body }, async ({ params, body, actor }) => {
  const db = getDb();
  switch (body.action) {
    case "update": return updateDraft(db, actor, { versionId: params.id, subject: body.subject, body: body.body, changeNote: body.changeNote });
    case "submit": return submitForApproval(db, actor, params.id);
    case "approve": return approveVersion(db, actor, params.id, body.comment);
    case "reject": return rejectVersion(db, actor, params.id, body.comment);
    case "rollback": return rollbackTo(db, actor, params.id);
  }
});
