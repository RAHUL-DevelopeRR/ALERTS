/** Small helpers shared by the Speech implementations (native, web, fake). Pure, no DOM. */

export const DEFAULT_MAX_ALTERNATIVES = 5;
/** Safety cap on one listening session when the caller passes no maxMs. */
export const DEFAULT_MAX_LISTEN_MS = 15_000;

/** 1..5, default 5. */
export function clampAlternatives(n: number | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_MAX_ALTERNATIVES;
  return Math.min(DEFAULT_MAX_ALTERNATIVES, Math.max(1, Math.floor(n)));
}

export function listenTimeout(ms: number | undefined): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_MAX_LISTEN_MS;
}

/** Trim, collapse whitespace, drop empties and duplicates, keep order (best first), cap at `max`. */
export function cleanAlternatives(list: readonly unknown[] | null | undefined, max: number): string[] {
  const out: string[] = [];
  if (!list) return out;
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Privacy notice for voice entry, in both app languages. The UI shows it (Settings → Privacy and the first mic
 * tap); it is true for every real Speech implementation: Android sends the audio to Google's speech service, the
 * browser build to Chrome's (Google) speech backend. Keep the wording in step with `Speech` in types.ts.
 */
export const SPEECH_PRIVACY_NOTE: Readonly<Record<'en' | 'ta', string>> = {
  en:
    'Voice entry sends what you say to Google\u2019s speech recognition service to turn it into text (Android: Google\u2019s speech service; browser: Chrome). It needs internet. The app does not keep the audio; only the entry is saved: after you tap Save, or, for a clear sentence with auto-save on, when its 3-second card runs out (Cancel or Undo stop it).',
  ta:
    'குரல் பதிவில் நீங்கள் பேசுவது உரையாக மாற்ற Google-இன் பேச்சு அறிதல் சேவைக்கு அனுப்பப்படுகிறது (ஆண்ட்ராய்டு: Google பேச்சு சேவை; பிரவுசர்: Chrome). இதற்கு இணையம் தேவை. ஆப் ஒலியைச் சேமிப்பதில்லை; "சேமி" தட்டிய பிறகு, அல்லது தானாகச் சேமிப்பு இயக்கத்தில் இருந்தால் தெளிவான வாக்கியத்தின் 3 நொடி அட்டை முடிந்ததும், அந்தப் பதிவு மட்டுமே சேமிக்கப்படும் (ரத்து / செயல்தவிர் மூலம் நிறுத்தலாம்).',
};

export function speechError(code: string): Error {
  return new Error(`SPEECH_ERROR:${code}`);
}

/** Call a user callback without letting it break the recogniser plumbing. */
export function safeCall(cb: ((text: string) => void) | undefined, text: string): void {
  if (!cb) return;
  try {
    cb(text);
  } catch (e) {
    console.error('[speech] onPartial failed', e);
  }
}
