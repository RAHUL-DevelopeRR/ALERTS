/** Home's Sync button: the sentence shown after a manual sync. */
import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../src/i18n';
import type { SyncStatus } from '../src/sync/types';
import { syncResultText } from '../src/ui/components/sync-button';

// setLang() sets <html lang>; the node test environment has no document.
(globalThis as { document?: unknown }).document ??= { documentElement: {} };

const st = (patch: Partial<SyncStatus>): SyncStatus => ({
  phase: 'idle', pending: 0, last_sync_at: '2026-10-25T07:00:00.000Z', error: null, clock_skew_ms: 0, rejected: 0, ...patch,
});

describe('Sync button result', () => {
  afterEach(() => setLang('ta'));

  it('says what came from the other phones, or that everything is up to date', () => {
    setLang('en');
    expect(syncResultText(st({}), 3)).toEqual({ text: 'Synced. 3 updates from the other phones.', error: false });
    expect(syncResultText(st({}), 1)).toEqual({ text: 'Synced. 1 update from the other phones.', error: false });
    expect(syncResultText(st({}), 0)).toEqual({ text: 'Synced. Everything is up to date.', error: false });
  });

  it('rows still waiting are named instead of "up to date"', () => {
    setLang('en');
    expect(syncResultText(st({ pending: 2 }), 0)).toEqual({ text: '2 to send to server', error: false });
  });

  it('no internet, a server problem and a removed phone are errors with their own sentence', () => {
    setLang('en');
    expect(syncResultText(st({ phase: 'offline', error: 'network' }), 0)).toEqual({
      text: 'No internet. The entries are safe on this phone and go to the server when the network is back.',
      error: true,
    });
    expect(syncResultText(st({ phase: 'error', error: 'server' }), 0)).toEqual({ text: 'The server had a problem. Try again later.', error: true });
    expect(syncResultText(st({ phase: 'error', error: 'daily_cap' }), 0).text).toBe('The server’s daily limit is used up. It resets tomorrow.');
    expect(syncResultText(st({ phase: 'revoked', error: 'revoked' }), 0)).toEqual({ text: 'Removed from shop', error: true });
  });

  it('Tamil', () => {
    setLang('ta');
    expect(syncResultText(st({}), 0).text).toBe('ஒத்திசைந்தது. எல்லாம் புதிதாக உள்ளது.');
    expect(syncResultText(st({}), 2).text).toBe('ஒத்திசைந்தது. மற்ற போன்களிலிருந்து 2 மாற்றங்கள் வந்தன.');
    expect(syncResultText(st({}), 1).text).toBe('ஒத்திசைந்தது. மற்ற போன்களிலிருந்து 1 மாற்றம் வந்தது.');
  });
});
