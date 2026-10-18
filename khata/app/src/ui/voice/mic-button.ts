/** Mic buttons: the round one beside a search box, and the top-bar icon on the customer page. */
import './voice.css';
import { t } from '../../i18n';
import { h } from '../components/dom';
import { micIcon } from './icons';
import { startVoice, type VoiceStartOptions } from './listen';
import { voicePrefs } from './prefs';

/** Round brand-green mic for the search row. Null when voice is switched off in Settings. */
export function micButton(opts: VoiceStartOptions, testid = 'mic'): HTMLButtonElement | null {
  if (!voicePrefs().on) return null;
  return h(
    'button',
    { class: 'mic-btn', attrs: { type: 'button', 'aria-label': t('voice.mic'), title: t('voice.mic'), 'data-testid': testid }, on: { click: () => void startVoice(opts) } },
    micIcon(),
  );
}

/** Top-bar mic (same look as the other header icon buttons). Null when voice is off. */
export function micHeaderButton(opts: VoiceStartOptions, testid = 'mic'): HTMLButtonElement | null {
  if (!voicePrefs().on) return null;
  return h(
    'button',
    { class: 'icon-btn', attrs: { type: 'button', 'aria-label': t('voice.mic'), title: t('voice.mic'), 'data-testid': testid }, on: { click: () => void startVoice(opts) } },
    micIcon(),
  );
}
