/**
 * Android implementation of Platform on Capacitor 8 plugins.
 *
 * Behaviour notes (from reading the plugins' Android sources in node_modules):
 * - AppLauncher.openUrl fires ACTION_VIEW and resolves {completed:false} when no app handles the URI (no <queries>
 *   needed because it calls startActivity directly). Rejections are mapped to false too.
 * - Share.share rejects with "Share canceled" when the user closes the sheet; that is not an error here.
 *   Files must be file:// URIs under a FileProvider path: we write them to Directory.Cache/share/ and
 *   res/xml/file_paths.xml exposes exactly that folder. The MIME type is inferred natively from the file
 *   extension, so shareFile() makes sure the name carries the extension matching `mimeType`.
 * - SecureStorage (@aparajita) encrypts each value with an AES-GCM key held in AndroidKeyStore and keeps the
 *   ciphertext in a private SharedPreferences file. The key prefix is per-JS-instance state, so it is set before
 *   every first use (ensureSecretPrefix).
 * - App's back-button callback is always enabled: with no JS listener and no WebView history the back button
 *   would do nothing, so we keep one permanent listener and minimise the app when no handler consumes it.
 */
import { App } from '@capacitor/app';
import { AppLauncher } from '@capacitor/app-launcher';
import { Clipboard } from '@capacitor/clipboard';
import { Device } from '@capacitor/device';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Keyboard } from '@capacitor/keyboard';
import { Network } from '@capacitor/network';
import { Share } from '@capacitor/share';
import { SecureStorage, StorageError, StorageErrorType } from '@aparajita/capacitor-secure-storage';
import type { Platform } from './types';

const PRIVATE_DIR = 'private';
const SHARE_DIR = 'share';
const TMP_SUFFIX = '.tmp';
const SECRET_PREFIX = 'kadankanakku_';

const EXT_BY_MIME: Record<string, string> = {
  'text/csv': '.csv',
  'text/plain': '.txt',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'text/html': '.html',
};

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; code?: unknown };
    return `${typeof o.code === 'string' ? o.code + ' ' : ''}${typeof o.message === 'string' ? o.message : ''}`;
  }
  return String(e);
}

/** Filesystem plugin's "does not exist" error: code OS-PLUG-FILE-0008 (see FilesystemErrors.kt). */
function isNotFound(e: unknown): boolean {
  const t = errText(e);
  return t.includes('OS-PLUG-FILE-0008') || /does not exist|not found|ENOENT/i.test(t);
}

function isShareCancel(e: unknown): boolean {
  return /cancel/i.test(errText(e));
}

function checkName(name: string): void {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`Invalid private file name: ${JSON.stringify(name)}`);
  }
}

/** Safe cache file name that still ends in the extension Android needs to infer the MIME type. */
function shareFileName(fileName: string, mimeType: string): string {
  // eslint-disable-next-line no-control-regex
  let name = fileName.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim() || 'file';
  const ext = EXT_BY_MIME[mimeType.split(';')[0].trim().toLowerCase()];
  if (ext && !name.toLowerCase().endsWith(ext)) name += ext;
  return name;
}

/** One native listener per event, fanned out to any number of JS subscribers. */
function fanOut<T>(attach: (emit: (v: T) => void) => Promise<unknown>) {
  const subs = new Set<(v: T) => void>();
  let attached = false;
  return (cb: (v: T) => void): (() => void) => {
    subs.add(cb);
    if (!attached) {
      attached = true;
      attach((v) => {
        for (const s of Array.from(subs)) {
          try {
            s(v);
          } catch (e) {
            console.error('[platform] listener failed', e);
          }
        }
      }).catch((e) => {
        attached = false;
        console.error('[platform] addListener failed', e);
      });
    }
    return () => {
      subs.delete(cb);
    };
  };
}

export function createNativePlatform(): Platform {
  let prefixReady: Promise<void> | null = null;
  const ensureSecretPrefix = (): Promise<void> => {
    if (!prefixReady) {
      prefixReady = SecureStorage.setKeyPrefix(SECRET_PREFIX).catch((e) => {
        prefixReady = null;
        throw e;
      });
    }
    return prefixReady;
  };

  const onOnline = fanOut<boolean>((emit) =>
    Network.addListener('networkStatusChange', (s) => emit(s.connected)),
  );
  const onAppState = fanOut<boolean>((emit) => App.addListener('appStateChange', (s) => emit(s.isActive)));

  // Back button: LIFO stack of handlers; the newest screen/dialog gets the first chance to consume it.
  const backHandlers: Array<() => boolean> = [];
  let backAttached = false;
  const attachBack = () => {
    if (backAttached) return;
    backAttached = true;
    App.addListener('backButton', () => {
      for (let i = backHandlers.length - 1; i >= 0; i--) {
        try {
          if (backHandlers[i]()) return;
        } catch (e) {
          console.error('[platform] back handler failed', e);
          return;
        }
      }
      App.minimizeApp().catch(() => {});
    }).catch((e) => {
      backAttached = false;
      console.error('[platform] backButton listener failed', e);
    });
  };
  // Attach at start-up so the back button minimises the app even before the UI registers a handler.
  attachBack();

  const privatePath = (name: string) => `${PRIVATE_DIR}/${name}`;

  async function readText(path: string): Promise<string | null> {
    try {
      const r = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof r.data === 'string' ? r.data : await r.data.text();
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  return {
    isNative: true,

    async openExternal(uri) {
      try {
        const r = await AppLauncher.openUrl({ url: uri });
        return !!r.completed;
      } catch {
        return false;
      }
    },

    async shareText(text, title) {
      try {
        await Share.share(title ? { text, title, dialogTitle: title } : { text });
      } catch (e) {
        if (!isShareCancel(e)) throw e;
      }
    },

    async shareFile(fileName, content, mimeType, title) {
      const name = shareFileName(fileName, mimeType);
      const { uri } = await Filesystem.writeFile({
        path: `${SHARE_DIR}/${name}`,
        data: content,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      try {
        await Share.share(title ? { files: [uri], title, dialogTitle: title } : { files: [uri] });
      } catch (e) {
        if (!isShareCancel(e)) throw e;
      }
    },

    async copyText(text) {
      await Clipboard.write({ string: text });
    },

    async writePrivateFile(name, content) {
      checkName(name);
      const path = privatePath(name);
      const tmp = path + TMP_SUFFIX;
      // Write the whole file first, then swap it in, so a crash mid-write never truncates the previous copy.
      await Filesystem.writeFile({ path: tmp, data: content, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true });
      await Filesystem.rename({ from: tmp, to: path, directory: Directory.Data, toDirectory: Directory.Data });
    },

    async readPrivateFile(name) {
      checkName(name);
      const path = privatePath(name);
      const main = await readText(path);
      if (main !== null) return main;
      // The plugin's rename deletes the target before renaming; a crash in that window leaves only the .tmp file.
      return readText(path + TMP_SUFFIX);
    },

    async listPrivateFiles(prefix) {
      let names: string[];
      try {
        const r = await Filesystem.readdir({ path: PRIVATE_DIR, directory: Directory.Data });
        names = r.files.filter((f) => f.type !== 'directory').map((f) => f.name);
      } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
      }
      const set = new Set<string>();
      for (const n of names) {
        const base = n.endsWith(TMP_SUFFIX) ? n.slice(0, -TMP_SUFFIX.length) : n;
        // A lone .tmp means the swap was interrupted; readPrivateFile() serves it, so list its final name.
        if (base !== n && !names.includes(base) && base.startsWith(prefix)) set.add(base);
        else if (base === n && n.startsWith(prefix)) set.add(n);
      }
      return Array.from(set).sort();
    },

    async deletePrivateFile(name) {
      checkName(name);
      for (const path of [privatePath(name), privatePath(name) + TMP_SUFFIX]) {
        try {
          await Filesystem.deleteFile({ path, directory: Directory.Data });
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      }
    },

    async secretGet(key) {
      await ensureSecretPrefix();
      try {
        return await SecureStorage.getItem(key);
      } catch (e) {
        // Corrupt ciphertext (e.g. the Keystore key was wiped by an OS update): drop it so the app can re-pair.
        if (e instanceof StorageError && e.code === StorageErrorType.invalidData) {
          console.warn('[platform] secret unreadable, removing', key);
          await SecureStorage.removeItem(key).catch(() => {});
          return null;
        }
        throw e;
      }
    },

    async secretSet(key, value) {
      await ensureSecretPrefix();
      if (value === null) await SecureStorage.removeItem(key);
      else await SecureStorage.setItem(key, value);
    },

    async isOnline() {
      try {
        return (await Network.getStatus()).connected;
      } catch {
        return navigator.onLine;
      }
    },

    onOnlineChange: onOnline,

    onAppStateChange: onAppState,

    onBackButton(cb) {
      attachBack();
      backHandlers.push(cb);
      return () => {
        const i = backHandlers.lastIndexOf(cb);
        if (i >= 0) backHandlers.splice(i, 1);
      };
    },

    async hapticTap() {
      try {
        await Haptics.impact({ style: ImpactStyle.Light });
      } catch {
        /* haptics are best-effort */
      }
    },

    async deviceModel() {
      try {
        const info = await Device.getInfo();
        // Settings.Global.DEVICE_NAME ("Redmi Note 12") when the user/OEM set one; Build.MODEL is often a code.
        const name = (info.name ?? '').trim();
        if (name) return name;
        const make = (info.manufacturer ?? '').trim();
        const model = (info.model ?? '').trim();
        if (!model) return make || 'Android';
        return make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model;
      } catch {
        return 'Android';
      }
    },

    async hideKeyboard() {
      try {
        await Keyboard.hide();
      } catch {
        const el = document.activeElement;
        if (el instanceof HTMLElement) el.blur();
      }
    },

    async exitApp() {
      await App.exitApp();
    },
  };
}
