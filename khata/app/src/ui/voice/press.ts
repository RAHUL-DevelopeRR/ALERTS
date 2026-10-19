/**
 * Press-and-hold vs tap on a mic button (hold-to-talk).
 *
 * The decision is pure (createPress / pressKind) so it can be unit-tested; bindPress() wires it to Pointer Events.
 * A press is one pointer from pointerdown to pointerup / pointercancel / lostpointercapture:
 * - in hold mode, a press held for at least HOLD_MIN_MS ends as 'hold' (release = finish listening);
 * - any shorter press, and every press in tap mode, ends as 'tap' (listening goes on until Stop / settle / cap);
 * - a second pointer while one is down, and an up for another pointer, are ignored.
 *
 * The click the browser synthesizes after the press is swallowed (swallowNextClick): a touch tap's click is
 * dispatched at the finger's position, and by then the listening sheet (opened on pointerdown) is under the
 * finger, so without this the click would land on its scrim and cancel the session that the press just started.
 * Pointer capture redirects pointer events only, not that click.
 */

/** A press held at least this long is a hold; below it, a tap (a quick tap on a phone is ~80-150 ms). */
export const HOLD_MIN_MS = 350;
/**
 * After a pointer release, the next pointer-generated click (detail >= 1) arriving within this time is swallowed:
 * the click that follows a press was already handled as the press. A keyboard click (detail 0) is never swallowed.
 */
export const CLICK_SWALLOW_MS = 400;

export type PressEnd = 'hold' | 'tap' | 'ignore';

/** How a press of `heldMs` ends: 'hold' only in hold mode and from minHoldMs on. */
export function pressKind(heldMs: number, holdMode: boolean, minHoldMs = HOLD_MIN_MS): 'hold' | 'tap' {
  return holdMode && Number.isFinite(heldMs) && heldMs >= minHoldMs ? 'hold' : 'tap';
}

export interface Press {
  /** True between an accepted down() and its up(). */
  readonly active: boolean;
  /** Returns false (and changes nothing) while another pointer's press is active. */
  down(pointerId: number, now: number): boolean;
  /** 'ignore' when no press is active or the pointer is not the one that went down. */
  up(pointerId: number, now: number, holdMode: boolean): PressEnd;
  /** Forget the active press without deciding (the flow was taken over by something else). */
  reset(): void;
}

export function createPress(minHoldMs = HOLD_MIN_MS): Press {
  let pointerId: number | null = null;
  let downAt = 0;
  return {
    get active() {
      return pointerId !== null;
    },
    down(id, now) {
      if (pointerId !== null) return false;
      pointerId = id;
      downAt = now;
      return true;
    },
    up(id, now, holdMode) {
      if (pointerId === null || id !== pointerId) return 'ignore';
      pointerId = null;
      return pressKind(now - downAt, holdMode, minHoldMs);
    },
    reset() {
      pointerId = null;
    },
  };
}

/**
 * A click without a pointer behind it: keyboard activation (Enter / Space) and element.click() carry detail 0 in
 * Chromium / Android WebView; a click synthesized from a mouse or touch press carries the click count (>= 1).
 * Without Pointer Events (never the case on a supported WebView) every click counts as a tap.
 */
export function isKeyboardClick(e: { detail?: number }, pointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window): boolean {
  return !pointerEvents || !e.detail;
}

let cancelSwallow: (() => void) | null = null;

/**
 * Swallow the next pointer-generated click on the document (capture phase, so nothing under the pointer sees it)
 * if it arrives within CLICK_SWALLOW_MS; one at a time, a new call replaces a pending one.
 */
export function swallowNextClick(ms = CLICK_SWALLOW_MS): void {
  if (typeof document === 'undefined') return;
  cancelSwallow?.();
  const onClick = (e: MouseEvent): void => {
    if (isKeyboardClick(e)) return;
    e.preventDefault();
    e.stopPropagation();
    off();
  };
  const timer = setTimeout(() => off(), ms);
  const off = (): void => {
    clearTimeout(timer);
    document.removeEventListener('click', onClick, true);
    if (cancelSwallow === off) cancelSwallow = null;
  };
  cancelSwallow = off;
  document.addEventListener('click', onClick, true);
}

export interface PressHandlers {
  /** Hold-to-talk on (Settings → Voice); read at release time. */
  holdMode(): boolean;
  /** A press began (primary button / first touch). */
  onDown(): void;
  /** The press ended: 'hold' = release after holding (finish now), 'tap' = a short press (or tap mode). */
  onUp(kind: 'hold' | 'tap'): void;
}

/**
 * Pointer Events on a mic button: pointer capture (the finger may slide off), the long-press context menu
 * suppressed, the click after the press swallowed, a keyboard activation (click without a pointer) counted as a
 * tap. CSS must set touch-action: none and user-select: none on the element (voice.css), or the browser may cancel
 * the press to scroll / select.
 */
export function bindPress(el: HTMLElement, h: PressHandlers, minHoldMs = HOLD_MIN_MS): void {
  const press = createPress(minHoldMs);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    if (!press.down(e.pointerId, now())) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable (old WebView): the up still arrives when the finger stays on the button */
    }
    h.onDown();
  });
  const end = (e: PointerEvent): void => {
    // Any release: the click the browser makes for it must not reach whatever is under the pointer now.
    swallowNextClick();
    const kind = press.up(e.pointerId, now(), h.holdMode());
    if (kind !== 'ignore') h.onUp(kind);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', (e) => {
    // A pointer press was handled above (and its click swallowed); a click without a pointer is a tap.
    if (!isKeyboardClick(e)) return;
    h.onDown();
    h.onUp('tap');
  });
}
