/** First run: language -> shop name (+ UPI) -> PIN (recommended, can skip) -> done. No server needed. */
import { setLang, t } from '../../i18n';
import { app, refreshSettings } from '../app';
import { h } from '../components/dom';
import { toast } from '../components/overlay';
import { errorText } from '../errors';
import { askNewPin, closeGate, logo, setGateBack, showGate } from '../gate';

function steps(n: number): HTMLElement {
  return h('div', 'steps', [0, 1, 2, 3].map((i) => h('span', i === n ? 'on' : '')));
}

export function runOnboarding(): Promise<void> {
  return new Promise((resolve) => {
    const stepLang = (): void => {
      const pick = async (lang: 'ta' | 'en'): Promise<void> => {
        await app.repo.saveSettings({ lang });
        setLang(lang);
        stepShop();
      };
      showGate(
        'onb',
        steps(0),
        h('div', 'gate-head', logo(), h('h1', { text: 'கடன் கணக்கு' }), h('p', { text: 'Kadan Kanakku' })),
        h('p', { style: { textAlign: 'center', marginBottom: '18px' }, text: 'மொழியைத் தேர்ந்தெடுக்கவும் · Choose a language' }),
        h('button', { class: 'btn btn-on-brand lang-btn', attrs: { type: 'button', lang: 'ta', 'data-testid': 'onb-ta' }, text: 'தமிழ்', on: { click: () => void pick('ta') } }),
        h('button', { class: 'btn btn-outline-light lang-btn', attrs: { type: 'button', lang: 'en', 'data-testid': 'onb-en' }, text: 'English', on: { click: () => void pick('en') } }),
      );
      setGateBack(() => false);
    };

    const stepShop = (): void => {
      const s = app.settings;
      const name = h('input', { class: 'input', attrs: { type: 'text', placeholder: t('onb.shopNamePh'), maxlength: 100, autocomplete: 'off', 'data-testid': 'onb-shop' } });
      const upi = h('input', { class: 'input', attrs: { type: 'text', placeholder: t('onb.upiPh'), maxlength: 100, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'data-testid': 'onb-upi' } });
      name.value = s?.shop_name ?? '';
      upi.value = s?.upi_id ?? '';
      const next = h('button', { class: 'btn btn-on-brand btn-big btn-block', attrs: { type: 'button', 'data-testid': 'onb-next' }, text: t('common.next') });
      const sync = (): void => {
        next.disabled = !name.value.trim();
      };
      name.addEventListener('input', sync);
      next.addEventListener('click', () => {
        void (async () => {
          try {
            await app.repo.saveSettings({ shop_name: name.value, upi_id: upi.value.trim() || null });
            await refreshSettings();
            stepPin();
          } catch (e) {
            toast(errorText(e), { error: true });
          }
        })();
      });
      showGate(
        'onb',
        steps(1),
        h('div', 'gate-head', h('h2', { text: t('onb.shopTitle') })),
        h(
          'div',
          'card',
          h('label', 'field', h('span', { class: 'field-label', text: t('onb.shopName') }), name),
          h('label', 'field', h('span', { class: 'field-label', text: `${t('onb.upi')} · ${t('common.optional')}` }), upi, h('p', { class: 'input-help', text: t('onb.upiHelp') })),
        ),
        h('div', 'gate-spacer'),
        next,
      );
      setGateBack(() => {
        stepLang();
        return true;
      });
      sync();
      setTimeout(() => name.focus(), 50);
    };

    const stepPin = (): void => {
      void askNewPin({ help: t('onb.pinHelp'), skipLabel: t('onb.pinSkip') }).then(async (pin) => {
        if (pin) {
          try {
            await app.repo.setPin(pin);
            toast(t('pin.set'));
          } catch (e) {
            toast(errorText(e), { error: true });
          }
        }
        stepDone();
      });
    };

    const stepDone = (): void => {
      showGate(
        'onb',
        steps(3),
        h('div', 'gate-head', logo(), h('h1', { text: t('onb.doneTitle') })),
        h('p', { style: { textAlign: 'center' }, text: t('onb.doneHelp') }),
        h('div', 'gate-spacer'),
        h('button', {
          class: 'btn btn-on-brand btn-big btn-block',
          attrs: { type: 'button', 'data-testid': 'onb-start' },
          text: t('onb.start'),
          on: {
            click: () => {
              void (async () => {
                await app.repo.setMeta('onboarded', new Date().toISOString());
                await refreshSettings();
                closeGate();
                resolve();
              })();
            },
          },
        }),
      );
      setGateBack(() => false);
    };

    stepLang();
  });
}
