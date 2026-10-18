/**
 * In-memory fake of the khata-api Worker (shared/protocol.ts semantics), exposed as a `fetch` function so the
 * real sync engine and the real SqlRepo can be tested end to end in Node.
 *
 * Mirrors khata/api/src/routes/sync.ts: customers before entries; idempotent replays answered 'already' with the
 * row's latest seq; MISMATCH for same id/different content; CODE_TAKEN, UNKNOWN_CUSTOMER, UNKNOWN_ORIGINAL,
 * ALREADY_REVERSED, REVERSAL_* checks; archived customers un-archived by money; one append-only change log
 * (seq) with device-filtered pulls and the same next_since rule; pairing with max_local_code; revoke + wipe flag.
 *
 * Fault injection: `server.fault({ path, mode })` for network failures, lost responses after commit, or a
 * canned HTTP error. `server.requests` logs every request.
 *
 * v2 accounts (shared/protocol.ts): users (`server.addUser`), /config, /auth/prelogin + /auth/login (fake PBKDF2:
 * `fakeDerive`, which the engine under test is given as `deriveKey`), /auth/google (id_token 'fake-google:<email>:<nonce>'),
 * /auth/nonce, /auth/logout, /auth/events, /users*, step-up (X-KK-Stepup = the user's stored client_key, X-KK-Recovery =
 * an unused recovery code; 5-minute window), per-username lockout after 5 failures with the known-device exemption, and
 * the web transport: a web login sets `server.webCookie` (the browser's cookie jar); a request with no Authorization
 * header uses it when `X-KK-Client: web` is present (403 csrf otherwise). Web devices never authenticate by Bearer.
 */
import { createFakeSpeech } from '../../src/platform/fake-speech';
import {
  CODE_BLOCK_SIZE,
  CUSTOMER_CANONICAL_FIELDS,
  ENTRY_CANONICAL_FIELDS,
  MAX_PUSH_ROWS,
  PBKDF2_DEFAULT_ITERATIONS,
  PULL_PAGE_SIZE,
  type AuthEvent,
  type Change,
  type ClientKind,
  type CustomerRow,
  type DeviceInfo,
  type EntryRow,
  type PushResult,
  type RejectReason,
  type Role,
  type ShopInfo,
  type Tbl,
  type UserInfo,
} from '../../../shared/protocol';
import { addDays, bizDateIST } from '../../src/core/ledger';

export interface FakeDevice {
  info: DeviceInfo;
  token: string;
  shop_id: string;
  wipe: boolean;
  requests: number;
  /** v2: the login that created this device (null: paired with a code). */
  user_id?: string | null;
  client?: ClientKind | null;
  /** v2: stepped up until this ms timestamp. */
  stepup_until?: number;
}

export interface FakeUser {
  info: UserInfo;
  salt: string;
  /** What the client sends (the fake stores it verbatim; the real server stores HMAC(PEPPER, key)). null = Google-only. */
  client_key: string | null;
}

/** Stand-in for PBKDF2 (the engine under test gets it as `deriveKey`); the fake server stores the result verbatim. */
export const fakeDerive = async (password: string, salt: string, iterations: number): Promise<string> =>
  `fk:${password.normalize('NFC')}:${salt}:${iterations}`;

export const LOCK_AFTER = 5;

interface LogRow {
  seq: number;
  tbl: Tbl;
  row_id: string;
  device_id: string;
}

export type FaultMode =
  /** fetch rejects before the server sees the request */
  | 'network'
  /** the server processes (and commits) the request, then the response is lost */
  | 'drop-response'
  /** answer with `status` + `body` without processing */
  | 'status';

export interface Fault {
  /** Path after /v1, e.g. '/sync/push'; a RegExp matches the path (query string included). */
  path: string | RegExp;
  mode: FaultMode;
  status?: number;
  body?: unknown;
  /** How many requests this fault applies to (default 1). */
  times?: number;
}

export interface LoggedRequest {
  method: string;
  path: string;
  body: unknown;
  device_id: string | null;
  status: number | 'network';
}

interface Snapshot {
  customers: Map<string, CustomerRow>;
  entries: Map<string, EntryRow>;
  log: LogRow[];
  seq: number;
  codeSeq: number;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function same(a: Record<string, unknown>, b: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((f) => (a[f] ?? null) === (b[f] ?? null));
}

let tokenCounter = 0;

export class FakeServer {
  shop: ShopInfo = { id: 'shop-1', name: 'Murugan Stores', upi_id: null, lang: 'ta' };
  epoch = 'epoch-1';
  setupKey: string | null = 'setup-secret';
  customers = new Map<string, CustomerRow>();
  entries = new Map<string, EntryRow>();
  log: LogRow[] = [];
  seq = 0;
  codeSeq = 0;
  devices = new Map<string, FakeDevice>();
  pairCodes = new Map<string, { role: Role; used: boolean }>();
  recovery = new Set<string>();
  requests: LoggedRequest[] = [];
  faults: Fault[] = [];
  /** Server clock (ms). Default: real time; tests set a fixed or skewed clock. */
  clock: () => number = () => Date.now();
  private codeCounter = 0;
  // ---- v2 accounts
  users = new Map<string, FakeUser>();
  /** The browser's cookie jar: the kk_session token of the last web login (null: no cookie / logged out). */
  webCookie: string | null = null;
  /** The browser's kk_known cookie. */
  knownCookie: string | null = null;
  /** known_device values issued -> user id (the real server MACs them; here they are opaque strings). */
  known = new Map<string, string>();
  /** Web Google client ids; empty = Google sign-in off (404 on /auth/nonce and /auth/google). */
  googleIds: string[] = [];
  nonces = new Set<string>();
  authEvents: AuthEvent[] = [];
  /** Failed logins per username (reset by a success). */
  loginFails = new Map<string, number>();
  private nonceCounter = 0;
  private userCounter = 0;

  /** Registers a user; `password` null = Google-only (then google_email is needed). */
  async addUser(username: string, password: string | null, role: Role = 'owner', extra: { display_name?: string; google_email?: string | null; disabled?: boolean } = {}): Promise<FakeUser> {
    const id = `user-${++this.userCounter}`;
    const salt = `salt-${id}`;
    const now = this.nowIso();
    const u: FakeUser = {
      info: {
        id, username, display_name: extra.display_name ?? username, role,
        google_email: extra.google_email ?? null, google_linked: false,
        google_email_expires_at: extra.google_email ? new Date(this.clock() + 48 * 3_600_000).toISOString() : null,
        has_password: password !== null, created_at: now, updated_at: now, disabled_at: extra.disabled ? now : null,
      },
      salt,
      client_key: password === null ? null : await fakeDerive(password, salt, PBKDF2_DEFAULT_ITERATIONS),
    };
    this.users.set(id, u);
    return u;
  }

  userByName(username: string): FakeUser | null {
    return [...this.users.values()].find((u) => u.info.username === username) ?? null;
  }

  /** Devices created by logins of `username` (live ones unless `all`). */
  devicesOf(username: string, all = false): FakeDevice[] {
    const u = this.userByName(username);
    return u ? [...this.devices.values()].filter((d) => d.user_id === u.info.id && (all || !d.info.revoked_at)) : [];
  }

  private event(action: string, extra: Partial<AuthEvent> = {}): void {
    this.authEvents.unshift({
      id: `ev-${this.authEvents.length + 1}`, at: this.nowIso(), actor_device_id: null, actor_user_id: null,
      action, target_user_id: null, target_device_id: null, detail: null, ...extra,
    });
  }

  /** The fetch function to hand to the engine; `label` is only used in the request log. */
  readonly fetch: typeof fetch = (input, init) => this.handle(input, init);

  fault(f: Fault): void {
    this.faults.push({ times: 1, ...f });
  }

  /** Mint an 8-digit single-use pairing code (owner by default). */
  mintCode(role: Role = 'owner'): string {
    this.codeCounter++;
    const code = String(10_000_000 + this.codeCounter * 7919).slice(-8);
    this.pairCodes.set(code, { role, used: false });
    return code;
  }

  snapshot(): Snapshot {
    return {
      customers: new Map([...this.customers].map(([k, v]) => [k, clone(v)])),
      entries: new Map([...this.entries].map(([k, v]) => [k, clone(v)])),
      log: this.log.map((l) => ({ ...l })),
      seq: this.seq,
      codeSeq: this.codeSeq,
    };
  }

  /** Simulate a database restore from `snap` (rows written after it are lost; seq goes backwards) + new epoch. */
  restore(snap: Snapshot, newEpoch: string): void {
    this.customers = new Map([...snap.customers].map(([k, v]) => [k, clone(v)]));
    this.entries = new Map([...snap.entries].map(([k, v]) => [k, clone(v)]));
    this.log = snap.log.map((l) => ({ ...l }));
    this.seq = snap.seq;
    this.codeSeq = Math.max(this.codeSeq, snap.codeSeq); // code blocks are never re-issued in tests
    this.epoch = newEpoch;
  }

  pushCount(): number {
    return this.requests.filter((r) => r.path === '/sync/push' && r.status !== 'network').length;
  }

  balance(customerId: string): number {
    let b = 0;
    for (const e of this.entries.values()) if (e.customer_id === customerId) b += e.delta_paise;
    return b;
  }

  // ---------------------------------------------------------------- transport

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private envelope(): { server_time: string; sync_epoch: string } {
    return { server_time: this.nowIso(), sync_epoch: this.epoch };
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Relative URLs (the web app's same-origin '/v1/...') resolve against the browser's origin, as in a real browser.
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://web.example');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    if (typeof init?.body === 'string' && init.body.length) body = JSON.parse(init.body);
    if (!url.pathname.startsWith('/v1/')) return this.json(404, { error: 'not_found' });
    const path = url.pathname.slice(3);
    const pathQ = path + url.search;
    const auth = /^Bearer (.+)$/.exec(headers.get('Authorization') ?? '');
    let dev: FakeDevice | null = null;
    let csrf = false;
    if (auth) {
      // Transport binding: a web session token is never accepted as a Bearer token.
      dev = [...this.devices.values()].find((d) => d.token === auth[1] && d.client !== 'web') ?? null;
    } else if (this.webCookie) {
      if (headers.get('X-KK-Client') !== 'web') csrf = true;
      else dev = [...this.devices.values()].find((d) => d.token === this.webCookie && d.client === 'web') ?? null;
    }
    const entry: LoggedRequest = { method, path, body: body === undefined ? undefined : clone(body), device_id: dev?.info.id ?? null, status: 0 };
    this.requests.push(entry);

    const fi = this.faults.findIndex((f) => (typeof f.path === 'string' ? f.path === path : f.path.test(pathQ)) && (f.times ?? 1) > 0);
    const fault = fi >= 0 ? this.faults[fi] : null;
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.times <= 0) this.faults.splice(fi, 1);
      if (fault.mode === 'network') {
        entry.status = 'network';
        throw new TypeError('fetch failed (fake network)');
      }
      if (fault.mode === 'status') {
        entry.status = fault.status ?? 500;
        return this.json(fault.status ?? 500, fault.body ?? { error: 'internal' });
      }
    }
    const res = this.route(method, path, url.searchParams, body, headers, dev, csrf);
    entry.status = res.status;
    if (fault?.mode === 'drop-response') {
      entry.status = 'network';
      throw new TypeError('fetch failed after commit (fake)');
    }
    return res;
  }

  // ---------------------------------------------------------------- routes

  private route(
    method: string, path: string, q: URLSearchParams, body: unknown, headers: Headers, dev: FakeDevice | null, csrf = false,
  ): Response {
    if (method === 'GET' && path === '/health') return this.json(200, { ok: true });
    if (method === 'POST' && path === '/setup') return this.setup(headers, body);
    if (method === 'POST' && path === '/pair') return this.pair(body);
    if (method === 'GET' && path === '/config') {
      return this.json(200, { google_client_id: this.googleIds[0] ?? null, auth: { password: true }, version: 'fake', server_time: this.nowIso() });
    }
    if (method === 'POST' && path === '/auth/prelogin') return this.prelogin(body);
    if (method === 'POST' && path === '/auth/login') return this.login(body, headers);
    if (method === 'POST' && path === '/auth/nonce') {
      if (!this.googleIds.length) return this.json(404, { error: 'not_found' });
      const nonce = `nonce-${++this.nonceCounter}`;
      this.nonces.add(nonce);
      return this.json(200, { nonce });
    }
    if (method === 'POST' && path === '/auth/google') return this.google(body);

    // ---- authenticated
    if (csrf) return this.json(403, { error: 'csrf' });
    if (!dev) return this.json(401, { error: 'unauthorized' });
    if (dev.info.revoked_at) return this.json(401, { error: 'revoked', wipe: dev.wipe });
    dev.requests++;
    dev.info.last_seen_at = this.nowIso();
    const owner = dev.info.role === 'owner';
    const forbidden = () => this.json(403, { error: 'forbidden' });
    const web = dev.client === 'web';
    const stepUp = (): Response | null => this.stepUp(dev, headers);

    if (method === 'POST' && path === '/auth/logout') {
      dev.info.revoked_at = this.nowIso();
      if (web) this.webCookie = null;
      this.event('logout', { actor_device_id: dev.info.id, actor_user_id: dev.user_id ?? null, target_device_id: dev.info.id });
      return this.json(200, { ok: true, ...this.envelope() });
    }
    if (method === 'GET' && path === '/auth/events') {
      if (!owner) return forbidden();
      return this.json(200, { events: clone(this.authEvents.slice(0, 200)), ...this.envelope() });
    }
    if (method === 'GET' && path === '/users') {
      if (!owner) return forbidden();
      return this.json(200, { users: [...this.users.values()].map((u) => clone(u.info)), ...this.envelope() });
    }
    if (method === 'POST' && path === '/users') {
      if (!owner) return forbidden();
      if (web) return this.json(403, { error: 'web_forbidden' });
      return this.createUser(dev, body, stepUp);
    }
    let m = /^\/users\/([^/]+)\/password$/.exec(path);
    if (method === 'PUT' && m) return this.setPassword(dev, decodeURIComponent(m[1]), body, stepUp);
    m = /^\/users\/([^/]+)$/.exec(path);
    if (method === 'PUT' && m) {
      if (!owner) return forbidden();
      if (web) return this.json(403, { error: 'web_forbidden' });
      return this.updateUser(dev, decodeURIComponent(m[1]), body, stepUp);
    }

    if (method === 'GET' && path === '/me') {
      const u = dev.user_id ? this.users.get(dev.user_id) : null;
      const user = u ? { id: u.info.id, username: u.info.username, display_name: u.info.display_name, role: u.info.role } : null;
      return this.json(200, { device: clone(dev.info), shop: clone(this.shop), user, ...this.envelope() });
    }
    if (method === 'POST' && path === '/sync/push') return this.push(dev, body);
    if (method === 'GET' && path === '/sync/pull') return this.pull(dev, q);
    if (method === 'POST' && path === '/devices/code-block') {
      const max = isObj(body) && typeof body.max_local_code === 'number' ? body.max_local_code : 0;
      return this.json(200, { ...this.block(max), ...this.envelope() });
    }
    if (method === 'POST' && path === '/devices/pair-code') {
      if (!owner) return forbidden();
      if (web) return this.json(403, { error: 'web_forbidden' });
      const denied = stepUp();
      if (denied) return denied;
      const role: Role = isObj(body) && body.role === 'staff' ? 'staff' : 'owner';
      return this.json(200, { code: this.mintCode(role), expires_at: new Date(this.clock() + 600_000).toISOString(), role, ...this.envelope() });
    }
    if (method === 'POST' && path === '/devices/recovery-codes') {
      if (!owner) return forbidden();
      if (web) return this.json(403, { error: 'web_forbidden' });
      const denied = stepUp();
      if (denied) return denied;
      const count = isObj(body) && typeof body.count === 'number' ? body.count : 5;
      this.recovery.clear();
      const codes: string[] = [];
      for (let i = 0; i < count; i++) {
        const c = `ABCD${String(i).padStart(4, '0')}EFGH${String(this.recovery.size).padStart(4, '0')}`;
        this.recovery.add(c);
        codes.push(`${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12)}`);
      }
      return this.json(200, { codes, ...this.envelope() });
    }
    if (method === 'GET' && path === '/devices') {
      if (!owner) return forbidden();
      return this.json(200, { devices: this.deviceList(), ...this.envelope() });
    }
    m = /^\/devices\/([^/]+)\/revoke$/.exec(path);
    if (method === 'POST' && m) {
      if (!owner) return forbidden();
      if (web) return this.json(403, { error: 'web_forbidden' });
      const denied = stepUp();
      if (denied) return denied;
      const id = decodeURIComponent(m[1]);
      if (id === dev.info.id) return this.json(400, { error: 'cannot_revoke_self' });
      const target = this.devices.get(id);
      if (!target) return this.json(404, { error: 'not_found' });
      target.info.revoked_at = target.info.revoked_at ?? this.nowIso();
      target.wipe = isObj(body) && body.wipe === true;
      return this.json(200, { ok: true, ...this.envelope() });
    }
    if (method === 'PUT' && path === '/shop') {
      if (!owner) return forbidden();
      if (isObj(body)) {
        if (typeof body.name === 'string') this.shop.name = body.name;
        if (body.upi_id !== undefined) this.shop.upi_id = (body.upi_id as string | null) ?? null;
        if (body.lang === 'ta' || body.lang === 'en') this.shop.lang = body.lang;
      }
      return this.json(200, { shop: clone(this.shop), ...this.envelope() });
    }
    m = /^\/customers\/([^/]+)\/erase$/.exec(path);
    if (method === 'POST' && m) {
      if (!owner) return forbidden();
      const c = this.customers.get(decodeURIComponent(m[1]));
      if (!c) return this.json(404, { error: 'not_found' });
      const now = this.nowIso();
      Object.assign(c, {
        name: `Erased ${bizDateIST(new Date(this.clock()))}`, search_name: null, phone: null, note: null,
        erased_at: now, received_at: now, updated_at: now, updated_by: dev.info.id,
      });
      this.append('customers', c.id, dev.info.id);
      return this.json(200, { customer: clone(c), ...this.envelope() });
    }
    if (method === 'GET' && path === '/export') {
      if (!owner) return forbidden();
      return this.json(200, {
        format: 'kadan-kanakku-export', version: 1, exported_at: this.nowIso(), shop: this.shop,
        devices: this.deviceList(), customers: [...this.customers.values()], entries: [...this.entries.values()],
      });
    }
    return this.json(404, { error: 'not_found' });
  }

  // ---------------------------------------------------------------- v2 accounts

  private prelogin(body: unknown): Response {
    if (!isObj(body) || typeof body.username !== 'string') return this.json(400, { error: 'bad_request' });
    const username = body.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return this.json(400, { error: 'bad_request', message: 'username' });
    const u = this.userByName(username);
    const real = u && u.client_key !== null && !u.info.disabled_at;
    return this.json(200, { salt: real ? u.salt : `fake-salt-${username}`, iterations: PBKDF2_DEFAULT_ITERATIONS });
  }

  private loginExtras(body: Record<string, unknown>): { name: string; client: ClientKind; shared: boolean; prev: string | null; prevToken: string | null; max: number } | Response {
    const name = typeof body.device_name === 'string' ? body.device_name.trim() : '';
    if (!name || name.length > 60) return this.json(400, { error: 'bad_request', message: 'device_name' });
    if (body.client !== 'android' && body.client !== 'web') return this.json(400, { error: 'bad_request', message: 'client' });
    return {
      name, client: body.client, shared: body.shared_computer === true,
      prev: typeof body.previous_device_id === 'string' ? body.previous_device_id : null,
      prevToken: typeof body.previous_device_token === 'string' ? body.previous_device_token : null,
      max: typeof body.max_local_code === 'number' ? body.max_local_code : 0,
    };
  }

  private login(body: unknown, headers: Headers): Response {
    if (!isObj(body) || typeof body.username !== 'string' || typeof body.client_key !== 'string') return this.json(400, { error: 'bad_request' });
    const ex = this.loginExtras(body);
    if (ex instanceof Response) return ex;
    const username = body.username.trim().toLowerCase();
    const u = this.userByName(username);
    const knownValue = headers.get('X-KK-Known') ?? (ex.client === 'web' ? this.knownCookie : null);
    const knownFor = knownValue ? this.known.get(knownValue) ?? null : null;
    const exempt = !!u && knownFor === u.info.id;
    const fails = this.loginFails.get(username) ?? 0;
    if (!exempt && fails >= LOCK_AFTER) return this.json(429, { error: 'locked', retry_after: 30 });
    const ok = !!u && !u.info.disabled_at && u.client_key !== null && u.client_key === body.client_key;
    if (!ok) {
      if (!exempt) this.loginFails.set(username, fails + 1);
      this.event('login.failed', { detail: { username, client: ex.client } });
      return this.json(403, { error: 'invalid_login' });
    }
    if (ex.client === 'web' && u.info.role !== 'owner') {
      this.event('login.refused', { actor_user_id: u.info.id, detail: { why: 'web_owner_only' } });
      return this.json(403, { error: 'web_owner_only' });
    }
    this.loginFails.delete(username);
    return this.issue(u, ex, 'login.ok');
  }

  private google(body: unknown): Response {
    if (!this.googleIds.length) return this.json(404, { error: 'not_found' });
    if (!isObj(body) || typeof body.id_token !== 'string') return this.json(400, { error: 'bad_request' });
    const ex = this.loginExtras(body);
    if (ex instanceof Response) return ex;
    const m = /^fake-google:([^:]+):(.+)$/.exec(body.id_token);
    if (!m) return this.json(403, { error: 'invalid_token', message: 'signature' });
    const [, email, nonce] = m;
    if (!this.nonces.delete(nonce)) return this.json(403, { error: 'invalid_token', message: 'nonce' });
    const u = [...this.users.values()].find((x) => x.info.google_email === email.toLowerCase() && !x.info.disabled_at);
    if (!u) return this.json(403, { error: 'not_linked' });
    u.info.google_linked = true;
    u.info.google_email_expires_at = null;
    if (ex.client === 'web' && u.info.role !== 'owner') return this.json(403, { error: 'web_owner_only' });
    return this.issue(u, ex, 'google.ok');
  }

  private issue(u: FakeUser, ex: { name: string; client: ClientKind; shared: boolean; prev: string | null; prevToken: string | null; max: number }, action: string): Response {
    const id = `dev-${++tokenCounter}`;
    const token = `tok-${tokenCounter}-${Math.random().toString(36).slice(2)}`;
    const now = this.nowIso();
    const web = ex.client === 'web';
    const expires = web ? new Date(this.clock() + (ex.shared ? 12 * 3_600_000 : 30 * 86_400_000)).toISOString() : null;
    this.devices.set(id, {
      // Like the real server (api/src/lib/rows.ts toDeviceInfo): GET /me reports expires_at and the derived `shared`.
      info: { id, name: ex.name, role: u.info.role, created_at: now, last_seen_at: null, revoked_at: null, client: ex.client, user_id: u.info.id, expires_at: expires, shared: web && ex.shared },
      token, shop_id: this.shop.id, wipe: false, requests: 0, user_id: u.info.id, client: ex.client,
    });
    if (ex.prev) {
      // Login takeover rule: same user, or a legacy row proved by its token. Anything else revokes nothing.
      const prev = this.devices.get(ex.prev);
      if (prev && !prev.info.revoked_at && ((prev.user_id ?? null) === u.info.id || (!prev.user_id && ex.prevToken !== null && prev.token === ex.prevToken))) {
        prev.info.revoked_at = now;
      }
    }
    const known = `${id}.known`;
    this.known.set(known, u.info.id);
    if (web) {
      this.webCookie = token;
      // A shared computer gets no persistent kk_known cookie (api/src/routes/auth.ts issueLogin).
      if (!ex.shared) this.knownCookie = known;
    }
    this.event(action, { actor_device_id: id, actor_user_id: u.info.id, target_device_id: id, detail: { client: ex.client, ...(ex.shared ? { shared_computer: true } : {}) } });
    return this.json(200, {
      token: web ? null : token, device_id: id, role: u.info.role, shop: clone(this.shop),
      code_block: web ? null : this.block(ex.max), ...this.envelope(),
      user: { id: u.info.id, username: u.info.username, display_name: u.info.display_name, role: u.info.role },
      known_device: known, expires_at: expires, shared: web && ex.shared,
    });
  }

  /** Step-up: null = proceed; else the 403 (stepup_required / stepup_invalid). Mirrors api/src/lib/stepup.ts. */
  private stepUp(dev: FakeDevice, headers: Headers): Response | null {
    const now = this.clock();
    if (dev.stepup_until && dev.stepup_until > now) return null;
    const grant = (): null => {
      dev.stepup_until = now + 5 * 60_000;
      this.event('stepup.ok', { actor_device_id: dev.info.id, actor_user_id: dev.user_id ?? null });
      return null;
    };
    const recovery = headers.get('X-KK-Recovery');
    if (recovery !== null) {
      const code = recovery.replace(/[\s-]+/g, '').toUpperCase();
      if (this.recovery.delete(code)) return grant();
      this.event('stepup.failed', { actor_device_id: dev.info.id });
      return this.json(403, { error: 'stepup_invalid' });
    }
    const key = headers.get('X-KK-Stepup');
    const user = dev.user_id ? this.users.get(dev.user_id) ?? null : null;
    if (key !== null) {
      if (user && user.client_key !== null && user.client_key === key) return grant();
      this.event('stepup.failed', { actor_device_id: dev.info.id });
      return this.json(403, { error: 'stepup_invalid' });
    }
    if (!dev.user_id && this.users.size === 0) return null; // bootstrap
    return this.json(403, { error: 'stepup_required', stepup: user?.client_key ? ['password', 'recovery'] : ['recovery'] });
  }

  private createUser(dev: FakeDevice, body: unknown, stepUp: () => Response | null): Response {
    if (!isObj(body) || typeof body.username !== 'string') return this.json(400, { error: 'bad_request' });
    const username = body.username.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) return this.json(400, { error: 'bad_request', message: 'username' });
    if (body.role !== 'owner' && body.role !== 'staff') return this.json(400, { error: 'bad_request', message: 'role' });
    const hasPw = body.client_key !== undefined;
    if (hasPw && (typeof body.salt !== 'string' || body.iterations !== PBKDF2_DEFAULT_ITERATIONS || typeof body.client_key !== 'string')) {
      return this.json(400, { error: 'bad_request', message: 'iterations' });
    }
    const email = typeof body.google_email === 'string' ? body.google_email.trim().toLowerCase() : null;
    if (email && !/@(gmail|googlemail)\.com$/.test(email)) return this.json(400, { error: 'bad_request', message: 'google_email_domain' });
    if (!hasPw && !email) return this.json(400, { error: 'bad_request', message: 'password' });
    const linkMe = body.link_me === true;
    if (linkMe && body.role !== 'owner') return this.json(400, { error: 'bad_request', message: 'link_me' });
    if (linkMe && dev.user_id) return this.json(400, { error: 'already_linked' });
    const denied = stepUp();
    if (denied) return denied;
    if (this.userByName(username)) return this.json(409, { error: 'username_taken' });
    if (email && [...this.users.values()].some((u) => u.info.google_email === email)) return this.json(409, { error: 'google_email_taken' });
    const id = `user-${++this.userCounter}`;
    const now = this.nowIso();
    const u: FakeUser = {
      info: {
        id, username, display_name: typeof body.display_name === 'string' && body.display_name.trim() ? body.display_name.trim() : username,
        role: body.role, google_email: email, google_linked: false,
        google_email_expires_at: email ? new Date(this.clock() + 48 * 3_600_000).toISOString() : null,
        has_password: hasPw, created_at: now, updated_at: now, disabled_at: null,
      },
      salt: hasPw ? (body.salt as string) : `salt-${id}`,
      client_key: hasPw ? (body.client_key as string) : null,
    };
    this.users.set(id, u);
    if (linkMe) {
      dev.user_id = id;
      dev.info.user_id = id;
    }
    this.event('user.create', { actor_device_id: dev.info.id, actor_user_id: dev.user_id ?? null, target_user_id: id, detail: { username, role: body.role } });
    return this.json(200, { user: clone(u.info), ...this.envelope() });
  }

  private updateUser(dev: FakeDevice, id: string, body: unknown, stepUp: () => Response | null): Response {
    if (!isObj(body)) return this.json(400, { error: 'bad_request' });
    const u = this.users.get(id);
    if (!u) return this.json(404, { error: 'not_found' });
    const self = dev.user_id === id;
    if (self && body.role !== undefined && body.role !== u.info.role) return this.json(400, { error: 'cannot_change_own_role' });
    if (self && body.disabled === true) return this.json(400, { error: 'cannot_disable_self' });
    const sensitive = body.role !== undefined || body.google_email !== undefined || body.disabled !== undefined;
    if (sensitive) {
      const denied = stepUp();
      if (denied) return denied;
    }
    const now = this.nowIso();
    const changed: Record<string, unknown> = {};
    if (typeof body.display_name === 'string' && body.display_name.trim()) {
      u.info.display_name = body.display_name.trim();
      changed.display_name = u.info.display_name;
    }
    if (body.role === 'owner' || body.role === 'staff') {
      const losesOwner = u.info.role === 'owner' && body.role === 'staff';
      const others = [...this.users.values()].filter((x) => x.info.id !== id && x.info.role === 'owner' && !x.info.disabled_at).length;
      if (losesOwner && others < 1) return this.json(409, { error: 'last_owner' });
      u.info.role = body.role;
      changed.role = body.role;
      for (const d of this.devices.values()) if (d.user_id === id && !d.info.revoked_at) d.info.role = body.role;
    }
    if (body.google_email !== undefined) {
      const email = typeof body.google_email === 'string' ? body.google_email.trim().toLowerCase() : null;
      if (email && !/@(gmail|googlemail)\.com$/.test(email)) return this.json(400, { error: 'bad_request', message: 'google_email_domain' });
      if (email && [...this.users.values()].some((x) => x.info.id !== id && x.info.google_email === email)) return this.json(409, { error: 'google_email_taken' });
      u.info.google_email = email;
      u.info.google_linked = false;
      u.info.google_email_expires_at = email ? new Date(this.clock() + 48 * 3_600_000).toISOString() : null;
      changed.google_email = email;
    }
    if (typeof body.disabled === 'boolean') {
      if (body.disabled && u.info.role === 'owner' && !u.info.disabled_at) {
        const others = [...this.users.values()].filter((x) => x.info.id !== id && x.info.role === 'owner' && !x.info.disabled_at).length;
        if (others < 1) return this.json(409, { error: 'last_owner' });
      }
      u.info.disabled_at = body.disabled ? (u.info.disabled_at ?? now) : null;
      changed.disabled = body.disabled;
      if (body.disabled) for (const d of this.devices.values()) if (d.user_id === id && !d.info.revoked_at) d.info.revoked_at = now;
    }
    u.info.updated_at = now;
    this.event('user.update', { actor_device_id: dev.info.id, actor_user_id: dev.user_id ?? null, target_user_id: id, detail: changed });
    return this.json(200, { user: clone(u.info), ...this.envelope() });
  }

  private setPassword(dev: FakeDevice, id: string, body: unknown, stepUp: () => Response | null): Response {
    if (!isObj(body) || typeof body.salt !== 'string' || typeof body.client_key !== 'string') return this.json(400, { error: 'bad_request', message: 'salt' });
    if (body.iterations !== PBKDF2_DEFAULT_ITERATIONS) return this.json(400, { error: 'bad_request', message: 'iterations' });
    const self = dev.user_id === id;
    if (!self && dev.info.role !== 'owner') return this.json(403, { error: 'forbidden' });
    if (!self && dev.client === 'web') return this.json(403, { error: 'web_forbidden' });
    const u = this.users.get(id);
    if (!u) return this.json(404, { error: 'not_found' });
    if (self) {
      if (typeof body.current_client_key !== 'string') return this.json(400, { error: 'bad_request', message: 'current_client_key' });
      if (u.client_key !== body.current_client_key) return this.json(403, { error: 'invalid_login' });
    } else {
      const denied = stepUp();
      if (denied) return denied;
    }
    u.salt = body.salt;
    u.client_key = body.client_key;
    u.info.has_password = true;
    u.info.updated_at = this.nowIso();
    this.loginFails.delete(u.info.username);
    for (const d of this.devices.values()) {
      if (d.user_id === id && !d.info.revoked_at && !(self && d.info.id === dev.info.id)) d.info.revoked_at = this.nowIso();
    }
    this.event(self ? 'password.change' : 'password.reset', { actor_device_id: dev.info.id, actor_user_id: dev.user_id ?? null, target_user_id: id });
    return this.json(200, { ok: true, ...this.envelope() });
  }

  private deviceList(): DeviceInfo[] {
    return [...this.devices.values()].map((d) => clone(d.info));
  }

  private append(tbl: Tbl, rowId: string, deviceId: string): number {
    this.seq++;
    this.log.push({ seq: this.seq, tbl, row_id: rowId, device_id: deviceId });
    return this.seq;
  }

  private block(maxLocal: number): { start: number; end: number } {
    this.codeSeq = Math.max(this.codeSeq, maxLocal) + CODE_BLOCK_SIZE;
    return { start: this.codeSeq - CODE_BLOCK_SIZE + 1, end: this.codeSeq };
  }

  private setup(headers: Headers, body: unknown): Response {
    if (!this.setupKey) return this.json(404, { error: 'not_found' });
    if (headers.get('X-Setup-Key') !== this.setupKey) return this.json(403, { error: 'forbidden' });
    if (isObj(body) && typeof body.shop_name === 'string' && body.shop_name.trim()) this.shop.name = body.shop_name.trim();
    return this.json(200, { shop: clone(this.shop), code: this.mintCode('owner'), expires_at: new Date(this.clock() + 86_400_000).toISOString() });
  }

  private pair(body: unknown): Response {
    if (!isObj(body) || typeof body.code !== 'string') return this.json(400, { error: 'bad_request' });
    const name = typeof body.device_name === 'string' ? body.device_name.trim() : '';
    if (!name || name.length > 60) return this.json(400, { error: 'bad_request' });
    const code = body.code.replace(/[\s-]+/g, '').toUpperCase();
    let role: Role;
    const pc = this.pairCodes.get(code);
    if (pc && !pc.used) {
      pc.used = true;
      role = pc.role;
    } else if (this.recovery.has(code)) {
      this.recovery.delete(code);
      role = 'owner';
    } else {
      return this.json(403, { error: 'invalid_code' });
    }
    const id = `dev-${++tokenCounter}`;
    const token = `tok-${tokenCounter}-${Math.random().toString(36).slice(2)}`;
    const now = this.nowIso();
    this.devices.set(id, {
      info: { id, name, role, created_at: now, last_seen_at: null, revoked_at: null },
      token, shop_id: this.shop.id, wipe: false, requests: 0,
    });
    if (typeof body.previous_device_id === 'string') {
      const prev = this.devices.get(body.previous_device_id);
      if (prev && !prev.info.revoked_at) prev.info.revoked_at = now;
    }
    const max = typeof body.max_local_code === 'number' ? body.max_local_code : 0;
    return this.json(200, {
      token, device_id: id, role, shop: clone(this.shop), code_block: this.block(max), ...this.envelope(),
    });
  }

  // ---------------------------------------------------------------- push

  private push(dev: FakeDevice, body: unknown): Response {
    if (!isObj(body)) return this.json(400, { error: 'bad_request' });
    const custIn = (Array.isArray(body.customers) ? body.customers : []) as CustomerRow[];
    const entIn = (Array.isArray(body.entries) ? body.entries : []) as EntryRow[];
    if (custIn.length + entIn.length > MAX_PUSH_ROWS) return this.json(413, { error: 'too_many_rows' });
    const now = this.nowIso();
    const today = bizDateIST(new Date(this.clock()));
    const results: PushResult[] = [];
    const owner = dev.info.role === 'owner';

    // Work on copies; commit at the end (one transaction).
    const custState = new Map(this.customers);
    const entState = new Map(this.entries);
    const codesTaken = new Map<number, string>();
    for (const c of this.customers.values()) codesTaken.set(c.code, c.id);
    const reversed = new Set<string>();
    for (const e of this.entries.values()) if (e.reverses_entry_id) reversed.add(e.reverses_entry_id);
    const knownCust = new Set(custState.keys());
    const pushedCustIds = new Set(custIn.map((x) => x.id));
    const accepted: { tbl: Tbl; id: string; resultIndex: number | null }[] = [];
    const chunkDelta = new Map<string, number>();
    for (const e of entIn) {
      if (this.entries.has(e.id)) continue;
      chunkDelta.set(e.customer_id, (chunkDelta.get(e.customer_id) ?? 0) + e.delta_paise);
    }
    const balance = (id: string) => {
      let b = 0;
      for (const e of this.entries.values()) if (e.customer_id === id) b += e.delta_paise;
      return b;
    };
    const reject = (tbl: Tbl, id: string, reason: RejectReason) => results.push({ tbl, id, status: 'rejected', reason });

    for (const x of custIn) {
      const prev = custState.get(x.id);
      if (prev && same(prev as never, x as never, CUSTOMER_CANONICAL_FIELDS)) {
        results.push({ tbl: 'customers', id: x.id, status: 'already' });
        continue;
      }
      let reason: RejectReason | null = null;
      if (typeof x.name !== 'string' || !x.name.trim() || !Number.isSafeInteger(x.code) || x.code < 1) reason = 'BAD_ROW';
      else if (prev?.erased_at) reason = 'ERASED';
      else if (!owner && !!prev?.archived_at !== !!x.archived_at) reason = 'FORBIDDEN_ROLE';
      else if (codesTaken.has(x.code) && codesTaken.get(x.code) !== x.id) reason = 'CODE_TAKEN';
      else if (x.archived_at && !prev?.archived_at && balance(x.id) + (chunkDelta.get(x.id) ?? 0) !== 0) reason = 'ARCHIVE_NONZERO';
      if (reason) {
        reject('customers', x.id, reason);
        knownCust.delete(x.id);
        continue;
      }
      const row: CustomerRow = {
        id: x.id, code: x.code, name: x.name, search_name: x.search_name ?? null, phone: x.phone ?? null,
        note: x.note ?? null, archived_at: x.archived_at ?? null, erased_at: null,
        created_at: prev?.created_at ?? x.created_at, updated_at: x.updated_at, updated_by: dev.info.id, received_at: now,
      };
      if (prev && prev.code !== row.code && codesTaken.get(prev.code) === x.id) codesTaken.delete(prev.code);
      custState.set(x.id, row);
      knownCust.add(x.id);
      codesTaken.set(row.code, x.id);
      accepted.push({ tbl: 'customers', id: x.id, resultIndex: results.length });
      results.push({ tbl: 'customers', id: x.id, status: 'stored' });
    }

    const unarchive = new Set<string>();
    for (const e of entIn) {
      const prev = entState.get(e.id);
      if (prev) {
        if (same(prev as never, e as never, ENTRY_CANONICAL_FIELDS)) results.push({ tbl: 'entries', id: e.id, status: 'already' });
        else reject('entries', e.id, 'MISMATCH');
        continue;
      }
      let reason: RejectReason | null = null;
      const a = e.amount_paise;
      const d = e.delta_paise;
      if (!Number.isSafeInteger(a) || a <= 0 || !Number.isSafeInteger(d)) reason = 'BAD_AMOUNT';
      else if (e.kind === 'GIVE' && d !== a) reason = 'BAD_AMOUNT';
      else if ((e.kind === 'RECEIVE' || e.kind === 'WRITEOFF') && d !== -a) reason = 'BAD_AMOUNT';
      else if (e.biz_date > addDays(today, 1)) reason = 'FUTURE_DATE';
      else if (e.kind === 'WRITEOFF' && !owner) reason = 'FORBIDDEN_ROLE';
      else if (!knownCust.has(e.customer_id)) reason = 'UNKNOWN_CUSTOMER';
      else if (e.kind === 'REVERSAL') {
        const target = e.reverses_entry_id ?? '';
        const orig = entState.get(target);
        if (!orig) reason = 'UNKNOWN_ORIGINAL';
        else if (orig.kind === 'REVERSAL') reason = 'REVERSAL_OF_REVERSAL';
        else if (reversed.has(target)) reason = 'ALREADY_REVERSED';
        else if (orig.customer_id !== e.customer_id || orig.amount_paise !== a || orig.biz_date !== e.biz_date
          || (orig.mode ?? null) !== (e.mode ?? null) || d !== -orig.delta_paise) reason = 'REVERSAL_MISMATCH';
      }
      if (reason) {
        reject('entries', e.id, reason);
        continue;
      }
      const row: EntryRow = {
        id: e.id, customer_id: e.customer_id, kind: e.kind, amount_paise: a, delta_paise: d, biz_date: e.biz_date,
        note: e.note ?? null, mode: e.mode ?? null, reverses_entry_id: e.reverses_entry_id ?? null,
        device_id: dev.info.id, created_at: e.created_at, received_at: now,
      };
      entState.set(e.id, row);
      if (row.reverses_entry_id) reversed.add(row.reverses_entry_id);
      if (custState.get(row.customer_id)?.archived_at && !pushedCustIds.has(row.customer_id)) unarchive.add(row.customer_id);
      accepted.push({ tbl: 'entries', id: e.id, resultIndex: results.length });
      results.push({ tbl: 'entries', id: e.id, status: 'stored' });
    }
    for (const id of unarchive) {
      const c = custState.get(id);
      if (c) custState.set(id, { ...c, archived_at: null, updated_at: now, updated_by: dev.info.id, received_at: now });
      accepted.push({ tbl: 'customers', id, resultIndex: null });
    }

    // Commit.
    this.customers = new Map([...custState].map(([k, v]) => [k, v]));
    this.entries = entState;
    for (const a of accepted) {
      const seq = this.append(a.tbl, a.id, dev.info.id);
      if (a.resultIndex !== null) results[a.resultIndex].seq = seq;
    }
    for (const r of results) {
      if (r.status !== 'already') continue;
      let max: number | undefined;
      for (const l of this.log) if (l.row_id === r.id) max = l.seq;
      r.seq = max;
    }
    return this.json(200, { results, ...this.envelope() });
  }

  // ---------------------------------------------------------------- pull

  private pull(dev: FakeDevice, q: URLSearchParams): Response {
    const since = Number(q.get('since') ?? '0');
    const limit = Math.min(Math.max(Number(q.get('limit') ?? PULL_PAGE_SIZE), 1), PULL_PAGE_SIZE);
    if (!Number.isInteger(since) || since < 0) return this.json(400, { error: 'bad_request' });
    // since=0 is a full re-pull (local database rebuilt): it includes the caller's own rows, like the real server.
    const page = this.log.filter((l) => l.seq > since && (since === 0 || l.device_id !== dev.info.id)).slice(0, limit + 1);
    const maxSeq = this.log.length ? this.log[this.log.length - 1].seq : 0;
    const hasMore = page.length > limit;
    const rows = hasMore ? page.slice(0, limit) : page;
    const lastSeq = rows.length ? rows[rows.length - 1].seq : since;
    const nextSince = hasMore ? lastSeq : Math.max(lastSeq, maxSeq, since);
    const changes: Change[] = [];
    for (const l of rows) {
      if (l.tbl === 'customers') {
        const c = this.customers.get(l.row_id);
        if (c) changes.push({ seq: l.seq, tbl: 'customers', row: clone(c) });
      } else {
        const e = this.entries.get(l.row_id);
        if (e) changes.push({ seq: l.seq, tbl: 'entries', row: clone(e) });
      }
    }
    return this.json(200, {
      changes, next_since: nextSince, has_more: hasMore, devices: this.deviceList(), shop: clone(this.shop), ...this.envelope(),
    });
  }
}

// ------------------------------------------------------------------ fake platform

export class FakePlatform {
  readonly isNative = false;
  /** Scripted speech (no microphone); push entries onto speech.script to drive voice code. */
  readonly speech = createFakeSpeech([], { delayMs: 0 });
  secrets = new Map<string, string>();
  files = new Map<string, string>();
  online = true;
  model = 'Redmi Note 12';
  /** Throw from secretGet (Keystore key lost). */
  secretBroken = false;
  private onlineCbs = new Set<(online: boolean) => void>();
  private appCbs = new Set<(active: boolean) => void>();

  setOnline(v: boolean): void {
    this.online = v;
    for (const cb of [...this.onlineCbs]) cb(v);
  }

  setActive(v: boolean): void {
    for (const cb of [...this.appCbs]) cb(v);
  }

  listenerCount(): number {
    return this.onlineCbs.size + this.appCbs.size;
  }

  async openExternal(): Promise<boolean> {
    return true;
  }
  async shareText(): Promise<void> {}
  async shareFile(): Promise<boolean> {
    return true;
  }
  async copyText(): Promise<void> {}
  async writePrivateFile(name: string, content: string): Promise<void> {
    this.files.set(name, content);
  }
  async readPrivateFile(name: string): Promise<string | null> {
    return this.files.get(name) ?? null;
  }
  async listPrivateFiles(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async deletePrivateFile(name: string): Promise<void> {
    this.files.delete(name);
  }
  async secretGet(key: string): Promise<string | null> {
    if (this.secretBroken) throw new Error('keystore key unavailable');
    return this.secrets.get(key) ?? null;
  }
  async secretSet(key: string, value: string | null): Promise<void> {
    if (value === null) this.secrets.delete(key);
    else this.secrets.set(key, value);
  }
  async isOnline(): Promise<boolean> {
    return this.online;
  }
  onOnlineChange(cb: (online: boolean) => void): () => void {
    this.onlineCbs.add(cb);
    return () => this.onlineCbs.delete(cb);
  }
  onAppStateChange(cb: (active: boolean) => void): () => void {
    this.appCbs.add(cb);
    return () => this.appCbs.delete(cb);
  }
  onBackButton(): () => void {
    return () => undefined;
  }
  async hapticTap(): Promise<void> {}
  async deviceModel(): Promise<string> {
    return this.model;
  }
  async hideKeyboard(): Promise<void> {}
  async exitApp(): Promise<void> {}
}

// ------------------------------------------------------------------ fake timers

/** Deterministic timer queue for the engine's injected setTimeout/clearTimeout and clock. */
export class FakeTimers {
  t: number;
  private seqNo = 0;
  private queue = new Map<number, { at: number; fn: () => void; ms: number }>();
  /** Every delay ever scheduled, in order (for backoff assertions). */
  scheduled: number[] = [];

  constructor(startMs: number) {
    this.t = startMs;
  }

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seqNo;
    this.queue.set(id, { at: this.t + ms, fn, ms });
    this.scheduled.push(ms);
    return id;
  };

  clearTimeout = (h: unknown): void => {
    this.queue.delete(h as number);
  };

  pending(): number[] {
    return [...this.queue.values()].map((q) => q.at - this.t).sort((a, b) => a - b);
  }

  /** Advance the clock, firing due timers in order (also timers scheduled while advancing). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, q] of this.queue) {
        if (q.at <= end && q.at < nextAt) {
          nextAt = q.at;
          nextId = id;
        }
      }
      if (nextId < 0) break;
      const q = this.queue.get(nextId)!;
      this.queue.delete(nextId);
      this.t = Math.max(this.t, q.at);
      q.fn();
    }
    this.t = end;
  }
}
