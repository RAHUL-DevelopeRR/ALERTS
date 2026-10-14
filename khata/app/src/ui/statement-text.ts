/**
 * Pure builders for the text a shopkeeper sends: the WhatsApp statement, the one-line WhatsApp reminder and the
 * one-line SMS. No DOM, no I/O; unit-tested in test/statement-text.test.ts.
 *
 * WhatsApp formatting: *bold*, ~strike~. A reversed entry and its reversal print as ONE "Corrected" line with the
 * old amount struck through, so the customer sees one confusing-free line instead of three.
 */
import type { Lang } from '../../../shared/protocol';
import { formatCode, formatDay, formatINR, upiLink } from '../core/ledger';
import type { EntryView, Statement } from '../data/types';
import { tl, type MsgKey } from '../i18n';

export interface TextOpts {
  shopName: string;
  upiId: string | null;
  lang: Lang;
  /** 'YYYY-MM-DD' the balance is stated "as of" (today IST). */
  asOf: string;
}

const KIND_KEY: Record<EntryView['kind'], MsgKey> = {
  GIVE: 'kind.GIVE',
  RECEIVE: 'kind.RECEIVE',
  WRITEOFF: 'kind.WRITEOFF',
  REVERSAL: 'kind.REVERSAL',
};
const MODE_KEY = { CASH: 'mode.CASH', UPI: 'mode.UPI', OTHER: 'mode.OTHER' } as const;

/** One statement line for an entry, or null when it is folded into another line (a reversal of a shown entry). */
export function entryLine(e: EntryView, shownIds: ReadonlySet<string>, lang: Lang): string | null {
  const date = formatDay(e.biz_date, lang, true);
  const amt = formatINR(e.amount_paise);
  if (e.kind === 'REVERSAL') {
    if (e.reverses_entry_id && shownIds.has(e.reverses_entry_id)) return null;
    // Original outside the period (cannot normally happen: a reversal carries the original's date).
    return `${date} · ${tl(lang, 'kind.REVERSAL')} ${e.delta_paise < 0 ? '−' : '+'}${amt}`;
  }
  if (e.is_reversed) {
    return `${date} · ${tl(lang, 'kind.corrected')} ~${tl(lang, KIND_KEY[e.kind])} ${amt}~`;
  }
  const extra: string[] = [];
  if (e.kind === 'RECEIVE' && e.mode) extra.push(tl(lang, MODE_KEY[e.mode]));
  if (e.note) extra.push(e.note);
  return [`${date} · ${tl(lang, KIND_KEY[e.kind])} ${amt}`, ...extra].join(' · ');
}

/** "Balance due ₹X as of 14 Oct 2026" / advance / settled, in `lang`. */
export function closingLine(balancePaise: number, asOf: string, lang: Lang): string {
  const date = formatDay(asOf, lang);
  if (balancePaise > 0) return tl(lang, 'stx.closingDue', { amount: formatINR(balancePaise), date });
  if (balancePaise < 0) return tl(lang, 'stx.closingAdvance', { amount: formatINR(-balancePaise), date });
  return tl(lang, 'stx.closingSettled', { date });
}

function openingLine(paise: number, lang: Lang): string {
  if (paise < 0) return `${tl(lang, 'stx.opening')}: ${tl(lang, 'bal.advance')} ${formatINR(-paise)}`;
  return `${tl(lang, 'stx.opening')}: ${formatINR(paise)}`;
}

/** Full WhatsApp statement (compact, one line per entry). */
export function statementText(st: Statement, o: TextOpts): string {
  const { lang } = o;
  const c = st.customer;
  const lines: string[] = [];
  if (o.shopName.trim()) lines.push(`*${o.shopName.trim()}*`);
  lines.push(`${tl(lang, 'stx.header')}: *${c.name}* (${formatCode(c.code)})`);
  lines.push(tl(lang, 'stx.period', { from: formatDay(st.from, lang), to: formatDay(st.to, lang) }));
  lines.push(openingLine(st.opening_paise, lang));
  lines.push('');
  const shown = new Set(st.rows.filter((r) => r.kind !== 'REVERSAL').map((r) => r.id));
  let any = false;
  for (const r of st.rows) {
    const l = entryLine(r, shown, lang);
    if (l !== null) {
      lines.push(l);
      any = true;
    }
  }
  if (!any) lines.push(tl(lang, 'stx.noEntries'));
  lines.push('');
  lines.push(`*${closingLine(st.closing_paise, o.asOf, lang)}*`);
  const upi = o.upiId?.trim();
  if (upi && st.closing_paise > 0) {
    lines.push(tl(lang, 'stx.payUpi', { id: upi }));
    lines.push(upiLink(upi, o.shopName.trim() || upi, st.closing_paise, `Khata ${formatCode(c.code)}`));
  }
  lines.push(tl(lang, 'stx.thanks'));
  return lines.join('\n');
}

/** One-line WhatsApp reminder for the customer screen (plus the UPI id/link when something is due). */
export function reminderText(
  c: { name: string; code: number },
  balancePaise: number,
  o: TextOpts,
): string {
  const { lang } = o;
  const date = formatDay(o.asOf, lang);
  const shop = o.shopName.trim() || tl(lang, 'app.name');
  let s: string;
  if (balancePaise > 0) s = tl(lang, 'stx.reminder', { shop, name: c.name, amount: formatINR(balancePaise), date });
  else if (balancePaise < 0) s = tl(lang, 'stx.reminderAdvance', { shop, name: c.name, amount: formatINR(-balancePaise), date });
  else s = tl(lang, 'stx.reminderSettled', { shop, name: c.name, date });
  const upi = o.upiId?.trim();
  if (upi && balancePaise > 0) {
    s += `\n${tl(lang, 'stx.payUpi', { id: upi })}\n${upiLink(upi, o.shopName.trim() || upi, balancePaise, `Khata ${formatCode(c.code)}`)}`;
  }
  return s;
}

/** One-line SMS: balance only (Tamil SMS is UCS-2, 70 chars a segment, so keep it short). */
export function smsText(c: { name: string; code: number }, balancePaise: number, o: TextOpts): string {
  const { lang } = o;
  const params = {
    shop: o.shopName.trim() || tl(lang, 'app.name'),
    name: c.name,
    code: formatCode(c.code),
    date: formatDay(o.asOf, lang, true),
    amount: formatINR(Math.abs(balancePaise)),
  };
  if (balancePaise > 0) return tl(lang, 'stx.sms', params);
  if (balancePaise < 0) return tl(lang, 'stx.smsAdvance', params);
  return tl(lang, 'stx.smsSettled', params);
}
