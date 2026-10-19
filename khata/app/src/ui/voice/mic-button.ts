/**
 * Mic buttons: the round one beside a search box, and the top-bar icon on the customer page.
 * Both work by Pointer Events (press.ts): hold-to-talk (press, speak, release to finish) when Settings → Voice
 * says so (default), otherwise a tap starts listening as before. A keyboard activation counts as a tap.
 */
import './voice.css';
import { t } from '../../i18n';
import { app } from '../app';
import { h } from '../components/dom';
import { micIcon } from './icons';
import { releaseVoice, startVoice, voiceTapped, type VoiceStartOptions } from './listen';
import { bindPress } from './press';
import { voicePrefs } from './prefs';

function bindMic(btn: HTMLButtonElement, opts: VoiceStartOptions): HTMLButtonElement {
  bindPress(btn, {
    holdMode: () => voicePrefs().hold,
    onDown: () => {
      void app.platform.hapticTap();
      void startVoice(opts, { held: voicePrefs().hold });
    },
    onUp: (kind) => {
      if (kind === 'hold') releaseVoice();
      else voiceTapped();
    },
  });
  return btn;
}

/** Round brand-green mic for the search row. Null when voice is switched off in Settings. */
export function micButton(opts: VoiceStartOptions, testid = 'mic'): HTMLButtonElement | null {
  if (!voicePrefs().on) return null;
  return bindMic(
    h('button', { class: 'mic-btn', attrs: { type: 'button', 'aria-label': t('voice.mic'), title: t('voice.mic'), 'data-testid': testid } }, micIcon()),
    opts,
  );
}

/** Top-bar mic (same look as the other header icon buttons). Null when voice is off. */
export function micHeaderButton(opts: VoiceStartOptions, testid = 'mic'): HTMLButtonElement | null {
  if (!voicePrefs().on) return null;
  return bindMic(
    h('button', { class: 'icon-btn mic-hold', attrs: { type: 'button', 'aria-label': t('voice.mic'), title: t('voice.mic'), 'data-testid': testid } }, micIcon()),
    opts,
  );
}
