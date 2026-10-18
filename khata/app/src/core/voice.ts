/**
 * Voice entry parser: Tamil / Tanglish / English shop speech -> ledger intents. Pure: no I/O, no DOM.
 *
 * Input is what a speech recogniser returned (up to 5 alternatives). Output is one VoiceIntent per spoken entry
 * ("Ramu 100, Sita 50" -> 2): who (customer matches), how much (paise) and which way (GIVE = Debit / பற்று,
 * RECEIVE = Credit / வரவு). The parser only suggests: money is never saved without the shopkeeper tapping Save
 * on a visible confirmation, and `kind: null` means the UI must ask.
 *
 * Pipeline (see docs/VOICE_ACCOUNTS_SYNC_PLAN.md section 2):
 *  1. tokenise with character offsets (NFC, Tamil digits -> ASCII, "1,500" kept whole, "100ரூபாய்" split);
 *  2. fold every word with transliterateTamil + phoneticFold so Tamil script and Tanglish share one lexicon
 *     (English words are looked up raw first: "fifty" would fold to "pipty");
 *  3. tag tokens (number, direction cue, item, quantity unit, stop word, name ...), merge number words into
 *     number runs, split the utterance into entries;
 *  4. per entry: pick the amount, resolve the direction from cues (+ dative on the name, + shop setting),
 *     score customers, compute confidence;
 *  5. score every alternative, keep the best, and blank the direction when close alternatives disagree on it
 *     (or when it rests only on a dative suffix that another alternative did not hear); when alternatives
 *     disagree on the amount, list the other values in `amount_alternatives` and cap confidence at 'medium'.
 *
 * Direction safety: `confidence: 'high'` needs exactly one clearly best customer (or the page's customer), a
 * parsed amount that no alternative disputes, and an explicit verb or label. A bare "kuduthaachu" (shop
 * setting), a dative-only reading, a fuzzy-matched verb, a mixed vote or an item-only guess never reach 'high'.
 * The app's own labels பற்று / வரவு and 'patru' / 'pattru' / 'varavu' are matched on the raw NFC text, never
 * folded: பற்று folds to 'paru', which is also பாரு / 'paaru' ("look"), a common filler (plan finding 21).
 *
 * LLM seam: a later build may send low-confidence intents to a server interpreter (plan 2.6). That hook belongs
 * in the UI layer (see `needsHelp()` below); this module never does I/O.
 */
import {
  asciiDigits, hasTamil, matchesQuery, MAX_AMOUNT_PAISE, normName, phoneticFold, searchKey, toPaise, transliterateTamil,
} from './ledger';

// ================================================================== public types

export interface VoiceCustomer {
  id: string;
  name: string;
  search_name: string | null;
  code: number;
  phone: string | null;
  note: string | null;
  archived_at?: string | null;
  erased_at?: string | null;
  /** Optional (HomeRow has it). Archived customers are only matched while they still owe or are owed money. */
  balance_paise?: number;
}

export interface VoiceSettings {
  /** Meaning of "<name> <amount> kuduthaachu" without -kku on the name. Default RECEIVE (customer paid). */
  bareKuduthaachu: 'RECEIVE' | 'GIVE';
}

export interface CustomerMatch {
  id: string;
  /** 0..1 */
  score: number;
}

export interface VoiceIntent {
  /** The alternative used. */
  heard: string;
  /** The spoken name as heard (a dative suffix such as -kku / க்கு is removed). */
  name_text: string | null;
  /** Up to 3 best customers, best first; [] if none. Same-name customers come back with equal scores. */
  matches: CustomerMatch[];
  amount_paise: number | null;
  /** null = direction unclear (UI must ask). */
  kind: 'GIVE' | 'RECEIVE' | null;
  /**
   * Why: 'verb:kattinaan', 'bare-kuduthaachu' (shop setting decided it), 'verb:kuduthaachu+dative', 'dative',
   * 'label:debit', 'conflict:alternatives(...)', 'conflict:dative(...)', 'inherited:...', 'negated:...'.
   */
  kind_reason: string | null;
  /** Item words like "arisi", "paal" (and quantities such as "2 kilo"), as heard. */
  note: string | null;
  confidence: 'high' | 'medium' | 'low';
  // ---- optional extras (additive; the UI may ignore them)
  /** Index of the alternative used. */
  alt_index?: number;
  /** The words or digits amount_paise came from, as heard ("ஐநூறு", "1,500", "two fifty"). Set with amount_paise. */
  amount_text?: string;
  /** Other alternatives heard a different amount for this entry (paise, distinct). Confidence is then at most 'medium'. */
  amount_alternatives?: number[];
  /** More than one possible amount was heard (amount_paise is then null); values in paise. */
  amount_candidates?: number[];
  /** "nethu" / yesterday -> -1, "munthaanethu" -> -2, "inniku" / today -> 0. Absent when not said. */
  date_offset?: 0 | -1 | -2;
  /** "gpay", "phonepe", "upi" -> 'UPI'. */
  mode?: 'UPI';
  /** "Ramu baaki evvalavu" / "how much": a balance question, not an entry. */
  balance_query?: boolean;
  /**
   * With opts.contextCustomerId: true when the page's customer was kept (no name spoken, or the spoken name fits
   * it within 0.10 of the best match); false when another customer clearly won or the name does not fit the
   * page's customer at all (matches then lists the candidates and the UI must ask).
   */
  context_kept?: boolean;
}

export interface ParseOptions {
  /**
   * On a customer's own page. A missing name means this customer; a spoken name keeps this customer while it
   * scores within 0.10 of the best match (same-name customers in particular), and other candidates are returned
   * only when one beats it by 0.10 or more or the name does not fit the page's customer at all.
   */
  contextCustomerId?: string;
}

const DEFAULT_SETTINGS: VoiceSettings = { bareKuduthaachu: 'RECEIVE' };

// ================================================================== small helpers

/** Levenshtein distance (iterative, two rows). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function sim(a: string, b: string): number {
  if (!a || !b) return 0;
  const m = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / m;
}

/** Latin phonetic key of one word in either script. */
function foldWord(w: string): string {
  const latin = hasTamil(w) ? transliterateTamil(w) : w.toLowerCase();
  return phoneticFold(latin.replace(/[^\p{L}]/gu, ''));
}

/**
 * Extra folding for names only: "lakshmi"/"laxmi"/லட்சுமி ("latsumi") meet at "laksmi"/"laksumi"; aspirated
 * "kh/ph/bh" lose the h; ஃப ("hp") is "p".
 */
function nameKey(w: string): string {
  return foldWord(w).replace(/x/g, 'ks').replace(/ts/g, 'ks').replace(/hp/g, 'p').replace(/([kptsnmlrv])h/g, '$1');
}

/** Tamil enunciative final -u ("Kumaru" for Kumar) dropped for a secondary comparison. */
function dropU(s: string): string {
  return s.length > 3 ? s.replace(/([^aeiou])u$/, '$1') : s;
}

// ================================================================== lexicon

type CueType =
  | 'verb'        // explicit verb with a direction (kattinaan, vaanginaan, kuduthen, paid, took ...)
  | 'kudu3p'      // customer-as-subject "give" (kuduthaan): RECEIVE, re-read as GIVE when the name has a dative
  | 'bare'        // impersonal kuduthaachu: shop setting, or GIVE with a dative
  | 'imp'         // imperative kudu: GIVE with a dative, else unclear
  | 'gave'        // English gave/given: RECEIVE ("Ramu gave"), GIVE with "to" or "I/we"
  | 'label'       // the app's own words: debit/பற்று -> GIVE, credit/varavu/jama -> RECEIVE
  | 'upi'         // gpay/phonepe/upi: a payment -> RECEIVE, mode UPI
  | 'shop'        // enakku/namakku/kadaikku: the shop is the recipient -> RECEIVE
  | 'noun'        // kadan/udhaar -> GIVE (weak)
  | 'baaki'       // baaki/balance: GIVE but may just be stating the balance (weakest)
  | 'light'       // ezhuthu/podu/vai/add: direction from a noun, else GIVE
  | 'account'     // kanakkula: with a light verb = "write it in his account" -> GIVE
  | 'kitta'       // neutral ("from/with")
  | 'thiruppi'    // "back": supports RECEIVE
  | 'negated';    // kudukkala / vaangala: did not pay/take -> no direction

interface Cue {
  label: string;
  type: CueType;
  dir: 'GIVE' | 'RECEIVE' | null;
  forms: string[];
  /** English forms: looked up raw (lower-case) only, never folded. */
  en?: boolean;
  /**
   * App labels in either script: matched on the raw NFC string only, never folded and never fuzzy. பற்று folds
   * to 'paru', the same as பாரு / 'paaru' ("look"), so the folded form must never become a cue.
   */
  raw?: boolean;
}

const R = 'RECEIVE' as const;
const G = 'GIVE' as const;

/**
 * Direction lexicon. Tamil script and Latin spellings of the same word fold to the same key, so listing both
 * mostly documents what the recogniser produces. Regex fallbacks below cover further conjugations.
 */
export const CUES: Cue[] = [
  // ---- kudu (give), customer as subject -> he paid -> RECEIVE
  { label: 'kuduthaan', type: 'kudu3p', dir: R, forms: [
    'குடுத்தான்', 'கொடுத்தான்', 'குடுத்தாரு', 'கொடுத்தாரு', 'கொடுத்தார்', 'குடுத்தார்', 'குடுத்தாங்க', 'கொடுத்தாங்க',
    'குடுத்தா', 'குடுத்தாள்', 'கொடுத்தாள்', 'குடுத்துட்டான்', 'கொடுத்துட்டான்', 'குடுத்துட்டாரு', 'குடுத்துட்டாங்க',
    'கொடுத்துட்டாங்க', 'குடுத்திட்டான்', 'கொடுத்திருக்கான்', 'குடுத்துருக்கான்', 'குடுத்துட்டா',
    'kuduthaan', 'koduthaan', 'kuduthan', 'kodutan', 'kudutthaan', 'kuduthaaru', 'koduthaaru', 'kuduthaar', 'koduthar',
    'kuduthaanga', 'koduthaanga', 'kuduthanga', 'kuduthaa', 'kuduthaal', 'koduthaal', 'kuduthuttaan', 'kuduthutaan',
    'koduthuttaan', 'kuduthuttaanga', 'koduthuttanga', 'kuduthittaan', 'kuduthurukkaan', 'kuduthirukkaan',
    'kuduthutta', 'kuduthaapla', 'kudthaan', 'kodthaan', 'kudthaanga', 'kodthaanga', 'kudthaaru', 'kodthaaru',
  ] },
  // ---- kattu (pay) -> RECEIVE
  { label: 'kattinaan', type: 'verb', dir: R, forms: [
    'கட்டினான்', 'கட்டுனான்', 'கட்டினாரு', 'கட்டினாங்க', 'கட்டுனாங்க', 'கட்டினா', 'கட்டினாள்', 'கட்டிட்டான்',
    'கட்டிட்டாரு', 'கட்டிட்டாங்க', 'கட்டியாச்சு', 'கட்டிட்டா', 'கட்டிருக்கான்', 'கட்டுனாரு', 'கட்டிட்டேன்',
    'kattinaan', 'kattinan', 'kattunaan', 'kattinaaru', 'kattinaanga', 'kattunanga', 'kattinaa', 'kattinaal',
    'kattittaan', 'kattitaan', 'kattittaaru', 'kattittaanga', 'kattiyaachu', 'kattiyachu', 'kattitta', 'kattirukkaan',
    'kattiyirukkaan', 'kattunaaru',
  ] },
  // tha/tharu (give to the speaker): customer as subject -> paid -> RECEIVE
  { label: 'thanthaan', type: 'verb', dir: R, forms: [
    'தந்தான்', 'தந்தாங்க', 'தந்தாரு', 'தந்தா', 'தந்துட்டான்', 'thanthaan', 'thandhaan', 'thanthaanga', 'thandhaanga',
    'thanthaaru', 'thandhaaru', 'thanthaa', 'thanthuttaan',
  ] },
  { label: 'settle', type: 'verb', dir: R, forms: ['செட்டில்', 'செட்டில்டு', 'settle', 'settil', 'setil', 'settled', 'settlement'] },
  { label: 'vanthuchu', type: 'verb', dir: R, forms: [
    'வந்துச்சு', 'வந்தாச்சு', 'வந்தது', 'வந்திருச்சு', 'vanthuchu', 'vandhuchu', 'vanthaachu', 'vandhaachu', 'vanthathu',
    'vandhadhu', 'vanthiruchu', 'vandhiruchu',
  ] },
  // speaker "I/we received" -> RECEIVE
  { label: 'vaanginen', type: 'verb', dir: R, forms: [
    'வாங்கினேன்', 'வாங்கிட்டேன்', 'வாங்குனேன்', 'வாங்கினோம்', 'வாங்கிட்டோம்', 'vaanginen', 'vaangitten', 'vaangunen',
    'vaanginom', 'vaangittom', 'vaangitom', 'vanginen',
  ] },
  { label: 'thiruppi', type: 'thiruppi', dir: R, forms: ['திருப்பி', 'திரும்பி', 'thiruppi', 'thirupi', 'tiruppi', 'thirumbi', 'thirumba'] },
  { label: 'upi', type: 'upi', dir: R, forms: ['ஜிபே', 'ஜீபே', 'போன்பே', 'பேடிஎம்', 'யுபிஐ', 'gpay', 'gepay', 'phonepe', 'paytm', 'upi'] },
  { label: 'enakku', type: 'shop', dir: R, forms: [
    'எனக்கு', 'நமக்கு', 'எங்களுக்கு', 'கடைக்கு', 'enakku', 'enaku', 'namakku', 'engalukku', 'kadaikku', 'kadaiku',
  ] },
  { label: 'varavu', type: 'label', dir: R, raw: true, forms: ['வரவு', 'varavu'] },
  { label: 'varavu', type: 'label', dir: R, forms: ['ஜமா', 'jama', 'jamaa'] },
  // ---- English, raw
  { label: 'paid', type: 'verb', dir: R, en: true, forms: [
    'paid', 'pay', 'pays', 'payment', 'payed', 'received', 'receive', 'recieved', 'got', 'returned', 'return', 'repaid',
    'deposit', 'deposited', 'settled', 'cleared',
  ] },
  { label: 'credit', type: 'label', dir: R, en: true, forms: ['credit', 'credited'] },
  { label: 'credit', type: 'label', dir: R, forms: ['கிரெடிட்', 'கிரெடிட்டு', 'kiredit'] },
  { label: 'gpay', type: 'upi', dir: R, en: true, forms: ['googlepay', 'phonepay', 'bhim'] },

  // ---- vaangu (take/buy), customer as subject -> took goods -> GIVE
  { label: 'vaanginaan', type: 'verb', dir: G, forms: [
    'வாங்கினான்', 'வாங்குனான்', 'வாங்கினா', 'வாங்கினாள்', 'வாங்கிட்டான்', 'வாங்கிட்டா', 'வாங்கிட்டாரு', 'வாங்கிட்டாங்க',
    'வாங்கிட்டு', 'வாங்கிக்கிட்டான்', 'வாங்கிக்கிட்டாங்க', 'வாங்கினாரு', 'வாங்கினாங்க', 'வாங்குனாங்க', 'வாங்கிருக்கான்',
    'வாங்கியிருக்கான்', 'வாங்குனா', 'வாங்குனாரு',
    'vaanginaan', 'vanginan', 'vaangunaan', 'vaanginaa', 'vaanginaal', 'vaangitaan', 'vaangittaan', 'vaangittaa',
    'vaangittaaru', 'vaangittaanga', 'vaangittu', 'vaangikittaan', 'vaangikittaanga', 'vaanginaaru', 'vaanginaanga',
    'vaangunaanga', 'vaangirukkaan', 'vaangunaa', 'vaangunaaru',
  ] },
  { label: 'eduthaan', type: 'verb', dir: G, forms: [
    'எடுத்தான்', 'எடுத்தாங்க', 'எடுத்தா', 'எடுத்தாரு', 'எடுத்துட்டு', 'எடுத்துட்டான்', 'எடுத்துக்கிட்டான்', 'எடுத்துட்டு போனான்',
    'eduthaan', 'eduthan', 'eduthaanga', 'eduthaa', 'eduthaaru', 'eduthuttu', 'eduthuttaan', 'eduthukittaan', 'eduthukitaan',
  ] },
  // speaker "I/we gave" -> GIVE
  { label: 'kuduthen', type: 'verb', dir: G, forms: [
    'குடுத்தேன்', 'கொடுத்தேன்', 'குடுத்தோம்', 'கொடுத்தோம்', 'குடுத்திருக்கேன்', 'குடுத்துட்டேன்', 'கொடுத்துட்டோம்', 'குடுத்துருக்கேன்',
    'kuduthen', 'koduthen', 'kuduthom', 'koduthom', 'kuduthirukken', 'kuduthutten', 'kuduthuttom', 'kudutthen',
  ] },
  // raw only: 'parru' / பாரு / 'paaru' fold to 'paru' and must stay out of the lexicon (finding 21)
  { label: 'debit', type: 'label', dir: G, raw: true, forms: ['பற்று', 'patru', 'pattru'] },
  { label: 'debit', type: 'label', dir: G, forms: ['டெபிட்'] },
  { label: 'debit', type: 'label', dir: G, en: true, forms: ['debit', 'debited', 'debt'] },
  { label: 'took', type: 'verb', dir: G, en: true, forms: ['took', 'taken', 'bought', 'purchased', 'borrowed', 'buy', 'purchase'] },
  { label: 'gave', type: 'gave', dir: null, en: true, forms: ['gave', 'given', 'give', 'gives'] },
  { label: 'kadan', type: 'noun', dir: G, forms: ['கடன்', 'உதாரி', 'உதார்', 'லோன்', 'kadan', 'kadanu', 'udhaar', 'udhaari', 'udhar', 'udaar', 'udhari'] },
  { label: 'kadan', type: 'noun', dir: G, en: true, forms: ['loan', 'udhaar', 'owes', 'owe'] },
  { label: 'baaki', type: 'baaki', dir: G, forms: ['பாக்கி', 'baaki', 'paakki', 'baki', 'bakki', 'paaki'] },
  { label: 'baaki', type: 'baaki', dir: G, en: true, forms: ['balance', 'due', 'pending'] },

  // ---- bare impersonal kuduthaachu: shop setting
  { label: 'kuduthaachu', type: 'bare', dir: null, forms: [
    'குடுத்தாச்சு', 'கொடுத்தாச்சு', 'குடுத்துட்டாச்சு', 'குடுத்தது', 'கொடுத்தது', 'குடுத்தாச்',
    'kuduthaachu', 'koduthaachu', 'kuduthachu', 'koduthachu', 'kudutthaachu', 'kuduthaach', 'kuduthathu', 'kuduthadhu',
    'kuduthuttaachu',
  ] },
  { label: 'kudu', type: 'imp', dir: null, forms: ['குடு', 'கொடு', 'குடுங்க', 'கொடுங்க', 'kudu', 'kodu', 'kudunga', 'kodunga', 'kuduthudu'] },
  // ---- light verbs / account
  { label: 'ezhuthu', type: 'light', dir: null, forms: [
    'எழுது', 'எழுதுங்க', 'எழுதிக்கோ', 'எழுதிடு', 'எழுதிக்கங்க', 'போடு', 'போடுங்க', 'போட்டுரு', 'போட்டுடு', 'வை', 'வைங்க',
    'ezhuthu', 'ezhudhu', 'ezhuthunga', 'ezhuthikko', 'ezhuthidu', 'eluthu', 'podu', 'podunga', 'potturu', 'pottudu',
    'vai', 'vainga', 'vaiyunga',
  ] },
  { label: 'ezhuthu', type: 'light', dir: null, en: true, forms: ['add', 'note', 'write', 'put', 'enter', 'mark'] },
  { label: 'kanakkula', type: 'account', dir: null, forms: [
    'கணக்குல', 'கணக்கில்', 'கணக்கு', 'கணக்குலே', 'பேர்ல', 'பேருல', 'peru', 'perla', 'perula', 'perle', 'kanakkula', 'kanakkule', 'kanakkil', 'kanakku', 'kanakla', 'kanakkla',
  ] },
  { label: 'kanakkula', type: 'account', dir: null, en: true, forms: ['account', 'accountla', 'khata', 'ledger'] },
  { label: 'kitta', type: 'kitta', dir: null, forms: ['கிட்ட', 'கிட்டே', 'கிட்டருந்து', 'kitta', 'kitte', 'kittarundhu', 'kittarunthu'] },
  { label: 'kitta', type: 'kitta', dir: null, en: true, forms: ['from'] },
  { label: 'negated', type: 'negated', dir: null, forms: [
    'குடுக்கல', 'கொடுக்கல', 'கட்டல', 'வாங்கல', 'குடுக்கலை', 'கட்டலை', 'kudukkala', 'kodukkala', 'kattala', 'vaangala',
    'kudukkalai', 'kattalai',
  ] },
];

/** Regex fallbacks on the folded form, for conjugations not listed above. */
const CUE_PATTERNS: { re: RegExp; label: string; type: CueType; dir: 'GIVE' | 'RECEIVE' | null }[] = [
  { re: /^(kutut|kotut)(u?t|it|ur|ir)?(asu|as|atu|ayitu|aytu)$/, label: 'kuduthaachu', type: 'bare', dir: null },
  { re: /^(kut|kot)a(su|s|tsu)$/, label: 'kuduthaachu', type: 'bare', dir: null }, // contracted: kudtachu
  { re: /^(kutut|kotut)(u?t|it|iruk|uruk)?(en|om|ten|tom)$/, label: 'kuduthen', type: 'verb', dir: G },
  { re: /^(kutut|kotut)(u?t|it|iruk|uruk)?(an|al|ar|aru|anka|ankal|a|apla|anu)$/, label: 'kuduthaan', type: 'kudu3p', dir: R },
  { re: /^(kutuk|kotuk)(al|ala|alai|ale)$/, label: 'negated', type: 'negated', dir: null },
  { re: /^vank(in|un|i|it|ikit|ikitu|iruk|iyiruk)(en|om|ten|tom)$/, label: 'vaanginen', type: 'verb', dir: R },
  { re: /^vank(in|un|it|ikit|iruk|iyiruk)(an|al|ar|aru|anka|ankal|a|anu)$/, label: 'vaanginaan', type: 'verb', dir: G },
  { re: /^vank(itu|ikitu)$/, label: 'vaanginaan', type: 'verb', dir: G },
  { re: /^kat(in|un|it|iy|iruk|iyiruk)(an|al|ar|aru|anka|ankal|a|asu|anu|en|om)$/, label: 'kattinaan', type: 'verb', dir: R },
  { re: /^etut(u?t|uk|ukit|it)?(an|al|ar|aru|anka|a|tu|u)$/, label: 'eduthaan', type: 'verb', dir: G },
  { re: /^vant(u|i|a)(su|tu|rusu|tusu)$/, label: 'vanthuchu', type: 'verb', dir: R },
  { re: /^setl/, label: 'settle', type: 'verb', dir: R },
];

const RAW_CUE = new Map<string, Cue>();
const FOLD_CUE = new Map<string, Cue>();
/** Folded keys that must never be cues: 'paru' is பாரு / 'paaru' ("look") as much as பற்று. */
const FORBIDDEN_FOLD_KEYS = new Set(['paru']);
for (const c of CUES) {
  for (const f of c.forms) {
    if (c.en || c.raw) { RAW_CUE.set(f.normalize('NFC').toLowerCase(), c); continue; }
    const k = foldWord(f);
    if (!k || FORBIDDEN_FOLD_KEYS.has(k)) continue;
    if (!FOLD_CUE.has(k)) FOLD_CUE.set(k, c);
  }
}
/** The folded keys the lexicon registered (tests check that no false friend such as 'paru' is among them). */
export const FOLDED_CUE_KEYS: ReadonlySet<string> = new Set(FOLD_CUE.keys());
/** Verb keys (folded) for fuzzy matching of recogniser misspellings. */
const FUZZY_CUE_KEYS = [...FOLD_CUE.entries()].filter(([k, c]) => k.length >= 5 && ['verb', 'kudu3p', 'bare', 'label'].includes(c.type));

/** Number of distinct surface forms in the direction lexicon. */
export const LEXICON_SIZE = new Set(CUES.flatMap((c) => c.forms)).size;

// ---- other word classes (forms listed in both scripts; English raw)
function wordSet(forms: string[], en: string[] = []): { fold: Set<string>; raw: Set<string> } {
  return { fold: new Set(forms.map(foldWord).filter(Boolean)), raw: new Set(en) };
}

const STOP = wordSet([
  'அண்ணா', 'அண்ணே', 'அக்கா', 'அம்மா', 'ஐயா', 'அய்யா', 'சார்', 'மேடம்', 'தம்பி', 'ஓகே', 'பணம்', 'காசு', 'கேஷ்', 'பண்ணிட்டான்',
  'பண்ணிட்டாரு', 'பண்ணிட்டாங்க', 'பண்ணு', 'பண்ணுங்க', 'பண்ணி', 'போனான்', 'போயிட்டான்', 'போனாரு', 'போனாங்க', 'இருந்து', 'இது', 'அது',
  'அவன்', 'அவள்', 'அவர்', 'அவங்க', 'மொத்தம்', 'ஆமா', 'சரி', 'என்ன', 'வந்து', 'விட்டு',
  'anna', 'annaa', 'anne', 'akka', 'amma', 'ayya', 'aiya', 'saar', 'thambi', 'panam', 'panamu', 'kaasu', 'kasu',
  'pannitaan', 'pannittaan', 'pannitan', 'pannittaaru', 'pannittaanga', 'pannu', 'pannunga', 'panni', 'ponaan', 'ponan',
  'poittaan', 'poyittaan', 'ponaaru', 'ponaanga', 'irundhu', 'irunthu', 'avan', 'aval', 'avar', 'avanga', 'motham',
  'aama', 'sari', 'enna', 'vandhu', 'vanthu', 'vittu', 'oda', 'voda', 'la', 'le', 'ma', 'da', 'di', 'pa', 'nga', 'ya',
], [
  'sir', 'madam', 'okay', 'ok', 'okk', 'um', 'umm', 'uh', 'hmm', 'the', 'of', 'for', 'is', 'has', 'have', 'rupees', 'cash',
  'amount', 'total', 'please', 'hello', 'yes', 'he', 'she', 'they', 'his', 'her', 'it', 'by', 'in', 'on', 'at', 'with',
  'worth', 'just', 'now', 'mr', 'mrs', 'brother', 'bro', 'entry', 'today\'s',
]);
/** "panniyaachu", "pannitaanga", "panniten": the light verb "do", in any person. */
const STOP_PATTERNS = [/^pan(i|u)(t|y|n|k|v|s)/, /^panu(nka|nk)?$/];
const SEP_WORDS = wordSet(['அப்புறம்', 'அப்பறம்', 'இன்னொரு', 'appuram', 'apram', 'aprom', 'appram', 'innoru'], ['and', 'then', 'also', 'next']);
const NEG = wordSet(['இல்ல', 'இல்லை', 'தப்பு', 'illa', 'illai', 'ille', 'thappu', 'thapu'], ['no', 'sorry', 'wrong', 'not']);
const PRON1 = wordSet(['நான்', 'நாங்க', 'நாம', 'naan', 'naanga', 'nanga', 'naama', 'naa'], ['i', 'we']);
const DATIVE_PRON = wordSet(['அவனுக்கு', 'அவளுக்கு', 'அவருக்கு', 'அவங்களுக்கு', 'avanukku', 'avalukku', 'avarukku', 'avangalukku'], ['him', 'them']);
const QUERY = wordSet(['எவ்வளவு', 'எவ்ளோ', 'எத்தனை', 'evvalavu', 'evlo', 'evvalo', 'evalo', 'ethana', 'ethanai'], ['much', 'how']);
const RUPEE = wordSet(['ரூபாய்க்கு', 'rupaikku', 'rubaaikku', 'roobaikku', 'ரூபாய்', 'ரூபா', 'ரூ', 'ருபாய்', 'ரூவா', 'rupaay', 'rupay', 'rubaa', 'ruba', 'rooba', 'rubai', 'roobai', 'rupa', 'rupai', 'ruva', 'roova'],
  ['rupees', 'rupee', 'rs', 'ruppees', 'rupes', 'bucks', 'inr']);
const PAISE = wordSet(['பைசா', 'paisa', 'paise', 'paisaa'], ['paise', 'paisa']);
const QTY = wordSet(['கிலோ', 'கிராம்', 'லிட்டர்', 'பாக்கெட்', 'டஜன்', 'பீஸ்', 'பாட்டில்', 'kilo', 'kilos', 'gram', 'litre', 'liter', 'paakket', 'packet', 'dasan', 'dozen'],
  ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'grams', 'gram', 'gm', 'gms', 'g', 'litre', 'liter', 'litres', 'liters', 'ltr', 'l', 'ml',
    'packet', 'packets', 'pocket', 'dozen', 'piece', 'pieces', 'pcs', 'bottle', 'bottles', 'bag', 'bags', 'box', 'nos']);
const ITEMS = wordSet([
  'அரிசி', 'பருப்பு', 'எண்ணெய்', 'சக்கரை', 'சர்க்கரை', 'பால்', 'முட்டை', 'சோப்பு', 'சாமான்', 'மாவு', 'ரவை', 'உப்பு', 'புளி',
  'மிளகாய்', 'கடுகு', 'வெங்காயம்', 'தக்காளி', 'காய்', 'காய்கறி', 'டீ', 'காபி', 'பிஸ்கட்', 'பிரட்', 'சிகரெட்', 'பீடி', 'ஷாம்பு',
  'பேஸ்ட்', 'மண்ணெண்ணெய்', 'மைதா', 'டீத்தூள்', 'பொடி', 'பழம்', 'வாழைப்பழம்', 'மூட்டை', 'சாக்லேட்', 'கோதுமை', 'தயிர்', 'நெய்',
  'arisi', 'paruppu', 'ennai', 'ennei', 'sakkarai', 'sarkarai', 'paal', 'muttai', 'soappu', 'saamaan', 'saaman', 'maavu',
  'rava', 'uppu', 'puli', 'milagai', 'kadugu', 'vengayam', 'thakkali', 'kaai', 'kaaikari', 'kaapi', 'beedi', 'maida',
  'podi', 'pazham', 'moottai', 'kothumai', 'thayir', 'nei', 'saamaanam',
], [
  'rice', 'dal', 'oil', 'sugar', 'milk', 'egg', 'eggs', 'soap', 'atta', 'salt', 'onion', 'onions', 'tomato', 'tomatoes',
  'vegetables', 'veg', 'tea', 'coffee', 'biscuit', 'biscuits', 'bread', 'cigarette', 'cigarettes', 'shampoo', 'paste',
  'toothpaste', 'kerosene', 'gas', 'groceries', 'grocery', 'items', 'things', 'goods', 'maida', 'sooji', 'rava', 'chocolate',
  'wheat', 'curd', 'ghee', 'banana', 'fruits', 'snacks', 'chips', 'arisi', 'paal',
]);
const DATE_WORDS: { set: { fold: Set<string>; raw: Set<string> }; off: 0 | -1 | -2 }[] = [
  { set: wordSet(['இன்னைக்கு', 'இன்று', 'இன்னிக்கு', 'inniku', 'innaikku', 'innikku', 'indru', 'innaiku'], ['today']), off: 0 },
  { set: wordSet(['நேத்து', 'நேற்று', 'nethu', 'naethu', 'netthu', 'netru'], ['yesterday']), off: -1 },
  { set: wordSet(['முந்தாநேத்து', 'munthaanethu', 'mundhaanethu', 'munthanethu'], []), off: -2 },
];
const CODE_WORDS = wordSet(['சி', 'கோட்', 'kod'], ['c', 'code', 'si']);
/** Honorifics that follow a name ("Ramu anna", "Sita akka-vukku"): skipped, but they may carry the name's dative. */
const HONORIFICS = wordSet(['அண்ணா', 'அண்ணே', 'அக்கா', 'அம்மா', 'ஐயா', 'அய்யா', 'சார்', 'தம்பி', 'anna', 'annaa', 'anne', 'akka', 'amma', 'ayya', 'aiya', 'saar', 'thambi'], ['sir', 'madam', 'brother', 'bro']);
const HONORIFIC_DATIVE = /^(.{2,}?)(வுக்கு|க்கு|உக்கு|னுக்கு|vukku|nukku|ukku|kku|ku)$/;
const TO_WORDS = new Set(['to']);

function inSet(s: { fold: Set<string>; raw: Set<string> }, raw: string, fold: string): boolean {
  return s.raw.has(raw) || (!!fold && s.fold.has(fold));
}

// ================================================================== numbers

type NumClass = 'unit' | 'teen' | 'ten' | 'hundred' | 'hword' | 'mult' | 'half';
interface Atom { v: number; cls: NumClass; en?: boolean }

const EN_NUM: Record<string, Atom> = {};
['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].forEach((w, i) => { EN_NUM[w] = { v: i + 1, cls: 'unit', en: true }; });
['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
  .forEach((w, i) => { EN_NUM[w] = { v: i + 10, cls: 'teen', en: true }; });
['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'].forEach((w, i) => { EN_NUM[w] = { v: (i + 2) * 10, cls: 'ten', en: true }; });
Object.assign(EN_NUM, {
  fourty: { v: 40, cls: 'ten', en: true }, hundred: { v: 100, cls: 'hword', en: true }, hundreds: { v: 100, cls: 'hword', en: true },
  thousand: { v: 1000, cls: 'mult', en: true }, thousands: { v: 1000, cls: 'mult', en: true },
  lakh: { v: 100000, cls: 'mult', en: true }, lakhs: { v: 100000, cls: 'mult', en: true }, lac: { v: 100000, cls: 'mult', en: true },
  lacs: { v: 100000, cls: 'mult', en: true }, crore: { v: 10000000, cls: 'mult', en: true }, crores: { v: 10000000, cls: 'mult', en: true },
  half: { v: 0.5, cls: 'half', en: true },
} satisfies Record<string, Atom>);

/**
 * Tamil number morphemes on the folded form. `trunc` morphemes (final vowel elided before a vowel: "rend-aayiram",
 * "irupath-anju", "onn-arai") are only valid before the classes in `before`, which stops names like "Patel" from
 * decomposing into 10 + 7.
 */
interface Morph { k: string; a: Atom; before?: NumClass[] }
const TA_MORPHS: Morph[] = [];
function m(keys: string[], v: number, cls: NumClass, before?: NumClass[]): void {
  for (const k of keys) TA_MORPHS.push({ k, a: { v, cls }, before });
}
const BEFORE_MULT: NumClass[] = ['mult', 'half'];
const BEFORE_UNIT: NumClass[] = ['unit', 'mult', 'half'];
m(['onu', 'onru', 'ontru', 'oru', 'onnu'], 1, 'unit'); m(['on', 'onr', 'ontr'], 1, 'unit', BEFORE_MULT);
m(['rentu', 'irantu', 'rentu'], 2, 'unit'); m(['rent', 'irant'], 2, 'unit', BEFORE_MULT);
m(['munu'], 3, 'unit'); m(['mun', 'muv', 'muva'], 3, 'unit', BEFORE_MULT);
m(['nalu', 'nanku'], 4, 'unit'); m(['nal', 'nank'], 4, 'unit', BEFORE_MULT);
m(['ansu', 'aintu', 'ainsu', 'ainu'], 5, 'unit'); m(['ans', 'aint'], 5, 'unit', BEFORE_MULT);
m(['aru'], 6, 'unit'); m(['ar'], 6, 'unit', ['mult']);
m(['elu'], 7, 'unit'); m(['el'], 7, 'unit', BEFORE_MULT);
m(['etu'], 8, 'unit'); m(['et'], 8, 'unit', BEFORE_MULT);
m(['onpatu', 'ompatu', 'ompotu', 'onpotu', 'onpatu'], 9, 'unit'); m(['onpat', 'ompat'], 9, 'unit', BEFORE_MULT);
m(['patu'], 10, 'teen'); m(['pat'], 10, 'teen', BEFORE_MULT);
m(['patinonu', 'patinonru'], 11, 'teen'); m(['panirantu', 'panentu', 'panrentu'], 12, 'teen'); m(['patimunu', 'patinmunu'], 13, 'teen');
m(['patinalu'], 14, 'teen'); m(['patinansu', 'patinaintu'], 15, 'teen'); m(['patinaru'], 16, 'teen');
m(['patinelu'], 17, 'teen'); m(['patinetu'], 18, 'teen'); m(['patonpatu', 'patompatu'], 19, 'teen');
m(['irupatu', 'irupotu'], 20, 'ten'); m(['irupat', 'irupata'], 20, 'ten', BEFORE_UNIT);
m(['mupatu'], 30, 'ten'); m(['mupat', 'mupata'], 30, 'ten', BEFORE_UNIT);
m(['napatu', 'narpatu', 'nalpatu'], 40, 'ten'); m(['napat', 'narpat', 'napata'], 40, 'ten', BEFORE_UNIT);
m(['aimpatu', 'ampatu', 'ampotu'], 50, 'ten'); m(['aimpat', 'ampat', 'ampata', 'aimpata'], 50, 'ten', BEFORE_UNIT);
m(['arupatu'], 60, 'ten'); m(['arupat', 'arupata'], 60, 'ten', BEFORE_UNIT);
m(['elupatu'], 70, 'ten'); m(['elupat', 'elupata'], 70, 'ten', BEFORE_UNIT);
m(['enpatu', 'empatu'], 80, 'ten'); m(['enpat', 'empat', 'enpata'], 80, 'ten', BEFORE_UNIT);
m(['tonuru', 'tonnuru'], 90, 'ten'); m(['tonuti', 'tonutri'], 90, 'ten', BEFORE_UNIT);
// நூற்றி transliterates to "noorri" (fold "nuri"); the spoken "nootthi" folds to "nuti"; both continue the number
const BEFORE_SMALL: NumClass[] = ['ten', 'teen', 'unit'];
m(['nuru', 'nuti', 'nutri', 'nutru', 'nutu', 'nuri'], 100, 'hundred'); m(['nutr', 'nur'], 100, 'hundred', BEFORE_SMALL);
m(['irunuru', 'irunuti', 'irunutri', 'irunuri'], 200, 'hundred'); m(['irunur'], 200, 'hundred', BEFORE_SMALL);
m(['munuru', 'munuti', 'munutri', 'munuri'], 300, 'hundred'); m(['munur'], 300, 'hundred', BEFORE_SMALL);
m(['nanuru', 'nanuti', 'nalunuru', 'nanuri'], 400, 'hundred'); m(['nanur'], 400, 'hundred', BEFORE_SMALL);
m(['ainuru', 'ainuti', 'ainutri', 'ansunuru', 'ainuri'], 500, 'hundred'); m(['ainur'], 500, 'hundred', BEFORE_SMALL);
m(['arunuru', 'arunuti', 'arunuri'], 600, 'hundred'); m(['elunuru', 'elunuti', 'elunuri'], 700, 'hundred');
m(['enuru', 'enuti', 'etunuru', 'enuri'], 800, 'hundred');
m(['tolayiram', 'tolayiratu', 'tolayirati'], 900, 'hundred');
m(['ayiram', 'ayiratu', 'ayirati', 'ayirat', 'ayira'], 1000, 'mult');
m(['laksam', 'latsam', 'laksatu', 'latsatu', 'lakam', 'laks', 'lak', 'latcam'], 100000, 'mult');
m(['koti', 'kotiye'], 10000000, 'mult');
m(['arai'], 0.5, 'half');
TA_MORPHS.sort((x, y) => y.k.length - x.k.length);

const CLASS_RANK: Record<NumClass, number> = { unit: 1, teen: 2, ten: 2, hundred: 3, hword: 3, mult: 4, half: 0 };

/** Can atom `b` continue a number whose previous atom is `a`? (Higher to lower, or a multiplier, or Indian English.) */
function canFollow(a: Atom, b: Atom): boolean {
  if (b.cls === 'mult' || b.cls === 'half') return true;
  if (a.cls === 'mult') return true;
  if (a.cls === 'half') return false;
  if (b.cls === 'hword') return a.cls !== 'hundred' && a.cls !== 'hword';
  if (a.cls === 'hword') return true;
  // Indian English "one fifty" (150), "twelve fifty" (1250), "two fifteen" (215)
  if (a.en && b.en && (a.cls === 'unit' || a.cls === 'teen') && (b.cls === 'ten' || b.cls === 'teen')) return true;
  // colloquial Tamil "rendu nooru" (200)
  if (a.cls === 'unit' && b.cls === 'hundred' && b.v === 100) return true;
  if (a.cls === 'ten' && b.cls === 'unit') return true;
  return CLASS_RANK[a.cls] > CLASS_RANK[b.cls];
}

/** Decompose one folded Tamil token into number atoms, or null. */
function tamilNumberAtoms(fold: string): Atom[] | null {
  if (fold.length < 2) return null;
  const memo = new Map<number, Atom[] | null>();
  const go = (i: number, prev: Atom | null, prevBefore: NumClass[] | undefined): Atom[] | null => {
    if (i === fold.length) return prevBefore ? null : [];
    const key = i * 100 + (prev ? CLASS_RANK[prev.cls] * 10 : 0) + (prevBefore ? 1 : 0);
    if (!prevBefore && memo.has(key) && prev === null) return memo.get(key)!;
    for (const mo of TA_MORPHS) {
      if (!fold.startsWith(mo.k, i)) continue;
      if (prevBefore && !prevBefore.includes(mo.a.cls)) continue;
      if (prev && !canFollow(prev, mo.a)) continue;
      const rest = go(i + mo.k.length, mo.a, mo.before);
      if (rest) return [mo.a, ...rest];
    }
    return null;
  };
  const r = go(0, null, undefined);
  return r && r.length ? r : null;
}

/** Evaluate a sequence of atoms (already checked with canFollow) to rupees. */
function evalAtoms(atoms: Atom[]): number {
  let total = 0;
  let cur = 0;
  let prev: Atom | null = null;
  for (const a of atoms) {
    switch (a.cls) {
      case 'mult':
        total += (cur || 1) * a.v;
        cur = 0;
        break;
      case 'hword':
        cur = (cur || 1) * 100;
        break;
      case 'hundred':
        if (prev && prev.cls === 'unit' && a.v === 100 && cur < 10) cur *= 100;
        else cur += a.v;
        break;
      case 'ten':
      case 'teen':
        if (prev && prev.en && a.en && (prev.cls === 'unit' || prev.cls === 'teen') && cur < 20) cur = cur * 100 + a.v;
        else cur += a.v;
        break;
      case 'unit':
        cur += a.v;
        break;
      case 'half':
        if (cur > 0) cur += 0.5;
        else if (total > 0 && prev && prev.cls === 'mult') total += prev.v / 2;
        else cur += 0.5;
        break;
    }
    prev = a;
  }
  return total + cur;
}

// ================================================================== tokens

type TokType =
  | 'digits' | 'numword' | 'cue' | 'neg' | 'stop' | 'rupee' | 'paise' | 'qty' | 'item' | 'sep' | 'code' | 'date'
  | 'pron1' | 'dativePron' | 'query' | 'to' | 'and' | 'a' | 'name';

interface Tok {
  surface: string;
  raw: string;
  fold: string;
  start: number;
  end: number;
  type: TokType;
  cue?: { label: string; type: CueType; dir: 'GIVE' | 'RECEIVE' | null; fuzzy?: boolean };
  atoms?: Atom[];
  digits?: string;   // ASCII digits (and a decimal part) of a digits token
  dateOff?: 0 | -1 | -2;
  /** Name token with a case suffix ("Ramukku", "Ramuvoda"): surface without it; `dative` for -kku/க்கு. */
  suffix?: { base: string; surface: string; dative: boolean };
  /** Locative -la/-le/-il glued to the word ("credit-la"). */
  locative?: boolean;
  /** Also exactly a customer's first name (number word / noun colliding with a name: Anju, Kaasi). */
  alsoName?: boolean;
  /** Honorific with a dative suffix ("akkavukku", "annanukku"): the name before it takes the dative. */
  honorificDative?: boolean;
}

const TOKEN_RE = /(\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})+,\d{3}|\d+)(?:\.(\d+))?|₹|[\p{L}\p{M}]+(?:['’][sS]\b)?|[,.;!?\n|]|-/gu;
const SUFFIX_JOIN = /^(kku|ukku|vukku|ku|la|le|il|oda|voda|kitta|க்கு|உக்கு|கு|ல|லே|ட|kita)$/i;

const UNKNOWN_LIKE = new Set<TokType>(['name']);

function classifyWord(surface: string, raw: string, fold: string): Omit<Tok, 'surface' | 'raw' | 'fold' | 'start' | 'end'> {
  // English words first, raw
  if (EN_NUM[raw]) return { type: 'numword', atoms: [EN_NUM[raw]] };
  if (raw === 'and') return { type: 'and' };
  if (raw === 'a' || raw === 'an') return { type: 'a' };
  if (TO_WORDS.has(raw)) return { type: 'to' };
  const rc = RAW_CUE.get(raw);
  if (rc) return { type: 'cue', cue: { label: rc.label, type: rc.type, dir: rc.dir } };
  for (const d of DATE_WORDS) if (inSet(d.set, raw, fold)) return { type: 'date', dateOff: d.off };
  if (inSet(RUPEE, raw, fold)) return { type: 'rupee' };
  if (inSet(PAISE, raw, fold)) return { type: 'paise' };
  if (inSet(CODE_WORDS, raw, fold)) return { type: 'code' };
  if (inSet(NEG, raw, fold)) return { type: 'neg' };
  if (inSet(PRON1, raw, fold)) return { type: 'pron1' };
  if (inSet(QUERY, raw, fold)) return { type: 'query' };
  if (inSet(QTY, raw, fold)) return { type: 'qty' };
  if (inSet(SEP_WORDS, raw, fold)) return { type: 'sep' };
  if (inSet(DATIVE_PRON, raw, fold)) return { type: 'dativePron' };
  // Tamil / Tanglish, folded
  // a lone Latin "c" in a Tamil verb is a misheard "ch" ("koduthaccu")
  const cfold = fold.replace(/c/g, 's');
  const fc = FOLD_CUE.get(fold) ?? FOLD_CUE.get(cfold);
  if (fc) return { type: 'cue', cue: { label: fc.label, type: fc.type, dir: fc.dir } };
  if (!hasTamil(surface) && /^[a-z]+$/.test(raw) && raw.length <= 3 && STOP.raw.has(raw)) return { type: 'stop' };
  if (inSet(STOP, raw, fold) || DATIVE_PARTICLE.has(raw) || STOP_PATTERNS.some((re) => re.test(fold))) return { type: 'stop' };
  if (inSet(ITEMS, raw, fold)) return { type: 'item' };
  const atoms = tamilNumberAtoms(fold);
  if (atoms) return { type: 'numword', atoms };
  for (const p of CUE_PATTERNS) if (p.re.test(cfold)) return { type: 'cue', cue: { label: p.label, type: p.type, dir: p.dir } };
  // glued locative: "creditla", "kanakkula" handled above; "accountla"
  const loc = /^(.{4,}?)(la|le|il)$/.exec(raw) ?? /^(.{2,}?)(ல|லே|ல்|யில்)$/.exec(raw);
  if (loc) {
    const base = RAW_CUE.get(loc[1]) ?? FOLD_CUE.get(foldWord(loc[1]));
    if (base && (base.type === 'label' || base.type === 'account')) return { type: 'cue', cue: { label: base.label, type: base.type, dir: base.dir }, locative: true };
  }
  // item with a dative/locative suffix ("arisikku")
  const itemBase = /^(.{3,}?)(uku|ku|la|il)$/.exec(fold);
  if (itemBase && ITEMS.fold.has(itemBase[1])) return { type: 'item' };
  // honorific with a dative ("akkavukku", "அண்ணனுக்கு"): a stop word that marks the name as dative
  const hd = HONORIFIC_DATIVE.exec(raw);
  if (hd) {
    const base = hd[1].replace(/ன$/, 'ன்');
    if (inSet(HONORIFICS, base, foldWord(base)) || inSet(HONORIFICS, hd[1], foldWord(hd[1]))) return { type: 'stop', honorificDative: true };
  }
  return { type: 'name' };
}

/** Index of the token after a name span, skipping one honorific ("Lakshmi akka ku"). */
function afterNameIndex(toks: Tok[], last: number): number {
  const n = last + 1;
  const t = toks[n];
  if (t && t.type === 'stop' && !t.honorificDative && inSet(HONORIFICS, t.raw, t.fold)) return n + 1;
  return n;
}

/**
 * Case suffixes on a name-like token, longest first: dative ("Ramukku", "Ramu-kku", "சீதாவுக்கு", "குமாருக்கு")
 * and genitive ("Ramuvoda kanakkula", "ராமுவோட"). Returns candidate bases; the caller keeps the one that matches
 * a customer best.
 */
function suffixCandidates(t: Tok): { base: string; surface: string; dative: boolean }[] {
  if (t.fold.length < 4) return [];
  const s = t.surface;
  const out: { base: string; surface: string; dative: boolean }[] = [];
  const add = (surface: string, dative: boolean) => {
    if (surface.length >= 2) out.push({ base: foldWord(surface), surface, dative });
  };
  if (!hasTamil(s)) {
    // "Ramukku" -> Ramu, "Kumarukku" -> Kumaru (dropU scoring meets Kumar) or Kumar, "Sitavukku" -> Sita
    const d = /^(.{2,}?)-?(vukku|vuku|kku|ku)$/i.exec(s);
    if (d) {
      add(d[1], true);
      if (/[^aeiou]u$/i.test(d[1])) add(d[1].slice(0, -1), true);
    }
    const g = /^(.{2,}?)-?(voda|vota|vode|oda|ota|ode|odu|vodu|vudaiya|udaiya)$/i.exec(s);
    if (g) add(g[1], false);
  } else {
    const d = /^(.+?)(வுக்கு|க்கு)$/.exec(s);
    if (d) add(d[1], true);
    const d2 = /^(.+?)(ுக்கு|உக்கு)$/.exec(s);
    if (d2) add(d2[1] + '்', true);
    const g = /^(.+?)(வோட|வோட்|வோடது|வுடைய)$/.exec(s);
    if (g) add(g[1], false);
    const g2 = /^(.+?)(ோட|ோட்|ுடைய)$/.exec(s);
    if (g2) add(g2[1] + '்', false);
  }
  return out;
}

/** Separate dative particle after a name: "Ramu ku", "Murugan ukku". */
const DATIVE_PARTICLE = new Set(['ku', 'kku', 'ukku', 'vukku', 'கு', 'க்கு', 'உக்கு', 'வுக்கு']);

function tokenize(text: string): { norm: string; toks: Tok[] } {
  const norm = asciiDigits(String(text ?? '').normalize('NFC'));
  const pieces: { s: string; start: number; end: number; num?: string; dec?: string }[] = [];
  for (const mt of norm.matchAll(TOKEN_RE)) {
    pieces.push({ s: mt[0], start: mt.index!, end: mt.index! + mt[0].length, num: mt[1], dec: mt[2] });
  }
  // hyphen joins: "Ramu-kku", "credit-la" -> one word; other hyphens vanish
  const merged: typeof pieces = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.s === '-') {
      const prev = merged[merged.length - 1];
      const next = pieces[i + 1];
      if (prev && next && !prev.num && !next.num && prev.end === p.start && next.start === p.end && SUFFIX_JOIN.test(next.s)) {
        merged[merged.length - 1] = { s: prev.s + next.s, start: prev.start, end: next.end };
        i++;
      }
      continue;
    }
    merged.push(p);
  }
  const toks: Tok[] = [];
  for (const p of merged) {
    const surface = text.normalize('NFC').slice(p.start, p.end);
    if (p.num !== undefined) {
      toks.push({ surface, raw: p.s, fold: '', start: p.start, end: p.end, type: 'digits', digits: p.num.replace(/,/g, '') + (p.dec ? `.${p.dec}` : '') });
      continue;
    }
    if (p.s === '₹') { toks.push({ surface, raw: p.s, fold: '', start: p.start, end: p.end, type: 'rupee' }); continue; }
    if (/^[,.;!?\n|]$/.test(p.s)) { toks.push({ surface, raw: p.s, fold: '', start: p.start, end: p.end, type: 'sep' }); continue; }
    const word = p.s.replace(/['’][sS]$/, '');
    const raw = word.toLowerCase().replace(/-/g, '');
    const fold = foldWord(raw);
    const t: Tok = { surface: word, raw, fold, start: p.start, end: p.end, type: 'name' };
    Object.assign(t, classifyWord(word, raw, fold));
    toks.push(t);
  }
  return { norm, toks };
}

/** Fuzzy direction-cue match for a name-like token (recogniser misspelling). */
function fuzzyCue(fold: string): Tok['cue'] | null {
  // Short words are too close to everything ("kotutu" is one letter from "potutu"); recognisers rarely change
  // the first consonant; and a tie between different meanings is no match.
  if (fold.length < 6) return null;
  const max = fold.length >= 9 ? 2 : 1;
  let bestD = Infinity;
  let hits: Cue[] = [];
  for (const [k, c] of FUZZY_CUE_KEYS) {
    if (k[0] !== fold[0] || Math.abs(k.length - fold.length) > max) continue;
    const d = levenshtein(fold, k);
    if (d > max) continue;
    if (d < bestD) { bestD = d; hits = [c]; } else if (d === bestD) hits.push(c);
  }
  if (!hits.length) return null;
  const c = hits[0];
  if (hits.some((h) => h.type !== c.type || h.dir !== c.dir)) return null;
  return { label: c.label, type: c.type, dir: c.dir, fuzzy: true };
}

// ================================================================== customers

interface IndexedCustomer {
  c: VoiceCustomer;
  /** Folded full forms (name, transliteration, search_name), words separated by single spaces. */
  forms: string[];
  key: string;
  firstWords: Set<string>;
}

function usable(c: VoiceCustomer): boolean {
  if (c.erased_at) return false;
  if (c.archived_at && !(c.balance_paise && c.balance_paise !== 0)) return false;
  return true;
}

function foldPhrase(s: string): string {
  return normName(s).split(/[\s.,\-_/]+/).map(nameKey).filter(Boolean).join(' ');
}

const indexCache = new WeakMap<VoiceCustomer[], IndexedCustomer[]>();
function indexCustomers(customers: VoiceCustomer[]): IndexedCustomer[] {
  const hit = indexCache.get(customers);
  if (hit) return hit;
  const out: IndexedCustomer[] = [];
  for (const c of customers) {
    if (!usable(c)) continue;
    const forms = new Set<string>();
    forms.add(foldPhrase(c.name));
    if (c.search_name) forms.add(foldPhrase(c.search_name));
    forms.delete('');
    const firstWords = new Set([...forms].map((f) => f.split(' ')[0]));
    out.push({ c, forms: [...forms], key: searchKey(c), firstWords });
  }
  indexCache.set(customers, out);
  return out;
}

function scoreCustomer(q: string, qRaw: string, ic: IndexedCustomer): number {
  if (!q) return 0;
  const qj = q.replace(/ /g, '');
  const qWords = q.split(' ');
  let best = 0;
  for (const f of ic.forms) {
    const fj = f.replace(/ /g, '');
    const fWords = f.split(' ');
    best = Math.max(best, sim(qj, fj), 0.95 * sim(dropU(qj), dropU(fj)));
    if (fWords.length > qWords.length) {
      const head = fWords.slice(0, qWords.length).join('');
      best = Math.max(best, 0.95 * sim(qj, head), 0.9 * sim(dropU(qj), dropU(head)));
      // any other word of the name ("Tea Kadai Ramu")
      for (let i = 1; i <= fWords.length - qWords.length; i++) {
        best = Math.max(best, 0.8 * sim(qj, fWords.slice(i, i + qWords.length).join('')));
      }
    }
  }
  if (qj.length >= 3 && matchesQuery(ic.key, qRaw)) best = Math.max(best, 0.8);
  if (qj.length <= 2) return best === 1 ? 1 : 0;
  return best;
}

const MATCH_FLOOR = 0.6;

/**
 * Rank customers for a spoken name. Score 0..1; same-name customers tie. "C-0042" / "C 42" / "code 42" match
 * the customer code exactly (1.0).
 */
export function matchCustomers(nameText: string, customers: VoiceCustomer[], limit = 3): CustomerMatch[] {
  const idx = indexCustomers(customers);
  const text = asciiDigits(String(nameText ?? '').normalize('NFC')).trim();
  if (!text) return [];
  const code = /^(?:(c|code|si|சி|கோட்)\s*[-#]?\s*)?0*(\d{1,6})$/i.exec(text);
  if (code) {
    const n = Number(code[2]);
    return idx.filter((ic) => ic.c.code === n).map((ic) => ({ id: ic.c.id, score: 1 })).slice(0, limit);
  }
  const q = foldPhrase(text);
  const scored: CustomerMatch[] = [];
  for (const ic of idx) {
    const s = scoreCustomer(q, text, ic);
    if (s >= MATCH_FLOOR) scored.push({ id: ic.c.id, score: Math.round(s * 1000) / 1000 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ================================================================== amount extraction

interface NumRun {
  /** token index range [i, j) */
  i: number;
  j: number;
  rupees: number;
  start: number;
  end: number;
}

/** Merge digits / number words into number runs. */
function numberRuns(toks: Tok[]): NumRun[] {
  const runs: NumRun[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    const aMult = t.type === 'a' && toks[i + 1]?.type === 'numword' && ['hword', 'mult'].includes(toks[i + 1].atoms![0].cls);
    if (t.type !== 'digits' && t.type !== 'numword' && !aMult) { i++; continue; }
    // a lone "half"/"arai" is not an amount
    if (t.type === 'numword' && t.atoms!.length === 1 && t.atoms![0].cls === 'half') { i++; continue; }
    let j = i;
    let atoms: Atom[] = [];
    let value: number | null = null;
    if (aMult) { atoms = [{ v: 1, cls: 'unit', en: true }]; j = i + 1; }
    if (t.type === 'digits') {
      const d = t.digits!;
      const n = Number(d);
      j = i + 1;
      // "2 thousand", "1.5 lakh", "5 hundred", "2 ஆயிரம்", "rendu" style multipliers after digits
      const nx = toks[j];
      if (nx && nx.type === 'numword' && n > 0 && n < 1000 && (nx.atoms![0].cls === 'mult' || (nx.atoms![0].cls === 'hword' && n < 100))) {
        atoms = [{ v: n, cls: n < 10 ? 'unit' : n < 100 ? 'ten' : 'hundred', en: true }];
        const cls = nx.atoms![0].cls;
        if (cls === 'hword') { atoms = [{ v: n, cls: 'unit', en: true }]; }
        // fall through into word accumulation below
      } else {
        value = Number.isFinite(n) ? n : null;
        runs.push({ i, j, rupees: value ?? NaN, start: t.start, end: t.end, digitsStr: d } as NumRun & { digitsStr: string });
        i = j;
        continue;
      }
    }
    // accumulate number words (and "and" between them)
    let k = j === i ? i : j;
    while (k < toks.length) {
      const w = toks[k];
      if (w.type === 'and' && atoms.length && (toks[k + 1]?.type === 'numword' || (toks[k + 1]?.type === 'a' && toks[k + 2]?.type === 'numword'))) { k++; continue; }
      if (w.type === 'a' && toks[k + 1]?.type === 'numword' && toks[k + 1].atoms![0].cls === 'half') { k++; continue; }
      if (w.type !== 'numword') break;
      const was = atoms.length ? atoms[atoms.length - 1] : null;
      const first = w.atoms![0];
      if (was && !canFollow(was, first)) break;
      if (!was && first.cls === 'half') break;
      // "half" only continues after "and"/"a" ("two and a half thousand") or directly
      atoms = atoms.concat(w.atoms!);
      k++;
    }
    if (!atoms.length || (atoms.length === 1 && atoms[0].cls === 'half')) { i = Math.max(k, i + 1); continue; }
    let rupees = evalAtoms(atoms);
    // "2 thousand 500", "ரெண்டாயிரத்து 500": digits below the last multiplier continue the number
    const last = atoms[atoms.length - 1];
    const nd = toks[k];
    if (last.cls === 'mult' && nd && nd.type === 'digits' && !nd.digits!.includes('.') && Number(nd.digits) < last.v) {
      rupees += Number(nd.digits);
      k++;
    }
    runs.push({ i, j: k, rupees, start: toks[i].start, end: toks[k - 1].end });
    i = k;
  }
  return runs;
}

function rupeesToPaise(r: number, digitsStr?: string): number | null {
  try {
    if (digitsStr !== undefined) {
      if (/\.\d{3,}$/.test(digitsStr)) return null;
      return toPaise(digitsStr);
    }
    if (!Number.isFinite(r) || r <= 0) return null;
    const p = Math.round(r * 100);
    if (p <= 0 || p > MAX_AMOUNT_PAISE) return null;
    return p;
  } catch {
    return null;
  }
}

interface AmountPick {
  paise: number | null;
  candidates: number[];
  run: NumRun | null;
  /** token indices consumed by numbers (all runs, including dropped ones) */
  used: Set<number>;
  /** quantity phrases ("2 kilo") as token index ranges, for the note */
  qty: [number, number][];
  codeRuns: NumRun[];
}

/** Choose the amount among the number runs inside toks[from, to). */
function pickAmount(toks: Tok[], runs: NumRun[], from: number, to: number): AmountPick {
  const inside = runs.filter((r) => r.i >= from && r.j <= to);
  const used = new Set<number>();
  const qty: [number, number][] = [];
  const codeRuns: NumRun[] = [];
  for (const r of inside) for (let x = r.i; x < r.j; x++) used.add(x);
  type C = { r: NumRun; paise: number; rupeeAdj: boolean; itemAfter: boolean };
  let cands: C[] = [];
  for (const r of inside) {
    const before = toks[r.i - 1];
    const after = toks[r.j];
    const digitsStr = (r as NumRun & { digitsStr?: string }).digitsStr;
    if (before && before.type === 'code') { codeRuns.push(r); continue; }
    if (after && after.type === 'qty') { qty.push([r.i, r.j + 1]); continue; }
    if (digitsStr && digitsStr.replace(/\D/g, '').length >= 10) continue; // phone number
    let paise = rupeesToPaise(r.rupees, digitsStr);
    // "100 rupees 50 paise"
    if (paise !== null && after && after.type === 'rupee') {
      const p2 = runs.find((x) => x.i === r.j + 1);
      if (p2 && toks[p2.j]?.type === 'paise' && p2.rupees < 100 && Number.isInteger(p2.rupees)) {
        paise += p2.rupees;
        used.add(p2.i);
        cands = cands.filter((c) => c.r !== p2);
        r.end = toks[p2.j].end;
        (r as NumRun & { absorbed?: NumRun }).absorbed = p2;
      }
    }
    if (inside.some((x) => (x as NumRun & { absorbed?: NumRun }).absorbed === r)) continue;
    if (paise === null) continue;
    const rupeeAdj = (before && before.type === 'rupee') || (after && after.type === 'rupee') || false;
    const itemAfter = !!after && after.type === 'item';
    cands.push({ r, paise, rupeeAdj, itemAfter });
  }
  // correction: a NEG word between two candidates drops the earlier one ("100 illa 150")
  for (let a = 0; a < cands.length - 1; a++) {
    const b = cands[a + 1];
    for (let x = cands[a].r.j; x < b.r.i; x++) {
      if (toks[x].type === 'neg') { cands.splice(a, 1); a = -1; break; }
    }
  }
  // "oru 500" / "one 500": the article "a", not the amount 1
  if (cands.length > 1) cands = cands.filter((c) => !(c.paise === 100 && c.r.j - c.r.i === 1 && toks[c.r.i].type === 'numword'));
  if (cands.length > 1 && cands.some((c) => c.rupeeAdj)) cands = cands.filter((c) => c.rupeeAdj);
  if (cands.length > 1 && cands.some((c) => !c.itemAfter)) {
    for (const c of cands.filter((x) => x.itemAfter)) qty.push([c.r.i, c.r.j + 1]);
    cands = cands.filter((c) => !c.itemAfter);
  }
  if (cands.length === 1) return { paise: cands[0].paise, candidates: [], run: cands[0].r, used, qty, codeRuns };
  if (cands.length === 0) return { paise: null, candidates: [], run: null, used, qty, codeRuns };
  return { paise: null, candidates: [...new Set(cands.map((c) => c.paise))], run: null, used, qty, codeRuns };
}

/**
 * The amount spoken in `text`: digits ("1,500", Tamil digits, "12.50"), "100 rupees/ரூபாய்/rubaa", Tamil number
 * words ("ஆயிரத்து ஐநூறு" = 1500, "ரெண்டாயிரத்து முந்நூத்தி அம்பது" = 2350, "irunoothi ambathu" = 250) and English
 * ("one fifty" = 150, "fifteen hundred", "two thousand five hundred"). Quantities ("2 kilo"), customer codes
 * ("C 42") and phone numbers are skipped; "100 illa 150" gives 150. When several amounts remain, the first one
 * next to a rupee word wins, else the first. Zero or above MAX_AMOUNT_PAISE -> null.
 * `span` is [start, end) in the NFC form of `text`.
 */
export function parseAmount(text: string): { paise: number; span: [number, number] } | null {
  const { toks } = tokenize(text);
  const runs = numberRuns(toks);
  const pick = pickAmount(toks, runs, 0, toks.length);
  if (pick.run && pick.paise !== null) return { paise: pick.paise, span: [pick.run.start, pick.run.end] };
  if (pick.candidates.length) {
    // ambiguous: first remaining candidate in reading order
    const first = runs.find((r) => {
      const p = rupeesToPaise(r.rupees, (r as NumRun & { digitsStr?: string }).digitsStr);
      return p !== null && pick.candidates.includes(p) && toks[r.i - 1]?.type !== 'code' && toks[r.j]?.type !== 'qty';
    });
    if (first) return { paise: rupeesToPaise(first.rupees, (first as NumRun & { digitsStr?: string }).digitsStr)!, span: [first.start, first.end] };
  }
  return null;
}

// ================================================================== direction

interface KindResult {
  kind: 'GIVE' | 'RECEIVE' | null;
  reason: string | null;
  /** may support confidence 'high' */
  explicit: boolean;
  /** cap at 'low' */
  weak: boolean;
  /** entry had a direction cue of its own (does not inherit) */
  own: boolean;
}

interface EntryCues {
  cues: NonNullable<Tok['cue']>[];
  dative: boolean;
  pron1: boolean;
  /** English "gave ... to X" */
  giveTo: boolean;
  creditLa: boolean;
  items: boolean;
  negWord: boolean;
}

function resolveKind(ec: EntryCues, settings: VoiceSettings): KindResult {
  const has = (t: CueType) => ec.cues.some((c) => c.type === t);
  const neg = ec.cues.find((c) => c.type === 'negated');
  if (neg) return { kind: null, reason: `negated:${neg.label}`, explicit: false, weak: true, own: true };
  const shop = has('shop');
  let gw = 0;
  let rw = 0;
  const reasons: { dir: 'GIVE' | 'RECEIVE'; reason: string; explicit: boolean; w: number }[] = [];
  const vote = (dir: 'GIVE' | 'RECEIVE', reason: string, explicit: boolean, w: number) => {
    reasons.push({ dir, reason, explicit, w });
    if (dir === 'GIVE') gw += w; else rw += w;
  };
  const fz = (c: { fuzzy?: boolean }) => (c.fuzzy ? '~' : '');
  for (const c of ec.cues) {
    switch (c.type) {
      case 'verb':
        vote(c.dir!, `verb:${c.label}${fz(c)}`, !c.fuzzy, 4);
        break;
      case 'kudu3p':
        if (ec.dative && !shop) vote(G, `verb:${c.label}+dative`, false, 3);
        else vote(R, `verb:${c.label}${fz(c)}`, !c.fuzzy, 4);
        break;
      case 'bare':
        if (ec.pron1) vote(G, `verb:${c.label}+speaker`, !c.fuzzy, 4);
        else if (shop) vote(R, `verb:${c.label}+enakku`, !c.fuzzy, 4);
        else if (ec.dative) vote(G, `verb:${c.label}+dative`, false, 3);
        else vote(settings.bareKuduthaachu, 'bare-kuduthaachu', false, 3);
        break;
      case 'imp':
        if (ec.dative) vote(G, `verb:${c.label}+dative`, false, 3);
        break;
      case 'gave':
        if (ec.giveTo || ec.pron1) vote(G, `verb:${c.label}+to`, true, 4);
        else if (ec.dative) vote(G, `verb:${c.label}+dative`, false, 3);
        else vote(R, `verb:${c.label}`, true, 4);
        break;
      case 'label':
        if (c.label === 'credit' && ec.creditLa) vote(G, 'label:credit-la', true, 4);
        else vote(c.dir!, `label:${c.label}${fz(c)}`, !c.fuzzy, 4);
        break;
      case 'upi':
        vote(R, `upi:${c.label}`, true, 4);
        break;
      case 'shop':
        if (!has('bare') && !has('kudu3p')) vote(R, 'shop-recipient', false, 2);
        break;
      default:
        break;
    }
  }
  if (gw || rw) {
    const fromSide = (dir: 'GIVE' | 'RECEIVE') => reasons.filter((r) => r.dir === dir);
    if (gw && rw) {
      const win = gw >= 2 * rw ? G : rw >= 2 * gw ? R : null;
      if (!win) {
        return { kind: null, reason: `conflict:${reasons.map((r) => r.reason).join('/')}`, explicit: false, weak: true, own: true };
      }
      return { kind: win, reason: `mixed:${fromSide(win)[0].reason}`, explicit: false, weak: false, own: true };
    }
    const dir = gw ? G : R;
    const side = fromSide(dir);
    const thiruppi = dir === R && has('thiruppi') ? '+thiruppi' : '';
    return { kind: dir, reason: side[0].reason + thiruppi, explicit: side.some((r) => r.explicit), weak: false, own: true };
  }
  // no verb: light verbs, account, nouns, dative, items
  const light = has('light');
  const account = has('account');
  if (has('imp') && (has('noun') || ec.creditLa || account)) return { kind: G, reason: 'verb:kudu+kadan', explicit: false, weak: false, own: true };
  if (has('imp')) return { kind: null, reason: 'verb:kudu-unclear', explicit: false, weak: true, own: true };
  if (account && (light || ec.cues.length === 1)) {
    return { kind: G, reason: light ? 'idiom:kanakkula-ezhuthu' : 'idiom:kanakkula', explicit: light, weak: false, own: true };
  }
  if (ec.creditLa) return { kind: G, reason: 'label:credit-la', explicit: true, weak: false, own: true };
  if (has('noun')) return { kind: G, reason: 'noun:kadan', explicit: false, weak: false, own: true };
  if (ec.dative) return { kind: G, reason: 'dative', explicit: false, weak: false, own: true };
  if (light) return { kind: G, reason: 'light:ezhuthu', explicit: false, weak: false, own: true };
  if (has('baaki')) return { kind: G, reason: 'noun:baaki', explicit: false, weak: true, own: true };
  if (has('thiruppi')) return { kind: R, reason: 'thiruppi', explicit: false, weak: true, own: true };
  if (ec.items) return { kind: G, reason: 'item', explicit: false, weak: true, own: true };
  return { kind: null, reason: null, explicit: false, weak: false, own: false };
}

// ================================================================== entries

interface Entry {
  from: number;
  to: number;
}

interface Built {
  intent: VoiceIntent;
  kr: KindResult;
  /** for alternative scoring */
  score: number;
  unknown: number;
  words: number;
  /** a dative (-kku on the name, avanukku, "to") was heard in this entry */
  dative: boolean;
  /** another alternative heard a different amount for this entry (confidence capped at 'medium') */
  amountDisputed?: boolean;
}

/** The direction rests on a dative alone (no explicit verb or label): blanked when alternatives disagree on it. */
function dativeDecided(kr: KindResult): boolean {
  return !!kr.kind && !!kr.reason && (kr.reason === 'dative' || kr.reason.endsWith('+dative'));
}

function isNameish(t: Tok): boolean {
  return UNKNOWN_LIKE.has(t.type);
}

/** Tag tokens with customer knowledge: name collisions and fuzzy cues. */
function refineTokens(toks: Tok[], idx: IndexedCustomer[]): void {
  const firstNames = new Set<string>();
  for (const ic of idx) for (const f of ic.firstWords) firstNames.add(f);
  for (const t of toks) {
    if (!t.fold) continue;
    const nk = nameKey(t.surface);
    if ((t.type === 'numword' || t.type === 'item' || (t.type === 'cue' && (t.cue!.type === 'noun' || t.cue!.type === 'baaki' || t.cue!.type === 'light'))) && firstNames.has(nk)) {
      t.alsoName = true;
    }
    if (t.type !== 'name') continue;
    // a good customer match keeps it a name; otherwise try a misspelt cue
    const exactish = idx.some((ic) => ic.forms.some((f) => f.split(' ').some((w) => sim(w, nk) >= 0.8)));
    if (!exactish) {
      const fc = fuzzyCue(t.fold.replace(/c/g, 's'));
      if (fc) { t.type = 'cue'; t.cue = fc; continue; }
    }
    const cands = suffixCandidates(t);
    if (cands.length) {
      const fullScore = idx.reduce((m, ic) => Math.max(m, ...ic.forms.map((f) => sim(f.split(' ')[0], nk))), 0);
      let pick: (typeof cands)[number] | null = null;
      let pickScore = -1;
      for (const c of cands) {
        const sc = idx.reduce((m, ic) => Math.max(m, ...ic.forms.map((f) => Math.max(sim(f.split(' ')[0], nameKey(c.surface)), 0.95 * sim(dropU(f.split(' ')[0]), dropU(nameKey(c.surface)))))), 0);
        if (sc > pickScore) { pick = c; pickScore = sc; }
      }
      // keep the whole word when it already is a customer's name ("Muruku"?) and the stripped form is not better
      if (pick && (pickScore >= fullScore || fullScore < 0.85)) t.suffix = pick;
    }
  }
}

/**
 * Participle + auxiliary: "koduthu vittaan" (gave away), "vaangi irukkaan" (has taken), "kuduthuttu poyittaan".
 * The auxiliary carries the person, so the pair reads like the finite verb.
 */
const PARTICIPLES: { re: RegExp; p3: Omit<Cue, 'forms'>; p1: Omit<Cue, 'forms'> | null }[] = [
  { re: /^(kutut|kotut)(u|utu|itu)$/, p3: { label: 'kuduthaan', type: 'kudu3p', dir: R }, p1: { label: 'kuduthen', type: 'verb', dir: G } },
  { re: /^(vanki|vankit|vankitu)$/, p3: { label: 'vaanginaan', type: 'verb', dir: G }, p1: { label: 'vaanginen', type: 'verb', dir: R } },
  { re: /^(kati|katit|katitu)$/, p3: { label: 'kattinaan', type: 'verb', dir: R }, p1: null },
  { re: /^(etutu|etututu)$/, p3: { label: 'eduthaan', type: 'verb', dir: G }, p1: null },
];
const AUX3 = /^(vit|iruk|poyit|poit|pon|ponn)(an|al|ar|aru|anka|ankal|a)$/;
const AUX1 = /^(vit|iruk)(en|om|ken|kom)$/;

function resolveParticiples(toks: Tok[]): void {
  for (let x = 0; x + 1 < toks.length; x++) {
    const a = toks[x];
    const b = toks[x + 1];
    if (!a.fold || !b.fold || (a.type !== 'name' && a.type !== 'cue')) continue;
    const pp = PARTICIPLES.find((p) => p.re.test(a.fold));
    if (!pp) continue;
    const third = AUX3.test(b.fold);
    const first = AUX1.test(b.fold);
    const c = third ? pp.p3 : first ? pp.p1 : null;
    if (!c) continue;
    a.type = 'cue';
    a.cue = { label: c.label, type: c.type, dir: c.dir };
    b.type = 'stop';
    b.cue = undefined;
  }
}

/**
 * "Anju 100 kuduthaachu": Anju is a customer and also the number 5. An isolated number word (no number word
 * or rupee/quantity word next to it) that is a customer's first name becomes a name when another number is
 * spoken elsewhere.
 */
function resolveNameCollisions(toks: Tok[]): void {
  const numberish = (t: Tok | undefined) => !!t && (t.type === 'numword' || t.type === 'rupee' || t.type === 'qty' || t.type === 'paise' || t.type === 'and');
  toks.forEach((t, x) => {
    if (t.type !== 'numword' || !t.alsoName) return;
    if (numberish(toks[x - 1]) || numberish(toks[x + 1])) return;
    const other = toks.some((o, y) => y !== x && (o.type === 'digits' || (o.type === 'numword' && !o.alsoName && o.atoms![0].cls !== 'half')));
    if (other) { t.type = 'name'; t.atoms = undefined; }
  });
}

function splitEntries(toks: Tok[], runs: NumRun[]): Entry[] {
  const runAt = new Map<number, NumRun>();
  for (const r of runs) runAt.set(r.i, r);
  const laterNumber = (x: number) => runs.some((r) => r.i > x);
  const entries: Entry[] = [];
  let from = 0;
  let hasName = false;
  let hasAmount = false;
  let i = 0;
  const close = (at: number) => {
    entries.push({ from, to: at });
    from = at;
    hasName = false;
    hasAmount = false;
  };
  while (i < toks.length) {
    const t = toks[i];
    const r = runAt.get(i);
    if (r) {
      const after = toks[r.j];
      const before = toks[r.i - 1];
      const isQty = after && after.type === 'qty';
      const isCode = before && before.type === 'code';
      if (!isQty && !isCode) hasAmount = true;
      i = r.j;
      continue;
    }
    if (t.type === 'sep' && (hasAmount || hasName) && hasAmount) {
      close(i + 1);
      i++;
      continue;
    }
    const nameLike = isNameish(t) || (t.alsoName && !hasName && !hasAmount);
    if (nameLike) {
      if (hasName && hasAmount && laterNumber(i)) close(i);
      hasName = true;
    }
    i++;
  }
  entries.push({ from, to: toks.length });
  // merge entries without name and amount into the previous one (trailing verbs, stray separators)
  const out: Entry[] = [];
  for (const e of entries) {
    const slice = toks.slice(e.from, e.to);
    const meaningful = slice.some((t) => isNameish(t) || t.alsoName) || runs.some((r) => r.i >= e.from && r.j <= e.to);
    if (!meaningful && out.length) out[out.length - 1].to = e.to;
    else if (!meaningful && !out.length && entries.length > 1) {
      // leading noise: glue to the next
      const nx = entries[entries.indexOf(e) + 1];
      if (nx) nx.from = e.from;
    } else out.push({ ...e });
  }
  return out.length ? out : [{ from: 0, to: toks.length }];
}

function buildEntry(
  heard: string, toks: Tok[], runs: NumRun[], e: Entry, idx: IndexedCustomer[], customers: VoiceCustomer[],
  settings: VoiceSettings, opts: ParseOptions,
): Built {
  const pick = pickAmount(toks, runs, e.from, e.to);
  const ec: EntryCues = { cues: [], dative: false, pron1: false, giveTo: false, creditLa: false, items: false, negWord: false };
  let dateOff: 0 | -1 | -2 | undefined;
  let mode: 'UPI' | undefined;
  let query = false;
  const nameIdx: number[] = [];
  const itemIdx: number[] = [];
  const noteIdx = new Set<number>();
  let codeMatch: CustomerMatch[] | null = null;
  for (const cr of pick.codeRuns) {
    const n = Math.round(cr.rupees);
    const hits = idx.filter((ic) => ic.c.code === n).map((ic) => ({ id: ic.c.id, score: 1 }));
    codeMatch = hits;
  }
  for (const [a, b] of pick.qty) for (let x = a; x < b; x++) noteIdx.add(x);
  const amountRun = pick.run;
  // has the amount been passed at token x?
  const amountBefore = (x: number) => (amountRun ? amountRun.j <= x : runs.some((r) => r.i >= e.from && r.j <= x));
  for (let x = e.from; x < e.to; x++) {
    const t = toks[x];
    if (pick.used.has(x)) continue;
    switch (t.type) {
      case 'cue': {
        const c = t.cue!;
        if (t.alsoName && !nameIdx.length && !amountBefore(x) && (c.type === 'noun' || c.type === 'baaki' || c.type === 'light')) { nameIdx.push(x); break; }
        if (c.type === 'upi') mode = 'UPI';
        if (c.type === 'baaki' && toks.slice(e.from, e.to).some((y) => y.type === 'query')) query = true;
        if (c.label === 'credit' && (t.locative || ['la', 'le', 'il', 'ல', 'லே'].includes(toks[x + 1]?.raw ?? '') || toks[x - 1]?.raw === 'on')) ec.creditLa = true;
        ec.cues.push(c);
        break;
      }
      case 'pron1': ec.pron1 = true; break;
      case 'dativePron': ec.dative = true; break;
      case 'stop': if (t.honorificDative && nameIdx.length) ec.dative = true; break;
      case 'to': {
        const nx = toks[x + 1];
        if (nx && (isNameish(nx) || nx.alsoName)) ec.giveTo = true;
        break;
      }
      case 'date': dateOff = t.dateOff; break;
      case 'query': query = true; break;
      case 'item':
        if (t.alsoName && !nameIdx.length && !amountBefore(x)) { nameIdx.push(x); break; }
        itemIdx.push(x);
        break;
      case 'numword':
        if (t.alsoName && !nameIdx.length) nameIdx.push(x);
        break;
      case 'name':
        nameIdx.push(x);
        break;
      default:
        break;
    }
  }
  // name correction: "Sita illa Seetha" -> keep the part after the last NEG that sits between name tokens
  let names = nameIdx;
  for (let x = names.length - 1; x > 0; x--) {
    const a = names[x - 1];
    const b = names[x];
    if (toks.slice(a + 1, b).some((t) => t.type === 'neg')) { names = names.slice(x); break; }
  }
  // the name is the contiguous group of name tokens; score sub-spans and keep the best
  // item words may be part of a customer's name ("Velu Tea Kadai"), so groups run over names and items
  const groups: number[][] = [];
  const nameSet = new Set(names);
  for (const x of [...names, ...itemIdx.filter((i) => !names.length || i > names[0])].sort((a, b) => a - b)) {
    const g = groups[groups.length - 1];
    if (g && x === g[g.length - 1] + 1) g.push(x); else groups.push([x]);
  }
  let best: { span: number[]; matches: CustomerMatch[]; top: number } | null = null;
  const nameSurface = (span: number[]) => span.map((x) => toks[x].suffix?.surface ?? toks[x].surface).join(' ');
  for (const g of groups) {
    for (let a = 0; a < g.length; a++) {
      for (let b = a + 1; b <= Math.min(g.length, a + 3); b++) {
        const span = g.slice(a, b);
        if (!nameSet.has(span[0]) || !nameSet.has(span[span.length - 1])) continue;
        const ms = matchCustomers(nameSurface(span), customers);
        const top = (ms[0]?.score ?? 0) - (groups.indexOf(g) > 0 ? 0.05 : 0) - a * 0.03 + (b - a) * 0.001;
        if (!best || top > best.top) best = { span, matches: ms, top };
      }
    }
  }
  const firstNameGroup = groups.map((g) => g.filter((x) => nameSet.has(x))).find((g) => g.length) ?? [];
  if (!best && firstNameGroup.length) best = { span: firstNameGroup, matches: [], top: 0 };
  let matches = best?.matches ?? [];
  // the first name group defines name_text if nothing matched
  const nameSpan = best && best.matches.length ? best.span : firstNameGroup;
  for (const x of itemIdx) if (!nameSpan.includes(x)) { noteIdx.add(x); ec.items = true; }
  if (codeMatch && codeMatch.length) matches = codeMatch.slice(0, 3);
  // words next to the matched name that are not part of it ("Ramu tea kadai" for customer "Ramu") go to the note
  const chosenGroup = groups.find((g) => nameSpan.length && g.includes(nameSpan[0]));
  if (chosenGroup && best && best.matches.length) for (const x of chosenGroup) if (!nameSpan.includes(x) && nameSet.has(x)) noteIdx.add(x);
  const afterName = nameSpan.length ? toks[afterNameIndex(toks, nameSpan[nameSpan.length - 1])] : undefined;
  ec.dative = ec.dative || nameSpan.some((x) => !!toks[x].suffix?.dative) || (!!afterName && DATIVE_PARTICLE.has(afterName.raw));
  // English "gave Ramu 100" (imperative/speaker) is handled by "to"/"I"; "gave to Ramu" sets giveTo.
  const name_text = nameSpan.length ? nameSurface(nameSpan) : null;
  const kr: KindResult = resolveKind(ec, settings);
  // note: item and quantity words in reading order, as heard
  const noteToks = [...noteIdx].sort((a, b) => a - b).filter((x) => toks[x] && toks[x].type !== 'sep');
  const note = noteToks.length ? noteToks.map((x) => toks[x].surface).join(' ') : null;

  let contextKept: boolean | undefined;
  if (opts.contextCustomerId) {
    const ctxId = opts.contextCustomerId;
    if (!nameSpan.length && !codeMatch) {
      matches = [{ id: ctxId, score: 1 }];
      contextKept = true;
    } else {
      // the page's customer stays unless another customer clearly beats it (finding 9: two Ramus)
      const ctxC = customers.find((c) => c.id === ctxId);
      let ctxScore = 0;
      if (codeMatch) ctxScore = codeMatch.some((m) => m.id === ctxId) ? 1 : 0;
      else if (ctxC && name_text) ctxScore = matchCustomers(name_text, [ctxC], 1)[0]?.score ?? 0;
      const top = matches[0]?.score ?? 0;
      if (ctxScore >= MATCH_FLOOR && top - ctxScore < 0.1) {
        matches = [{ id: ctxId, score: ctxScore }];
        contextKept = true;
      } else {
        contextKept = false;
      }
    }
  }
  const intent: VoiceIntent = {
    heard,
    name_text,
    matches,
    amount_paise: pick.paise,
    kind: kr.kind,
    kind_reason: kr.reason,
    note,
    confidence: 'low',
  };
  if (pick.run && pick.paise !== null) intent.amount_text = heard.normalize('NFC').slice(pick.run.start, pick.run.end).trim();
  if (pick.candidates.length) intent.amount_candidates = pick.candidates;
  if (contextKept !== undefined) intent.context_kept = contextKept;
  if (dateOff !== undefined) intent.date_offset = dateOff;
  if (mode) intent.mode = mode;
  if (query && pick.paise === null) {
    intent.balance_query = true;
    intent.kind = null;
    intent.kind_reason = 'balance-query';
    kr.kind = null;
  }

  let unknown = 0;
  let words = 0;
  for (let x = e.from; x < e.to; x++) {
    const t = toks[x];
    if (t.type === 'sep') continue;
    words++;
    if (t.type === 'name' && !nameSpan.includes(x)) unknown++;
  }
  const top = matches[0]?.score ?? 0;
  const score = top + (pick.paise !== null ? 1 : pick.candidates.length ? 0.4 : 0) + (kr.kind ? (kr.explicit ? 1 : 0.7) : 0);
  return { intent, kr, score, unknown, words, dative: ec.dative };
}

/**
 * 'high' only when exactly one customer is clearly best (or the page's customer was kept with a good match),
 * the amount parsed and no alternative disputes it, and the direction comes from an explicit verb or label
 * (never from the bare-kuduthaachu setting, a dative alone, a fuzzy verb, a mixed vote or an item).
 */
function confidenceOf(b: Built, opts: ParseOptions): 'high' | 'medium' | 'low' {
  const { intent, kr } = b;
  if (intent.amount_paise === null || intent.kind === null) return 'low';
  const ms = intent.matches;
  const top = ms[0]?.score ?? 0;
  const second = ms[1]?.score ?? 0;
  const ctx = !!opts.contextCustomerId && intent.context_kept === true;
  const nameClear = ctx ? top >= 0.85 : top >= 0.85 && top - second >= 0.1;
  const nameOk = ctx || top >= 0.7;
  if (kr.weak || !nameOk) return 'low';
  if (b.amountDisputed || dativeDecided(kr) || kr.reason === 'bare-kuduthaachu') return 'medium';
  if (kr.explicit && nameClear) return 'high';
  return 'medium';
}

function parseAlternative(heard: string, customers: VoiceCustomer[], settings: VoiceSettings, opts: ParseOptions): { built: Built[]; score: number } {
  const idx = indexCustomers(customers);
  const { toks } = tokenize(heard);
  refineTokens(toks, idx);
  resolveParticiples(toks);
  resolveNameCollisions(toks);
  const runs = numberRuns(toks);
  const entries = splitEntries(toks, runs);
  const built = entries.map((e) => buildEntry(heard.trim(), toks, runs, e, idx, customers, settings, opts));
  // inheritance: an entry with no cue of its own takes the nearest explicit direction in the sentence
  for (let i = 0; i < built.length; i++) {
    const b = built[i];
    if (b.kr.own || b.intent.balance_query) continue;
    const order = [...built.slice(i + 1), ...built.slice(0, i).reverse()];
    const src = order.find((o) => o.kr.own && o.intent.kind && !o.kr.reason?.startsWith('item'));
    if (src) {
      b.intent.kind = src.intent.kind;
      b.intent.kind_reason = `inherited:${src.intent.kind_reason}`;
      b.kr = { kind: src.intent.kind, reason: b.intent.kind_reason, explicit: false, weak: false, own: false };
    }
  }
  const words = built.reduce((s, b) => s + b.words, 0) || 1;
  const unknown = built.reduce((s, b) => s + b.unknown, 0);
  const score = built.reduce((s, b) => s + b.score, 0) / built.length - 0.5 * (unknown / words);
  return { built, score };
}

/**
 * Parse a spoken utterance. `alternatives` are the recogniser's guesses, best first. Every alternative is
 * parsed and scored (customer match + amount + direction - unknown words); the best one wins. When another
 * close alternative reads the opposite direction for the same entry and amount (typically "Ramukku" vs "Ramu"),
 * the direction is blanked: kind null, reason 'conflict:alternatives'.
 */
export function parseUtterance(
  alternatives: string[], customers: VoiceCustomer[], settings?: Partial<VoiceSettings>, opts: ParseOptions = {},
): VoiceIntent[] {
  const st: VoiceSettings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const alts = (alternatives ?? []).map((a) => String(a ?? '').trim()).filter(Boolean).slice(0, 5);
  if (!alts.length) return [];
  const parsed = alts.map((a, i) => ({ i, ...parseAlternative(a, customers, st, opts) }));
  for (const p of parsed) p.score -= 0.03 * p.i;
  const best = parsed.reduce((a, b) => (b.score > a.score + 1e-9 ? b : a));
  // conflict checks against the other alternatives (same number of entries)
  for (const p of parsed) {
    if (p === best || p.built.length !== best.built.length) continue;
    const close = p.i <= 2 && p.score >= best.score - 0.6;
    p.built.forEach((ob, k) => {
      const bb = best.built[k];
      const sameCustomer = bb.intent.matches[0]?.id === ob.intent.matches[0]?.id;
      // amount: another reading of the same entry heard a different amount (finding 8)
      if (bb.intent.amount_paise !== null && ob.intent.amount_paise !== null && bb.intent.amount_paise !== ob.intent.amount_paise
        && (sameCustomer || !ob.intent.matches.length || !bb.intent.matches.length)) {
        const list = bb.intent.amount_alternatives ?? [];
        if (!list.includes(ob.intent.amount_paise)) list.push(ob.intent.amount_paise);
        bb.intent.amount_alternatives = list;
        bb.amountDisputed = true;
      }
      if (!bb.intent.kind || !sameCustomer || bb.intent.amount_paise !== ob.intent.amount_paise) return;
      // direction decided only by a dative that this alternative did not hear ("Ramukku 100" vs "Ramu 100")
      if (dativeDecided(bb.kr) && !ob.dative && ob.intent.kind !== bb.intent.kind) {
        bb.intent.kind = null;
        bb.intent.kind_reason = `conflict:dative(${bb.kr.reason}|${ob.kr.reason ?? 'none'})`;
        bb.kr = { ...bb.kr, kind: null };
        return;
      }
      // opposite explicit readings of the same entry (typically "Ramukku" vs "Ramu" with kuduthaachu)
      if (!close || !ob.intent.kind || bb.intent.kind === ob.intent.kind) return;
      bb.intent.kind = null;
      bb.intent.kind_reason = `conflict:alternatives(${bb.kr.reason}|${ob.kr.reason})`;
      bb.kr = { ...bb.kr, kind: null };
    });
  }
  return best.built.map((b) => {
    b.intent.confidence = confidenceOf(b, opts);
    b.intent.alt_index = best.i;
    return b.intent;
  });
}

/**
 * Direction of an utterance on its own (no customer list): the verb lexicon, "-kku" dative on a name-like
 * word, the speaker pronoun, and the shop's kuduthaachu setting.
 */
export function detectKind(text: string, settings?: Partial<VoiceSettings>): { kind: 'GIVE' | 'RECEIVE' | null; reason: string | null; dativeName: boolean } {
  const st: VoiceSettings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const { toks } = tokenize(text);
  refineTokens(toks, []);
  resolveParticiples(toks);
  const ec: EntryCues = { cues: [], dative: false, pron1: false, giveTo: false, creditLa: false, items: false, negWord: false };
  let dativeName = false;
  toks.forEach((t, x) => {
    if (t.type === 'cue') {
      ec.cues.push(t.cue!);
      if (t.cue!.label === 'credit' && (t.locative || ['la', 'le', 'il', 'ல', 'லே'].includes(toks[x + 1]?.raw ?? '') || toks[x - 1]?.raw === 'on')) ec.creditLa = true;
    } else if (t.type === 'pron1') ec.pron1 = true;
    else if (t.type === 'dativePron') ec.dative = true;
    else if (t.type === 'item') ec.items = true;
    else if (t.type === 'to' && toks[x + 1] && isNameish(toks[x + 1])) ec.giveTo = true;
    else if (t.type === 'stop' && t.honorificDative) { dativeName = true; ec.dative = true; }
    else if (t.type === 'name' && (t.suffix?.dative || DATIVE_PARTICLE.has(toks[afterNameIndex(toks, x)]?.raw ?? ''))) { dativeName = true; ec.dative = true; }
  });
  const kr = resolveKind(ec, st);
  return { kind: kr.kind, reason: kr.reason, dativeName };
}

/**
 * True when an intent is unsure enough that a future helper (plan 2.6: server-side interpreter, off in this
 * build) could be asked. The UI decides; nothing here does I/O.
 */
export function needsHelp(intent: VoiceIntent): boolean {
  return intent.confidence === 'low' || intent.kind === null || intent.amount_paise === null || !intent.matches.length;
}
