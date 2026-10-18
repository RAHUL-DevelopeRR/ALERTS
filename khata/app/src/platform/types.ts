/**
 * Everything the UI needs from the device, behind one interface so the same UI runs in the browser preview
 * (src/platform/web.ts) and on Android (src/platform/native.ts, Capacitor plugins).
 * Get the active implementation with `platform()` from src/platform/index.ts.
 */
export interface Platform {
  readonly isNative: boolean;
  /** Open an external URI: https://wa.me/..., smsto:..., tel:..., upi://... Resolves false if no app handles it. */
  openExternal(uri: string): Promise<boolean>;
  /** Android share sheet with plain text. */
  shareText(text: string, title?: string): Promise<void>;
  /**
   * Write `content` to a cache file and open the share sheet (Drive, WhatsApp, Files...).
   * Resolves true when the file was handed to a target app (or downloaded, in the browser preview) and false when
   * the user closed the share sheet without picking one. It cannot see what the target app does afterwards (e.g.
   * the user backing out of Drive's save dialog still counts as shared). Other failures reject.
   */
  shareFile(fileName: string, content: string, mimeType: string, title?: string): Promise<boolean>;
  /** Copy to clipboard. */
  copyText(text: string): Promise<void>;
  /** App-private persistent files (rolling local snapshots). */
  writePrivateFile(name: string, content: string): Promise<void>;
  readPrivateFile(name: string): Promise<string | null>;
  listPrivateFiles(prefix: string): Promise<string[]>;
  deletePrivateFile(name: string): Promise<void>;
  /** Keystore-backed secret storage (device token). Web preview uses localStorage. */
  secretGet(key: string): Promise<string | null>;
  secretSet(key: string, value: string | null): Promise<void>;
  /** Online status + change events (used to trigger sync). */
  isOnline(): Promise<boolean>;
  onOnlineChange(cb: (online: boolean) => void): () => void;
  /** App foreground/background (used for the PIN lock timeout and foreground sync). */
  onAppStateChange(cb: (active: boolean) => void): () => void;
  /** Android back button; return true from the handler if it was consumed. Default: minimise app. */
  onBackButton(cb: () => boolean): () => void;
  /** Short vibration on save (no-op on web). */
  hapticTap(): Promise<void>;
  /** Device model, e.g. "Redmi Note 12" (used as default device name). */
  deviceModel(): Promise<string>;
  /** Hide the soft keyboard. */
  hideKeyboard(): Promise<void>;
  /** Exit the app (Android); no-op on web. */
  exitApp(): Promise<void>;
  /** Speech-to-text for voice entry (Android: Google SpeechRecognizer via plugin; web: Web Speech API). */
  readonly speech: Speech;
}

/** One recognition update. Kept for UI code that wants to model partial vs final results explicitly. */
export interface SpeechResult {
  alternatives: string[];
  final: boolean;
}

export type SpeechLang = 'ta-IN' | 'en-IN';

export interface SpeechListenOptions {
  lang: SpeechLang;
  /** Live (interim) transcript, best alternative only. Called zero or more times before listen() settles. */
  onPartial?: (text: string) => void;
  /** Alternatives to request (1-5, default 5). How many come back is up to the recogniser (often one for ta-IN). */
  maxAlternatives?: number;
  /**
   * Phrases to bias recognition towards (customer names). Honoured only where the platform supports it:
   * Android ignores them (the plugin does not pass EXTRA_BIASING_STRINGS); web passes them as
   * SpeechRecognition.phrases only when the browser exposes SpeechRecognitionPhrase, and silently retries without
   * them if the browser rejects them.
   */
  biasPhrases?: string[];
  /** Safety cap: listening is stopped after this many ms (default 15000). The UI's own limit should be shorter. */
  maxMs?: number;
}

/**
 * Speech-to-text. Both real implementations need internet and send the audio to Google (Android's speech service,
 * Chrome's Web Speech backend); the privacy notice must say so.
 *
 * Errors (listen() rejects with an Error whose message is exactly one of):
 * - 'SPEECH_UNAVAILABLE' : no recogniser on this device/browser (non-GMS ROM, Firefox, ...).
 * - 'SPEECH_PERMISSION'  : microphone permission is not granted (call ensurePermission() first).
 * - 'SPEECH_ERROR:<code>': recogniser failure. Android codes (plugin getErrorCode): NETWORK, NETWORK_TIMEOUT,
 *   SERVER, SERVER_DISCONNECTED, AUDIO, CLIENT, INSUFFICIENT_PERMISSIONS, RECOGNIZER_BUSY, START_FAILED,
 *   BUSY (a previous session did not shut down in time; try again),
 *   UNKNOWN_<n> (e.g. UNKNOWN_12 = language not supported, UNKNOWN_13 = language unavailable).
 *   Web codes (SpeechRecognitionErrorEvent.error): network, audio-capture, language-not-supported,
 *   bad-grammar, phrases-not-supported, aborted, ...
 * Silence (Android NO_MATCH / SPEECH_TIMEOUT, web 'no-speech') is not an error: listen() resolves with whatever
 * partial text was heard (usually []).
 */
export interface Speech {
  /** True when a recogniser exists (Android: SpeechRecognizer.isRecognitionAvailable; web: the API is present). */
  available(): Promise<boolean>;
  /** Ask for microphone permission if needed; false if denied. */
  ensurePermission(): Promise<boolean>;
  /**
   * Start listening. onPartial gets live text; resolves with up to `maxAlternatives` final alternatives (best first,
   * trimmed, non-empty, de-duplicated) or [] on silence. stop() ends listening early and still resolves with what
   * was heard. Only one session at a time: a second listen() while one is running stops the first.
   */
  listen(opts: SpeechListenOptions): Promise<string[]>;
  /** Stop the current session (if any); the pending listen() resolves with the result so far. */
  stop(): Promise<void>;
}
