/** On-screen numeric keypad (amounts and PIN). The system keyboard is never used for numbers. */
import { t } from '../../i18n';
import { h, icon } from './dom';

/** Keys: digits, 'back', 'clear' (long-press back), '.' (decimal) or 'ok' (PIN pads). */
export function keypad(onKey: (key: string) => void, opts: { decimal?: boolean; ok?: boolean }): HTMLElement {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', opts.decimal ? '.' : opts.ok ? 'ok' : '', '0', 'back'];
  const pad = h('div', { class: 'keypad', attrs: { role: 'group' } });
  for (const k of keys) {
    if (k === '') {
      pad.appendChild(h('span', 'key blank'));
      continue;
    }
    const label = k === 'back' ? icon('backspace', 'ic-lg') : k === 'ok' ? icon('check', 'ic-lg') : k;
    const b = h(
      'button',
      {
        class: 'key',
        attrs: { type: 'button', 'aria-label': k === 'back' ? 'backspace' : k === 'ok' ? t('common.ok') : k, 'data-key': k },
        on: {
          click: (e) => {
            e.preventDefault();
            onKey(k);
          },
        },
      },
      label,
    );
    if (k === 'back') {
      // Long-press backspace clears everything.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cancel = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      b.addEventListener('pointerdown', () => {
        cancel();
        timer = setTimeout(() => onKey('clear'), 600);
      });
      b.addEventListener('pointerup', cancel);
      b.addEventListener('pointerleave', cancel);
      b.setAttribute('title', t('common.back'));
    }
    pad.appendChild(b);
  }
  return pad;
}
