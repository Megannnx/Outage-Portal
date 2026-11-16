/**
 * Template lifecycle: draft → pending approval → published → retired.
 * Published wording is immutable (DB trigger). A different administrator must
 * approve (four-eyes) unless TEMPLATE_SELF_APPROVAL=true for single-admin setups.
 */
import { and, desc, eq, max } from "drizzle-orm";
import type { DB } from "../db/client";
import { communicationTemplates, templateApprovals, templateVersions } from "../db/schema";
import { clock } from "../lib/clock";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { audit, type Actor } from "../audit/audit";
import { checkTemplate, render, type Vars } from "./render";
import { KIND_MAP } from "../domain/catalog";
import { assertNoPrivateTerms } from "./privacy";

export const SAMPLE_VARS: Vars = {
  site_name: "Dowerview", estate_name: "Dowerview Estate", incident_reference: "INC-2026-000123",
  outage_start_time: "16 Nov 2026 08:00", confirmed_cause: "an electricity outage affecting the area",
  fault_description: "a fibre break on their network", repair_status: "repairs are in progress", eta: "16:30 today",
  next_update_time: "10:03 today", rfo: "A contractor damaged the fibre route on Main Road. The cable was re-spliced and tested.",
  support_contact: "ATEC Support: support@atec.co.za", restored_time: "16 Nov 2026 13:35", downtime: "5h 35m", affected_sites: "Dowerview, Hazeldean",
};

async function loadVersion(db: DB, id: string) {
  const [row] = await db.select({ v: templateVersions, t: communicationTemplates }).from(templateVersions)
    .innerJoin(communicationTemplates, eq(communicationTemplates.id, templateVersions.templateId)).where(eq(templateVersions.id, id));
  if (!row) throw notFound("Template version not found");
  return row;
}

export async function createTemplate(db: DB, actor: Actor, input: { kind: string; audience: "all" | "resident" | "isp"; name: string; description?: string }) {
  if (!KIND_MAP.has(input.kind) && !/^custom_[a-z0-9_]{3,40}$/.test(input.kind)) throw badRequest("Kind must be a built-in kind or custom_<name>");
  const [t] = await db.insert(communicationTemplates).values({ kind: input.kind, audience: input.audience, name: input.name, description: input.description ?? "" })
    .onConflictDoNothing().returning();
  if (!t) throw conflict("A template for this kind and audience already exists");
  await audit(db, actor, "template.created", "communication_template", t.id, null, input);
  return t;
}

export async function createDraft(db: DB, actor: Actor, input: { templateId: string; subject: string; body: string; changeNote?: string }) {
  const [t] = await db.select().from(communicationTemplates).where(eq(communicationTemplates.id, input.templateId));
  if (!t) throw notFound("Template not found");
  const check = checkTemplate(t.kind, input.subject, input.body);
  if (!check.ok) throw badRequest(check.errors.join("; "), check);
  return db.transaction(async (tx) => {
    const [{ m }] = await tx.select({ m: max(templateVersions.version) }).from(templateVersions).where(eq(templateVersions.templateId, t.id));
    const [v] = await tx.insert(templateVersions).values({
      templateId: t.id, version: (m ?? 0) + 1, subject: input.subject, body: input.body, changeNote: input.changeNote ?? "", status: "draft", createdBy: actor.id,
    }).returning();
    await audit(tx, actor, "template.draft_created", "template_version", v.id, null, { subject: v.subject, body: v.body });
    return v;
  });
}

export async function updateDraft(db: DB, actor: Actor, input: { versionId: string; subject: string; body: string; changeNote?: string }) {
  const { v, t } = await loadVersion(db, input.versionId);
  if (v.status !== "draft") throw badRequest("Only drafts can be edited — create a new version instead");
  const check = checkTemplate(t.kind, input.subject, input.body);
  if (!check.ok) throw badRequest(check.errors.join("; "), check);
  await db.update(templateVersions).set({ subject: input.subject, body: input.body, changeNote: input.changeNote ?? v.changeNote }).where(eq(templateVersions.id, v.id));
  await audit(db, actor, "template.draft_updated", "template_version", v.id, { subject: v.subject, body: v.body }, { subject: input.subject, body: input.body });
}

export async function submitForApproval(db: DB, actor: Actor, versionId: string) {
  const { v, t } = await loadVersion(db, versionId);
  if (v.status !== "draft") throw badRequest("Only drafts can be submitted");
  const check = checkTemplate(t.kind, v.subject, v.body);
  if (!check.ok) throw badRequest(check.errors.join("; "), check);
  await assertNoPrivateTerms(db, `${v.subject}\n${v.body}`, "This wording");
  await db.update(templateVersions).set({ status: "pending_approval", submittedAt: clock.now() }).where(eq(templateVersions.id, v.id));
  await audit(db, actor, "template.submitted", "template_version", v.id);
}

export async function approveVersion(db: DB, actor: Actor, versionId: string, comment = "") {
  const { v, t } = await loadVersion(db, versionId);
  if (v.status !== "pending_approval") throw badRequest("This version is not awaiting approval");
  if (v.createdBy && v.createdBy === actor.id && process.env.TEMPLATE_SELF_APPROVAL !== "true")
    throw forbidden("You cannot approve your own wording — another administrator must approve it");
  const check = checkTemplate(t.kind, v.subject, v.body);
  if (!check.ok) throw badRequest(check.errors.join("; "), check);
  await assertNoPrivateTerms(db, `${v.subject}\n${v.body}`, "This wording");
  await db.transaction(async (tx) => {
    const now = clock.now();
    await tx.update(templateVersions).set({ status: "retired", retiredAt: now }).where(and(eq(templateVersions.templateId, t.id), eq(templateVersions.status, "published")));
    await tx.update(templateVersions).set({ status: "published", publishedAt: now }).where(eq(templateVersions.id, v.id));
    await tx.insert(templateApprovals).values({ templateVersionId: v.id, approverId: actor.id!, decision: "approved", comment, at: now });
    await audit(tx, actor, "template.approved_published", "template_version", v.id, null, { kind: t.kind, audience: t.audience, version: v.version });
  });
}

export async function rejectVersion(db: DB, actor: Actor, versionId: string, comment: string) {
  const { v } = await loadVersion(db, versionId);
  if (v.status !== "pending_approval") throw badRequest("This version is not awaiting approval");
  await db.update(templateVersions).set({ status: "rejected" }).where(eq(templateVersions.id, v.id));
  await db.insert(templateApprovals).values({ templateVersionId: v.id, approverId: actor.id!, decision: "rejected", comment, at: clock.now() });
  await audit(db, actor, "template.rejected", "template_version", v.id, null, { comment });
}

/** Roll back = re-submit an earlier version's exact wording as a new version (still needs approval). */
export async function rollbackTo(db: DB, actor: Actor, versionId: string) {
  const { v } = await loadVersion(db, versionId);
  const nv = await createDraft(db, actor, { templateId: v.templateId, subject: v.subject, body: v.body, changeNote: `Rollback to v${v.version}` });
  await submitForApproval(db, actor, nv.id);
  return nv;
}

/** Disable: the kind falls back down its chain (e.g. eta_changed → eta_available). */
export async function disableTemplate(db: DB, actor: Actor, templateId: string, reason: string) {
  await db.update(templateVersions).set({ status: "retired", retiredAt: clock.now() }).where(and(eq(templateVersions.templateId, templateId), eq(templateVersions.status, "published")));
  await audit(db, actor, "template.disabled", "communication_template", templateId, null, { reason });
}

export function previewWording(kind: string, subject: string, body: string, vars: Vars = SAMPLE_VARS) {
  const check = checkTemplate(kind, subject, body);
  if (!check.ok) return { ok: false as const, errors: check.errors };
  try {
    return { ok: true as const, subject: render(subject, vars), body: render(body, vars), withoutOptional: render(body, { ...vars, eta: undefined, fault_description: undefined, repair_status: undefined, ...(kind === "eta_available" || kind === "eta_changed" ? { eta: vars.eta } : {}) }) };
  } catch (e) { return { ok: false as const, errors: [(e as Error).message] }; }
}

export async function versionsFor(db: DB, templateId: string) {
  return db.select().from(templateVersions).where(eq(templateVersions.templateId, templateId)).orderBy(desc(templateVersions.version));
}
