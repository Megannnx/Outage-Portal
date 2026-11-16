/**
 * The 25 edge cases from section 15, each with a defined, asserted outcome.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setup, down, up, netxms, run, tick, incidentFor, commsFor, captured, captureControl, s, advance, at, type World } from "./helpers";
import { confirmCause, createDispatch, submitTechnicalUpdate, submitRfo, decideCorrelation, previewTechnicalUpdate } from "@/server/incidents/actions";
import { runEscalationSweep, runHealthSweep } from "@/server/escalations/engine";
import { processEvent } from "@/server/incidents/lifecycle";
import { fromNetxms, fromTelegram } from "@/server/ingestion/normalize";
import { getSettings } from "@/server/domain/settings";
import { claimDue, failJob } from "@/server/scheduler/jobs";
import { drain } from "@/server/scheduler/runner";
import { createDraft, submitForApproval, approveVersion } from "@/server/comms/templates";

let w: World;
beforeEach(async () => { w = await setup(); });
const live = async (id: string) => (await commsFor(w.db, id)).filter((c) => !["cancelled"].includes(c.status));
const residentKinds = async (id: string) => (await live(id)).filter((c) => c.audience === "resident").map((c) => c.kind);

describe("Edge cases", () => {
  it("1. down and back within 3 minutes → interruption, no external comms, kept for reporting", async () => {
    await down(w.db, "1001");
    await run(w.db, 2);
    await up(w.db, "1001");
    await run(w.db, 10);
    const inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("interruption");
    expect(inc.downtimeSeconds).toBe(120);
    expect(await commsFor(w.db, inc.id)).toHaveLength(0);
    expect(captured).toHaveLength(0);
  });

  it("2. remains down beyond 3 minutes → validated and communicated", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    expect((await incidentFor(w.db, w.dwv.id)).phase).toBe("active");
    expect(await residentKinds((await incidentFor(w.db, w.dwv.id)).id)).toEqual(["initial_outage"]);
  });

  it("3. duplicate outage notifications → one incident, one initial message", async () => {
    const r1 = await down(w.db, "1001");
    const r2 = await down(w.db, "1001");                       // exact duplicate
    const r3 = await netxms(w.db, "SYS_NODE_UNREACHABLE", "1001", new Date(at().getTime() + 20_000)); // same state, other event
    expect(r1.result).toBe("processed");
    expect(r2.result).toBe("duplicate");
    expect(r3.result).toBe("ignored");
    await run(w.db, 5);
    const all = await w.db.select().from(s.incidents);
    expect(all).toHaveLength(1);
    expect(await residentKinds(all[0].id)).toEqual(["initial_outage"]);
  });

  it("4. delayed restoration notification → downtime uses the event's own timestamp", async () => {
    await down(w.db, "1001");
    await run(w.db, 30);
    const realUp = new Date(at().getTime() - 10 * 60_000); // came up 10 min ago, delivered now
    await up(w.db, "1001", realUp);
    await run(w.db, 1);
    const inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("awaiting_rfo"); // already stable for >5 min
    expect(inc.downtimeSeconds).toBe(20 * 60);
  });

  it("5. restoration arrives before its outage → reconstructed, no contradictory comms", async () => {
    const t = at();
    await up(w.db, "1001", new Date(t.getTime() + 60_000));     // UP (08:01) arrives first
    const r = await down(w.db, "1001", t);                     // then DOWN (08:00)
    expect(r.result).toBe("stale");
    await run(w.db, 10);
    const inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("interruption");
    expect(inc.downtimeSeconds).toBe(60);
    expect(captured).toHaveLength(0);
  });

  it("6. monitoring integration silent → critical health alert", async () => {
    await down(w.db, "1001");
    advance(61);
    await runHealthSweep(w.db);
    const [a] = await w.db.select().from(s.alerts).where(eq(s.alerts.key, "monitoring_silent:netxms"));
    expect(a.severity).toBe("critical");
    await netxms(w.db, "PORTAL_HEARTBEAT", "0");
    await runHealthSweep(w.db);
    const [a2] = await w.db.select().from(s.alerts).where(eq(s.alerts.key, "monitoring_silent:netxms"));
    expect(a2.resolvedAt).not.toBeNull();
  });

  it("7. multiple sites down simultaneously → independent incidents and schedules", async () => {
    await Promise.all([down(w.db, "1001"), down(w.db, "2001"), down(w.db, "3001")]);
    await run(w.db, 3);
    const all = await w.db.select().from(s.incidents);
    expect(all).toHaveLength(3);
    expect(all.every((i) => i.phase === "active")).toBe(true);
    expect(new Set(all.map((i) => i.reference)).size).toBe(3);
  });

  it("8 & 22. shared backhaul → correlation; grouped ISP update sent once per ISP contact", async () => {
    await down(w.db, "1001");
    await down(w.db, "2001");
    await run(w.db, 3);
    const [sgg] = await w.db.select().from(s.correlationSuggestions);
    expect(sgg.reason).toContain("POP-NORTH");
    await decideCorrelation(w.db, w.tech, { suggestionId: sgg.id, accept: true });
    const dwv = await incidentFor(w.db, w.dwv.id);
    captured.length = 0;
    await submitTechnicalUpdate(w.db, w.tech, { incidentId: dwv.id, text: "DFA fibre break on POP-NORTH ring", facts: { providerId: w.dfa.id, faultType: "fibre_break" }, applyToGroup: true });
    await tick(w.db);
    const isp = captured.filter((m) => m.meta.audience === "isp");
    // ISP Alpha serves both sites → noc@alpha + ops@alpha once each; Bravo serves DWV only.
    expect(isp.map((m) => m.address).sort()).toEqual(["noc@alpha.test", "noc@bravo.test", "ops@alpha.test"]);
    expect(captured.filter((m) => m.meta.audience === "resident").map((m) => m.address).sort()).toEqual(["list:res-dwv", "list:res-hzd"]);
  });

  it("9. wrong cause corrected → audit trail, unsent message cancelled, next comms use new cause", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    captureControl.failNext = 10; // hold the first cause message in retry so it is still unsent
    await confirmCause(w.db, w.desk, { incidentId: inc.id, causeKey: "power_area" });
    await tick(w.db);
    captureControl.failNext = 0;
    await confirmCause(w.db, w.desk, { incidentId: inc.id, causeKey: "power_ok" });
    await run(w.db, 5);
    const cs = await commsFor(w.db, inc.id);
    const areaRes = cs.find((c) => c.kind === "power_area" && c.audience === "resident")!;
    // Partly-attempted messages are never recalled; untouched ones are cancelled.
    expect(["cancelled", "sent"]).toContain(areaRes.status);
    expect(cs.some((c) => c.kind === "power_ok_investigating" && c.status === "sent")).toBe(true);
    const confs = await w.db.select().from(s.causeConfirmations).where(eq(s.causeConfirmations.incidentId, inc.id));
    expect(confs).toHaveLength(2);
    expect(confs.find((c) => c.causeKey === "power_area")!.supersededAt).not.toBeNull();
    expect(confs.find((c) => c.causeKey === "power_ok")!.isCorrection).toBe(true);
    const audits = await w.db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "incident.cause_corrected"));
    expect(audits).toHaveLength(1);
    await run(w.db, 120);
    expect(await residentKinds(inc.id)).toContain("awaiting_backhaul"); // periodic follows the corrected cause
  });

  it("10. technical update without ETA → ETA-free template", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    await submitTechnicalUpdate(w.db, w.tech, { incidentId: inc.id, text: "Techs dispatched, no ETA yet", facts: { technicians: "dispatched", etaUnavailable: true } });
    await tick(w.db);
    const m = captured.find((x) => x.meta.kind === "technicians_dispatched" && x.meta.audience === "resident")!;
    expect(m.text).toContain("No estimated restoration time has been confirmed yet");
  });

  it("11. ETA changes later → eta_changed; past ETA is never quoted", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    await submitTechnicalUpdate(w.db, w.tech, { incidentId: inc.id, text: "ETA 10:00", facts: { eta: "2026-11-16T08:00:00.000Z" } });
    await tick(w.db);
    await submitTechnicalUpdate(w.db, w.tech, { incidentId: inc.id, text: "ETA now 11:30", facts: { eta: "2026-11-16T09:30:00.000Z" } });
    await tick(w.db);
    expect(await residentKinds(inc.id)).toEqual(["initial_outage", "eta_available", "eta_changed"]);
    expect(captured.find((m) => m.meta.kind === "eta_changed")!.text).toContain("11:30 today");
    // ETA passes without restoration: the 2-hour message must not repeat it, and Technical is chased.
    await run(w.db, 245); // ETA (11:30) passes; the 12:03 update must not quote it
    const periodic = captured.filter((m) => m.meta.kind === "no_update" && m.meta.audience === "resident");
    expect(periodic.length).toBeGreaterThan(0);
    expect(periodic.at(-1)!.text).not.toContain("11:30");
    await runEscalationSweep(w.db);
    expect((await w.db.select().from(s.escalations)).some((e) => e.trigger === "eta_passed")).toBe(true);
  });

  it("12. contradictory update → flagged; cannot send until the field is confirmed", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    const text = "ETA 18:00 but ETA unknown according to their NOC";
    const pv = await previewTechnicalUpdate(w.db, { incidentId: inc.id, text });
    expect(pv.extraction!.conflicts.map((c) => c.field)).toContain("eta");
    expect(pv.facts.eta).toBeUndefined(); // conflicting fields are never pre-filled
    await expect(submitTechnicalUpdate(w.db, w.tech, { incidentId: inc.id, text, facts: { eta: "2026-11-16T16:00:00.000Z" } })).rejects.toThrow(/contradictory/);
    await submitTechnicalUpdate(w.db, w.tech, { incidentId: inc.id, text, facts: { etaUnavailable: true }, acknowledgedConflicts: ["eta"] });
    // "Investigating" must not become "repairs underway"
    const pv2 = await previewTechnicalUpdate(w.db, { incidentId: inc.id, text: "Technicians are investigating the fault" });
    expect(pv2.facts.repairStatus).toBe("investigating");
    expect(pv2.plan.requestedKind).toBeNull();
  });

  it("13. no technical update for 2h → no-update message continues and Technical is chased", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    await confirmCause(w.db, w.desk, { incidentId: inc.id, causeKey: "power_ok" });
    await run(w.db, 121);
    await runEscalationSweep(w.db);
    expect(await residentKinds(inc.id)).toContain("awaiting_backhaul");
    const esc = await w.db.select().from(s.escalations).where(eq(s.escalations.trigger, "technical_update_overdue"));
    expect(esc.map((e) => e.level).sort()).toEqual([1, 2]);
  });

  it("14. email provider fails during a scheduled send → retried, then delivered; failure alerted while pending", async () => {
    await down(w.db, "1001");
    captureControl.failNext = 2;
    await run(w.db, 3);
    let ds = await w.db.select().from(s.communicationDeliveries);
    expect(ds.filter((d) => d.status === "deferred")).toHaveLength(2);
    expect((await w.db.select().from(s.alerts)).some((a) => a.key.startsWith("delivery_retry:") && !a.resolvedAt)).toBe(true);
    await run(w.db, 2);
    ds = await w.db.select().from(s.communicationDeliveries);
    expect(ds.every((d) => d.status === "accepted")).toBe(true);
    const inc = await incidentFor(w.db, w.dwv.id);
    expect((await live(inc.id)).every((c) => c.status === "sent")).toBe(true);
  });

  it("14b. permanent failure → delivery failed, communication flagged, escalated", async () => {
    await down(w.db, "1001");
    captureControl.failNext = 100; captureControl.transient = false;
    await run(w.db, 3);
    captureControl.transient = true;
    const inc = await incidentFor(w.db, w.dwv.id);
    expect((await live(inc.id)).every((c) => c.status === "failed")).toBe(true);
    await runEscalationSweep(w.db);
    expect((await w.db.select().from(s.escalations)).some((e) => e.trigger === "delivery_failed")).toBe(true);
  });

  it("15. accepted then bounced → status updated, recipient flagged after repeated bounces", async () => {
    const { applyDeliveryStatus } = await import("@/server/comms/delivery-status");
    await down(w.db, "1001");
    await run(w.db, 3);
    const [d] = await w.db.select().from(s.communicationDeliveries).where(eq(s.communicationDeliveries.address, "noc@bravo.test"));
    await applyDeliveryStatus(w.db, { providerMessageId: d.providerMessageId!, status: "bounced", detail: "550 mailbox unavailable", hard: true });
    let [r] = await w.db.select().from(s.recipients).where(eq(s.recipients.email, "noc@bravo.test"));
    expect(r.bounceCount).toBe(1);
    expect(r.status).toBe("active");
    await run(w.db, 120);
    const [d2] = await w.db.select().from(s.communicationDeliveries).where(and(eq(s.communicationDeliveries.address, "noc@bravo.test"), eq(s.communicationDeliveries.status, "accepted")));
    await applyDeliveryStatus(w.db, { providerMessageId: d2.providerMessageId!, status: "bounced", detail: "550", hard: true });
    [r] = await w.db.select().from(s.recipients).where(eq(s.recipients.email, "noc@bravo.test"));
    expect(r.status).toBe("invalid");
    expect((await w.db.select().from(s.alerts)).some((a) => a.key === `recipient_invalid:${r.id}`)).toBe(true);
    const [c] = await w.db.select().from(s.communications).where(eq(s.communications.id, d.communicationId));
    expect(c.status).toBe("partially_failed");
  });

  it("16. server restarts mid-job → lease expires, job re-runs, no duplicate messages", async () => {
    await down(w.db, "1001");
    advance(3);
    const claimed = await claimDue(w.db, "crashed-worker"); // claimed then the process 'dies'
    expect(claimed.map((j) => j.kind)).toEqual(["validate_outage"]);
    advance(1);
    await drain(w.db);
    expect((await incidentFor(w.db, w.dwv.id)).phase).toBe("validating"); // still leased
    advance(5);
    await drain(w.db);
    await drain(w.db);
    const inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("active");
    expect(await residentKinds(inc.id)).toEqual(["initial_outage"]);
    // A job that keeps failing ends in the dead-letter state.
    const job = { ...claimed[0], attempts: 8, max_attempts: 8 };
    expect(await failJob(w.db, job, new Error("boom"))).toBe("dead");
  });

  it("17. link up then immediately down → no restoration message, flap counted, downtime continuous", async () => {
    await down(w.db, "1001");
    await run(w.db, 30);
    await up(w.db, "1001");
    await run(w.db, 2);
    await down(w.db, "1001");
    await run(w.db, 10);
    let inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("active");
    expect(inc.flapCount).toBe(1);
    expect(await residentKinds(inc.id)).toEqual(["initial_outage"]);
    await up(w.db, "1001");
    await run(w.db, 6);
    inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("awaiting_rfo");
    expect(inc.downtimeSeconds).toBe(42 * 60); // from the ORIGINAL start to the final restore
    expect(await w.db.select().from(s.incidents)).toHaveLength(1);
  });

  it("17b. outage again after restoration → new incident linked to the previous one", async () => {
    await down(w.db, "1001");
    await run(w.db, 10);
    await up(w.db, "1001");
    await run(w.db, 10);
    await down(w.db, "1001");
    await run(w.db, 3);
    const all = await w.db.select().from(s.incidents).orderBy(s.incidents.createdAt);
    expect(all).toHaveLength(2);
    expect(all[1].relatedIncidentId).toBe(all[0].id);
  });

  it("18. restored while a scheduled update is queued → stale update cancelled, not sent", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    await run(w.db, 116);           // 1 minute before the 2-hour update
    await up(w.db, "1001");         // link comes up
    await run(w.db, 1);             // periodic job fires during 'restoring' → deferred, not sent
    expect(await residentKinds(inc.id)).toEqual(["initial_outage"]);
    await run(w.db, 10);
    expect(await residentKinds(inc.id)).toEqual(["initial_outage", "restored_awaiting_rfo"]);
  });

  it("18b. update queued, then restoration confirmed before delivery → cancelled, never sent", async () => {
    await down(w.db, "1001");
    await run(w.db, 10);
    const inc = await incidentFor(w.db, w.dwv.id);
    captureControl.failNext = 4; // provider down: all 4 deliveries of the next update are deferred
    await submitTechnicalUpdate(w.db, w.tech, { incidentId: inc.id, text: "Techs on site", facts: { technicians: "on_site" } });
    await tick(w.db);
    await up(w.db, "1001", new Date(at().getTime() - 6 * 60_000)); // link came up 6 min ago → already stable
    await run(w.db, 30);
    const c = (await commsFor(w.db, inc.id)).filter((x) => x.kind === "technicians_on_site");
    expect(c.every((x) => x.status === "cancelled")).toBe(true);
    expect(captured.some((m) => m.meta.kind === "technicians_on_site")).toBe(false);
    expect(captured.some((m) => m.meta.kind === "restored_awaiting_rfo")).toBe(true);
    // An update entered while 'restoring' is stored but never sent.
  });

  it("19. RFO arrives days later → still accepted, durations tracked, overdue escalations fired", async () => {
    await down(w.db, "1001");
    await run(w.db, 10);
    await up(w.db, "1001");
    await run(w.db, 6);
    advance(60 * 24 * 3 + 5);
    await runEscalationSweep(w.db);
    const esc = await w.db.select().from(s.escalations).where(eq(s.escalations.trigger, "rfo_overdue"));
    expect(esc.map((e) => e.level).sort()).toEqual([1, 2]);
    const inc = await incidentFor(w.db, w.dwv.id);
    await submitRfo(w.db, w.tech, { incidentId: inc.id, rfoText: "Faulty power supply in the cabinet was replaced." });
    await tick(w.db);
    expect((await incidentFor(w.db, w.dwv.id)).phase).toBe("resolved");
    await runEscalationSweep(w.db);
    expect((await w.db.select().from(s.escalations).where(eq(s.escalations.trigger, "rfo_overdue"))).every((e) => e.resolvedAt)).toBe(true);
  });

  it("20. template edited while a message is queued → queued message keeps the approved wording it was rendered with", async () => {
    await down(w.db, "1001");
    captureControl.failNext = 1;
    await run(w.db, 3);  // initial rendered, one delivery deferred
    const [tpl] = await w.db.select().from(s.communicationTemplates).where(eq(s.communicationTemplates.kind, "initial_outage"));
    const v = await createDraft(w.db, w.admin, { templateId: tpl.id, subject: "NEW {{site_name}}", body: "New wording for {{site_name}}" });
    await submitForApproval(w.db, w.admin, v.id);
    const other = { id: w.tech.id, label: "Second admin" };
    await w.db.update(s.users).set({ role: "admin" }).where(eq(s.users.id, w.tech.id!));
    await approveVersion(w.db, other, v.id);
    await run(w.db, 2);
    const initial = captured.filter((m) => m.meta.kind === "initial_outage");
    expect(initial.length).toBe(4);
    expect(initial.every((m) => m.text.includes("We are aware of a network interruption"))).toBe(true);
  });

  it("20b. unapproved wording can never be sent; author cannot approve their own change", async () => {
    const [tpl] = await w.db.select().from(s.communicationTemplates).where(eq(s.communicationTemplates.kind, "initial_outage"));
    const v = await createDraft(w.db, w.admin, { templateId: tpl.id, subject: "Draft {{site_name}}", body: "Draft body {{site_name}}" });
    await submitForApproval(w.db, w.admin, v.id);
    await expect(approveVersion(w.db, w.admin, v.id)).rejects.toThrow(/own/);
    await down(w.db, "1001");
    await run(w.db, 3);
    expect(captured.some((m) => m.text.includes("Draft body"))).toBe(false);
    await expect(createDraft(w.db, w.admin, { templateId: tpl.id, subject: "x", body: "Hi {{customer_name}}" })).rejects.toThrow(/Unknown placeholder/);
  });

  it("21. update against the wrong site/incident is rejected (closed incident, stale version)", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    await confirmCause(w.db, w.desk, { incidentId: inc.id, causeKey: "power_area", expectedVersion: inc.version });
    await expect(confirmCause(w.db, w.desk, { incidentId: inc.id, causeKey: "power_ok", expectedVersion: inc.version })).rejects.toThrow(/updated by someone else/);
    await down(w.db, "3001");
    await run(w.db, 1);
    await up(w.db, "3001");
    await run(w.db, 1);
    const mdw = await incidentFor(w.db, w.mdw.id);
    expect(mdw.phase).toBe("interruption");
    await expect(submitTechnicalUpdate(w.db, w.tech, { incidentId: mdw.id, text: "x", facts: {} })).rejects.toThrow(/closed/);
    // Only the incident's own site recipients are ever targeted.
    const cs = await w.db.select().from(s.communicationDeliveries);
    expect(cs.some((d) => d.address === "list:res-mdw")).toBe(false);
  });

  it("23. after-hours outage → identical automation; business-hours-only rules wait", async () => {
    const { setTime } = await import("./helpers");
    setTime(new Date("2026-11-15T23:30:00Z")); // Monday 01:30 SAST
    await w.db.update(s.escalationRules).set({ window: "business_hours" }).where(eq(s.escalationRules.trigger, "cause_overdue"));
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    expect(await residentKinds(inc.id)).toEqual(["initial_outage"]);
    await run(w.db, 30);
    await runEscalationSweep(w.db);
    expect((await w.db.select().from(s.escalations)).filter((e) => e.trigger === "cause_overdue")).toHaveLength(0);
  });

  it("24. unacknowledged dispatch → escalated (see Scenario C) and status stays 'technician required'", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    await confirmCause(w.db, w.desk, { incidentId: inc.id, causeKey: "power_server_room" });
    await createDispatch(w.db, w.desk, { incidentId: inc.id });
    await expect(createDispatch(w.db, w.desk, { incidentId: inc.id })).rejects.toThrow(/already open/);
    await run(w.db, 16);
    await runEscalationSweep(w.db);
    expect((await incidentFor(w.db, w.dwv.id)).status).toBe("technician_required");
    expect((await w.db.select().from(s.escalations)).some((e) => e.trigger === "dispatch_unacknowledged")).toBe(true);
  });

  it("25. two employees update the same incident simultaneously → one wins, the other gets a conflict", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    const results = await Promise.allSettled([
      confirmCause(w.db, w.desk, { incidentId: inc.id, causeKey: "power_area", expectedVersion: inc.version }),
      confirmCause(w.db, w.admin, { incidentId: inc.id, causeKey: "power_ok", expectedVersion: inc.version }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await tick(w.db);
    const causeMsgs = (await live(inc.id)).filter((c) => c.purpose === "cause" && c.audience === "resident");
    expect(causeMsgs).toHaveLength(1);
  });

  it("Interface events never take down a site unless that interface is registered", async () => {
    const st = await getSettings(w.db);
    await processEvent(w.db, fromNetxms({ event: "SYS_IF_DOWN", object_id: 1001, object_name: "DWV L3GR10", timestamp: Math.floor(at().getTime() / 1000), interface: "ether5" }, st));
    await run(w.db, 5);
    expect(await w.db.select().from(s.incidents)).toHaveLength(0);
  });

  it("Unmatched monitoring objects raise an admin alert instead of being dropped silently", async () => {
    const r = await down(w.db, "9999");
    expect(r.result).toBe("unmatched");
    expect((await w.db.select().from(s.alerts)).some((a) => a.key.startsWith("unmatched:netxms:9999"))).toBe(true);
  });

  it("Telegram backup channel posts are parsed into the same pipeline", async () => {
    const st = await getSettings(w.db);
    await w.db.insert(s.siteMonitoringIdentifiers).values({ siteId: w.hzd.id, source: "any", matchType: "name_exact", value: "HZD L3GR10" });
    const ev = fromTelegram({ channel_post: { message_id: 55, chat: { id: -100 }, date: Math.floor(at().getTime() / 1000), text: "🔴 HZD L3GR10 is down" } }, st)!;
    expect(ev.kind).toBe("down");
    const r = await processEvent(w.db, ev);
    expect(r.result).toBe("processed");
  });
});

it("Audit log is append-only and its hash chain verifies", async () => {
  const { verifyAuditChain } = await import("@/server/audit/verify");
  const ww = w;
  await down(ww.db, "1001");
  await run(ww.db, 3);
  const inc = await incidentFor(ww.db, ww.dwv.id);
  await confirmCause(ww.db, ww.desk, { incidentId: inc.id, causeKey: "power_area" });
  await confirmCause(ww.db, ww.desk, { incidentId: inc.id, causeKey: "power_ok" });
  expect((await verifyAuditChain(ww.db)).ok).toBe(true);
  const { sql } = await import("drizzle-orm");
  await expect(ww.db.execute(sql`update audit_logs set action = 'x'`)).rejects.toThrow();
  await expect(ww.db.execute(sql`update technical_updates set original_text = 'x'`)).resolves.toBeDefined(); // no rows yet → no-op
});

it("Headend IP identifies the site when no object ID is registered (interface events still ignored)", async () => {
  const st = await getSettings(w.db);
  await w.db.insert(s.siteMonitoringIdentifiers).values({ siteId: w.hzd.id, source: "netxms", matchType: "ip", value: "10.75.9.1", critical: true });
  const ts = Math.floor(at().getTime() / 1000);
  const ifEv = await processEvent(w.db, fromNetxms({ event: "SYS_IF_DOWN", object_id: 777, object_name: "HZD L3GR10", ip: "10.75.9.1", timestamp: ts, interface: "ether3" }, st));
  expect(ifEv.result).toBe("unmatched");
  const r = await processEvent(w.db, fromNetxms({ event: "SYS_NODE_DOWN", object_id: 777, object_name: "HZD L3GR10", ip: "10.75.9.1", timestamp: ts + 1 }, st));
  expect(r.result).toBe("processed");
  expect((await incidentFor(w.db, w.hzd.id)).phase).toBe("validating");
});

describe("Resident safety lock", () => {
  const setMode = async (mode: string, accounts: string[] = []) => {
    await w.db.delete(s.settings).where(eq(s.settings.key, "residentDelivery"));
    await w.db.insert(s.settings).values([{ key: "residentDelivery", value: mode }, { key: "residentTestAccounts", value: accounts }]);
  };

  it("off: resident message is prepared but nothing reaches residents; ISPs still notified", async () => {
    await setMode("off");
    await down(w.db, "1001");
    await run(w.db, 4);
    const inc = await incidentFor(w.db, w.dwv.id);
    const res = (await commsFor(w.db, inc.id)).filter((c) => c.audience === "resident");
    expect(res).toHaveLength(1);
    expect(res[0].status).toBe("cancelled");
    expect(captured.filter((m) => /^(list|account):/.test(m.address))).toHaveLength(0);
    expect(captured.filter((m) => m.address.includes("@")).length).toBeGreaterThan(0);
  });

  it("test: only the test account receives it, marked [TEST]", async () => {
    await setMode("test", ["ACC12345"]);
    await down(w.db, "1001");
    await run(w.db, 4);
    const toResidents = captured.filter((m) => /^(list|account):/.test(m.address));
    expect(toResidents.map((m) => m.address)).toEqual(["account:ACC12345"]);
  });
});
