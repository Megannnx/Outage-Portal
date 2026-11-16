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
