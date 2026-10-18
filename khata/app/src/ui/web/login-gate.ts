/**
 * The web app's login gate: user id + password (owner only; staff get the bilingual refusal), the optional Google
 * button, the "shared computer" choice (in-memory database, 12-hour session) and a language toggle. Resolves once a
 * session exists. `signIn` is supplied by boot.ts because a shared-computer login first swaps the database.
 */
import type { ConfigResponse } from '../../../../shared/protocol';
import { getLang, setLang, t } from '../../i18n';
import type { LoginProgress } from '../../sync/types';
import { app } from '../app';
import { h } from '../components/dom';
import { toast } from '../components/overlay';
import { errorText } from '../errors';
import { closeGate, logo, setGateBack, showGate } from '../gate';
import { signInForm } from '../screens/login';
import { renderGoogleButton } from './google';

export interface LoginGateOptions {
  config: ConfigResponse | null;
  /** Performs the login with the chosen mode (shared -> memory database). */
  signIn: (how: { kind: 'password'; username: string; password: string } | { kind: 'google'; idToken: string }, shared: boolean, onProgress: (p: LoginProgress) => void) => Promise<void>;
  /** A single-use nonce for Google (null when Google sign-in is off or the nonce could not be fetched). */
  nonce: () => Promise<string | null>;
  /** Shown above the form once (e.g. "your session ended"). */
  notice?: string | null;
}

export function loginGate(opts: LoginGateOptions): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      closeGate();
      resolve();
    };
    const paint = (notice: string | null): void => {
      const shared = h('input', { attrs: { type: 'checkbox', 'data-testid': 'web-shared' } });
      const form = signInForm({
        testidPrefix: 'web',
        buttonClass: 'btn btn-primary btn-big btn-block',
        run: (username, password, onProgress) => opts.signIn({ kind: 'password', username, password }, shared.checked, onProgress),
        onDone: finish,
        extra: h(
          'div',
          null,
          h('label', 'check', shared, t('web.shared')),
          h('p', { class: 'input-help', style: { marginBottom: '12px' }, text: t('web.sharedHelp') }),
        ),
      });
      const googleHost = h('div', { class: 'web-google hidden', attrs: { 'data-testid': 'web-google' } });
      const or = h('p', { class: 'web-or hidden', text: t('web.or') });
      const langBtn = (lang: 'ta' | 'en', label: string): HTMLElement =>
        h('button', {
          class: getLang() === lang ? 'on' : '',
          attrs: { type: 'button', lang, 'data-testid': `web-lang-${lang}` },
          text: label,
          on: {
            click: () => {
              if (getLang() === lang) return;
              setLang(lang);
              try {
                void app.repo?.saveSettings({ lang });
              } catch {
                /* no repo yet */
              }
              paint(null);
            },
          },
        });
      showGate(
        'web-login',
        h(
          'div',
          'web-login-card',
          h('div', 'gate-head', logo(), h('h1', { text: 'கடன் கணக்கு' }), h('p', { text: 'Kadan Kanakku' })),
          h(
            'div',
            'card',
            h('h2', { style: { fontSize: '20px', marginBottom: '4px' }, text: t('web.loginTitle') }),
            h('p', { class: 'input-help', style: { marginBottom: '12px' }, text: t('web.loginHelp') }),
            notice ? h('div', { class: 'inline-warn', style: { marginBottom: '12px' }, attrs: { 'data-testid': 'web-notice' }, text: notice }) : null,
            form,
            or,
            googleHost,
          ),
          h('div', 'web-login-lang', langBtn('ta', 'தமிழ்'), langBtn('en', 'English')),
        ),
      );
      setGateBack(() => true);
      setTimeout(() => form.querySelector<HTMLInputElement>('input')?.focus(), 50);
      const clientId = opts.config?.google_client_id;
      if (clientId) {
        void (async () => {
          const nonce = await opts.nonce();
          if (!nonce) return;
          try {
            await renderGoogleButton(googleHost, {
              clientId,
              nonce,
              locale: getLang(),
              onCredential: (idToken) => {
                void opts
                  .signIn({ kind: 'google', idToken }, shared.checked, () => undefined)
                  .then(finish, (e) => toast(errorText(e), { error: true }));
              },
            });
            googleHost.classList.remove('hidden');
            or.classList.remove('hidden');
          } catch (e) {
            console.warn('[web] Google sign-in button unavailable', e);
          }
        })();
      }
    };
    paint(opts.notice ?? null);
  });
}
