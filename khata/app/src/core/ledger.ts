/**
 * Pure ledger functions: no I/O, no DOM, no SQLite. Unit-tested in test/ledger.test.ts.
 * Money is always integer paise. Business dates are 'YYYY-MM-DD' in Asia/Kolkata.
 */
import type { EntryKind, PayMode } from '../../../shared/protocol';

export const IST_OFFSET_MIN = 330; // India has no DST
const DAY_MS = 86_400_000;
/** ₹1,00,00,00,000 (100 crore) — far above any udhaar, far below 2^53. Server allows 1e12. */
export const MAX_AMOUNT_PAISE = 1_000_000_000_00;

// ------------------------------------------------------------------ ids

/** UUID v4. crypto.randomUUID needs Chrome 92+, so fall back to getRandomValues on older WebViews. */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c!.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ money

/** Tamil digits ௦-௯ (U+0BE6..U+0BEF) and Devanagari ०-९ to ASCII. */
export function asciiDigits(s: string): string {
  return s
    .replace(/[௦-௯]/g, (d) => String(d.charCodeAt(0) - 0x0be6))
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

/**
 * Parse a typed rupee amount into integer paise. Accepts "250", "1,250", "12.5", "12.29", "₹ 1,23,456.50",
 * Tamil digits. Rejects blanks, signs, a third decimal, letters, zero and amounts above MAX_AMOUNT_PAISE.
 * Never uses parseFloat(s) * 100 (12.29 * 100 = 1228.9999...).
 */
export function toPaise(input: string): number {
  const s = asciiDigits(String(input)).replace(/[₹\s,]/g, '');
  const m = /^(\d{1,10})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) throw new Error('BAD_AMOUNT');
  const paise = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(paise) || paise <= 0 || paise > MAX_AMOUNT_PAISE) throw new Error('BAD_AMOUNT');
  return paise;
}

/** Indian digit grouping of a non-negative integer string: 1234567 -> "12,34,567". */
function groupIN(intDigits: string): string {
  if (intDigits.length <= 3) return intDigits;
  const last3 = intDigits.slice(-3);
  let rest = intDigits.slice(0, -3);
  const parts: string[] = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) parts.unshift(rest);
  return `${parts.join(',')},${last3}`;
}

/**
 * "₹1,23,456.50"; whole rupees drop ".00" ("₹250"). `signed` prefixes "−" for negatives (else absolute value).
 * Implemented without Intl so output is identical on every WebView.
 */
export function formatINR(paise: number, opts: { symbol?: boolean; signed?: boolean; decimals?: 'auto' | 'always' } = {}): string {
  const { symbol = true, signed = false, decimals = 'auto' } = opts;
  const neg = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const frac = decimals === 'always' || p !== 0 ? `.${String(p).padStart(2, '0')}` : '';
  return `${signed && neg ? '−' : ''}${symbol ? '₹' : ''}${groupIN(String(rupees))}${frac}`;
}

/** Live formatting of a partially typed amount string for the keypad display ("12345.5" -> "12,345.5"). */
export function formatTyping(raw: string): string {
  const [i, f] = raw.split('.');
  const g = groupIN((i || '0').replace(/^0+(?=\d)/, ''));
  return f !== undefined ? `${g}.${f}` : g;
}

const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function en99(n: number): string {
  if (n < 20) return EN_ONES[n];
  return EN_TENS[Math.floor(n / 10)] + (n % 10 ? `-${EN_ONES[n % 10]}` : '');
}
function en999(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${EN_ONES[h]} hundred` : '', r ? en99(r) : ''].filter(Boolean).join(' ');
}

/**
 * Amount in words using the Indian (lakh/crore) system, as a fat-finger check beside the typed digits.
 * en: "One lakh twenty-three thousand four hundred fifty-six rupees and fifty paise".
 * ta: unit words with digits, which reads unambiguously: "1 இலட்சம் 23 ஆயிரம் 456 ரூபாய் 50 பைசா".
 */
export function amountInWords(paise: number, lang: 'en' | 'ta'): string {
  const abs = Math.abs(Math.trunc(paise));
  let r = Math.floor(abs / 100);
  const p = abs % 100;
  const crore = Math.floor(r / 1_00_00_000); r %= 1_00_00_000;
  const lakh = Math.floor(r / 1_00_000); r %= 1_00_000;
  const thousand = Math.floor(r / 1000); r %= 1000;
  const rest = r;
  if (lang === 'ta') {
    const parts: string[] = [];
    if (crore) parts.push(`${crore} கோடி`);
    if (lakh) parts.push(`${lakh} இலட்சம்`);
    if (thousand) parts.push(`${thousand} ஆயிரம்`);
    if (rest || parts.length === 0) parts.push(`${rest}`);
    let out = `${parts.join(' ')} ரூபாய்`;
    if (p) out += ` ${p} பைசா`;
    return out;
  }
  const parts: string[] = [];
  if (crore) parts.push(`${crore >= 1000 ? String(crore) : en999(crore)} crore`);
  if (lakh) parts.push(`${en99(lakh)} lakh`);
  if (thousand) parts.push(`${en99(thousand)} thousand`);
  if (rest) parts.push(en999(rest));
  let out = parts.length ? parts.join(' ') : 'zero';
  out += Math.floor(abs / 100) === 1 ? ' rupee' : ' rupees';
  if (p) out += ` and ${en99(p)} paise`;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// ------------------------------------------------------------------ dates (IST)

/** 'YYYY-MM-DD' of the instant `d` in Asia/Kolkata (UTC+05:30, no DST). */
export function bizDateIST(d: Date = new Date()): string {
  const t = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  return t.toISOString().slice(0, 10);
}

/** Today in IST, corrected by a known server clock offset (server_time - device time, ms). */
export function todayIST(clockOffsetMs = 0): string {
  return bizDateIST(new Date(Date.now() + clockOffsetMs));
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date 'YYYY-MM-DD'. */
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** UTC ISO instants of 00:00 and 24:00 IST for an IST day: created_at window for "entered today". */
export function istDayBoundsUTC(day: string): { start: string; end: string } {
  const start = Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MIN * 60_000;
  return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_TA = ['ஜன', 'பிப்', 'மார்', 'ஏப்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆக', 'செப்', 'அக்', 'நவ', 'டிச'];

/** "12 Oct 2026" / "12 அக் 2026"; `short` drops the year. */
export function formatDay(day: string, lang: 'en' | 'ta', short = false): string {
  const [y, m, d] = day.split('-').map(Number);
  const mon = (lang === 'ta' ? MONTHS_TA : MONTHS_EN)[m - 1];
  return short ? `${d} ${mon}` : `${d} ${mon} ${y}`;
}

/** Local IST time "09:41" of an ISO instant. */
export function formatTimeIST(iso: string): string {
  const t = new Date(Date.parse(iso) + IST_OFFSET_MIN * 60_000);
  return t.toISOString().slice(11, 16);
}

// ------------------------------------------------------------------ entries

export interface EntryDraft {
  id: string;
  customer_id: string;
  kind: EntryKind;
  amount_paise: number;
  delta_paise: number;
  biz_date: string;
  note: string | null;
  mode: PayMode | null;
  reverses_entry_id: string | null;
  device_id: string;
  created_at: string;
}

/** Build a GIVE / RECEIVE / WRITEOFF. Throws BAD_AMOUNT, BAD_DATE, FUTURE_DATE. */
export function makeEntry(p: {
  customer_id: string;
  kind: 'GIVE' | 'RECEIVE' | 'WRITEOFF';
  amount_paise: number;
  biz_date?: string;
  note?: string | null;
  mode?: PayMode | null;
  device_id: string;
  today?: string;
  now?: Date;
}): EntryDraft {
  if (!Number.isSafeInteger(p.amount_paise) || p.amount_paise <= 0 || p.amount_paise > MAX_AMOUNT_PAISE) {
    throw new Error('BAD_AMOUNT');
  }
  const today = p.today ?? todayIST();
  const biz = p.biz_date ?? today;
  if (!isValidDate(biz)) throw new Error('BAD_DATE');
  if (biz > today) throw new Error('FUTURE_DATE');
  const note = p.note?.trim() ? p.note.trim().slice(0, 200) : null;
  return {
    id: uuid(),
    customer_id: p.customer_id,
    kind: p.kind,
    amount_paise: p.amount_paise,
    delta_paise: p.kind === 'GIVE' ? p.amount_paise : -p.amount_paise,
    biz_date: biz,
    note,
    mode: p.kind === 'RECEIVE' ? (p.mode ?? null) : null,
    reverses_entry_id: null,
    device_id: p.device_id,
    created_at: (p.now ?? new Date()).toISOString(),
  };
}

/**
 * Build the REVERSAL of `orig`: same customer, amount, biz_date and mode, delta = -orig.delta, so both halves
 * land in the same day book, statement period and Cash/UPI column. created_at is "now" (audit order).
 */
export function makeReversal(
  orig: Pick<EntryDraft, 'id' | 'customer_id' | 'kind' | 'amount_paise' | 'delta_paise' | 'biz_date' | 'mode'>,
  device_id: string,
  note?: string | null,
  now: Date = new Date(),
): EntryDraft {
  if (orig.kind === 'REVERSAL') throw new Error('CANNOT_REVERSE_REVERSAL');
  return {
    id: uuid(),
    customer_id: orig.customer_id,
    kind: 'REVERSAL',
    amount_paise: orig.amount_paise,
    delta_paise: -orig.delta_paise,
    biz_date: orig.biz_date,
    note: note?.trim() ? note.trim().slice(0, 200) : null,
    mode: orig.mode ?? null,
    reverses_entry_id: orig.id,
    device_id,
    created_at: now.toISOString(),
  };
}

/** Plain balance of a list of rows (callers pass only counted, i.e. non-rejected, rows). */
export function sumDelta(rows: { delta_paise: number }[]): number {
  return rows.reduce((s, r) => s + r.delta_paise, 0);
}

/**
 * Default statement period. Rows must be counted rows sorted (biz_date, created_at, id).
 * - Balance non-zero now: from the first row after the last point where the running balance was 0.
 * - Balance zero now ("settled"): from the row after the PREVIOUS zero through the settling row, so a
 *   just-settled customer gets a receipt instead of an empty statement.
 * Returns biz_date bounds (inclusive). With no rows: today..today.
 */
export function defaultPeriod(
  rows: { biz_date: string; delta_paise: number }[],
  today: string,
): { from: string; to: string; kind: 'since_zero' | 'settled' } {
  if (rows.length === 0) return { from: today, to: today, kind: 'since_zero' };
  const zeros: number[] = []; // indexes i where running balance after row i is 0
  let run = 0;
  rows.forEach((r, i) => {
    run += r.delta_paise;
    if (run === 0) zeros.push(i);
  });
  if (run !== 0) {
    const last = zeros.length ? zeros[zeros.length - 1] : -1;
    return { from: rows[last + 1].biz_date, to: today, kind: 'since_zero' };
  }
  const settle = zeros[zeros.length - 1];
  const prev = zeros.length > 1 ? zeros[zeros.length - 2] : -1;
  return { from: rows[prev + 1].biz_date, to: rows[settle].biz_date, kind: 'settled' };
}

// ------------------------------------------------------------------ customers

/** "C-0042". */
export function formatCode(code: number): string {
  return `C-${String(code).padStart(4, '0')}`;
}

/** Case/space-insensitive name key for same-name detection. */
export function normName(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Clean a display name: collapse whitespace, trim, max 100 chars. Throws BAD_NAME if empty. */
export function cleanName(name: string): string {
  const n = name.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!n) throw new Error('BAD_NAME');
  return n;
}

/**
 * Normalise an Indian (default) or international phone number to E.164. Returns null for blank input,
 * throws BAD_PHONE for anything that is not a plausible number.
 *  "98765 43210", "098765-43210", "+91 98765 43210", "919876543210" -> "+919876543210"
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (input == null) return null;
  const raw = asciiDigits(input).trim();
  if (!raw) return null;
  const plus = raw.startsWith('+') || raw.startsWith('00');
  let d = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) d = d.slice(2);
  if (plus) {
    if (d.length < 8 || d.length > 15) throw new Error('BAD_PHONE');
    if (d.startsWith('91') && !/^91[6-9]\d{9}$/.test(d)) throw new Error('BAD_PHONE');
    return `+${d}`;
  }
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (/^[6-9]\d{9}$/.test(d)) return `+91${d}`;
  throw new Error('BAD_PHONE');
}

/** "+919876543210" -> "98765 43210" for display (other countries unchanged). */
export function formatPhone(e164: string | null): string {
  if (!e164) return '';
  const m = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return m ? `${m[1]} ${m[2]}` : e164;
}

// Minimal Tamil -> Latin transliteration so "முருகன்" is also found by typing "murugan".
const TA_VOWELS: Record<string, string> = {
  'அ': 'a', 'ஆ': 'aa', 'இ': 'i', 'ஈ': 'ee', 'உ': 'u', 'ஊ': 'oo', 'எ': 'e', 'ஏ': 'e', 'ஐ': 'ai',
  'ஒ': 'o', 'ஓ': 'o', 'ஔ': 'au', 'ஃ': 'h',
};
const TA_SIGNS: Record<string, string> = {
  'ா': 'aa', 'ி': 'i', 'ீ': 'ee', 'ு': 'u', 'ூ': 'oo', 'ெ': 'e', 'ே': 'e', 'ை': 'ai', 'ொ': 'o', 'ோ': 'o', 'ௌ': 'au',
};
const TA_CONS: Record<string, string> = {
  'க': 'k', 'ங': 'ng', 'ச': 's', 'ஞ': 'nj', 'ட': 't', 'ண': 'n', 'த': 'th', 'ந': 'n', 'ப': 'p', 'ம': 'm',
  'ய': 'y', 'ர': 'r', 'ல': 'l', 'வ': 'v', 'ழ': 'zh', 'ள': 'l', 'ற': 'r', 'ன': 'n', 'ஜ': 'j', 'ஷ': 'sh',
  'ஸ': 's', 'ஹ': 'h', 'ஶ': 'sh',
};
const PULLI = '்';

/** Rough phonetic Latin spelling of Tamil text (other characters pass through, lower-cased). */
export function transliterateTamil(s: string): string {
  let out = '';
  const chars = Array.from(s.normalize('NFC'));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (TA_CONS[ch] !== undefined) {
      const next = chars[i + 1];
      if (next === PULLI) { out += TA_CONS[ch]; i++; }
      else if (next && TA_SIGNS[next] !== undefined) { out += TA_CONS[ch] + TA_SIGNS[next]; i++; }
      else out += `${TA_CONS[ch]}a`;
    } else if (TA_VOWELS[ch] !== undefined) out += TA_VOWELS[ch];
    else out += ch.toLowerCase();
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function hasTamil(s: string): boolean {
  return /[஀-௿]/.test(s);
}

/**
 * Fold Latin spellings so Tamil names typed in English match their transliteration:
 * "murugan" / "murukan" -> "murukan", "senthil" / "sendhil" -> "sentil", "lakshmi" / "latchumi" share most of it.
 */
export function phoneticFold(s: string): string {
  return s
    .toLowerCase()
    .replace(/zh/g, 'l').replace(/sh|ch|j|z/g, 's').replace(/th|dh/g, 't')
    .replace(/g/g, 'k').replace(/d/g, 't').replace(/b/g, 'p').replace(/w/g, 'v').replace(/f/g, 'p').replace(/q/g, 'k')
    .replace(/aa/g, 'a').replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Search key: lower-case text containing the name, its transliteration, search_name, code (both
 * "c-0042" and "42"), phone digits and note, plus a phonetically folded copy of the Latin parts.
 * Every whitespace-separated query token must be a substring of the key (raw or folded).
 */
export function searchKey(c: { name: string; search_name: string | null; code: number; phone: string | null; note: string | null }): string {
  const parts = [c.name, c.search_name ?? '', formatCode(c.code), String(c.code), (c.phone ?? '').replace(/\D/g, ''), c.note ?? ''];
  if (hasTamil(c.name)) parts.push(transliterateTamil(c.name));
  const raw = normName(parts.join(' '));
  return `${raw} | ${phoneticFold(raw.replace(/[\u0B80-\u0BFF]+/g, ' '))}`;
}

export function matchesQuery(key: string, query: string): boolean {
  const q = normName(asciiDigits(query));
  if (!q) return true;
  return q.split(' ').every((t) => {
    if (key.includes(t)) return true;
    const latin = hasTamil(t) ? transliterateTamil(t) : t;
    return key.includes(latin) || key.includes(phoneticFold(latin));
  });
}

// ------------------------------------------------------------------ sharing links

/** WhatsApp click-to-chat. Number: digits only, international, no '+'. No number -> contact picker. */
export function whatsappLink(phoneE164: string | null, text: string): string {
  const num = phoneE164 ? phoneE164.replace(/\D/g, '') : '';
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}

/** smsto: URI understood by Android's ACTION_SENDTO (no SMS permission needed). */
export function smsLink(phoneE164: string | null, body: string): string {
  return `smsto:${phoneE164 ?? ''}?body=${encodeURIComponent(body)}`;
}

export function telLink(phoneE164: string): string {
  return `tel:${phoneE164}`;
}

/** UPI deep link (NPCI linking spec): pa and pn mandatory, cu=INR. */
export function upiLink(vpa: string, payeeName: string, amountPaise: number | null, note?: string): string {
  const params = new URLSearchParams({ pa: vpa, pn: payeeName, cu: 'INR' });
  if (amountPaise && amountPaise > 0) params.set('am', (amountPaise / 100).toFixed(2));
  if (note) params.set('tn', note.slice(0, 50));
  return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
}

/** SMS segment estimate: GSM-7 (160/153) unless any non-GSM char (Tamil, ₹), then UCS-2 (70/67). */
export function smsSegments(text: string): { segments: number; unicode: boolean } {
  const gsm = /^[\n\r A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
  const unicode = !gsm.test(text);
  const len = Array.from(text).length;
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return { segments: len <= single ? 1 : Math.ceil(len / multi), unicode };
}
