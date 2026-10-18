import { Hono } from 'hono';
import type { CustomerRow, EraseResponse, ShopUpdateResponse } from '../../../shared/protocol';
import type { AppEnv, ShopRecord } from '../env';
import { auditStatement } from '../lib/audit';
import { auth, ownerOnly } from '../lib/auth';
import { badRequest, envelope, fail, isObj, readJson } from '../lib/http';
import { toCustomerRow, toShopInfo } from '../lib/rows';
import { requireStepUp } from '../lib/stepup';
import { iso, istDate } from '../lib/time';

export const shopRoutes = new Hono<AppEnv>();

const UPI_RE = /^[\w.\-]{2,256}@[a-zA-Z][\w.\-]{1,64}$/;

/**
 * Owner edits the shop. The UPI id is where customers are told to pay, so changing it (set or cleared) is an
 * owner-power action: step-up (password or recovery code), from any owner session, audited as shop.update. Name and
 * language need no step-up.
 */
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
  const upiChanged = upi_id !== cur.upi_id;
  if (upiChanged) {
    const denied = await requireStepUp(c);
    if (denied) return denied;
  }
  const now = new Date();
  const dev = c.get('device');
  const db = c.env.DB;
  const changed: Record<string, unknown> = {};
  if (name !== cur.name) changed.name = name;
  if (upiChanged) changed.upi_id = upi_id;
  if (lang !== cur.lang) changed.lang = lang;
  const [upd] = await db.batch([
    db
      .prepare(
        `UPDATE shops SET name = ?1, upi_id = ?2, lang = ?3 WHERE id = ?4
         RETURNING id, name, upi_id, lang, sync_epoch, created_at`,
      )
      .bind(name, upi_id, lang, cur.id),
    ...(upiChanged
      ? [auditStatement(db, now, { shopId: cur.id, actorDeviceId: dev.id, actorUserId: dev.user_id, action: 'shop.update', detail: changed })]
      : []),
  ]);
  const row = upd?.results?.[0] as ShopRecord | undefined;
  if (!row) return fail(c, 404, 'not_found');
  return c.json<ShopUpdateResponse>({ shop: toShopInfo(row), ...envelope(c, now) });
});

/**
 * DPDP erasure: personal fields overwritten, erased_at set (terminal), one change-log row, in one batch. Irreversible,
 * so it is an owner-power action: step-up from any owner session, audited as customer.erase.
 */
shopRoutes.post('/customers/:id/erase', auth, ownerOnly, async (c) => {
  const id = c.req.param('id');
  const dev = c.get('device');
  const denied = await requireStepUp(c);
  if (denied) return denied;
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
    // Audited only when the row exists (the subquery repeats the match).
    db
      .prepare(
        `INSERT INTO auth_events (id, shop_id, at, actor_device_id, actor_user_id, action, target_user_id, target_device_id, detail)
         SELECT ?1, shop_id, ?2, ?3, ?4, 'customer.erase', NULL, NULL, ?5 FROM customers WHERE id = ?6 AND shop_id = ?7`,
      )
      .bind(crypto.randomUUID(), nowIso, dev.id, dev.user_id, JSON.stringify({ customer_id: id }), id, dev.shop_id),
  ]);
  const row = upd?.results?.[0] as CustomerRow | undefined;
  if (!row) return fail(c, 404, 'not_found');
  return c.json<EraseResponse>({ customer: toCustomerRow(row), ...envelope(c, now) });
});
