/** Home / Customers: totals, search (Tamil or English), sort + filter chips, the customer list. */
import { formatCode, formatINR, matchesQuery, normName, searchKey } from '../../core/ledger';
import type { HomeRow } from '../../data/types';
import { t } from '../../i18n';
import { app, refreshSettings } from '../app';
import { add, button, clear, h, icon } from '../components/dom';
import { shell } from '../components/shell';
import { syncPill } from '../components/sync-pill';
import { money, toneClass, balanceLabel } from '../format';
import * as router from '../router';
import type { Screen } from '../router';
import { saveBackupCopy } from '../backup';

type Sort = 'recent' | 'due' | 'oldest';

/** Survives navigation (back from a customer keeps the search), reset on a fresh app start. */
export const homeState = { q: '', sort: 'recent' as Sort, late: false };

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
      h('span', { class: `cust-bal amt ${toneClass(r.balance_paise)}`, text: r.balance_paise === 0 ? balanceLabel(0) : money(r.balance_paise) }),
      r.balance_paise < 0 ? h('span', { class: 'cust-days adv', text: t('bal.advance') }) : null,
      dt && r.balance_paise >= 0 ? h('span', { class: `cust-days${dt.late ? ' late' : ''}`, text: dt.text }) : null,
    ),
  );
}

export const homeScreen: Screen = async (root, route) => {
  const s = await refreshSettings();
  const [rows, totals, onboarded] = await Promise.all([app.repo.listHome(), app.repo.totals(), app.repo.getMeta('onboarded')]);
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
    h('div', { class: 'summary-sub', text: totals.customers_owing === 1 ? t('home.fromOne') : t('home.fromN', { n: totals.customers_owing }) }),
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
  const input = h('input', {
    class: 'input',
    attrs: { type: 'search', placeholder: t('home.search'), autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search', 'data-testid': 'search', value: homeState.q },
  });
  input.value = homeState.q;
  const chipRow = h('div', 'chips scroll');
  const list = h('div', { class: 'list', attrs: { 'data-testid': 'cust-list' } });
  const emptyEl = h('div', 'empty hidden');
  const keys = new Map(rows.map((r) => [r.id, searchKey(r)]));

  const paintChips = (): void => {
    clear(chipRow);
    const chip = (label: string, on: boolean, fn: () => void): HTMLElement =>
      h('button', { class: `chip${on ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': on ? 'true' : 'false' }, on: { click: fn } }, label);
    chipRow.append(
      chip(t('home.sortRecent'), homeState.sort === 'recent', () => { homeState.sort = 'recent'; paint(); }),
      chip(t('home.sortDue'), homeState.sort === 'due', () => { homeState.sort = 'due'; paint(); }),
      chip(t('home.sortOldest'), homeState.sort === 'oldest', () => { homeState.sort = 'oldest'; paint(); }),
      chip(t('home.filter30'), homeState.late, () => { homeState.late = !homeState.late; paint(); }),
    );
  };

  const paint = (): void => {
    paintChips();
    clear(list);
    const q = homeState.q.trim();
    let shown = rows.filter((r) => matchesQuery(keys.get(r.id) ?? '', q));
    if (homeState.late) shown = shown.filter((r) => r.balance_paise > 0 && (r.days_since ?? 0) >= 30);
    shown = sortRows(shown, homeState.sort);
    const frag = document.createDocumentFragment();
    if (q && !rows.some((r) => normName(r.name) === normName(q))) {
      frag.appendChild(
        h(
          'button',
          { class: 'cust-row add-row', attrs: { type: 'button', 'data-testid': 'add-as-new' }, on: { click: () => void router.go('customer-edit', { name: q }) } },
          icon('plus'),
          h('span', { class: 'cust-main', text: t('home.addAs', { q }) }),
        ),
      );
    }
    for (const r of shown) frag.appendChild(customerRow(r, s.paired));
    list.appendChild(frag);
    list.classList.toggle('hidden', !list.firstChild);
    emptyEl.classList.toggle('hidden', shown.length > 0);
    emptyEl.textContent = rows.length === 0 ? t('home.empty') : homeState.late && !q ? t('home.none30') : t('home.noMatch', { q });
    if (shown.length === 0 && q && list.firstChild) emptyEl.classList.add('hidden');
  };

  input.addEventListener('input', () => {
    homeState.q = input.value;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void app.platform.hideKeyboard();
  });

  add(
    body,
    summary,
    banners,
    rows.length > 0 || homeState.q ? h('div', 'search-wrap', icon('search'), input) : null,
    rows.length > 0 ? chipRow : null,
    list,
    emptyEl,
  );
  paint();

  // ---- bottom bar
  const bar = h(
    'nav',
    'bottom-bar',
    h('button', { class: 'nav-btn', attrs: { type: 'button', 'data-testid': 'nav-daybook' }, on: { click: () => void router.go('daybook') } }, icon('book'), t('home.dayBook')),
    h(
      'button',
      { class: 'nav-add', attrs: { type: 'button', 'data-testid': 'add-customer' }, on: { click: () => void router.go('customer-edit', homeState.q.trim() ? { name: homeState.q.trim() } : {}) } },
      icon('plus'),
      t('home.addCustomer'),
    ),
    h('button', { class: 'nav-btn', attrs: { type: 'button', 'data-testid': 'nav-settings' }, on: { click: () => void router.go('settings') } }, icon('gear'), t('home.settings')),
  );
  root.appendChild(bar);
  return () => pill.dispose();
};
