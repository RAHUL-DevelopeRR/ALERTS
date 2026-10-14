import { describe, it, expect } from 'vitest';
import * as L from '../src/core/ledger';
describe('ledger smoke', () => {
  it('paise', () => {
    expect(L.toPaise('12.29')).toBe(1229);
    expect(L.toPaise('0.29')).toBe(29);
    expect(L.toPaise('1.1')).toBe(110);
    expect(L.toPaise('₹ 1,23,456.50')).toBe(12345650);
    expect(L.toPaise('௧௫௦')).toBe(15000);
    expect(() => L.toPaise('1.234')).toThrow();
    expect(() => L.toPaise('0')).toThrow();
    expect(() => L.toPaise('-5')).toThrow();
    expect(L.formatINR(12345650)).toBe('₹1,23,456.50');
    expect(L.formatINR(25000)).toBe('₹250');
    expect(L.formatINR(-150000, { signed: true })).toBe('−₹1,500');
    expect(L.amountInWords(12345650, 'en')).toBe('One lakh twenty-three thousand four hundred fifty-six rupees and fifty paise');
    expect(L.amountInWords(150000, 'ta')).toBe('1 ஆயிரம் 500 ரூபாய்');
  });
  it('dates', () => {
    expect(L.bizDateIST(new Date('2026-10-12T19:00:00Z'))).toBe('2026-10-13');
    expect(L.bizDateIST(new Date('2026-10-12T18:29:59Z'))).toBe('2026-10-12');
    expect(L.istDayBoundsUTC('2026-10-13')).toEqual({ start: '2026-10-12T18:30:00.000Z', end: '2026-10-13T18:30:00.000Z' });
    expect(L.isValidDate('2026-02-30')).toBe(false);
  });
  it('phone + names', () => {
    expect(L.normalizePhone('98765 43210')).toBe('+919876543210');
    expect(L.normalizePhone('098765-43210')).toBe('+919876543210');
    expect(L.normalizePhone('+91 98765 43210')).toBe('+919876543210');
    expect(L.normalizePhone('919876543210')).toBe('+919876543210');
    expect(() => L.normalizePhone('12345')).toThrow();
    expect(L.transliterateTamil('முருகன்')).toBe('murukan');
    const key = L.searchKey({ name: 'முருகன்', search_name: 'Murugan', code: 17, phone: '+919876543210', note: '3rd street' });
    expect(L.matchesQuery(key, 'murugan 3rd')).toBe(true);
    expect(L.matchesQuery(key, 'C-0017')).toBe(true);
    expect(L.matchesQuery(key, '43210')).toBe(true);
  });
  it('entries + period', () => {
    const e = L.makeEntry({ customer_id: 'c', kind: 'RECEIVE', amount_paise: 500, mode: 'UPI', device_id: 'd', today: '2026-10-12' });
    const r = L.makeReversal(e, 'd');
    expect(r.delta_paise).toBe(500); expect(r.mode).toBe('UPI'); expect(r.biz_date).toBe('2026-10-12');
    expect(() => L.makeEntry({ customer_id: 'c', kind: 'GIVE', amount_paise: 1, biz_date: '2026-10-13', device_id: 'd', today: '2026-10-12' })).toThrow('FUTURE_DATE');
    const rows = [{ biz_date: '2026-10-01', delta_paise: 100 }, { biz_date: '2026-10-02', delta_paise: -100 }, { biz_date: '2026-10-05', delta_paise: 300 }];
    expect(L.defaultPeriod(rows, '2026-10-12')).toEqual({ from: '2026-10-05', to: '2026-10-12', kind: 'since_zero' });
    expect(L.defaultPeriod(rows.slice(0, 2), '2026-10-12')).toEqual({ from: '2026-10-01', to: '2026-10-02', kind: 'settled' });
    expect(L.upiLink('shop@okaxis', 'Ravi Stores', 125000, 'C-0042')).toBe('upi://pay?pa=shop%40okaxis&pn=Ravi%20Stores&cu=INR&am=1250.00&tn=C-0042');
    expect(L.whatsappLink('+919876543210', 'hi there')).toBe('https://wa.me/919876543210?text=hi%20there');
  });
});
describe('phonetic search', () => {
  it('finds Tamil names typed in English', () => {
    const k = L.searchKey({ name: 'முருகன்', search_name: null, code: 3, phone: null, note: null });
    expect(L.matchesQuery(k, 'murugan')).toBe(true);
    expect(L.matchesQuery(k, 'muru')).toBe(true);
    expect(L.matchesQuery(k, 'முருக')).toBe(true);
    expect(L.matchesQuery(k, 'kamala')).toBe(false);
    const s = L.searchKey({ name: 'செந்தில்', search_name: null, code: 4, phone: null, note: null });
    expect(L.matchesQuery(s, 'senthil')).toBe(true);
    const e = L.searchKey({ name: 'Kamala', search_name: null, code: 5, phone: null, note: 'blue house' });
    expect(L.matchesQuery(e, 'kamala blue')).toBe(true);
  });
});
