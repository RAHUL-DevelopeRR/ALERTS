import type { Context } from 'hono';
import { RECOVERY_HEADER, STEPUP_HEADER, STEPUP_WINDOW_MIN } from '../../../shared/protocol';
import type { AppEnv } from '../env';
import { audit, auditStatement } from './audit';
import { normaliseCode, pepperHash } from './crypto';
import { fail } from './http';
import { lockRead, lockRecordAttempt, lockReset, retryAfterSeconds } from './lockout';
import { checkClientKey, parseClientKey } from './password';
import { addMinutes, iso } from './time';

const RECOVERY_RE = /^[0-9A-Z]{16}$/;

/**
 * Step-up for owner-power routes (after auth + ownerOnly + noWeb). Accepted, in this order:
 *  1. the device is still inside its window (devices.stepup_until > now);
 *  2. `X-KK-Recovery: <printed recovery code>` of this shop: consumed (used_at/used_by), works for any device,
 *     including legacy paired phones (user_id NULL) and Google-only users;
 *  3. `X-KK-Stepup: <client_key>`: the caller's user's CURRENT password, verified like a login, with the same
 *     5-failure backoff keyed on (username, 'stepup:<device id>');
 *  4. bootstrap: a legacy device (no user) while the shop has NO users keeps its v1 powers (this is how the first
 *     owner login gets created with link_me and recovery codes get printed before accounts exist).
 * A proof opens a STEPUP_WINDOW_MIN window and writes stepup.ok; a bad proof writes stepup.failed.
 * Returns the error Response, or null when the caller may proceed (c.get('device').stepup_until is then fresh).
 */
export async function requireStepUp(c: Context<AppEnv>): Promise<Response | null> {
  const dev = c.get('device');
  const db = c.env.DB;
  const pepper = c.env.PEPPER ?? '';
  const now = new Date();
  const nowIso = iso(now);
  if (dev.stepup_until && dev.stepup_until > nowIso) return null;
  const until = iso(addMinutes(now, STEPUP_WINDOW_MIN));
  const grant = db.prepare('UPDATE devices SET stepup_until = ?1 WHERE id = ?2').bind(until, dev.id);

  const recovery = c.req.header(RECOVERY_HEADER);
  if (recovery !== undefined) {
    const code = normaliseCode(recovery.length > 64 ? '' : recovery);
    let claimed = false;
    if (RECOVERY_RE.test(code)) {
      const hash = await pepperHash(code, pepper);
      // Claim the code and open the window in one batch; the grant is a no-op unless the claim succeeded.
      const [claim] = await db.batch([
        db
          .prepare(
            `UPDATE pair_codes SET used_at = ?1, used_by = ?2
             WHERE code_hash = ?3 AND shop_id = ?4 AND kind = 'recovery' AND used_at IS NULL RETURNING code_hash`,
          )
          .bind(nowIso, dev.id, hash, dev.shop_id),
        db
          .prepare(
            `UPDATE devices SET stepup_until = ?1 WHERE id = ?2
             AND EXISTS (SELECT 1 FROM pair_codes WHERE code_hash = ?3 AND used_by = ?2 AND used_at = ?4)`,
          )
          .bind(until, dev.id, hash, nowIso),
      ]);
      claimed = (claim?.results?.length ?? 0) > 0;
    }
    await audit(db, now, {
      shopId: dev.shop_id,
      actorDeviceId: dev.id,
      actorUserId: dev.user_id,
      action: claimed ? 'stepup.ok' : 'stepup.failed',
      detail: { how: 'recovery' },
    });
    if (!claimed) return fail(c, 403, 'stepup_invalid');
    dev.stepup_until = until;
    return null;
  }

  const stepup = c.req.header(STEPUP_HEADER);
  if (stepup !== undefined) {
    const key = parseClientKey(stepup);
    if (!key) return fail(c, 403, 'stepup_invalid');
    const user = dev.user_id
      ? await db
          .prepare('SELECT username, pw_verifier FROM users WHERE id = ?1 AND disabled_at IS NULL')
          .bind(dev.user_id)
          .first<{ username: string; pw_verifier: string | null }>()
      : null;
    if (!user || !user.pw_verifier) return fail(c, 403, 'stepup_invalid');
    const source = `stepup:${dev.id}`;
    const [attempt, lock] = await db.batch([lockRecordAttempt(db, user.username, source, now), lockRead(db, user.username, source)]);
    if (!attempt?.results?.length) {
      const retry = retryAfterSeconds((lock?.results?.[0] as { locked_until: string | null } | undefined)?.locked_until, now);
      c.header('Retry-After', String(retry));
      return fail(c, 429, 'locked', { retry_after: retry });
    }
    const ok = await checkClientKey(pepper, key, user.pw_verifier);
    if (!ok) {
      await audit(db, now, { shopId: dev.shop_id, actorDeviceId: dev.id, actorUserId: dev.user_id, action: 'stepup.failed', detail: { how: 'password' } });
      return fail(c, 403, 'stepup_invalid');
    }
    await db.batch([
      lockReset(db, user.username, source),
      grant,
      auditStatement(db, now, { shopId: dev.shop_id, actorDeviceId: dev.id, actorUserId: dev.user_id, action: 'stepup.ok', detail: { how: 'password' } }),
    ]);
    dev.stepup_until = until;
    return null;
  }

  // No proof offered. Bootstrap exemption for a legacy device in a shop that has no users yet.
  if (dev.user_id === null) {
    const any = await db.prepare('SELECT 1 AS x FROM users WHERE shop_id = ? LIMIT 1').bind(dev.shop_id).first();
    if (!any) return null;
  }
  const hasPassword = dev.user_id
    ? await db.prepare('SELECT 1 AS x FROM users WHERE id = ? AND pw_verifier IS NOT NULL').bind(dev.user_id).first()
    : null;
  return fail(c, 403, 'stepup_required', { stepup: hasPassword ? ['password', 'recovery'] : ['recovery'] });
}
