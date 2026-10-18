/**
 * Web app boot (called by src/main.ts when __WEB_APP__): the browser is never the ledger of record.
 *
 *   a persisted copy exists (IndexedDB)?  yes: open it -> sync (401 -> session ended: wipe, login gate)
 *                                         no: in-memory database first, then GET /me (cookie survived?)
 *                                               -> shared session: stay in memory, adopt it (never persisted)
 *                                               -> normal session: switch to the persisted database, adopt it
 *                                               -> no session: login gate
 *   login gate: user id + password (owner only) or Google; "shared computer" -> in-memory database + in-memory
 *   platform storage (nothing is left on the computer), shared_computer sent to the server (12 h session); otherwise
 *   the persisted database is opened only now. After login: full pull (the first syncNow), then the normal UI.
 *
 * The order matters: the persisted sql.js database is never opened until the session is known NOT to be a shared
 * one (GET /me device.shared, LoginResponse.shared), so a reload on a shared computer rebuilds the ledger in memory
 * again. When the server does not say (older server), the session is treated as shared: in memory is the safe side.
 *
 * Also installs: the 401 watcher (session ended -> show the unsynced count, wipe this browser's copy, back to the
 * login page), and the "+ Customer" guard (the web creates customers only online and in sync, with a code block
 * requested on demand: a browser never burns 50 codes per login).
 */
import type { MeResponse } from '../../../../shared/protocol';
import { openRepo } from '../../data/index';
import type { NewCustomerInput, Repo } from '../../data/types';
import type { Platform } from '../../platform/types';
import { createSyncEngine } from '../../sync/index';
import { SyncError, type LoginProgress } from '../../sync/types';
import { getLang, onLangChange, setLang, t } from '../../i18n';
import { app, refreshSettings } from '../app';
import { h } from '../components/dom';
import { alertDialog } from '../components/overlay';
import { logo, showGate } from '../gate';
import { loginGate } from './login-gate';
import { endWebSession } from './session';
import { hasWebDatabase, rememberLang, rememberedLang, wipeWebStorage } from './storage';
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

/** True when the server says this cookie session is a shared-computer one; unknown (older server) counts as shared. */
export function isSharedSession(me: MeResponse): boolean {
  return me.device.shared !== false;
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
  const startLang = rememberedLang();
  if (startLang) setLang(startLang);
  onLangChange(rememberLang);

  let mode: 'none' | 'memory' | 'persisted' = 'none';
  const closeCurrent = async (): Promise<void> => {
    if (mode === 'none') return;
    try {
      app.sync.stop();
    } catch {
      /* no engine yet */
    }
    await app.db.close().catch(() => undefined);
    mode = 'none';
  };
  /** In-memory database + in-memory platform storage; anything persisted by an earlier visit is removed. */
  const goMemory = async (): Promise<void> => {
    const lang = getLang();
    await closeCurrent();
    await wipeWebStorage();
    app.platform = memoryPlatform(basePlatform);
    await openWebRepo(true);
    await app.repo.saveSettings({ lang });
    setLang(lang);
    mode = 'memory';
  };
  /** The persisted database (IndexedDB), for a session the owner chose to keep on this computer. */
  const goPersisted = async (): Promise<void> => {
    const lang = getLang();
    await closeCurrent();
    app.platform = basePlatform;
    await openWebRepo(false);
    await app.repo.saveSettings({ lang });
    setLang(lang);
    mode = 'persisted';
  };

  let signedIn = false;
  let notice: string | null = null;
  if (await hasWebDatabase()) {
    // A local copy from an earlier (non-shared) sign-in: the first sync validates the cookie (401 -> session ended).
    app.platform = basePlatform;
    await openWebRepo(false);
    mode = 'persisted';
    if (app.settings.paired) {
      const st = await app.sync.syncNow();
      if (st.phase === 'revoked') {
        // Session expired or revoked: drop this browser's copy, keep only the language choice for the login page.
        const n = app.sync.lastRevokedPending;
        notice = n > 0 ? `${t('web.sessionEnded')} ${t('web.sessionEndedUnsynced', { n })}` : t('web.sessionEnded');
        await goMemory();
      } else {
        signedIn = true;
      }
    } else {
      // An empty database without a sign-in (older build): nothing to keep.
      await goMemory();
    }
  } else {
    await goMemory();
  }

  if (!signedIn) {
    // No local copy (first visit, shared computer reloaded, or site data cleared): ask the server whether the
    // cookie still names a session, and only then decide where that session may live.
    let me: MeResponse | null = null;
    try {
      me = await app.sync.webSession();
    } catch (e) {
      console.warn('[web] session check failed', e);
    }
    if (me) {
      if (!isSharedSession(me)) await goPersisted();
      try {
        signedIn = await app.sync.resumeWebSession(origin, me);
      } catch (e) {
        console.warn('[web] resume failed', e);
        signedIn = false;
      }
      if (!signedIn && mode === 'persisted') await goMemory();
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
        // The database is chosen by the checkbox: shared -> stay in memory (nothing persists); otherwise the
        // persisted one is opened now, for the first time in this visit.
        if (shared && mode !== 'memory') await goMemory();
        if (!shared && mode !== 'persisted') await goPersisted();
        const name = await app.platform.deviceModel().catch(() => 'Browser');
        try {
          if (how.kind === 'password') await app.sync.login(origin, how.username, how.password, name, { shared, onProgress });
          else await app.sync.googleLogin(origin, how.idToken, name, { shared });
        } catch (e) {
          // A failed sign-in leaves nothing behind: back to the in-memory database until the next attempt.
          if (mode === 'persisted') await goMemory();
          throw e;
        }
        if (app.sync.getAccount()?.shared && mode !== 'memory') {
          // Belt and braces: the server says shared (it decides the session length) -> never keep a copy here.
          await goMemory();
          await app.sync.resumeWebSession(origin);
        }
        await app.repo.setMeta('onboarded', new Date().toISOString());
        await refreshSettings();
      },
    });
  }
  if (!(await app.repo.getMeta('onboarded'))) await app.repo.setMeta('onboarded', new Date().toISOString());
  await refreshSettings();
  watchSession();
}
