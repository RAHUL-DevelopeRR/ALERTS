/**
 * Android Speech on @capgo/capacitor-speech-recognition 8.3.2 (Google's SpeechRecognizer).
 *
 * Plugin facts this relies on (node_modules/@capgo/capacitor-speech-recognition, read from source):
 * - available() -> { available }: SpeechRecognizer.isRecognitionAvailable(context). On Android 11+ this only sees the
 *   Google speech service because the manifest declares <queries> for android.speech.RecognitionService.
 * - checkPermissions()/requestPermissions() -> { speechRecognition: 'granted'|'denied'|'prompt' } for RECORD_AUDIO.
 * - start({language, maxResults, partialResults:true, popup:false}): rejects with code 'UNAVAILABLE' when no
 *   recogniser exists, message 'Missing permission' without RECORD_AUDIO, 'Speech recognition is already running.'
 *   when a session is not yet IDLE. With partialResults:true it RESOLVES IMMEDIATELY once listening started
 *   (startInlineListening) and everything else arrives as events:
 *   - 'listeningState' {state:'startingListening'|'started'|'stoppingListening'|'stopped', sessionId, reason,
 *     errorCode?}: 'startingListening' is emitted inside start() before any result; 'stopped' is the last event of
 *     a session (finishSession), after the plugin is IDLE again.
 *   - 'partialResults' {matches?, accumulatedText?}: live partials (onPartialResults, usually one match) AND the
 *     final result (onResults: up to maxResults matches) use the same event; the final one comes right before
 *     'stopped'. No sessionId on this event.
 *   - 'error' {code, message, sessionId}: getErrorCode() names (NO_MATCH, SPEECH_TIMEOUT, NETWORK, ...), followed by
 *     'stopped' with reason 'silence' (NO_MATCH/SPEECH_TIMEOUT) or 'error'.
 * - stop(): posts stopListening() on the main thread; Google normally delivers onResults, and the plugin forces
 *   finishSession('userStop') after 500 ms if it does not.
 * - contextualStrings is ignored on Android (no EXTRA_BIASING_STRINGS in buildRecognizerIntent), so biasPhrases are
 *   not sent. CONFIDENCE_SCORES are not exposed by the plugin.
 * - Events are not retained (notifyListeners without retain), so listeners are attached before the first start().
 * - The plugin has no onPause hook (only handleOnDestroy tears the recogniser down), so native.ts calls stop() when
 *   the app goes to the background: Android 12+ cuts microphone access for background apps anyway, and the session
 *   should end with what was heard rather than with a late AUDIO/CLIENT error.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition';
import type {
  SpeechRecognitionErrorEvent,
  SpeechRecognitionListeningEvent,
  SpeechRecognitionPartialResultEvent,
} from '@capgo/capacitor-speech-recognition';
import { clampAlternatives, cleanAlternatives, listenTimeout, safeCall, speechError } from './speech-common';
import type { Speech, SpeechListenOptions } from './types';

const SILENCE_CODES = new Set(['NO_MATCH', 'SPEECH_TIMEOUT']);
/** How long listen() waits for a previous native session to reach IDLE before trying anyway. */
const IDLE_WAIT_MS = 2500;
/** JS-side fallback after stop() in case the plugin never emits 'stopped'. */
const STOP_FALLBACK_MS = 1500;

interface Session {
  /** Plugin sessionId, known from the 'startingListening' event. */
  id: number | null;
  matches: string[];
  errorCode: string | null;
  /**
   * True once we asked the plugin to stop (user tap, maxMs, app to background). Google often answers
   * stopListening() with onError(ERROR_CLIENT) instead of onResults when little or nothing was said; after our own
   * stop() every error is treated as "end of session" and listen() resolves with what was heard so far.
   */
  stopping: boolean;
  max: number;
  settled: boolean;
  onPartial?: (text: string) => void;
  resolve: (alts: string[]) => void;
  reject: (e: Error) => void;
  timers: Array<ReturnType<typeof setTimeout>>;
}

function errInfo(e: unknown): { code: string; message: string } {
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown };
  return {
    code: typeof o.code === 'string' ? o.code : '',
    message: typeof o.message === 'string' ? o.message : String(e),
  };
}

/** Map a start() rejection to the Speech error contract. */
export function mapStartError(e: unknown): Error {
  const { code, message } = errInfo(e);
  if (code === 'UNAVAILABLE' || /not available/i.test(message)) return new Error('SPEECH_UNAVAILABLE');
  if (/missing permission/i.test(message)) return new Error('SPEECH_PERMISSION');
  if (/already running/i.test(message)) return speechError('BUSY');
  return speechError('START_FAILED');
}

export function createNativeSpeech(): Speech {
  let listeners: Promise<PluginListenerHandle[]> | null = null;
  let current: Session | null = null;
  /** True from our start() call until the plugin reports 'stopped' (or start() fails before starting). */
  let nativeBusy = false;
  let idleWaiters: Array<() => void> = [];

  const markIdle = () => {
    nativeBusy = false;
    const w = idleWaiters;
    idleWaiters = [];
    for (const f of w) f();
  };

  const waitIdle = (ms: number): Promise<void> =>
    nativeBusy
      ? new Promise<void>((res) => {
          const t = setTimeout(res, ms);
          idleWaiters.push(() => {
            clearTimeout(t);
            res();
          });
        })
      : Promise.resolve();

  const settle = (s: Session, outcome: { alts: string[] } | { error: Error }) => {
    if (s.settled) return;
    s.settled = true;
    for (const t of s.timers) clearTimeout(t);
    s.timers = [];
    if (current === s) current = null;
    if ('error' in outcome) s.reject(outcome.error);
    else s.resolve(outcome.alts);
  };

  const finishFromMatches = (s: Session) => settle(s, { alts: cleanAlternatives(s.matches, s.max) });

  const onPartialEvent = (ev: SpeechRecognitionPartialResultEvent) => {
    const s = current;
    if (!s || s.settled || s.id === null) return;
    const matches = Array.isArray(ev.matches) ? ev.matches : [];
    if (matches.length > 0) s.matches = matches.slice();
    const text = (typeof ev.accumulatedText === 'string' && ev.accumulatedText) || matches[0] || '';
    if (text.trim()) safeCall(s.onPartial, text.trim());
  };

  const onStateEvent = (ev: SpeechRecognitionListeningEvent) => {
    const s = current;
    if (ev.state === 'startingListening') {
      if (s && !s.settled && s.id === null && typeof ev.sessionId === 'number') s.id = ev.sessionId;
      return;
    }
    if (ev.state !== 'stopped') return;
    markIdle();
    if (!s || s.settled || s.id === null || ev.sessionId !== s.id) return;
    // s.errorCode only holds errors from before stop() (onErrorEvent ignores later ones); after our own stop the
    // 'stopped' event's errorCode (e.g. CLIENT from stopListening) is not a failure either.
    const code = s.errorCode ?? (!s.stopping && typeof ev.errorCode === 'string' ? ev.errorCode : null);
    if (code && !SILENCE_CODES.has(code)) settle(s, { error: speechError(code) });
    else finishFromMatches(s);
  };

  const onErrorEvent = (ev: SpeechRecognitionErrorEvent) => {
    const s = current;
    if (!s || s.settled || s.id === null || ev.sessionId !== s.id || s.stopping) return;
    if (typeof ev.code === 'string' && ev.code) s.errorCode = ev.code;
  };

  const ensureListeners = (): Promise<PluginListenerHandle[]> => {
    if (!listeners) {
      listeners = Promise.all([
        SpeechRecognition.addListener('partialResults', onPartialEvent),
        SpeechRecognition.addListener('listeningState', onStateEvent),
        SpeechRecognition.addListener('error', onErrorEvent),
      ]).catch((e) => {
        listeners = null;
        throw e;
      });
    }
    return listeners;
  };

  const stop = async (): Promise<void> => {
    const s = current;
    if (!s || s.settled) {
      if (nativeBusy) await SpeechRecognition.stop().catch(() => undefined);
      return;
    }
    s.stopping = true;
    s.timers.push(setTimeout(() => finishFromMatches(s), STOP_FALLBACK_MS));
    try {
      await SpeechRecognition.stop();
    } catch {
      finishFromMatches(s);
    }
  };

  return {
    async available() {
      try {
        return !!(await SpeechRecognition.available()).available;
      } catch {
        return false;
      }
    },

    async ensurePermission() {
      try {
        if ((await SpeechRecognition.checkPermissions()).speechRecognition === 'granted') return true;
        return (await SpeechRecognition.requestPermissions()).speechRecognition === 'granted';
      } catch {
        return false;
      }
    },

    async listen(opts: SpeechListenOptions) {
      if (current && !current.settled) await stop();
      await waitIdle(IDLE_WAIT_MS);
      await ensureListeners();

      const max = clampAlternatives(opts.maxAlternatives);
      let resolve!: (alts: string[]) => void;
      let reject!: (e: Error) => void;
      const done = new Promise<string[]>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const s: Session = {
        id: null,
        matches: [],
        errorCode: null,
        stopping: false,
        max,
        settled: false,
        onPartial: opts.onPartial,
        resolve,
        reject,
        timers: [],
      };
      current = s;
      nativeBusy = true;
      try {
        await SpeechRecognition.start({
          language: opts.lang,
          maxResults: max,
          partialResults: true,
          popup: false,
        });
        if (!s.settled) s.timers.push(setTimeout(() => void stop(), listenTimeout(opts.maxMs)));
      } catch (e) {
        const err = mapStartError(e);
        // Unavailable / no permission: the plugin returned before leaving IDLE. Otherwise wait for its 'stopped'.
        if (err.message === 'SPEECH_UNAVAILABLE' || err.message === 'SPEECH_PERMISSION') markIdle();
        settle(s, { error: err });
      }
      return done;
    },

    stop,
  };
}
