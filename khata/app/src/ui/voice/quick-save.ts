/**
 * Voice auto-save: when the shopkeeper clearly said a known customer, an amount and an entry word ("Ramu 100
 * kattinaan", "Ramukku 250 kuduthen", "Ramu debit 300"), the entry is shown on a small card and saved after a short
 * countdown. Cancel discards it, Edit opens the usual prefilled keypad, Save now skips the wait; after saving, the
 * toast offers Undo (a reversal, like every other undo).
 *
 * Only for the safest case (Settings → Voice entry → auto-save, default on): parser confidence 'high' (one clear
 * customer, an undisputed amount, an explicit direction word), today's date, below the "confirm above" amount, not a
 * repeat of an entry saved in the last minute, and not a payment larger than the due. Everything else goes to the
 * keypad exactly as before.
 */
import type { VoiceIntent } from '../../core/voice';
import { amountInWords, formatCode, formatINR } from '../../core/ledger';
import type { HomeRow } from '../../data/types';
import { getLang, t } from '../../i18n';
import { afterWrite, app, refreshSettings } from '../app';
import { button, h } from '../components/dom';
import { pushLayer, toast } from '../components/overlay';
import { errorText } from '../errors';
import * as router from '../router';
import { signedBal } from '../screens/customer';
import { bumpVoiceStats, voicePrefs } from './prefs';

/** Seconds the card waits before saving on its own. */
export const AUTO_SAVE_SECONDS = 3;

export type QuickSaveResult = 'saved' | 'edit' | 'cancel' | 'skip';

/** Pure eligibility check (unit-tested): may this intent be auto-saved? */
export function autoSaveEligible(
  intent: Pick<VoiceIntent, 'confidence' | 'kind' | 'amount_paise' | 'date_offset' | 'amount_alternatives'>,
  ctx: { autosave: boolean; confirmAbovePaise: number; balancePaise: number; recentDuplicate: boolean },
): boolean {
  if (!ctx.autosave) return false;
  if (intent.confidence !== 'high' || !intent.kind || !intent.amount_paise || intent.amount_paise <= 0) return false;
  if (intent.date_offset) return false;
  if (intent.amount_alternatives && intent.amount_alternatives.some((a) => a !== intent.amount_paise)) return false;
  if (intent.amount_paise >= ctx.confirmAbovePaise) return false;
  if (ctx.recentDuplicate) return false;
  if (intent.kind === 'RECEIVE' && ctx.balancePaise > 0 && intent.amount_paise > ctx.balancePaise) return false;
  return true;
}

/** Show the auto-save card if the intent qualifies; resolves with what happened. */
export async function quickSave(intent: VoiceIntent, customerId: string, row: HomeRow | undefined): Promise<QuickSaveResult> {
  const kind = intent.kind;
  const amount = intent.amount_paise;
  if (!kind || !amount) return 'skip';
  const settings = await refreshSettings();
  const balance = row ? row.balance_paise : await app.repo.balance(customerId);
  const dup = await app.repo.recentDuplicate(customerId, kind, amount);
  if (!autoSaveEligible(intent, { autosave: voicePrefs().autosave, confirmAbovePaise: settings.confirm_above_paise, balancePaise: balance, recentDuplicate: dup })) return 'skip';

  const customer = row ?? (await app.repo.getCustomer(customerId));
  const name = customer?.name ?? '';
  const after = balance + (kind === 'GIVE' ? amount : -amount);
  const kindLabel = kind === 'GIVE' ? t('det.gave') : t('det.got');
  const kindSub = kind === 'GIVE' ? t('det.gaveSub') : t('det.gotSub');

  return new Promise<QuickSaveResult>((resolve) => {
    let left = AUTO_SAVE_SECONDS;
    let done = false;
    const countdown = h('div', { class: 'qs-countdown', attrs: { 'data-testid': 'qs-countdown' }, text: t('voice.autoSaving', { n: left }) });
    const bar = h('div', 'qs-bar', h('div', { class: 'qs-bar-fill', style: { animationDuration: `${AUTO_SAVE_SECONDS}s` } }));
    const finish = (r: QuickSaveResult): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      remove();
      resolve(r);
    };
    const save = async (): Promise<void> => {
      if (done) return;
      done = true;
      clearInterval(timer);
      remove();
      try {
        const res = await app.repo.addEntry({
          customer_id: customerId,
          kind,
          amount_paise: amount,
          note: intent.note,
          mode: kind === 'RECEIVE' ? (intent.mode ?? 'CASH') : null,
        });
        afterWrite();
        void app.platform.hapticTap();
        void bumpVoiceStats({ saved: 1 });
        const cur = router.current();
        if (!(cur?.name === 'customer' && cur.params.id === customerId)) await router.go('customer', { id: customerId });
        else void router.rerender();
        const bal = signedBal(res.balance_paise);
        const msg = kind === 'GIVE' ? t('entry.addedGave', { amount: formatINR(amount), bal }) : t('entry.addedGot', { amount: formatINR(amount), bal });
        toast(`${name}: ${msg}`, {
          ms: 8000,
          action: {
            label: t('common.undo'),
            run: () => {
              void (async () => {
                try {
                  const u = await app.repo.reverseEntry(res.entry.id, null);
                  afterWrite();
                  toast(t('entry.undone', { bal: signedBal(u.balance_paise) }));
                  void router.rerender();
                } catch (e) {
                  toast(errorText(e), { error: true });
                }
              })();
            },
          },
        });
        resolve('saved');
      } catch (e) {
        toast(errorText(e), { error: true });
        resolve('edit');
      }
    };

    const panel = h(
      'div',
      { class: `voice-panel qs-card qs-${kind === 'GIVE' ? 'gave' : 'got'}`, attrs: { role: 'dialog', 'aria-modal': 'true', 'data-testid': 'qs-card' } },
      h('div', { class: 'qs-heard', text: t('voice.heard', { text: intent.heard }) }),
      h('div', 'qs-who', h('b', { text: name }), customer ? h('span', { class: 'muted', text: ` · ${formatCode(customer.code)}` }) : null),
      h('div', 'qs-kind', h('span', { class: 'qs-kind-label', attrs: { 'data-testid': 'qs-kind' }, text: kindLabel }), h('span', { class: 'qs-kind-sub', text: ` · ${kindSub}` })),
      h('div', { class: 'qs-amount', attrs: { 'data-testid': 'qs-amount' }, text: formatINR(amount) }),
      h('div', { class: 'qs-words muted', text: amountInWords(amount, getLang()) }),
      intent.note ? h('div', { class: 'qs-note', text: intent.note }) : null,
      h('div', { class: 'qs-bal', text: `${signedBal(balance)} → ${signedBal(after)}` }),
      countdown,
      bar,
      h(
        'div',
        'voice-actions qs-actions',
        button(t('common.cancel'), () => {
          void bumpVoiceStats({ cancelled: 1 });
          finish('cancel');
        }, 'btn', { 'data-testid': 'qs-cancel' }),
        button(t('voice.autoEdit'), () => finish('edit'), 'btn', { 'data-testid': 'qs-edit' }),
        button(t('voice.autoSaveNow'), () => void save(), `btn ${kind === 'GIVE' ? 'btn-gave' : 'btn-got'}`, { 'data-testid': 'qs-save' }),
      ),
    );
    const scrim = h('div', { class: 'scrim scrim-sheet voice-scrim' }, panel);
    const remove = pushLayer(scrim, () => finish('cancel'));
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) void save();
      else countdown.textContent = t('voice.autoSaving', { n: left });
    }, 1000);
  });
}
