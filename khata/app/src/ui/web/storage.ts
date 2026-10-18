/**
 * Wipes everything the web app keeps in this browser: the sql.js database in IndexedDB (src/db/sqljs.ts stores it
 * under the name below) and the localStorage entries of the web platform (private files such as account.json and
 * daily snapshots, PIN counters). Call after the database has been closed. Never throws.
 */
import { PREVIEW_DB_KEY } from '../../data/index';

/** IndexedDB database name used by src/db/sqljs.ts (kept in sync by test/web.storage.test.ts). */
export const SQLJS_IDB_NAME = 'kadan-kanakku-sqljs';

export async function wipeWebStorage(): Promise<void> {
  try {
    window.localStorage.clear();
  } catch {
    /* storage unavailable */
  }
  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      const req = indexedDB.deleteDatabase(SQLJS_IDB_NAME);
      req.onsuccess = finish;
      req.onerror = finish;
      req.onblocked = finish;
      setTimeout(finish, 3000);
    } catch {
      finish();
    }
  });
}

/** True when a persisted database exists (the browser was signed in before and not in shared mode). */
export async function hasWebDatabase(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  return new Promise<boolean>((resolve) => {
    try {
      const req = indexedDB.open(SQLJS_IDB_NAME);
      let created = false;
      req.onupgradeneeded = () => {
        created = true;
      };
      req.onsuccess = () => {
        const db = req.result;
        const has = !created && db.objectStoreNames.contains('db');
        db.close();
        if (created) indexedDB.deleteDatabase(SQLJS_IDB_NAME);
        resolve(has);
      };
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

void PREVIEW_DB_KEY;
