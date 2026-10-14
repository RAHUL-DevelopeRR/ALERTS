import { describe, expect, it } from 'vitest';
import { closingLine, entryLine, reminderText, smsText, statementText } from '../src/ui/statement-text';
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
  it('builds a compact Tamil statement with one corrected line, closing balance and UPI link', async () => {
    const { st } = await kamalaStatement();
    const txt = statementText(st, { ...OPTS, lang: 'ta' });
    const lines = txt.split('\n');
    expect(lines[0]).toBe('*Murugan Stores*');
    expect(lines[1]).toBe('கணக்கு விவரம்: *Kamala* (C-0001)');
    expect(txt).toContain('12 அக் · கொடுத்தது ₹250 · rice, dal');
    expect(txt).toContain('12 அக் · திருத்தப்பட்டது ~கொடுத்தது ₹1,500~');
    expect(txt).toContain('13 அக் · பெற்றது ₹100 · UPI');
    // The reversal itself is folded into the "corrected" line.
    expect(txt).not.toContain('திருத்தம் ');
    expect(txt).toContain('*14 அக் 2026 நிலவரப்படி நிலுவை ₹300*');
    expect(txt).toContain('UPI மூலம் செலுத்த: murugan@upi');
    expect(txt).toContain('upi://pay?pa=murugan%40upi&pn=Murugan%20Stores&cu=INR&am=300.00');
    expect(txt.trim().endsWith('நன்றி.')).toBe(true);
  });

  it('builds the English statement with opening balance and mode', async () => {
    const { st } = await kamalaStatement();
    const txt = statementText(st, { ...OPTS, lang: 'en' });
    expect(txt).toContain('Statement: *Kamala* (C-0001)');
    expect(txt).toContain('12 Oct 2026 to 14 Oct 2026');
    expect(txt).toContain('Opening balance: ₹0');
    expect(txt).toContain('12 Oct · Gave ₹150');
    expect(txt).toContain('13 Oct · Got ₹100 · UPI');
    expect(txt).toContain('*Balance due ₹300 as of 14 Oct 2026*');
    expect(txt.split('\n').filter((l) => l.includes('Gave')).length).toBe(3);
  });

  it('omits the UPI lines when nothing is due or no UPI id is set', async () => {
    const { st } = await kamalaStatement();
    const noUpi = statementText(st, { ...OPTS, upiId: null, lang: 'en' });
    expect(noUpi).not.toContain('upi://');
    const settled = statementText({ ...st, closing_paise: 0 }, { ...OPTS, lang: 'en' });
    expect(settled).toContain('*Settled, nothing due as of 14 Oct 2026*');
    expect(settled).not.toContain('upi://');
  });

  it('shows "no entries" for an empty period and an advance opening', async () => {
    const { st } = await kamalaStatement();
    const txt = statementText({ ...st, rows: [], opening_paise: -20_000, closing_paise: -20_000 }, { ...OPTS, lang: 'en' });
    expect(txt).toContain('Opening balance: Advance ₹200');
    expect(txt).toContain('No entries in this period.');
    expect(txt).toContain('*Advance ₹200 as of 14 Oct 2026*');
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
  it('prints a write-off with its reason', () => {
    expect(entryLine({ ...base, kind: 'WRITEOFF', reverses_entry_id: null, note: 'moved away' }, new Set(), 'en'))
      .toBe('1 Oct · Write-off ₹50 · moved away');
  });
});

describe('closingLine / reminderText / smsText', () => {
  it('states due, advance and settled in both languages', () => {
    expect(closingLine(125_000, '2026-10-14', 'en')).toBe('Balance due ₹1,250 as of 14 Oct 2026');
    expect(closingLine(-20_000, '2026-10-14', 'en')).toBe('Advance ₹200 as of 14 Oct 2026');
    expect(closingLine(0, '2026-10-14', 'ta')).toBe('14 அக் 2026 நிலவரப்படி கணக்கு முடிந்தது, நிலுவை இல்லை');
  });

  it('reminder carries the balance and the UPI link only when something is due', () => {
    const c = { name: 'Kamala', code: 42 };
    const r = reminderText(c, 125_000, { ...OPTS, lang: 'en' });
    expect(r.split('\n')[0]).toBe('Murugan Stores: Dear Kamala, your balance due is ₹1,250 as of 14 Oct 2026. Thank you.');
    expect(r).toContain('Pay by UPI: murugan@upi');
    expect(r).toContain('tn=Khata%20C-0042');
    const adv = reminderText(c, -5_000, { ...OPTS, lang: 'ta' });
    expect(adv).toContain('முன்பணம் ₹50');
    expect(adv).not.toContain('upi://');
  });

  it('SMS is one line with the balance; English fits one GSM segment', () => {
    const c = { name: 'Kamala', code: 42 };
    const en = smsText(c, 125_000, { ...OPTS, lang: 'en' });
    expect(en).toBe('Murugan Stores: Kamala (C-0042) balance due ₹1,250 as of 14 Oct.');
    expect(en.includes('\n')).toBe(false);
    const ta = smsText(c, 125_000, { ...OPTS, lang: 'ta' });
    expect(ta).toContain('நிலுவை ₹1,250');
    expect(smsSegments(ta).unicode).toBe(true);
    expect(smsText(c, 0, { ...OPTS, lang: 'en' })).toContain('settled');
  });
});
