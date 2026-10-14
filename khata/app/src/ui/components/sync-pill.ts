/** Sync status pill for the home header, live-subscribed to the sync engine. Tap opens Settings. */
import type { SyncStatus } from '../../sync/types';
import { t } from '../../i18n';
import { app } from '../app';
import * as router from '../router';
import { when } from '../format';
import { clear, h, icon, type IconName } from './dom';

export function pillContent(s: SyncStatus): { text: string; icon: IconName; tone: '' | 'warn' | 'bad' } {
  switch (s.phase) {
    case 'unpaired':
      return { text: t('sync.unpaired'), icon: 'phoneOnly', tone: '' };
    case 'syncing':
      return { text: t('sync.syncing'), icon: 'cloud', tone: '' };
    case 'offline':
      return { text: s.pending > 0 ? t('sync.offlinePending', { n: s.pending }) : t('sync.offline'), icon: 'cloudOff', tone: s.pending > 0 ? 'warn' : '' };
    case 'error':
      return { text: t('sync.error'), icon: 'warn', tone: 'bad' };
    case 'revoked':
      return { text: t('sync.revoked'), icon: 'warn', tone: 'bad' };
    case 'idle':
    default:
      if (s.pending > 0) return { text: t('sync.pending', { n: s.pending }), icon: 'cloud', tone: 'warn' };
      if (s.last_sync_at) return { text: t('sync.idle', { time: when(s.last_sync_at) }), icon: 'check', tone: '' };
      return { text: t('sync.idleNever'), icon: 'check', tone: '' };
  }
}

/** Returns the pill element and an unsubscribe function. */
export function syncPill(): { el: HTMLElement; dispose: () => void } {
  const el = h('button', { class: 'pill', attrs: { type: 'button', 'data-testid': 'sync-pill' }, on: { click: () => void router.go('settings', { section: 'sync' }) } });
  const paint = (s: SyncStatus): void => {
    const c = pillContent(s);
    clear(el);
    el.className = `pill${c.tone ? ` ${c.tone}` : ''}`;
    el.append(icon(c.icon, 'ic-sm'), h('span', { text: c.text }));
  };
  let status: SyncStatus;
  try {
    status = app.sync.status();
  } catch {
    status = { phase: 'unpaired', pending: 0, last_sync_at: null, error: null, clock_skew_ms: 0, rejected: 0 };
  }
  paint(status);
  const dispose = app.sync.subscribe(paint);
  return { el, dispose };
}
