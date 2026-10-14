import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { auth, ownerOnly } from '../lib/auth';
import { listDevices, toCustomerRow, toEntryRow, toShopInfo, type CustomerDb, type EntryDb } from '../lib/rows';
import { iso, istDate } from '../lib/time';

export const exportRoutes = new Hono<AppEnv>();

const PAGE = 2000;

/**
 * GET /v1/export (owner): the whole shop as an ExportFile, streamed through a TransformStream in keyset pages
 * of 2,000 rows, so the Worker never builds (or JSON.stringifies) the full copy in memory.
 */
exportRoutes.get('/export', auth, ownerOnly, (c) => {
  const db = c.env.DB;
  const shop = c.get('shop');
  const now = new Date();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const write = (s: string) => writer.write(enc.encode(s));

  async function pages<T extends { id: string }>(table: 'customers' | 'entries', map: (r: T) => unknown) {
    let after = '';
    let first = true;
    for (;;) {
      const { results } = await db
        .prepare(`SELECT * FROM ${table} WHERE shop_id = ? AND id > ? ORDER BY id LIMIT ?`)
        .bind(shop.id, after, PAGE)
        .all<T>();
      if (!results.length) return;
      await write((first ? '' : ',') + results.map((r) => JSON.stringify(map(r))).join(','));
      first = false;
      after = (results[results.length - 1] as T).id;
      if (results.length < PAGE) return;
    }
  }

  const run = async () => {
    try {
      const devices = await listDevices(db, shop.id);
      await write(
        `{"format":"kadan-kanakku-export","version":1,"exported_at":${JSON.stringify(iso(now))},` +
          `"shop":${JSON.stringify(toShopInfo(shop))},"devices":${JSON.stringify(devices)},"customers":[`,
      );
      await pages<CustomerDb>('customers', toCustomerRow);
      await write('],"entries":[');
      await pages<EntryDb>('entries', toEntryRow);
      await write(']}');
      await writer.close();
    } catch (err) {
      console.error('export failed', err instanceof Error ? err.message : 'unknown');
      await writer.abort(err).catch(() => undefined);
    }
  };
  const done = run();
  try {
    c.executionCtx.waitUntil(done);
  } catch {
    // no execution context (unit use); the stream still drives the writer
  }
  return c.body(readable, 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="kadan-kanakku-${istDate(now)}.json"`,
    'Cache-Control': 'no-store',
  });
});
