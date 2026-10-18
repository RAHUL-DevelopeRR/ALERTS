import { Hono } from 'hono';
import { GOOGLE_EMAIL_LINK_HOURS, type OkResponse, type Role, type UserInfo, type UserResponse, type UsersResponse } from '../../../shared/protocol';
import type { AppEnv } from '../env';
import { auditStatement } from '../lib/audit';
import { auth, noWeb, ownerOnly } from '../lib/auth';
import { badRequest, envelope, fail, isObj, readJson } from '../lib/http';
import {
  checkClientKey,
  normaliseUsername,
  parseClientKey,
  parseDisplayName,
  parseEmail,
  parsePasswordSet,
  passwordVerifier,
} from '../lib/password';
import { requireStepUp } from '../lib/stepup';
import { addMs, iso } from '../lib/time';

export const usersRoutes = new Hono<AppEnv>();

/** users as stored in D1. */
interface UserDb {
  id: string;
  shop_id: string;
  username: string;
  display_name: string;
  role: Role;
  pw_salt: string | null;
  pw_iterations: number | null;
  pw_verifier: string | null;
  google_email: string | null;
  google_sub: string | null;
  google_email_set_at: string | null;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

const toUserInfo = (u: UserDb): UserInfo => ({
  id: u.id,
  username: u.username,
  display_name: u.display_name,
  role: u.role,
  google_email: u.google_email,
  google_linked: u.google_sub !== null,
  google_email_expires_at:
    u.google_email !== null && u.google_sub === null && u.google_email_set_at
      ? iso(addMs(new Date(u.google_email_set_at), GOOGLE_EMAIL_LINK_HOURS * 3_600_000))
      : null,
  has_password: u.pw_verifier !== null,
  created_at: u.created_at,
  updated_at: u.updated_at,
  disabled_at: u.disabled_at,
});

/** Maps a UNIQUE violation to its 409 code; anything else is rethrown. */
function uniqueConflict(err: unknown): 'username_taken' | 'google_email_taken' | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/UNIQUE constraint failed/i.test(msg)) return null;
  if (msg.includes('users.username')) return 'username_taken';
  if (msg.includes('users.google_email')) return 'google_email_taken';
  return null;
}

const getUser = (db: D1Database, id: string, shopId: string) =>
  db.prepare('SELECT * FROM users WHERE id = ? AND shop_id = ?').bind(id, shopId).first<UserDb>();

usersRoutes.get('/users', auth, ownerOnly, async (c) => {
  const now = new Date();
  const { results } = await c.env.DB.prepare('SELECT * FROM users WHERE shop_id = ? ORDER BY created_at, id')
    .bind(c.get('device').shop_id)
    .all<UserDb>();
  return c.json<UsersResponse>({ users: results.map(toUserInfo), ...envelope(c, now) });
});

/**
 * Owner creates a user (step-up; never from the web). `link_me` (role owner, caller has no user yet) attaches the
 * calling device to it: how a v1 paired owner phone creates its own login without re-pairing. While the shop has no
 * users at all, a legacy owner phone needs no step-up (bootstrap, see lib/stepup.ts).
 */
usersRoutes.post('/users', auth, ownerOnly, noWeb, async (c) => {
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const username = normaliseUsername(body.username);
  if (!username) return badRequest(c, 'username');
  const displayName = parseDisplayName(body.display_name);
  if (!displayName) return badRequest(c, 'display_name');
  if (body.role !== 'owner' && body.role !== 'staff') return badRequest(c, 'role');
  const role: Role = body.role;
  const pw = parsePasswordSet(body);
  if (typeof pw === 'string') return badRequest(c, pw);
  const email = parseEmail(body.google_email, c.env.GOOGLE_HD);
  if (email === 'invalid') return badRequest(c, 'google_email');
  if (email === 'google_email_domain') return badRequest(c, 'google_email_domain');
  if (pw === null && !email) return badRequest(c, 'password');
  if (body.link_me !== undefined && typeof body.link_me !== 'boolean') return badRequest(c, 'link_me');
  const dev = c.get('device');
  const linkMe = body.link_me === true;
  if (linkMe && role !== 'owner') return badRequest(c, 'link_me');
  if (linkMe && dev.user_id) return fail(c, 400, 'already_linked');
  const denied = await requireStepUp(c);
  if (denied) return denied;

  const now = new Date();
  const nowIso = iso(now);
  const id = crypto.randomUUID();
  const verifier = pw ? await passwordVerifier(c.env.PEPPER ?? '', pw.clientKey) : null;
  const db = c.env.DB;
  const stmts = [
    db
      .prepare(
        `INSERT INTO users (id, shop_id, username, display_name, role, pw_salt, pw_iterations, pw_verifier,
           google_email, google_sub, google_email_set_at, created_at, updated_at, disabled_at, failed_count, locked_until)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?11, ?10, ?10, NULL, 0, NULL)
         RETURNING *`,
      )
      .bind(id, dev.shop_id, username, displayName, role, pw?.salt ?? null, pw?.iterations ?? null, verifier, email ?? null, nowIso, email ? nowIso : null),
    auditStatement(db, now, {
      shopId: dev.shop_id,
      actorDeviceId: dev.id,
      actorUserId: dev.user_id,
      action: 'user.create',
      targetUserId: id,
      detail: { username, role, has_password: pw !== null, google_email: email ?? null, link_me: linkMe },
    }),
  ];
  if (linkMe) {
    stmts.push(db.prepare('UPDATE devices SET user_id = ?1 WHERE id = ?2 AND user_id IS NULL').bind(id, dev.id));
  }
  let out: D1Result[];
  try {
    out = await db.batch(stmts);
  } catch (err) {
    const conflict = uniqueConflict(err);
    if (conflict) return fail(c, 409, conflict);
    throw err;
  }
  const row = out[0]?.results?.[0] as UserDb | undefined;
  if (!row) throw new Error('users: insert returned nothing');
  return c.json<UserResponse>({ user: toUserInfo(row), ...envelope(c, now) });
});

/**
 * Owner edits a user (never from the web; step-up when role, google_email or disabled is touched). The UPDATE itself
 * carries the last-owner guard, so two owners demoting each other at once can never leave the shop without an
 * enabled owner user. Disabling revokes that user's devices and deletes the unused codes they issued; a role change
 * is applied to the user's live devices, in the same batch.
 */
usersRoutes.put('/users/:id', auth, ownerOnly, noWeb, async (c) => {
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const dev = c.get('device');
  const id = c.req.param('id');
  const target = await getUser(c.env.DB, id, dev.shop_id);
  if (!target) return fail(c, 404, 'not_found');

  let displayName = target.display_name;
  if (body.display_name !== undefined) {
    const d = parseDisplayName(body.display_name);
    if (!d) return badRequest(c, 'display_name');
    displayName = d;
  }
  let role = target.role;
  if (body.role !== undefined) {
    if (body.role !== 'owner' && body.role !== 'staff') return badRequest(c, 'role');
    role = body.role;
  }
  const email = parseEmail(body.google_email, c.env.GOOGLE_HD);
  if (email === 'invalid') return badRequest(c, 'google_email');
  if (email === 'google_email_domain') return badRequest(c, 'google_email_domain');
  if (body.disabled !== undefined && typeof body.disabled !== 'boolean') return badRequest(c, 'disabled');
  const isSelf = dev.user_id === id;
  if (isSelf && role !== target.role) return fail(c, 400, 'cannot_change_own_role');
  if (isSelf && body.disabled === true) return fail(c, 400, 'cannot_disable_self');
  const sensitive = body.role !== undefined || body.google_email !== undefined || body.disabled !== undefined;
  if (sensitive) {
    const denied = await requireStepUp(c);
    if (denied) return denied;
  }

  const now = new Date();
  const nowIso = iso(now);
  const disabledAt = body.disabled === true ? (target.disabled_at ?? nowIso) : body.disabled === false ? null : target.disabled_at;
  const googleEmail = email === undefined ? target.google_email : email;
  // A different address unlinks the old Google account (the new one links on its first sign-in, within 48 h).
  // Sending the SAME still-unlinked address again restarts the 48 h window (how the owner re-opens an expired one).
  const emailChanged = googleEmail !== target.google_email;
  const googleSub = emailChanged ? null : target.google_sub;
  const emailSetAt =
    email === undefined || googleEmail === null
      ? googleEmail === null ? null : target.google_email_set_at
      : emailChanged || target.google_sub === null
        ? nowIso
        : target.google_email_set_at;
  if (googleEmail === null && target.pw_verifier === null) return badRequest(c, 'google_email');
  const losesOwner = target.role === 'owner' && target.disabled_at === null && (role !== 'owner' || disabledAt !== null);

  const db = c.env.DB;
  const changed: Record<string, unknown> = {};
  if (displayName !== target.display_name) changed.display_name = displayName;
  if (role !== target.role) changed.role = role;
  if (emailChanged || emailSetAt !== target.google_email_set_at) changed.google_email = googleEmail;
  if (disabledAt !== target.disabled_at) changed.disabled = disabledAt !== null;
  const stmts = [
    db
      .prepare(
        `UPDATE users SET display_name = ?1, role = ?2, google_email = ?3, google_sub = ?4, disabled_at = ?5,
           updated_at = ?6, google_email_set_at = ?10
         WHERE id = ?7 AND shop_id = ?8
           AND (?9 = 0 OR (SELECT COUNT(*) FROM users WHERE shop_id = ?8 AND role = 'owner' AND disabled_at IS NULL
                             AND id <> ?7) >= 1)
         RETURNING *`,
      )
      .bind(displayName, role, googleEmail, googleSub, disabledAt, nowIso, id, dev.shop_id, losesOwner ? 1 : 0, emailSetAt),
    // Devices follow the user's (possibly unchanged) role; no-op when the guard refused the update.
    db
      .prepare(
        `UPDATE devices SET role = (SELECT role FROM users WHERE id = ?1)
         WHERE user_id = ?1 AND revoked_at IS NULL AND role <> (SELECT role FROM users WHERE id = ?1)`,
      )
      .bind(id),
    db
      .prepare(
        `DELETE FROM pair_codes WHERE used_at IS NULL
           AND issued_by IN (SELECT id FROM devices WHERE user_id = ?1 AND revoked_at IS NULL)
           AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND disabled_at IS NOT NULL)`,
      )
      .bind(id),
    db
      .prepare(
        `UPDATE devices SET revoked_at = ?2
         WHERE user_id = ?1 AND revoked_at IS NULL
           AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND disabled_at IS NOT NULL)`,
      )
      .bind(id, nowIso),
    // Audited only when the UPDATE went through (the guard subquery is repeated).
    db
      .prepare(
        `INSERT INTO auth_events (id, shop_id, at, actor_device_id, actor_user_id, action, target_user_id, target_device_id, detail)
         SELECT ?1, ?2, ?3, ?4, ?5, 'user.update', ?6, NULL, ?7 FROM users WHERE id = ?6 AND updated_at = ?3`,
      )
      .bind(crypto.randomUUID(), dev.shop_id, nowIso, dev.id, dev.user_id, id, JSON.stringify(changed)),
  ];
  let out: D1Result[];
  try {
    out = await db.batch(stmts);
  } catch (err) {
    const conflict = uniqueConflict(err);
    if (conflict) return fail(c, 409, conflict);
    throw err;
  }
  const row = out[0]?.results?.[0] as UserDb | undefined;
  if (!row) return fail(c, 409, 'last_owner');
  return c.json<UserResponse>({ user: toUserInfo(row), ...envelope(c, now) });
});

/**
 * Sets a password. Any signed-in user (web included) may change their own with current_client_key (their OTHER
 * devices are revoked). An owner device may reset anyone else's after step-up, never from the web (that user's
 * devices are revoked, e.g. after a lost phone).
 */
usersRoutes.put('/users/:id/password', auth, async (c) => {
  const body = await readJson(c);
  if (!isObj(body)) return badRequest(c);
  const pw = parsePasswordSet(body);
  if (pw === null) return badRequest(c, 'salt');
  if (typeof pw === 'string') return badRequest(c, pw);
  const dev = c.get('device');
  const id = c.req.param('id');
  const isSelf = dev.user_id === id;
  if (!isSelf && dev.role !== 'owner') return fail(c, 403, 'forbidden');
  if (!isSelf && dev.client === 'web') return fail(c, 403, 'web_forbidden');
  const target = await getUser(c.env.DB, id, dev.shop_id);
  if (!target) return fail(c, 404, 'not_found');
  const pepper = c.env.PEPPER ?? '';
  if (isSelf) {
    const current = parseClientKey(body.current_client_key);
    if (!current) return badRequest(c, 'current_client_key');
    if (!(await checkClientKey(pepper, current, target.pw_verifier))) return fail(c, 403, 'invalid_login');
  } else {
    const denied = await requireStepUp(c);
    if (denied) return denied;
  }
  const now = new Date();
  const nowIso = iso(now);
  const verifier = await passwordVerifier(pepper, pw.clientKey);
  const db = c.env.DB;
  await db.batch([
    db
      .prepare(
        `UPDATE users SET pw_salt = ?1, pw_iterations = ?2, pw_verifier = ?3, failed_count = 0, locked_until = NULL,
           updated_at = ?4 WHERE id = ?5 AND shop_id = ?6`,
      )
      .bind(pw.salt, pw.iterations, verifier, nowIso, id, dev.shop_id),
    db.prepare('DELETE FROM login_locks WHERE username = ?').bind(target.username),
    db
      .prepare(`UPDATE devices SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL AND id <> ?3`)
      .bind(nowIso, id, isSelf ? dev.id : ''),
    auditStatement(db, now, {
      shopId: dev.shop_id,
      actorDeviceId: dev.id,
      actorUserId: dev.user_id,
      action: isSelf ? 'password.change' : 'password.reset',
      targetUserId: id,
    }),
  ]);
  return c.json<OkResponse>({ ok: true, ...envelope(c, now) });
});
