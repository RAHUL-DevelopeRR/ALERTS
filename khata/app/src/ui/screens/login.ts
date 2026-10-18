/**
 * Shared account widgets (Android Settings and the web app): password field with show/hide, the user id + password
 * sign-in form, the step-up dialog (owner's password or a printed recovery code), the new-password dialog and the
 * sign-out flow. Passwords live only in the input elements and the in-flight call; nothing here stores one.
 */
import '../../styles/accounts.css';
import { PASSWORD_MIN_LENGTH } from '../../sync/password';
import { SyncError, type LoginProgress, type StepUpAnswer } from '../../sync/types';
import { t, tl } from '../../i18n';
import { app, refreshSettings } from '../app';
import { button, clear, h, type Child } from '../components/dom';
import { dialog, toast } from '../components/overlay';
import { errorText } from '../errors';
import { when } from '../format';

export interface PasswordField {
  wrap: HTMLElement;
  input: HTMLInputElement;
}

/** A password input with a Show/Hide toggle. */
export function passwordField(opts: { label: string; testid: string; autocomplete: 'current-password' | 'new-password'; placeholder?: string }): PasswordField {
  const input = h('input', {
    class: 'input',
    attrs: { type: 'password', autocomplete: opts.autocomplete, autocapitalize: 'none', spellcheck: 'false', placeholder: opts.placeholder ?? '', 'data-testid': opts.testid },
  });
  const toggle = h('button', { class: 'link pw-toggle', attrs: { type: 'button', 'data-testid': `${opts.testid}-toggle` }, text: t('auth.show') });
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? t('auth.hide') : t('auth.show');
    input.focus();
  });
  const wrap = h(
    'label',
    'field',
    h('span', { class: 'field-label pw-label' }, h('span', { text: opts.label }), toggle),
    input,
  );
  return { wrap, input };
}

export function progressLabel(p: LoginProgress): string {
  return p === 'prelogin' ? t('auth.stepPrelogin') : p === 'deriving' ? t('auth.stepDerive') : t('auth.stepLogin');
}

export function usernameField(testid: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = h('input', {
    class: 'input',
    attrs: { type: 'text', inputmode: 'email', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 32, placeholder: t('auth.usernamePh'), 'data-testid': testid },
  });
  return { wrap: h('label', 'field', h('span', { class: 'field-label', text: t('auth.username') }), input), input };
}

/**
 * User id + password form. `run` performs the sign-in (the caller decides server URL, device name, shared flag);
 * the form shows progress on the button and errors inline. Resolves through `onDone`.
 */
export function signInForm(opts: {
  run: (username: string, password: string, onProgress: (p: LoginProgress) => void) => Promise<void>;
  onDone: () => void;
  extra?: Child;
  testidPrefix?: string;
  buttonClass?: string;
}): HTMLElement {
  const pre = opts.testidPrefix ?? 'login';
  const user = usernameField(`${pre}-user`);
  const pw = passwordField({ label: t('auth.password'), testid: `${pre}-pw`, autocomplete: 'current-password' });
  const err = h('div', { class: 'inline-warn hidden', attrs: { role: 'alert', 'data-testid': `${pre}-error` } });
  const go = button(t('auth.signInBtn'), () => void submit(), opts.buttonClass ?? 'btn btn-primary btn-block', { 'data-testid': `${pre}-submit` });
  let busy = false;
  const submit = async (): Promise<void> => {
    if (busy) return;
    const username = user.input.value.trim();
    const password = pw.input.value;
    if (!username || !password) {
      err.textContent = t('serr.invalid_login');
      err.classList.remove('hidden');
      return;
    }
    busy = true;
    err.classList.add('hidden');
    go.disabled = true;
    user.input.disabled = true;
    pw.input.disabled = true;
    try {
      await opts.run(username, password, (p) => {
        go.textContent = progressLabel(p);
      });
      pw.input.value = '';
      opts.onDone();
    } catch (e) {
      // Staff on the web: the refusal is shown in both languages (the person may not have picked one yet).
      err.textContent = e instanceof SyncError && e.code === 'web_owner_only'
        ? `${tl('ta', 'serr.web_owner_only')}\n${tl('en', 'serr.web_owner_only')}`
        : errorText(e);
      err.classList.remove('hidden');
      if (e instanceof SyncError && e.code === 'invalid_login') pw.input.value = '';
    } finally {
      busy = false;
      go.disabled = false;
      go.textContent = t('auth.signInBtn');
      user.input.disabled = false;
      pw.input.disabled = false;
    }
  };
  const form = h('form', { class: 'login-form', attrs: { autocomplete: 'on', 'data-testid': `${pre}-form` } }, user.wrap, pw.wrap, opts.extra ?? null, go, err);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submit();
  });
  return form;
}

// ------------------------------------------------------------------ step-up

/**
 * The step-up provider for owner-power calls: asks for the owner's password or a printed recovery code.
 * Installed once at boot with app.sync.setStepUpProvider(stepUpDialog).
 */
export async function stepUpDialog(req: { can: Array<'password' | 'recovery'>; retry: boolean }): Promise<StepUpAnswer | null> {
  const canPw = req.can.includes('password');
  let mode: 'password' | 'recovery' = canPw ? 'password' : 'recovery';
  const pw = passwordField({ label: t('auth.password'), testid: 'stepup-pw', autocomplete: 'current-password' });
  const code = h('input', { class: 'input', attrs: { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX-XXXX', 'data-testid': 'stepup-code' } });
  const codeWrap = h('label', 'field', h('span', { class: 'field-label', text: t('auth.recoveryCode') }), code);
  const seg = h('div', { class: 'seg', attrs: { 'data-testid': 'stepup-mode' } });
  const paint = (): void => {
    clear(seg);
    seg.append(
      h('button', { class: mode === 'password' ? 'on' : '', attrs: { type: 'button', disabled: !canPw }, text: t('auth.usePassword'), on: { click: () => { mode = 'password'; paint(); } } }),
      h('button', { class: mode === 'recovery' ? 'on' : '', attrs: { type: 'button' }, text: t('auth.useRecovery'), on: { click: () => { mode = 'recovery'; paint(); } } }),
    );
    pw.wrap.classList.toggle('hidden', mode !== 'password');
    codeWrap.classList.toggle('hidden', mode !== 'recovery');
    seg.dispatchEvent(new Event('input', { bubbles: true }));
  };
  paint();
  const valid = (): boolean => (mode === 'password' ? pw.input.value.length > 0 : code.value.replace(/[\s-]/g, '').length === 16);
  const ok = await dialog<boolean>({
    title: t('auth.stepupTitle'),
    body: h(
      'div',
      null,
      h('p', { class: req.retry ? 'inline-warn' : 'pre', text: req.retry ? t('auth.stepupRetry') : t('auth.stepupHelp') }),
      seg,
      pw.wrap,
      codeWrap,
    ),
    buttons: [
      { label: t('common.cancel'), value: false },
      { label: t('auth.confirm'), value: true, kind: 'primary', enable: valid },
    ],
    dismissValue: false,
  });
  if (!ok) return null;
  return mode === 'password' ? { kind: 'password', password: pw.input.value } : { kind: 'recovery', code: code.value };
}

// ------------------------------------------------------------------ new password

/** Asks for a new password twice (min length, must match). Resolves the password or null. `current` adds a current-password field. */
export async function askNewPassword(opts: { title: string; current?: boolean; message?: string }): Promise<{ password: string; current: string } | null> {
  const cur = opts.current ? passwordField({ label: t('auth.currentPw'), testid: 'pw-current', autocomplete: 'current-password' }) : null;
  const a = passwordField({ label: t('auth.newPassword'), testid: 'pw-new', autocomplete: 'new-password' });
  const b = passwordField({ label: t('auth.newPassword2'), testid: 'pw-new2', autocomplete: 'new-password' });
  const warn = h('p', { class: 'inline-warn hidden', text: t('auth.pwMismatch') });
  const valid = (): boolean => {
    const long = a.input.value.length >= PASSWORD_MIN_LENGTH;
    const same = a.input.value === b.input.value;
    warn.classList.toggle('hidden', !(long && b.input.value.length >= a.input.value.length && !same));
    return long && same && (!cur || cur.input.value.length > 0);
  };
  const ok = await dialog<boolean>({
    title: opts.title,
    body: h('div', null, opts.message ? h('p', { class: 'pre', text: opts.message }) : null, cur?.wrap ?? null, a.wrap, b.wrap, warn),
    buttons: [
      { label: t('common.cancel'), value: false },
      { label: t('common.save'), value: true, kind: 'primary', enable: valid },
    ],
    dismissValue: false,
  });
  return ok ? { password: a.input.value, current: cur?.input.value ?? '' } : null;
}

// ------------------------------------------------------------------ sign out

/** Asks keep/remove, signs out (offering "sign out anyway" when the server is unreachable). True when signed out. */
export async function signOutFlow(opts: { webWipe?: () => Promise<void> } = {}): Promise<boolean> {
  const choice = await dialog<'keep' | 'remove' | null>({
    title: t('auth.signOutTitle'),
    buttons: [
      { label: t('auth.signOutKeep'), value: 'keep', kind: 'primary' },
      { label: t('auth.signOutRemove'), value: 'remove', kind: 'danger' },
      { label: t('common.cancel'), value: null },
    ],
    dismissValue: null,
    vertical: true,
  });
  if (!choice) return false;
  const removeData = choice === 'remove';
  try {
    await app.sync.logout({ removeData });
  } catch (e) {
    if (!(e instanceof SyncError) || e.code !== 'network') {
      toast(errorText(e), { error: true });
      return false;
    }
    const anyway = await dialog<boolean>({
      body: h('p', { class: 'pre', text: t('auth.signOutOffline') }),
      buttons: [{ label: t('common.cancel'), value: false }, { label: t('auth.signOutAnyway'), value: true, kind: 'danger' }],
      dismissValue: false,
    });
    if (!anyway) return false;
    try {
      await app.sync.logout({ removeData, force: true });
    } catch (e2) {
      toast(errorText(e2), { error: true });
      return false;
    }
  }
  if (removeData && opts.webWipe) await opts.webWipe();
  await refreshSettings();
  toast(t('auth.signedOut'));
  return true;
}

/** "Session ends 12 Nov 2026" or '' when unknown. */
export function sessionEndsText(expiresAt: string | null): string {
  if (!expiresAt) return '';
  if (!Number.isFinite(Date.parse(expiresAt))) return '';
  return t('auth.sessionEnds', { when: when(expiresAt) });
}
