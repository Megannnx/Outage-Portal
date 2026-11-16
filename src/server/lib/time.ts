import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";

export const DISPLAY_TZ = process.env.DISPLAY_TIMEZONE ?? "Africa/Johannesburg";

export function inTz(d: Date | string | number): TZDate {
  return new TZDate(new Date(d).getTime(), DISPLAY_TZ);
}
/** 16 Nov 2026 14:05 */
export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return format(inTz(d), "d MMM yyyy HH:mm");
}
/** 14:05 */
export function fmtTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return format(inTz(d), "HH:mm");
}
/** 14:05 today / 14:05 on 17 Nov 2026 — used for ETAs in customer wording. */
export function fmtCustomerTime(d: Date, now: Date): string {
  const a = inTz(d), b = inTz(now);
  const sameDay = format(a, "yyyy-MM-dd") === format(b, "yyyy-MM-dd");
  return sameDay ? `${format(a, "HH:mm")} today` : `${format(a, "HH:mm")} on ${format(a, "EEEE d MMMM")}`;
}
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
/** Build a Date from a wall-clock time in the display time zone. */
export function zonedWallTime(base: Date, hours: number, minutes: number, dayOffset = 0): Date {
  const b = inTz(base);
  const t = new TZDate(b.getFullYear(), b.getMonth(), b.getDate() + dayOffset, hours, minutes, 0, DISPLAY_TZ);
  return new Date(t.getTime());
}
export function isBusinessHours(d: Date, startHour = 7, endHour = 18): boolean {
  const t = inTz(d);
  const day = t.getDay();
  const h = t.getHours();
  return day >= 1 && day <= 5 && h >= startHour && h < endHour;
}
