/**
 * Settings → Voice entry: on/off, spoken language, hold-to-talk or tap-to-talk, what a bare "Ramu 100 kuduthaachu"
 * means in this shop, a
 * "Try voice" tester (shows how a sentence is understood, saves nothing), the local accuracy counters and the
 * privacy line (audio goes to Google). settings.ts inserts the result with one call.
 */
import './voice.css';
import { formatINR } from '../../core/ledger';
import { parseUtterance, type VoiceIntent } from '../../core/voice';
import { getLang, t } from '../../i18n';
import { SPEECH_PRIVACY_NOTE } from '../../platform/index';
import type { SpeechLang } from '../../platform/types';
import { app } from '../app';
import { button, clear, h, type Child } from '../components/dom';
import { toast } from '../components/overlay';
import { errorText } from '../errors';
import * as router from '../router';
import { micIcon } from './icons';
import { voicePreflight } from './listen';
import { planIntent, speechErrorKey, toVoiceCustomers } from './plan';
import { loadVoicePrefs, loadVoiceStats, resetVoiceStats, saveVoicePrefs, type VoicePrefs, type VoiceStats } from './prefs';

function block(...children: Child[]): HTMLElement {
  return h('div', 'set-block', children);
}

function onOffSeg(p: VoicePrefs): HTMLElement {
  const pick = (on: boolean): void => {
    if (on === p.on) return;
    void saveVoicePrefs({ on }).then(() => router.rerender(), (e) => toast(errorText(e), { error: true }));
  };
  return h(
    'div',
    'seg',
    h('button', { class: p.on ? 'on' : '', attrs: { type: 'button', 'aria-pressed': p.on ? 'true' : 'false', 'data-testid': 'voice-on' }, text: t('voice.on'), on: { click: () => pick(true) } }),
    h('button', { class: p.on ? '' : 'on', attrs: { type: 'button', 'aria-pressed': p.on ? 'false' : 'true', 'data-testid': 'voice-off' }, text: t('voice.off'), on: { click: () => pick(false) } }),
  );
}

function langSeg(p: VoicePrefs): HTMLElement {
  const pick = (lang: SpeechLang): void => {
    if (lang === p.lang) return;
    void saveVoicePrefs({ lang }).then(() => router.rerender(), (e) => toast(errorText(e), { error: true }));
  };
  return h(
    'div',
    'seg',
    h('button', { class: p.lang === 'ta-IN' ? 'on' : '', attrs: { type: 'button', lang: 'ta', 'aria-pressed': p.lang === 'ta-IN' ? 'true' : 'false', 'data-testid': 'voice-lang-ta' }, text: t('voice.langTa'), on: { click: () => pick('ta-IN') } }),
    h('button', { class: p.lang === 'en-IN' ? 'on' : '', attrs: { type: 'button', lang: 'en', 'aria-pressed': p.lang === 'en-IN' ? 'true' : 'false', 'data-testid': 'voice-lang-en' }, text: t('voice.langEn'), on: { click: () => pick('en-IN') } }),
  );
}

function bareChoice(p: VoicePrefs): HTMLElement[] {
  const pick = (bare: 'RECEIVE' | 'GIVE'): void => {
    if (bare === p.bare) return;
    void saveVoicePrefs({ bare }).then(() => router.rerender(), (e) => toast(errorText(e), { error: true }));
  };
  const choice = (bare: 'RECEIVE' | 'GIVE', label: string, sub: string): HTMLElement =>
    h(
      'button',
      { class: `voice-choice${p.bare === bare ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': p.bare === bare ? 'true' : 'false', 'data-testid': `voice-bare-${bare}` }, on: { click: () => pick(bare) } },
      h('span', { class: bare === 'GIVE' ? 'owes' : 'adv', text: label }),
      h('span', { class: 'sub', text: sub }),
    );
  return [
    choice('RECEIVE', t('voice.bareReceive'), t('voice.bareReceiveSub')),
    choice('GIVE', t('voice.bareGive'), t('voice.bareGiveSub')),
  ];
}

function autoChoice(p: VoicePrefs): HTMLElement[] {
  const pick = (autosave: boolean): void => {
    if (autosave === p.autosave) return;
    void saveVoicePrefs({ autosave }).then(() => router.rerender(), (e) => toast(errorText(e), { error: true }));
  };
  const choice = (on: boolean, label: string, sub: string): HTMLElement =>
    h(
      'button',
      { class: `voice-choice${p.autosave === on ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': p.autosave === on ? 'true' : 'false', 'data-testid': on ? 'voice-auto-on' : 'voice-auto-off' }, on: { click: () => pick(on) } },
      h('span', { text: label }),
      h('span', { class: 'sub', text: sub }),
    );
  return [choice(true, t('voice.autoOn'), t('voice.autoOnSub')), choice(false, t('voice.autoOff'), t('voice.autoOffSub'))];
}

function holdChoice(p: VoicePrefs): HTMLElement[] {
  const pick = (hold: boolean): void => {
    if (hold === p.hold) return;
    void saveVoicePrefs({ hold }).then(() => router.rerender(), (e) => toast(errorText(e), { error: true }));
  };
  const choice = (hold: boolean, label: string, sub: string): HTMLElement =>
    h(
      'button',
      { class: `voice-choice${p.hold === hold ? ' on' : ''}`, attrs: { type: 'button', 'aria-pressed': p.hold === hold ? 'true' : 'false', 'data-testid': hold ? 'voice-hold-on' : 'voice-hold-off' }, on: { click: () => pick(hold) } },
      h('span', { text: label }),
      h('span', { class: 'sub', text: sub }),
    );
  return [
    choice(true, t('voice.holdOn'), t('voice.holdOnSub')),
    choice(false, t('voice.holdOff'), t('voice.holdOffSub')),
    h('p', { class: 'input-help', style: { marginTop: '8px' }, text: t('voice.holdHint') }),
  ];
}

/** "Customer: Ramu · Amount: ₹100 · Direction: Credit · Confidence: high", one line per spoken entry. */
function describeIntents(intents: VoiceIntent[], names: Map<string, string>): HTMLElement {
  const out = h('div', { class: 'voice-result', attrs: { 'data-testid': 'voice-try-result' } });
  if (!intents.length) {
    out.textContent = t('voice.resNothing');
    return out;
  }
  intents.forEach((it, i) => {
    const plan = planIntent(it);
    let who: string;
    if (plan.type === 'entry' || (plan.type === 'balance' && plan.customerId)) who = names.get((plan as { customerId: string }).customerId) ?? '?';
    else if (plan.type === 'pick') who = t('voice.resSeveral', { n: it.matches.length });
    else if (plan.type === 'new') who = t('voice.resNew', { name: plan.name });
    else who = t('voice.resNone');
    const kind = it.kind === 'GIVE' ? h('span', { class: 'kind-gave', text: t('kind.GIVE') }) : it.kind === 'RECEIVE' ? h('span', { class: 'kind-got', text: t('kind.RECEIVE') }) : h('span', { text: t('voice.resUnclear') });
    const conf = it.confidence === 'high' ? t('voice.confHigh') : it.confidence === 'medium' ? t('voice.confMedium') : t('voice.confLow');
    out.append(
      h('div', null,
        intents.length > 1 ? h('b', { text: `${i + 1}. ` }) : null,
        h('div', { text: t('voice.heard', { text: it.heard }) }),
        h('div', { text: t('voice.resCustomer', { v: who }) }),
        h('div', { text: t('voice.resAmount', { v: it.amount_paise === null ? '—' : formatINR(it.amount_paise) + (it.amount_text && it.amount_text.replace(/[,\s]/g, '') !== String(it.amount_paise / 100) ? ` (${it.amount_text})` : '') }) }),
        h('div', null, t('voice.resKind', { v: '' }), kind),
        it.note ? h('div', { text: `${t('cust.note')}: ${it.note}` }) : null,
        h('div', { class: 'muted', text: t('voice.resConf', { v: conf }) }),
      ),
    );
  });
  return out;
}

function tryBlock(p: VoicePrefs): HTMLElement {
  const input = h('input', { class: 'input', attrs: { type: 'text', maxlength: 200, autocomplete: 'off', placeholder: t('voice.tryPh'), 'data-testid': 'voice-try-input' } });
  const resultHost = h('div', null);
  const show = async (alts: string[]): Promise<void> => {
    const rows = await app.repo.listHome();
    const customers = toVoiceCustomers(rows);
    const names = new Map(rows.map((r) => [r.id, r.name]));
    const intents = parseUtterance(alts, customers, { bareKuduthaachu: p.bare });
    clear(resultHost);
    resultHost.appendChild(describeIntents(intents, names));
  };
  const parseBtn = button(t('voice.tryParse'), () => {
    const text = input.value.trim();
    if (!text) return;
    void show([text]).catch((e) => toast(errorText(e), { error: true }));
  }, 'btn btn-primary', { 'data-testid': 'voice-try-parse' });
  parseBtn.style.marginLeft = '8px';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') parseBtn.click();
  });
  const micBtn = h('button', { class: 'mic-btn', attrs: { type: 'button', 'aria-label': t('voice.mic'), 'data-testid': 'voice-try-mic' } }, micIcon());
  micBtn.addEventListener('click', () => {
    void (async () => {
      const speech = app.platform.speech;
      micBtn.disabled = true;
      try {
        // Same gate as the mic buttons: recogniser, internet, the one-time Google notice, mic permission.
        if (!(await voicePreflight())) return;
        input.value = '';
        input.placeholder = t('voice.listening');
        const alts = await speech.listen({ lang: p.lang, onPartial: (text) => { input.value = text; }, maxAlternatives: 5, maxMs: 12_000 });
        if (!alts.length) {
          toast(t('voice.nothing'), { error: true });
          return;
        }
        input.value = alts[0];
        await show(alts);
      } catch (e) {
        const key = speechErrorKey(String((e as Error)?.message ?? e));
        toast(t(`voice.${key}`), { error: true, ms: 5000 });
      } finally {
        input.placeholder = t('voice.tryPh');
        micBtn.disabled = false;
      }
    })();
  });
  return h('div', null, h('p', { class: 'input-help', style: { marginBottom: '8px' }, text: t('voice.tryHelp') }), h('div', 'voice-try-row', input, parseBtn, micBtn), resultHost);
}

function statsBlock(st: VoiceStats): HTMLElement {
  const stat = (label: string, v: number, testid: string): HTMLElement => h('div', { class: 'voice-stat', attrs: { 'data-testid': testid } }, h('span', { class: 'v num', text: String(v) }), h('span', { class: 'l', text: label }));
  const reset = button(t('voice.statReset'), () => {
    void resetVoiceStats().then(() => router.rerender(), (e) => toast(errorText(e), { error: true }));
  }, 'btn btn-block', { 'data-testid': 'voice-stats-reset' });
  return h(
    'div',
    null,
    h('span', { class: 'field-label', text: t('voice.stats') }),
    h(
      'div',
      { class: 'voice-stats', attrs: { 'data-testid': 'voice-stats' } },
      stat(t('voice.statHeard'), st.heard, 'voice-stat-heard'),
      stat(t('voice.statSaved'), st.saved, 'voice-stat-saved'),
      stat(t('voice.statAmount'), st.amount_edited, 'voice-stat-amount'),
      stat(t('voice.statKind'), st.kind_changed, 'voice-stat-kind'),
      stat(t('voice.statCancel'), st.cancelled, 'voice-stat-cancelled'),
    ),
    reset,
  );
}

/** The whole "Voice entry" section (a <section> like the others in settings.ts). */
export async function voiceSettingsSection(): Promise<HTMLElement> {
  const [p, st] = await Promise.all([loadVoicePrefs(), loadVoiceStats()]);
  return h(
    'section',
    { attrs: { id: 'sec-voice', 'data-testid': 'sec-voice' } },
    h('h2', { class: 'section-title', text: t('voice.section') }),
    h(
      'div',
      'list',
      block(onOffSeg(p), h('p', { class: 'input-help', text: t('voice.onHelp') })),
      p.on
        ? [
            block(h('span', { class: 'field-label', text: t('voice.lang') }), langSeg(p)),
            block(h('span', { class: 'field-label', text: t('voice.holdQ') }), holdChoice(p)),
            block(h('span', { class: 'field-label', text: t('voice.autoQ') }), autoChoice(p)),
            block(h('span', { class: 'field-label', text: t('voice.bareQ') }), bareChoice(p)),
            block(h('span', { class: 'field-label', text: t('voice.try') }), tryBlock(p)),
            block(statsBlock(st)),
          ]
        : null,
      block(h('span', { class: 'field-label', text: t('voice.privacyTitle') }), h('p', { class: 'input-help', style: { fontSize: '15px', margin: '0' }, text: SPEECH_PRIVACY_NOTE[getLang()] })),
    ),
  );
}
