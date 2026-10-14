/**
 * Search box with an always-visible clear (×) button while it holds text. The WebView's own type=search clear
 * button only shows while the field is focused, which costs two extra taps per customer at a busy counter.
 */
import { t } from '../../i18n';
import { h, icon } from './dom';

export interface SearchField {
  el: HTMLElement;
  input: HTMLInputElement;
}

export function searchField(opts: { value: string; testid: string; onInput: (q: string) => void; onEnter?: () => void }): SearchField {
  const input = h('input', {
    class: 'input',
    attrs: {
      type: 'search', placeholder: t('home.search'), autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
      enterkeyhint: 'search', 'data-testid': opts.testid,
    },
  });
  input.value = opts.value;
  const clearBtn = h(
    'button',
    {
      class: 'search-clear',
      attrs: { type: 'button', 'aria-label': t('home.searchClear'), title: t('home.searchClear'), 'data-testid': `${opts.testid}-clear` },
      on: {
        click: () => {
          input.value = '';
          sync();
          opts.onInput('');
          input.focus();
        },
      },
    },
    icon('close'),
  );
  const sync = (): void => {
    clearBtn.classList.toggle('hidden', !input.value);
  };
  input.addEventListener('input', () => {
    sync();
    opts.onInput(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') opts.onEnter?.();
  });
  sync();
  return { el: h('div', 'search-wrap', icon('search'), input, clearBtn), input };
}
