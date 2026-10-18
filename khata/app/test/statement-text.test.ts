import { describe, expect, it } from 'vitest';
import { closingLine, entryLine, payeeName, reminderText, smsText, statementText } from '../src/ui/statement-text';
import { makeRepo } from './helpers/repo';
import type { EntryView } from '../src/data/types';
import { smsSegments } from '../src/core/ledger';

const OPTS = { shopName: 'Murugan Stores', upiId: 'murugan@upi', asOf: '2026-10-14' } as const;

async function kamalaStatement() {
  const { repo, clock } = await makeRepo('2026-10-12T05:00:00.000Z');
  const c = await repo.createCustomer({ name: 'Kamala', phone: '98765 43210' });
  await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 25_000, note: 'rice, dal' });
  clock.advance(60_000);
  const big = await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 150_000 });
  clock.advance(60_000);
  await repo.reverseEntry(big.entry.id);
  await repo.addEntry({ customer_id: c.id, kind: 'GIVE', amount_paise: 15_000, biz_date: '2026-10-12' });
  clock.set('2026-10-13T05:00:00.000Z');
  await repo.addEntry({ customer_id: c.id, kind: 'RECEIVE', amount_paise: 10_000, mode: 'UPI' });
  clock.set('2026-10-14T05:00:00.000Z');
  const p = await repo.defaultStatementPeriod(c.id);
  return { st: await repo.statement(c.id, p.from, p.to), c };
}

describe('statementText', () => {
  it('builds a compact Tamil statement in customer-side words, one cancelled line, closing balance and UPI id', async () => {
    const { st } = await kamalaStatement();
    const txt = statementText(st, { ...OPTS, lang: 'ta' });
    const lines = txt.split('\n');
    expect(lines[0]).toBe('*Murugan Stores*');
    expect(lines[1]).toBe('கணக்கு விவரம்: *Kamala* (C-0001)');
    expect(txt).toContain('12 அக். · கடனாக வாங்கியது ₹250 · rice, dal');
    expect(txt).toContain('12 அக். · ரத்து ~கடனாக வாங்கியது ₹1,500~');
    expect(txt).toContain('13 அக். · நீங்கள் செலுத்தியது ₹100 · UPI');
    // The shop's own words (Gave / Got) read backwards to the customer and are never used in the text.
    expect(txt).not.toContain('கொடுத்தது');
    expect(txt).not.toContain('பெற்றது');
    expect(txt).not.toContain('பற்று');
    // The reversal itself is folded into the "cancelled" line.
    expect(txt).not.toContain('திருத்தம் ');
    expect(txt).toContain('*14 அக். 2026 வரை நீங்கள் தர வேண்டியது ₹300*');
    expect(txt).toContain('UPI மூலம் செலுத்த: murugan@upi');
    // WhatsApp does not linkify upi://, so the raw link is left out unless asked for.
    expect(txt).not.toContain('upi://');
    expect(statementText(st, { ...OPTS, lang: 'ta', upiLink: true })).toContain('upi://pay?pa=murugan%40upi&pn=Murugan%20Stores&cu=INR&am=300.00');
    expect(txt.trim().endsWith('நன்றி.')).toBe(true);
  });

  it('builds the English statement with opening balance and mode', async () => {
    const { st } = await kamalaStatement();
    const txt = statementText(st, { ...OPTS, lang: 'en' });
    expect(txt).toContain('Statement: *Kamala* (C-0001)');
    expect(txt).toContain('12 Oct 2026 to 14 Oct 2026');
    expect(txt).toContain('Opening balance: ₹0');
    expect(txt).toContain('12 Oct · Purchase ₹150');
    expect(txt).toContain('12 Oct · Cancelled ~Purchase ₹1,500~');
    expect(txt).toContain('13 Oct · You paid ₹100 · UPI');
    expect(txt).toContain('*You owe ₹300 as of 14 Oct 2026*');
    expect(txt.split('\n').filter((l) => l.includes('Purchase')).length).toBe(3);
    expect(txt).not.toMatch(/\b(Gave|Got|Debit|Credit)\b/);
  });

  it('omits the UPI lines when nothing is due or no UPI id is set', async () => {
    const { st } = await kamalaStatement();
    const noUpi = statementText(st, { ...OPTS, upiId: null, lang: 'en', upiLink: true });
    expect(noUpi).not.toContain('upi://');
    expect(noUpi).not.toContain('Pay by UPI');
    const settled = statementText({ ...st, closing_paise: 0 }, { ...OPTS, lang: 'en', upiLink: true });
    expect(settled).toContain('*Settled, nothing due as of 14 Oct 2026*');
    expect(settled).not.toContain('upi://');
  });

  it('shows "no entries" for an empty period and an advance opening', async () => {
    const { st } = await kamalaStatement();
    const txt = statementText({ ...st, rows: [], opening_paise: -20_000, closing_paise: -20_000 }, { ...OPTS, lang: 'en' });
    expect(txt).toContain('Opening advance: ₹200');
    expect(txt).toContain('No entries in this period.');
    expect(txt).toContain('*We hold your advance of ₹200 as of 14 Oct 2026*');
    const ta = statementText({ ...st, rows: [], opening_paise: -20_000, closing_paise: -20_000 }, { ...OPTS, lang: 'ta' });
    expect(ta).toContain('முன்பு இருந்த உங்கள் முன்பணம்: ₹200');
    expect(ta).not.toContain('நிலுவை: முன்பணம்');
  });
});

describe('entryLine', () => {
  const base: EntryView = {
    id: 'a', customer_id: 'c', kind: 'REVERSAL', amount_paise: 5000, delta_paise: -5000, biz_date: '2026-10-01',
    note: null, mode: null, reverses_entry_id: 'x', device_id: 'd', created_at: '2026-10-01T00:00:00Z',
    received_at: null, server_seq: null, sync_state: 'pending', reject_reason: null, running_paise: 0,
    is_reversed: false, reversed_by: null, device_name: null,
  };
  it('prints an orphan reversal on its own line and folds a reversal of a shown entry', () => {
    expect(entryLine(base, new Set(), 'en')).toBe('1 Oct · Correction −₹50');
    expect(entryLine(base, new Set(['x']), 'en')).toBeNull();
  });
  it('prints a write-off WITHOUT its private reason', () => {
    const w: EntryView = { ...base, kind: 'WRITEOFF', reverses_entry_id: null, note: 'moved away' };
    expect(entryLine(w, new Set(), 'en')).toBe('1 Oct · Waived ₹50');
    expect(entryLine(w, new Set(), 'ta')).toBe('1 அக். · தள்ளுபடி ₹50');
  });
});

describe('closingLine / reminderText / smsText', () => {
  it('states due, advance and settled in both languages, saying who owes whom', () => {
    expect(closingLine(125_000, '2026-10-14', 'en')).toBe('You owe ₹1,250 as of 14 Oct 2026');
    expect(closingLine(-20_000, '2026-10-14', 'en')).toBe('We hold your advance of ₹200 as of 14 Oct 2026');
    expect(closingLine(125_000, '2026-10-14', 'ta')).toBe('14 அக். 2026 வரை நீங்கள் தர வேண்டியது ₹1,250');
    expect(closingLine(-20_000, '2026-10-14', 'ta')).toBe('14 அக். 2026 வரை உங்கள் முன்பணம் ₹200 எங்களிடம் உள்ளது');
    expect(closingLine(0, '2026-10-14', 'ta')).toBe('14 அக். 2026 வரை பாக்கி எதுவும் இல்லை, கணக்கு முடிந்தது');
  });

  it('reminder carries the balance and the UPI id only when something is due', () => {
    const c = { name: 'Kamala', code: 42 };
    const r = reminderText(c, 125_000, { ...OPTS, lang: 'en' });
    expect(r.split('\n')[0]).toBe('Murugan Stores: Dear Kamala, your balance due is ₹1,250 as of 14 Oct 2026. Thank you.');
    expect(r).toContain('Pay by UPI: murugan@upi');
    expect(r).not.toContain('upi://');
    expect(reminderText(c, 125_000, { ...OPTS, lang: 'en', upiLink: true })).toContain('tn=Khata%20C-0042');
    const ta = reminderText(c, 125_000, { ...OPTS, lang: 'ta' });
    expect(ta.split('\n')[0]).toBe('Murugan Stores: வணக்கம் Kamala, 14 அக். 2026 வரை நீங்கள் தர வேண்டியது ₹1,250. நன்றி.');
    const adv = reminderText(c, -5_000, { ...OPTS, lang: 'ta', upiLink: true });
    expect(adv).toContain('உங்கள் முன்பணம் ₹50 எங்களிடம் உள்ளது');
    expect(adv).not.toContain('upi://');
    expect(adv).not.toContain('UPI');
  });

  it('SMS is one line with the balance; English fits one UCS-2 segment (₹ is not GSM-7)', () => {
    const c = { name: 'Kamala', code: 42 };
    const en = smsText(c, 125_000, { ...OPTS, lang: 'en' });
    expect(en).toBe('Murugan Stores: Kamala (C-0042) balance due ₹1,250 as of 14 Oct.');
    expect(en.includes('\n')).toBe(false);
    expect(smsSegments(en).unicode).toBe(true);
    expect(smsSegments(en).segments).toBe(1);
    const ta = smsText(c, 125_000, { ...OPTS, lang: 'ta' });
    expect(ta).toBe('Murugan Stores: Kamala (C-0042) தர வேண்டியது ₹1,250 (14 அக்.)');
    expect(smsSegments(ta).unicode).toBe(true);
    expect(smsText(c, 0, { ...OPTS, lang: 'en' })).toContain('settled');
    // A Tamil shop and customer name still fit one 70-character UCS-2 segment, for due, advance and settled.
    const tamil = { ...OPTS, lang: 'ta' as const, shopName: 'ஸ்ரீ முருகன் ஸ்டோர்ஸ்' };
    const kamala = { name: 'கமலா', code: 42 };
    for (const bal of [125_000, -5_000, 0]) expect(smsSegments(smsText(kamala, bal, tamil)).segments).toBe(1);
  });
});

describe('payeeName', () => {
  it('uses the shop name unless it is Tamil (then the VPA keeps the UPI link short)', () => {
    expect(payeeName('Murugan Stores', 'm@upi')).toBe('Murugan Stores');
    expect(payeeName('முருகன் ஸ்டோர்ஸ்', 'm@upi')).toBe('m@upi');
    expect(payeeName('  ', 'm@upi')).toBe('m@upi');
  });
});
