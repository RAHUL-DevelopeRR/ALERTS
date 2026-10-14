/**
 * Sync engine contract (src/sync/engine.ts implements it; get it with `syncEngine()` from src/sync/index.ts).
 * The engine is optional: an unpaired phone works fully offline and never calls the network.
 */
import type { Role, DeviceInfo, ShopInfo } from '../../../shared/protocol';

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
  /** Start triggers: foreground, network regained, debounced after local writes, every 15 min while open. */
  start(): void;
  stop(): void;
  /** Call after any local write; schedules a push in ~30 s (debounced). */
  notifyLocalWrite(): void;
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
}

/** Errors thrown by pairing/owner calls: `new SyncError(code)`. Codes: invalid_code, throttled, network,
 *  bad_url, forbidden, unauthorized, revoked, server, setup_disabled, bad_setup_key, daily_cap. */
export class SyncError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'SyncError';
  }
}
