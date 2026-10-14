export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');

export const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

/** UUID shape (any version 1-8, RFC 4122 variant), case-insensitive. Clients generate v4. */
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

export const isSafePositiveInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;

/** Optional non-negative integer (max_local_code). */
export function optionalCode(v: unknown): number | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 1_000_000_000) return 'invalid';
  return v;
}
