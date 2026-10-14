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
 * Pair throttle: global per-UTC-day failure counter. Past the threshold only one attempt per 30 s gets through
 * (claimed atomically by moving next_allowed_at); the rest are 429. Never a lockout, never burns codes.
 */
async function pairAllowed(db: D1Database, now: Date, threshold: number): Promise<boolean> {
  const day = utcDay(now);
  const row = await db.prepare('SELECT count FROM pair_failures WHERE day = ?').bind(day).first<{ count: number }>();
  if (!row || row.count < threshold) return true;
  const claimed = await db
    .prepare(
      `UPDATE pair_failures SET next_allowed_at = ?1
       WHERE day = ?2 AND (next_allowed_at IS NULL OR next_allowed_at <= ?3) RETURNING day`,
    )
    .bind(iso(addMs(now, THROTTLE_WINDOW_MS)), day, iso(now))
    .first();
  return claimed !== null;
}

async function recordPairFailure(db: D1Database, now: Date, threshold: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pair_failures (day, count, next_allowed_at) VALUES (?1, 1, CASE WHEN 1 >= ?2 THEN ?3 END)
       ON CONFLICT(day) DO UPDATE SET count = pair_failures.count + 1,
         next_allowed_at = CASE WHEN pair_failures.count + 1 >= ?2 THEN ?3 ELSE pair_failures.next_allowed_at END`,
    )
    .bind(utcDay(now), threshold, iso(addMs(now, THROTTLE_WINDOW_MS)))
    .run();
}

publicRoutes.post('/pair', async (c) => {
  const db = c.env.DB;
  const pepper = c.env.PEPPER ?? '';
  const threshold = intVar(c.env.PAIR_THROTTLE_AFTER, 20);
  const now = new Date();
  if (!(await pairAllowed(db, now, threshold))) return fail(c, 429, 'throttled');

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
  if (!/^[0-9]{8}$/.test(code) && !/^[0-9A-Z]{16}$/.test(code)) {
    await recordPairFailure(db, now, threshold);
    return fail(c, 403, 'invalid_code');
  }
  const codeHash = await pepperHash(code, pepper);
  const token = randomToken();
  const tokenHash = await pepperHash(token, pepper);
  const deviceId = crypto.randomUUID();
  const nowIso = iso(now);

  // ONE transaction: claim the code, create the device, revoke the phone's old device row,
  // raise + advance the customer-code sequence and record the block, then read the shop.
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
    stmts.push(
      db
        .prepare(
          `UPDATE devices SET revoked_at = ?1
           WHERE id = ?2 AND id <> ?3 AND revoked_at IS NULL
             AND shop_id = (SELECT shop_id FROM devices WHERE id = ?3)`,
        )
        .bind(nowIso, prev, deviceId),
    );
  }
  const blockIdx = stmts.length;
  stmts.push(...codeBlockStatements(db, deviceId, maxLocal ?? 0, now));
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
  if (!claim) {
    await recordPairFailure(db, now, threshold);
    return fail(c, 403, 'invalid_code');
  }
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
