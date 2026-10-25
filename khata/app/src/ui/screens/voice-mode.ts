/**
 * Voice mode screen (Home → Voice mode): the phone lies on the counter and keeps listening; each spoken entry
 * shows as an approval card (customer, Debit/Credit, amount, balance before → after) with Approve, Edit (the
 * keypad, then back here) and Skip; approved entries collect in "This session" with Undo. Pause / Resume and Stop
 * at the bottom; the big microphone is Pause / Resume too. The session itself (loop, card, log) lives in
 * ../voice/mode.ts so it survives the keypad opening over this screen.
 */
import '../voice/voice.css';
import { amountInWords, formatCode, formatINR } from '../../core/ledger';
import { getLang, t } from '../../i18n';
import { refreshSettings } from '../app';
import { button, clear, h } from '../components/dom';
import { dialog, toast } from '../components/overlay';
import { shell, showFooter } from '../components/shell';
import { errorText } from '../errors';
import { money, toneClass } from '../format';
import * as router from '../router';
import type { Screen } from '../router';
import { signedBal } from './customer';
import { rowDetail } from './home';
import { micIcon } from '../voice/icons';
import { voicePreflight } from '../voice/listen';
import {
  approveCard, beginEdit, cardCustomerName, customerRow, modeState, pauseMode, resumeMode, screenShown, setCardAmount,
  setCardChoice, setCardKind, skipCard, startMode, stopMode, subscribeMode, undoLogged, type ApproveCheck, type ModeCard,
  type ModeLogItem, type ModeNote, type ModeState,
} from '../voice/mode';
import { loadVoicePrefs, saveVoicePrefs } from '../voice/prefs';
import type { MsgKey } from '../../i18n';

const kindText = (k: 'GIVE' | 'RECEIVE'): string => (k === 'GIVE' ? t('det.gave') : t('det.got'));

/** "Debit ₹865", "Credit ₹250": only the sides that have something. */
function totalParts(tot: { gave: number; got: number }): string[] {
  const parts: string[] = [];
  if (tot.gave) parts.push(`${kindText('GIVE')} ${formatINR(tot.gave)}`);
  if (tot.got) parts.push(`${kindText('RECEIVE')} ${formatINR(tot.got)}`);
  return parts;
}

/**
 * Home's "Voice mode" button: voice on, the usual voice preflight (recogniser, internet, the Google notice, mic
 * permission), voice mode's own one-time notice, then the screen. Never throws.
 */
export async function openVoiceMode(): Promise<void> {
  try {
    const p = await loadVoicePrefs();
    if (!p.on) await saveVoicePrefs({ on: true });
    if (!(await voicePreflight())) return;
    if (!p.mode_notice_ok) {
      const idle = p.mode_idle === 60 ? t('vm.idle60') : p.mode_idle === 15 ? t('vm.idle15') : '';
      const ok = await dialog<boolean>({
        title: t('vm.noticeTitle'),
        body: h('p', { class: 'pre', attrs: { 'data-testid': 'vm-notice' }, text: `${t('vm.noticeBody')}\n${idle ? t('vm.noticeIdle', { idle }) : t('vm.noticeNoIdle')}` }),
        buttons: [
          { label: t('common.cancel'), value: false },
          { label: t('vm.noticeOk'), value: true, kind: 'primary' },
        ],
        dismissValue: false,
      });
      if (!ok) return;
      await saveVoicePrefs({ mode_notice_ok: true });
    }
    await router.go('voice-mode');
  } catch (e) {
    toast(errorText(e), { error: true });
  }
}

function confirmCheck(chk: ApproveCheck): Promise<boolean> {
  if (chk.type === 'big') {
    return dialog<boolean>({
      title: t('entry.bigConfirm', { amount: formatINR(chk.amount_paise) }),
      body: h('p', { class: 'muted', text: amountInWords(chk.amount_paise, getLang()) }),
      buttons: [
        { label: t('common.no'), value: false },
        { label: t('common.yes'), value: true, kind: chk.kind === 'GIVE' ? 'gave' : 'got' },
      ],
      dismissValue: false,
    });
  }
  if (chk.type === 'advance') {
    return dialog<boolean>({
      body: h('p', { text: t('entry.advanceConfirm', { due: formatINR(chk.due_paise), adv: formatINR(chk.amount_paise - chk.due_paise) }) }),
      buttons: [
        { label: t('common.no'), value: false },
        { label: t('common.yes'), value: true, kind: 'got' },
      ],
      dismissValue: false,
    });
  }
  return dialog<boolean>({
    body: h('p', { text: t('entry.dupConfirm', { amount: formatINR(chk.amount_paise) }) }),
    buttons: [
      { label: t('common.cancel'), value: false },
      { label: t('entry.saveAgain'), value: true, kind: 'primary' },
    ],
    dismissValue: false,
  });
}

function noteText(n: ModeNote): string {
  switch (n.type) {
    case 'ignored': {
      const key: MsgKey = n.why === 'noAmount' ? 'vm.ignoredNoAmount' : n.why === 'noName' ? 'vm.ignoredNoName' : n.why === 'negated' ? 'vm.ignoredNegated' : n.why === 'unsure' ? 'vm.ignoredUnsure' : 'vm.ignoredNoise';
      return t(key, { text: n.heard });
    }
    case 'saved':
      return t('vm.saved', { name: n.name, kind: kindText(n.kind), amount: formatINR(n.amount_paise), bal: signedBal(n.balance_paise) });
    case 'undone':
      return t('vm.undone', { name: n.name, bal: signedBal(n.balance_paise) });
    case 'balance':
      return t('vm.balance', { name: n.name, bal: signedBal(n.balance_paise) });
    case 'error':
      return n.text;
  }
}

function failText(key: string | null): string {
  if (key === 'unavailable') return t('voice.unavailable');
  if (key === 'denied') return t('voice.denied');
  if (key === 'offline') return t('voice.offline');
  return t('voice.busy');
}

export const voiceModeScreen: Screen = async (root) => {
  await refreshSettings();
  root.classList.add('voice-mode');
  const { body, footer } = shell(root, { title: t('vm.title'), back: true, bodyClass: 'vm-body' });

  // ---- status: big mic (Pause / Resume), state, live words, the "say" hint, what just happened
  const orb = h('button', { class: 'vm-orb', attrs: { type: 'button', 'data-testid': 'vm-orb' } }, micIcon());
  const stateEl = h('div', { class: 'vm-state', attrs: { 'data-testid': 'vm-state' } });
  const liveEl = h('div', { class: 'vm-live', attrs: { 'data-testid': 'vm-live' } });
  const hintEl = h('div', { class: 'vm-hint' }, t('vm.say'), h('br'), h('b', { text: t('vm.example') }));
  const noteEl = h('div', { class: 'vm-note hidden', attrs: { 'data-testid': 'vm-note' } });
  const status = h('section', { class: 'vm-status', attrs: { 'data-testid': 'vm-status' } }, orb, stateEl, liveEl, hintEl, noteEl);
  const cardHost = h('div', { attrs: { 'data-testid': 'vm-card-host' } });
  const logHost = h('section', { class: 'vm-log', attrs: { 'data-testid': 'vm-log' } });
  body.append(status, cardHost, logHost);

  const pauseBtn = button('', () => {
    const s = modeState();
    if (s.pause) resumeMode();
    else pauseMode('user');
  }, 'btn btn-big', { 'data-testid': 'vm-pause' });
  const stopBtn = button(t('vm.stop'), () => router.back(), 'btn btn-big btn-danger', { 'data-testid': 'vm-stop' });
  showFooter(footer, h('div', 'footer-row', pauseBtn, stopBtn));
  orb.addEventListener('click', () => pauseBtn.click());

  // ---- the approval card
  const approve = async (): Promise<void> => {
    try {
      await approveCard(confirmCheck);
    } catch (e) {
      toast(errorText(e), { error: true });
    }
  };
  const edit = (): void => {
    const r = beginEdit();
    if (r) void router.go(r.name, r.params, r.state);
  };

  const pickRow = (id: string, score: number | null, chosen: boolean): HTMLElement | null => {
    const r = customerRow(id);
    if (!r) return null;
    return h(
      'button',
      { class: `vm-pick${chosen ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': chosen ? 'true' : 'false', 'data-testid': 'vm-pick', 'data-id': id }, on: { click: () => setCardChoice(id) } },
      h('span', 'vm-pick-main', h('span', { class: 'vm-pick-name', text: r.name }), h('span', { class: 'sub', text: rowDetail(r) })),
      h('span', { class: `vm-pick-bal amt ${toneClass(r.balance_paise)}`, text: r.balance_paise === 0 ? money(0) : signedBal(r.balance_paise) }),
      score !== null && score < 0.95 ? h('span', { class: 'vm-pick-score', text: `${Math.round(score * 100)}%` }) : null,
    );
  };

  const cardEl = (c: ModeCard, queued: number): HTMLElement => {
    const it = c.intent;
    const tone = c.kind === 'GIVE' ? 'gave' : c.kind === 'RECEIVE' ? 'got' : 'none';
    const el = h('section', { class: `vm-card ${tone}${c.busy ? ' busy' : ''}`, attrs: { 'data-testid': 'vm-card', role: 'group' } });
    el.appendChild(h('div', { class: 'vm-heard', attrs: { 'data-testid': 'vm-heard' }, text: t('voice.heard', { text: it.heard }) }));

    // who
    const who = h('div', 'vm-who');
    const ch = c.who.choice;
    if (ch === 'new') {
      who.append(
        h('div', 'vm-who-main', h('span', { class: 'badge badge-warn', text: t('vm.newCustomer') }), h('b', { class: 'vm-name', attrs: { 'data-testid': 'vm-name' }, text: c.who.newName ?? '' })),
      );
      if (c.who.candidates.length) {
        who.append(h('div', { class: 'vm-sub-label', text: t('voice.didYouMean') }));
        for (const m of c.who.candidates) {
          const row = pickRow(m.id, m.score, false);
          if (row) who.append(row);
        }
      }
    } else if (ch !== null && c.who.candidates.length <= 1) {
      const r = customerRow(ch);
      who.append(
        h(
          'div',
          'vm-who-main',
          h('b', { class: 'vm-name', attrs: { 'data-testid': 'vm-name' }, text: r?.name ?? '' }),
          r ? h('span', { class: 'sub', text: ` · ${formatCode(r.code)}${r.note ? ` · ${r.note}` : ''}` }) : null,
        ),
      );
      if (c.who.newName) who.append(h('button', { class: 'link vm-add-new', attrs: { type: 'button', 'data-testid': 'vm-add-new' }, text: t('vm.addAsNew', { name: c.who.newName }), on: { click: () => setCardChoice('new') } }));
    } else {
      who.append(h('div', { class: 'vm-sub-label', text: t('voice.pickTitle') }));
      for (const m of c.who.candidates) {
        const row = pickRow(m.id, m.score, m.id === ch);
        if (row) who.append(row);
      }
      if (c.who.newName) who.append(h('button', { class: 'link vm-add-new', attrs: { type: 'button', 'data-testid': 'vm-add-new' }, text: t('vm.addAsNew', { name: c.who.newName }), on: { click: () => setCardChoice('new') } }));
    }
    el.appendChild(who);

    // amount (+ what other alternatives heard)
    el.appendChild(h('div', { class: 'vm-amount', attrs: { 'data-testid': 'vm-amount' }, text: formatINR(c.amount_paise) }));
    el.appendChild(h('div', { class: 'vm-words muted', text: amountInWords(c.amount_paise, getLang()) }));
    if (c.alternatives.length) {
      el.appendChild(
        h(
          'div',
          'chips vm-alts',
          h('span', { class: 'vm-sub-label', text: t('vm.orAmount') }),
          c.alternatives.map((a) => h('button', { class: 'chip', attrs: { type: 'button', 'data-testid': 'vm-alt' }, text: formatINR(a), on: { click: () => setCardAmount(a) } })),
        ),
      );
    }

    // Debit / Credit
    const seg = h('div', 'seg vm-kind');
    for (const k of ['GIVE', 'RECEIVE'] as const) {
      seg.appendChild(
        h(
          'button',
          {
            class: c.kind === k ? (k === 'GIVE' ? 'on-gave' : 'on-got') : '',
            attrs: { type: 'button', 'aria-pressed': c.kind === k ? 'true' : 'false', 'data-testid': `vm-kind-${k}` },
            on: { click: () => setCardKind(k) },
          },
          h('span', { class: 'vm-kind-label', text: kindText(k) }),
          h('span', { class: 'vm-kind-sub', text: k === 'GIVE' ? t('det.gaveSub') : t('det.gotSub') }),
        ),
      );
    }
    el.appendChild(seg);

    // date, note, balance before -> after
    if (it.date_offset) el.appendChild(h('div', { class: 'vm-line', text: t('vm.date', { d: it.date_offset === -1 ? t('common.yesterday') : t('vm.dayBefore') }) }));
    if (it.note) el.appendChild(h('div', { class: 'vm-line', text: `${t('cust.note')}: ${it.note}` }));
    const r = ch && ch !== 'new' ? customerRow(ch) : null;
    const before = r ? r.balance_paise : ch === 'new' ? 0 : null;
    if (before !== null && c.kind) {
      const after = before + (c.kind === 'GIVE' ? c.amount_paise : -c.amount_paise);
      el.appendChild(h('div', { class: 'vm-bal', attrs: { 'data-testid': 'vm-bal' }, text: `${signedBal(before)} → ${signedBal(after)}` }));
    }
    if (queued > 0) el.appendChild(h('div', { class: 'vm-line muted', text: t('vm.queued', { n: queued }) }));

    // actions
    const name = cardCustomerName(c);
    const ready = ch !== null && c.kind !== null && !c.busy;
    const approveLabel = ch === null
      ? t('vm.approvePick')
      : c.kind === null
        ? t('vm.approveKind')
        : ch === 'new'
          ? t('vm.approveNew', { name: name ?? '' })
          : t('vm.approve', { kind: kindText(c.kind), amount: formatINR(c.amount_paise) });
    const approveBtn = button(approveLabel, () => void approve(), `btn btn-xl btn-block ${c.kind === 'GIVE' ? 'btn-gave' : c.kind === 'RECEIVE' ? 'btn-got' : 'btn-primary'}`, { 'data-testid': 'vm-approve' });
    approveBtn.disabled = !ready;
    const editBtn = button(t('vm.edit'), edit, 'btn', { 'data-testid': 'vm-edit' });
    editBtn.disabled = ch === null || c.busy;
    const skipBtn = button(t('vm.skip'), () => skipCard(), 'btn', { 'data-testid': 'vm-skip' });
    skipBtn.disabled = c.busy;
    el.append(h('div', 'vm-actions', skipBtn, editBtn), approveBtn);
    return el;
  };

  // ---- "This session"
  const logEl = (log: ModeLogItem[]): HTMLElement[] => {
    let n = 0;
    let gave = 0;
    let got = 0;
    for (const l of log) {
      if (l.undone) continue;
      n++;
      if (l.kind === 'GIVE') gave += l.amount_paise;
      else got += l.amount_paise;
    }
    const head = h(
      'div',
      'vm-log-head',
      h('span', { class: 'section-title', text: t('vm.session') }),
      log.length ? h('span', { class: 'vm-sum', attrs: { 'data-testid': 'vm-sum' }, text: [t('vm.sessionSum', { n }), ...totalParts({ gave, got })].join(' · ') }) : null,
    );
    if (!log.length) return [head, h('p', { class: 'muted vm-empty', text: t('vm.sessionEmpty') })];
    const list = h('div', 'list');
    for (const l of log) {
      const time = new Date(l.at).toLocaleTimeString(getLang() === 'ta' ? 'ta-IN' : 'en-IN', { hour: 'numeric', minute: '2-digit' });
      list.appendChild(
        h(
          'div',
          { class: `vm-log-item${l.undone ? ' undone' : ''}`, attrs: { 'data-testid': 'vm-log-item', 'data-id': l.entryId } },
          h(
            'span',
            'vm-log-main',
            h('b', { text: l.name }),
            h('span', { class: 'sub', text: `${time} · ${l.undone ? t('vm.undoneTag') : signedBal(l.balance_paise)}` }),
          ),
          h('span', { class: `vm-log-amt ${l.kind === 'GIVE' ? 'gave' : 'got'}`, text: `${kindText(l.kind)} ${formatINR(l.amount_paise)}` }),
          l.undone
            ? null
            : button(t('common.undo'), () => void undoLogged(l.entryId).catch((e) => toast(errorText(e), { error: true })), 'btn btn-ghost vm-undo', { 'data-testid': 'vm-undo' }),
        ),
      );
    }
    return [head, list];
  };

  let lastCard: ModeCard | null | undefined;
  let lastQueued = -1;
  let lastLog: ModeLogItem[] | undefined;
  const paint = (s: ModeState): void => {
    // status
    let stateText: string;
    let orbClass = 'vm-orb';
    if (s.card) {
      stateText = t('vm.cardWait');
      orbClass += ' card';
    } else if (s.pause) {
      stateText = s.pause === 'idle'
        ? t('vm.pausedIdle', { n: Math.max(1, Math.round(s.idleMin || 15)) })
        : s.pause === 'background'
          ? t('vm.pausedBackground')
          : s.pause === 'editing'
            ? t('vm.pausedEditing')
            : s.pause === 'failed'
              ? t('vm.pausedFailed', { msg: failText(s.failKey) })
              : t('vm.pausedUser');
      orbClass += ' paused';
    } else if (s.retrying) {
      stateText = s.retrying === 'offline' ? t('vm.retryOffline') : t('vm.retryBusy');
      orbClass += ' retry';
    } else {
      stateText = t('vm.listening');
      orbClass += ' listening';
    }
    stateEl.textContent = s.pause && !s.card ? `${t('vm.paused')}. ${stateText}` : stateText;
    orb.className = orbClass;
    orb.setAttribute('aria-label', s.pause ? t('vm.resume') : t('vm.pause'));
    const listening = s.active && !s.card && !s.pause;
    liveEl.textContent = listening ? s.live || '…' : '';
    liveEl.classList.toggle('hidden', !listening);
    liveEl.classList.toggle('placeholder', !s.live);
    hintEl.classList.toggle('hidden', !listening);
    if (s.note) {
      noteEl.textContent = noteText(s.note);
      noteEl.className = `vm-note ${s.note.type}`;
    } else noteEl.className = 'vm-note hidden';
    status.classList.toggle('compact', !!s.card);
    // footer
    pauseBtn.textContent = s.pause ? t('vm.resume') : t('vm.pause');
    pauseBtn.className = `btn btn-big ${s.pause ? 'btn-primary' : ''}`;
    pauseBtn.disabled = s.pause === 'editing';
    // card
    if (s.card !== lastCard || s.queued !== lastQueued) {
      lastCard = s.card;
      lastQueued = s.queued;
      clear(cardHost);
      if (s.card) cardHost.appendChild(cardEl(s.card, s.queued));
    }
    if (s.log !== lastLog) {
      lastLog = s.log;
      clear(logHost);
      logHost.append(...logEl(s.log));
    }
  };

  const unsub = subscribeMode(paint);
  if (!modeState().active) await startMode();
  paint(modeState());
  // Back here from the keypad / the customer form: a form left with Back reports nothing, so the card returns.
  const shown = setTimeout(screenShown, 0);

  return () => {
    clearTimeout(shown);
    unsub();
    const cur = router.current()?.name;
    if (cur === 'voice-mode') return; // re-rendered (language, PIN unlock): the session goes on
    if (modeState().pause === 'editing' && (cur === 'entry' || cur === 'customer-edit')) return; // Edit
    const tot = stopMode();
    toast(tot.n ? t('vm.summary', { n: tot.n, parts: totalParts(tot).join(', ') }) : t('vm.summaryNone'), { ms: 6000 });
  };
};
