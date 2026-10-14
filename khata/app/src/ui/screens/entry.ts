/**
 * Gave / Got keypad (one screen, kind preselected, colour-coded). Custom keypad, never the system keyboard.
 * Correction mode (state.correct): prefilled with the original; on Save the original is reversed and the corrected
 * entry added in ONE transaction (repo.correctEntry), so fixing ₹1,500 → ₹150 is one edit + Save, and backing out
 * changes nothing. Backing out with a new amount typed asks first (a slipped thumb must not lose an entry).
 */
import { addDays, amountInWords, formatINR, formatTyping } from '../../core/ledger';
import type { EntryView, PayMode } from '../../data/types';
import { getLang, t } from '../../i18n';
import { afterWrite, app, refreshSettings } from '../app';
import { applyKey, paiseToTyped, typedPaise } from '../amount-input';
import { button, clear, h, icon } from '../components/dom';
import { keypad } from '../components/keypad';
import { actionSheet, dialog, toast } from '../components/overlay';
import { shell, showFooter } from '../components/shell';
import { errorText } from '../errors';
import { day, today } from '../format';
import { quick } from '../quick-session';
import * as router from '../router';
import type { Screen } from '../router';
import { signedBal } from './customer';
import { homeState } from './home';

type Kind = 'GIVE' | 'RECEIVE';

export const entryScreen: Screen = async (root, route) => {
  const s = await refreshSettings();
  const id = route.params.id;
  const [c, balance] = await Promise.all([app.repo.getCustomer(id), app.repo.balance(id)]);
  if (!c) throw new Error('NOT_FOUND');
  const correct = (route.state as { correct?: EntryView } | undefined)?.correct ?? null;
  const isQuick = route.params.quick === '1' && quick.active;
  const todayStr = today(s.clock_offset_ms);

  let kind: Kind = route.params.kind === 'RECEIVE' ? 'RECEIVE' : 'GIVE';
  let raw = correct ? paiseToTyped(correct.amount_paise) : '';
  let date = correct ? correct.biz_date : isQuick && quick.date ? quick.date : todayStr;
  let mode: PayMode = (correct?.mode as PayMode | null) ?? 'CASH';
  let saving = false;

  root.classList.add('entry-screen');
  const { header, body, footer } = shell(root, {
    title: correct ? t('entry.correctTitle') : kind === 'GIVE' ? t('entry.gaveTitle') : t('entry.gotTitle'),
    sub: c.name,
    back: true,
    tone: kind === 'GIVE' ? 'gave' : 'got',
  });
  const titleEl = header.querySelector('h1')!.firstChild as Text;

  const seg = h('div', 'seg');
  const amountVal = h('div', { class: 'amount-val', attrs: { 'data-testid': 'amount' } });
  const amountWords = h('div', { class: 'amount-words', attrs: { 'data-testid': 'amount-words' } });
  const amountBox = h('div', 'amount-box', amountVal, amountWords);
  const chips = h('div', 'chips');
  const noteIn = h('input', { class: 'input note-input', attrs: { type: 'text', maxlength: 200, autocomplete: 'off', enterkeyhint: 'done', 'data-testid': 'entry-note' } });
  noteIn.value = correct?.note ?? '';
  noteIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void app.platform.hideKeyboard();
  });
  const saveBtn = button('', () => void save(), 'btn btn-xl btn-block', { 'data-testid': 'entry-save' });

  const paint = (): void => {
    const p = typedPaise(raw);
    amountVal.textContent = `₹${raw ? formatTyping(raw) : '0'}`;
    amountVal.classList.toggle('placeholder', !raw);
    amountWords.textContent = p ? amountInWords(p, getLang()) : t('entry.zero');
    const tone = kind === 'GIVE' ? 'gave' : 'got';
    amountBox.className = `amount-box ${tone}`;
    header.className = `topbar ${tone}`;
    if (!correct) titleEl.textContent = kind === 'GIVE' ? t('entry.gaveTitle') : t('entry.gotTitle');
    noteIn.placeholder = kind === 'GIVE' ? t('entry.notePh') : t('entry.notePhGot');
    saveBtn.className = `btn btn-xl btn-block btn-${tone}`;
    saveBtn.textContent = isQuick ? t('entry.saveNext') : t('entry.save');
    saveBtn.disabled = saving || p === null;
    // kind toggle
    clear(seg);
    for (const k of ['GIVE', 'RECEIVE'] as Kind[]) {
      seg.appendChild(
        h('button', {
          class: kind === k ? (k === 'GIVE' ? 'on-gave' : 'on-got') : '',
          attrs: { type: 'button', 'aria-pressed': kind === k ? 'true' : 'false', 'data-testid': `kind-${k}` },
          text: k === 'GIVE' ? t('det.gave') : t('det.got'),
          on: { click: () => { kind = k; paint(); } },
        }),
      );
    }
    // chips: date, full balance, mode
    clear(chips);
    const dateLabel = date === todayStr ? t('common.today') : date === addDays(todayStr, -1) ? t('common.yesterday') : day(date, false);
    chips.appendChild(
      h('button', { class: `chip${date !== todayStr ? ' on' : ''}`, attrs: { type: 'button', 'data-testid': 'date-chip' }, on: { click: pickDate } }, icon('cal', 'ic-sm'), dateLabel),
    );
    if (kind === 'RECEIVE') {
      if (balance > 0) {
        chips.appendChild(
          h('button', {
            class: `chip${typedPaise(raw) === balance ? ' on-got' : ''}`,
            attrs: { type: 'button', 'data-testid': 'full-chip' },
            text: t('entry.full', { amount: formatINR(balance) }),
            on: { click: () => { raw = paiseToTyped(balance); paint(); } },
          }),
        );
      }
      const modes = h('div', 'seg seg-sm');
      chips.appendChild(modes);
      for (const m of ['CASH', 'UPI', 'OTHER'] as PayMode[]) {
        modes.appendChild(
          h('button', {
            class: mode === m ? 'on-got' : '',
            attrs: { type: 'button', 'aria-pressed': mode === m ? 'true' : 'false', 'data-testid': `mode-${m}` },
            text: t(`mode.${m}` as const),
            on: { click: () => { mode = m; paint(); } },
          }),
        );
      }
    }
  };

  const onKey = (k: string): void => {
    raw = applyKey(raw, k);
    paint();
  };

  const pickDate = (): void => {
    actionSheet({
      title: t('common.pickDate'),
      actions: [
        { label: t('common.today'), sub: day(todayStr, false), run: () => { date = todayStr; paint(); } },
        { label: t('common.yesterday'), sub: day(addDays(todayStr, -1), false), run: () => { date = addDays(todayStr, -1); paint(); } },
        {
          label: `${t('common.pickDate')}…`,
          run: async () => {
            const input = h('input', { class: 'input', attrs: { type: 'date', max: todayStr, value: date, 'data-testid': 'date-input' } });
            input.value = date;
            const ok = await dialog<boolean>({
              title: t('common.pickDate'),
              body: input,
              buttons: [
                { label: t('common.cancel'), value: false },
                { label: t('common.ok'), value: true, kind: 'primary', enable: () => !!input.value && input.value <= todayStr },
              ],
              dismissValue: false,
            });
            if (!ok) return;
            if (input.value > todayStr) {
              toast(t('entry.futureDate'), { error: true });
              return;
            }
            date = input.value;
            paint();
          },
        },
      ],
    });
  };

  const save = async (): Promise<void> => {
    const paise = typedPaise(raw);
    if (saving || paise === null) return;
    if (date > todayStr) {
      toast(t('entry.futureDate'), { error: true });
      return;
    }
    saving = true;
    paint();
    try {
      if (paise >= s.confirm_above_paise) {
        const ok = await dialog<boolean>({
          title: t('entry.bigConfirm', { amount: formatINR(paise) }),
          body: h('p', { class: 'muted', text: amountInWords(paise, getLang()) }),
          buttons: [
            { label: t('common.no'), value: false },
            { label: t('common.yes'), value: true, kind: kind === 'GIVE' ? 'gave' : 'got' },
          ],
          dismissValue: false,
        });
        if (!ok) return;
      }
      // Got more than the due: the rest becomes an advance. Typing 500 for 50 must not pass silently.
      const dueBefore = correct ? balance - correct.delta_paise : balance;
      if (kind === 'RECEIVE' && dueBefore > 0 && paise > dueBefore) {
        const ok = await dialog<boolean>({
          body: h('p', { text: t('entry.advanceConfirm', { due: formatINR(dueBefore), adv: formatINR(paise - dueBefore) }) }),
          buttons: [
            { label: t('common.no'), value: false },
            { label: t('common.yes'), value: true, kind: 'got' },
          ],
          dismissValue: false,
        });
        if (!ok) return;
      }
      if (!correct && (await app.repo.recentDuplicate(c.id, kind, paise))) {
        const ok = await dialog<boolean>({
          body: h('p', { text: t('entry.dupConfirm', { amount: formatINR(paise) }) }),
          buttons: [
            { label: t('common.cancel'), value: false },
            { label: t('entry.saveAgain'), value: true, kind: 'primary' },
          ],
          dismissValue: false,
        });
        if (!ok) return;
      }
      const input = {
        customer_id: c.id,
        kind,
        amount_paise: paise,
        biz_date: date,
        note: noteIn.value,
        mode: kind === 'RECEIVE' ? mode : null,
      };
      // A correction is one transaction: never a reversed original without its replacement.
      const res = correct ? await app.repo.correctEntry(correct.id, input) : await app.repo.addEntry(input);
      afterWrite();
      // The next customer at the counter starts from a clean home search.
      homeState.q = '';
      void app.platform.hapticTap();
      const bal = signedBal(res.balance_paise);
      if (isQuick) {
        quick.count++;
        quick.date = date;
        if (kind === 'GIVE') quick.gave += paise;
        else quick.got += paise;
      }
      router.back({ force: true });
      if (correct) {
        toast(t('entry.corrected', { bal }));
        return;
      }
      const base = kind === 'GIVE' ? t('entry.addedGave', { amount: formatINR(paise), bal }) : t('entry.addedGot', { amount: formatINR(paise), bal });
      // Quick entry returns to the list, not the customer: name the customer so the Undo is unambiguous.
      const msg = isQuick ? `${c.name}: ${base}` : base;
      toast(msg, {
        action: {
          label: t('common.undo'),
          run: () => {
            void (async () => {
              try {
                const u = await app.repo.reverseEntry(res.entry.id, null);
                afterWrite();
                if (isQuick) {
                  quick.count--;
                  if (kind === 'GIVE') quick.gave -= paise;
                  else quick.got -= paise;
                }
                toast(t('entry.undone', { bal: signedBal(u.balance_paise) }));
                void router.rerender();
              } catch (e) {
                toast(errorText(e), { error: true });
              }
            })();
          },
        },
      });
    } catch (e) {
      toast(errorText(e), { error: true });
    } finally {
      saving = false;
      if (root.isConnected) paint();
    }
  };

  const balLine = h(
    'div',
    'entry-cust',
    h('b', { text: c.name }),
    h('span', { class: 'num', text: t('entry.currentBal', { bal: signedBal(balance) }) }),
  );
  body.append(seg, balLine, amountBox, chips, noteIn, keypad(onKey, { decimal: true }));
  showFooter(footer, saveBtn);
  paint();

  // Hardware / desktop keyboard support (preview, e2e, Bluetooth keyboards) when the note field is not focused.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (document.activeElement === noteIn || document.querySelector('.scrim')) return;
    if (/^[0-9]$/.test(e.key) || e.key === '.') onKey(e.key);
    else if (e.key === 'Backspace') onKey('back');
    else if (e.key === 'Enter') void save();
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKeyDown);

  // Back with a NEW amount typed: ask before throwing it away. Correction mode backs out freely (nothing changes).
  let asking = false;
  const removeGuard = router.setLeaveGuard(() => {
    if (correct || saving || !raw) return false;
    if (!asking) {
      asking = true;
      void dialog<boolean>({
        title: t('entry.discardTitle'),
        body: h('p', { class: 'amount-confirm num', text: `₹${formatTyping(raw)}` }),
        buttons: [
          { label: t('entry.discard'), value: true, kind: 'danger' },
          { label: t('entry.keepEditing'), value: false, kind: 'primary' },
        ],
        dismissValue: false,
      }).then((discard) => {
        asking = false;
        if (discard && root.isConnected) router.back({ force: true });
      });
    }
    return true;
  });
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    removeGuard();
  };
};
