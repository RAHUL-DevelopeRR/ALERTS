/**
 * Add / edit customer: name (required), mobile (optional, duplicate warning), note. "Save & add credit" first.
 * From quick entry (params.quick = '1'): saving goes straight to the keypad in quick mode, which returns to the
 * quick list, so the sitting (count, sticky date) carries on.
 * From voice entry (state.voice, an unknown name): saving opens the keypad prefilled with what was heard.
 */
import { cleanName, formatCode, formatPhone, normalizePhone, normName } from '../../core/ledger';
import type { Customer } from '../../data/types';
import { t } from '../../i18n';
import { afterWrite, app } from '../app';
import { button, clear, h } from '../components/dom';
import { dialog, toast } from '../components/overlay';
import { shell, showFooter } from '../components/shell';
import { errorText, errorCode } from '../errors';
import { quick } from '../quick-session';
import * as router from '../router';
import type { Screen } from '../router';
import { rowDetail } from './home';
import type { VoicePrefill } from '../voice/prefill';

export const customerEditScreen: Screen = async (root, route) => {
  const id = route.params.id;
  const existing = id ? await app.repo.getCustomer(id) : null;
  if (id && !existing) throw new Error('NOT_FOUND');
  const fromQuick = !existing && route.params.quick === '1' && quick.active;
  const voice = existing ? null : ((route.state as { voice?: VoicePrefill } | undefined)?.voice ?? null);
  /** Keypad route for the voice prefill (direction left unset when the parser could not tell). */
  const voiceEntry = (customerId: string): [Record<string, string>, { voice: VoicePrefill }] => {
    const params: Record<string, string> = { id: customerId };
    if (voice?.kind) params.kind = voice.kind;
    if (fromQuick) params.quick = '1';
    return [params, { voice: voice! }];
  };
  const { body, footer } = shell(root, { title: existing ? t('cust.edit') : t('cust.new'), back: true });

  const nameIn = h('input', { class: 'input', attrs: { type: 'text', placeholder: t('cust.namePh'), autocomplete: 'off', autocapitalize: 'words', maxlength: 100, enterkeyhint: 'next', 'data-testid': 'cust-name' } });
  const phoneIn = h('input', { class: 'input', attrs: { type: 'tel', inputmode: 'tel', placeholder: t('cust.phonePh'), autocomplete: 'off', maxlength: 20, enterkeyhint: 'next', 'data-testid': 'cust-phone' } });
  const noteIn = h('input', { class: 'input', attrs: { type: 'text', placeholder: t('cust.notePh'), autocomplete: 'off', maxlength: 200, enterkeyhint: 'done', 'data-testid': 'cust-note' } });
  nameIn.value = existing?.name ?? route.params.name ?? '';
  phoneIn.value = existing?.phone ? formatPhone(existing.phone) : '';
  noteIn.value = existing?.note ?? '';
  const nameErr = h('div', 'inline-warn hidden');
  /** Duplicate-number warning, managed by the debounced checkPhone(). */
  const phoneWarn = h('div', { class: 'inline-warn hidden', attrs: { 'data-testid': 'phone-warn' } });
  /** "Number not valid", set by save() only; checkPhone() never touches it (it used to wipe it 250 ms later). */
  const phoneErr = h('div', { class: 'inline-warn hidden', attrs: { 'data-testid': 'phone-err' } });

  let phoneTimer: ReturnType<typeof setTimeout> | null = null;
  const checkPhone = async (): Promise<void> => {
    let p: string | null = null;
    try {
      p = normalizePhone(phoneIn.value);
    } catch {
      p = null;
    }
    clear(phoneWarn);
    phoneWarn.classList.add('hidden');
    if (!p) return;
    const others = await app.repo.findByPhone(p, id);
    if (!others.length) return;
    const o = others[0];
    phoneWarn.append(
      t('cust.phoneTaken', { name: o.name, code: formatCode(o.code) }),
      button(t('cust.openThem'), () => void router.replace('customer', { id: o.id }), 'link'),
    );
    phoneWarn.classList.remove('hidden');
  };
  phoneIn.addEventListener('input', () => {
    phoneErr.classList.add('hidden');
    if (phoneTimer) clearTimeout(phoneTimer);
    phoneTimer = setTimeout(() => void checkPhone(), 250);
  });
  phoneIn.addEventListener('blur', () => {
    try {
      const p = normalizePhone(phoneIn.value);
      if (p) phoneIn.value = formatPhone(p);
    } catch {
      /* shown on save */
    }
  });
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') phoneIn.focus(); });
  phoneIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') noteIn.focus(); });
  noteIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') void app.platform.hideKeyboard(); });
  if (existing?.phone) void checkPhone();

  body.append(
    h('label', 'field', h('span', { class: 'field-label', text: t('cust.name') }), nameIn, nameErr),
    h('label', 'field', h('span', { class: 'field-label', text: `${t('cust.phone')} (${t('common.optional')})` }), phoneIn, phoneErr, phoneWarn),
    h('label', 'field', h('span', { class: 'field-label', text: `${t('cust.note')} (${t('common.optional')})` }), noteIn),
  );

  let saving = false;
  const showErr = (el: HTMLElement, msg: string): void => {
    el.textContent = msg;
    el.classList.remove('hidden');
  };

  const save = async (thenCredit: boolean): Promise<void> => {
    if (saving) return;
    nameErr.classList.add('hidden');
    let name: string;
    try {
      name = cleanName(nameIn.value);
    } catch {
      showErr(nameErr, t('err.BAD_NAME'));
      nameIn.focus();
      return;
    }
    if (phoneTimer) {
      clearTimeout(phoneTimer);
      phoneTimer = null;
    }
    let phone: string | null;
    try {
      phone = normalizePhone(phoneIn.value);
    } catch {
      showErr(phoneErr, t('err.BAD_PHONE'));
      phoneIn.focus();
      return;
    }
    phoneErr.classList.add('hidden');
    saving = true;
    for (const b of footer.querySelectorAll('button')) b.disabled = true;
    try {
      if (!existing || normName(existing.name) !== normName(name)) {
        const same = await app.repo.findBySameName(name, id);
        if (same.length) {
          const choice = await sameNameDialog(same);
          if (choice === null) return;
          if (choice !== 'new') {
            if (voice) await router.replace('entry', ...voiceEntry(choice));
            else if (fromQuick) await router.replace('entry', { id: choice, kind: 'GIVE', quick: '1' });
            else await router.replace('customer', { id: choice });
            return;
          }
        }
      }
      if (existing) {
        await app.repo.updateCustomer(existing.id, { name, phone, note: noteIn.value });
        afterWrite();
        toast(t('cust.saved'));
        router.back();
        return;
      }
      const c = await app.repo.createCustomer({ name, phone, note: noteIn.value });
      afterWrite();
      toast(t('cust.savedAs', { code: formatCode(c.code) }));
      if (voice) {
        if (!fromQuick) await router.replace('customer', { id: c.id });
        await (fromQuick ? router.replace('entry', ...voiceEntry(c.id)) : router.go('entry', ...voiceEntry(c.id)));
        return;
      }
      if (fromQuick) {
        // Back to the quick list on plain Save; straight to the quick keypad on "Save + credit".
        if (thenCredit) await router.replace('entry', { id: c.id, kind: 'GIVE', quick: '1' });
        else router.back({ force: true });
        return;
      }
      await router.replace('customer', { id: c.id });
      if (thenCredit) await router.go('entry', { id: c.id, kind: 'GIVE' });
    } catch (e) {
      const code = errorCode(e);
      if (code === 'BAD_NAME') showErr(nameErr, errorText(e));
      else toast(errorText(e), { error: true });
    } finally {
      saving = false;
      for (const b of footer.querySelectorAll('button')) b.disabled = false;
    }
  };

  if (existing) {
    showFooter(footer, button(t('common.save'), () => void save(false), 'btn btn-primary btn-big btn-block', { 'data-testid': 'cust-save' }));
  } else {
    showFooter(
      footer,
      h(
        'div',
        'footer-row',
        button(t('common.save'), () => void save(false), 'btn btn-big', { 'data-testid': 'cust-save' }),
        button(t('cust.saveAndCredit'), () => void save(true), 'btn btn-gave btn-big', { 'data-testid': 'cust-save-credit' }),
      ),
    );
  }
  if (!existing) setTimeout(() => (nameIn.value ? phoneIn : nameIn).focus(), 50);
};

/** "There is already a Murugan (C-0017, note). Open existing / Add new". Returns an id, 'new', or null (cancel). */
async function sameNameDialog(same: Customer[]): Promise<string | 'new' | null> {
  const first = same[0];
  // "C-0002 கணக்கைத் திற" with the note on its own line, so the verb never sits between the code and the note.
  const buttons = same.slice(0, 3).map((c) => ({ label: `${t('cust.openExisting', { code: formatCode(c.code) })}${c.note ? `\n${c.note}` : ''}`, value: c.id as string | null }));
  return dialog<string | null>({
    title: t('cust.sameNameTitle'),
    body: h('p', { text: t('cust.sameName', { name: first.name, detail: rowDetail(first).replace(' · ', ', ') }) }),
    buttons: [...buttons, { label: t('cust.addNew'), value: 'new', kind: 'primary' }, { label: t('common.cancel'), value: null }],
    dismissValue: null,
    vertical: true,
  });
}
