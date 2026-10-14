/**
 * Typed HTTP client for every route in shared/protocol.ts (all under /v1).
 *
 * - Base URL: trimmed, trailing slashes and a trailing "/v1" stripped, https:// added when no scheme is given.
 *   Plain http:// is accepted only for LAN/localhost development hosts (wrangler dev on the shop Wi-Fi).
 * - JSON in and out; `Authorization: Bearer <token>` on every authenticated route.
 * - 20 s timeout. AbortController aborts the WebView fetch; a timer race also covers CapacitorHttp's patched
 *   fetch, whose native POST path ignores `signal` (node_modules/@capacitor/android/.../native-bridge.js).
 * - Every failure becomes a SyncError (see `ApiFailure` for the extra HTTP details).
 */
import {
  API_VERSION,
  PULL_PAGE_SIZE,
  type ApiError,
  type CodeBlockRequest,
  type CodeBlockResponse,
  type DevicesResponse,
  type EraseResponse,
  type MeResponse,
  type OkResponse,
  type PairCodeResponse,
  type PairRequest,
  type PairResponse,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type RecoveryCodesResponse,
  type Role,
  type SetupResponse,
  type ShopUpdateRequest,
  type ShopUpdateResponse,
} from '../../../shared/protocol';
import { asciiDigits } from '../core/ledger';
import { SyncError } from './types';

export const REQUEST_TIMEOUT_MS = 20_000;

/** A SyncError raised for an HTTP answer: carries the status, the server's error body and the 401 wipe flag. */
export class ApiFailure extends SyncError {
  constructor(
    code: string,
    public readonly status: number,
    public readonly wipe: boolean = false,
    message?: string,
  ) {
    super(code, message);
    this.name = 'ApiFailure';
  }
}

/** Error codes that mean "this phone's token is no longer valid". */
export const AUTH_ERRORS: ReadonlySet<string> = new Set(['revoked', 'unauthorized']);

// ------------------------------------------------------------------ URL and code normalisation

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Hosts where cleartext http:// is tolerated: loopback, RFC 1918 LAN ranges, link-local, mDNS (.local). */
export function isDevHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1') return true;
  const m = IPV4_RE.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((x) => x > 255)) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/**
 * "khata-api.x.workers.dev/" -> "https://khata-api.x.workers.dev". Throws SyncError('bad_url').
 * Query strings and fragments are dropped; a path prefix (reverse proxy) is kept.
 */
export function normalizeServerUrl(input: string): string {
  let s = (input ?? '').trim();
  if (!s) throw new SyncError('bad_url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new SyncError('bad_url');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SyncError('bad_url');
  if (!u.hostname || u.username || u.password) throw new SyncError('bad_url');
  if (u.protocol === 'http:' && !isDevHost(u.hostname)) throw new SyncError('bad_url');
  let path = u.pathname.replace(/\/+$/, '');
  if (path.toLowerCase().endsWith(`/${API_VERSION}`)) path = path.slice(0, -(API_VERSION.length + 1));
  path = path.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * Pairing code as typed: Tamil digits -> ASCII, spaces/dashes removed, upper-cased.
 * Valid: 8 digits, or a 16-character owner recovery code. Throws SyncError('invalid_code') before any request.
 */
export function normalizePairCode(input: string): string {
  const c = asciiDigits(input ?? '').replace(/[\s\-–—]+/g, '').toUpperCase();
  if (!/^[0-9]{8}$/.test(c) && !/^[0-9A-Z]{16}$/.test(c)) throw new SyncError('invalid_code');
  return c;
}

// ------------------------------------------------------------------ client

export interface ApiClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

type Method = 'GET' | 'POST' | 'PUT';

interface CallOpts {
  auth?: boolean;
  body?: unknown;
  headers?: Record<string, string>;
  /** Return the body as text instead of parsing JSON. */
  text?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function hasEnvelope(v: unknown): v is { server_time: string; sync_epoch: string } {
  return isObj(v) && typeof v.server_time === 'string' && typeof v.sync_epoch === 'string';
}

/** Maps an HTTP failure to a SyncError code (see SyncError in ./types). */
export function errorCodeFor(status: number, body: Partial<ApiError> | null, path: string): string {
  const err = typeof body?.error === 'string' ? body.error : '';
  const isSetup = path === '/setup';
  const isPair = path === '/pair';
  if (status === 401) return err === 'revoked' ? 'revoked' : 'unauthorized';
  if (status === 403) {
    if (isSetup) return 'bad_setup_key';
    if (err === 'invalid_code') return 'invalid_code';
    return 'forbidden';
  }
  if (status === 404) return isSetup ? 'setup_disabled' : 'not_found';
  if (status === 413) return 'too_many_rows';
  if (status === 429) {
    if (err === 'daily_cap' || err === 'throttled') return err;
    // Cloudflare's own free-plan cap (error 1027) answers 429 with an HTML page.
    return isPair ? 'throttled' : 'daily_cap';
  }
  if (status === 400) return err === 'cannot_revoke_self' ? err : 'bad_request';
  if (status === 500 && err === 'batch_failed') return 'batch_failed';
  return 'server';
}

export class ApiClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;

  constructor(
    /** Already normalised with normalizeServerUrl(). */
    readonly baseUrl: string,
    private readonly getToken: () => Promise<string | null>,
    opts: ApiClientOptions = {},
  ) {
    const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
    this.fetchFn = f;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  url(path: string): string {
    return `${this.baseUrl}/${API_VERSION}${path}`;
  }

  private async call<T>(method: Method, path: string, o: CallOpts = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(o.headers ?? {}) };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.auth !== false) {
      let token: string | null = null;
      try {
        token = await this.getToken();
      } catch {
        token = null;
      }
      // No token on this phone (never paired, or the Keystore key is gone): not a server verdict, never unpairs.
      if (!token) throw new ApiFailure('unpaired', 0);
      headers.Authorization = `Bearer ${token}`;
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: unknown = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.setT(() => {
        try {
          ctrl?.abort();
        } catch {
          /* ignore */
        }
        reject(new SyncError('network', 'timeout'));
      }, this.timeoutMs);
    });
    // Never leave an unhandled rejection behind when the request wins the race.
    timeout.catch(() => undefined);
    try {
      let res: Response;
      try {
        res = await Promise.race([
          this.fetchFn(this.url(path), {
            method,
            headers,
            body: o.body === undefined ? undefined : JSON.stringify(o.body),
            signal: ctrl?.signal,
          }),
          timeout,
        ]);
      } catch (e) {
        if (e instanceof SyncError) throw e;
        throw new SyncError('network', e instanceof Error ? e.message : 'fetch failed');
      }
      let text: string;
      try {
        text = await Promise.race([res.text(), timeout]);
      } catch (e) {
        if (e instanceof SyncError) throw e;
        throw new SyncError('network', 'body read failed');
      }
      if (!res.ok) {
        let body: Partial<ApiError> | null = null;
        try {
          const parsed: unknown = JSON.parse(text);
          if (isObj(parsed)) body = parsed as Partial<ApiError>;
        } catch {
          body = null;
        }
        const code = errorCodeFor(res.status, body, path);
        throw new ApiFailure(code, res.status, res.status === 401 && body?.wipe === true, body?.message ?? body?.error ?? `HTTP ${res.status}`);
      }
      if (o.text) return text as unknown as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ApiFailure('server', res.status, false, 'invalid JSON');
      }
    } finally {
      this.clearT(timer);
    }
  }

  /** Validates that an authenticated response carries the envelope; otherwise 'server'. */
  private checked<T>(v: T, extra?: (v: Record<string, unknown>) => boolean): T {
    if (!hasEnvelope(v) || (extra && !extra(v as unknown as Record<string, unknown>))) {
      throw new ApiFailure('server', 200, false, 'unexpected response');
    }
    return v;
  }

  // ---------------------------------------------------------------- public routes

  async health(): Promise<boolean> {
    const r = await this.call<{ ok?: boolean }>('GET', '/health', { auth: false });
    return r?.ok === true;
  }

  async setup(setupKey: string, shopName?: string): Promise<SetupResponse> {
    const r = await this.call<SetupResponse>('POST', '/setup', {
      auth: false,
      headers: { 'X-Setup-Key': setupKey },
      body: shopName ? { shop_name: shopName } : {},
    });
    if (!isObj(r) || typeof r.code !== 'string' || !isObj(r.shop)) throw new ApiFailure('server', 200, false, 'unexpected response');
    return r;
  }

  async pair(req: PairRequest): Promise<PairResponse> {
    const r = await this.call<PairResponse>('POST', '/pair', { auth: false, body: req });
    return this.checked(r, (v) =>
      typeof v.token === 'string' && typeof v.device_id === 'string' && isObj(v.shop) && isObj(v.code_block));
  }

  // ---------------------------------------------------------------- authenticated routes

  async me(): Promise<MeResponse> {
    return this.checked(await this.call<MeResponse>('GET', '/me'));
  }

  async pairCode(role: Role): Promise<PairCodeResponse> {
    return this.checked(await this.call<PairCodeResponse>('POST', '/devices/pair-code', { body: { role } }),
      (v) => typeof v.code === 'string');
  }

  async recoveryCodes(count?: number): Promise<RecoveryCodesResponse> {
    return this.checked(
      await this.call<RecoveryCodesResponse>('POST', '/devices/recovery-codes', { body: count === undefined ? {} : { count } }),
      (v) => Array.isArray(v.codes),
    );
  }

  async codeBlock(req: CodeBlockRequest): Promise<CodeBlockResponse> {
    return this.checked(await this.call<CodeBlockResponse>('POST', '/devices/code-block', { body: req }),
      (v) => Number.isSafeInteger(v.start) && Number.isSafeInteger(v.end));
  }

  async devices(): Promise<DevicesResponse> {
    return this.checked(await this.call<DevicesResponse>('GET', '/devices'), (v) => Array.isArray(v.devices));
  }

  async revoke(id: string, wipe: boolean): Promise<OkResponse> {
    return this.checked(await this.call<OkResponse>('POST', `/devices/${encodeURIComponent(id)}/revoke`, { body: { wipe } }));
  }

  async updateShop(patch: ShopUpdateRequest): Promise<ShopUpdateResponse> {
    return this.checked(await this.call<ShopUpdateResponse>('PUT', '/shop', { body: patch }), (v) => isObj(v.shop));
  }

  async erase(customerId: string): Promise<EraseResponse> {
    return this.checked(
      await this.call<EraseResponse>('POST', `/customers/${encodeURIComponent(customerId)}/erase`, { body: {} }),
      (v) => isObj(v.customer),
    );
  }

  async push(req: PushRequest): Promise<PushResponse> {
    return this.checked(await this.call<PushResponse>('POST', '/sync/push', { body: req }), (v) => Array.isArray(v.results));
  }

  async pull(since: number, limit: number = PULL_PAGE_SIZE): Promise<PullResponse> {
    const q = `?since=${Math.max(0, Math.floor(since))}&limit=${Math.max(1, Math.floor(limit))}`;
    return this.checked(await this.call<PullResponse>('GET', `/sync/pull${q}`),
      (v) => Array.isArray(v.changes) && typeof v.next_since === 'number');
  }

  /** GET /export as text (the server streams it; the caller saves/shares the string). */
  async exportText(): Promise<string> {
    return this.call<string>('GET', '/export', { text: true });
  }
}
