/**
 * Acceptance scenarios A–H from the specification (I is in reports.test.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setup, down, up, run, tick, incidentFor, commsFor, captured, s, advance, type World } from "./helpers";
import { confirmCause, createDispatch, acknowledgeDispatchByToken, submitTechnicalUpdate, previewTechnicalUpdate, submitRfo } from "@/server/incidents/actions";
import { runEscalationSweep } from "@/server/escalations/engine";

let w: World;
beforeEach(async () => { w = await setup(); });

const kinds = async (incId: string) => (await commsFor(w.db, incId)).filter((c) => c.status !== "cancelled").map((c) => `${c.kind}/${c.audience}`);

describe("Scenario A — basic outage", () => {
  it("sends the approved initial message after 3 uninterrupted minutes, without human action", async () => {
    await down(w.db, "1001");
    const inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("validating");
    await run(w.db, 2);
    expect(await commsFor(w.db, inc.id)).toHaveLength(0);
    await run(w.db, 1);
    const after = await incidentFor(w.db, w.dwv.id);
    expect(after.phase).toBe("active");
    expect(after.status).toBe("awaiting_cause");
    expect(after.validatedAt?.toISOString()).toBe("2026-11-16T06:03:00.000Z");
    expect(await kinds(inc.id)).toEqual(["initial_outage/resident", "initial_outage/isp"]);
    // Residents via the client API list, ISPs individually (3 contacts across 2 ISPs).
    const addrs = captured.map((m) => m.address).sort();
    expect(addrs).toEqual(["list:res-dwv", "noc@alpha.test", "noc@bravo.test", "ops@alpha.test"]);
    expect(captured[0].text).toContain("We are aware of a network interruption currently affecting Dowerview Estate");
    expect(captured[0].text).not.toMatch(/\{\{/);
    expect(after.firstCommAt).not.toBeNull();
    const [sched] = await w.db.select().from(s.communicationSchedules).where(eq(s.communicationSchedules.incidentId, inc.id));
    expect(sched.nextDueAt?.toISOString()).toBe("2026-11-16T08:03:00.000Z");
  });
});

describe("Scenario B — area power outage", () => {
  it("sends the power template and keeps 2-hourly follow-ups until restoration", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    advance(4); // 08:07
    const inc0 = await incidentFor(w.db, w.dwv.id);
    const r = await confirmCause(w.db, w.desk, { incidentId: inc0.id, causeKey: "power_area", expectedVersion: inc0.version });
    await tick(w.db);
    expect(r.incident.status).toBe("power_area");
    expect(await kinds(inc0.id)).toContain("power_area/resident");
    await run(w.db, 120); // 10:07
    expect((await kinds(inc0.id)).filter((k) => k === "power_still_unavailable/resident")).toHaveLength(1);
    await run(w.db, 120); // 12:07
    expect((await kinds(inc0.id)).filter((k) => k === "power_still_unavailable/resident")).toHaveLength(2);
    await up(w.db, "1001");
    await run(w.db, 5);
    const inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("awaiting_rfo");
    await run(w.db, 240);
    expect((await kinds(inc0.id)).filter((k) => k === "power_still_unavailable/resident")).toHaveLength(2);
  });
});

describe("Scenario C — server-room power outage", () => {
  it("requires an urgent dispatch, tracks acknowledgement and escalates when ignored", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    const r = await confirmCause(w.db, w.desk, { incidentId: inc.id, causeKey: "power_server_room" });
    expect(r.requiresDispatch).toBe(true);
    expect(r.incident.status).toBe("technician_required");
    await tick(w.db);
    expect(await kinds(inc.id)).toContain("power_server_room/resident");

    // No dispatch logged within 5 min → escalation
    await run(w.db, 6);
    await runEscalationSweep(w.db);
    let esc = await w.db.select().from(s.escalations).where(eq(s.escalations.incidentId, inc.id));
    expect(esc.map((e) => e.trigger)).toContain("dispatch_not_created");

    const { dispatch, ackUrl } = await createDispatch(w.db, w.desk, { incidentId: inc.id, notes: "Gate code 1234" });
    expect(dispatch.reference).toBe("DSP-000001");
    expect((dispatch.workOrder as any).priority).toBe("URGENT");
    expect((dispatch.workOrder as any).siteName).toBe("Dowerview");
    await tick(w.db);
    const [sent] = await w.db.select().from(s.technicianDispatches).where(eq(s.technicianDispatches.id, dispatch.id));
    expect(sent.status).toBe("sent"); // internal email actually went out
    expect(captured.some((m) => m.subject.startsWith("[INTERNAL] URGENT DISPATCH DSP-000001"))).toBe(true);

    // Not acknowledged for 15 min → escalation L1, 30 → L2
    await run(w.db, 16);
    await runEscalationSweep(w.db);
    await run(w.db, 15);
    await runEscalationSweep(w.db);
    esc = await w.db.select().from(s.escalations).where(eq(s.escalations.trigger, "dispatch_unacknowledged"));
    expect(esc.map((e) => e.level).sort()).toEqual([1, 2]);

    await acknowledgeDispatchByToken(w.db, ackUrl.split("/dispatch/")[1], "Sipho M");
    const after = await incidentFor(w.db, w.dwv.id);
    expect(after.status).toBe("technician_investigating");
    await runEscalationSweep(w.db);
    esc = await w.db.select().from(s.escalations).where(eq(s.escalations.trigger, "dispatch_unacknowledged"));
    expect(esc.every((e) => e.resolvedAt)).toBe(true);
  });
});

describe("Scenario D — power confirmed → backhaul update", () => {
  it("assigns Technical, then sends the matching approved message from verified facts", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    const r = await confirmCause(w.db, w.desk, { incidentId: inc.id, causeKey: "power_ok" });
    expect(r.incident.technicalAssigned).toBe(true);
    expect(r.incident.status).toBe("awaiting_backhaul");
    await tick(w.db);
    expect(await kinds(inc.id)).toContain("power_ok_investigating/resident");
    expect(captured.some((m) => m.subject.startsWith("[INTERNAL]") && m.address === "noc-team@atec.test")).toBe(true);
    // Power confirmed must NOT be turned into a backhaul claim.
    const pok = captured.find((m) => m.meta.kind === "power_ok_investigating")!;
    expect(pok.text).not.toMatch(/backhaul|fibre/i);

    const text = "DFA confirmed a fibre break. Repair team dispatched. Estimated restoration 16:30.";
    const pv = await previewTechnicalUpdate(w.db, { incidentId: inc.id, text });
    expect(pv.facts).toMatchObject({ providerId: w.dfa.id, faultType: "fibre_break", technicians: "dispatched" });
    expect(pv.plan.requestedKind).toBe("eta_available");
    expect(pv.preview[0].body).toContain("16:30 today");
    expect(pv.preview[0].body).toContain("the cause is a fibre break");
    expect(pv.preview[0].body).not.toMatch(/Dark Fibre Africa|DFA|backhaul/i);

    const before = captured.length;
    await submitTechnicalUpdate(w.db, w.tech, { incidentId: inc.id, text, facts: pv.facts });
    await tick(w.db);
    const msgs = captured.slice(before).filter((m) => !m.subject.startsWith("[INTERNAL]"));
    expect(msgs.length).toBe(4);
    expect(msgs.every((m) => m.meta.kind === "eta_available")).toBe(true);
    const [tu] = await w.db.select().from(s.technicalUpdates).where(eq(s.technicalUpdates.incidentId, inc.id));
    expect(tu.originalText).toBe(text);
  });
});

describe("Scenario E — no information for two hours", () => {
  it("sends the approved no-update message automatically", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    await run(w.db, 119);
    expect(await kinds(inc.id)).toEqual(["initial_outage/resident", "initial_outage/isp"]);
    await run(w.db, 1);
    expect(await kinds(inc.id)).toContain("no_update/resident");
    const msg = captured.find((m) => m.meta.kind === "no_update")!;
    expect(msg.text).toContain("No estimated restoration time has been confirmed yet");
    expect(msg.text).not.toMatch(/repairs are in progress/i);
  });
});

describe("Scenario F — ETA received", () => {
  it("sends the ETA message with site and time", async () => {
    await down(w.db, "1001");
    await run(w.db, 3);
    const inc = await incidentFor(w.db, w.dwv.id);
    await submitTechnicalUpdate(w.db, w.tech, { incidentId: inc.id, text: "ETA 14:00", facts: { eta: "2026-11-16T12:00:00.000Z" } });
    await tick(w.db);
    const m = captured.find((x) => x.meta.kind === "eta_available" && x.meta.audience === "resident")!;
    expect(m.subject).toContain("14:00 today");
    expect(m.text).toContain("Dowerview");
  });
});

describe("Scenario G — restoration", () => {
  it("waits for stability, sends restoration notice, calculates downtime, awaits RFO", async () => {
    await down(w.db, "1001");
    await run(w.db, 60);
    await up(w.db, "1001");
    let inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("restoring");
    await run(w.db, 4);
    expect((await incidentFor(w.db, w.dwv.id)).phase).toBe("restoring");
    await run(w.db, 1);
    inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("awaiting_rfo");
    expect(inc.status).toBe("restored_awaiting_rfo");
    expect(inc.downtimeSeconds).toBe(3600);
    expect(inc.rfoStatus).toBe("awaiting");
    expect(await kinds(inc.id)).toContain("restored_awaiting_rfo/resident");
    const [sched] = await w.db.select().from(s.communicationSchedules).where(eq(s.communicationSchedules.incidentId, inc.id));
    expect(sched.active).toBe(false);
  });
});

describe("Scenario H — RFO received", () => {
  it("sends the final RFO message and resolves once delivered", async () => {
    await down(w.db, "1001");
    await run(w.db, 30);
    await up(w.db, "1001");
    await run(w.db, 6);
    let inc = await incidentFor(w.db, w.dwv.id);
    await expect(submitRfo(w.db, w.tech, { incidentId: inc.id, rfoText: "A third-party contractor damaged the fibre route on Main Road; DFA re-spliced the cable." })).rejects.toThrow(/kept private/);
    await submitRfo(w.db, w.tech, { incidentId: inc.id, rfoText: "A third-party contractor damaged the fibre route on Main Road; the cable was re-spliced." });
    inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("awaiting_rfo"); // not resolved until the final message is out
    await tick(w.db);
    inc = await incidentFor(w.db, w.dwv.id);
    expect(inc.phase).toBe("resolved");
    expect(inc.resolvedAt).not.toBeNull();
    const fin = captured.find((m) => m.meta.kind === "final_rfo")!;
    expect(fin.text).toContain("the cable was re-spliced");
  });
});
