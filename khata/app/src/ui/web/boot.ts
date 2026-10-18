/**
 * Web app boot (called by src/main.ts when __WEB_APP__): the browser is never the ledger of record.
 *
 *   open the persisted sql.js database -> signed in before?  yes: sync (401 -> session ended: wipe, login)
 *                                                            no: GET /me (cookie survived?) -> adopt, else login gate
 *   login gate: user id + password (owner only) or Google; "shared computer" -> in-memory database + in-memory
 *   platform storage (nothing is left on the computer), shared_computer sent to the server (12 h session).
 *   After login: full pull (the first syncNow), then the normal UI.
 *
 * Also installs: the 401 watcher (session ended -> show the unsynced count, wipe this browser's copy, back to the
 * login page), and the "+ Customer" guard (the web creates customers only online and in sync, with a code block
 * requested on demand: a browser never burns 50 codes per login).
 */
import { openRepo } from '../../data/index';
import type { NewCustomerInput, Repo } from '../../data/types';
import type { Platform } from '../../platform/types';
import { createSyncEngine } from '../../sync/index';
import { SyncError, type LoginProgress } from '../../sync/types';
import { getLang, setLang, t } from '../../i18n';
import { app, refreshSettings } from '../app';
import { h } from '../components/dom';
import { alertDialog } from '../components/overlay';
import { logo, showGate } from '../gate';
import { loginGate } from './login-gate';
import { endWebSession } from './session';
import { wipeWebStorage } from './storage';
import { injectWebStyles } from './styles';

/** Platform wrapper for a shared computer: private files and secrets stay in memory (nothing persisted). */
function memoryPlatform(base: Platform): Platform {
  const files = new Map<string, string>();
  const secrets = new Map<string, string>();
  return {
    ...base,
    get speech() {
      return base.speech;
    },
    async writePrivateFile(name, content) {
      files.set(name, content);
    },
    async readPrivateFile(name) {
      return files.get(name) ?? null;
    },
    async listPrivateFiles(prefix) {
      return [...files.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async deletePrivateFile(name) {
      files.delete(name);
    },
    async secretGet(key) {
      return secrets.get(key) ?? null;
    },
    async secretSet(key, value) {
      if (value === null) secrets.delete(key);
      else secrets.set(key, value);
    },
  };
}

/** The web creates a customer only online, after a successful sync, with a code block fetched on demand. */
function guardRepo(repo: Repo): Repo {
  const createCustomer = async (input: NewCustomerInput) => {
    let online = true;
    try {
      online = await app.platform.isOnline();
    } catch {
      online = true;
    }
    if (!online) throw new SyncError('web_offline');
    const st = await app.sync.syncNow();
    if (st.phase !== 'idle') throw new SyncError('web_offline');
    try {
      await app.sync.requestCodes();
    } catch (e) {
      throw e instanceof SyncError ? new SyncError('web_offline', e.message) : e;
    }
    return repo.createCustomer(input);
  };
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === 'createCustomer') return createCustomer;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

async function openWebRepo(memory: boolean): Promise<void> {
  const { repo, db } = await openRepo({ memory });
  app.repo = guardRepo(repo);
  app.db = db;
  await refreshSettings();
  app.sync = createSyncEngine(repo, app.platform, { web: true });
  await app.sync.refreshStatus();
}

function watchSession(): void {
  let handled = false;
  app.sync.subscribe((s) => {
    if (s.phase !== 'revoked' || handled) return;
    handled = true;
    void sessionEnded();
  });
}

/** 401 during a session: say so (with the unsynced count), wipe this browser's copy and return to the login page. */
async function sessionEnded(): Promise<void> {
  const n = app.sync.lastRevokedPending;
  const msg = n > 0 ? `${t('web.sessionEnded')}\n${t('web.sessionEndedUnsynced', { n })}` : t('web.sessionEnded');
  await alertDialog(t('web.sessionEnded'), msg);
  await endWebSession({ logout: false });
}

/**
 * Runs until the browser is signed in: app.repo / app.db / app.sync are then set and the first sync has run.
 * Throws only for a database failure (main.ts shows the boot error).
 */
export async function webPrelude(): Promise<void> {
  injectWebStyles();
  const origin = window.location.origin;
  const basePlatform = app.platform;
  showGate('boot', logo(), h('div', 'spinner'), h('p', { text: t('web.loading') }));
  await openWebRepo(false);

  let signedIn = false;
  let notice: string | null = null;
  if (app.settings.paired) {
    // A local copy from an earlier sign-in: the first sync validates the cookie (401 -> session ended).
    const st = await app.sync.syncNow();
    if (st.phase === 'revoked') {
      // Session expired or revoked: drop this browser's copy, keep only the language choice for the login page.
      const n = app.sync.lastRevokedPending;
      const lang = getLang();
      await app.db.close().catch(() => undefined);
      await wipeWebStorage();
      await openWebRepo(false);
      await app.repo.saveSettings({ lang });
      setLang(lang);
      notice = n > 0 ? `${t('web.sessionEnded')} ${t('web.sessionEndedUnsynced', { n })}` : t('web.sessionEnded');
    } else {
      signedIn = true;
    }
  } else {
    // No local copy (first visit, or site data cleared): a surviving session cookie rebuilds it from GET /me.
    try {
      signedIn = await app.sync.resumeWebSession(origin);
    } catch (e) {
      console.warn('[web] resume failed', e);
      signedIn = false;
    }
  }

  if (!signedIn) {
    let config = null;
    try {
      config = await app.sync.config(origin);
    } catch (e) {
      console.warn('[web] config unavailable', e);
    }
    await loginGate({
      config,
      notice,
      nonce: async () => {
        try {
          return await app.sync.nonce(origin);
        } catch {
          return null;
        }
      },
      signIn: async (how, shared, onProgress: (p: LoginProgress) => void) => {
        if (shared && !app.sync.getAccount()) {
          // Shared computer: nothing persists. Close the persisted (empty) database, drop it, go in-memory.
          app.sync.stop();
          await app.db.close().catch(() => undefined);
          await wipeWebStorage();
          app.platform = memoryPlatform(basePlatform);
          await openWebRepo(true);
        }
        const name = await app.platform.deviceModel().catch(() => 'Browser');
        if (how.kind === 'password') await app.sync.login(origin, how.username, how.password, name, { shared, onProgress });
        else await app.sync.googleLogin(origin, how.idToken, name, { shared });
        await app.repo.setMeta('onboarded', new Date().toISOString());
        await refreshSettings();
      },
    });
  }
  if (!(await app.repo.getMeta('onboarded'))) await app.repo.setMeta('onboarded', new Date().toISOString());
  await refreshSettings();
  watchSession();
}
