/**
 * Voice entry preferences and the local accuracy counters, both JSON in the `meta` table (keys voice_prefs and
 * voice_stats, this phone only: never synced, never in a backup file). Prefs are cached in memory after the
 * first load so screens can read them synchronously; every save updates the cache too.
 */
import type { SpeechLang } from '../../platform/types';
import { app } from '../app';

export interface VoicePrefs {
  /** Mic buttons shown (default on). */
  on: boolean;
  /** Recogniser language (default Tamil). */
  lang: SpeechLang;
  /** What a bare "<name> <amount> kuduthaachu" means in this shop (default: the customer paid). */
  bare: 'RECEIVE' | 'GIVE';
  /** The privacy notice (audio goes to Google) was shown and accepted on the first mic tap. */
  notice_ok: boolean;
}

export interface VoiceStats {
  /** Listening sessions that returned at least one alternative. */
  heard: number;
  /** Entries saved from a voice prefill. */
  saved: number;
  /** ... of which the amount was changed before Save. */
  amount_edited: number;
  /** ... of which Debit/Credit was flipped before Save (a prefilled direction only). */
  kind_changed: number;
  /** Voice prefills left without saving. */
  cancelled: number;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = { on: true, lang: 'ta-IN', bare: 'RECEIVE', notice_ok: false };
export const EMPTY_VOICE_STATS: VoiceStats = { heard: 0, saved: 0, amount_edited: 0, kind_changed: 0, cancelled: 0 };

let cached: VoicePrefs | null = null;

/** Parse a stored prefs JSON; anything odd falls back to the defaults field by field. */
export function parseVoicePrefs(json: string | null): VoicePrefs {
  const out = { ...DEFAULT_VOICE_PREFS };
  if (!json) return out;
  try {
    const o = JSON.parse(json) as Partial<Record<keyof VoicePrefs, unknown>>;
    if (typeof o.on === 'boolean') out.on = o.on;
    if (o.lang === 'ta-IN' || o.lang === 'en-IN') out.lang = o.lang;
    if (o.bare === 'RECEIVE' || o.bare === 'GIVE') out.bare = o.bare;
    if (typeof o.notice_ok === 'boolean') out.notice_ok = o.notice_ok;
  } catch {
    /* defaults */
  }
  return out;
}

export function parseVoiceStats(json: string | null): VoiceStats {
  const out = { ...EMPTY_VOICE_STATS };
  if (!json) return out;
  try {
    const o = JSON.parse(json) as Partial<Record<keyof VoiceStats, unknown>>;
    for (const k of Object.keys(out) as (keyof VoiceStats)[]) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
    }
  } catch {
    /* defaults */
  }
  return out;
}

export async function loadVoicePrefs(): Promise<VoicePrefs> {
  if (cached) return cached;
  let json: string | null = null;
  try {
    json = await app.repo.getMeta('voice_prefs');
  } catch (e) {
    console.warn('[voice] prefs read failed', e);
  }
  cached = parseVoicePrefs(json);
  return cached;
}

/** The cached prefs (defaults until loadVoicePrefs() ran once). */
export function voicePrefs(): VoicePrefs {
  return cached ?? DEFAULT_VOICE_PREFS;
}

export async function saveVoicePrefs(patch: Partial<VoicePrefs>): Promise<VoicePrefs> {
  const next = { ...(await loadVoicePrefs()), ...patch };
  await app.repo.setMeta('voice_prefs', JSON.stringify(next));
  cached = next;
  return next;
}

export async function loadVoiceStats(): Promise<VoiceStats> {
  try {
    return parseVoiceStats(await app.repo.getMeta('voice_stats'));
  } catch (e) {
    console.warn('[voice] stats read failed', e);
    return { ...EMPTY_VOICE_STATS };
  }
}

/** Add to one or more counters. Best effort: a failure is logged, never shown (the ledger write already happened). */
export async function bumpVoiceStats(patch: Partial<VoiceStats>): Promise<void> {
  try {
    const cur = await loadVoiceStats();
    for (const [k, v] of Object.entries(patch) as [keyof VoiceStats, number | undefined][]) {
      if (typeof v === 'number') cur[k] += v;
    }
    await app.repo.setMeta('voice_stats', JSON.stringify(cur));
  } catch (e) {
    console.warn('[voice] stats write failed', e);
  }
}

export async function resetVoiceStats(): Promise<void> {
  await app.repo.setMeta('voice_stats', null);
}

/** Tests only. */
export function _resetVoicePrefsCache(): void {
  cached = null;
}
