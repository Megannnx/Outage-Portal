"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error { constructor(public status: number, public code: string, message: string, public details?: any) { super(message); } }

export async function api<T = any>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin", cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      if (data.error === "mfa_required") window.location.href = "/login/mfa";
      else if (data.error === "unauthenticated") window.location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    }
    if (res.status === 403 && data.error === "mfa_setup_required" && typeof window !== "undefined") window.location.href = "/account/mfa";
    throw new ApiError(res.status, data.error ?? "error", data.message ?? `Request failed (${res.status})`, data.details);
  }
  return data as T;
}

/** Shared live-update channel (one EventSource per tab). */
type Listener = () => void;
const listeners = new Set<Listener>();
let es: EventSource | null = null;
let connected = false;
const statusListeners = new Set<(ok: boolean) => void>();
function ensureStream() {
  if (es || typeof window === "undefined") return;
  es = new EventSource("/api/stream");
  es.addEventListener("changed", () => listeners.forEach((l) => l()));
  es.addEventListener("ping", () => { if (!connected) { connected = true; statusListeners.forEach((s) => s(true)); } });
  es.onopen = () => { connected = true; statusListeners.forEach((s) => s(true)); };
  es.onerror = () => { connected = false; statusListeners.forEach((s) => s(false)); };
}
export function useLive(fn: Listener) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => { ensureStream(); const l = () => ref.current(); listeners.add(l); return () => { listeners.delete(l); }; }, []);
}
export function useLiveStatus() {
  const [ok, setOk] = useState(true);
  useEffect(() => { ensureStream(); statusListeners.add(setOk); return () => { statusListeners.delete(setOk); }; }, []);
  return ok;
}

export function useApi<T>(url: string | null, opts: { live?: boolean; interval?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const n = ++seq.current;
    try { const d = await api<T>(url); if (n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (n === seq.current) setError(e as ApiError); }
    finally { if (n === seq.current) setLoading(false); }
  }, [url]);
  useEffect(() => { setLoading(!!url); setData(null); void load(); }, [load, url]);
  useLive(() => { if (opts.live) void load(); });
  useEffect(() => { if (!opts.interval) return; const t = setInterval(load, opts.interval); return () => clearInterval(t); }, [load, opts.interval]);
  return { data, error, loading, reload: load, setData };
}

/** Ticking clock for live timers (one interval per component). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

const TZ = "Africa/Johannesburg";
const fTime = new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const fDate = new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, day: "numeric", month: "short" });
const fDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const time = (d?: string | Date | null) => (d ? fTime.format(new Date(d)) : "—");
export const dateTime = (d?: string | Date | null) => {
  if (!d) return "—";
  const x = new Date(d);
  return fDay.format(x) === fDay.format(new Date()) ? `${fTime.format(x)}` : `${fDate.format(x)} ${fTime.format(x)}`;
};
export function duration(sec: number | null | undefined, short = false) {
  if (sec == null || !isFinite(sec)) return "—";
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return short ? `${m}m` : `${m}m ${String(ss).padStart(2, "0")}s`;
}
/** Convert an ISO instant to a value for <input type="datetime-local"> in SAST, and back. */
export function toLocalInput(iso?: string | null) {
  if (!iso) return "";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}
export function fromLocalInput(v: string) { return v ? new Date(`${v}:00+02:00`).toISOString() : null; } // SAST has no DST
export const humanize = (s?: string | null) => (s ? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");
