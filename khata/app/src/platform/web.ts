/**
 * Browser preview implementation of Platform (`npm run dev`).
 *
 * Nothing here is secure or durable: secrets and "private files" live in localStorage under a `preview-` prefix so a
 * developer can see them in DevTools. The Android build never includes this module (see index.ts / __NATIVE_BUILD__).
 */
import type { Platform } from './types';

const SECRET_PREFIX = 'preview-secret:';
const FILE_PREFIX = 'preview-file:';

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  // Let quota errors propagate: a snapshot that silently failed to save would be worse than a visible error.
  if (value === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}

function checkName(name: string): void {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`Invalid private file name: ${JSON.stringify(name)}`);
  }
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

function download(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    ta.remove();
  }
}

export function createWebPlatform(): Platform {
  return {
    isNative: false,

    async openExternal(uri) {
      try {
        const w = window.open(uri, '_blank');
        if (!w) return false;
        try {
          w.opener = null;
        } catch {
          /* cross-origin window: ignore */
        }
        return true;
      } catch {
        return false;
      }
    },

    async shareText(text, title) {
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share(title ? { title, text } : { text });
          return;
        } catch (e) {
          if (isAbort(e)) return; // user closed the share sheet
        }
      }
      // Desktop preview: no share sheet. Copy so the developer can paste it somewhere.
      await copyText(text);
      console.info('[platform/web] shareText fallback: copied to clipboard\n' + text);
    },

    async shareFile(fileName, content, mimeType, title) {
      const blob = new Blob([content], { type: mimeType });
      if (typeof navigator.share === 'function' && typeof File === 'function') {
        const file = new File([blob], fileName, { type: mimeType });
        const data: ShareData = title ? { files: [file], title } : { files: [file] };
        if (typeof navigator.canShare !== 'function' || navigator.canShare(data)) {
          try {
            await navigator.share(data);
            return true;
          } catch (e) {
            if (isAbort(e)) return false;
          }
        }
      }
      download(fileName, blob);
      return true;
    },

    copyText,

    async writePrivateFile(name, content) {
      checkName(name);
      lsSet(FILE_PREFIX + name, content);
    },

    async readPrivateFile(name) {
      checkName(name);
      return lsGet(FILE_PREFIX + name);
    },

    async listPrivateFiles(prefix) {
      const out: string[] = [];
      try {
        const ls = window.localStorage;
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k && k.startsWith(FILE_PREFIX)) {
            const name = k.slice(FILE_PREFIX.length);
            if (name.startsWith(prefix)) out.push(name);
          }
        }
      } catch {
        return [];
      }
      return out.sort();
    },

    async deletePrivateFile(name) {
      checkName(name);
      try {
        window.localStorage.removeItem(FILE_PREFIX + name);
      } catch {
        /* storage unavailable: nothing to delete */
      }
    },

    async secretGet(key) {
      return lsGet(SECRET_PREFIX + key);
    },

    async secretSet(key, value) {
      lsSet(SECRET_PREFIX + key, value);
    },

    async isOnline() {
      return navigator.onLine;
    },

    onOnlineChange(cb) {
      const on = () => cb(true);
      const off = () => cb(false);
      window.addEventListener('online', on);
      window.addEventListener('offline', off);
      return () => {
        window.removeEventListener('online', on);
        window.removeEventListener('offline', off);
      };
    },

    onAppStateChange(cb) {
      const handler = () => cb(document.visibilityState === 'visible');
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },

    onBackButton() {
      // Browsers have no hardware back button we can intercept without history tricks; the preview ignores it.
      return () => {};
    },

    async hapticTap() {
      /* no-op on web */
    },

    async deviceModel() {
      return 'Browser preview';
    },

    async hideKeyboard() {
      const el = document.activeElement;
      if (el instanceof HTMLElement) el.blur();
    },

    async exitApp() {
      /* no-op on web */
    },
  };
}
