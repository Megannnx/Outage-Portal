/**
 * Deterministic extraction of technical facts from pasted supplier / technician text.
 *
 * Principles
 *  - Every fact carries the exact text that supports it (evidence) and a confidence.
 *  - Nothing is inferred: "technicians are investigating" is NOT "repairs underway".
 *  - Negations ("not yet on site", "no ETA") are respected.
 *  - Contradictions are reported, never silently resolved.
 *  - The pasted text is data. It is never executed, templated or followed as instructions.
 */
import { zonedWallTime, inTz } from "../lib/time";

export interface Fact<T> { value: T; confidence: number; evidence: string; note?: string }

export interface ProviderRef { id: string; name: string; aliases: string[] }
export interface FaultRef { key: string; keywords: string[] }

export interface Extraction {
  provider?: Fact<{ id: string; name: string }>;
  faultType?: Fact<string>;
  technicians?: Fact<"dispatched" | "on_site">;
  repairStatus?: Fact<"investigating" | "underway" | "delayed" | "completed">;
  eta?: Fact<string>;
  etaUnavailable?: Fact<true>;
  providerRef?: Fact<string>;
  nextProviderUpdate?: Fact<string>;
  furtherInvestigation?: Fact<true>;
  conflicts: { field: string; reason: string }[];
  warnings: string[];
  extractor: "rules" | "rules+llm";
}

const NEG = /\b(not|no|yet to|haven'?t|hasn'?t|has not|have not|isn'?t|aren'?t|unable to|awaiting|waiting for|pending)\b[\w\s,'-]{0,20}$/i;

function sentenceOf(text: string, idx: number, len: number): string {
  const start = Math.max(text.lastIndexOf(".", idx) + 1, text.lastIndexOf("\n", idx) + 1, 0);
  let end = text.length;
  for (const ch of [".", "\n"]) { const e = text.indexOf(ch, idx + len); if (e !== -1 && e < end) end = e; }
  return text.slice(start, end).trim();
}

function negated(text: string, idx: number): boolean {
  const s = Math.max(text.lastIndexOf(".", idx) + 1, text.lastIndexOf("\n", idx) + 1, idx - 40, 0);
  return NEG.test(text.slice(s, idx));
}

function find(text: string, re: RegExp): { m: RegExpExecArray; neg: boolean }[] {
  const out: { m: RegExpExecArray; neg: boolean }[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) { out.push({ m, neg: negated(text, m.index) }); if (m[0].length === 0) g.lastIndex++; }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Lexicon ──
const TECH_ON_SITE = /\b(?:(?:tech(?:nician)?s?|team|crew|engineers?|field\s+(?:team|staff))\s+(?:is\s+|are\s+|has\s+|have\s+)?(?:now\s+)?(?:on[\s-]?site|onsite|arrived|at\s+(?:the\s+)?site)|arrived\s+on[\s-]?site|(?:is|are)\s+(?:now\s+)?on[\s-]?site)\b/i;
const TECH_DISPATCHED = /\b(?:(?:tech(?:nician)?s?|team|crew|engineers?|field\s+(?:team|staff)|splicing\s+team|repair\s+team)\s+(?:has\s+been\s+|have\s+been\s+|was\s+|were\s+|is\s+|are\s+)?(?:dispatched|en\s+route|on\s+(?:their|the|its)\s+way|sent(?:\s+out)?|deployed|mobilised|mobilized)|dispatched\s+(?:a\s+)?(?:tech(?:nician)?s?|team|crew))\b/i;
const NOT_ON_SITE = /\b(?:not\s+(?:yet\s+)?(?:on[\s-]?site|arrived)|yet\s+to\s+(?:arrive|reach\s+(?:the\s+)?site))\b/i;
const REPAIRS_UNDERWAY = /\b(?:(?:repairs?|repair\s+work|splicing|restoration\s+work|re-?splic\w*)\s+(?:is\s+|are\s+|has\s+|have\s+)?(?:now\s+)?(?:underway|under\s+way|in\s+progress|commenced|started|begun|ongoing)|(?:busy|currently|now)\s+(?:repairing|splicing|fixing)|(?:started|commenced|begun)\s+(?:the\s+)?(?:repairs?|splicing))\b/i;
const REPAIRS_DONE = /\b(?:(?:repairs?|repair\s+work|splicing|work)\s+(?:is\s+|are\s+|has\s+been\s+|have\s+been\s+)?(?:now\s+)?(?:complete[d]?|finished|done)|completed\s+(?:the\s+)?(?:repairs?|splicing))\b/i;
const REPAIR_DELAY = /\b(?:delay(?:ed|s)?|postponed|set\s*back|setback|waiting\s+(?:for|on)\s+(?:parts|permission|wayleave|access|materials|equipment)|could\s+not\s+(?:access|gain\s+access))\b/i;
const INVESTIGATING = /\b(?:investigat\w*|troubleshoot\w*|checking|looking\s+into|diagnos\w*)\b/i;
const FURTHER = /\b(?:further\s+investigation|still\s+investigating|root\s+cause\s+(?:unknown|not\s+yet)|escalated\s+to)\b/i;
const NO_ETA = /\b(?:no\s+eta|eta\s*(?:is\s+)?(?:unknown|tbc|tba|to\s+be\s+(?:confirmed|advised)|not\s+(?:yet\s+)?(?:available|known|provided|confirmed))|without\s+an?\s+eta|no\s+estimated\s+(?:restoration\s+)?time|unable\s+to\s+(?:give|provide)\s+an?\s+eta)\b/i;
const ETA_ABS = /\b(?:eta|e\.t\.a\.?|estimated\s+(?:restoration|resolution|time\s+of\s+restoration|repair\s+time|time)|expected\s+(?:restoration|to\s+be\s+restored|back\s+(?:up|online)|completion)|restor\w*\s+(?:by|at|before)|(?:should|will)\s+be\s+(?:restored|back\s+(?:up|online)|fixed)\s+(?:by|at|before))\s*(?:of|is|time)?\s*[:\-–]?\s*(?:approx(?:imately|\.)?|around|about|~|±|\+-)?\s*(?<h>\d{1,2})(?:[:hH.](?<m>\d{2}))?\s*(?<ap>am|pm|a\.m\.|p\.m\.)?(?:\s*(?<day>today|tonight|tomorrow|tmrw))?/i;
const ETA_REL = /\b(?:eta|e\.t\.a\.?|estimated|expected|restor\w*|back\s+(?:up|online)|fixed|resolved)\b[^.\n]{0,30}?\b(?:(?:within|in)\s+)?(?:approx(?:imately|\.)?\s+|about\s+|around\s+|~)?(?<n>\d+(?:[.,]\d+)?)\s*(?<u>hours?|hrs?|h|minutes?|mins?)\b/i;
const NEXT_UPDATE = /\bnext\s+(?:update|feedback|progress\s+report)\b[^.\n]{0,25}?\b(?<h>\d{1,2})[:hH.](?<m>\d{2})\s*(?<ap>am|pm)?/i;
const PROVIDER_REF = /\b(?:ref(?:erence)?|ticket|case|incident|tt|job|fault)\s*(?:no\.?|number|nr|#|id)?\s*[:#\-]?\s*(?<ref>(?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{3,24})\b/i;

function toHour(h: number, ap?: string) {
  if (!ap) return h;
  const p = ap.toLowerCase().startsWith("p");
  if (h === 12) return p ? 12 : 0;
  return p ? h + 12 : h;
}

export function extractRules(text: string, now: Date, providers: ProviderRef[], faults: FaultRef[]): Extraction {
  const ex: Extraction = { conflicts: [], warnings: [], extractor: "rules" };
  const clean = text.replace(/\r/g, "").slice(0, 8000);

  // Provider
  for (const p of providers) {
    for (const name of [p.name, ...p.aliases]) {
      if (!name) continue;
      const m = new RegExp(`(?<![\\w])${escapeRe(name)}(?![\\w])`, "i").exec(clean);
      if (m) { ex.provider = { value: { id: p.id, name: p.name }, confidence: 0.95, evidence: m[0] }; break; }
    }
    if (ex.provider) break;
  }

  // Fault type — first non-negated keyword wins; different types → conflict
  const faultHits: { key: string; evidence: string }[] = [];
  for (const f of faults) for (const kw of f.keywords) {
    for (const { m, neg } of find(clean, new RegExp(`\\b${escapeRe(kw)}\\b`, "i"))) {
      if (neg) { ex.warnings.push(`Ignored negated mention: "${sentenceOf(clean, m.index, m[0].length)}"`); continue; }
      faultHits.push({ key: f.key, evidence: sentenceOf(clean, m.index, m[0].length) });
    }
  }
  const faultKeys = [...new Set(faultHits.map((h) => h.key))];
  if (faultKeys.length) {
    ex.faultType = { value: faultKeys[0], confidence: faultKeys.length === 1 ? 0.9 : 0.5, evidence: faultHits[0].evidence };
    if (faultKeys.length > 1) ex.conflicts.push({ field: "faultType", reason: `Text mentions several fault types: ${faultKeys.join(", ")}` });
  }

  // Technicians
  const onSite = find(clean, TECH_ON_SITE), disp = find(clean, TECH_DISPATCHED);
  const onSiteYes = onSite.filter((x) => !x.neg), onSiteNo = onSite.filter((x) => x.neg);
  const dispYes = disp.filter((x) => !x.neg);
  if (onSiteYes.length) ex.technicians = { value: "on_site", confidence: 0.9, evidence: sentenceOf(clean, onSiteYes[0].m.index, onSiteYes[0].m[0].length) };
  else if (dispYes.length) ex.technicians = { value: "dispatched", confidence: 0.9, evidence: sentenceOf(clean, dispYes[0].m.index, dispYes[0].m[0].length) };
  if (onSiteYes.length && onSiteNo.length) ex.conflicts.push({ field: "technicians", reason: "Text says technicians are on site and also not on site" });
  if (onSiteNo.length && !onSiteYes.length) ex.warnings.push(`Technicians are NOT yet on site: "${sentenceOf(clean, onSiteNo[0].m.index, onSiteNo[0].m[0].length)}"`);
  const notOnSite = NOT_ON_SITE.exec(clean);
  if (notOnSite) {
    ex.warnings.push(`Technicians are NOT yet on site: "${sentenceOf(clean, notOnSite.index, notOnSite[0].length)}"`);
    if (ex.technicians?.value === "on_site") ex.conflicts.push({ field: "technicians", reason: "Text says technicians are on site and also not on site" });
  }

  // Repair status — explicit statements only
  const under = find(clean, REPAIRS_UNDERWAY).filter((x) => !x.neg);
  const done = find(clean, REPAIRS_DONE).filter((x) => !x.neg);
  const delay = find(clean, REPAIR_DELAY).filter((x) => !x.neg);
  const inv = find(clean, INVESTIGATING).filter((x) => !x.neg);
  const statuses: { v: "completed" | "delayed" | "underway" | "investigating"; e: RegExpExecArray }[] = [];
  if (done.length) statuses.push({ v: "completed", e: done[0].m });
  if (delay.length) statuses.push({ v: "delayed", e: delay[0].m });
  if (under.length) statuses.push({ v: "underway", e: under[0].m });
  if (!statuses.length && inv.length) statuses.push({ v: "investigating", e: inv[0].m });
  if (statuses.length) {
    const s = statuses[0];
    ex.repairStatus = { value: s.v, confidence: statuses.length > 1 && !(s.v === "delayed" && statuses[1]?.v === "underway") ? 0.6 : 0.9, evidence: sentenceOf(clean, s.e.index, s.e[0].length) };
    if (statuses.some((x) => x.v === "completed") && statuses.some((x) => x.v === "underway"))
      ex.conflicts.push({ field: "repairStatus", reason: "Text says repairs are both underway and completed" });
  }

  // Further investigation
  const fur = find(clean, FURTHER).filter((x) => !x.neg);
  if (fur.length) ex.furtherInvestigation = { value: true, confidence: 0.85, evidence: sentenceOf(clean, fur[0].m.index, fur[0].m[0].length) };

  // ETA
  const noEta = NO_ETA.exec(clean);
  if (noEta) ex.etaUnavailable = { value: true, confidence: 0.95, evidence: sentenceOf(clean, noEta.index, noEta[0].length) };
  const abs = ETA_ABS.exec(clean);
  const rel = ETA_REL.exec(clean);
  const absUsable = !!abs?.groups && (!!abs.groups.m || !!abs.groups.ap) && toHour(Number(abs.groups.h), abs.groups.ap) <= 23 && Number(abs.groups.m ?? 0) <= 59;
  if (abs?.groups && absUsable) {
    const h = Number(abs.groups.h), m = Number(abs.groups.m ?? 0);
    const hour = toHour(h, abs.groups.ap);
    {
      const day = (abs.groups.day ?? "").toLowerCase();
      let dayOffset = day.startsWith("tom") || day === "tmrw" ? 1 : 0;
      let eta = zonedWallTime(now, hour, m, dayOffset);
      let confidence = 0.9;
      let note: string | undefined;
      if (!day && eta.getTime() < now.getTime() - 5 * 60_000) {
        eta = zonedWallTime(now, hour, m, 1);
        confidence = 0.55;
        note = "Time has already passed today — assumed tomorrow. Please confirm.";
      }
      if (!abs.groups.ap && h <= 12 && h >= 1 && hour < 7) { confidence = Math.min(confidence, 0.6); note = "12-hour time without am/pm — please confirm."; }
      ex.eta = { value: eta.toISOString(), confidence, evidence: sentenceOf(clean, abs.index, abs[0].length), note };
    }
  } else if (rel?.groups) {
    const n = Number(rel.groups.n.replace(",", "."));
    const mins = /^h/i.test(rel.groups.u) ? n * 60 : n;
    if (mins > 0 && mins <= 7 * 24 * 60) {
      ex.eta = { value: new Date(now.getTime() + mins * 60_000).toISOString(), confidence: 0.7, evidence: sentenceOf(clean, rel.index, rel[0].length), note: "Relative ETA converted from the time this update was entered. Please confirm." };
    }
  }
  if (ex.eta && ex.etaUnavailable) ex.conflicts.push({ field: "eta", reason: "Text gives an ETA and also says no ETA is available" });

  // Provider reference
  const ref = PROVIDER_REF.exec(clean);
  if (ref?.groups?.ref) ex.providerRef = { value: ref.groups.ref.toUpperCase(), confidence: 0.85, evidence: ref[0] };

  // Next update from provider
  const nu = NEXT_UPDATE.exec(clean);
  if (nu?.groups) {
    const hour = toHour(Number(nu.groups.h), nu.groups.ap);
    if (hour <= 23) {
      let t = zonedWallTime(now, hour, Number(nu.groups.m), 0);
      if (t < now) t = zonedWallTime(now, hour, Number(nu.groups.m), 1);
      ex.nextProviderUpdate = { value: t.toISOString(), confidence: 0.8, evidence: sentenceOf(clean, nu.index, nu[0].length) };
    }
  }
  void inTz;
  return ex;
}
