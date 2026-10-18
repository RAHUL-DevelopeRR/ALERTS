/**
 * The web app's login gate: user id + password (owner only; staff get the bilingual refusal), the optional Google
 * button, the "shared computer" choice (in-memory database, 12-hour session) and a language toggle. Resolves once a
 * session exists. `signIn` is supplied by boot.ts because a shared-computer login first swaps the database.
 */
import { NONCE_TTL_MIN, type ConfigResponse } from '../../../../shared/protocol';
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
    let nonceTimer: ReturnType<typeof setInterval> | null = null;
    const stopNonceTimer = (): void => {
      if (nonceTimer) clearInterval(nonceTimer);
      nonceTimer = null;
    };
    const paint = (notice: string | null): void => {
      stopNonceTimer();
      const shared = h('input', { attrs: { type: 'checkbox', 'data-testid': 'web-shared' } });
      // What happens to this computer depends on the box: say so for the state it is in (default = a copy stays).
      const sharedHelp = h('p', { class: 'input-help', style: { marginBottom: '12px' }, attrs: { 'data-testid': 'web-shared-help' }, text: t('web.sharedHelpOff') });
      shared.addEventListener('change', () => {
        sharedHelp.textContent = shared.checked ? t('web.sharedHelpOn') : t('web.sharedHelpOff');
      });
      const form = signInForm({
        testidPrefix: 'web',
        buttonClass: 'btn btn-primary btn-big btn-block',
        run: (username, password, onProgress) => opts.signIn({ kind: 'password', username, password }, shared.checked, onProgress),
        onDone: () => {
          stopNonceTimer();
          finish();
        },
        extra: h('div', null, h('label', 'check', shared, t('web.shared')), sharedHelp),
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
        /**
         * The nonce is single-use on the server and is consumed even by a refused sign-in (not_linked,
         * web_owner_only), and it expires after NONCE_TTL_MIN: so the button is (re)mounted with a FRESH nonce after
         * every failed attempt and again before the current nonce can expire, instead of once per paint.
         */
        let mounting: Promise<void> | null = null;
        const mountGoogle = async (): Promise<void> => {
          if (done) return;
          const nonce = await opts.nonce();
          if (!nonce || done) return;
          try {
            while (googleHost.firstChild) googleHost.removeChild(googleHost.firstChild);
            await renderGoogleButton(googleHost, {
              clientId,
              nonce,
              locale: getLang(),
              onCredential: (idToken) => {
                void opts.signIn({ kind: 'google', idToken }, shared.checked, () => undefined).then(
                  () => {
                    stopNonceTimer();
                    finish();
                  },
                  (e) => {
                    toast(errorText(e), { error: true });
                    remount();
                  },
                );
              },
            });
            googleHost.classList.remove('hidden');
            or.classList.remove('hidden');
          } catch (e) {
            console.warn('[web] Google sign-in button unavailable', e);
          }
        };
        const remount = (): void => {
          if (mounting) return;
          mounting = mountGoogle().finally(() => {
            mounting = null;
          });
        };
        remount();
        nonceTimer = setInterval(remount, Math.max(1, NONCE_TTL_MIN - 2) * 60_000);
      }
    };
    paint(opts.notice ?? null);
  });
}
