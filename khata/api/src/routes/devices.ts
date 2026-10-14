import { Hono } from 'hono';
import {
  PAIR_CODE_TTL_MIN,
  type CodeBlockResponse,
  type DevicesResponse,
  type MeResponse,
  type OkResponse,
  type PairCodeResponse,
  type RecoveryCodesResponse,
} from '../../../shared/protocol';
import type { AppEnv } from '../env';
import { auth, ownerOnly } from '../lib/auth';
import { blockFromResult, codeBlockStatements, mintPairCode } from '../lib/codes';
import { normaliseCode, pepperHash, randomRecoveryCode } from '../lib/crypto';
import { badRequest, envelope, fail, isObj, readJson } from '../lib/http';
import { listDevices, toDeviceInfo, toShopInfo } from '../lib/rows';
import { iso } from '../lib/time';
import { optionalCode } from '../lib/util';

export const deviceRoutes = new Hono<AppEnv>();

deviceRoutes.get('/me', auth, (c) => {
  const now = new Date();
  return c.json<MeResponse>({
    device: toDeviceInfo(c.get('device')),
    shop: toShopInfo(c.get('shop')),
    ...envelope(c, now),
  });
});

deviceRoutes.post('/devices/pair-code', auth, ownerOnly, async (c) => {
  const body = await readJson(c);
  if (!isObj(body) || (body.role !== 'owner' && body.role !== 'staff')) return badRequest(c, 'role');
  const now = new Date();
  const dev = c.get('device');
  const minted = await mintPairCode(c.env.DB, c.env.PEPPER ?? '', {
    shopId: dev.shop_id,
    role: body.role,
    kind: 'pair',
    issuedBy: dev.id,
    now,
    ttlMin: PAIR_CODE_TTL_MIN,
  });
  return c.json<PairCodeResponse>({ code: minted.code, expires_at: minted.expires_at, role: body.role, ...envelope(c, now) });
});

deviceRoutes.post('/devices/recovery-codes', auth, ownerOnly, async (c) => {
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const count = body.count ?? 5;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 3 || count > 5) return badRequest(c, 'count');
  const now = new Date();
  const dev = c.get('device');
  const pepper = c.env.PEPPER ?? '';
  const codes = Array.from({ length: count }, randomRecoveryCode);
  const hashes = await Promise.all(codes.map((x) => pepperHash(normaliseCode(x), pepper)));
  const db = c.env.DB;
  await db.batch([
    db.prepare(`DELETE FROM pair_codes WHERE shop_id = ? AND kind = 'recovery' AND used_at IS NULL`).bind(dev.shop_id),
    db
      .prepare(
        `INSERT INTO pair_codes (code_hash, shop_id, role, kind, issued_by, created_at, expires_at)
         VALUES ${hashes.map((_, i) => `(?${i + 4}, ?1, 'owner', 'recovery', ?2, ?3, NULL)`).join(', ')}`,
      )
      .bind(dev.shop_id, dev.id, iso(now), ...hashes),
  ]);
  return c.json<RecoveryCodesResponse>({ codes, ...envelope(c, now) });
});

deviceRoutes.post('/devices/code-block', auth, async (c) => {
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const maxLocal = optionalCode(body.max_local_code);
  if (maxLocal === 'invalid') return badRequest(c, 'max_local_code');
  const now = new Date();
  const out = await c.env.DB.batch(codeBlockStatements(c.env.DB, c.get('device').id, maxLocal ?? 0, now));
  const block = blockFromResult(out[0]);
  if (!block) throw new Error('code-block: no block issued');
  return c.json<CodeBlockResponse>({ ...block, ...envelope(c, now) });
});

deviceRoutes.get('/devices', auth, ownerOnly, async (c) => {
  const now = new Date();
  const devices = await listDevices(c.env.DB, c.get('device').shop_id);
  return c.json<DevicesResponse>({ devices, ...envelope(c, now) });
});

deviceRoutes.post('/devices/:id/revoke', auth, ownerOnly, async (c) => {
  const body = await readJson(c);
  if (!isObj(body) || (body.wipe !== undefined && typeof body.wipe !== 'boolean')) return badRequest(c, 'wipe');
  const id = c.req.param('id');
  const dev = c.get('device');
  if (id === dev.id) return fail(c, 400, 'cannot_revoke_self');
  const now = new Date();
  const db = c.env.DB;
  // Same transaction: the unused pair and recovery codes this device issued die with it, so a stolen phone cannot
  // leave a way back in (recovery codes never expire). Re-issue recovery codes afterwards if the revoked phone
  // minted the printed ones.
  const [upd] = await db.batch([
    db
      .prepare(
        `UPDATE devices SET revoked_at = COALESCE(revoked_at, ?1), wipe_on_revoke = ?2
         WHERE id = ?3 AND shop_id = ?4 RETURNING id`,
      )
      .bind(iso(now), body.wipe === true ? 1 : 0, id, dev.shop_id),
    db
      .prepare(
        `DELETE FROM pair_codes WHERE shop_id = ?1 AND issued_by = ?2 AND used_at IS NULL
           AND EXISTS (SELECT 1 FROM devices WHERE id = ?2 AND shop_id = ?1)`,
      )
      .bind(dev.shop_id, id),
  ]);
  if (!upd?.results?.length) return fail(c, 404, 'not_found');
  return c.json<OkResponse>({ ok: true, ...envelope(c, now) });
});
