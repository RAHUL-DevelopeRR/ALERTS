/**
 * The sync engine (contract: ./types.ts). Follows docs/GROCERY_DEBT_APP_PLAN.md "Sync protocol, step by step
 * (client)"; every transactional step lives in the Repo (src/data/types.ts), so this file only orchestrates:
 *
 *   cycle = push (outbox in chunks of <= MAX_PUSH_ROWS) -> pull (pages until !has_more) -> code-block top-up
 *
 * - Unpaired (no server_url or no device token): phase 'unpaired', never touches the network.
 * - One cycle at a time. syncNow() during a cycle joins it; an automatic trigger during a cycle sets a
 *   "run again" flag so the write that triggered it is not left behind.
 * - sync_epoch is checked in every push/pull response; a change runs repo.handleEpochChange() (re-queue
 *   everything, cursor 0) and restarts the cycle from push.
 * - 413 / 500 batch_failed halve the chunk size for the rest of the cycle (min 1; at 1 row the server answers
 *   BATCH_FAILED itself).
 * - Network / 5xx / 429 -> phase 'offline' or 'error' and an automatic retry on the backoff schedule
 *   (5 s, 30 s, 2 min, 10 min, then hourly, each with +/-20 % jitter). Manual syncNow() always tries now.
 * - 401 -> keep the still-unsynced rows (a private file when the owner asked to wipe), clear the token, unpair.
 * - syncNow() never throws.
 *
 * v2 accounts (shared/protocol.ts "v2: accounts"): login() / googleLogin() create a session device exactly like
 * pair() (same completePairing path), logout() revokes it. Option `web` = the web app: cookie sessions (ApiClient
 * mode 'cookie', same-origin relative URLs, no token in storage), no automatic customer-code blocks (the web asks for
 * one with requestCodes() right before creating a customer), and no previous-device takeover. Owner-power calls go
 * through stepped(): on 403 stepup_required the step-up provider (a UI dialog) supplies the owner's password or a
 * printed recovery code and the call is retried with the proof header.
 */
import {
  MAX_PUSH_ROWS,
  PULL_PAGE_SIZE,
  type AuthEvent,
  type ConfigResponse,
  type CustomerRow,
  type DeviceInfo,
  type EntryRow,
  type LoginExtras,
  type LoginResponse,
  type Role,
  type ShopInfo,
  type UserInfo,
} from '../../../shared/protocol';
import type { Platform } from '../platform/types';
import type { Customer, Repo } from '../data/types';
import { ApiClient, ApiFailure, AUTH_ERRORS, normalizePairCode, normalizeServerUrl, type ApiClientOptions, type StepUpProof } from './api';
import { checkNewPassword, deriveClientKey, newPasswordSet, normalizeUsername } from './password';
import {
  SyncError,
  type AccountInfo,
  type LoginProgress,
  type NewUserInput,
  type StepUpAnswer,
  type StepUpProvider,
  type SyncEngine,
  type SyncPhase,
  type SyncStatus,
} from './types';

/** Platform secret key holding the device bearer token. */
export const TOKEN_KEY = 'device_token';
/** Platform secret key holding the known-device value of the last login (Android; sent as X-KK-Known). */
export const KNOWN_DEVICE_KEY = 'known_device';
/** Private file describing the signed-in account (username, role, session kind). Not a secret; removed at sign-out. */
export const ACCOUNT_FILE = 'account.json';
/** The customer-code "block" a web session starts with: empty, so a customer can be created only after requestCodes(). */
const EMPTY_BLOCK = { start: 1, end: 0 };
/** Max step-up prompts for one owner action. */
const MAX_STEPUP_TRIES = 3;
/** Prefix of the private file that keeps unsynced rows before a remote wipe (`<prefix>-<timestamp>.json`). */
export const UNSYNCED_FILE_PREFIX = 'unsynced-before-wipe';
export const DEBOUNCE_MS = 30_000;
export const INTERVAL_MS = 15 * 60_000;
export const BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 3_600_000];
/** Request a new customer-code block when fewer than this many codes are left. */
export const CODES_LOW_WATER = 10;
/** Store a clock offset (and correct biz_date defaults) only above this skew. */
export const CLOCK_SKEW_LIMIT_MS = 10 * 60_000;
/** Max epoch-change restarts / extra rounds in one cycle (a flapping server must not loop forever). */
const MAX_ROUNDS = 4;
/** Max consecutive pushes that changed nothing (only retriable rows left) before the push phase stops. */
const MAX_IDLE_PUSHES = 2;
/** Safety cap on pull pages per cycle (500 rows each). */
const MAX_PULL_PAGES = 10_000;

export interface SyncEngineOptions {
  fetch?: typeof fetch;
  /** Wall clock in ms (tests). */
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** [0, 1) source for backoff jitter (tests). */
  random?: () => number;
  requestTimeoutMs?: number;
  debounceMs?: number;
  intervalMs?: number;
  backoffMs?: readonly number[];
  /** The web app: cookie sessions on same-origin URLs, no token storage, codes only on request (see module comment). */
  web?: boolean;
  /** PBKDF2 implementation (tests inject a fast stand-in; the server cannot tell). */
  deriveKey?: typeof deriveClientKey;
  /** Asked for the owner's password / a recovery code when a call answers stepup_required (set later with setStepUpProvider). */
  stepUp?: StepUpProvider;
}

type Trigger = 'start' | 'foreground' | 'online' | 'write' | 'interval' | 'retry';
type RoundResult = 'done' | 'epoch';

interface Ctx {
  api: ApiClient;
}

/** Unsynced rows saved before a remote wipe; same shape as a local backup plus the Needs-attention list. */
export interface UnsyncedFile {
  format: 'kadan-kanakku-backup';
  version: 1;
  exported_at: string;
  shop_name: string;
  customers: CustomerRow[];
  entries: EntryRow[];
  /** Marks this file as rows that never reached the server (re-enter them on another phone). */
  unsynced: true;
  needs_attention: { tbl: string; id: string; reason: string; summary: string }[];
}

function wireCustomer(c: Customer): CustomerRow {
  return {
    id: c.id, code: c.code, name: c.name, search_name: c.search_name, phone: c.phone, note: c.note,
    archived_at: c.archived_at, erased_at: c.erased_at, created_at: c.created_at, updated_at: c.updated_at,
    updated_by: c.updated_by, received_at: c.received_at ?? null,
  };
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return a.phase === b.phase && a.pending === b.pending && a.last_sync_at === b.last_sync_at && a.error === b.error
    && a.clock_skew_ms === b.clock_skew_ms && a.rejected === b.rejected;
}

export class Engine implements SyncEngine {
  private readonly nowMs: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private readonly backoff: readonly number[];
  private readonly apiOpts: ApiClientOptions;
  readonly web: boolean;
  private readonly derive: typeof deriveClientKey;
  private stepUpProvider: StepUpProvider | null;
  private account: AccountInfo | null = null;
  /** Rows that had not reached the server when the last 401 arrived (the web shows it before wiping). */
  lastRevokedPending = 0;

  private current: SyncStatus = {
    phase: 'unpaired', pending: 0, last_sync_at: null, error: null, clock_skew_ms: 0, rejected: 0,
  };
  private readonly subs = new Set<(s: SyncStatus) => void>();

  private running: Promise<void> | null = null;
  private rerun = false;
  private started = false;
  private active = true;
  private unsubs: (() => void)[] = [];
  private debounceTimer: unknown = null;
  private intervalTimer: unknown = null;
  private retryTimer: unknown = null;
  private failures = 0;
  private nextRetryAt = 0;
  /** server_time - device time from the latest response of the running cycle (null: none seen). */
  private lastSkew: number | null = null;

  constructor(private readonly repo: Repo, private readonly platform: Platform, opts: SyncEngineOptions = {}) {
    this.nowMs = opts.now ?? (() => Date.now());
    this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.random = opts.random ?? Math.random;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.intervalMs = opts.intervalMs ?? INTERVAL_MS;
    this.backoff = opts.backoffMs && opts.backoffMs.length ? opts.backoffMs : BACKOFF_MS;
    this.web = opts.web === true;
    this.derive = opts.deriveKey ?? deriveClientKey;
    this.stepUpProvider = opts.stepUp ?? null;
    this.apiOpts = {
      fetch: opts.fetch,
      timeoutMs: opts.requestTimeoutMs,
      setTimeout: this.setT,
      clearTimeout: this.clearT,
      mode: this.web ? 'cookie' : 'bearer',
    };
  }

  // ---------------------------------------------------------------- status

  status(): SyncStatus {
    return { ...this.current };
  }

  subscribe(cb: (s: SyncStatus) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  /** Re-read pending/rejected/last-sync and the resting phase from the repo (call once at app start). */
  async refreshStatus(): Promise<SyncStatus> {
    await this.loadAccount();
    if (!this.running) await this.refresh(await this.restingPhase().catch(() => ({})));
    else await this.refresh();
    return this.status();
  }

  /** Resolves when no cycle is running (an automatic cycle started by a trigger included). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  /** ms timestamp of the next automatic retry (0 when none is scheduled). For the UI's "retrying" text and tests. */
  retryAt(): number {
    return this.nextRetryAt;
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    const next = { ...this.current, ...patch };
    if (sameStatus(next, this.current)) return;
    this.current = next;
    const snap = this.status();
    for (const cb of [...this.subs]) {
      try {
        cb(snap);
      } catch {
        /* a broken subscriber must not break sync */
      }
    }
  }

  /** Re-read counts from the repo; `patch` overrides the rest. Never throws. */
  private async refresh(patch: Partial<SyncStatus> = {}): Promise<void> {
    const counts: Partial<SyncStatus> = {};
    try {
      counts.pending = await this.repo.pendingCount();
      counts.rejected = (await this.repo.needsAttention()).length;
      counts.last_sync_at = await this.repo.getMeta('last_sync_at');
    } catch {
      /* keep the previous counts */
    }
    this.setStatus({ ...counts, ...patch });
  }

  /** Phase to show when no cycle is running and nothing went wrong in this session. */
  private async restingPhase(): Promise<Partial<SyncStatus>> {
    const ctx = await this.context().catch(() => null);
    if (!ctx) {
      const err = await this.repo.getMeta('last_sync_error').catch(() => null);
      return err === 'revoked' ? { phase: 'revoked', error: 'revoked' } : { phase: 'unpaired', error: null };
    }
    if (this.current.phase === 'unpaired' || this.current.phase === 'revoked' || this.current.phase === 'syncing') {
      const err = await this.repo.getMeta('last_sync_error').catch(() => null);
      return { phase: err ? (err === 'network' ? 'offline' : 'error') : 'idle', error: err };
    }
    return {};
  }

  // ---------------------------------------------------------------- context

  private async token(): Promise<string | null> {
    try {
      return await this.platform.secretGet(TOKEN_KEY);
    } catch {
      return null; // Keystore key lost: behave as unpaired (show the Pair screen), never crash
    }
  }

  /** API client for the paired server, or null when unpaired (no server_url; on Android also no token). */
  private async context(): Promise<Ctx | null> {
    const url = await this.repo.getMeta('server_url');
    if (!url) return null;
    if (this.web) return { api: new ApiClient('', async () => null, this.apiOpts) };
    if (!(await this.token())) return null;
    let base: string;
    try {
      base = normalizeServerUrl(url);
    } catch {
      return null;
    }
    return { api: new ApiClient(base, () => this.token(), this.apiOpts) };
  }

  /** Unauthenticated client for login-time routes. Web: same-origin relative URLs whatever `base` says. */
  private publicApi(base: string): ApiClient {
    return new ApiClient(this.web ? '' : base, async () => null, this.apiOpts);
  }

  private async secret(key: string): Promise<string | null> {
    try {
      return await this.platform.secretGet(key);
    } catch {
      return null;
    }
  }

  private trackClock(serverTime: string | undefined): void {
    if (!serverTime) return;
    const t = Date.parse(serverTime);
    if (!Number.isFinite(t)) return;
    this.lastSkew = t - this.nowMs();
    this.setStatus({ clock_skew_ms: Math.abs(this.lastSkew) });
  }

  /** meta.clock_offset_ms = skew when it is beyond the limit, else 0 (the phone clock is fine). */
  private async persistClock(): Promise<void> {
    if (this.lastSkew === null) return;
    const off = Math.abs(this.lastSkew) > CLOCK_SKEW_LIMIT_MS ? Math.round(this.lastSkew) : 0;
    const cur = Number(await this.repo.getMeta('clock_offset_ms')) || 0;
    if (cur !== off) await this.repo.setMeta('clock_offset_ms', String(off));
  }

  /** True (after re-queueing everything) when the server's sync_epoch differs from ours. */
  private async epochChanged(epoch: string | undefined): Promise<boolean> {
    if (!epoch) return false;
    const mine = await this.repo.getMeta('sync_epoch');
    if (mine === epoch) return false;
    await this.repo.handleEpochChange(epoch);
    return true;
  }

  // ---------------------------------------------------------------- cycle

  private async push(api: ApiClient): Promise<RoundResult> {
    let size = MAX_PUSH_ROWS;
    let idle = 0;
    for (;;) {
      const batch = await this.repo.outboxBatch(size);
      if (batch.customers.length + batch.entries.length === 0) return 'done';
      let resp;
      try {
        resp = await api.push(batch);
      } catch (e) {
        if (e instanceof SyncError && (e.code === 'too_many_rows' || e.code === 'batch_failed') && size > 1) {
          size = Math.max(1, Math.floor(size / 2));
          continue;
        }
        throw e;
      }
      this.trackClock(resp.server_time);
      if (await this.epochChanged(resp.sync_epoch)) return 'epoch';
      const c = await this.repo.applyPushResults(resp.results, resp.server_time);
      void this.refresh();
      if (c.accepted + c.rejected > 0) idle = 0;
      else if (++idle >= MAX_IDLE_PUSHES) return 'done'; // only retriable rows left; the next cycle retries them
    }
  }

  private async pull(api: ApiClient): Promise<RoundResult> {
    for (let i = 0; i < MAX_PULL_PAGES; i++) {
      const since = Number(await this.repo.getMeta('cursor')) || 0;
      const page = await api.pull(since, PULL_PAGE_SIZE);
      this.trackClock(page.server_time);
      if (await this.epochChanged(page.sync_epoch)) return 'epoch';
      await this.repo.applyPullPage(page, since); // ignored if a restore/requeue reset the cursor meanwhile
      if (!page.has_more || page.next_since <= since) return 'done';
    }
    return 'done';
  }

  /** Tops up customer codes; true when a block was added. The web never tops up by itself (see requestCodes). */
  private async ensureCodes(api: ApiClient, lowWater = CODES_LOW_WATER): Promise<boolean> {
    if (this.web && lowWater === CODES_LOW_WATER) return false;
    if ((await this.repo.codesRemaining()) >= lowWater) return false;
    const max = await this.repo.maxLocalCode();
    const block = await api.codeBlock(max > 0 ? { max_local_code: max } : {});
    this.trackClock(block.server_time);
    await this.repo.addCodeBlock(block.start, block.end);
    return true;
  }

  private async cycle(manual: boolean): Promise<void> {
    let ctx: Ctx | null;
    try {
      ctx = await this.context();
    } catch {
      ctx = null;
    }
    if (!ctx) {
      await this.refresh(await this.restingPhase());
      return;
    }
    if (!manual) {
      let online = true;
      try {
        online = await this.platform.isOnline();
      } catch {
        online = true;
      }
      if (!online) {
        // No request while the OS says offline; the online event triggers the next cycle.
        await this.refresh({ phase: 'offline', error: 'network' });
        return;
      }
    }
    this.lastSkew = null;
    await this.refresh({ phase: 'syncing' });
    try {
      for (let round = 0; ; round++) {
        if (round >= MAX_ROUNDS) throw new SyncError('server', 'sync did not settle (epoch changing)');
        if ((await this.push(ctx.api)) === 'epoch') continue;
        if ((await this.pull(ctx.api)) === 'epoch') continue;
        if ((await this.ensureCodes(ctx.api)) && (await this.repo.pendingCount()) > 0) {
          // A CODE_TAKEN customer may have been waiting for codes: one more push with the new block.
          if ((await this.push(ctx.api)) === 'epoch') continue;
        }
        break;
      }
      await this.persistClock();
      const at = new Date(this.nowMs()).toISOString();
      await this.repo.setMeta('last_sync_at', at);
      await this.repo.setMeta('last_sync_error', null);
      this.failures = 0;
      this.nextRetryAt = 0;
      this.clearRetry();
      await this.refresh({ phase: 'idle', error: null, last_sync_at: at });
    } catch (e) {
      await this.persistClock().catch(() => undefined);
      await this.onFailure(e);
    }
  }

  private async onFailure(e: unknown): Promise<void> {
    const code = e instanceof SyncError ? e.code : 'local';
    if (AUTH_ERRORS.has(code)) {
      await this.handleRevoked(e instanceof ApiFailure && e.wipe);
      return;
    }
    if (code === 'unpaired') {
      await this.refresh(await this.restingPhase());
      return;
    }
    const phase: SyncPhase = code === 'network' ? 'offline' : 'error';
    try {
      await this.repo.setMeta('last_sync_error', code);
    } catch {
      /* ignore */
    }
    this.scheduleRetry();
    await this.refresh({ phase, error: code });
  }

  private scheduleRetry(): void {
    this.failures++;
    const base = this.backoff[Math.min(this.failures - 1, this.backoff.length - 1)];
    const delay = Math.max(0, Math.round(base * (0.8 + 0.4 * this.random())));
    this.nextRetryAt = this.nowMs() + delay;
    this.clearRetry();
    if (this.started) {
      this.retryTimer = this.setT(() => {
        this.retryTimer = null;
        this.trigger('retry');
      }, delay);
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.clearT(this.retryTimer);
    this.retryTimer = null;
  }

  // ---------------------------------------------------------------- revoke / unsynced rows

  /** Writes the still-unsynced rows to a private file. Returns false if they could not be saved. */
  private async saveUnsynced(): Promise<boolean> {
    try {
      // Every row that exists on no server (also the ones the push skips: entries under a never-accepted
      // rejected customer, void reversals of a refused original, the refused rows themselves).
      const rows = await this.repo.unsyncedRows();
      const attention = await this.repo.needsAttention();
      if (rows.customers.length + rows.entries.length + attention.length === 0) return true;
      const customers = [...rows.customers];
      const have = new Set(customers.map((c) => c.id));
      const wanted = [...rows.entries.map((e) => e.customer_id), ...attention.map((a) => a.customer_id)];
      for (const id of wanted) {
        if (have.has(id)) continue;
        const c = await this.repo.getCustomer(id);
        if (c) customers.push(wireCustomer(c));
        have.add(id);
      }
      const now = new Date(this.nowMs()).toISOString();
      const file: UnsyncedFile = {
        format: 'kadan-kanakku-backup',
        version: 1,
        exported_at: now,
        shop_name: (await this.repo.getMeta('shop_name')) ?? '',
        customers,
        entries: rows.entries,
        unsynced: true,
        needs_attention: attention.map((a) => ({ tbl: a.tbl, id: a.id, reason: a.reason, summary: a.summary })),
      };
      const stamp = now.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      await this.platform.writePrivateFile(`${UNSYNCED_FILE_PREFIX}-${stamp}.json`, JSON.stringify(file));
      return true;
    } catch {
      return false;
    }
  }

  /** 401: keep what never reached the server, clear the token, forget the pairing (and wipe if asked). */
  private async handleRevoked(wipe: boolean): Promise<void> {
    this.clearRetry();
    this.failures = 0;
    this.nextRetryAt = 0;
    try {
      this.lastRevokedPending = await this.repo.pendingCount();
    } catch {
      this.lastRevokedPending = 0;
    }
    // Never destroy rows that exist nowhere else: wipe only once they are safely in the private file.
    const canWipe = wipe ? await this.saveUnsynced() : false;
    try {
      await this.platform.secretSet(TOKEN_KEY, null);
    } catch {
      /* the server already refuses the token */
    }
    try {
      await this.repo.unpair(canWipe);
      await this.repo.setMeta('last_sync_error', 'revoked');
    } catch {
      /* status below still says revoked */
    }
    await this.saveAccount(null);
    await this.refresh({ phase: 'revoked', error: 'revoked', clock_skew_ms: 0 });
  }

  // ---------------------------------------------------------------- running cycles

  private run(manual: boolean): Promise<void> {
    if (this.running) {
      if (!manual) this.rerun = true;
      return this.running;
    }
    const p = (async () => {
      try {
        let first = true;
        let loops = 0;
        do {
          this.rerun = false;
          try {
            await this.cycle(first && manual);
          } catch {
            /* cycle() handles its own errors; this is a last-resort guard */
          }
          first = false;
        } while (this.rerun && this.started && ++loops < 3);
      } finally {
        this.running = null;
      }
    })();
    this.running = p;
    return p;
  }

  private trigger(reason: Trigger): void {
    if (!this.started) return;
    // Backoff applies to automatic triggers; network regained (and the retry timer itself) go now.
    if (reason !== 'online' && reason !== 'retry' && reason !== 'start' && this.nowMs() < this.nextRetryAt) return;
    void this.run(false);
  }

  async syncNow(): Promise<SyncStatus> {
    try {
      await this.run(true);
    } catch {
      /* never throws */
    }
    return this.status();
  }

  notifyLocalWrite(): void {
    void this.refresh();
    if (!this.started) return;
    if (this.debounceTimer !== null) this.clearT(this.debounceTimer);
    this.debounceTimer = this.setT(() => {
      this.debounceTimer = null;
      this.trigger('write');
    }, this.debounceMs);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.active = true;
    this.unsubs.push(
      this.platform.onAppStateChange((active) => {
        this.active = active;
        if (active) {
          this.armInterval();
          this.trigger('foreground');
        } else {
          this.disarmInterval();
        }
      }),
    );
    this.unsubs.push(
      this.platform.onOnlineChange((online) => {
        if (online) this.trigger('online');
      }),
    );
    this.armInterval();
    this.trigger('start');
  }

  stop(): void {
    this.started = false;
    for (const u of this.unsubs.splice(0)) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    if (this.debounceTimer !== null) this.clearT(this.debounceTimer);
    this.debounceTimer = null;
    this.disarmInterval();
    this.clearRetry();
  }

  private armInterval(): void {
    this.disarmInterval();
    if (!this.started || !this.active) return;
    this.intervalTimer = this.setT(() => {
      this.intervalTimer = null;
      this.trigger('interval');
      this.armInterval();
    }, this.intervalMs);
  }

  private disarmInterval(): void {
    if (this.intervalTimer !== null) this.clearT(this.intervalTimer);
    this.intervalTimer = null;
  }

  // ---------------------------------------------------------------- pairing

  async setupAndPair(serverUrl: string, setupKey: string, shopName: string, deviceName: string): Promise<void> {
    const base = normalizeServerUrl(serverUrl);
    const key = (setupKey ?? '').trim();
    if (!key) throw new SyncError('bad_setup_key');
    const api = new ApiClient(base, async () => null, this.apiOpts);
    const name = (shopName ?? '').trim().slice(0, 80);
    const r = await api.setup(key, name || undefined);
    await this.pair(base, r.code, deviceName);
  }

  async pair(serverUrl: string, code: string, deviceName: string): Promise<void> {
    const base = normalizeServerUrl(serverUrl);
    const normCode = normalizePairCode(code);
    const name = await this.resolveDeviceName(deviceName);
    // Never pair in the middle of a cycle against the old server.
    if (this.running) await this.running.catch(() => undefined);
    const api = new ApiClient(base, async () => null, this.apiOpts);
    const oldId = await this.repo.getMeta('device_id');
    const maxLocal = await this.repo.maxLocalCode();
    const r = await api.pair({
      code: normCode,
      device_name: name,
      ...(maxLocal > 0 ? { max_local_code: maxLocal } : {}),
      ...(oldId && !oldId.startsWith('local-') ? { previous_device_id: oldId } : {}),
    });
    this.trackClock(r.server_time);
    await this.platform.secretSet(TOKEN_KEY, r.token);
    await this.repo.completePairing({
      server_url: base,
      device_id: r.device_id,
      device_name: name,
      role: r.role,
      shop: r.shop,
      sync_epoch: r.sync_epoch,
      code_block: r.code_block,
    });
    await this.saveAccount(null);
    this.failures = 0;
    this.nextRetryAt = 0;
    this.clearRetry();
    await this.refresh({ phase: 'idle', error: null });
    await this.syncNow();
  }

  async disconnect(): Promise<void> {
    if (this.running) await this.running.catch(() => undefined);
    this.clearRetry();
    this.failures = 0;
    this.nextRetryAt = 0;
    await this.repo.unpair(false);
    try {
      await this.platform.secretSet(TOKEN_KEY, null);
    } catch {
      /* ignore */
    }
    await this.saveAccount(null);
    await this.refresh({ phase: 'unpaired', error: null, clock_skew_ms: 0 });
  }

  // ---------------------------------------------------------------- v2: accounts

  getAccount(): AccountInfo | null {
    return this.account ? { ...this.account, user: { ...this.account.user } } : null;
  }

  setStepUpProvider(fn: StepUpProvider | null): void {
    this.stepUpProvider = fn;
  }

  private async loadAccount(): Promise<void> {
    try {
      const text = await this.platform.readPrivateFile(ACCOUNT_FILE);
      const v = text ? (JSON.parse(text) as AccountInfo) : null;
      this.account = v && typeof v === 'object' && v.user && typeof v.user.username === 'string' ? v : null;
    } catch {
      this.account = null;
    }
  }

  private async saveAccount(a: AccountInfo | null): Promise<void> {
    this.account = a;
    try {
      if (a) await this.platform.writePrivateFile(ACCOUNT_FILE, JSON.stringify(a));
      else await this.platform.deletePrivateFile(ACCOUNT_FILE);
    } catch {
      /* the account is still known for this run; a missing file only hides the name next time */
    }
  }

  private async resolveDeviceName(deviceName: string): Promise<string> {
    let name = (deviceName ?? '').trim().slice(0, 60);
    if (!name) {
      try {
        name = ((await this.platform.deviceModel()) || '').trim().slice(0, 60);
      } catch {
        name = '';
      }
    }
    return name || (this.web ? 'Browser' : 'Phone');
  }

  /** The LoginExtras every login sends: device name, client kind, takeover of this client's previous row (Android). */
  private async loginExtras(name: string, shared: boolean): Promise<LoginExtras> {
    const extras: LoginExtras = { device_name: name, client: this.web ? 'web' : 'android' };
    const maxLocal = await this.repo.maxLocalCode();
    if (maxLocal > 0) extras.max_local_code = maxLocal;
    if (this.web) {
      if (shared) extras.shared_computer = true;
      return extras;
    }
    const oldId = await this.repo.getMeta('device_id');
    if (oldId && !oldId.startsWith('local-')) {
      extras.previous_device_id = oldId;
      // A v1 paired row is taken over only with proof of possession: its still-valid token.
      const oldToken = await this.token();
      if (oldToken) extras.previous_device_token = oldToken;
    }
    return extras;
  }

  /** GET /config of a server (public; the login screen decides what to offer). */
  async config(serverUrl: string): Promise<ConfigResponse> {
    return this.publicApi(this.web ? '' : normalizeServerUrl(serverUrl)).config();
  }

  /** POST /auth/nonce for Google Identity Services (throws 'google_off' when Google sign-in is off). */
  async nonce(serverUrl: string): Promise<string> {
    return this.publicApi(this.web ? '' : normalizeServerUrl(serverUrl)).nonce();
  }

  async login(
    serverUrl: string,
    username: string,
    password: string,
    deviceName: string,
    opts: { shared?: boolean; onProgress?: (p: LoginProgress) => void } = {},
  ): Promise<AccountInfo> {
    const base = this.web ? '' : normalizeServerUrl(serverUrl);
    const stored = normalizeServerUrl(serverUrl);
    const user = normalizeUsername(username);
    if (typeof password !== 'string' || !password) throw new SyncError('invalid_login');
    if (this.running) await this.running.catch(() => undefined);
    const api = this.publicApi(base);
    opts.onProgress?.('prelogin');
    const pre = await api.prelogin(user);
    opts.onProgress?.('deriving');
    const key = await this.derive(password, pre.salt, pre.iterations);
    opts.onProgress?.('login');
    const name = await this.resolveDeviceName(deviceName);
    const extras = await this.loginExtras(name, opts.shared === true);
    const known = this.web ? null : await this.secret(KNOWN_DEVICE_KEY);
    const r = await api.login({ username: user, client_key: key, ...extras }, known);
    return this.completeLogin(r, stored, name);
  }

  /** Web Google sign-in: `idToken` is the GIS credential minted with a nonce from nonce(). */
  async googleLogin(serverUrl: string, idToken: string, deviceName: string, opts: { shared?: boolean } = {}): Promise<AccountInfo> {
    const base = this.web ? '' : normalizeServerUrl(serverUrl);
    const stored = normalizeServerUrl(serverUrl);
    if (this.running) await this.running.catch(() => undefined);
    const name = await this.resolveDeviceName(deviceName);
    const extras = await this.loginExtras(name, opts.shared === true);
    const r = await this.publicApi(base).googleLogin({ id_token: idToken, ...extras });
    return this.completeLogin(r, stored, name);
  }

  /** Stores the session like pair() does, records the account, runs the first sync. */
  private async completeLogin(r: LoginResponse, serverUrl: string, name: string): Promise<AccountInfo> {
    this.trackClock(r.server_time);
    if (!this.web) {
      if (!r.token) throw new SyncError('server', 'no token');
      await this.platform.secretSet(TOKEN_KEY, r.token);
      try {
        await this.platform.secretSet(KNOWN_DEVICE_KEY, r.known_device);
      } catch {
        /* only loses the throttle exemption */
      }
    }
    await this.repo.completePairing({
      server_url: serverUrl,
      device_id: r.device_id,
      device_name: name,
      role: r.role,
      shop: r.shop,
      sync_epoch: r.sync_epoch,
      code_block: r.code_block ?? EMPTY_BLOCK,
    });
    const account: AccountInfo = {
      user: r.user,
      client: this.web ? 'web' : 'android',
      expires_at: r.expires_at ?? null,
      signed_in_at: new Date(this.nowMs()).toISOString(),
    };
    await this.saveAccount(account);
    this.failures = 0;
    this.nextRetryAt = 0;
    this.clearRetry();
    await this.refresh({ phase: 'idle', error: null });
    await this.syncNow();
    return this.getAccount()!;
  }

  /**
   * Web: a browser whose session cookie is still valid but whose local copy is gone (cleared site data) rebuilds the
   * pairing from GET /me. true = signed in (and synced); false = no session (401). Network trouble throws.
   */
  async resumeWebSession(serverUrl: string): Promise<boolean> {
    const stored = normalizeServerUrl(serverUrl);
    let me;
    try {
      me = await this.publicApi('').me();
    } catch (e) {
      if (e instanceof SyncError && AUTH_ERRORS.has(e.code)) return false;
      throw e;
    }
    if (!me.user) return false;
    await this.repo.completePairing({
      server_url: stored,
      device_id: me.device.id,
      device_name: me.device.name,
      role: me.device.role,
      shop: me.shop,
      sync_epoch: me.sync_epoch,
      code_block: EMPTY_BLOCK,
    });
    await this.saveAccount({ user: me.user, client: 'web', expires_at: null, signed_in_at: new Date(this.nowMs()).toISOString() });
    await this.refresh({ phase: 'idle', error: null });
    await this.syncNow();
    return true;
  }

  /**
   * Sign out: revoke the session on the server, forget it here; `removeData` also deletes the local ledger copy.
   * When the server cannot be reached the call fails with 'network' unless `force` (the UI asks first); the
   * session then stays live on the server until it expires or an owner revokes it.
   */
  async logout(opts: { removeData: boolean; force?: boolean }): Promise<void> {
    if (this.running) await this.running.catch(() => undefined);
    this.clearRetry();
    this.failures = 0;
    this.nextRetryAt = 0;
    const ctx = await this.context();
    if (ctx) {
      try {
        await ctx.api.logout();
      } catch (e) {
        const code = e instanceof SyncError ? e.code : 'local';
        if (!AUTH_ERRORS.has(code) && !opts.force) throw e instanceof SyncError ? e : new SyncError('network');
      }
    }
    try {
      await this.platform.secretSet(TOKEN_KEY, null);
    } catch {
      /* ignore */
    }
    await this.repo.unpair(opts.removeData);
    await this.saveAccount(null);
    await this.refresh({ phase: 'unpaired', error: null, clock_skew_ms: 0 });
  }

  /** Web: fetch a customer-code block when none is left (the web creates customers only online, right after a sync). */
  async requestCodes(): Promise<void> {
    await this.owner(async (api) => {
      await this.ensureCodes(api, 1);
    });
  }

  /** Turns the provider's answer into the proof header value (password -> prelogin + PBKDF2). */
  private async proofFor(api: ApiClient, ans: StepUpAnswer): Promise<StepUpProof> {
    if (ans.kind === 'recovery') {
      const code = normalizePairCode(ans.code);
      if (code.length !== 16) throw new SyncError('invalid_code');
      return { kind: 'recovery', code };
    }
    const username = this.account?.user.username;
    if (!username) throw new SyncError('stepup_invalid');
    const pre = await api.prelogin(username);
    return { kind: 'password', client_key: await this.derive(ans.password, pre.salt, pre.iterations) };
  }

  /** Owner-power call with step-up: retried with a proof from the provider on stepup_required / stepup_invalid. */
  private stepped<T>(fn: (api: ApiClient, proof: StepUpProof | null) => Promise<T>): Promise<T> {
    return this.owner(async (api) => {
      let proof: StepUpProof | null = null;
      for (let attempt = 0; ; attempt++) {
        try {
          return await fn(api, proof);
        } catch (e) {
          if (!(e instanceof ApiFailure) || (e.code !== 'stepup_required' && e.code !== 'stepup_invalid')) throw e;
          if (!this.stepUpProvider || attempt >= MAX_STEPUP_TRIES) throw e;
          const can = e.body?.stepup ?? (this.account ? ['password', 'recovery'] : ['recovery']);
          const ans = await this.stepUpProvider({ can, retry: e.code === 'stepup_invalid', attempt });
          if (!ans) throw new SyncError('cancelled');
          proof = await this.proofFor(api, ans);
        }
      }
    });
  }

  listUsers(): Promise<UserInfo[]> {
    return this.owner(async (api) => (await api.users()).users);
  }

  createUser(input: NewUserInput): Promise<UserInfo> {
    return this.stepped(async (api, proof) => {
      const username = normalizeUsername(input.username);
      const display = (input.display_name ?? '').trim().slice(0, 80) || username;
      const pw = input.password ? await newPasswordSet(input.password, this.derive) : null;
      const email = (input.google_email ?? '').trim().toLowerCase() || null;
      if (!pw && !email) throw new SyncError('password_short');
      const r = await api.createUser(
        { username, display_name: display, role: input.role, ...(pw ?? {}), ...(email ? { google_email: email } : {}), ...(input.link_me ? { link_me: true } : {}) },
        proof,
      );
      if (input.link_me) {
        const u = r.user;
        await this.saveAccount({
          user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role },
          client: 'android',
          expires_at: null,
          signed_in_at: new Date(this.nowMs()).toISOString(),
        });
      }
      return r.user;
    });
  }

  updateUser(id: string, patch: { display_name?: string; role?: Role; google_email?: string | null; disabled?: boolean }): Promise<UserInfo> {
    return this.stepped(async (api, proof) => (await api.updateUser(id, patch, proof)).user);
  }

  /** Owner resets ANOTHER user's password (their devices are revoked). */
  resetPassword(id: string, newPassword: string): Promise<void> {
    return this.stepped(async (api, proof) => {
      const pw = await newPasswordSet(checkNewPassword(newPassword), this.derive);
      await api.setPassword(id, pw, proof);
    });
  }

  /** The signed-in user changes their own password (needs the current one; other devices are revoked). */
  changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
    return this.owner(async (api) => {
      const me = this.account?.user;
      if (!me) throw new SyncError('unpaired');
      checkNewPassword(newPassword);
      const pre = await api.prelogin(me.username);
      const current = await this.derive(currentPassword, pre.salt, pre.iterations);
      const pw = await newPasswordSet(newPassword, this.derive);
      await api.setPassword(me.id, { ...pw, current_client_key: current });
    });
  }

  authEvents(): Promise<AuthEvent[]> {
    return this.owner(async (api) => (await api.authEvents()).events);
  }

  // ---------------------------------------------------------------- owner calls (throw SyncError)

  private async owner<T>(fn: (api: ApiClient) => Promise<T>): Promise<T> {
    const ctx = await this.context();
    if (!ctx) throw new SyncError('unpaired');
    try {
      return await fn(ctx.api);
    } catch (e) {
      if (e instanceof SyncError) {
        if (AUTH_ERRORS.has(e.code)) await this.handleRevoked(e instanceof ApiFailure && e.wipe);
        throw e;
      }
      throw new SyncError('local', e instanceof Error ? e.message : String(e));
    }
  }

  createPairCode(role: Role): Promise<{ code: string; expires_at: string }> {
    return this.stepped(async (api, proof) => {
      const r = await api.pairCode(role, proof);
      this.trackClock(r.server_time);
      return { code: r.code, expires_at: r.expires_at };
    });
  }

  createRecoveryCodes(count?: number): Promise<string[]> {
    return this.stepped(async (api, proof) => (await api.recoveryCodes(count, proof)).codes);
  }

  listDevices(): Promise<DeviceInfo[]> {
    return this.owner(async (api) => {
      const r = await api.devices();
      await this.repo.setDevices(r.devices);
      return r.devices;
    });
  }

  revokeDevice(id: string, wipe: boolean): Promise<void> {
    return this.stepped(async (api, proof) => {
      await api.revoke(id, wipe, proof);
    });
  }

  updateShop(patch: { name?: string; upi_id?: string | null; lang?: 'ta' | 'en' }): Promise<ShopInfo> {
    return this.owner(async (api) => (await api.updateShop(patch)).shop);
  }

  eraseCustomer(customerId: string): Promise<void> {
    return this.owner(async (api) => {
      const r = await api.erase(customerId);
      await this.repo.applyErasure(customerId, r.customer);
      void this.refresh();
    });
  }

  downloadServerExport(): Promise<string> {
    return this.owner((api) => api.exportText());
  }
}
