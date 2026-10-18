import { AUTH_EVENTS_LIMIT, type AuthEvent } from '../../../shared/protocol';
import { iso } from './time';

/** Audit trail (auth_events). One INSERT per action, batched with the action itself whenever there is a batch. */
export interface AuditRow {
  /** null only for failed logins that name no existing user (the Worker serves one shop; the oldest shop is used). */
  shopId: string | null;
  actorDeviceId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetUserId?: string | null;
  targetDeviceId?: string | null;
  /** Small JSON object; never credentials. */
  detail?: Record<string, unknown> | null;
}

const RETENTION_MS = 90 * 86_400_000;

export function auditStatement(db: D1Database, now: Date, row: AuditRow): D1PreparedStatement {
  const detail = row.detail && Object.keys(row.detail).length > 0 ? JSON.stringify(row.detail).slice(0, 2000) : null;
  return db
    .prepare(
      `INSERT INTO auth_events (id, shop_id, at, actor_device_id, actor_user_id, action, target_user_id, target_device_id, detail)
       VALUES (?1, COALESCE(?2, (SELECT id FROM shops ORDER BY created_at, id LIMIT 1)), ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      crypto.randomUUID(),
      row.shopId,
      iso(now),
      row.actorDeviceId ?? null,
      row.actorUserId ?? null,
      row.action,
      row.targetUserId ?? null,
      row.targetDeviceId ?? null,
      detail,
    );
}

export const audit = (db: D1Database, now: Date, row: AuditRow): Promise<D1Result> => auditStatement(db, now, row).run();

/** Housekeeping: forget events older than 90 days (run inside login batches; indexed on (shop_id, at)). */
export const auditPrune = (db: D1Database, now: Date): D1PreparedStatement =>
  db.prepare('DELETE FROM auth_events WHERE at < ?').bind(iso(new Date(now.getTime() - RETENTION_MS)));

interface EventDb {
  id: string;
  at: string;
  actor_device_id: string | null;
  actor_user_id: string | null;
  action: string;
  target_user_id: string | null;
  target_device_id: string | null;
  detail: string | null;
}

export async function listAuthEvents(db: D1Database, shopId: string): Promise<AuthEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT id, at, actor_device_id, actor_user_id, action, target_user_id, target_device_id, detail
       FROM auth_events WHERE shop_id = ?1 ORDER BY at DESC, id DESC LIMIT ?2`,
    )
    .bind(shopId, AUTH_EVENTS_LIMIT)
    .all<EventDb>();
  return results.map((e) => {
    let detail: Record<string, unknown> | null = null;
    if (e.detail) {
      try {
        const v = JSON.parse(e.detail) as unknown;
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) detail = v as Record<string, unknown>;
      } catch {
        /* keep null */
      }
    }
    return {
      id: e.id,
      at: e.at,
      actor_device_id: e.actor_device_id,
      actor_user_id: e.actor_user_id,
      action: e.action,
      target_user_id: e.target_user_id,
      target_device_id: e.target_device_id,
      detail,
    };
  });
}
