/**
 * Quick entry (from the day book): search customer -> keypad -> "Save & next" -> back here, for the evening's
 * paper slips. The date chip is sticky across the sitting; a running count and totals are shown.
 * A name that is not in the list gets the same "add as new" row as home: new customer -> keypad (quick mode,
 * sticky date) -> back here, without losing the sitting.
 */
import { addDays, formatINR, matchesQuery, normName, searchKey } from '../../core/ledger';
import { t } from '../../i18n';
import { app, refreshSettings } from '../app';
import { button, clear, h, icon } from '../components/dom';
import { actionSheet, dialog } from '../components/overlay';
import { searchField } from '../components/search';
import { shell, showFooter } from '../components/shell';
import { day, money, today, toneClass } from '../format';
import { endQuick, quick } from '../quick-session';
import * as router from '../router';
import type { Screen } from '../router';
import { rowDetail } from './home';

export const quickScreen: Screen = async (root) => {
  const s = await refreshSettings();
  if (!quick.active) {
    router.back();
    return;
  }
  const todayStr = today(s.clock_offset_ms);
  const rows = (await app.repo.listHome()).filter((r) => !r.erased_at);
  const keys = new Map(rows.map((r) => [r.id, searchKey(r)]));
  const { body, footer } = shell(root, { title: t('quick.title'), back: true });

  const summary = h('div', { class: 'card', attrs: { 'data-testid': 'quick-sitting' } },
    h('div', { class: 'tot-label', text: t(quick.count === 1 ? 'quick.sittingOne' : 'quick.sitting', { n: quick.count, gave: formatINR(quick.gave), got: formatINR(quick.got) }) }),
  );
  const date = quick.date ?? todayStr;
  const dateLabel = date === todayStr ? t('common.today') : date === addDays(todayStr, -1) ? t('common.yesterday') : day(date, false);
  const dateChip = h(
    'button',
    { class: `chip${date !== todayStr ? ' on' : ''}`, attrs: { type: 'button', 'data-testid': 'quick-date' }, on: { click: () => pickDate() } },
    icon('cal', 'ic-sm'),
    `${t('quick.dateFor')}: ${dateLabel}`,
  );
  const pickDate = (): void => {
    actionSheet({
      title: t('quick.dateFor'),
      actions: [
        { label: t('common.today'), run: () => { quick.date = null; void router.rerender(); } },
        { label: t('common.yesterday'), run: () => { quick.date = addDays(todayStr, -1); void router.rerender(); } },
        {
          label: `${t('common.pickDate')}…`,
          run: async () => {
            const input = h('input', { class: 'input', attrs: { type: 'date', max: todayStr, value: date } });
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
            if (ok && input.value) {
              quick.date = input.value === todayStr ? null : input.value;
              void router.rerender();
            }
          },
        },
      ],
    });
  };

  const search = searchField({ value: '', testid: 'quick-search', onInput: () => paint(), onEnter: () => void app.platform.hideKeyboard() });
  const input = search.input;
  const list = h('div', 'list');
  const paint = (): void => {
    clear(list);
    const q = input.value.trim();
    const shown = rows.filter((r) => matchesQuery(keys.get(r.id) ?? '', q)).slice(0, q ? 50 : 30);
    for (const r of shown) {
      list.appendChild(
        h(
          'button',
          { class: 'cust-row', attrs: { type: 'button', 'data-testid': 'quick-row' }, on: { click: () => void router.go('entry', { id: r.id, kind: 'GIVE', quick: '1' }) } },
          h('span', 'cust-main', h('span', { class: 'cust-name', text: r.name }), h('span', { class: 'cust-sub', text: rowDetail(r) })),
          h('span', 'cust-side', h('span', { class: `cust-bal amt ${toneClass(r.balance_paise)}`, text: money(r.balance_paise) })),
        ),
      );
    }
    if (q && !rows.some((r) => normName(r.name) === normName(q))) {
      list.appendChild(
        h(
          'button',
          { class: `cust-row add-row${shown.length ? ' secondary' : ''}`, attrs: { type: 'button', 'data-testid': 'quick-add-as-new' }, on: { click: () => void router.go('customer-edit', { name: q, quick: '1' }) } },
          icon('plus'),
          h('span', { class: 'cust-main', text: t('home.addAs', { q }) }),
        ),
      );
    }
    list.classList.toggle('hidden', !list.firstChild);
  };
  body.append(
    summary,
    h('div', 'chips', dateChip),
    h('p', { class: 'muted', style: { fontSize: '15px', margin: '4px 4px 10px' }, text: t('quick.help') }),
    search.el,
    list,
  );
  paint();
  showFooter(
    footer,
    button(t('quick.finish'), () => {
      endQuick();
      router.back();
    }, 'btn btn-big btn-block', { 'data-testid': 'quick-finish' }),
  );
  setTimeout(() => input.focus(), 60);
};
