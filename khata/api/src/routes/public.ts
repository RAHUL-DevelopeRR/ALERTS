import { Hono } from 'hono';
import {
  SETUP_CODE_TTL_MIN,
  type HealthResponse,
  type PairResponse,
  type Role,
  type SetupResponse,
} from '../../../shared/protocol';
import { intVar, type AppEnv, type ShopRecord } from '../env';
import { blockFromResult, codeBlockStatements, mintPairCode } from '../lib/codes';
import { constantTimeEqual, normaliseCode, pepperHash, randomToken } from '../lib/crypto';
import { badRequest, fail, isObj, readJson } from '../lib/http';
import { toShopInfo } from '../lib/rows';
import { addMs, iso, utcDay } from '../lib/time';
import { optionalCode } from '../lib/util';

export const publicRoutes = new Hono<AppEnv>();

const THROTTLE_WINDOW_MS = 30_000;

publicRoutes.get('/health', async (c) => {
  await c.env.DB.prepare('SELECT 1').first();
  return c.json<HealthResponse>({ ok: true });
});

/** Developer bootstrap: create (or reuse) the shop and mint a first-owner pairing code. */
publicRoutes.post('/setup', async (c) => {
  const key = c.env.SETUP_KEY;
  if (!key) return fail(c, 404, 'not_found');
  if (!(await constantTimeEqual(c.req.header('X-Setup-Key') ?? '', key))) return fail(c, 403, 'forbidden');
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  let shopName = 'My Shop';
  if (body.shop_name !== undefined && body.shop_name !== null) {
    if (typeof body.shop_name !== 'string') return badRequest(c, 'shop_name');
    const t = body.shop_name.trim();
    if (t.length < 1 || t.length > 80) return badRequest(c, 'shop_name');
    shopName = t;
  }
  const now = new Date();
  const db = c.env.DB;
  const OLDEST = 'SELECT id FROM shops ORDER BY created_at, id LIMIT 1';
  const [, , shopRes] = await db.batch([
    db
      .prepare(
        `INSERT INTO shops (id, name, upi_id, lang, sync_epoch, created_at)
         SELECT ?1, ?2, NULL, 'ta', ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM shops)`,
      )
      .bind(crypto.randomUUID(), shopName, crypto.randomUUID(), iso(now)),
    db.prepare(`INSERT OR IGNORE INTO seq (shop_id, name, value) SELECT id, 'customer_code', 0 FROM (${OLDEST})`),
    db.prepare(`SELECT id, name, upi_id, lang, sync_epoch, created_at FROM shops WHERE id = (${OLDEST})`),
  ]);
  const shop = shopRes?.results?.[0] as ShopRecord | undefined;
  if (!shop) throw new Error('setup: shop missing after insert');
  // Only the newest setup code is live: a leaked older one stops working as soon as the developer mints another.
  await db.prepare(`DELETE FROM pair_codes WHERE shop_id = ? AND kind = 'setup' AND used_at IS NULL`).bind(shop.id).run();
  console.warn('setup: owner pairing code minted');
  const minted = await mintPairCode(db, c.env.PEPPER ?? '', {
    shopId: shop.id,
    role: 'owner',
    kind: 'setup',
    issuedBy: 'setup',
    now,
    ttlMin: SETUP_CODE_TTL_MIN,
  });
  return c.json<SetupResponse>({ shop: toShopInfo(shop), code: minted.code, expires_at: minted.expires_at });
});

/**
 * Pair throttle (8-digit codes only): a global per-UTC-day counter of attempts. Reserving an attempt is ONE atomic
 * statement, so a burst cannot slip past the threshold: below PAIR_THROTTLE_AFTER every attempt is allowed; past it
 * only the request that moves next_allowed_at (one per 30 s) is. A successful pairing gives its attempt back, so the
 * count is the day's failures. Never a lockout of recovery codes, never burns codes.
 */
async function reservePairAttempt(db: D1Database, now: Date, threshold: number): Promise<boolean> {
  const next = iso(addMs(now, THROTTLE_WINDOW_MS));
  const row = await db
    .prepare(
      `INSERT INTO pair_failures (day, count, next_allowed_at) VALUES (?1, 1, CASE WHEN 1 >= ?2 THEN ?3 END)
       ON CONFLICT(day) DO UPDATE SET count = count + 1,
         next_allowed_at = CASE WHEN count + 1 >= ?2 THEN ?3 ELSE next_allowed_at END
       WHERE count < ?2 OR next_allowed_at IS NULL OR next_allowed_at <= ?4
       RETURNING count`,
    )
    .bind(utcDay(now), threshold, next, iso(now))
    .first();
  return row !== null;
}

/** Recovery codes: 16 characters of the Crockford-style alphabet (80 bits, no throttle needed). */
const RECOVERY_RE = /^[0-9A-Z]{16}$/;
const PAIR_RE = /^[0-9]{8}$/;

publicRoutes.post('/pair', async (c) => {
  const db = c.env.DB;
  const pepper = c.env.PEPPER ?? '';
  const threshold = intVar(c.env.PAIR_THROTTLE_AFTER, 20);
  const now = new Date();

  // First layer: per client IP (Workers Rate Limiting binding; absent in local tests without a client IP).
  const ip = c.req.header('CF-Connecting-IP');
  if (ip && c.env.PAIR_LIMITER) {
    const { success } = await c.env.PAIR_LIMITER.limit({ key: `pair:${ip}` });
    if (!success) return fail(c, 429, 'throttled');
  }

  // The body is validated before the global throttle is touched: junk requests cannot spend its slots.
  const body = await readJson(c);
  if (!isObj(body) || typeof body.code !== 'string' || body.code.length > 64) return badRequest(c);
  const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
  if (deviceName.length < 1 || deviceName.length > 60) return badRequest(c, 'device_name');
  const maxLocal = optionalCode(body.max_local_code);
  if (maxLocal === 'invalid') return badRequest(c, 'max_local_code');
  const prev = body.previous_device_id;
  if (prev !== undefined && prev !== null && (typeof prev !== 'string' || prev.length > 64)) {
    return badRequest(c, 'previous_device_id');
  }

  const code = normaliseCode(body.code);
  const isRecovery = RECOVERY_RE.test(code);
  // A code of neither shape can never match: refused without touching the throttle (it is not a guess).
  if (!isRecovery && !PAIR_RE.test(code)) return fail(c, 403, 'invalid_code');
  // 80-bit recovery codes are excluded from every throttle side effect (the owner's way back in can't be blocked).
  if (!isRecovery && !(await reservePairAttempt(db, now, threshold))) return fail(c, 429, 'throttled');

  const codeHash = await pepperHash(code, pepper);
  const token = randomToken();
  const tokenHash = await pepperHash(token, pepper);
  const deviceId = crypto.randomUUID();
  const nowIso = iso(now);

  // ONE transaction: claim the code, create the device, revoke the phone's old device row, raise + advance the
  // customer-code sequence and record the block, give the throttle attempt back, then read the shop.
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE pair_codes SET used_at = ?1, used_by = ?2
         WHERE code_hash = ?3 AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)
         RETURNING shop_id, role, kind`,
      )
      .bind(nowIso, deviceId, codeHash),
    db
      .prepare(
        `INSERT INTO devices (id, shop_id, name, role, token_hash, created_at)
         SELECT ?1, shop_id, ?2, role, ?3, ?4 FROM pair_codes WHERE code_hash = ?5 AND used_by = ?1`,
      )
      .bind(deviceId, deviceName, tokenHash, nowIso, codeHash),
  ];
  if (typeof prev === 'string') {
    // previous_device_id is this phone's old row. Only a device of the same shop and of the same or a lower role
    // is revoked: a staff code can never revoke an owner phone (device ids are visible to every phone via pull).
    // The unused codes the old row issued (e.g. printed recovery codes) move to the new row, so they stay valid
    // and are cut off if this device is revoked later.
    stmts.push(
      db
        .prepare(
          `UPDATE devices SET revoked_at = ?1
           WHERE id = ?2 AND id <> ?3 AND revoked_at IS NULL
             AND shop_id = (SELECT shop_id FROM devices WHERE id = ?3)
             AND (role = 'staff' OR (SELECT role FROM devices WHERE id = ?3) = 'owner')`,
        )
        .bind(nowIso, prev, deviceId),
      db
        .prepare(
          `UPDATE pair_codes SET issued_by = ?1
           WHERE issued_by = ?2 AND used_at IS NULL
             AND shop_id = (SELECT shop_id FROM devices WHERE id = ?1)
             AND EXISTS (SELECT 1 FROM devices WHERE id = ?2 AND revoked_at = ?3)`,
        )
        .bind(deviceId, prev, nowIso),
    );
  }
  const blockIdx = stmts.length;
  stmts.push(...codeBlockStatements(db, deviceId, maxLocal ?? 0, now));
  if (!isRecovery) {
    stmts.push(
      db
        .prepare(
          `UPDATE pair_failures SET count = count - 1
           WHERE day = ?1 AND count > 0 AND EXISTS (SELECT 1 FROM devices WHERE id = ?2)`,
        )
        .bind(utcDay(now), deviceId),
    );
  }
  stmts.push(
    db
      .prepare(
        `SELECT s.id, s.name, s.upi_id, s.lang, s.sync_epoch, s.created_at
         FROM devices d JOIN shops s ON s.id = d.shop_id WHERE d.id = ?`,
      )
      .bind(deviceId),
  );
  const out = await db.batch(stmts);
  const claim = out[0]?.results?.[0] as { shop_id: string; role: Role; kind: string } | undefined;
  if (!claim) return fail(c, 403, 'invalid_code'); // an 8-digit attempt stays counted as a failure
  const block = blockFromResult(out[blockIdx]);
  const shop = out[out.length - 1]?.results?.[0] as ShopRecord | undefined;
  if (!block || !shop) throw new Error('pair: batch returned no block or shop');
  return c.json<PairResponse>({
    token,
    device_id: deviceId,
    role: claim.role,
    shop: toShopInfo(shop),
    code_block: block,
    server_time: nowIso,
    sync_epoch: shop.sync_epoch,
  });
});
