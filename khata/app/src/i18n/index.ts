/**
 * Tiny i18n: t(key, params) in the current app language, tl(lang, key, params) in a given one
 * (statement text can be sent in the other language). Placeholders: {name}.
 */
import type { Lang } from '../../../shared/protocol';
import { en, type MsgKey } from './en';
import { ta } from './ta';

export type { MsgKey } from './en';
export type Params = Record<string, string | number>;

const DICTS: Record<Lang, Record<MsgKey, string>> = { en, ta };
let current: Lang = 'ta';
const listeners = new Set<(l: Lang) => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  const next: Lang = lang === 'en' ? 'en' : 'ta';
  if (next === current) return;
  current = next;
  document.documentElement.lang = next;
  for (const l of listeners) l(next);
}

export function onLangChange(cb: (l: Lang) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Fill {placeholders}. Unknown placeholders are left as they are (visible in review, never crash). */
export function fill(s: string, params?: Params): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function tl(lang: Lang, key: MsgKey, params?: Params): string {
  const d = DICTS[lang] ?? en;
  return fill(d[key] ?? en[key] ?? key, params);
}

export function t(key: MsgKey, params?: Params): string {
  return tl(current, key, params);
}

/** True if `key` exists (used when mapping dynamic error codes). */
export function hasKey(key: string): key is MsgKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}
