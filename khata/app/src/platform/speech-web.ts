/**
 * Browser Speech on the Web Speech API (SpeechRecognition / webkitSpeechRecognition).
 *
 * - Chrome (desktop and Android) is the tested target; it streams the audio to Google's servers. Edge and Safari
 *   expose the API with their own (Microsoft / Apple) recognisers; Firefox has none, so available() is false there.
 * - continuous=false, interimResults=true, maxAlternatives 1-5. Chrome ends the session on its own after a pause;
 *   stop() ends it early and the browser still delivers the final result before 'end'.
 * - Contextual biasing (`recognition.phrases = [new SpeechRecognitionPhrase(text, boost)]`) is used only when the
 *   browser exposes SpeechRecognitionPhrase. A browser that has the class but cannot honour it fires the error
 *   'phrases-not-supported'; we then retry once without phrases and never send them again in this page.
 */
import { clampAlternatives, cleanAlternatives, listenTimeout, safeCall, speechError } from './speech-common';
import type { Speech, SpeechListenOptions } from './types';

/** Minimal structural types so we do not depend on the DOM lib's (still evolving) Web Speech typings. */
interface SRAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SRResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SRAlternative;
}
interface SRResultList {
  readonly length: number;
  [index: number]: SRResult;
}
interface SREvent {
  readonly resultIndex: number;
  readonly results: SRResultList;
}
interface SRErrorEvent {
  readonly error: string;
  readonly message?: string;
}
interface SRInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  phrases?: unknown;
  onresult: ((ev: SREvent) => void) | null;
  onerror: ((ev: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SRConstructor = new () => SRInstance;
type PhraseConstructor = new (phrase: string, boost?: number) => unknown;

const MAX_PHRASES = 100;
const PHRASE_BOOST = 3;
/** JS-side fallback after stop() in case the browser never fires 'end'. */
const STOP_FALLBACK_MS = 2000;
const PERMISSION_CODES = new Set(['not-allowed', 'service-not-allowed']);
/** Not failures: nothing (more) was said, or we stopped/aborted the session ourselves. */
const QUIET_CODES = new Set(['no-speech', 'aborted']);

function recognitionCtor(): SRConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SRConstructor; webkitSpeechRecognition?: SRConstructor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function phraseCtor(): PhraseConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognitionPhrase?: PhraseConstructor };
  return typeof w.SpeechRecognitionPhrase === 'function' ? w.SpeechRecognitionPhrase : null;
}

/**
 * Turn a (possibly multi-result) result list into alternatives, best first. With continuous=false there is
 * normally one result; if the browser split the utterance, earlier results contribute their best transcript as a
 * prefix to each alternative of the last result.
 */
export function alternativesFromResults(results: SRResultList | null, max: number): string[] {
  if (!results || results.length === 0) return [];
  const prefix: string[] = [];
  for (let i = 0; i < results.length - 1; i++) {
    const r = results[i];
    if (r && r.length > 0 && r[0]) prefix.push(r[0].transcript);
  }
  const last = results[results.length - 1];
  const alts: string[] = [];
  if (last) {
    for (let j = 0; j < last.length; j++) {
      const a = last[j];
      if (a) alts.push([...prefix, a.transcript].join(' '));
    }
  }
  if (alts.length === 0 && prefix.length > 0) alts.push(prefix.join(' '));
  return cleanAlternatives(alts, max);
}

function bestTranscript(results: SRResultList): string {
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && r.length > 0 && r[0]) parts.push(r[0].transcript);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

interface WebSession {
  rec: SRInstance | null;
  settled: boolean;
  stopping: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  stopAll: () => void;
  settleNow: () => void;
  /** Resolves once this session's listen() promise has settled. */
  whenSettled: Promise<void>;
}

export function createWebSpeech(): Speech {
  let phrasesRejected = false;
  let current: WebSession | null = null;

  const stop = async (): Promise<void> => {
    const s = current;
    if (!s || s.settled) return;
    s.stopping = true;
    if (!s.stopTimer) s.stopTimer = setTimeout(() => s.settleNow(), STOP_FALLBACK_MS);
    s.stopAll();
  };

  return {
    async available() {
      return recognitionCtor() !== null;
    },

    async ensurePermission() {
      if (!recognitionCtor()) return false;
      try {
        const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
        if (perms && typeof perms.query === 'function') {
          const st = await perms.query({ name: 'microphone' as PermissionName });
          if (st.state === 'granted') return true;
          if (st.state === 'denied') return false;
        }
      } catch {
        /* Firefox/Safari may not know the 'microphone' permission name: fall through to getUserMedia */
      }
      const md = navigator.mediaDevices;
      if (!md || typeof md.getUserMedia !== 'function') {
        // No getUserMedia (old browser or insecure context): let recognition itself prompt, if it can.
        return typeof window !== 'undefined' && window.isSecureContext;
      }
      try {
        const stream = await md.getUserMedia({ audio: true });
        for (const t of stream.getTracks()) t.stop();
        return true;
      } catch (e) {
        const name = e && typeof e === 'object' ? (e as { name?: string }).name : '';
        // No microphone at all is not a permission problem; listen() will report SPEECH_ERROR:audio-capture.
        return name === 'NotFoundError' || name === 'OverconstrainedError';
      }
    },

    async listen(opts: SpeechListenOptions) {
      const prev = current;
      if (prev && !prev.settled) {
        await stop();
        // Let the previous recognition end before starting another one (Chrome aborts overlapping sessions).
        await prev.whenSettled;
      }
      const Ctor = recognitionCtor();
      if (!Ctor) throw new Error('SPEECH_UNAVAILABLE');
      const max = clampAlternatives(opts.maxAlternatives);

      return new Promise<string[]>((resolve, reject) => {
        let lastResults: SRResultList | null = null;
        let maxTimer: ReturnType<typeof setTimeout> | null = null;
        let markSettled!: () => void;
        const whenSettled = new Promise<void>((res) => {
          markSettled = res;
        });

        const session: WebSession = {
          whenSettled,
          rec: null,
          settled: false,
          stopping: false,
          stopTimer: null,
          stopAll: () => {
            try {
              session.rec?.stop();
            } catch {
              session.settleNow();
            }
          },
          settleNow: () => finish(null),
        };
        current = session;

        function cleanup() {
          if (maxTimer) clearTimeout(maxTimer);
          if (session.stopTimer) clearTimeout(session.stopTimer);
          const rec = session.rec;
          if (rec) {
            rec.onresult = null;
            rec.onerror = null;
            rec.onend = null;
          }
          if (current === session) current = null;
        }

        function finish(error: Error | null) {
          if (session.settled) return;
          session.settled = true;
          const rec = session.rec;
          cleanup();
          markSettled();
          if (error) {
            try {
              rec?.abort();
            } catch {
              /* already ended */
            }
            reject(error);
          } else {
            resolve(alternativesFromResults(lastResults, max));
          }
        }

        function run(withPhrases: boolean) {
          const rec = new Ctor!();
          session.rec = rec;
          let errorCode: string | null = null;
          rec.lang = opts.lang;
          rec.continuous = false;
          rec.interimResults = true;
          rec.maxAlternatives = max;
          const Phrase = withPhrases ? phraseCtor() : null;
          const phrases = (opts.biasPhrases ?? []).map((p) => p.trim()).filter(Boolean).slice(0, MAX_PHRASES);
          const usedPhrases = !!Phrase && phrases.length > 0 && 'phrases' in rec;
          if (usedPhrases) {
            try {
              rec.phrases = phrases.map((p) => new Phrase!(p, PHRASE_BOOST));
            } catch {
              /* ignore: biasing is best-effort */
            }
          }
          rec.onresult = (ev) => {
            lastResults = ev.results;
            const text = bestTranscript(ev.results);
            if (text) safeCall(opts.onPartial, text);
          };
          rec.onerror = (ev) => {
            errorCode = ev && typeof ev.error === 'string' ? ev.error : 'unknown';
          };
          rec.onend = () => {
            if (session.settled || session.rec !== rec) return;
            if (errorCode === 'phrases-not-supported' && usedPhrases && !session.stopping) {
              phrasesRejected = true;
              run(false);
              return;
            }
            if (errorCode && PERMISSION_CODES.has(errorCode)) finish(new Error('SPEECH_PERMISSION'));
            else if (errorCode && !QUIET_CODES.has(errorCode)) finish(speechError(errorCode));
            else finish(null);
          };
          try {
            rec.start();
          } catch {
            finish(speechError('start-failed'));
          }
        }

        run(!phrasesRejected);
        if (!session.settled) maxTimer = setTimeout(() => void stop(), listenTimeout(opts.maxMs));
      });
    },

    stop,
  };
}
