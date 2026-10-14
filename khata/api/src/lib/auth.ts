import type { MiddlewareHandler } from 'hono';
import { intVar, type AppEnv, type DeviceRecord, type ShopRecord } from '../env';
import { pepperHash } from './crypto';
import { fail } from './http';
import { iso, utcDay } from './time';

/**
 * Bearer-token auth. One round trip: the UPDATE ... RETURNING bumps last_seen_at and the per-UTC-day request
 * counter of the live device, and the shop SELECT (same batch) supplies sync_epoch.
 */
export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,200})$/.exec(c.req.header('Authorization') ?? '');
  if (!m?.[1]) return fail(c, 401, 'unauthorized');
  const hash = await pepperHash(m[1], c.env.PEPPER ?? '');
  const now = new Date();
  const day = utcDay(now);
  const db = c.env.DB;
  const [upd, shop] = await db.batch([
    db
      .prepare(
        `UPDATE devices SET last_seen_at = ?1,
           requests_today = CASE WHEN requests_day = ?2 THEN requests_today + 1 ELSE 1 END,
           requests_day = ?2
         WHERE token_hash = ?3 AND revoked_at IS NULL
         RETURNING id, shop_id, name, role, created_at, last_seen_at, revoked_at, requests_today`,
      )
      .bind(iso(now), day, hash),
    db
      .prepare(
        `SELECT s.id, s.name, s.upi_id, s.lang, s.sync_epoch, s.created_at
         FROM devices d JOIN shops s ON s.id = d.shop_id
         WHERE d.token_hash = ? AND d.revoked_at IS NULL`,
      )
      .bind(hash),
  ]);
  const device = upd?.results?.[0] as DeviceRecord | undefined;
  const shopRow = shop?.results?.[0] as ShopRecord | undefined;
  if (!device || !shopRow) {
    const revoked = await db
      .prepare('SELECT wipe_on_revoke FROM devices WHERE token_hash = ?')
      .bind(hash)
      .first<{ wipe_on_revoke: number }>();
    if (revoked) return fail(c, 401, 'revoked', { wipe: revoked.wipe_on_revoke === 1 });
    return fail(c, 401, 'unauthorized');
  }
  if (device.requests_today > intVar(c.env.DAILY_REQUEST_CAP, 5000)) return fail(c, 429, 'daily_cap');
  c.set('device', device);
  c.set('shop', shopRow);
  await next();
};

export const ownerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('device').role !== 'owner') return fail(c, 403, 'forbidden');
  await next();
};
