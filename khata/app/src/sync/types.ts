/**
 * Sync engine contract (src/sync/engine.ts implements it; get it with `syncEngine()` from src/sync/index.ts).
 * The engine is optional: an unpaired phone works fully offline and never calls the network.
 */
import type { AuthEvent, ClientKind, ConfigResponse, Role, DeviceInfo, MeResponse, ShopInfo, UserInfo, UserSummary } from '../../../shared/protocol';

export type SyncPhase = 'unpaired' | 'idle' | 'syncing' | 'offline' | 'error' | 'revoked';

export interface SyncStatus {
  phase: SyncPhase;
  /** Rows still to upload (outbox count). */
  pending: number;
  last_sync_at: string | null;
  /** Localizable error code: 'network' | 'server' | 'daily_cap' | 'throttled' | 'revoked' | 'clock' | string */
  error: string | null;
  /** |server - device| clock difference in ms from the last sync (warn above 10 minutes). */
  clock_skew_ms: number;
  /** Rows the server rejected permanently (Needs attention). */
  rejected: number;
}

export interface SyncEngine {
  status(): SyncStatus;
  /** Subscribe to status changes; returns unsubscribe. */
  subscribe(cb: (s: SyncStatus) => void): () => void;
  /**
   * Start triggers: foreground, network regained, 2 s after local writes, every 20 s while open and in use (every
   * minute after 5 minutes with no touch, no save and nothing new from other phones).
   */
  start(): void;
  stop(): void;
  /** Call after any local write; schedules a push in ~2 s (debounced). */
  notifyLocalWrite(): void;
  /**
   * A screen that shows balances opened (a customer's page, Home, the day book): sync now, quietly, when the last
   * cycle ended more than `maxAgeMs` ago (default FRESH_MS, 5 s). Respects the retry backoff; no-op when unpaired.
   */
  refreshIfStale(maxAgeMs?: number): void;
  /** Someone touched the phone: polls go back to every 20 s, and after a quiet spell what is on screen is fetched now. */
  notifyActivity(): void;
  /** After a cycle that brought rows from the server (other phones' entries): `n` = changes pulled. */
  onRemoteChange(cb: (n: number) => void): () => void;
  /** Run one full cycle now (push all, then pull all). Resolves when done; never throws. */
  syncNow(): Promise<SyncStatus>;

  /** First-time server setup from this phone: POST /setup with the developer's setup key, then pair as owner. */
  setupAndPair(serverUrl: string, setupKey: string, shopName: string, deviceName: string): Promise<void>;
  /** Pair with a code (8 digits, or an owner recovery code). Then runs a full sync. */
  pair(serverUrl: string, code: string, deviceName: string): Promise<void>;
  /** Owner: mint a pairing code for another phone. */
  createPairCode(role: Role): Promise<{ code: string; expires_at: string }>;
  /** Owner: issue fresh recovery codes (shown once). */
  createRecoveryCodes(count?: number): Promise<string[]>;
  listDevices(): Promise<DeviceInfo[]>;
  revokeDevice(id: string, wipe: boolean): Promise<void>;
  /** Owner: push shop name/UPI/lang to the server (also stored locally by the caller). */
  updateShop(patch: { name?: string; upi_id?: string | null; lang?: 'ta' | 'en' }): Promise<ShopInfo>;
  /** Owner: erase a customer on the server (needs network) and apply the result locally. */
  eraseCustomer(customerId: string): Promise<void>;
  /** Owner: download the server's full JSON export (as text). */
  downloadServerExport(): Promise<string>;
  /** Forget the server on this phone (keeps local data). */
  disconnect(): Promise<void>;

  /** Re-read counts, resting phase and the account from the repo / private file (once at app start). */
  refreshStatus(): Promise<SyncStatus>;
  /** Rows that had not reached the server when the last 401 arrived (the web shows it before wiping). */
  readonly lastRevokedPending: number;

  // ---- v2 accounts (see engine.ts "v2: accounts")
  /** The signed-in account (null: unpaired, or a v1 paired phone without a login). Loaded by refreshStatus(). */
  getAccount(): AccountInfo | null;
  /** Installs the UI that asks for the owner's password / a recovery code when a call needs step-up. */
  setStepUpProvider(fn: StepUpProvider | null): void;
  config(serverUrl: string): Promise<ConfigResponse>;
  nonce(serverUrl: string): Promise<string>;
  /** prelogin -> PBKDF2 -> /auth/login -> completePairing -> first sync. Throws SyncError (invalid_login, locked, ...). */
  login(serverUrl: string, username: string, password: string, deviceName: string, opts?: { shared?: boolean; onProgress?: (p: LoginProgress) => void }): Promise<AccountInfo>;
  googleLogin(serverUrl: string, idToken: string, deviceName: string, opts?: { shared?: boolean }): Promise<AccountInfo>;
  /**
   * Web only: GET /me with the cookie the browser still holds. null = no live session (401/403); network trouble
   * throws. boot.ts calls it BEFORE choosing a database so a shared-computer session (device.shared) is rebuilt in
   * memory and never written to this computer.
   */
  webSession(): Promise<MeResponse | null>;
  /** Web only: rebuild the local pairing from a still-valid cookie session (`me` from webSession(), else GET /me). */
  resumeWebSession(serverUrl: string, me?: MeResponse): Promise<boolean>;
  logout(opts: { removeData: boolean; force?: boolean }): Promise<void>;
  /** Web only: fetch a customer-code block when none is left. */
  requestCodes(): Promise<void>;
  listUsers(): Promise<UserInfo[]>;
  createUser(input: NewUserInput): Promise<UserInfo>;
  updateUser(id: string, patch: { display_name?: string; role?: Role; google_email?: string | null; disabled?: boolean }): Promise<UserInfo>;
  resetPassword(id: string, newPassword: string): Promise<void>;
  changeOwnPassword(currentPassword: string, newPassword: string): Promise<void>;
  authEvents(): Promise<AuthEvent[]>;
}

/** The signed-in account as kept on this device (never a credential). */
export interface AccountInfo {
  user: UserSummary;
  client: ClientKind;
  /** When the web session ends (null for Android / when unknown). */
  expires_at: string | null;
  signed_in_at: string;
  /** Web only: the session was opened with "shared computer" (in-memory database, nothing persisted). */
  shared?: boolean;
}

export type LoginProgress = 'prelogin' | 'deriving' | 'login';

export interface NewUserInput {
  username: string;
  display_name: string;
  role: Role;
  /** Omit for a Google-only user (then google_email is required). */
  password?: string | null;
  google_email?: string | null;
  /** Attach THIS paired owner phone to the new owner user (bootstrap). */
  link_me?: boolean;
}

export type StepUpAnswer = { kind: 'password'; password: string } | { kind: 'recovery'; code: string };

/** Asked once per attempt; `can` lists what the server accepts; return null to cancel. */
export type StepUpProvider = (req: { can: Array<'password' | 'recovery'>; retry: boolean; attempt: number }) => Promise<StepUpAnswer | null>;

/** Errors thrown by pairing/owner calls: `new SyncError(code)`. Codes: invalid_code, throttled, network,
 *  bad_url, forbidden, unauthorized, revoked, server, setup_disabled, bad_setup_key, daily_cap; v2: invalid_login,
 *  locked, web_owner_only, web_forbidden, stepup_required, stepup_invalid, not_linked, invalid_token, google_off,
 *  username_taken, google_email_taken, last_owner, already_linked, cannot_change_own_role, cannot_disable_self,
 *  password_short, bad_username, cancelled, web_offline. */
export class SyncError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'SyncError';
  }
}
