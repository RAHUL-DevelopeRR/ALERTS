/** UI formatting helpers shared by screens (money tone, entry labels, relative times). */
import { formatDay, formatINR, formatTimeIST, todayIST, bizDateIST } from '../core/ledger';
import type { EntryKind, PayMode } from '../data/types';
import { getLang, t } from '../i18n';

export function toneClass(paise: number): 'owes' | 'adv' | 'zero' {
  return paise > 0 ? 'owes' : paise < 0 ? 'adv' : 'zero';
}

export function money(paise: number): string {
  return formatINR(Math.abs(paise));
}

/** "₹1,250" owes / "Advance ₹200" / "Settled". */
export function balanceLabel(paise: number): string {
  if (paise > 0) return t('bal.owes');
  if (paise < 0) return t('bal.advance');
  return t('bal.settled');
}

export function kindLabel(k: EntryKind): string {
  return t(`kind.${k}` as const);
}

export function modeLabel(m: PayMode | null): string {
  return m ? t(`mode.${m}` as const) : '';
}

export function day(d: string, short = true): string {
  return formatDay(d, getLang(), short);
}

/** Today (IST) corrected with the server clock offset when known. */
export function today(offsetMs = 0): string {
  return todayIST(offsetMs);
}

/** "09:41" today, "12 Oct 09:41" on another day, for an ISO instant. */
export function when(iso: string | null): string {
  if (!iso) return t('common.never');
  const d = bizDateIST(new Date(iso));
  const time = formatTimeIST(iso);
  return d === todayIST() ? time : `${formatDay(d, getLang(), true)} ${time}`;
}

/** Signed amount for an entry row: "+₹250" gave (customer owes more), "−₹100" got. */
export function signedDelta(delta: number): string {
  return `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${formatINR(Math.abs(delta))}`;
}
