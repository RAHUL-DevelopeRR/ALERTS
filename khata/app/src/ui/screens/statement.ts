/** Statement: period chips, Tamil/English message toggle, preview, WhatsApp / SMS / Share / Copy. */
import { addDays, normalizePhone, smsLink, smsSegments, whatsappLink } from '../../core/ledger';
import type { Lang } from '../../data/types';
import { getLang, t } from '../../i18n';
import { app, refreshSettings } from '../app';
import { add, button, h, icon } from '../components/dom';
import { promptDialog, toast } from '../components/overlay';
import { shell } from '../components/shell';
import { errorText } from '../errors';
import { today } from '../format';
import * as router from '../router';
import type { Screen } from '../router';
import { smsText, statementText } from '../statement-text';

type Period = 'default' | 'last30' | 'all' | 'custom';

export const statementScreen: Screen = async (root, route) => {
  const s = await refreshSettings();
  const id = route.params.id;
  const todayStr = today(s.clock_offset_ms);
  const [c, def, entries] = await Promise.all([app.repo.getCustomer(id), app.repo.defaultStatementPeriod(id), app.repo.listEntries(id)]);
  if (!c) throw new Error('NOT_FOUND');
  const p = route.params;
  const period = (p.period as Period) || 'default';
  const lang: Lang = p.lang === 'en' || p.lang === 'ta' ? p.lang : getLang();
  let from = def.from;
  let to = def.to;
  if (period === 'last30') {
    from = addDays(todayStr, -29);
    to = todayStr;
  } else if (period === 'all') {
    from = entries.length ? entries[0].biz_date : todayStr;
    to = todayStr;
  } else if (period === 'custom') {
    from = p.from && p.from <= todayStr ? p.from : def.from;
    to = p.to && p.to <= todayStr ? p.to : todayStr;
    if (from > to) [from, to] = [to, from];
  }
  const st = await app.repo.statement(id, from, to);
  const balance = entries.length ? entries[entries.length - 1].running_paise : 0;
  const opts = { shopName: s.shop_name, upiId: s.upi_id, lang, asOf: todayStr };
  const text = statementText(st, opts);
  const sms = smsText(c, balance, opts);

  const { body } = shell(root, { title: t('st.title'), sub: c.name, back: true });
  const set = (patch: Record<string, string>): void => {
    Object.assign(route.params, patch);
    void router.rerender();
  };
  const chip = (label: string, key: Period): HTMLElement =>
    h('button', { class: `chip${period === key ? ' on' : ''}`, attrs: { type: 'button', 'data-testid': `period-${key}` }, text: label, on: { click: () => set({ period: key }) } });
  const chips = h(
    'div',
    'chips',
    chip(def.kind === 'settled' ? t('st.settled') : t('st.sinceZero'), 'default'),
    chip(t('st.last30'), 'last30'),
    chip(t('st.all'), 'all'),
    chip(t('st.custom'), 'custom'),
  );
  let custom: HTMLElement | null = null;
  if (period === 'custom') {
    const fromIn = h('input', { class: 'input', attrs: { type: 'date', max: todayStr, value: from } });
    const toIn = h('input', { class: 'input', attrs: { type: 'date', max: todayStr, value: to } });
    fromIn.value = from;
    toIn.value = to;
    fromIn.addEventListener('change', () => fromIn.value && set({ from: fromIn.value, to: toIn.value }));
    toIn.addEventListener('change', () => toIn.value && set({ from: fromIn.value, to: toIn.value }));
    custom = h(
      'div',
      'custom-dates',
      h('label', 'field', h('span', { class: 'field-label', text: t('st.from') }), fromIn),
      h('label', 'field', h('span', { class: 'field-label', text: t('st.to') }), toIn),
    );
  }
  const langSeg = h(
    'div',
    'seg',
    h('button', { class: lang === 'ta' ? 'on' : '', attrs: { type: 'button', 'data-testid': 'st-lang-ta' }, text: 'தமிழ்', on: { click: () => set({ lang: 'ta' }) } }),
    h('button', { class: lang === 'en' ? 'on' : '', attrs: { type: 'button', 'data-testid': 'st-lang-en' }, text: 'English', on: { click: () => set({ lang: 'en' }) } }),
  );

  const open = async (uri: string): Promise<void> => {
    const ok = await app.platform.openExternal(uri);
    if (!ok) toast(t('st.noApp'), { error: true });
  };
  const sendOther = async (): Promise<void> => {
    const v = await promptDialog({
      title: t('st.otherNumber'),
      label: t('st.otherNumberPh'),
      inputmode: 'tel',
      placeholder: '98765 43210',
      valid: (x) => {
        try {
          return !!normalizePhone(x);
        } catch {
          return false;
        }
      },
    });
    if (!v) return;
    try {
      await open(whatsappLink(normalizePhone(v), text));
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const segs = smsSegments(sms).segments;
  const actions = h(
    'div',
    'share-grid',
    button([icon('chat'), t('st.whatsapp')], () => void open(whatsappLink(c.phone, text)), 'btn btn-got btn-big wide', { 'data-testid': 'st-whatsapp' }),
    c.phone ? button(t('st.otherNumber'), () => void sendOther(), 'btn wide', { 'data-testid': 'st-other' }) : null,
    button([icon('sms'), t('st.sms')], () => void open(smsLink(c.phone, sms)), 'btn btn-big', { 'data-testid': 'st-sms' }),
    button([icon('share'), t('st.share')], () => void app.platform.shareText(text, t('st.title')), 'btn btn-big', { 'data-testid': 'st-share' }),
    button([icon('copy'), t('st.copy')], () => {
      void app.platform.copyText(text).then(() => toast(t('common.copied')), (e) => toast(errorText(e), { error: true }));
    }, 'btn btn-big wide', { 'data-testid': 'st-copy' }),
  );
  add(
    body,
    chips,
    custom,
    h('div', { class: 'field-label', style: { margin: '10px 2px 6px' }, text: t('st.textLang') }),
    langSeg,
    h('div', { class: 'preview', attrs: { 'data-testid': 'st-preview', lang }, text: text }),
    actions,
    h('p', { class: 'muted', style: { fontSize: '14px', margin: '10px 4px' }, text: t('st.smsInfo', { n: segs }) }),
  );
};
