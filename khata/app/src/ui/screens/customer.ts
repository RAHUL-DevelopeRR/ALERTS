/** Customer detail: big balance, Gave / Got, reminder / statement / call, entries with collapsed corrections. */
import { amountInWords, formatCode, formatINR, formatPhone, telLink, whatsappLink } from '../../core/ledger';
import type { Customer, EntryView } from '../../data/types';
import { getLang, t } from '../../i18n';
import { afterWrite, app, refreshSettings } from '../app';
import { button, h, icon } from '../components/dom';
import { actionSheet, confirmDialog, promptDialog, toast, type SheetAction } from '../components/overlay';
import { iconButton, shell, showFooter } from '../components/shell';
import { balanceLabel, day, kindLabel, modeLabel, money, signedDelta, toneClass, today } from '../format';
import { errorText } from '../errors';
import * as router from '../router';
import type { Screen } from '../router';
import { reminderText } from '../statement-text';

/** Per-session toggle, shared by all customers. */
let showCorrections = false;

export const customerScreen: Screen = async (root, route) => {
  const id = route.params.id;
  const s = await refreshSettings();
  const [c, rows] = await Promise.all([app.repo.getCustomer(id), app.repo.listEntries(id)]);
  if (!c) throw new Error('NOT_FOUND');
  const balance = rows.length ? rows[rows.length - 1].running_paise : 0;
  const owner = s.role === 'owner';

  const more = iconButton('more', t('common.more'), () => openMenu(c, balance, owner));
  const { body, footer } = shell(root, { title: c.name, sub: formatCode(c.code), back: true, actions: [more] });

  // ---- notes
  if (c.erased_at) body.appendChild(h('div', { class: 'note-box', text: t('det.erasedNote') }));
  else if (c.archived_at) body.appendChild(h('div', { class: 'note-box', text: t('det.archivedNote') }));
  if (c.sync_state === 'rejected' || rows.some((r) => r.sync_state === 'rejected')) body.appendChild(h('div', { class: 'note-box', text: t('det.rejectedNote') }));

  // ---- hero
  const metaBits: (Node | string)[] = [formatCode(c.code)];
  if (c.phone) {
    metaBits.push(' · ', button(formatPhone(c.phone), () => void app.platform.openExternal(telLink(c.phone!)), 'link', { 'data-testid': 'cust-phone-link' }));
  }
  // Settled (₹0 after some entries): green, with "Send receipt" instead of the reminder.
  const settled = balance === 0 && rows.length > 0;
  const tone = settled ? 'settled' : toneClass(balance);
  const hero = h(
    'section',
    { class: `card hero${settled ? ' hero-settled' : ''}`, attrs: { 'data-testid': 'hero' } },
    h('div', 'hero-meta', metaBits),
    c.note ? h('div', { class: 'hero-meta', text: c.note }) : null,
    h('div', { class: `hero-label ${tone}`, text: balanceLabel(balance) }),
    balance !== 0 ? h('div', { class: `hero-amt ${tone}`, attrs: { 'data-testid': 'balance' }, text: money(balance) }) : h('div', { class: `hero-amt ${tone}`, attrs: { 'data-testid': 'balance' }, text: formatINR(0) }),
    balance !== 0 ? h('div', { class: 'hero-words', text: amountInWords(Math.abs(balance), getLang()) }) : null,
  );

  // ---- actions
  const remind = async (): Promise<void> => {
    const text = reminderText(c, balance, { shopName: s.shop_name, upiId: s.upi_id, lang: getLang(), asOf: today(s.clock_offset_ms) });
    const ok = await app.platform.openExternal(whatsappLink(c.phone, text));
    if (!ok) toast(t('st.noApp'), { error: true });
  };
  const actions = h(
    'div',
    'actions3',
    settled
      ? h('button', { class: 'act act-receipt', attrs: { type: 'button', disabled: !!c.erased_at, 'data-testid': 'act-receipt' }, on: { click: () => void router.go('statement', { id: c.id }) } }, icon('check'), t('det.sendReceipt'))
      : h('button', { class: 'act', attrs: { type: 'button', disabled: !!c.erased_at, 'data-testid': 'act-remind' }, on: { click: () => void remind() } }, icon('chat'), t('det.remind')),
    h('button', { class: 'act', attrs: { type: 'button', 'data-testid': 'act-statement' }, on: { click: () => void router.go('statement', { id: c.id }) } }, icon('doc'), t('det.statement')),
    h(
      'button',
      { class: 'act', attrs: { type: 'button', disabled: !c.phone, 'data-testid': 'act-call' }, on: { click: () => c.phone && void app.platform.openExternal(telLink(c.phone)) } },
      icon('phone'),
      t('det.call'),
    ),
  );

  // ---- entries (newest first, each with the running balance after it)
  const hasCorrections = rows.some((r) => r.kind === 'REVERSAL');
  const listHead = h(
    'div',
    'list-head',
    h('h2', { class: 'section-title', text: t('det.entries') }),
    hasCorrections
      ? button(showCorrections ? t('det.hideCorrections') : t('det.showCorrections'), () => {
          showCorrections = !showCorrections;
          void router.rerender();
        }, 'link', { 'data-testid': 'toggle-corrections' })
      : null,
  );
  const list = h('div', { class: 'list', attrs: { 'data-testid': 'entries' } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'REVERSAL' && !showCorrections && r.reverses_entry_id && byId.has(r.reverses_entry_id)) continue;
    list.appendChild(entryRow(r, byId, s.paired, () => onEntryTap(c, r, owner)));
  }
  body.append(hero, actions, listHead, rows.length ? list : h('div', { class: 'empty', text: t('det.noEntries') }));

  // ---- Gave / Got
  if (!c.erased_at || balance !== 0) {
    showFooter(
      footer,
      h(
        'div',
        'footer-row',
        button([h('span', 'btn-main', t('det.gave')), h('span', 'btn-sub', t('det.gaveSub'))], () => void router.go('entry', { id: c.id, kind: 'GIVE' }), 'btn btn-gave btn-xl btn-stack', { 'data-testid': 'btn-gave' }),
        button([h('span', 'btn-main', t('det.got')), h('span', 'btn-sub', t('det.gotSub'))], () => void router.go('entry', { id: c.id, kind: 'RECEIVE' }), 'btn btn-got btn-xl btn-stack', { 'data-testid': 'btn-got' }),
      ),
    );
  }
};

function entryRow(r: EntryView, byId: Map<string, EntryView>, paired: boolean, onTap: () => void): HTMLElement {
  const meta: string[] = [day(r.biz_date)];
  let kindText = kindLabel(r.kind);
  let amountText = signedDelta(r.delta_paise);
  let tone = r.delta_paise > 0 ? 'owes' : 'adv';
  let struck = false;
  if (r.kind === 'REVERSAL') {
    const orig = r.reverses_entry_id ? byId.get(r.reverses_entry_id) : undefined;
    kindText = orig ? t('det.correctionOf', { kind: kindLabel(orig.kind), amount: formatINR(orig.amount_paise) }) : kindLabel('REVERSAL');
    tone = 'zero';
  } else if (r.is_reversed) {
    struck = true;
    kindText = `${t('kind.corrected')}: ${kindLabel(r.kind)}`;
    amountText = formatINR(r.amount_paise);
    tone = 'zero';
  }
  if (r.kind === 'RECEIVE' && r.mode) meta.push(modeLabel(r.mode));
  if (r.note) meta.push(r.note);
  const kindTone = r.kind === 'GIVE' ? 'owes' : r.kind === 'RECEIVE' || r.kind === 'WRITEOFF' ? 'adv' : 'zero';
  return h(
    'button',
    { class: `entry-row${struck ? ' struck' : ''}`, attrs: { type: 'button', 'data-testid': 'entry-row', 'data-kind': r.kind, 'data-reversed': r.is_reversed ? '1' : '0' }, on: { click: onTap } },
    h(
      'span',
      'entry-main',
      h('span', { class: `entry-kind ${struck ? '' : kindTone}` }, h('span', { class: 'entry-kind-text', text: kindText })),
      h(
        'span',
        'entry-meta',
        h('span', { text: meta.join(' · ') }),
        r.device_name ? h('span', { class: 'badge badge-dev', text: r.device_name }) : null,
        r.sync_state === 'rejected' ? h('span', { class: 'badge badge-bad', text: t('badge.rejected') }) : null,
        paired && r.sync_state === 'pending' ? h('span', { class: 'badge badge-warn', text: t('badge.pending') }) : null,
      ),
    ),
    h(
      'span',
      'entry-side',
      h('span', { class: `entry-amt amt ${tone}`, text: amountText }),
      struck ? null : h('span', { class: 'entry-run', text: r.running_paise === 0 ? t('bal.short', { amount: formatINR(0) }) : signedBal(r.running_paise) }),
    ),
  );
}

function onEntryTap(c: Customer, r: EntryView, owner: boolean): void {
  if (r.kind === 'REVERSAL' || r.is_reversed || r.sync_state === 'rejected') {
    toast(t('det.cannotCorrect'));
    return;
  }
  const actions: SheetAction[] = [];
  if (r.kind === 'GIVE' || r.kind === 'RECEIVE') {
    actions.push({
      label: t('det.correct'),
      sub: t('det.correctHelp'),
      run: () => void router.go('entry', { id: c.id, kind: r.kind }, { correct: r }),
    });
  }
  if (r.kind !== 'WRITEOFF' || owner) {
    actions.push({
      label: t('det.cancelEntry'),
      danger: true,
      run: async () => {
        const ok = await confirmDialog({ message: t('det.cancelConfirm', { amount: formatINR(r.amount_paise) }), ok: t('det.cancelEntry'), danger: true });
        if (!ok) return;
        try {
          const res = await app.repo.reverseEntry(r.id);
          afterWrite();
          void app.platform.hapticTap();
          toast(t('det.cancelled', { bal: signedBal(res.balance_paise) }));
          void router.rerender();
        } catch (e) {
          toast(errorText(e), { error: true });
        }
      },
    });
  }
  actionSheet({
    title: `${kindLabel(r.kind)} ${formatINR(r.amount_paise)}`,
    subtitle: [day(r.biz_date, false), r.note ?? ''].filter(Boolean).join(' · '),
    actions,
  });
}

/** The whole balance phrase, never a bare or minus amount: "நிலுவை ₹500" / "முன்பணம் ₹50" / "கணக்கு முடிந்தது".
 *  Toasts put it after a "·" with no word of their own, so an advance can never read as money owed. */
export function signedBal(paise: number): string {
  if (paise > 0) return t('bal.short', { amount: formatINR(paise) });
  if (paise < 0) return `${t('bal.advance')} ${formatINR(-paise)}`;
  return t('bal.settled');
}

function openMenu(c: Customer, balance: number, owner: boolean): void {
  const actions: SheetAction[] = [];
  if (!c.erased_at) actions.push({ label: t('det.menuEdit'), run: () => void router.go('customer-edit', { id: c.id }) });
  if (owner && balance > 0) {
    actions.push({
      label: t('det.menuWriteoff'),
      sub: t('set.owner'),
      run: async () => {
        const reason = await promptDialog({
          title: t('det.writeoffTitle', { amount: formatINR(balance) }),
          label: t('det.writeoffReason'),
          placeholder: t('det.writeoffReasonPh'),
          ok: t('det.menuWriteoff'),
          danger: true,
        });
        if (!reason) return;
        try {
          const res = await app.repo.addEntry({ customer_id: c.id, kind: 'WRITEOFF', amount_paise: balance, note: reason });
          afterWrite();
          toast(t('det.writeoffDone', { bal: signedBal(res.balance_paise) }));
          void router.rerender();
        } catch (e) {
          toast(errorText(e), { error: true });
        }
      },
    });
  }
  if (c.archived_at) {
    actions.push({
      label: t('det.menuUnarchive'),
      run: async () => {
        try {
          await app.repo.unarchiveCustomer(c.id);
          afterWrite();
          void router.rerender();
        } catch (e) {
          toast(errorText(e), { error: true });
        }
      },
    });
  } else if (owner && balance === 0 && !c.erased_at) {
    actions.push({
      label: t('det.menuArchive'),
      sub: t('set.owner'),
      run: async () => {
        if (!(await confirmDialog({ message: t('det.archiveConfirm', { name: c.name }), ok: t('det.menuArchive') }))) return;
        try {
          await app.repo.archiveCustomer(c.id);
          afterWrite();
          toast(t('det.archived'));
          router.back();
        } catch (e) {
          toast(errorText(e), { error: true });
        }
      },
    });
  }
  if (owner && !c.erased_at) {
    actions.push({
      label: t('det.menuErase'),
      sub: t('set.owner'),
      danger: true,
      run: async () => {
        const code = String(c.code);
        const typed = await promptDialog({
          title: t('det.eraseTitle', { name: c.name }),
          message: t('det.eraseBody'),
          label: t('det.eraseType', { code }),
          inputmode: 'numeric',
          ok: t('det.menuErase'),
          danger: true,
          valid: (v) => v.trim().replace(/^c-?0*/i, '') === code,
        });
        if (typed === null) return;
        try {
          if (app.settings.paired) await app.sync.eraseCustomer(c.id);
          else await app.repo.applyErasure(c.id);
          afterWrite();
          toast(t('det.erased'));
          void router.rerender();
        } catch (e) {
          toast(errorText(e), { error: true });
        }
      },
    });
  }
  actionSheet({ title: c.name, subtitle: formatCode(c.code), actions });
}
