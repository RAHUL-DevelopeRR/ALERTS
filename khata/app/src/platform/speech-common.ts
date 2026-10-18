/** Small helpers shared by the Speech implementations (native, web, fake). Pure, no DOM. */

export const DEFAULT_MAX_ALTERNATIVES = 5;
/** Safety cap on one listening session when the caller passes no maxMs. */
export const DEFAULT_MAX_LISTEN_MS = 15_000;

/** 1..5, default 5. */
export function clampAlternatives(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_MAX_ALTERNATIVES;
  return Math.min(DEFAULT_MAX_ALTERNATIVES, Math.max(1, Math.floor(n)));
}

export function listenTimeout(ms: number | undefined): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_MAX_LISTEN_MS;
}

/** Trim, collapse whitespace, drop empties and duplicates, keep order (best first), cap at `max`. */
export function cleanAlternatives(list: readonly unknown[] | null | undefined, max: number): string[] {
  const out: string[] = [];
  if (!list) return out;
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function speechError(code: string): Error {
  return new Error(`SPEECH_ERROR:${code}`);
}

/** Call a user callback without letting it break the recogniser plumbing. */
export function safeCall(cb: ((text: string) => void) | undefined, text: string): void {
  if (!cb) return;
  try {
    cb(text);
  } catch (e) {
    console.error('[speech] onPartial failed', e);
  }
}
