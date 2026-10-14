/**
 * Sync entry point. The app creates the engine once at startup:
 *
 *   const engine = createSyncEngine(repo, platform());
 *   engine.start();               // triggers: now, foreground, network regained, 30 s after writes, every 15 min
 *   // after every local write:  engine.notifyLocalWrite();
 *
 * `syncEngine()` returns the engine created last (for modules that cannot receive it by argument).
 */
import type { Repo } from '../data/types';
import type { Platform } from '../platform/types';
import { Engine, type SyncEngineOptions } from './engine';
import type { SyncEngine } from './types';

export type { SyncEngine, SyncStatus, SyncPhase } from './types';
export { SyncError } from './types';
export { ApiClient, ApiFailure, normalizeServerUrl, normalizePairCode, isDevHost, errorCodeFor, REQUEST_TIMEOUT_MS } from './api';
export {
  Engine,
  TOKEN_KEY,
  UNSYNCED_FILE_PREFIX,
  BACKOFF_MS,
  DEBOUNCE_MS,
  INTERVAL_MS,
  CODES_LOW_WATER,
  CLOCK_SKEW_LIMIT_MS,
  type SyncEngineOptions,
  type UnsyncedFile,
} from './engine';

let last: Engine | null = null;

export function createSyncEngine(repo: Repo, platform: Platform, opts: SyncEngineOptions = {}): Engine {
  const engine = new Engine(repo, platform, opts);
  last = engine;
  void engine.refreshStatus();
  return engine;
}

/** The engine created by the last createSyncEngine() call. Throws if none was created yet. */
export function syncEngine(): SyncEngine & Engine {
  if (!last) throw new Error('createSyncEngine() has not been called');
  return last;
}
