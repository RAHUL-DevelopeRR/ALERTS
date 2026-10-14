import { SELF } from 'cloudflare:test';
import type {
  ApiError,
  CustomerRow,
  EntryKind,
  EntryRow,
  PairResponse,
  PayMode,
  PullResponse,
  PushRequest,
  PushResponse,
  SetupResponse,
} from '../../shared/protocol';

export const ORIGIN = 'https://kadan.test';

export interface Res<T = any> {
  status: number;
  /** Success body, or an ApiError for non-2xx answers. */
  body: T & Partial<ApiError>;
  headers: Headers;
}

export async function call<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await SELF.fetch(`${ORIGIN}/v1${path}`, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed as T & Partial<ApiError>, headers: res.headers };
}

export async function setup(shop_name?: string): Promise<SetupResponse> {
  const r = await call<SetupResponse>('POST', '/setup', {
    headers: { 'X-Setup-Key': 'test-setup-key' },
    body: shop_name ? { shop_name } : {},
  });
  if (r.status !== 200) throw new Error(`setup failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function pair(
  code: string,
  extra: { device_name?: string; max_local_code?: number; previous_device_id?: string } = {},
): Promise<Res<PairResponse>> {
  return call<PairResponse>('POST', '/pair', { body: { code, device_name: extra.device_name ?? 'Phone', ...extra } });
}

export async function owner(extra: { max_local_code?: number; device_name?: string } = {}): Promise<PairResponse> {
  const s = await setup();
  const r = await pair(s.code, { device_name: 'Owner phone', ...extra });
  if (r.status !== 200) throw new Error(`owner pair failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function addDevice(ownerToken: string, role: 'owner' | 'staff', name = 'Helper phone'): Promise<PairResponse> {
  const pc = await call('POST', '/devices/pair-code', { token: ownerToken, body: { role } });
  if (pc.status !== 200) throw new Error(`pair-code failed ${pc.status}`);
  const r = await pair(pc.body.code, { device_name: name });
  if (r.status !== 200) throw new Error(`pair failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const push = (token: string, req: Partial<PushRequest>) =>
  call<PushResponse>('POST', '/sync/push', { token, body: { customers: req.customers ?? [], entries: req.entries ?? [] } });

export const pull = (token: string, since = 0, limit?: number) =>
  call<PullResponse>('GET', `/sync/pull?since=${since}${limit ? `&limit=${limit}` : ''}`, { token });

export const uuid = () => crypto.randomUUID();

export const istToday = (offsetDays = 0) =>
  new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

let codeCounter = 1;
export function customer(over: Partial<CustomerRow> = {}): CustomerRow {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    code: codeCounter++,
    name: 'Kamala',
    search_name: 'kamala',
    phone: '+919876543210',
    note: '3rd street',
    archived_at: null,
    erased_at: null,
    created_at: now,
    updated_at: now,
    updated_by: 'ignored',
    ...over,
  };
}

export function entry(
  customer_id: string,
  kind: EntryKind,
  amount: number,
  over: Partial<EntryRow> = {},
): EntryRow {
  const delta = kind === 'GIVE' ? amount : -amount;
  const mode: PayMode | null = kind === 'RECEIVE' ? 'CASH' : null;
  return {
    id: uuid(),
    customer_id,
    kind,
    amount_paise: amount,
    delta_paise: delta,
    biz_date: istToday(),
    note: null,
    mode,
    reverses_entry_id: null,
    device_id: 'ignored',
    created_at: new Date().toISOString(),
    ...over,
  };
}

/** A REVERSAL copying the original's customer, amount, date and mode. */
export function reversal(orig: EntryRow, over: Partial<EntryRow> = {}): EntryRow {
  return entry(orig.customer_id, 'REVERSAL', orig.amount_paise, {
    delta_paise: -orig.delta_paise,
    biz_date: orig.biz_date,
    mode: orig.mode,
    reverses_entry_id: orig.id,
    ...over,
  });
}
