/**
 * Source adapters: turn whatever a monitoring system sends into one NormalizedEvent.
 * Adding a new monitoring system = adding a function here + a route.
 */
import { z } from "zod";
import type { Settings } from "../domain/settings";
import { clock } from "../lib/clock";
import { sha256 } from "../lib/crypto";

export interface NormalizedEvent {
  source: string;
  dedupeKey: string;
  kind: "down" | "up" | "heartbeat" | "unknown";
  eventName: string;
  objectRef: string;    // stable id (NetXMS object id)
  objectName: string;   // human name (NetXMS object name)
  occurredAt: Date;
  raw: unknown;
}

const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function safeTime(epochMs: number | null): Date {
  const now = clock.now();
  if (!epochMs || !Number.isFinite(epochMs)) return now;
  // Never trust a source clock that is ahead of ours.
  return epochMs > now.getTime() + MAX_FUTURE_SKEW_MS ? now : new Date(epochMs);
}

/** NetXMS — payload produced by the server action documented in docs/NETXMS_SETUP.md. */
export const NetxmsPayload = z.object({
  event: z.string().min(1).max(128),
  object_id: z.union([z.string(), z.number()]).transform(String),
  object_name: z.string().max(256).default(""),
  timestamp: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  ip: z.string().max(64).optional(),
  severity: z.union([z.string(), z.number()]).optional(),
  interface: z.string().max(256).optional(),
  message: z.string().max(2000).optional(),
});

export function fromNetxms(body: unknown, s: Settings): NormalizedEvent {
  const p = NetxmsPayload.parse(body);
  const name = p.event.toUpperCase();
  const kind = name === "PORTAL_HEARTBEAT" || name === "HEARTBEAT" ? "heartbeat"
    : s.downEvents.includes(name) ? "down" : s.upEvents.includes(name) ? "up" : "unknown";
  // Interface events are keyed on node + interface so a port flap never looks like the node.
  const iface = p.interface && !p.interface.startsWith("%") ? p.interface : "";
  return {
    source: "netxms",
    dedupeKey: `netxms:${p.object_id}:${iface}:${name}:${p.timestamp}`,
    kind, eventName: name,
    objectRef: iface ? `${p.object_id}/${iface}` : p.object_id,
    objectName: p.object_name,
    occurredAt: safeTime(p.timestamp * 1000),
    raw: body,
  };
}

/** Telegram backup channel: the portal's bot is an admin of a private channel NetXMS posts into. */
export function fromTelegram(update: any, s: Settings): NormalizedEvent | null {
  const msg = update?.channel_post ?? update?.message ?? update?.edited_channel_post;
  if (!msg || typeof msg.text !== "string") return null;
  let object = "", state = "";
  for (const pat of s.telegramPatterns) {
    let re: RegExp;
    try { re = new RegExp(pat, "i"); } catch { continue; }
    const m = re.exec(msg.text);
    if (m?.groups?.object && m.groups.state) { object = m.groups.object.trim(); state = m.groups.state.toLowerCase(); break; }
  }
  const kind = ["down", "unreachable", "offline"].includes(state) ? "down" : ["up", "online"].includes(state) ? "up" : "unknown";
  return {
    source: "telegram",
    dedupeKey: `telegram:${msg.chat?.id}:${msg.message_id}`,
    kind, eventName: state ? `TELEGRAM_${state.toUpperCase()}` : "TELEGRAM_UNPARSED",
    objectRef: "", objectName: object,
    occurredAt: safeTime((msg.date ?? 0) * 1000),
    raw: update,
  };
}

/** Generic contract for any future monitoring system. */
export const GenericPayload = z.object({
  event_id: z.string().max(200).optional(),
  object_id: z.string().max(200).default(""),
  object_name: z.string().max(256).default(""),
  state: z.enum(["down", "up", "heartbeat"]),
  occurred_at: z.string().datetime({ offset: true }),
});

export function fromGeneric(source: string, body: unknown): NormalizedEvent {
  const p = GenericPayload.parse(body);
  const occurred = safeTime(Date.parse(p.occurred_at));
  return {
    source,
    dedupeKey: `${source}:${p.event_id ?? sha256(`${p.object_id}|${p.object_name}|${p.state}|${p.occurred_at}`)}`,
    kind: p.state, eventName: p.state.toUpperCase(),
    objectRef: p.object_id, objectName: p.object_name, occurredAt: occurred, raw: body,
  };
}
