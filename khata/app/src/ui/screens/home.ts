/** Home / Customers: totals, search (Tamil or English), sort + filter chips, the customer list. */
import { formatCode, formatINR, matchesQuery, normName, searchKey } from '../../core/ledger';
import type { HomeRow } from '../../data/types';
import { t } from '../../i18n';
import { app, refreshSettings } from '../app';
import { add, button, clear, h, icon } from '../components/dom';
import { dialog } from '../components/overlay';
import { searchField } from '../components/search';
import { shell } from '../components/shell';
import { syncPill } from '../components/sync-pill';
import { money, toneClass } from '../format';
import * as router from '../router';
import type { Screen } from '../router';
import { saveBackupCopy } from '../backup';
import { micFab } from '../voice/mic-button';
import { micIcon } from '../voice/icons';
import { openVoiceMode } from './voice-mode';
import { loadVoicePrefs } from '../voice/prefs';

type Sort = 'recent' | 'due' | 'oldest';

/** Survives navigation (back from a customer keeps the search and the due list), reset on a fresh app start.
 *  The search is cleared after an entry is saved (entry.ts), so the next customer starts from a clean box.
 *  dueDays / dueMin: the morning collection round's "due list" (0 = no limit; both 0 = list off). */
export const homeState = { q: '', sort: 'recent' as Sort, dueOn: false, dueDays: 0, dueMin: 0 };

const DUE_DAY_CHOICES = [0, 7, 15, 30, 60];
const DUE_MIN_CHOICES = [0, 10_000, 50_000, 100_000, 500_000];

const BACKUP_NUDGE_MS = 7 * 86_400_000;
const SKEW_WARN_MS = 10 * 60_000;

function sortRows(rows: HomeRow[], sort: Sort): HomeRow[] {
  const out = rows.slice();
  if (sort === 'due') out.sort((a, b) => b.balance_paise - a.balance_paise || a.name.localeCompare(b.name));
  else if (sort === 'oldest') {
    out.sort((a, b) => {
      const ao = a.balance_paise > 0 ? 0 : 1;
      const bo = b.balance_paise > 0 ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const an = a.last_payment === null ? 0 : 1; // never paid first
      const bn = b.last_payment === null ? 0 : 1;
      if (ao === 0 && an !== bn) return an - bn;
      return (b.days_since ?? -1) - (a.days_since ?? -1) || b.balance_paise - a.balance_paise;
    });
  }
  return out;
}

function daysText(r: HomeRow): { text: string; late: boolean } | null {
  if (r.days_since === null) return null;
  if (r.balance_paise > 0) {
    if (r.last_payment === null) return r.days_since > 0 ? { text: t('home.unpaidFor', { n: r.days_since }), late: r.days_since >= 30 } : null;
    return { text: r.days_since === 0 ? t('home.paidToday') : t('home.paidAgo', { n: r.days_since }), late: r.days_since >= 30 };
  }
  if (r.last_payment !== null) return { text: r.days_since === 0 ? t('home.paidToday') : t('home.paidAgo', { n: r.days_since }), late: false };
  return null;
}

/** Second line: code + note, or code + last 4 phone digits, so two Murugans are told apart. */
export function rowDetail(r: { code: number; note: string | null; phone: string | null }): string {
  const bits = [formatCode(r.code)];
  if (r.note) bits.push(r.note);
  else if (r.phone) bits.push(`•• ${r.phone.replace(/\D/g, '').slice(-4)}`);
  return bits.join(' · ');
}

function customerRow(r: HomeRow, paired: boolean): HTMLElement {
  const dt = daysText(r);
  const badges = [
    r.archived_at ? h('span', { class: 'badge', text: t('badge.archived') }) : null,
    r.erased_at ? h('span', { class: 'badge', text: t('badge.erased') }) : null,
    r.has_rejected ? h('span', { class: 'badge badge-bad', text: t('badge.rejected') }) : null,
    paired && r.has_pending ? h('span', { class: 'badge badge-warn', text: t('badge.pending') }) : null,
  ];
  return h(
    'button',
    { class: 'cust-row', attrs: { type: 'button', 'data-testid': 'cust-row', 'data-id': r.id }, on: { click: () => void router.go('customer', { id: r.id }) } },
    h('span', 'cust-main', h('span', { class: 'cust-name' }, r.name, badges), h('span', { class: 'cust-sub', text: rowDetail(r) })),
    h(
      'span',
      'cust-side',
      h('span', { class: `cust-bal amt ${toneClass(r.balance_paise)}`, text: money(r.balance_paise) }),
      r.balance_paise < 0 ? h('span', { class: 'cust-days adv', text: t('bal.advance') }) : null,
      dt && r.balance_paise >= 0 ? h('span', { class: `cust-days${dt.late ? ' late' : ''}`, text: dt.text }) : null,
    ),
  );
}

export const homeScreen: Screen = async (root, route) => {
  const s = await refreshSettings();
  const [rows, totals, onboarded] = await Promise.all([app.repo.listHome(), app.repo.totals(), app.repo.getMeta('onboarded'), loadVoicePrefs()]);
  // Other phones' latest entries: fetched now if the last sync is older than a few seconds (redraws when they land).
  app.sync.refreshIfStale();
  if (route.params.fresh === '1') {
    homeState.q = '';
    delete route.params.fresh;
  }
  const pill = syncPill();
  const { body } = shell(root, {
    title: s.shop_name || t('app.name'),
    below: pill.el,
  });
  root.classList.add('home');

  // ---- summary
  const summary = h(
    'div',
    { class: 'summary', attrs: { 'data-testid': 'summary' } },
    h('div', { class: 'summary-label', text: t('home.toCollect') }),
    h('div', { class: 'summary-amt num', text: formatINR(totals.receivable_paise) }),
    h('div', { class: 'summary-sub', text: totals.customers_owing === 0 ? t('home.fromNone') : totals.customers_owing === 1 ? t('home.fromOne') : t('home.fromN', { n: totals.customers_owing }) }),
    totals.advance_paise > 0 ? h('div', { class: 'summary-adv', text: t('home.advances', { amount: formatINR(totals.advance_paise) }) }) : null,
  );

  // ---- banners
  const banners: HTMLElement[] = [];
  const st = app.sync.status();
  if (st.clock_skew_ms > SKEW_WARN_MS) {
    banners.push(h('div', 'banner', icon('warn'), h('span', { class: 'banner-text', text: t('home.skew', { n: Math.round(st.clock_skew_ms / 60_000) }) })));
  }
  const ref = s.last_backup_at ?? onboarded;
  const refMs = ref ? Date.parse(ref) : NaN;
  if (rows.length > 0 && (Number.isNaN(refMs) || Date.now() - refMs > BACKUP_NUDGE_MS)) {
    banners.push(
      h(
        'div',
        { class: 'banner', attrs: { 'data-testid': 'backup-nudge' } },
        icon('warn'),
        h('span', { class: 'banner-text', text: s.last_backup_at ? t('home.backupNudge') : t('home.backupNever') }),
        button(t('home.backupNow'), () => void saveBackupCopy().then(() => router.rerender()), 'btn'),
      ),
    );
  }

  // ---- search + chips
  const search = searchField({
    value: homeState.q,
    testid: 'search',
    onInput: (q) => {
      homeState.q = q;
      paint();
    },
    onEnter: () => void app.platform.hideKeyboard(),
  });
  // Voice entry (v2): the mic sits beside the search box; null when switched off in Settings → Voice.
  const searchRow = h('div', 'search-row', search.el);
  // Sort chips wrap onto a second line instead of scrolling off-screen; the due list is a separate, clearly
  // different action (a filter with its own sheet), not a fourth sort.
  const chipRow = h('div', 'chips');
  const dueLine = h('div', { class: 'due-total hidden', attrs: { 'data-testid': 'due-total' } });
  const list = h('div', { class: 'list', attrs: { 'data-testid': 'cust-list' } });
  const emptyEl = h('div', 'empty hidden');
  const keys = new Map(rows.map((r) => [r.id, searchKey(r)]));

  const dueWhat = (): string => {
    const bits: string[] = [];
    if (homeState.dueDays) bits.push(t('home.dueDays', { n: homeState.dueDays }));
    if (homeState.dueMin) bits.push(t('home.dueMin', { amount: formatINR(homeState.dueMin) }));
    return bits.join(' · ') || t('home.dueAny');
  };

  const openDueSheet = async (): Promise<void> => {
    let days = homeState.dueOn ? homeState.dueDays : 30;
    let min = homeState.dueOn ? homeState.dueMin : 0;
    const daysRow = h('div', 'chips');
    const minRow = h('div', 'chips');
    const paintSheet = (): void => {
      clear(daysRow);
      clear(minRow);
      for (const d of DUE_DAY_CHOICES) {
        daysRow.appendChild(
          h('button', { class: `chip${days === d ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': days === d ? 'true' : 'false', 'data-testid': `due-days-${d}` }, text: d ? t('home.dueDays', { n: d }) : t('home.dueAny'), on: { click: () => { days = d; paintSheet(); } } }),
        );
      }
      for (const m of DUE_MIN_CHOICES) {
        minRow.appendChild(
          h('button', { class: `chip${min === m ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': min === m ? 'true' : 'false', 'data-testid': `due-min-${m}` }, text: m ? t('home.dueMin', { amount: formatINR(m) }) : t('home.dueAny'), on: { click: () => { min = m; paintSheet(); } } }),
        );
      }
    };
    paintSheet();
    const choice = await dialog<'show' | 'clear' | null>({
      title: t('home.dueList'),
      body: h('div', null, h('div', { class: 'field-label', text: t('home.dueDaysLabel') }), daysRow, h('div', { class: 'field-label', style: { marginTop: '10px' }, text: t('home.dueMinLabel') }), minRow),
      buttons: [
        { label: t('common.clear'), value: 'clear' },
        { label: t('home.dueShow'), value: 'show', kind: 'primary' },
      ],
      dismissValue: null,
    });
    if (choice === 'show') {
      homeState.dueOn = true;
      homeState.dueDays = days;
      homeState.dueMin = min;
    } else if (choice === 'clear') {
      homeState.dueOn = false;
    } else return;
    paint();
  };

  const paintChips = (): void => {
    clear(chipRow);
    const chip = (label: string, on: boolean, fn: () => void, testid: string): HTMLElement =>
      h('button', { class: `chip${on ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': on ? 'true' : 'false', 'data-testid': testid }, on: { click: fn } }, label);
    chipRow.append(
      chip(t('home.sortRecent'), homeState.sort === 'recent', () => { homeState.sort = 'recent'; paint(); }, 'sort-recent'),
      chip(t('home.sortDue'), homeState.sort === 'due', () => { homeState.sort = 'due'; paint(); }, 'sort-due'),
      chip(t('home.sortOldest'), homeState.sort === 'oldest', () => { homeState.sort = 'oldest'; paint(); }, 'sort-oldest'),
      h(
        'button',
        { class: `chip chip-filter${homeState.dueOn ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': homeState.dueOn ? 'true' : 'false', 'data-testid': 'due-list' }, on: { click: () => void openDueSheet() } },
        icon('filter', 'ic-sm'),
        homeState.dueOn ? t('home.dueListOn', { what: dueWhat() }) : t('home.dueList'),
      ),
    );
  };

  const paint = (): void => {
    paintChips();
    clear(list);
    const q = homeState.q.trim();
    let shown = rows.filter((r) => matchesQuery(keys.get(r.id) ?? '', q));
    if (homeState.dueOn) {
      shown = shown.filter((r) => r.balance_paise > 0 && r.balance_paise >= homeState.dueMin && (r.days_since ?? 0) >= homeState.dueDays);
    }
    shown = sortRows(shown, homeState.sort);
    const frag = document.createDocumentFragment();
    for (const r of shown) frag.appendChild(customerRow(r, s.paired));
    // "Add as new" only AFTER the matches (the thumb lands on the first row while typing), and only as a
    // secondary row when something matched.
    if (q && !rows.some((r) => normName(r.name) === normName(q))) {
      frag.appendChild(
        h(
          'button',
          { class: `cust-row add-row${shown.length ? ' secondary' : ''}`, attrs: { type: 'button', 'data-testid': 'add-as-new' }, on: { click: () => void router.go('customer-edit', { name: q }) } },
          icon('plus'),
          h('span', { class: 'cust-main', text: t('home.addAs', { q }) }),
        ),
      );
    }
    list.appendChild(frag);
    list.classList.toggle('hidden', !list.firstChild);
    if (homeState.dueOn && shown.length) {
      const sum = shown.reduce((a, r) => a + r.balance_paise, 0);
      dueLine.textContent = shown.length === 1 ? t('home.dueTotalOne', { amount: formatINR(sum) }) : t('home.dueTotal', { n: shown.length, amount: formatINR(sum) });
      dueLine.classList.remove('hidden');
    } else dueLine.classList.add('hidden');
    emptyEl.classList.toggle('hidden', shown.length > 0);
    emptyEl.textContent = rows.length === 0
      ? t('home.empty')
      : homeState.dueOn && !q
        ? homeState.dueDays && !homeState.dueMin ? t('home.noneDays', { n: homeState.dueDays }) : t('home.dueNone')
        : t('home.noMatch', { q });
    if (shown.length === 0 && q && list.firstChild) {
      // Only the "add as new" row: say why first, then offer it.
      emptyEl.classList.remove('hidden');
      emptyEl.classList.add('empty-tight');
    } else emptyEl.classList.remove('empty-tight');
  };

  add(
    body,
    summary,
    banners,
    rows.length > 0 || homeState.q ? searchRow : null,
    rows.length > 0 ? chipRow : null,
    dueLine,
    emptyEl,
    list,
  );
  paint();

  // ---- bottom bar + floating "+ Customer"
  body.classList.add('pad-fab');
  const bar = h(
    'nav',
    'bottom-bar',
    h('button', { class: 'nav-btn', attrs: { type: 'button', 'data-testid': 'nav-daybook' }, on: { click: () => void router.go('daybook') } }, icon('book'), h('span', { text: t('home.dayBook') })),
    h('button', { class: 'nav-btn nav-voice', attrs: { type: 'button', 'data-testid': 'nav-voice' }, on: { click: () => void openVoiceMode() } }, micIcon(), h('span', { text: t('vm.nav') })),
    h('button', { class: 'nav-btn', attrs: { type: 'button', 'data-testid': 'nav-settings' }, on: { click: () => void router.go('settings') } }, icon('gear'), h('span', { text: t('home.settings') })),
  );
  const fab = h(
    'button',
    { class: 'fab', attrs: { type: 'button', 'data-testid': 'add-customer' }, on: { click: () => void router.go('customer-edit', homeState.q.trim() ? { name: homeState.q.trim() } : {}) } },
    icon('plus'),
    h('span', { text: t('home.addCustomer') }),
  );
  root.append(micFab({}), fab);
  root.appendChild(bar);
  return () => pill.dispose();
};
