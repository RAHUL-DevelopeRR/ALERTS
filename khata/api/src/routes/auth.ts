import { Hono, type Context } from 'hono';
import {
  PBKDF2_DEFAULT_ITERATIONS,
  type ConfigResponse,
  type LoginResponse,
  type OkResponse,
  type PreloginResponse,
  type Role,
  type UserSummary,
} from '../../../shared/protocol';
import { intVar, SERVER_VERSION, type AppEnv, type ShopRecord } from '../env';
import { auth } from '../lib/auth';
import { blockFromResult } from '../lib/codes';
import { pepperHash, randomToken } from '../lib/crypto';
import { googleAudiences, verifyGoogleIdToken } from '../lib/google';
import { badRequest, envelope, fail, isObj, readJson } from '../lib/http';
import { checkClientKey, fakeSalt, LOCK_AFTER, LOCK_BASE_S, LOCK_MAX_S, normaliseUsername, parseClientKey } from '../lib/password';
import { toShopInfo } from '../lib/rows';
import {
  clearSessionCookie,
  newDeviceTail,
  parseLoginExtras,
  setSessionCookie,
  shopOfDevice,
  WEB_SESSION_MS,
  type LoginExtrasParsed,
} from '../lib/session';
import { giveBackDailyAttempt, reserveDailyAttempt } from '../lib/throttle';
import { addMs, iso } from '../lib/time';

export const authRoutes = new Hono<AppEnv>();

/** Per-client-IP first layer (Workers Rate Limiting binding; absent in local tests without a client IP). */
async function ipAllowed(c: Context<AppEnv>, scope: string): Promise<boolean> {
  const ip = c.req.header('CF-Connecting-IP');
  if (!ip || !c.env.AUTH_LIMITER) return true;
  const { success } = await c.env.AUTH_LIMITER.limit({ key: `${scope}:${ip}` });
  return success;
}

authRoutes.get('/config', (c) => {
  return c.json<ConfigResponse>({
    google_client_id: googleAudiences(c.env.GOOGLE_CLIENT_IDS)[0] ?? null,
    auth: { password: true },
    version: SERVER_VERSION,
    server_time: new Date().toISOString(),
  });
});

/**
 * Step 1 of a password login. Real users get their stored salt and iterations; unknown, disabled and password-less
 * users get HMAC(PEPPER, 'salt:' + username) truncated to 16 bytes and the default count: same status, same shape,
 * same work (one indexed SELECT + one HMAC on both paths).
 */
authRoutes.post('/auth/prelogin', async (c) => {
  if (!(await ipAllowed(c, 'prelogin'))) return fail(c, 429, 'throttled');
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const username = normaliseUsername(body.username);
  if (!username) return badRequest(c, 'username');
  const [row, fake] = await Promise.all([
    c.env.DB.prepare(
      `SELECT pw_salt, pw_iterations FROM users
       WHERE username = ? AND disabled_at IS NULL AND pw_verifier IS NOT NULL AND pw_salt IS NOT NULL`,
    )
      .bind(username)
      .first<{ pw_salt: string; pw_iterations: number }>(),
    fakeSalt(c.env.PEPPER ?? '', username),
  ]);
  const res: PreloginResponse = row
    ? { salt: row.pw_salt, iterations: row.pw_iterations }
    : { salt: fake, iterations: PBKDF2_DEFAULT_ITERATIONS };
  return c.json(res);
});

/** SQL: the new locked_until after a failure is recorded (failed_count = the OLD value). ?2 = now. */
const NEXT_LOCK = `CASE WHEN failed_count + 1 >= ${LOCK_AFTER}
  THEN strftime('%Y-%m-%dT%H:%M:%fZ', ?2,
         '+' || MIN(${LOCK_MAX_S}, ${LOCK_BASE_S} << MIN(failed_count + 1 - ${LOCK_AFTER}, 5)) || ' seconds')
  ELSE NULL END`;
const LIVE_USER = 'SELECT 1 FROM users WHERE username = ?1 AND disabled_at IS NULL';

/**
 * Step 2. Order: per-IP limiter, body validation (junk never touches a counter), the shop-wide daily failure budget
 * (auth_failures), then ONE batch that atomically records this attempt as a failure for the username unless it is
 * locked (users.failed_count/locked_until, or login_throttle for unknown/disabled usernames, so a lockout looks the
 * same for both), then the constant-time verifier check. A success resets the counters and gives the daily attempt
 * back in the batch that creates the device.
 */
authRoutes.post('/auth/login', async (c) => {
  if (!(await ipAllowed(c, 'login'))) return fail(c, 429, 'throttled');
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const username = normaliseUsername(body.username);
  if (!username) return badRequest(c, 'username');
  const clientKey = parseClientKey(body.client_key);
  if (!clientKey) return badRequest(c, 'client_key');
  const extras = parseLoginExtras(body);
  if (typeof extras === 'string') return badRequest(c, extras);

  const db = c.env.DB;
  const now = new Date();
  const nowIso = iso(now);
  if (!(await reserveDailyAttempt(db, 'auth_failures', now, intVar(c.env.AUTH_THROTTLE_AFTER, 100)))) {
    return fail(c, 429, 'throttled');
  }

  const monthAgo = iso(addMs(now, -30 * 86_400_000));
  const [userRes, ghostRes, lockRes] = await db.batch([
    db
      .prepare(
        `UPDATE users SET failed_count = failed_count + 1, locked_until = ${NEXT_LOCK}
         WHERE username = ?1 AND disabled_at IS NULL AND (locked_until IS NULL OR locked_until <= ?2)
         RETURNING id, pw_verifier`,
      )
      .bind(username, nowIso),
    db
      .prepare(
        `INSERT INTO login_throttle (username, failed_count, locked_until, updated_at)
         SELECT ?1, 1, NULL, ?2 WHERE NOT EXISTS (${LIVE_USER})
         ON CONFLICT(username) DO UPDATE SET failed_count = failed_count + 1, locked_until = ${NEXT_LOCK}, updated_at = ?2
         WHERE locked_until IS NULL OR locked_until <= ?2
         RETURNING failed_count`,
      )
      .bind(username, nowIso),
    db
      .prepare(
        `SELECT locked_until FROM users WHERE username = ?1 AND disabled_at IS NULL
         UNION ALL
         SELECT locked_until FROM login_throttle WHERE username = ?1 AND NOT EXISTS (${LIVE_USER})`,
      )
      .bind(username),
    // Housekeeping: forget unknown-username counters untouched for 30 days.
    db.prepare('DELETE FROM login_throttle WHERE updated_at < ?').bind(monthAgo),
  ]);
  const user = userRes?.results?.[0] as { id: string; pw_verifier: string | null } | undefined;
  const ghost = ghostRes?.results?.[0];
  // Always do the verifier work, so every path costs the same.
  const ok = await checkClientKey(c.env.PEPPER ?? '', clientKey, user?.pw_verifier);
  if (!user && !ghost) {
    const until = (lockRes?.results?.[0] as { locked_until: string | null } | undefined)?.locked_until;
    const retry = until ? Math.max(1, Math.ceil((Date.parse(until) - now.getTime()) / 1000)) : LOCK_BASE_S;
    c.header('Retry-After', String(retry));
    return fail(c, 429, 'locked', { retry_after: retry });
  }
  if (!ok || !user) return fail(c, 403, 'invalid_login');
  const issued = await issueLogin(c, user.id, extras, now, { resetFailures: true, giveBack: true });
  return issued ?? fail(c, 403, 'invalid_login');
});

/**
 * Google sign-in. Signs in only a user the owner pre-registered: google_sub already linked, or google_email equal and
 * google_sub still NULL (linked now, in the same batch). Never creates users.
 */
authRoutes.post('/auth/google', async (c) => {
  const audiences = googleAudiences(c.env.GOOGLE_CLIENT_IDS);
  if (audiences.length === 0) return fail(c, 404, 'not_found');
  if (!(await ipAllowed(c, 'google'))) return fail(c, 429, 'throttled');
  const body = await readJson(c);
  if (!isObj(body) || typeof body.id_token !== 'string' || body.id_token.length > 8192) return badRequest(c, 'id_token');
  const extras = parseLoginExtras(body);
  if (typeof extras === 'string') return badRequest(c, extras);

  let verified: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
  try {
    verified = await verifyGoogleIdToken(body.id_token, audiences);
  } catch (err) {
    console.error('google jwks unavailable', err instanceof Error ? err.message : 'unknown');
    return fail(c, 503, 'unavailable');
  }
  if (!verified.ok) return fail(c, 403, 'invalid_token', { message: verified.error });
  const { sub, email } = verified.identity;
  const now = new Date();
  const db = c.env.DB;
  const [, found] = await db.batch([
    db
      .prepare(
        `UPDATE users SET google_sub = ?1, updated_at = ?3
         WHERE google_sub IS NULL AND google_email = ?2 AND disabled_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM users WHERE google_sub = ?1)`,
      )
      .bind(sub, email, iso(now)),
    db.prepare('SELECT id FROM users WHERE google_sub = ?1 AND disabled_at IS NULL').bind(sub),
  ]);
  const userId = (found?.results?.[0] as { id: string } | undefined)?.id;
  if (!userId) return fail(c, 403, 'not_linked');
  const issued = await issueLogin(c, userId, extras, now, { resetFailures: false, giveBack: false });
  return issued ?? fail(c, 403, 'not_linked');
});

/** Revokes the calling device (and the unused 8-digit codes it minted) and clears the web cookie. */
authRoutes.post('/auth/logout', auth, async (c) => {
  const dev = c.get('device');
  const now = new Date();
  const db = c.env.DB;
  await db.batch([
    db.prepare('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2').bind(iso(now), dev.id),
    db
      .prepare(`DELETE FROM pair_codes WHERE issued_by = ?1 AND kind = 'pair' AND used_at IS NULL`)
      .bind(dev.id),
  ]);
  clearSessionCookie(c);
  return c.json<OkResponse>({ ok: true, ...envelope(c, now) });
});

/**
 * Creates the session device for `userId` in ONE batch, exactly like /pair: the device row (role from the user,
 * user_id, client, web expiry), previous-device revoke + code move, customer-code block, then reads the user and the
 * shop. The INSERT re-checks disabled_at, so a user disabled meanwhile gets nothing (null -> caller answers 403).
 */
async function issueLogin(
  c: Context<AppEnv>,
  userId: string,
  extras: LoginExtrasParsed,
  now: Date,
  opts: { resetFailures: boolean; giveBack: boolean },
): Promise<Response | null> {
  const db = c.env.DB;
  const pepper = c.env.PEPPER ?? '';
  const nowIso = iso(now);
  const token = randomToken();
  const tokenHash = await pepperHash(token, pepper);
  const deviceId = crypto.randomUUID();
  const web = extras.client === 'web';
  const expires = web ? iso(addMs(now, WEB_SESSION_MS)) : null;

  const stmts: D1PreparedStatement[] = [];
  if (opts.resetFailures) {
    stmts.push(
      db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ? AND disabled_at IS NULL').bind(userId),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO devices (id, shop_id, name, role, token_hash, created_at, user_id, client, expires_at)
         SELECT ?1, shop_id, ?2, role, ?3, ?4, id, ?5, ?6 FROM users WHERE id = ?7 AND disabled_at IS NULL`,
      )
      .bind(deviceId, extras.deviceName, tokenHash, nowIso, extras.client, expires, userId),
  );
  const tail = newDeviceTail(db, { deviceId, prev: extras.prev, maxLocal: extras.maxLocal, now });
  const blockIdx = stmts.length + tail.blockIdx;
  stmts.push(...tail.stmts);
  if (opts.giveBack) stmts.push(giveBackDailyAttempt(db, 'auth_failures', now, deviceId));
  stmts.push(
    db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?`,
      )
      .bind(deviceId),
    shopOfDevice(db, deviceId),
  );
  const out = await db.batch(stmts);
  const user = out[out.length - 2]?.results?.[0] as UserSummary | undefined;
  const shop = out[out.length - 1]?.results?.[0] as ShopRecord | undefined;
  if (!user || !shop) return null;
  const block = blockFromResult(out[blockIdx]);
  if (!block) throw new Error('login: batch returned no block');
  if (web) setSessionCookie(c, token);
  return c.json<LoginResponse>({
    token: web ? null : token,
    device_id: deviceId,
    role: user.role as Role,
    shop: toShopInfo(shop),
    code_block: block,
    server_time: nowIso,
    sync_epoch: shop.sync_epoch,
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
  });
}

