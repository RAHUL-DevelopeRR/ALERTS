import { Hono, type Context } from 'hono';
import {
  GOOGLE_EMAIL_LINK_HOURS,
  PBKDF2_DEFAULT_ITERATIONS,
  type AuthEventsResponse,
  type ConfigResponse,
  type LoginResponse,
  type NonceResponse,
  type OkResponse,
  type PreloginResponse,
  type Role,
  type UserSummary,
} from '../../../shared/protocol';
import { intVar, SERVER_VERSION, type AppEnv, type ShopRecord } from '../env';
import { audit, auditPrune, auditStatement, listAuthEvents } from '../lib/audit';
import { auth, ownerOnly } from '../lib/auth';
import { blockFromResult } from '../lib/codes';
import { pepperHash, randomToken } from '../lib/crypto';
import { googleAudiences, verifyGoogleIdToken } from '../lib/google';
import { badRequest, envelope, fail, isObj, readJson } from '../lib/http';
import {
  knownDeviceValue,
  lockPrune,
  lockRead,
  lockRecordAttempt,
  lockReset,
  readKnownDevice,
  requestSource,
  retryAfterSeconds,
  verifyKnownDevice,
} from '../lib/lockout';
import { checkNonce, consumeNonce, mintNonce } from '../lib/nonce';
import { checkClientKey, fakeSalt, normaliseUsername, parseClientKey } from '../lib/password';
import { toShopInfo } from '../lib/rows';
import {
  clearSessionCookie,
  newDeviceTail,
  parseLoginExtras,
  setKnownCookie,
  setSessionCookie,
  shopOfDevice,
  WEB_SESSION_MS,
  WEB_SHARED_SESSION_MS,
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
 * Step 1 of a password login. Real users get their stored salt; unknown, disabled and password-less users get
 * HMAC(PEPPER, 'salt:' + username) truncated to 16 bytes: same status, same shape, same work (one indexed SELECT +
 * one HMAC on both paths). The iteration count is the default for everyone (the server stores no other count), so
 * nothing in the answer depends on whether the user exists.
 */
authRoutes.post('/auth/prelogin', async (c) => {
  if (!(await ipAllowed(c, 'prelogin'))) return fail(c, 429, 'throttled');
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const username = normaliseUsername(body.username);
  if (!username) return badRequest(c, 'username');
  const [row, fake] = await Promise.all([
    c.env.DB.prepare(
      `SELECT pw_salt FROM users
       WHERE username = ? AND disabled_at IS NULL AND pw_verifier IS NOT NULL AND pw_salt IS NOT NULL`,
    )
      .bind(username)
      .first<{ pw_salt: string }>(),
    fakeSalt(c.env.PEPPER ?? '', username),
  ]);
  const res: PreloginResponse = { salt: row ? row.pw_salt : fake, iterations: PBKDF2_DEFAULT_ITERATIONS };
  return c.json(res);
});

/** A single-use nonce for Google sign-in (404 while Google sign-in is off everywhere). */
authRoutes.post('/auth/nonce', async (c) => {
  if (googleAudiences(c.env.GOOGLE_CLIENT_IDS).length === 0 && googleAudiences(c.env.GOOGLE_ANDROID_CLIENT_IDS).length === 0) {
    return fail(c, 404, 'not_found');
  }
  if (!(await ipAllowed(c, 'nonce'))) return fail(c, 429, 'throttled');
  return c.json<NonceResponse>({ nonce: await mintNonce(c.env.PEPPER ?? '', new Date()) });
});

interface LiveUser {
  id: string;
  shop_id: string;
  role: Role;
  pw_verifier: string | null;
}

/**
 * Step 2. Order: per-IP limiter, body validation (junk never touches a counter), known-device check (one indexed
 * SELECT, only when the request carries a value), the shop-wide daily failure budget (auth_failures; unknown sources
 * only), then ONE batch that atomically records this attempt as a failure for (username, source) unless that pair is
 * locked, then the constant-time verifier check. Real and unknown usernames take the same path. A success resets the
 * pair and gives the daily attempt back in the batch that creates the device.
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
  const pepper = c.env.PEPPER ?? '';
  const now = new Date();
  const knownId = await verifyKnownDevice(db, pepper, readKnownDevice(c), username);
  const source = knownId ? `known:${knownId}` : requestSource(c);
  if (!knownId && !(await reserveDailyAttempt(db, 'auth_failures', now, intVar(c.env.AUTH_THROTTLE_AFTER, 100)))) {
    return fail(c, 429, 'throttled');
  }

  const [userRes, attempt, lockRes] = await db.batch([
    db
      .prepare('SELECT id, shop_id, role, pw_verifier FROM users WHERE username = ?1 AND disabled_at IS NULL')
      .bind(username),
    lockRecordAttempt(db, username, source, now),
    lockRead(db, username, source),
    lockPrune(db, now),
    auditPrune(db, now),
  ]);
  const user = userRes?.results?.[0] as LiveUser | undefined;
  const allowed = (attempt?.results?.length ?? 0) > 0;
  // Always do the verifier work, so every path costs the same.
  const ok = await checkClientKey(pepper, clientKey, user?.pw_verifier);
  const detail = { username, source, client: extras.client };
  if (!allowed) {
    const retry = retryAfterSeconds((lockRes?.results?.[0] as { locked_until: string | null } | undefined)?.locked_until, now);
    c.header('Retry-After', String(retry));
    return fail(c, 429, 'locked', { retry_after: retry });
  }
  if (!ok || !user) {
    const lockedNow = ((attempt?.results?.[0] as { locked_until: string | null } | undefined)?.locked_until ?? null) !== null;
    await audit(db, now, {
      shopId: user?.shop_id ?? null,
      actorUserId: user?.id ?? null,
      action: lockedNow ? 'login.locked' : 'login.failed',
      targetUserId: user?.id ?? null,
      detail,
    });
    return fail(c, 403, 'invalid_login');
  }
  if (extras.client === 'web' && user.role !== 'owner') {
    await audit(db, now, { shopId: user.shop_id, actorUserId: user.id, action: 'login.refused', targetUserId: user.id, detail: { ...detail, why: 'web_owner_only' } });
    return fail(c, 403, 'web_owner_only');
  }
  const issued = await issueLogin(c, user, extras, now, {
    before: [lockReset(db, username, source)],
    giveBack: !knownId,
    action: 'login.ok',
    detail,
  });
  return issued ?? fail(c, 403, 'invalid_login');
});

/**
 * Google sign-in. The declared client kind picks the audience list (web ids are never valid for 'android'). The ID
 * token must carry a live nonce from POST /auth/nonce (consumed here). Signs in only a user the owner pre-registered:
 * google_sub already linked, or google_email equal, unlinked and set less than GOOGLE_EMAIL_LINK_HOURS ago (linked
 * now, in the same batch). Never creates users.
 */
authRoutes.post('/auth/google', async (c) => {
  const body = await readJson(c);
  if (!isObj(body) || typeof body.id_token !== 'string' || body.id_token.length > 8192) return badRequest(c, 'id_token');
  const extras = parseLoginExtras(body);
  if (typeof extras === 'string') return badRequest(c, extras);
  const audiences = googleAudiences(extras.client === 'web' ? c.env.GOOGLE_CLIENT_IDS : c.env.GOOGLE_ANDROID_CLIENT_IDS);
  if (audiences.length === 0) return fail(c, 404, 'not_found');
  if (!(await ipAllowed(c, 'google'))) return fail(c, 429, 'throttled');

  let verified: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
  try {
    verified = await verifyGoogleIdToken(body.id_token, audiences);
  } catch (err) {
    console.error('google jwks unavailable', err instanceof Error ? err.message : 'unknown');
    return fail(c, 503, 'unavailable');
  }
  if (!verified.ok) return fail(c, 403, 'invalid_token', { message: verified.error });
  const { sub, email, nonce } = verified.identity;
  const now = new Date();
  const db = c.env.DB;
  const pepper = c.env.PEPPER ?? '';
  const nonceExp = await checkNonce(pepper, nonce, now);
  if (!nonceExp || !(await consumeNonce(db, pepper, nonce as string, nonceExp, now))) {
    return fail(c, 403, 'invalid_token', { message: 'nonce' });
  }
  const linkCutoff = iso(addMs(now, -GOOGLE_EMAIL_LINK_HOURS * 3_600_000));
  const [, found] = await db.batch([
    db
      .prepare(
        `UPDATE users SET google_sub = ?1, updated_at = ?3
         WHERE google_sub IS NULL AND google_email = ?2 AND disabled_at IS NULL
           AND google_email_set_at IS NOT NULL AND google_email_set_at > ?4
           AND NOT EXISTS (SELECT 1 FROM users WHERE google_sub = ?1)`,
      )
      .bind(sub, email, iso(now), linkCutoff),
    db.prepare('SELECT id, shop_id, role, pw_verifier FROM users WHERE google_sub = ?1 AND disabled_at IS NULL').bind(sub),
  ]);
  const user = found?.results?.[0] as LiveUser | undefined;
  const detail = { source: requestSource(c), client: extras.client, email_domain: email.slice(email.lastIndexOf('@') + 1) };
  if (!user) {
    await audit(db, now, { shopId: null, action: 'google.failed', detail: { ...detail, why: 'not_linked' } });
    return fail(c, 403, 'not_linked');
  }
  if (extras.client === 'web' && user.role !== 'owner') {
    await audit(db, now, { shopId: user.shop_id, actorUserId: user.id, action: 'login.refused', targetUserId: user.id, detail: { ...detail, why: 'web_owner_only' } });
    return fail(c, 403, 'web_owner_only');
  }
  const issued = await issueLogin(c, user, extras, now, { before: [], giveBack: false, action: 'google.ok', detail });
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
    auditStatement(db, now, { shopId: dev.shop_id, actorDeviceId: dev.id, actorUserId: dev.user_id, action: 'logout', targetDeviceId: dev.id }),
  ]);
  clearSessionCookie(c);
  return c.json<OkResponse>({ ok: true, ...envelope(c, now) });
});

/** The audit trail, newest first (owner; readable from the web). */
authRoutes.get('/auth/events', auth, ownerOnly, async (c) => {
  const now = new Date();
  const events = await listAuthEvents(c.env.DB, c.get('device').shop_id);
  return c.json<AuthEventsResponse>({ events, ...envelope(c, now) });
});

/**
 * Creates the session device for `user` in ONE batch, exactly like /pair: the device row (role from the user,
 * user_id, client, web expiry), previous-device takeover (login rule: same user, or a legacy row whose token the
 * request proved), the customer-code block (not for the web), the audit row, then reads the user and the shop. The
 * INSERT re-checks disabled_at, so a user disabled meanwhile gets nothing (null -> caller answers 403).
 */
async function issueLogin(
  c: Context<AppEnv>,
  user: LiveUser,
  extras: LoginExtrasParsed,
  now: Date,
  opts: { before: D1PreparedStatement[]; giveBack: boolean; action: string; detail: Record<string, unknown> },
): Promise<Response | null> {
  const db = c.env.DB;
  const pepper = c.env.PEPPER ?? '';
  const nowIso = iso(now);
  const token = randomToken();
  const tokenHash = await pepperHash(token, pepper);
  const deviceId = crypto.randomUUID();
  const web = extras.client === 'web';
  const expires = web ? iso(addMs(now, extras.shared ? WEB_SHARED_SESSION_MS : WEB_SESSION_MS)) : null;
  const prevTokenHash = extras.prev && extras.prevToken ? await pepperHash(extras.prevToken, pepper) : null;

  const stmts: D1PreparedStatement[] = [...opts.before];
  stmts.push(
    db
      .prepare(
        `INSERT INTO devices (id, shop_id, name, role, token_hash, created_at, user_id, client, expires_at)
         SELECT ?1, shop_id, ?2, role, ?3, ?4, id, ?5, ?6 FROM users WHERE id = ?7 AND disabled_at IS NULL`,
      )
      .bind(deviceId, extras.deviceName, tokenHash, nowIso, extras.client, expires, user.id),
  );
  const tail = newDeviceTail(db, {
    deviceId,
    prev: extras.prev,
    maxLocal: extras.maxLocal,
    now,
    rule: { kind: 'login', userId: user.id, prevTokenHash, web },
    block: !web,
  });
  const blockIdx = tail.blockIdx < 0 ? -1 : stmts.length + tail.blockIdx;
  stmts.push(...tail.stmts);
  if (opts.giveBack) stmts.push(giveBackDailyAttempt(db, 'auth_failures', now, deviceId));
  stmts.push(
    auditStatement(db, now, {
      shopId: user.shop_id,
      actorDeviceId: deviceId,
      actorUserId: user.id,
      action: opts.action,
      targetDeviceId: deviceId,
      detail: { ...opts.detail, ...(extras.prev ? { previous_device_id: extras.prev } : {}), ...(extras.shared ? { shared_computer: true } : {}) },
    }),
    db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?`,
      )
      .bind(deviceId),
    shopOfDevice(db, deviceId),
  );
  const out = await db.batch(stmts);
  const summary = out[out.length - 2]?.results?.[0] as UserSummary | undefined;
  const shop = out[out.length - 1]?.results?.[0] as ShopRecord | undefined;
  if (!summary || !shop) return null;
  const block = blockIdx < 0 ? null : blockFromResult(out[blockIdx]);
  if (!web && !block) throw new Error('login: batch returned no block');
  const known = await knownDeviceValue(pepper, deviceId);
  if (web) {
    setSessionCookie(c, token, extras.shared);
    setKnownCookie(c, known);
  }
  return c.json<LoginResponse>({
    token: web ? null : token,
    device_id: deviceId,
    role: summary.role,
    shop: toShopInfo(shop),
    code_block: block,
    server_time: nowIso,
    sync_epoch: shop.sync_epoch,
    user: { id: summary.id, username: summary.username, display_name: summary.display_name, role: summary.role },
    known_device: known,
    expires_at: expires,
  });
}
