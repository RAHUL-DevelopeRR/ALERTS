/** Settings: shop, language, security, safety, backup, shop server, needs attention, privacy, about. */
import { formatINR } from '../../core/ledger';
import { selfTest } from '../../data/index';
import type { Settings } from '../../data/types';
import type { Role } from '../../data/types';
import type { AuthEvent, UserInfo } from '../../../../shared/protocol';
import { hasKey, setLang, t } from '../../i18n';
import { afterWrite, app, refreshSettings } from '../app';
import { endWebSession } from '../web/session';
import { isWebApp } from '../web/flag';
import { askNewPassword, passwordField, sessionEndsText, signOutFlow, usernameField } from './login';
import { listLocalCopies, restoreFromFile, restoreLocalCopy, saveBackupCopy } from '../backup';
import { add, button, clear, h, type Child } from '../components/dom';
import { actionSheet, alertDialog, confirmDialog, dialog, toast } from '../components/overlay';
import { shell } from '../components/shell';
import { pillContent } from '../components/sync-pill';
import { errorText, reasonText } from '../errors';
import { when, today } from '../format';
import { askNewPin } from '../gate';
import * as router from '../router';
import type { Screen } from '../router';
import { APP_VERSION } from '../version';
import { voiceSettingsSection } from '../voice/settings-section';

const LOCK_CHOICES = [2, 10, 30];
const CONFIRM_CHOICES = [200_000, 500_000, 1_000_000, 2_500_000];

function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', null, h('h2', { class: 'section-title', text: title }), h('div', 'list', children));
}

function block(...children: Child[]): HTMLElement {
  return h('div', 'set-block', children);
}

async function busy<T>(btn: HTMLButtonElement, fn: () => Promise<T>): Promise<T | undefined> {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('common.working');
  try {
    return await fn();
  } catch (e) {
    toast(errorText(e), { error: true });
    return undefined;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function shopSection(s: Settings): HTMLElement {
  const name = h('input', { class: 'input', attrs: { type: 'text', maxlength: 100, autocomplete: 'off', 'data-testid': 'set-shop' } });
  const upi = h('input', { class: 'input', attrs: { type: 'text', maxlength: 100, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: t('onb.upiPh'), 'data-testid': 'set-upi' } });
  name.value = s.shop_name;
  upi.value = s.upi_id ?? '';
  const editable = !s.paired || s.role === 'owner';
  name.disabled = !editable;
  upi.disabled = !editable;
  const save = button(t('common.save'), () => {
    void busy(save, async () => {
      const patch = { shop_name: name.value.trim(), upi_id: upi.value.trim() || null };
      if (!patch.shop_name) throw new Error('BAD_NAME');
      if (s.paired && s.role === 'owner') await app.sync.updateShop({ name: patch.shop_name, upi_id: patch.upi_id });
      await app.repo.saveSettings(patch);
      await refreshSettings();
      toast(t('set.saved'));
    });
  }, 'btn btn-primary btn-block', { 'data-testid': 'set-shop-save' });
  return section(
    t('set.shop'),
    block(
      h('label', 'field', h('span', { class: 'field-label', text: t('set.shopName') }), name),
      h('label', 'field', h('span', { class: 'field-label', text: t('set.upi') }), upi, h('p', { class: 'input-help', text: t('onb.upiHelp') })),
      editable ? save : h('p', { class: 'input-help', text: t('set.owner') }),
    ),
  );
}

function langSection(s: Settings): HTMLElement {
  const pick = async (lang: 'ta' | 'en'): Promise<void> => {
    if (lang === s.lang) return;
    await app.repo.saveSettings({ lang });
    setLang(lang);
    await refreshSettings();
    if (s.paired && s.role === 'owner') {
      // The shop language is shared by all phones; the next pull would otherwise switch it back.
      app.sync.updateShop({ lang }).catch((e) => toast(errorText(e), { error: true }));
    }
    void router.rerender();
  };
  return section(
    t('set.language'),
    block(
      h(
        'div',
        'seg',
        h('button', { class: s.lang === 'ta' ? 'on' : '', attrs: { type: 'button', lang: 'ta', 'data-testid': 'set-lang-ta' }, text: 'தமிழ்', on: { click: () => void pick('ta') } }),
        h('button', { class: s.lang === 'en' ? 'on' : '', attrs: { type: 'button', lang: 'en', 'data-testid': 'set-lang-en' }, text: 'English', on: { click: () => void pick('en') } }),
      ),
    ),
  );
}

async function setPin(): Promise<void> {
  const pin = await askNewPin();
  if (!pin) return;
  try {
    await app.repo.setPin(pin);
    toast(t('pin.set'));
  } catch (e) {
    toast(errorText(e), { error: true });
  }
  void router.rerender();
}

function securitySection(s: Settings): HTMLElement {
  const removePin = async (): Promise<void> => {
    if (!(await confirmDialog({ message: t('set.removePinConfirm'), ok: t('set.removePin'), danger: true }))) return;
    await app.repo.setPin(null);
    toast(t('pin.removed'));
    void router.rerender();
  };
  const lockChips = h(
    'div',
    'chips',
    LOCK_CHOICES.map((m) =>
      h('button', {
        class: `chip${s.lock_timeout_min === m ? ' on' : ''}`,
        attrs: { type: 'button' },
        text: t('set.minutes', { n: m }),
        on: { click: () => void app.repo.saveSettings({ lock_timeout_min: m }).then(() => router.rerender()) } },
      ),
    ),
  );
  return section(
    t('set.security'),
    block(
      h('p', { style: { fontWeight: '700', marginBottom: '10px' }, text: s.pin_set ? t('set.pinOn') : t('set.pinOff') }),
      button(s.pin_set ? t('set.changePin') : t('set.setPin'), () => void setPin(), 'btn btn-primary btn-block', { 'data-testid': 'set-pin' }),
      s.pin_set ? button(t('set.removePin'), () => void removePin(), 'btn btn-block', { 'data-testid': 'remove-pin' }) : null,
      s.pin_set
        ? h('div', { style: { marginTop: '14px' } }, h('span', { class: 'field-label', text: t('set.lockAfter') }), lockChips)
        : null,
    ),
  );
}

function safetySection(s: Settings): HTMLElement {
  const choices = CONFIRM_CHOICES.includes(s.confirm_above_paise) ? CONFIRM_CHOICES : [...CONFIRM_CHOICES, s.confirm_above_paise].sort((a, b) => a - b);
  return section(
    t('set.safety'),
    block(
      h('span', { class: 'field-label', text: t('set.confirmAbove') }),
      h(
        'div',
        'chips',
        choices.map((p) =>
          h('button', {
            class: `chip${s.confirm_above_paise === p ? ' on' : ''}`,
            attrs: { type: 'button' },
            text: formatINR(p),
            on: { click: () => void app.repo.saveSettings({ confirm_above_paise: p }).then(() => router.rerender()) },
          }),
        ),
      ),
      h('p', { class: 'input-help', text: t('set.confirmAboveHelp') }),
    ),
  );
}

async function pickLocalCopy(): Promise<void> {
  let copies: Awaited<ReturnType<typeof listLocalCopies>>;
  try {
    copies = await listLocalCopies();
  } catch (e) {
    toast(errorText(e), { error: true });
    return;
  }
  if (!copies.length) {
    toast(t('set.dailyNone'));
    return;
  }
  actionSheet({
    title: t('set.dailyTitle'),
    actions: copies.map((c) => ({
      label: c.label,
      run: async () => {
        if (await restoreLocalCopy(c.name)) void router.rerender();
      },
    })),
  });
}

function backupSection(s: Settings): HTMLElement {
  // No `accept`: Capacitor maps it to EXTRA_MIME_TYPES and the system picker then greys out backups that WhatsApp,
  // Telegram or a file manager report as application/octet-stream or text/plain. validateBackup() rejects
  // anything that is not a backup.
  const fileIn = h('input', { class: 'hidden', attrs: { type: 'file', 'data-testid': 'restore-file' } });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (!f) return;
    void restoreFromFile(f).then((ok) => {
      if (ok) void router.rerender();
    });
  });
  const save = button(t('set.saveBackup'), () => void busy(save, async () => {
    await saveBackupCopy();
    void router.rerender();
  }), 'btn btn-primary btn-block', { 'data-testid': 'save-backup' });
  return section(
    t('set.backup'),
    block(
      h('p', { class: 'input-help', style: { marginBottom: '10px' }, text: t('set.saveBackupHelp') }),
      save,
      h('p', { class: 'input-help', attrs: { 'data-testid': 'last-backup' }, text: t('set.lastBackup', { when: when(s.last_backup_at) }) }),
      button(t('set.restore'), () => fileIn.click(), 'btn btn-block', { 'data-testid': 'restore' }),
      button(t('set.restoreDaily'), () => void pickLocalCopy(), 'btn btn-block', { 'data-testid': 'restore-daily' }),
      fileIn,
    ),
  );
}

// ------------------------------------------------------------------ shop server

function connectForm(s: Settings): HTMLElement {
  let mode: 'code' | 'login' | 'setup' = 'code';
  const url = h('input', { class: 'input', attrs: { type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: t('set.serverUrlPh'), 'data-testid': 'srv-url' } });
  const devName = h('input', { class: 'input', attrs: { type: 'text', maxlength: 60, autocomplete: 'off' } });
  const code = h('input', { class: 'input', attrs: { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'data-testid': 'srv-code' } });
  const key = h('input', { class: 'input', attrs: { type: 'password', autocomplete: 'off' } });
  const shopName = h('input', { class: 'input', attrs: { type: 'text', maxlength: 100 } });
  url.value = s.server_url ?? '';
  shopName.value = s.shop_name;
  devName.value = s.device_name ?? '';
  if (!devName.value) void app.platform.deviceModel().then((m) => { if (!devName.value) devName.value = m; }).catch(() => undefined);
  const err = h('div', 'inline-warn hidden');
  const codeField = h('label', 'field', h('span', { class: 'field-label', text: t('set.pairCode') }), code);
  const keyField = h('label', 'field hidden', h('span', { class: 'field-label', text: t('set.setupKey') }), key);
  const shopField = h('label', 'field hidden', h('span', { class: 'field-label', text: t('set.shopName') }), shopName);
  // Sign in with user id & password (v2): the device is named with the same field; the password never leaves the form.
  const user = usernameField('srv-user');
  const pw = passwordField({ label: t('auth.password'), testid: 'srv-pw', autocomplete: 'current-password' });
  user.wrap.classList.add('hidden');
  pw.wrap.classList.add('hidden');
  const seg = h('div', { class: 'seg', attrs: { 'data-testid': 'srv-mode' } });
  const label = (): string => (mode === 'login' ? t('auth.signInBtn') : t('set.pairBtn'));
  const paintSeg = (): void => {
    clear(seg);
    seg.append(
      h('button', { class: mode === 'code' ? 'on' : '', attrs: { type: 'button', 'data-testid': 'srv-mode-code' }, text: t('set.pairWithCode'), on: { click: () => { mode = 'code'; paintSeg(); } } }),
      h('button', { class: mode === 'login' ? 'on' : '', attrs: { type: 'button', 'data-testid': 'srv-mode-login' }, text: t('auth.signInShort'), on: { click: () => { mode = 'login'; paintSeg(); } } }),
      h('button', { class: mode === 'setup' ? 'on' : '', attrs: { type: 'button', 'data-testid': 'srv-mode-setup' }, text: t('set.firstSetup'), on: { click: () => { mode = 'setup'; paintSeg(); } } }),
    );
    codeField.classList.toggle('hidden', mode !== 'code');
    keyField.classList.toggle('hidden', mode !== 'setup');
    shopField.classList.toggle('hidden', mode !== 'setup');
    user.wrap.classList.toggle('hidden', mode !== 'login');
    pw.wrap.classList.toggle('hidden', mode !== 'login');
    go.textContent = label();
  };
  const go = button(t('set.pairBtn'), () => {
    err.classList.add('hidden');
    void (async () => {
      go.disabled = true;
      go.textContent = t('common.working');
      try {
        const dn = devName.value.trim() || 'Phone';
        if (mode === 'code') await app.sync.pair(url.value.trim(), code.value.trim(), dn);
        else if (mode === 'login') {
          await app.sync.login(url.value.trim(), user.input.value, pw.input.value, dn, { onProgress: (p) => { go.textContent = p === 'deriving' ? t('auth.stepDerive') : t('auth.stepLogin'); } });
          pw.input.value = '';
        } else await app.sync.setupAndPair(url.value.trim(), key.value, shopName.value.trim(), dn);
        await refreshSettings();
        toast(mode === 'login' ? t('auth.signedIn') : t('set.paired'));
        void router.rerender();
      } catch (e) {
        err.textContent = errorText(e);
        err.classList.remove('hidden');
      } finally {
        go.disabled = false;
        go.textContent = label();
      }
    })();
  }, 'btn btn-primary btn-block', { 'data-testid': 'srv-connect' });
  paintSeg();
  return h(
    'div',
    null,
    seg,
    h('label', 'field', h('span', { class: 'field-label', text: t('set.serverUrl') }), url),
    codeField,
    user.wrap,
    pw.wrap,
    keyField,
    shopField,
    h('label', 'field', h('span', { class: 'field-label', text: t('set.deviceName') }), devName),
    go,
    err,
  );
}

// ------------------------------------------------------------------ accounts (v2)

function roleText(role: Role): string {
  return role === 'owner' ? t('set.roleOwner') : t('set.roleStaff');
}

/** Who is signed in on this device, with Sign out / Change my password. */
function accountBlock(s: Settings): HTMLElement {
  const acc = app.sync.getAccount();
  const web = isWebApp();
  const signOut = button(t('auth.signOut'), () => {
    void (async () => {
      if (web) {
        if (!(await confirmDialog({ title: t('auth.signOutTitle'), message: t('web.signOutWipe'), ok: t('auth.signOut'), danger: true }))) return;
        await endWebSession({ logout: true });
        return;
      }
      if (await signOutFlow()) void router.rerender();
    })();
  }, 'btn btn-block', { 'data-testid': 'sign-out' });
  const changePw = button(t('auth.changeMyPw'), () => {
    void (async () => {
      const r = await askNewPassword({ title: t('auth.changeMyPw'), current: true });
      if (!r) return;
      try {
        await app.sync.changeOwnPassword(r.current, r.password);
        toast(t('auth.pwChanged'));
      } catch (e) {
        toast(errorText(e), { error: true });
      }
    })();
  }, 'btn btn-block', { 'data-testid': 'change-pw' });
  if (!acc) {
    const createMine = s.role === 'owner' && !web
      ? button(t('auth.createMine'), () => void createLoginForMe(s), 'btn btn-primary btn-block', { 'data-testid': 'create-mine' })
      : null;
    return block(
      h('p', { class: 'input-help', attrs: { 'data-testid': 'account-line' }, text: t('auth.noLogin') }),
      createMine ? h('p', { class: 'input-help', style: { margin: '6px 2px 10px' }, text: t('auth.createMineHelp') }) : null,
      createMine,
    );
  }
  const ends = sessionEndsText(acc.expires_at);
  return block(
    h('p', { style: { fontWeight: '700' }, attrs: { 'data-testid': 'account-line' }, text: t('auth.signedInAs', { name: acc.user.display_name, user: acc.user.username }) }),
    h('p', { class: 'input-help', style: { marginBottom: '10px' }, text: `${roleText(acc.user.role)}${ends ? ` · ${ends}` : ''}${acc.shared ? ` · ${t('web.sharedMode')}` : ''}` }),
    changePw,
    signOut,
  );
}

/**
 * A paired owner phone without a login creates its own (link_me): user id + password. The server cannot ask for a
 * step-up while the shop has no users (bootstrap), so this phone asks for an app PIN first: without one, whoever
 * holds an unlocked phone could turn it into a web-capable owner login (a guard on this phone only).
 */
async function createLoginForMe(s: Settings): Promise<void> {
  if (!s.pin_set) {
    await alertDialog(t('auth.createMine'), t('auth.createMinePin'));
    await setPin();
    return;
  }
  const user = usernameField('mine-user');
  const name = h('input', { class: 'input', attrs: { type: 'text', maxlength: 80, autocomplete: 'name', 'data-testid': 'mine-name' } });
  const a = passwordField({ label: t('auth.newPassword'), testid: 'mine-pw', autocomplete: 'new-password' });
  const b = passwordField({ label: t('auth.newPassword2'), testid: 'mine-pw2', autocomplete: 'new-password' });
  const ok = await dialog<boolean>({
    title: t('auth.createMine'),
    body: h('div', null, user.wrap, h('label', 'field', h('span', { class: 'field-label', text: t('auth.displayName') }), name), a.wrap, b.wrap),
    buttons: [
      { label: t('common.cancel'), value: false },
      { label: t('common.save'), value: true, kind: 'primary', enable: () => user.input.value.trim().length >= 3 && a.input.value.length >= 8 && a.input.value === b.input.value },
    ],
    dismissValue: false,
  });
  if (!ok) return;
  try {
    const u = await app.sync.createUser({ username: user.input.value, display_name: name.value.trim() || user.input.value.trim(), role: 'owner', password: a.input.value, link_me: true });
    toast(t('auth.userCreated', { user: u.username }));
    void router.rerender();
  } catch (e) {
    toast(errorText(e), { error: true });
  }
}

async function addUserDialog(): Promise<void> {
  const user = usernameField('new-user');
  const name = h('input', { class: 'input', attrs: { type: 'text', maxlength: 80, autocomplete: 'off', 'data-testid': 'new-name' } });
  let role: Role = 'staff';
  const seg = h('div', { class: 'seg', attrs: { 'data-testid': 'new-role' } });
  const paint = (): void => {
    clear(seg);
    seg.append(
      h('button', { class: role === 'staff' ? 'on' : '', attrs: { type: 'button' }, text: t('set.roleStaff'), on: { click: () => { role = 'staff'; paint(); } } }),
      h('button', { class: role === 'owner' ? 'on' : '', attrs: { type: 'button' }, text: t('set.roleOwner'), on: { click: () => { role = 'owner'; paint(); } } }),
    );
  };
  paint();
  const a = passwordField({ label: t('auth.newPassword'), testid: 'new-pw', autocomplete: 'new-password' });
  const b = passwordField({ label: t('auth.newPassword2'), testid: 'new-pw2', autocomplete: 'new-password' });
  const gmail = h('input', { class: 'input', attrs: { type: 'email', inputmode: 'email', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'name@gmail.com', 'data-testid': 'new-gmail' } });
  const valid = (): boolean => {
    const pw = a.input.value;
    const g = gmail.value.trim();
    const pwOk = pw.length === 0 ? g.length > 0 : pw.length >= 8 && pw === b.input.value;
    return user.input.value.trim().length >= 3 && pwOk;
  };
  const ok = await dialog<boolean>({
    title: t('auth.addUser'),
    body: h(
      'div',
      null,
      user.wrap,
      h('label', 'field', h('span', { class: 'field-label', text: t('auth.displayName') }), name),
      h('div', 'field', h('span', { class: 'field-label', text: t('auth.role') }), seg),
      a.wrap,
      b.wrap,
      h('label', 'field', h('span', { class: 'field-label', text: t('auth.gmail') }), gmail, h('p', { class: 'input-help', text: t('auth.gmailHelp') })),
    ),
    buttons: [
      { label: t('common.cancel'), value: false },
      { label: t('common.save'), value: true, kind: 'primary', enable: valid },
    ],
    dismissValue: false,
  });
  if (!ok) return;
  try {
    const u = await app.sync.createUser({
      username: user.input.value,
      display_name: name.value.trim() || user.input.value.trim(),
      role,
      password: a.input.value || null,
      google_email: gmail.value.trim() || null,
    });
    toast(t('auth.userCreated', { user: u.username }));
    void router.rerender();
  } catch (e) {
    toast(errorText(e), { error: true });
  }
}

function userRow(u: UserInfo, me: string | null, web: boolean, reload: () => void): HTMLElement {
  const bits: string[] = [roleText(u.role)];
  if (u.disabled_at) bits.push(t('auth.disabled'));
  if (!u.has_password) bits.push(t('auth.noPassword'));
  if (u.google_email) {
    if (u.google_linked) bits.push(t('auth.googleLinked'));
    else if (u.google_email_expires_at && Date.parse(u.google_email_expires_at) > Date.now()) bits.push(t('auth.googlePending', { when: when(u.google_email_expires_at) }));
    else bits.push(t('auth.googleExpired'));
  }
  const isMe = u.id === me;
  const actions: Child[] = [];
  if (!web && !isMe) {
    actions.push(
      button(t('auth.resetPw'), () => {
        void (async () => {
          const r = await askNewPassword({ title: t('auth.resetPwTitle', { user: u.username }) });
          if (!r) return;
          try {
            await app.sync.resetPassword(u.id, r.password);
            toast(t('auth.resetDone'));
          } catch (e) {
            toast(errorText(e), { error: true });
          }
        })();
      }, 'btn', { 'data-testid': `user-reset-${u.username}` }),
      button(u.disabled_at ? t('auth.enable') : t('auth.disable'), () => {
        void (async () => {
          if (!u.disabled_at && !(await confirmDialog({ message: t('auth.disableConfirm', { user: u.username }), ok: t('auth.disable'), danger: true }))) return;
          try {
            await app.sync.updateUser(u.id, { disabled: !u.disabled_at });
            toast(t('auth.userSaved'));
            reload();
          } catch (e) {
            toast(errorText(e), { error: true });
          }
        })();
      }, u.disabled_at ? 'btn' : 'btn btn-danger', { 'data-testid': `user-toggle-${u.username}` }),
    );
  }
  return h(
    'div',
    { class: 'set-row user-row', style: { paddingLeft: '0', paddingRight: '0' }, attrs: { 'data-testid': `user-${u.username}` } },
    h(
      'span',
      'grow',
      `${u.display_name} (${u.username})`,
      isMe ? h('span', { class: 'badge', text: t('auth.thisDevice') }) : null,
      h('span', { class: 'sub', text: bits.join(' · ') }),
    ),
    actions.length ? h('div', 'user-actions', actions) : null,
  );
}

/** Owner: the shop's logins (list from the server; add / reset / disable need step-up and are phone-only). */
function usersSection(): HTMLElement {
  const web = isWebApp();
  const box = h('div', { attrs: { 'data-testid': 'users-list' } }, h('p', { class: 'input-help', text: t('common.working') }));
  const load = async (): Promise<void> => {
    try {
      const users = await app.sync.listUsers();
      const me = app.sync.getAccount()?.user.id ?? null;
      clear(box);
      for (const u of users) box.appendChild(userRow(u, me, web, () => void load()));
    } catch (e) {
      clear(box);
      box.appendChild(h('p', { class: 'input-help', text: `${errorText(e)} ${t('common.needsInternet')}` }));
    }
  };
  void load();
  return h(
    'div',
    null,
    h('h2', { class: 'section-title', text: t('auth.users') }),
    h(
      'div',
      'list',
      block(
        h('p', { class: 'input-help', style: { marginBottom: '10px' }, text: web ? t('web.phoneOnly') : t('auth.usersHelp') }),
        box,
        web ? null : button(t('auth.addUser'), () => void addUserDialog(), 'btn btn-block', { 'data-testid': 'add-user' }),
      ),
    ),
  );
}

function eventLabel(e: AuthEvent): string {
  const k = `auth.ev.${e.action}`;
  return hasKey(k) ? t(k) : e.action;
}

/** Names for the ids an audit row carries (user ids -> user id shown to the owner, device ids -> device name). */
interface EventNames {
  users: Map<string, string>;
  devices: Map<string, string>;
}

/** Server codes in a row's detail are shown as the owner reads them elsewhere (serr.*), never raw. */
function codeText(code: string): string {
  const k = `serr.${code}`;
  return hasKey(k) ? t(k) : code;
}

function clientText(client: string): string {
  return client === 'web' ? t('auth.clientWeb') : client === 'android' ? t('auth.clientPhone') : client;
}

export function eventDetail(e: AuthEvent, names: EventNames = { users: new Map(), devices: new Map() }): string {
  const d = e.detail ?? {};
  const parts: string[] = [];
  const who = typeof d.username === 'string' ? d.username : e.actor_user_id ? names.users.get(e.actor_user_id) ?? null : null;
  if (who) parts.push(who);
  if (typeof d.client === 'string') parts.push(clientText(d.client));
  if (typeof d.why === 'string') parts.push(codeText(d.why));
  if (typeof d.how === 'string') parts.push(d.how);
  if (typeof d.role === 'string' && e.action === 'user.create') parts.push(roleText(d.role === 'owner' ? 'owner' : 'staff'));
  if (e.target_user_id && e.target_user_id !== e.actor_user_id) {
    const target = names.users.get(e.target_user_id);
    if (target && !parts.includes(target)) parts.push(target);
  }
  // Which device signed out / was removed / signed in: the row names it when the server still lists it.
  if (e.target_device_id) {
    const dev = names.devices.get(e.target_device_id);
    if (dev) parts.push(dev);
  }
  return parts.join(' · ');
}

/** Owner: the audit trail (GET /auth/events), newest first. */
function activitySection(): HTMLElement {
  const box = h('div', { attrs: { 'data-testid': 'activity-list' } }, h('p', { class: 'input-help', text: t('common.working') }));
  void (async () => {
    try {
      const [events, users, devices] = await Promise.all([
        app.sync.authEvents(),
        app.sync.listUsers().catch(() => [] as UserInfo[]),
        app.sync.listDevices().catch(() => []),
      ]);
      const names: EventNames = {
        users: new Map(users.map((u) => [u.id, u.username])),
        devices: new Map(devices.map((d) => [d.id, d.name])),
      };
      clear(box);
      if (!events.length) box.appendChild(h('p', { class: 'input-help', text: t('auth.activityNone') }));
      for (const e of events.slice(0, 50)) {
        box.appendChild(
          h(
            'div',
            { class: 'set-row', style: { paddingLeft: '0', paddingRight: '0' } },
            h('span', 'grow', eventLabel(e), h('span', { class: 'sub', text: [when(e.at), eventDetail(e, names)].filter(Boolean).join(' · ') })),
          ),
        );
      }
    } catch (e) {
      clear(box);
      box.appendChild(h('p', { class: 'input-help', text: `${errorText(e)} ${t('common.needsInternet')}` }));
    }
  })();
  return h(
    'div',
    null,
    h('h2', { class: 'section-title', text: t('auth.activity') }),
    h('div', 'list', block(h('p', { class: 'input-help', style: { marginBottom: '6px' }, text: t('auth.activityHelp') }), box)),
  );
}

async function devicesBlock(s: Settings): Promise<HTMLElement> {
  const box = h('div', null, h('p', { class: 'input-help', text: t('common.working') }));
  const load = async (): Promise<void> => {
    try {
      const devices = await app.sync.listDevices();
      clear(box);
      for (const d of devices.filter((x) => !x.revoked_at)) {
        const me = d.id === s.device_id;
        box.appendChild(
          h(
            'div',
            { class: 'set-row', style: { paddingLeft: '0', paddingRight: '0' } },
            h(
              'span',
              'grow',
              d.name,
              me ? h('span', { class: 'badge', text: t('common.thisPhone') }) : null,
              h('span', { class: 'sub', text: `${d.role === 'owner' ? t('set.roleOwner') : t('set.roleStaff')} · ${t('set.lastSeen', { when: when(d.last_seen_at) })}` }),
            ),
            me
              ? null
              : button(t('common.remove'), () => {
                  void (async () => {
                    const wipe = h('input', { attrs: { type: 'checkbox' } });
                    const ok = await dialog<boolean>({
                      title: t('set.removeDevice', { name: d.name }),
                      body: h('label', 'check', wipe, t('set.wipeToo')),
                      buttons: [{ label: t('common.cancel'), value: false }, { label: t('common.remove'), value: true, kind: 'danger' }],
                      dismissValue: false,
                    });
                    if (!ok) return;
                    try {
                      await app.sync.revokeDevice(d.id, wipe.checked);
                      toast(t('set.removed'));
                      void load();
                    } catch (e) {
                      toast(errorText(e), { error: true });
                    }
                  })();
                }, 'btn'),
          ),
        );
      }
    } catch (e) {
      clear(box);
      box.appendChild(h('p', { class: 'input-help', text: `${errorText(e)} ${t('common.needsInternet')}` }));
    }
  };
  void load();
  return box;
}

async function serverSection(s: Settings): Promise<HTMLElement> {
  const web = isWebApp();
  if (!s.paired) {
    if (web) return h('section', { attrs: { id: 'sec-sync' } });
    const formHost = h('div', null);
    const open = button(t('set.connect'), () => {
      open.remove();
      formHost.appendChild(connectForm(s));
    }, 'btn btn-block', { 'data-testid': 'srv-open' });
    return h(
      'section',
      { attrs: { id: 'sec-sync' } },
      h('h2', { class: 'section-title', text: t('set.sync') }),
      h('div', 'list', block(h('p', { class: 'input-help', style: { marginBottom: '10px' }, text: t('set.syncHelp') }), open, formHost)),
    );
  }
  const st = app.sync.status();
  const owner = s.role === 'owner';
  const account = app.sync.getAccount();
  const syncNow = button(t('set.syncNow'), () => void busy(syncNow, async () => {
    await app.sync.syncNow();
    void router.rerender();
  }), 'btn btn-primary btn-block', { 'data-testid': 'sync-now' });
  const status = block(
    h('p', { style: { fontWeight: '700' }, text: web ? t('web.onlineCopy') : `${pillContent(st).text}` }),
    web ? h('p', { class: 'input-help', text: t('web.onlineCopyHelp') }) : null,
    h('p', { class: 'input-help', text: `${s.role === 'owner' ? t('set.role.owner') : t('set.role.staff')} · ${s.device_name ?? ''}` }),
    h('p', { class: 'input-help', style: { marginBottom: '10px' }, text: t('set.lastSync', { when: when(st.last_sync_at ?? s.last_sync_at) }) }),
    st.error ? h('div', { class: 'inline-warn', style: { marginBottom: '10px' }, text: errorText({ code: st.error }) }) : null,
    syncNow,
  );
  const ownerBlocks: Child[] = [];
  if (owner) ownerBlocks.push(usersSection());
  if (owner && !web) {
    const addPhone = button(t('set.addPhone'), () => {
      void (async () => {
        const role = await dialog<Role | null>({
          title: t('set.role'),
          buttons: [
            { label: t('set.roleStaff'), value: 'staff', kind: 'primary' },
            { label: t('set.roleOwner'), value: 'owner' },
            { label: t('common.cancel'), value: null },
          ],
          dismissValue: null,
          vertical: true,
        });
        if (!role) return;
        try {
          const r = await app.sync.createPairCode(role);
          await alertDialog(
            t('set.pairCodeTitle'),
            h('div', null, h('div', { class: 'code-big', attrs: { 'data-testid': 'pair-code' }, text: r.code.replace(/^(\d{4})(\d{4})$/, '$1 $2') }), h('p', { text: t('set.pairCodeBody', { time: when(r.expires_at) }) })),
          );
        } catch (e) {
          toast(errorText(e), { error: true });
        }
      })();
    }, 'btn btn-block');
    const recovery = button(t('set.recoveryGen'), () => {
      void (async () => {
        if (!(await confirmDialog({ title: t('set.recovery'), message: t('set.recoveryHelp'), ok: t('set.recoveryGen') }))) return;
        try {
          const codes = await app.sync.createRecoveryCodes();
          const ok = await dialog<boolean>({
            title: t('set.recoveryTitle'),
            body: h('div', null, h('p', { text: t('set.recoveryBody') }), h('div', 'codes-list', codes.map((c) => h('div', { text: c })))),
            buttons: [{ label: t('common.copy'), value: true }, { label: t('common.done'), value: false, kind: 'primary' }],
            dismissValue: false,
          });
          if (ok) await app.platform.copyText(codes.join('\n')).then(() => toast(t('common.copied')));
        } catch (e) {
          toast(errorText(e), { error: true });
        }
      })();
    }, 'btn btn-block');
    const download = button(t('set.downloadServer'), () => void busy(download, async () => {
      const text = await app.sync.downloadServerExport();
      await app.platform.shareFile(`kadan-kanakku-server-${today(s.clock_offset_ms)}.json`, text, 'application/json', t('set.downloadServer'));
    }), 'btn btn-block');
    ownerBlocks.push(
      h('h2', { class: 'section-title', text: t('set.devices') }),
      h('div', 'list', block(await devicesBlock(s), addPhone)),
      h('h2', { class: 'section-title', text: t('set.recovery') }),
      h('div', 'list', block(h('p', { class: 'input-help', style: { marginBottom: '10px' }, text: t('set.recoveryHelp') }), recovery)),
      h('div', { class: 'list', style: { marginTop: '12px' } }, block(download)),
    );
  }
  if (owner) ownerBlocks.push(activitySection());
  const reupload = button(t('set.reupload'), () => {
    void (async () => {
      if (!(await confirmDialog({ message: t('set.reuploadConfirm'), ok: t('set.reupload') }))) return;
      try {
        const n = await app.repo.requeueEverything();
        toast(t('set.reuploadDone', { n }));
        await app.sync.syncNow();
        void router.rerender();
      } catch (e) {
        toast(errorText(e), { error: true });
      }
    })();
  }, 'btn btn-block');
  const disconnect = button(t('set.disconnect'), () => {
    void (async () => {
      if (!(await confirmDialog({ message: t('set.disconnectConfirm'), ok: t('set.disconnect'), danger: true }))) return;
      try {
        await app.sync.disconnect();
        await refreshSettings();
        void router.rerender();
      } catch (e) {
        toast(errorText(e), { error: true });
      }
    })();
  }, 'btn btn-block');
  return h(
    'section',
    { attrs: { id: 'sec-sync' } },
    h('h2', { class: 'section-title', text: t('set.sync') }),
    h('div', 'list', status),
    h('h2', { class: 'section-title', text: t('web.account') }),
    h('div', 'list', accountBlock(s)),
    ownerBlocks,
    // A signed-in device leaves with Sign out (above); Disconnect stays for v1 code-paired phones.
    h('div', { class: 'list', style: { marginTop: '12px' } }, block(reupload, account || web ? null : disconnect)),
  );
}

async function attentionSection(): Promise<HTMLElement | null> {
  const items = await app.repo.needsAttention();
  if (!items.length) return null;
  const rows = items.map((it) =>
    h(
      'div',
      'set-block',
      h('div', { style: { fontWeight: '700' }, text: it.summary }),
      h('div', { class: 'input-help', text: reasonText(it.reason) }),
      h(
        'div',
        { class: 'footer-row', style: { marginTop: '8px' } },
        button(t('common.open'), () => void router.go('customer', { id: it.customer_id }), 'btn'),
        button(t('set.discard'), () => void app.repo.resolveRejected(it.tbl, it.id, 'discard').then(() => router.rerender()), 'btn'),
        button(t('set.resend'), () => void app.repo.resolveRejected(it.tbl, it.id, 'resend').then(() => { afterWrite(); void router.rerender(); }), 'btn btn-primary'),
      ),
    ),
  );
  return section(t('set.attention'), rows);
}

async function aboutSection(): Promise<HTMLElement> {
  let engine = '';
  try {
    engine = await app.db.engine();
  } catch (e) {
    engine = String(e);
  }
  const out = h('pre', { class: 'selftest hidden', attrs: { 'data-testid': 'selftest' } });
  const run = button(t('set.selfTest'), () => void busy(run, async () => {
    const r = await selfTest(app.db);
    out.textContent = r.lines.join('\n');
    out.classList.remove('hidden');
  }), 'btn btn-block', { 'data-testid': 'run-selftest' });
  return section(
    t('set.about'),
    block(
      h('p', { style: { fontWeight: '700' }, text: `${t('app.name')} · ${t('set.version', { v: APP_VERSION })}` }),
      h('p', { class: 'input-help', style: { marginBottom: '10px' }, text: t('set.engine', { e: engine }) }),
      run,
      out,
    ),
  );
}

export const settingsScreen: Screen = async (root, route) => {
  const s = await refreshSettings();
  const { body } = shell(root, { title: t('set.title'), back: true });
  const [server, attention, about] = await Promise.all([serverSection(s), attentionSection(), aboutSection()]);
  const web = isWebApp();
  add(
    body,
    shopSection(s),
    langSection(s),
    web ? null : securitySection(s),
    safetySection(s),
    backupSection(s),
    server,
    attention,
    await voiceSettingsSection(), // Settings → Voice entry (src/ui/voice/settings-section.ts)
    section(t('set.privacy'), block(h('p', { class: 'input-help', style: { fontSize: '15px' }, text: web ? t('web.privacyBody') : t('set.privacyBody') }))),
    about,
  );
  if (route.params.section === 'sync') {
    delete route.params.section;
    setTimeout(() => document.getElementById('sec-sync')?.scrollIntoView({ block: 'start' }), 0);
  }
};
