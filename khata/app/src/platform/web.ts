/**
 * Browser implementation of Platform: the dev preview (`npm run dev`) AND the production web app.
 *
 * - Secrets and "private files" live in localStorage under the historical `preview-` prefixes (kept so existing
 *   previews and e2e runs keep their data). The production web app authenticates with an HttpOnly cookie, so it
 *   stores no token here; nothing in this module is meant to be secret.
 * - shareFile() downloads the file; shareText() uses the Web Share sheet where the browser has one, else copies.
 * - openExternal() opens http(s) links in a new tab with noopener/noreferrer and hands tel:/sms:/upi:/whatsapp:
 *   links to the OS through a link click; other schemes (javascript:, data:, ...) are refused.
 * - speech: Web Speech API (speech-web.ts), or the scripted fake when `window.__KK_FAKE_SPEECH__` is set (e2e).
 * The Android build never includes this module (see index.ts / __NATIVE_BUILD__).
 */
import { createFakeSpeech } from './fake-speech';
import { createWebSpeech } from './speech-web';
import type { Platform, Speech } from './types';

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

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'tel:', 'sms:', 'smsto:', 'mailto:', 'upi:', 'whatsapp:']);

function openViaLink(href: string, newTab: boolean): void {
  const a = document.createElement('a');
  a.href = href;
  if (newTab) a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Short human name for this browser, used as the default device name when pairing ("Chrome on Android"). */
function browserName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser\//.test(ua)
      ? 'Samsung Internet'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iPhone'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /CrOS/.test(ua)
            ? 'Chromebook'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return os ? `${browser} on ${os}` : browser;
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
  let speech: Speech | null = null;
  let wakeLock: { released?: boolean; release(): Promise<void> } | null = null;
  return {
    isNative: false,

    /** Chosen on first use, so an e2e script may set window.__KK_FAKE_SPEECH__ any time before the first mic tap. */
    get speech(): Speech {
      if (!speech) {
        const script = typeof window !== 'undefined' ? window.__KK_FAKE_SPEECH__ : undefined;
        if (Array.isArray(script)) {
          window.__KK_FAKE_SPEECH_OPTIONS__ ??= {};
          const fake = createFakeSpeech(script, window.__KK_FAKE_SPEECH_OPTIONS__);
          window.__KK_FAKE_SPEECH_CALLS__ = fake.calls;
          speech = fake;
        } else {
          speech = createWebSpeech();
        }
        // A hidden tab (phone locked, app switched) ends the session with what was heard so far.
        const s = speech;
        try {
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') void s.stop();
          });
        } catch {
          /* no document (tests) */
        }
      }
      return speech;
    },

    async openExternal(uri) {
      let url: URL;
      try {
        url = new URL(uri, window.location.href);
      } catch {
        return false;
      }
      if (!EXTERNAL_SCHEMES.has(url.protocol)) return false;
      try {
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          // With 'noopener' window.open() returns null even on success, so a blocked popup cannot be detected;
          // fall back to a link click (also new-tab, also noopener) when window.open is unavailable or throws.
          try {
            window.open(url.href, '_blank', 'noopener,noreferrer');
          } catch {
            openViaLink(url.href, true);
          }
        } else {
          // tel:, sms:, upi:, whatsapp: go to the OS handler; no empty tab is left behind.
          openViaLink(url.href, false);
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

    async shareFile(fileName, content, mimeType) {
      // A download is the one behaviour every desktop and mobile browser supports for backups/CSV exports.
      download(fileName, new Blob([content], { type: mimeType }));
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

    async keepAwake(on) {
      // Screen Wake Lock API (Chrome); released by the browser when the tab is hidden, so voice mode asks again
      // on every resume. Missing or refused (no user gesture, battery saver): nothing to do.
      try {
        if (!on) {
          await wakeLock?.release();
          wakeLock = null;
          return;
        }
        const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ released?: boolean; release(): Promise<void> }> } };
        if (!nav.wakeLock || (wakeLock && !wakeLock.released)) return;
        wakeLock = await nav.wakeLock.request('screen');
      } catch {
        wakeLock = null;
      }
    },

    async deviceModel() {
      return browserName();
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
