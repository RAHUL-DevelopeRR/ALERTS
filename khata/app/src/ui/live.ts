/**
 * Live screens: when the sync engine brings another phone's entries (onRemoteChange), the screen that shows
 * balances redraws from the local ledger, so counter 2 sees the sale counter 1 just saved without touching the
 * phone. Only list / read screens redraw (Home, a customer's page, the day book, a statement, quick entry), and
 * only when it cannot disturb the person: not while a text field has the focus (typing a name, a note), not while a
 * dialog or sheet is open, not behind the PIN gate. Otherwise the redraw waits and is retried until it is safe or
 * the person has moved to another screen (which renders fresh anyway). The keypad, the customer form and Settings
 * never redraw under the person's fingers; voice mode refreshes its own customer list (voice/mode.ts).
 *
 * A touch or a key press tells the engine someone is using this phone (notifyActivity): a phone nobody has touched for
 * 5 minutes polls once a minute instead of every 20 s, and the first touch after that fetches at once.
 */
import { app } from './app';
import { hasLayers } from './components/overlay';
import { gateOpen } from './gate';
import * as router from './router';
import type { Route, RouteName } from './router';

const LIVE: ReadonlySet<RouteName> = new Set<RouteName>(['home', 'customer', 'daybook', 'statement', 'quick']);
const RETRY_MS = 1500;

let pending: Route | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** True when redrawing the current screen now cannot lose input or close something the person is looking at. */
export function canRedraw(): boolean {
  const r = router.current();
  if (!r || !LIVE.has(r.name)) return false;
  if (gateOpen() || hasLayers()) return false;
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return false;
  return true;
}

function attempt(): void {
  timer = null;
  if (!pending) return;
  // Navigated away meanwhile: the new screen was rendered from the up-to-date ledger.
  if (router.current() !== pending) {
    pending = null;
    return;
  }
  if (canRedraw()) {
    pending = null;
    void router.rerender();
    return;
  }
  timer = setTimeout(attempt, RETRY_MS);
}

/** Other phones' rows arrived: redraw the current list screen as soon as that is safe. */
export function remoteChanged(): void {
  const r = router.current();
  if (!r || !LIVE.has(r.name)) return;
  pending = r;
  if (timer) clearTimeout(timer);
  attempt();
}

/** Wire the sync engine to the screens (once, at boot). */
export function startLiveRefresh(): () => void {
  const used = (): void => app.sync.notifyActivity();
  const opts = { capture: true, passive: true } as const;
  document.addEventListener('pointerdown', used, opts);
  document.addEventListener('keydown', used, opts);
  const off = app.sync.onRemoteChange(() => remoteChanged());
  return () => {
    off();
    document.removeEventListener('pointerdown', used, opts);
    document.removeEventListener('keydown', used, opts);
  };
}
