/**
 * Scripted Speech for unit tests (Vitest) and end-to-end flows (Playwright), so voice flows run without a
 * microphone or a recogniser.
 *
 * Each listen() takes the next entry of `script` (the array is consumed IN PLACE, so a test may push more entries
 * later) and, after `delayMs`, resolves with those alternatives (best first, capped at maxAlternatives). Partial
 * text is emitted word by word from the first alternative before it resolves; stop() resolves early with the
 * whole entry (at once, or after `stopDelayMs` to model the recogniser's final-result latency after a hold-to-talk
 * release). Special entries:
 * - []                         : silence, resolves [] (also when the script has run out).
 * - ['!SPEECH_ERROR:NETWORK']  : rejects with Error('SPEECH_ERROR:NETWORK') (any message after the '!').
 *
 * In the web build, setting `window.__KK_FAKE_SPEECH__ = [[...alts], ...]` before (or after) the app loads makes
 * platform().speech use this fake (see web.ts). `window.__KK_FAKE_SPEECH_OPTIONS__` = { delayMs, stopDelayMs,
 * available, permission } tunes it; fields are read on every call, so a test can flip them at any time.
 */
import { clampAlternatives, cleanAlternatives, safeCall } from './speech-common';
import type { Speech, SpeechListenOptions } from './types';

export interface FakeSpeechOptions {
  /** Time from listen() to the result, default 30 ms. */
  delayMs?: number;
  /** Time from stop() to the result (the whole entry), default 0: the pending listen() resolves at once. */
  stopDelayMs?: number;
  /** What available() reports and whether listen() works, default true. */
  available?: boolean;
  /** Whether the microphone permission is (or becomes) granted, default true. */
  permission?: boolean;
}

export interface FakeSpeech extends Speech {
  /** Options of every listen() call, oldest first (lets tests assert lang, biasPhrases, ...). */
  readonly calls: SpeechListenOptions[];
  /** Number of stop() calls. */
  readonly stopCount: number;
  /** Number of ensurePermission() calls. */
  readonly permissionRequests: number;
  /** The live script (same array that was passed in). */
  readonly script: string[][];
}

declare global {
  interface Window {
    __KK_FAKE_SPEECH__?: string[][];
    __KK_FAKE_SPEECH_OPTIONS__?: FakeSpeechOptions;
  }
}

export function createFakeSpeech(script: string[][], options: FakeSpeechOptions = {}): FakeSpeech {
  const calls: SpeechListenOptions[] = [];
  let stopCount = 0;
  let permissionRequests = 0;
  let granted: boolean | null = null;
  let active: { finish: () => void; stop: () => void } | null = null;

  const delay = () => (typeof options.delayMs === 'number' && options.delayMs >= 0 ? options.delayMs : 30);
  const stopDelay = () => (typeof options.stopDelayMs === 'number' && options.stopDelayMs > 0 ? options.stopDelayMs : 0);
  const isAvailable = () => options.available !== false;

  return {
    calls,
    get stopCount() {
      return stopCount;
    },
    get permissionRequests() {
      return permissionRequests;
    },
    script,

    async available() {
      return isAvailable();
    },

    async ensurePermission() {
      permissionRequests++;
      granted = options.permission !== false;
      return granted;
    },

    listen(opts) {
      calls.push({ ...opts, biasPhrases: opts.biasPhrases ? [...opts.biasPhrases] : undefined });
      if (active) active.finish();
      if (!isAvailable()) return Promise.reject(new Error('SPEECH_UNAVAILABLE'));
      if (options.permission === false || granted === false) return Promise.reject(new Error('SPEECH_PERMISSION'));

      const entry = script.length > 0 ? (script.shift() ?? []) : [];
      const max = clampAlternatives(opts.maxAlternatives);
      return new Promise<string[]>((resolve, reject) => {
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        let done = false;
        let stopping = false;
        const session = {
          /** stop(): the result comes at once, or after stopDelayMs; partials stop (nothing more is heard). */
          stop: () => {
            if (done || stopping) return;
            stopping = true;
            const ms = stopDelay();
            if (ms <= 0) {
              session.finish();
              return;
            }
            for (const t of timers) clearTimeout(t);
            timers.length = 0;
            timers.push(setTimeout(session.finish, ms));
          },
          finish: () => {
            if (done) return;
            done = true;
            for (const t of timers) clearTimeout(t);
            if (active === session) active = null;
            const first = entry[0];
            if (typeof first === 'string' && first.startsWith('!')) {
              reject(new Error(first.slice(1)));
              return;
            }
            if (typeof first === 'string' && first.trim()) safeCall(opts.onPartial, first.trim());
            resolve(cleanAlternatives(entry, max));
          },
        };
        active = session;

        const total = delay();
        const first = entry[0];
        if (typeof first === 'string' && !first.startsWith('!')) {
          const words = first.trim().split(/\s+/).filter(Boolean);
          words.forEach((_, i) => {
            const at = Math.floor((total * (i + 1)) / (words.length + 1));
            timers.push(setTimeout(() => !done && safeCall(opts.onPartial, words.slice(0, i + 1).join(' ')), at));
          });
        }
        timers.push(setTimeout(session.finish, total));
      });
    },

    async stop() {
      stopCount++;
      active?.stop();
    },
  };
}
