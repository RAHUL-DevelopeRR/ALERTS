/**
 * Web session end: sign out on the server, close the database, wipe this browser's copy and go back to the login
 * screen (a full reload boots the gate again). Also used when the server answers 401 (session expired/revoked).
 */
import { app } from '../app';
import { SyncError } from '../../sync/types';
import { wipeWebStorage } from './storage';

export async function endWebSession(opts: { logout: boolean }): Promise<void> {
  if (opts.logout) {
    try {
      await app.sync.logout({ removeData: true, force: true });
    } catch (e) {
      if (!(e instanceof SyncError)) console.warn('[web] logout failed', e);
    }
  }
  try {
    app.sync.stop();
  } catch {
    /* ignore */
  }
  try {
    await app.db.close();
  } catch {
    /* ignore */
  }
  await wipeWebStorage();
  window.location.replace(window.location.pathname);
}
