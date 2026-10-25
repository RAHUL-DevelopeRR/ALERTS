/**
 * Hash router with an in-app navigation stack. The URL hash mirrors the top of the stack (history.replaceState,
 * so the browser history never grows); the Android back button pops the stack (see main.ts).
 * Every show re-renders the screen from the Repo, so returning to a screen always shows fresh numbers.
 */
import { clear, h } from './components/dom';
import { errorText } from './errors';
import { hideActionToast, toast } from './components/overlay';

export type RouteName =
  | 'home' | 'customer' | 'customer-edit' | 'entry' | 'daybook' | 'statement' | 'settings' | 'quick' | 'voice-mode';

export interface Route {
  name: RouteName;
  params: Record<string, string>;
  /** In-memory extras (prefill for a correction, quick-entry flags). Not in the URL. */
  state?: unknown;
  /** Saved scroll position of the screen body, restored when the route is shown again. */
  scroll?: number;
}

/** A screen renders into `root` and may return a cleanup function (unsubscribe, timers). */
export type Screen = (root: HTMLElement, route: Route) => Promise<void | (() => void)>;

const screens = new Map<RouteName, Screen>();
let stack: Route[] = [];
let hostEl: HTMLElement | null = null;
let currentEl: HTMLElement | null = null;
let cleanup: (() => void) | null = null;
let token = 0;
/**
 * A screen may refuse a plain back (hardware back, top-bar back, Escape) while it holds unsaved input, e.g. the
 * keypad with an amount typed. The guard returns true when it consumed the back (it then asks the user and calls
 * back({ force: true }) itself). Cleared on every navigation.
 */
let leaveGuard: (() => boolean) | null = null;

/** Install a guard for the current screen. Returns a remover that only clears it if it is still this guard
 *  (a screen's cleanup runs after the next screen rendered and may already have set its own). */
export function setLeaveGuard(fn: () => boolean): () => void {
  leaveGuard = fn;
  return () => {
    if (leaveGuard === fn) leaveGuard = null;
  };
}

export function registerScreen(name: RouteName, s: Screen): void {
  screens.set(name, s);
}

export function mountRouter(host: HTMLElement): void {
  hostEl = host;
}

function hashOf(r: Route): string {
  const q = new URLSearchParams(r.params).toString();
  return `#/${r.name}${q ? `?${q}` : ''}`;
}

function saveScroll(): void {
  const top = stack[stack.length - 1];
  const body = currentEl?.querySelector<HTMLElement>('.body');
  if (top && body) top.scroll = body.scrollTop;
}

async function render(): Promise<void> {
  const r = stack[stack.length - 1];
  if (!r || !hostEl) return;
  const my = ++token;
  const screen = screens.get(r.name);
  const el = h('div', { class: 'screen', dataset: { route: r.name } });
  let c: void | (() => void);
  try {
    if (!screen) throw new Error(`No screen ${r.name}`);
    c = await screen(el, r);
  } catch (e) {
    console.error('[router] render failed', r.name, e);
    if (my !== token) return;
    toast(errorText(e), { error: true });
    if (stack.length > 1) {
      stack.pop();
      void render();
    }
    return;
  }
  if (my !== token) {
    if (typeof c === 'function') c();
    return;
  }
  if (cleanup) cleanup();
  cleanup = typeof c === 'function' ? c : null;
  if (currentEl) currentEl.replaceWith(el);
  else {
    clear(hostEl);
    hostEl.appendChild(el);
  }
  currentEl = el;
  try {
    history.replaceState(null, '', hashOf(r));
  } catch {
    /* file:// or sandboxed: ignore */
  }
  const body = el.querySelector<HTMLElement>('.body');
  if (body && r.scroll) body.scrollTop = r.scroll;
}

export function go(name: RouteName, params: Record<string, string> = {}, state?: unknown): Promise<void> {
  hideActionToast();
  leaveGuard = null;
  saveScroll();
  stack.push({ name, params, state });
  return render();
}

export function replace(name: RouteName, params: Record<string, string> = {}, state?: unknown): Promise<void> {
  hideActionToast();
  leaveGuard = null;
  stack.pop();
  stack.push({ name, params, state });
  return render();
}

/** Pop one screen. Returns false on the root screen (nothing popped). */
export function back(opts: { force?: boolean } = {}): boolean {
  if (stack.length <= 1) return false;
  if (!opts.force && leaveGuard && leaveGuard()) return true;
  hideActionToast();
  leaveGuard = null;
  stack.pop();
  void render();
  return true;
}

/** Pop back to the nearest route named `name` (or reset to it). */
export function backTo(name: RouteName, params?: Record<string, string>): Promise<void> {
  hideActionToast();
  leaveGuard = null;
  let i = stack.length - 1;
  while (i >= 0 && !(stack[i].name === name && (!params || Object.entries(params).every(([k, v]) => stack[i].params[k] === v)))) i--;
  if (i < 0) {
    stack = [{ name, params: params ?? {} }];
  } else {
    stack = stack.slice(0, i + 1);
  }
  return render();
}

export function reset(name: RouteName = 'home', params: Record<string, string> = {}): Promise<void> {
  hideActionToast();
  leaveGuard = null;
  stack = [{ name, params }];
  return render();
}

/** Re-render the current screen (language switch, data changed under it). */
export function rerender(): Promise<void> {
  saveScroll();
  return render();
}

export function current(): Route | undefined {
  return stack[stack.length - 1];
}

export function depth(): number {
  return stack.length;
}
