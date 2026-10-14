export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(',');

export const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

/**
 * UUID shape (any version 1-8, RFC 4122 variant), LOWER CASE only. Ids are compared byte for byte (maps, SQLite), so
 * an upper-case copy of an id would otherwise be a different row: the same money posted twice. Clients generate v4.
 */
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);

/** Highest customer code a pushed customer may carry. */
export const MAX_CUSTOMER_CODE = 1_000_000_000;
/**
 * Highest max_local_code accepted by /pair and /devices/code-block. Far below MAX_CUSTOMER_CODE, so no device can
 * push the shop's code sequence to where blocks are unusable (it only ever grows by CODE_BLOCK_SIZE per block).
 */
export const MAX_LOCAL_CODE = 1_000_000;

export const isSafePositiveInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max;

/** Optional non-negative integer (max_local_code). */
export function optionalCode(v: unknown): number | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > MAX_LOCAL_CODE) return 'invalid';
  return v;
}
