import { Hono } from 'hono';
import type { CustomerRow, EraseResponse, ShopUpdateResponse } from '../../../shared/protocol';
import type { AppEnv, ShopRecord } from '../env';
import { auth, ownerOnly } from '../lib/auth';
import { badRequest, envelope, fail, isObj, readJson } from '../lib/http';
import { toCustomerRow, toShopInfo } from '../lib/rows';
import { iso, istDate } from '../lib/time';

export const shopRoutes = new Hono<AppEnv>();

const UPI_RE = /^[\w.\-]{2,256}@[a-zA-Z][\w.\-]{1,64}$/;

shopRoutes.put('/shop', auth, ownerOnly, async (c) => {
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const cur = c.get('shop');
  let { name, upi_id, lang } = cur;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return badRequest(c, 'name');
    const t = body.name.trim();
    if (t.length < 1 || t.length > 80) return badRequest(c, 'name');
    name = t;
  }
  if (body.upi_id !== undefined) {
    if (body.upi_id === null) upi_id = null;
    else if (typeof body.upi_id === 'string' && UPI_RE.test(body.upi_id.trim())) upi_id = body.upi_id.trim();
    else return badRequest(c, 'upi_id');
  }
  if (body.lang !== undefined) {
    if (body.lang !== 'ta' && body.lang !== 'en') return badRequest(c, 'lang');
    lang = body.lang;
  }
  const now = new Date();
  const row = await c.env.DB.prepare(
    `UPDATE shops SET name = ?1, upi_id = ?2, lang = ?3 WHERE id = ?4
     RETURNING id, name, upi_id, lang, sync_epoch, created_at`,
  )
    .bind(name, upi_id, lang, cur.id)
    .first<ShopRecord>();
  if (!row) return fail(c, 404, 'not_found');
  return c.json<ShopUpdateResponse>({ shop: toShopInfo(row), ...envelope(c, now) });
});

/** DPDP erasure: personal fields overwritten, erased_at set (terminal), one change-log row, in one batch. */
shopRoutes.post('/customers/:id/erase', auth, ownerOnly, async (c) => {
  const id = c.req.param('id');
  const dev = c.get('device');
  const now = new Date();
  const nowIso = iso(now);
  const db = c.env.DB;
  const [upd] = await db.batch([
    db
      .prepare(
        `UPDATE customers SET name = ?1, search_name = NULL, phone = NULL, note = NULL,
           erased_at = ?2, received_at = ?2, updated_at = ?2, updated_by = ?3
         WHERE id = ?4 AND shop_id = ?5 RETURNING *`,
      )
      .bind(`Erased ${istDate(now)}`, nowIso, dev.id, id, dev.shop_id),
    db
      .prepare(
        `INSERT INTO changelog (shop_id, tbl, row_id, device_id, received_at)
         SELECT shop_id, 'customers', id, ?1, ?2 FROM customers WHERE id = ?3 AND shop_id = ?4`,
      )
      .bind(dev.id, nowIso, id, dev.shop_id),
  ]);
  const row = upd?.results?.[0] as CustomerRow | undefined;
  if (!row) return fail(c, 404, 'not_found');
  return c.json<EraseResponse>({ customer: toCustomerRow(row), ...envelope(c, now) });
});
