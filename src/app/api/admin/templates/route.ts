import { z } from "zod";
import { asc, desc } from "drizzle-orm";
import { route } from "@/server/api";
import { getDb } from "@/server/db/client";
import { communicationTemplates, templateApprovals, templateVersions, users } from "@/server/db/schema";
import { createTemplate } from "@/server/comms/templates";
import { KINDS, PLACEHOLDERS } from "@/server/domain/catalog";
import { eq } from "drizzle-orm";
export const dynamic = "force-dynamic";
export const GET = route({ perm: "admin.templates" }, async () => {
  const db = getDb();
  const [templates, versions, approvals, us] = await Promise.all([
    db.select().from(communicationTemplates).orderBy(asc(communicationTemplates.kind)),
    db.select().from(templateVersions).orderBy(desc(templateVersions.version)),
    db.select().from(templateApprovals).orderBy(desc(templateApprovals.at)),
    db.select({ id: users.id, name: users.name }).from(users),
  ]);
  const name = (id: string | null) => us.find((u) => u.id === id)?.name ?? "System";
  return {
    kinds: KINDS, placeholders: PLACEHOLDERS,
    templates: templates.map((t) => ({
      ...t,
      versions: versions.filter((v) => v.templateId === t.id).map((v) => ({ ...v, createdByName: name(v.createdBy), approvals: approvals.filter((a) => a.templateVersionId === v.id).map((a) => ({ ...a, approverName: name(a.approverId) })) })),
    })),
  };
  void eq;
});
export const POST = route({ perm: "admin.templates", body: z.object({ kind: z.string(), audience: z.enum(["all", "resident", "isp"]), name: z.string().min(2).max(100), description: z.string().max(300).optional() }) },
  async ({ body, actor }) => createTemplate(getDb(), actor, body));
