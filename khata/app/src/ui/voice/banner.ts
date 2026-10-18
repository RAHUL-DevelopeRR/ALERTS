/**
 * "Heard: ..." banner on the keypad for a voice prefill: the words the amount came from in large type beside the
 * rupees ("ஐநூறு → ₹500", finding 8), the balance before → after (updates while the amount or direction changes),
 * other amounts the recogniser offered as chips, and a clear "Debit or Credit?" ask when the direction was unclear.
 * When a chip or the keypad changes the amount, the heard figure is struck through and the chosen one shown beside
 * it, so the banner never disagrees with the keypad (the keypad value is what Save uses).
 */
import { formatINR } from '../../core/ledger';
import { t } from '../../i18n';
import { clear, h } from '../components/dom';
import { signedBal } from '../screens/customer';
import { micIcon } from './icons';
import type { VoicePrefill } from './prefill';

type Kind = 'GIVE' | 'RECEIVE';

export interface VoiceBanner {
  el: HTMLElement;
  /** Re-render the amount line, the balance line and the chip highlight for the keypad's current state. */
  update(paise: number | null, kind: Kind | null): void;
}

export function voiceBanner(v: VoicePrefill, o: { balance: number; onAmount: (paise: number) => void }): VoiceBanner {
  const heard = h('span', { class: 'voice-heard' }, t('voice.heardLabel'), ' ', h('b', { attrs: { 'data-testid': 'voice-heard' }, text: `“${v.heard}”` }));
  const top = h('div', 'voice-banner-top', micIcon('ic'), heard, v.queue ? h('span', { class: 'voice-queue', attrs: { 'data-testid': 'voice-queue' }, text: t('voice.queue', { i: v.queue.index, n: v.queue.total }) }) : null);

  const src = h('div', { class: 'voice-amount-src', attrs: { 'data-testid': 'voice-amount-src' } });
  /** The spoken words when they differ from the figure ("ஐநூறு", "five hundred"), else null. */
  const spoken = ((): string | null => {
    if (v.amount_paise === null || !v.amount_text) return null;
    const plain = v.amount_text.replace(/[,\s]/g, '');
    return plain === String(v.amount_paise / 100) || plain === formatINR(v.amount_paise).replace(/[₹,]/g, '') ? null : v.amount_text;
  })();
  const paintSrc = (current: number | null): void => {
    clear(src);
    if (v.amount_paise === null) {
      // Nothing heard: the typed figure takes the line once there is one.
      if (current === null) src.textContent = t('voice.noAmount');
      else src.append(h('span', { class: 'num', text: formatINR(current) }));
      return;
    }
    const rupees = formatINR(v.amount_paise);
    if (current === v.amount_paise) {
      if (spoken) src.append(h('span', { text: spoken }), h('span', { class: 'arrow', text: '→' }));
      src.append(h('span', { class: 'num', text: rupees }));
      return;
    }
    // Changed on the keypad or by a chip: heard figure struck through, the chosen one in its place.
    src.append(h('s', { class: 'was num', attrs: { 'data-testid': 'voice-amount-was' }, text: spoken ? `${spoken} (${rupees})` : rupees }), h('span', { class: 'arrow', text: '→' }), h('span', { class: 'num', text: current === null ? '—' : formatINR(current) }));
  };

  const bal = h('div', { class: 'voice-bal', attrs: { 'data-testid': 'voice-balance-line' } });
  const ask = h('div', { class: 'voice-ask hidden', attrs: { 'data-testid': 'voice-ask' }, text: t('voice.chooseKindHelp') });
  const alts = v.amount_paise !== null && v.amount_alternatives.length ? [v.amount_paise, ...v.amount_alternatives] : [];
  // The chips already say "look again"; the generic check line is for prefills without them.
  const check = v.confidence === 'high' || alts.length ? null : h('div', { class: 'voice-alt-label', text: t('voice.check') });

  const chips = h('div', { class: 'chips', attrs: { 'data-testid': 'voice-alts' } });
  const altLabel = h('span', { class: 'voice-alt-label', text: t('voice.didYouSay') });
  const paintChips = (current: number | null): void => {
    clear(chips);
    for (const a of alts) {
      chips.appendChild(
        h('button', { class: `chip${current === a ? ' on' : ''}`, attrs: { type: 'button', 'data-testid': 'voice-alt', 'data-paise': String(a) }, text: formatINR(a), on: { click: () => o.onAmount(a) } }),
      );
    }
  };

  const el = h('div', { class: 'voice-banner', attrs: { 'data-testid': 'voice-banner' } }, top, h('div', 'voice-banner-row', src, bal), alts.length ? h('div', 'voice-alts-row', altLabel, chips) : null, check, ask);

  return {
    el,
    update(paise, kind) {
      paintSrc(paise);
      const before = signedBal(o.balance);
      clear(bal);
      if (paise !== null && kind) {
        const after = o.balance + (kind === 'GIVE' ? paise : -paise);
        bal.append(before, ' → ', h('b', { text: signedBal(after) }));
      } else bal.append(before, ' → ', h('b', { text: '?' }));
      ask.classList.toggle('hidden', kind !== null);
      paintChips(paise);
    },
  };
}
