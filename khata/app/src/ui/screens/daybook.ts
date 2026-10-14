/**
 * Day book: one IST day at a time. "Business day" = repo.dayBook (by biz_date); "Entered on this day" =
 * repo.enteredOn (by created_at, whatever date the entry carries). Reversed pairs collapse into one struck line.
 */
import { addDays, bizDateIST, formatCode, formatINR, formatTimeIST } from '../../core/ledger';
import type { DayBookRow, DayBookTotals } from '../../data/types';
import { getLang, t } from '../../i18n';
import { app, refreshSettings } from '../app';
import { button, h, icon } from '../components/dom';
import { dialog } from '../components/overlay';
import { iconButton, shell, showFooter } from '../components/shell';
import { day, kindLabel, modeLabel, signedDelta, today } from '../format';
import { startQuick } from '../quick-session';
import * as router from '../router';
import type { Screen } from '../router';

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_TA = ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'];

let tab: 'business' | 'entered' = 'business';

/** Totals for the "entered" tab, computed like the day book: reversed originals and their reversals excluded. */
export function totalsOf(rows: DayBookRow[], label: string): DayBookTotals {
  const tot: DayBookTotals = {
    biz_date: label, given_paise: 0, received_paise: 0, received_cash_paise: 0, received_upi_paise: 0,
    received_other_paise: 0, writeoff_paise: 0, net_paise: 0, corrections_count: 0, entry_count: rows.length,
  };
  for (const r of rows) {
    tot.net_paise += r.delta_paise;
    if (r.kind === 'REVERSAL') {
      tot.corrections_count++;
      continue;
    }
    if (r.is_reversed) continue;
    if (r.kind === 'GIVE') tot.given_paise += r.amount_paise;
    else if (r.kind === 'WRITEOFF') tot.writeoff_paise += r.amount_paise;
    else if (r.kind === 'RECEIVE') {
      tot.received_paise += r.amount_paise;
      if (r.mode === 'CASH') tot.received_cash_paise += r.amount_paise;
      else if (r.mode === 'UPI') tot.received_upi_paise += r.amount_paise;
      else tot.received_other_paise += r.amount_paise;
    }
  }
  return tot;
}

function totalCard(label: string, value: string, tone: string, sub?: string, wide = false, testid?: string): HTMLElement {
  return h(
    'div',
    { class: `tot${wide ? ' wide' : ''}`, attrs: { 'data-testid': testid } },
    h('div', { class: 'tot-label', text: label }),
    h('div', { class: `tot-val amt ${tone}`, text: value }),
    sub ? h('div', { class: 'tot-sub', text: sub }) : null,
  );
}

function dayRow(r: DayBookRow, byId: Map<string, DayBookRow>): HTMLElement {
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
  const meta = [kindText];
  if (r.kind === 'RECEIVE' && r.mode && !struck) meta.push(modeLabel(r.mode));
  if (r.note) meta.push(r.note);
  // The typed time only means something when the slip was typed on its own date. A back-dated slip on the
  // business tab shows "typed 14 Oct" instead of today's time under 13 Oct.
  const typedOn = bizDateIST(new Date(r.created_at));
  const backDated = typedOn !== r.biz_date;
  const showTime = tab === 'entered' || !backDated;
  return h(
    'button',
    { class: `day-row${struck ? ' struck' : ''}`, attrs: { type: 'button', 'data-testid': 'day-row', 'data-kind': r.kind }, on: { click: () => void router.go('customer', { id: r.customer_id }) } },
    h('span', { class: 'day-time num', text: showTime ? formatTimeIST(r.created_at) : '' }),
    h(
      'span',
      'entry-main',
      h('span', 'entry-kind', h('span', { class: 'day-name', text: r.customer_name }), ' ', h('span', { class: 'day-code', text: `· ${formatCode(r.customer_code)}` })),
      h(
        'span',
        'entry-meta',
        h('span', { class: 'entry-kind-text', text: meta.join(' · ') }),
        r.device_name ? h('span', { class: 'badge badge-dev', text: r.device_name }) : null,
        !showTime ? h('span', { class: 'badge', attrs: { 'data-testid': 'typed-on' }, text: t('day.enteredOn', { date: day(typedOn) }) }) : null,
      ),
    ),
    h('span', 'entry-side', h('span', { class: `entry-amt amt ${tone}`, text: amountText }), tab === 'entered' && r.biz_date !== bizDateIST(new Date(r.created_at)) ? h('span', { class: 'entry-run', text: t('day.forDate', { date: day(r.biz_date) }) }) : null),
  );
}

export const dayBookScreen: Screen = async (root, route) => {
  const s = await refreshSettings();
  const todayStr = today(s.clock_offset_ms);
  const date = route.params.date && route.params.date <= todayStr ? route.params.date : todayStr;
  const [book, entered, month] = await Promise.all([
    app.repo.dayBook(date),
    app.repo.enteredOn(date),
    app.repo.monthTotals(date.slice(0, 7)),
  ]);
  const rows = tab === 'business' ? book.rows : entered;
  const tot = tab === 'business' ? book.totals : totalsOf(entered, date);

  const { body, footer } = shell(root, { title: t('day.title'), back: true });
  const setDate = (d: string): void => {
    route.params.date = d;
    route.scroll = 0;
    void router.rerender();
  };
  const pick = async (): Promise<void> => {
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
    if (ok && input.value) setDate(input.value);
  };
  const dateLabel = date === todayStr ? `${t('common.today')} · ${day(date)}` : date === addDays(todayStr, -1) ? `${t('common.yesterday')} · ${day(date)}` : day(date, false);
  const nav = h(
    'div',
    'date-nav',
    iconButton('chevL', t('day.prev'), () => setDate(addDays(date, -1))),
    h('button', { class: 'date-btn', attrs: { type: 'button', 'data-testid': 'day-date' }, on: { click: () => void pick() } }, icon('cal'), dateLabel),
    date < todayStr ? iconButton('chevR', t('day.next'), () => setDate(addDays(date, 1))) : h('span', { style: { width: '48px' } }),
  );
  const seg = h(
    'div',
    'seg',
    h('button', { class: tab === 'business' ? 'on' : '', attrs: { type: 'button', 'data-testid': 'tab-business' }, text: t('day.business'), on: { click: () => { tab = 'business'; void router.rerender(); } } }),
    h('button', { class: tab === 'entered' ? 'on' : '', attrs: { type: 'button', 'data-testid': 'tab-entered' }, text: t('day.entered'), on: { click: () => { tab = 'entered'; void router.rerender(); } } }),
  );
  const net = tot.net_paise;
  const grid = h(
    'div',
    'tot-grid',
    totalCard(t('day.given'), formatINR(tot.given_paise), 'owes', undefined, false, 'tot-given'),
    totalCard(t('day.received'), formatINR(tot.received_paise), 'adv', undefined, false, 'tot-received'),
    h(
      'div',
      { class: 'tot wide', attrs: { 'data-testid': 'tot-split' } },
      h('div', { class: 'tot-sub', text: t('day.split', { cash: formatINR(tot.received_cash_paise), upi: formatINR(tot.received_upi_paise), other: formatINR(tot.received_other_paise) }) }),
    ),
    totalCard(t('day.net'), signedDelta(net), net > 0 ? 'owes' : net < 0 ? 'adv' : 'zero', undefined, false, 'tot-net'),
    totalCard(t('day.writeoffs'), formatINR(tot.writeoff_paise), 'zero', `${t('day.corrections')}: ${tot.corrections_count}`, false, 'tot-writeoff'),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const list = h('div', { class: 'list', attrs: { 'data-testid': 'day-list' } });
  let shownCount = 0;
  for (const r of rows) {
    if (r.kind === 'REVERSAL' && r.reverses_entry_id && byId.has(r.reverses_entry_id)) continue;
    list.appendChild(dayRow(r, byId));
    shownCount++;
  }
  const monthName = (getLang() === 'ta' ? MONTHS_TA : MONTHS_EN)[Number(date.slice(5, 7)) - 1];
  body.append(
    nav,
    seg,
    grid,
    h('div', 'list-head', h('h2', { class: 'section-title', text: shownCount === 1 ? t('day.entriesOne') : t('day.entries', { n: shownCount }) })),
    rows.length ? list : h('div', { class: 'empty', text: t('day.none') }),
    h('p', { class: 'month-line', attrs: { 'data-testid': 'month-line' }, text: t('day.month', { month: `${monthName} ${date.slice(0, 4)}`, given: formatINR(month.given_paise), received: formatINR(month.received_paise) }) }),
  );
  showFooter(
    footer,
    button(
      [icon('bolt'), t('day.quick')],
      () => {
        startQuick(date === todayStr ? null : date);
        void router.go('quick');
      },
      'btn btn-primary btn-big btn-block',
      { 'data-testid': 'quick-entry' },
    ),
  );
};
