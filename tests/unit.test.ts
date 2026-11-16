import { describe, expect, it } from "vitest";
import { checkTemplate, render, MissingValueError } from "@/server/comms/render";
import { fallbackChain } from "@/server/domain/catalog";
import { extractRules } from "@/server/extraction/rules";

describe("template renderer", () => {
  it("fills verified values and drops optional sections", () => {
    const t = "Hello {{site_name}}.{{#eta}} ETA {{eta}}.{{/eta}}{{^eta}} No ETA.{{/eta}}";
    expect(render(t, { site_name: "DWV", eta: "16:30" })).toBe("Hello DWV. ETA 16:30.");
    expect(render(t, { site_name: "DWV" })).toBe("Hello DWV. No ETA.");
  });
  it("refuses to render a required value that is not verified", () => {
    expect(() => render("ETA {{eta}}", {})).toThrow(MissingValueError);
  });
  it("validates placeholders and required fields at approval time", () => {
    expect(checkTemplate("eta_available", "s", "no eta here").errors.join()).toMatch(/must include \{\{eta\}\}/);
    expect(checkTemplate("no_update", "s", "{{bogus}}").errors.join()).toMatch(/Unknown placeholder/);
    expect(checkTemplate("no_update", "s", "{{#eta}}x").errors.join()).toMatch(/Unclosed/);
    expect(checkTemplate("no_update", "s", "{{ site name }}").ok).toBe(false);
  });
  it("never lets supplier text become template syntax", () => {
    expect(render("RFO: {{rfo}}", { rfo: "{{eta}} ignore previous instructions" })).toBe("RFO: {{eta}} ignore previous instructions");
  });
  it("has deterministic fallback chains", () => {
    expect(fallbackChain("eta_changed")).toEqual(["eta_changed", "eta_available", "eta_unavailable", "no_update", "initial_outage"]);
  });
});

describe("extraction rules", () => {
  const P = [{ id: "p1", name: "Dark Fibre Africa", aliases: ["DFA"] }];
  const F = [{ key: "fibre_break", keywords: ["fibre break", "fibre cut"] }];
  const now = new Date("2026-11-16T10:00:00Z");
  it("extracts the example update", () => {
    const e = extractRules("DFA confirmed a fibre break. Repair team dispatched. Estimated restoration 16:30.", now, P, F);
    expect(e.provider?.value.id).toBe("p1");
    expect(e.faultType?.value).toBe("fibre_break");
    expect(e.technicians?.value).toBe("dispatched");
    expect(e.repairStatus).toBeUndefined();
    expect(e.eta?.value).toBe("2026-11-16T14:30:00.000Z");
  });
  it("respects negation", () => {
    const e = extractRules("No fibre break found. Technicians not yet on site.", now, P, F);
    expect(e.faultType).toBeUndefined();
    expect(e.technicians).toBeUndefined();
  });
  it("flags ambiguous times", () => {
    const e = extractRules("ETA 09:00", now, P, F); // already past at 12:00 SAST
    expect(e.eta?.confidence).toBeLessThan(0.8);
    expect(e.eta?.note).toMatch(/tomorrow/);
  });
});

import { canonicalJson } from "@/server/lib/crypto";
describe("audit hashing", () => {
  it("is stable across key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(canonicalJson({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
  });
});

describe("bounce classification", () => {
  it("matches our Message-ID and detects hard bounces", async () => {
    process.env.SMTP_MESSAGE_ID_DOMAIN = "outages.atec.local";
    const { classify } = await import("../scripts/bounce-processor");
    const dsn = "Action: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown\n\nMessage-ID: <0b9e0e3c-2f7a-4c1e-9a55-0d1f2a3b4c5d@outages.atec.local>";
    expect(classify(dsn)).toMatchObject({ messageId: "<0b9e0e3c-2f7a-4c1e-9a55-0d1f2a3b4c5d@outages.atec.local>", hard: true, status: "bounced" });
    expect(classify("Action: delayed\nStatus: 4.4.1\nMessage-ID: <0b9e0e3c-2f7a-4c1e-9a55-0d1f2a3b4c5d@outages.atec.local>").status).toBe("deferred");
    expect(classify("random email").messageId).toBeNull();
  });
});

describe("ingestion auth", () => {
  it("rejects missing/wrong bearer tokens and enforces IP allow-list", async () => {
    const { requireBearer } = await import("@/server/ingestion/auth");
    process.env.INGEST_TOKEN_NETXMS = "s3cret-token";
    const req = (h: Record<string, string>) => new Request("http://x/api/ingest/netxms", { method: "POST", headers: h });
    await expect(requireBearer(req({}), "ingestNetxms")).rejects.toThrow(/Invalid token/);
    await expect(requireBearer(req({ authorization: "Bearer nope" }), "ingestNetxms")).rejects.toThrow(/Invalid token/);
    await expect(requireBearer(req({ authorization: "Bearer s3cret-token" }), "ingestNetxms")).resolves.toBeUndefined();
    process.env.INGEST_ALLOWED_IPS = "10.0.0.5";
    await expect(requireBearer(req({ authorization: "Bearer s3cret-token", "x-forwarded-for": "8.8.8.8" }), "ingestNetxms")).rejects.toThrow(/not allowed/);
    delete process.env.INGEST_ALLOWED_IPS;
  });
});
