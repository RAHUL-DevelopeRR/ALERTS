/** Time helpers. All stored timestamps are Date#toISOString() strings, so they compare lexically. */

export const iso = (d: Date): string => d.toISOString();

export const addMs = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

export const addMinutes = (d: Date, minutes: number): Date => addMs(d, minutes * 60_000);

/** UTC calendar day, YYYY-MM-DD (request counters and pair throttle reset at 00:00 UTC). */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

const IST_OFFSET_MS = 330 * 60_000; // Asia/Kolkata is UTC+05:30, no DST

/** Business date in Asia/Kolkata, YYYY-MM-DD. */
export const istDate = (d: Date): string => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isRealDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** ISO-8601 timestamp with an explicit zone (Z or +hh:mm). */
export function isIsoTimestamp(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
}
