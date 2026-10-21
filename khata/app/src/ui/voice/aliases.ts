/**
 * Names learned on this phone: when the shopkeeper picks a customer for a spoken name that was not exactly that
 * customer's ("Raghul" -> Rahul, "Ramu anna" -> Ramu), the spoken form is remembered and matches that customer like
 * the name itself next time (and so may auto-save). Device-local (meta 'voice_aliases'), never synced; newest last,
 * one customer per spoken form (a later pick replaces the earlier one), at most MAX_ALIASES.
 */
import { nameFold } from '../../core/voice';
import { app } from '../app';

export const MAX_ALIASES = 300;
const KEY = 'voice_aliases';

export type Alias = readonly [heard: string, customerId: string];

/** Pure: parse the stored JSON, keeping only well-formed pairs (unit-tested). */
export function parseAliases(json: string | null): Alias[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((p): p is [string, string] => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string' && !!p[0].trim() && !!p[1])
      .slice(-MAX_ALIASES);
  } catch {
    return [];
  }
}

/** Pure: add (or move) heard -> id; the same folded form never maps to two customers. */
export function withAlias(list: readonly Alias[], heard: string, customerId: string): Alias[] {
  const text = heard.replace(/\s+/g, ' ').trim();
  const k = nameFold(text);
  if (!k) return [...list];
  const rest = list.filter(([h]) => nameFold(h) !== k);
  return [...rest, [text, customerId] as const].slice(-MAX_ALIASES);
}

export async function loadAliases(): Promise<Alias[]> {
  try {
    return parseAliases(await app.repo.getMeta(KEY));
  } catch {
    return [];
  }
}

export async function learnAlias(heard: string, customerId: string): Promise<void> {
  const next = withAlias(await loadAliases(), heard, customerId);
  await app.repo.setMeta(KEY, JSON.stringify(next));
}

export async function forgetAliases(): Promise<void> {
  await app.repo.setMeta(KEY, null);
}
