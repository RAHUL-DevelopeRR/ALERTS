/**
 * The running app's shared context: repo, db, platform, sync engine and cached settings.
 * Filled once by src/main.ts at boot; screens import `app` and read it at render time.
 */
import type { Db } from '../db/db';
import type { Repo, Settings } from '../data/types';
import type { Platform } from '../platform/types';
import type { SyncEngine } from '../sync/types';
import { setLang } from '../i18n';

export interface AppCtx {
  repo: Repo;
  db: Db;
  platform: Platform;
  sync: SyncEngine;
  settings: Settings;
}

export const app = {} as AppCtx;

/** Re-read settings from the repo and apply the language. */
export async function refreshSettings(): Promise<Settings> {
  app.settings = await app.repo.getSettings();
  setLang(app.settings.lang);
  return app.settings;
}

/** Call after every successful local write so the sync engine schedules a push. */
export function afterWrite(): void {
  try {
    app.sync.notifyLocalWrite();
  } catch (e) {
    console.warn('[ui] notifyLocalWrite failed', e);
  }
}
