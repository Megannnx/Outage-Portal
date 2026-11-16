/**
 * Communication catalogue: the template kinds the engine can ask for, the
 * placeholders each may use, and the deterministic fallback chain used when
 * a template needs a fact we have not verified.
 */

export const PLACEHOLDERS = {
  site_name: "Affected site name",
  estate_name: "Estate or area",
  incident_reference: "Incident number, e.g. INC-2026-000123",
  outage_start_time: "When the outage started (local time)",
  confirmed_cause: "Admin-approved wording for the confirmed cause",
  provider_name: "Backhaul provider public name",
  fault_description: "Admin-approved wording for the verified fault",
  repair_status: "Admin-approved wording for the verified repair status",
  eta: "Verified estimated restoration time",
  next_update_time: "When the next update will be sent",
  rfo: "Verified reason for outage",
  support_contact: "Support contact details",
  restored_time: "When service was restored",
  downtime: "Total downtime",
  affected_sites: "List of affected sites (grouped ISP messages)",
} as const;
export type Placeholder = keyof typeof PLACEHOLDERS;

export interface KindDef {
  kind: string;
  label: string;
  /** Placeholders a published version of this kind MUST contain. */
  required: Placeholder[];
  /** Next kind to try when this one cannot be rendered with verified data. */
  fallback: string | null;
  purpose: "initial" | "cause" | "technical" | "periodic" | "restoration" | "final";
}

export const KINDS: KindDef[] = [
  { kind: "initial_outage", label: "Initial outage detected", required: [], fallback: null, purpose: "initial" },
  { kind: "power_area", label: "Area-wide power outage", required: [], fallback: "unknown_cause", purpose: "cause" },
  { kind: "power_server_room", label: "Server-room power outage", required: [], fallback: "unknown_cause", purpose: "cause" },
  { kind: "power_ok_investigating", label: "Power confirmed — network investigation", required: [], fallback: "unknown_cause", purpose: "cause" },
  { kind: "unknown_cause", label: "Unknown cause / still investigating", required: [], fallback: "no_update", purpose: "cause" },
  { kind: "backhaul_failure", label: "Backhaul failure", required: [], fallback: "unknown_cause", purpose: "technical" },
  { kind: "fibre_break", label: "Fibre break confirmed", required: [], fallback: "backhaul_failure", purpose: "technical" },
  { kind: "equipment_failure", label: "Equipment failure", required: [], fallback: "unknown_cause", purpose: "technical" },
  { kind: "technicians_dispatched", label: "Technicians dispatched", required: [], fallback: "no_update", purpose: "technical" },
  { kind: "technicians_on_site", label: "Technicians on site", required: [], fallback: "technicians_dispatched", purpose: "technical" },
  { kind: "repairs_underway", label: "Repairs underway", required: [], fallback: "no_update", purpose: "technical" },
  { kind: "repair_delayed", label: "Repair delay confirmed", required: [], fallback: "eta_unavailable", purpose: "technical" },
  { kind: "repairs_completed", label: "Repair work completed — monitoring", required: [], fallback: "no_update", purpose: "technical" },
  { kind: "eta_available", label: "ETA available", required: ["eta"], fallback: "eta_unavailable", purpose: "technical" },
  { kind: "eta_changed", label: "ETA changed", required: ["eta"], fallback: "eta_available", purpose: "technical" },
  { kind: "eta_unavailable", label: "ETA unavailable", required: [], fallback: "no_update", purpose: "technical" },
  { kind: "no_update", label: "No update available", required: [], fallback: "initial_outage", purpose: "periodic" },
  { kind: "awaiting_backhaul", label: "Awaiting backhaul feedback", required: [], fallback: "no_update", purpose: "periodic" },
  { kind: "power_still_unavailable", label: "Power still unavailable", required: [], fallback: "no_update", purpose: "periodic" },
  { kind: "restored_awaiting_rfo", label: "Link restored — awaiting RFO", required: [], fallback: null, purpose: "restoration" },
  { kind: "final_rfo", label: "Final RFO / resolution", required: ["rfo"], fallback: null, purpose: "final" },
  { kind: "final_no_rfo", label: "Final resolution (RFO not required)", required: [], fallback: null, purpose: "final" },
];

export const KIND_MAP = new Map(KINDS.map((k) => [k.kind, k]));

export function kindDef(kind: string): KindDef {
  return KIND_MAP.get(kind) ?? { kind, label: kind, required: [], fallback: "no_update", purpose: "technical" };
}

/** Fallback chain for a kind, e.g. eta_changed → eta_available → eta_unavailable → no_update → initial_outage. */
export function fallbackChain(kind: string): string[] {
  const chain: string[] = [];
  let k: string | null = kind;
  while (k && !chain.includes(k)) {
    chain.push(k);
    k = kindDef(k).fallback;
  }
  return chain;
}

/** Verified technical facts held on the incident. Only confirmed values ever land here. */
export interface TechState {
  providerId?: string | null;
  providerName?: string | null;
  faultType?: string | null;            // key into fault_types
  faultDescription?: string | null;     // admin-approved wording copied from fault_types
  technicians?: "dispatched" | "on_site" | null;
  repairStatus?: "investigating" | "underway" | "delayed" | "completed" | null;
  eta?: string | null;                  // ISO
  etaSetAt?: string | null;
  etaUnavailable?: boolean;
  providerRef?: string | null;
  nextProviderUpdate?: string | null;   // ISO
  furtherInvestigation?: boolean;
}

export const REPAIR_STATUS_WORDING: Record<string, string> = {
  investigating: "the fault is being investigated",
  underway: "repairs are in progress",
  delayed: "the repair has been delayed",
  completed: "repair work has been completed and the service is being monitored",
};
