/**
 * Home's "Sync" button (top right): one tap sends this phone's waiting entries and fetches the other phones' entries
 * at once (syncNow: no waiting for the next 20-s poll, no retry backoff, tried even when Android says offline). It
 * cannot make another phone fetch: that phone gets the entry on its own next poll (within 20 s while open), when a
 * customer's page opens there, or when someone taps Sync on it. Hidden while this phone is not connected to a shop
 * server (one-phone shops never see it). The result is a toast; the pill on the left keeps the lasting status.
 */
import type { SyncStatus } from '../../sync/types';
import { t } from '../../i18n';
import { app } from '../app';
import { errorText } from '../errors';
import { h, icon } from './dom';
import { toast } from './overlay';

/** The toast after a manual sync: what happened, in one sentence. `pulled` = rows that came from other phones. */
export function syncResultText(s: SyncStatus, pulled: number): { text: string; error: boolean } {
  switch (s.phase) {
    case 'idle':
      if (s.pending > 0) return { text: t('sync.pending', { n: s.pending }), error: false };
      if (pulled === 1) return { text: t('sync.doneOne'), error: false };
      return { text: pulled > 0 ? t('sync.doneNew', { n: pulled }) : t('sync.doneNone'), error: false };
    case 'offline':
      return { text: t('sync.offlineToast'), error: true };
    case 'revoked':
      return { text: t('sync.revoked'), error: true };
    case 'unpaired':
      return { text: t('sync.unpaired'), error: false };
    default:
      return { text: s.error ? errorText({ code: s.error }) : t('sync.error'), error: true };
  }
}

/** Returns the button and an unsubscribe function. */
export function syncButton(): { el: HTMLButtonElement; dispose: () => void } {
  const label = h('span', { text: t('sync.btn') });
  const el = h(
    'button',
    { class: 'sync-btn', attrs: { type: 'button', 'data-testid': 'home-sync', 'aria-label': t('sync.btnHelp'), title: t('sync.btnHelp') } },
    icon('sync', 'ic-sm'),
    label,
  );
  let busy = false;
  el.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    el.disabled = true;
    el.classList.add('spinning');
    label.textContent = t('sync.btnBusy');
    let pulled = 0;
    const off = app.sync.onRemoteChange((n) => {
      pulled += n;
    });
    void app.sync
      .syncNow()
      .then((s) => {
        const r = syncResultText(s, pulled);
        toast(r.text, { error: r.error, ms: r.error ? 5_000 : 3_000 });
      })
      .finally(() => {
        off();
        busy = false;
        el.disabled = false;
        el.classList.remove('spinning');
        label.textContent = t('sync.btn');
      });
  });
  const show = (s: SyncStatus): void => {
    el.classList.toggle('hidden', s.phase === 'unpaired' || s.phase === 'revoked');
  };
  let status: SyncStatus;
  try {
    status = app.sync.status();
  } catch {
    status = { phase: 'unpaired', pending: 0, last_sync_at: null, error: null, clock_skew_ms: 0, rejected: 0 };
  }
  show(status);
  const dispose = app.sync.subscribe(show);
  return { el, dispose };
}
