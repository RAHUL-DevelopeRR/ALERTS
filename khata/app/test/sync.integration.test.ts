/**
 * OPTIONAL: two phones pair against a real khata-api Worker (e.g. `wrangler dev`) and converge.
 * Skipped unless both are set:
 *   KHATA_API_URL=http://127.0.0.1:8787  KHATA_SETUP_KEY=<the SETUP_KEY secret>  npx vitest run test/sync.integration.test.ts
 * The Worker's shop may already hold data from earlier runs; the phones pull it all and must still agree.
 */
import { describe, it, expect } from 'vitest';
import { openSqlJs } from '../src/db/sqljs';
import { migrate } from '../src/db/schema';
import { SqlRepo } from '../src/data/repo';
import { Engine } from '../src/sync/engine';
import { FakePlatform } from './helpers/fake-server';
import { dayBookView, ledgerView } from './helpers/sync';
import { bizDateIST } from '../src/core/ledger';

const URL_ = process.env.KHATA_API_URL;
const KEY = process.env.KHATA_SETUP_KEY;

async function phone(): Promise<{ repo: SqlRepo; engine: Engine; platform: FakePlatform }> {
  const db = await openSqlJs();
  await migrate(db);
  const repo = new SqlRepo(db);
  await repo.init();
  const platform = new FakePlatform();
  return { repo, platform, engine: new Engine(repo, platform) };
}

describe.skipIf(!URL_ || !KEY)('integration: real Worker', () => {
  it('two phones pair and converge', async () => {
    const A = await phone();
    const B = await phone();
    const tag = Date.now().toString(36);

    // A has offline history before pairing; it must be uploaded with its codes kept collision-free.
    const pre = await A.repo.createCustomer({ name: `Pre ${tag}` });
    await A.repo.addEntry({ customer_id: pre.id, kind: 'GIVE', amount_paise: 12_345 });

    await A.engine.setupAndPair(URL_!, KEY!, 'Integration Shop', `A ${tag}`);
    expect(A.engine.status()).toMatchObject({ phase: 'idle', pending: 0, error: null });

    const code = await A.engine.createPairCode('staff');
    await B.engine.pair(URL_!, code.code, `B ${tag}`);
    expect(B.engine.status()).toMatchObject({ phase: 'idle', pending: 0 });

    const k = await A.repo.createCustomer({ name: `Kamala ${tag}`, phone: '9876543210' });
    const g = await A.repo.addEntry({ customer_id: k.id, kind: 'GIVE', amount_paise: 50_000 });
    await A.repo.addEntry({ customer_id: k.id, kind: 'RECEIVE', amount_paise: 20_000, mode: 'UPI' });
    await A.engine.syncNow();
    await B.engine.syncNow();
    expect(await B.repo.balance(k.id)).toBe(30_000);

    await B.repo.addEntry({ customer_id: k.id, kind: 'GIVE', amount_paise: 1_500 });
    // Both phones reverse the same entry: exactly one reversal must count everywhere.
    await A.repo.reverseEntry(g.entry.id);
    await B.repo.reverseEntry(g.entry.id);
    await A.engine.syncNow();
    await B.engine.syncNow();
    await A.engine.syncNow();

    expect(A.engine.status()).toMatchObject({ phase: 'idle', pending: 0, rejected: 0 });
    expect(B.engine.status()).toMatchObject({ phase: 'idle', pending: 0, rejected: 0 });
    expect(await A.repo.balance(k.id)).toBe(-20_000 + 1_500);
    expect(await ledgerView(A.repo)).toEqual(await ledgerView(B.repo));
    const today = bizDateIST();
    expect(await dayBookView(A.repo, today)).toEqual(await dayBookView(B.repo, today));

    // Clean up: the owner revokes B (no wipe); B notices on its next sync.
    await A.engine.revokeDevice((await B.repo.getSettings()).device_id, false);
    expect((await B.engine.syncNow()).phase).toBe('revoked');
  }, 60_000);
});
