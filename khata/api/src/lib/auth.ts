import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { SESSION_COOKIE, WEB_CLIENT_HEADER } from '../../../shared/protocol';
import { intVar, type AppEnv, type DeviceRecord, type ShopRecord } from '../env';
import { pepperHash } from './crypto';
import { fail } from './http';
import { iso, utcDay } from './time';

type Credential = { token: string; via: 'bearer' | 'cookie' };

const TOKEN_RE = /^[A-Za-z0-9_-]{16,200}$/;

/**
 * Where the session token comes from. `Authorization: Bearer` (apps, v1 paired phones) wins when present; otherwise
 * the kk_session cookie (web), which is accepted only together with `X-KK-Client: web` on EVERY method (CSRF guard;
 * SameSite=Strict is the first layer, and a cross-site page cannot add a custom header without a CORS preflight that
 * this Worker never grants with credentials).
 */
function readCredential(c: Context<AppEnv>): Credential | 'csrf' | null {
  const authz = c.req.header('Authorization');
  if (authz !== undefined) {
    const m = /^Bearer\s+([A-Za-z0-9_-]{16,200})$/.exec(authz);
    return m?.[1] ? { token: m[1], via: 'bearer' } : null;
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie || !TOKEN_RE.test(cookie)) return null;
  if (c.req.header(WEB_CLIENT_HEADER) !== 'web') return 'csrf';
  return { token: cookie, via: 'cookie' };
}

/**
 * Session auth. One round trip: the UPDATE ... RETURNING bumps last_seen_at and the per-UTC-day request counter of
 * the live device, and the shop SELECT (same batch) supplies sync_epoch. Transport binding: web devices
 * (client = 'web') authenticate only by cookie, every other device only by Bearer. Web sessions also expire.
 */
export const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cred = readCredential(c);
  if (cred === 'csrf') return fail(c, 403, 'csrf');
  if (!cred) return fail(c, 401, 'unauthorized');
  const hash = await pepperHash(cred.token, c.env.PEPPER ?? '');
  const now = new Date();
  const nowIso = iso(now);
  const day = utcDay(now);
  const db = c.env.DB;
  const LIVE = `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)
    AND (CASE WHEN client = 'web' THEN 'cookie' ELSE 'bearer' END) = ?3`;
  const [upd, shop] = await db.batch([
    db
      .prepare(
        `UPDATE devices SET last_seen_at = ?2,
           requests_today = CASE WHEN requests_day = ?4 THEN requests_today + 1 ELSE 1 END,
           requests_day = ?4
         WHERE token_hash = ?1 AND ${LIVE}
         RETURNING id, shop_id, name, role, created_at, last_seen_at, revoked_at, requests_today, user_id, client, stepup_until, expires_at`,
      )
      .bind(hash, nowIso, cred.via, day),
    db
      .prepare(
        `SELECT s.id, s.name, s.upi_id, s.lang, s.sync_epoch, s.created_at
         FROM devices d JOIN shops s ON s.id = d.shop_id
         WHERE d.token_hash = ?1 AND ${LIVE}`, // LIVE's columns exist only in devices, so they need no prefix
      )
      .bind(hash, nowIso, cred.via),
  ]);
  const device = upd?.results?.[0] as DeviceRecord | undefined;
  const shopRow = shop?.results?.[0] as ShopRecord | undefined;
  if (!device || !shopRow) {
    const revoked = await db
      .prepare('SELECT wipe_on_revoke FROM devices WHERE token_hash = ? AND revoked_at IS NOT NULL')
      .bind(hash)
      .first<{ wipe_on_revoke: number }>();
    if (revoked) return fail(c, 401, 'revoked', { wipe: revoked.wipe_on_revoke === 1 });
    return fail(c, 401, 'unauthorized');
  }
  if (device.requests_today > intVar(c.env.DAILY_REQUEST_CAP, 10000)) return fail(c, 429, 'daily_cap');
  c.set('device', device);
  c.set('shop', shopRow);
  await next();
};

export const ownerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('device').role !== 'owner') return fail(c, 403, 'forbidden');
  await next();
};

/**
 * Owner-power routes are never available to a web session, whatever its role: a browser left open on a shared PC or
 * an XSS must not be able to create logins, mint codes or revoke phones. (The client kind is self-declared, so this is
 * defence in depth; the real gate is step-up, see lib/stepup.ts.)
 */
export const noWeb: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('device').client === 'web') return fail(c, 403, 'web_forbidden');
  await next();
};
