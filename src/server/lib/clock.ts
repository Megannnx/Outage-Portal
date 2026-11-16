/**
 * Time source. Production uses the wall clock; tests swap in a controllable clock
 * so the 3-minute and 2-hour rules can be exercised deterministically.
 */
let current: () => Date = () => new Date();
export const clock = {
  now: (): Date => current(),
  set(fn: () => Date) { current = fn; },
  reset() { current = () => new Date(); },
};
export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
export const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;
