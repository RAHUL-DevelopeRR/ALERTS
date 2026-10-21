import { describe, expect, it } from 'vitest';
import { autoSaveEligible } from '../src/ui/voice/quick-save';

const base = { confidence: 'high' as const, kind: 'RECEIVE' as const, amount_paise: 10000, date_offset: undefined, amount_alternatives: [] as number[] };
const ctx = { autosave: true, confirmAbovePaise: 1_000_000, balancePaise: 25000, recentDuplicate: false };

describe('voice auto-save eligibility', () => {
  it('saves a clear entry', () => expect(autoSaveEligible(base, ctx)).toBe(true));
  it('respects the setting', () => expect(autoSaveEligible(base, { ...ctx, autosave: false })).toBe(false));
  it('never for medium/low confidence', () => {
    expect(autoSaveEligible({ ...base, confidence: 'medium' }, ctx)).toBe(false);
    expect(autoSaveEligible({ ...base, confidence: 'low' }, ctx)).toBe(false);
  });
  it('never without a direction or amount', () => {
    expect(autoSaveEligible({ ...base, kind: null }, ctx)).toBe(false);
    expect(autoSaveEligible({ ...base, amount_paise: null }, ctx)).toBe(false);
  });
  it('never for back-dated, disputed, large, duplicate or over-the-due entries', () => {
    expect(autoSaveEligible({ ...base, date_offset: -1 }, ctx)).toBe(false);
    expect(autoSaveEligible({ ...base, amount_alternatives: [100000] }, ctx)).toBe(false);
    expect(autoSaveEligible({ ...base, amount_paise: 1_000_000 }, ctx)).toBe(false);
    expect(autoSaveEligible(base, { ...ctx, recentDuplicate: true })).toBe(false);
    expect(autoSaveEligible({ ...base, amount_paise: 30000 }, ctx)).toBe(false);
  });
  it('a debit larger than the balance is fine', () => expect(autoSaveEligible({ ...base, kind: 'GIVE', amount_paise: 30000 }, ctx)).toBe(true));
});
