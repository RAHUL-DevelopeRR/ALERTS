/**
 * The shop server an APK can be built for, so nobody at the counter types an address: the release build passes
 * SHOP_SERVER_URL (tools/build-release-apk.sh), which Vite exposes as import.meta.env.VITE_SHOP_SERVER_URL. Empty in
 * a generic build: sign-in and Settings then ask for the address once.
 */
import { normalizeServerUrl } from '../sync/api';
import { t } from '../i18n';
import { button, h } from './components/dom';

function builtIn(): string {
  const raw = String(import.meta.env.VITE_SHOP_SERVER_URL ?? '').trim();
  if (!raw) return '';
  try {
    return normalizeServerUrl(raw);
  } catch {
    return '';
  }
}

/** Normalised https URL of the built-in shop server, or '' when this build has none. */
export const BUILT_IN_SERVER: string = builtIn();

/** "kadan-kanakku-api.example.workers.dev" for a URL (what the sign-in screen shows instead of the address). */
export function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The server address of a sign-in form. When this APK has the shop's server built in, nobody sees an address: the
 * field is replaced by one line, "Shop server: <host> · Change" (Change, for whoever installs the phones, opens the
 * field). A generic build shows the field. `testid` names the input; the line and the link get `-line` / `-change`.
 */
export function serverField(testid: string, value: string = BUILT_IN_SERVER): { input: HTMLInputElement; el: HTMLElement } {
  const input = h('input', {
    class: 'input',
    attrs: { type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: t('set.serverUrlPh'), 'data-testid': testid },
  });
  input.value = value;
  const field = h('label', 'field', h('span', { class: 'field-label', text: t('set.serverUrl') }), input);
  if (!BUILT_IN_SERVER || value !== BUILT_IN_SERVER) return { input, el: field };
  field.classList.add('hidden');
  const line: HTMLElement = h(
    'p',
    { class: 'input-help onb-server-line', attrs: { 'data-testid': `${testid}-line` } },
    t('onb.serverLine', { host: serverHost(BUILT_IN_SERVER) }),
    ' ',
    button(t('onb.serverChange'), () => {
      line.classList.add('hidden');
      field.classList.remove('hidden');
      input.focus();
    }, 'link', { 'data-testid': `${testid}-change` }),
  );
  return { input, el: h('div', null, line, field) };
}
