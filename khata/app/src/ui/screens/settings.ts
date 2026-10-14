/** Settings: shop, language, security, safety, backup, shop server, needs attention, privacy, about. */
import { formatINR } from '../../core/ledger';
import { selfTest } from '../../data/index';
import type { Settings } from '../../data/types';
import type { Role } from '../../data/types';
import { setLang, t } from '../../i18n';
import { afterWrite, app, refreshSettings } from '../app';
import { restoreFromFile, saveBackupCopy } from '../backup';
import { add, button, clear, h, type Child } from '../components/dom';
import { alertDialog, confirmDialog, dialog, toast } from '../components/overlay';
import { shell } from '../components/shell';
import { pillContent } from '../components/sync-pill';
import { errorText, reasonText } from '../errors';
import { when, today } from '../format';
import { askNewPin } from '../gate';
import * as router from '../router';
import type { Screen } from '../router';
import { APP_VERSION } from '../version';

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

function securitySection(s: Settings): HTMLElement {
  const setPin = async (): Promise<void> => {
    const pin = await askNewPin();
    if (!pin) return;
    try {
      await app.repo.setPin(pin);
      toast(t('pin.set'));
    } catch (e) {
      toast(errorText(e), { error: true });
    }
    void router.rerender();
  };
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

function backupSection(s: Settings): HTMLElement {
  const fileIn = h('input', { class: 'hidden', attrs: { type: 'file', accept: 'application/json,.json', 'data-testid': 'restore-file' } });
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
      fileIn,
    ),
  );
}

// ------------------------------------------------------------------ shop server

function connectForm(s: Settings): HTMLElement {
  let mode: 'code' | 'setup' = 'code';
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
  const seg = h('div', 'seg');
  const paintSeg = (): void => {
    clear(seg);
    seg.append(
      h('button', { class: mode === 'code' ? 'on' : '', attrs: { type: 'button' }, text: t('set.pairWithCode'), on: { click: () => { mode = 'code'; paintSeg(); } } }),
      h('button', { class: mode === 'setup' ? 'on' : '', attrs: { type: 'button' }, text: t('set.firstSetup'), on: { click: () => { mode = 'setup'; paintSeg(); } } }),
    );
    codeField.classList.toggle('hidden', mode !== 'code');
    keyField.classList.toggle('hidden', mode !== 'setup');
    shopField.classList.toggle('hidden', mode !== 'setup');
  };
  paintSeg();
  const go = button(t('set.pairBtn'), () => {
    err.classList.add('hidden');
    void (async () => {
      go.disabled = true;
      go.textContent = t('common.working');
      try {
        const dn = devName.value.trim() || 'Phone';
        if (mode === 'code') await app.sync.pair(url.value.trim(), code.value.trim(), dn);
        else await app.sync.setupAndPair(url.value.trim(), key.value, shopName.value.trim(), dn);
        await refreshSettings();
        toast(t('set.paired'));
        void router.rerender();
      } catch (e) {
        err.textContent = errorText(e);
        err.classList.remove('hidden');
      } finally {
        go.disabled = false;
        go.textContent = t('set.pairBtn');
      }
    })();
  }, 'btn btn-primary btn-block', { 'data-testid': 'srv-connect' });
  return h(
    'div',
    null,
    seg,
    h('label', 'field', h('span', { class: 'field-label', text: t('set.serverUrl') }), url),
    codeField,
    keyField,
    shopField,
    h('label', 'field', h('span', { class: 'field-label', text: t('set.deviceName') }), devName),
    go,
    err,
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
  if (!s.paired) {
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
  const syncNow = button(t('set.syncNow'), () => void busy(syncNow, async () => {
    await app.sync.syncNow();
    void router.rerender();
  }), 'btn btn-primary btn-block', { 'data-testid': 'sync-now' });
  const status = block(
    h('p', { style: { fontWeight: '700' }, text: `${pillContent(st).text}` }),
    h('p', { class: 'input-help', text: `${s.role === 'owner' ? t('set.role.owner') : t('set.role.staff')} · ${s.device_name ?? ''}` }),
    h('p', { class: 'input-help', style: { marginBottom: '10px' }, text: t('set.lastSync', { when: when(st.last_sync_at ?? s.last_sync_at) }) }),
    st.error ? h('div', { class: 'inline-warn', style: { marginBottom: '10px' }, text: errorText({ code: st.error }) }) : null,
    syncNow,
  );
  const ownerBlocks: Child[] = [];
  if (owner) {
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
    ownerBlocks,
    h('div', { class: 'list', style: { marginTop: '12px' } }, block(reupload, disconnect)),
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
  add(
    body,
    shopSection(s),
    langSection(s),
    securitySection(s),
    safetySection(s),
    backupSection(s),
    server,
    attention,
    section(t('set.privacy'), block(h('p', { class: 'input-help', style: { fontSize: '15px' }, text: t('set.privacyBody') }))),
    about,
  );
  if (route.params.section === 'sync') {
    delete route.params.section;
    setTimeout(() => document.getElementById('sec-sync')?.scrollIntoView({ block: 'start' }), 0);
  }
};
