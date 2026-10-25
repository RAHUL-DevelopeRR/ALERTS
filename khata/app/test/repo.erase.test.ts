/** Settings → Backup → "Erase all entries and start fresh" (repo.eraseLedger). */
import { describe, expect, it } from 'vitest';
import { RepoError } from '../src/data/types';
import { makeRepo, pair } from './helpers/repo';

describe('eraseLedger', () => {
  it('empties the book on a phone that is not connected; numbers start again at C-0001; settings stay', async () => {
    const { repo } = await makeRepo();
    await repo.saveSettings({ shop_name: 'Rahul stores', lang: 'en', upi_id: 'rahul@upi' });
    await repo.setPin('2468');
    const a = await repo.createCustomer({ name: 'Ramu' });
    const b = await repo.createCustomer({ name: 'Seenu' });
    await repo.addEntry({ customer_id: a.id, kind: 'GIVE', amount_paise: 50_000 });
    await repo.addEntry({ customer_id: b.id, kind: 'RECEIVE', amount_paise: 20_000 });
    const wrong = await repo.addEntry({ customer_id: a.id, kind: 'GIVE', amount_paise: 999 });
    await repo.reverseEntry(wrong.entry.id);
    await repo.setMeta('voice_aliases', JSON.stringify({ ramu: a.id }));
    await repo.setMeta('voice_stats', JSON.stringify({ heard: 4 }));

    expect(await repo.eraseLedger()).toEqual({ customers: 2, entries: 4 });
    expect(await repo.listHome()).toEqual([]);
    expect(await repo.totals()).toMatchObject({ receivable_paise: 0 });
    expect(await repo.pendingCount()).toBe(0);
    expect(await repo.getMeta('voice_aliases')).toBeNull();
    expect(await repo.getMeta('voice_stats')).toBeNull();
    const s = await repo.getSettings();
    expect([s.shop_name, s.lang, s.upi_id, s.pin_set, s.paired]).toEqual(['Rahul stores', 'en', 'rahul@upi', true, false]);
    expect(await repo.verifyPin('2468')).toBe(true);

    const fresh = await repo.createCustomer({ name: 'Kamala' });
    expect(fresh.code).toBe(1); // C-0001 again
    expect(await repo.eraseLedger()).toEqual({ customers: 1, entries: 0 });
  });

  it('is refused on a phone connected to a shop server (sign out instead)', async () => {
    const { repo } = await makeRepo();
    await pair(repo);
    await repo.createCustomer({ name: 'Ramu' });
    const err = await repo.eraseLedger().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoError);
    expect((err as RepoError).code).toBe('ERASE_CONNECTED');
    expect((await repo.listHome()).length).toBe(1);
  });
});
