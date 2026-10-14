import type { EntryKind, RejectReason } from '../../../shared/protocol';
import type { Json } from './http';
import { addDays, isIsoTimestamp, isRealDate } from './time';
import { isSafePositiveInt, isUuid } from './util';

const PHONE_RE = /^\+[0-9]{8,15}$/;
const KINDS: ReadonlySet<string> = new Set<EntryKind>(['GIVE', 'RECEIVE', 'WRITEOFF', 'REVERSAL']);
const MODES: ReadonlySet<string> = new Set(['CASH', 'UPI', 'OTHER']);
export const MAX_AMOUNT_PAISE = 1_000_000_000_000; // 1e12 paise = Rs 1,000 crore

const nullOr = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || v === null || ok(v);
const shortText = (max: number) => (v: unknown) => typeof v === 'string' && v.length <= max;

/** Structural checks of a pushed customer (BAD_ROW); null when the shape is valid. */
export function customerShape(x: Json): RejectReason | null {
  if (!isUuid(x.id)) return 'BAD_ROW';
  if (!isSafePositiveInt(x.code, 1_000_000_000)) return 'BAD_ROW';
  if (typeof x.name !== 'string' || x.name.length > 200) return 'BAD_ROW';
  const n = x.name.trim().length;
  if (n < 1 || n > 100) return 'BAD_ROW';
  if (!nullOr(x.search_name, shortText(100))) return 'BAD_ROW';
  if (!nullOr(x.phone, (v) => typeof v === 'string' && PHONE_RE.test(v))) return 'BAD_ROW';
  if (!nullOr(x.note, shortText(200))) return 'BAD_ROW';
  if (!nullOr(x.archived_at, isIsoTimestamp)) return 'BAD_ROW';
  if (!isIsoTimestamp(x.created_at) || !isIsoTimestamp(x.updated_at)) return 'BAD_ROW';
  return null;
}

/**
 * Structural, amount and date checks of a pushed entry, in rejection-table order:
 * BAD_ROW, BAD_AMOUNT, FUTURE_DATE. Relational checks (customer, reversal target) are done by the caller.
 */
export function entryShape(e: Json, todayIST: string): RejectReason | null {
  if (!isUuid(e.id) || !isUuid(e.customer_id)) return 'BAD_ROW';
  if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) return 'BAD_ROW';
  if (!isRealDate(e.biz_date)) return 'BAD_ROW';
  if (!nullOr(e.note, shortText(200))) return 'BAD_ROW';
  if (!nullOr(e.mode, (v) => typeof v === 'string' && MODES.has(v))) return 'BAD_ROW';
  const hasMode = e.mode !== undefined && e.mode !== null;
  if (hasMode && e.kind !== 'RECEIVE' && e.kind !== 'REVERSAL') return 'BAD_ROW';
  const isReversal = e.kind === 'REVERSAL';
  if (isReversal ? !isUuid(e.reverses_entry_id) : !nullOr(e.reverses_entry_id, () => false)) return 'BAD_ROW';
  if (isReversal && e.reverses_entry_id === e.id) return 'BAD_ROW';
  if (!isIsoTimestamp(e.created_at)) return 'BAD_ROW';

  if (!isSafePositiveInt(e.amount_paise, MAX_AMOUNT_PAISE)) return 'BAD_AMOUNT';
  const a = e.amount_paise;
  const d = e.delta_paise;
  if (typeof d !== 'number' || !Number.isSafeInteger(d)) return 'BAD_AMOUNT';
  if (e.kind === 'GIVE' && d !== a) return 'BAD_AMOUNT';
  if ((e.kind === 'RECEIVE' || e.kind === 'WRITEOFF') && d !== -a) return 'BAD_AMOUNT';
  if (isReversal && Math.abs(d) !== a) return 'BAD_AMOUNT';

  if ((e.biz_date as string) > addDays(todayIST, 1)) return 'FUTURE_DATE';
  return null;
}
