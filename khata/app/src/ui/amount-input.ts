/**
 * Keypad typing rules for amounts (pure). The typed string is parsed by toPaise() on save; this only keeps the
 * string well-formed while typing: digits, one '.', at most 2 decimals, at most 9 rupee digits, no leading zeros.
 */
import { toPaise } from '../core/ledger';

export const MAX_INT_DIGITS = 9;

export function applyKey(raw: string, key: string): string {
  if (key === 'back') return raw.slice(0, -1);
  if (key === 'clear') return '';
  if (key === '.') {
    if (raw.includes('.')) return raw;
    return raw === '' ? '0.' : `${raw}.`;
  }
  if (!/^\d$/.test(key)) return raw;
  const [i, f] = raw.split('.');
  if (f !== undefined) return f.length >= 2 ? raw : raw + key;
  if (i === '0') return key; // replace a lone leading zero
  if (i.length >= MAX_INT_DIGITS) return raw;
  return raw + key;
}

/** Paise for the typed string, or null when it is not a valid positive amount yet. */
export function typedPaise(raw: string): number | null {
  if (!raw) return null;
  try {
    return toPaise(raw);
  } catch {
    return null;
  }
}

/** Paise to the keypad string ("1500.5" style) for prefilling. */
export function paiseToTyped(paise: number): string {
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return p ? `${r}.${String(p).padStart(2, '0')}` : String(r);
}
