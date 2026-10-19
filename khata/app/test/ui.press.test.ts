/** Hold-to-talk press logic (src/ui/voice/press.ts): pure decision helpers, and the click swallow on a stub document. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLICK_SWALLOW_MS, HOLD_MIN_MS, createPress, isKeyboardClick, pressKind, swallowNextClick } from '../src/ui/voice/press';

describe('pressKind', () => {
  it('hold mode: a press of HOLD_MIN_MS or longer is a hold, shorter is a tap', () => {
    expect(HOLD_MIN_MS).toBe(350);
    expect(pressKind(349, true)).toBe('tap');
    expect(pressKind(350, true)).toBe('hold');
    expect(pressKind(2000, true)).toBe('hold');
    expect(pressKind(120, true)).toBe('tap');
    expect(pressKind(0, true)).toBe('tap');
  });

  it('tap mode: every press is a tap; odd durations are taps too', () => {
    expect(pressKind(5000, false)).toBe('tap');
    expect(pressKind(Number.NaN, true)).toBe('tap');
    expect(pressKind(-10, true)).toBe('tap');
    expect(pressKind(400, true, 500)).toBe('tap');
    expect(pressKind(500, true, 500)).toBe('hold');
  });
});

describe('createPress', () => {
  it('one press: down then up decides hold or tap by duration and mode', () => {
    const p = createPress();
    expect(p.active).toBe(false);
    expect(p.down(1, 1000)).toBe(true);
    expect(p.active).toBe(true);
    expect(p.up(1, 1600, true)).toBe('hold');
    expect(p.active).toBe(false);

    expect(p.down(2, 5000)).toBe(true);
    expect(p.up(2, 5100, true)).toBe('tap');

    expect(p.down(3, 9000)).toBe(true);
    expect(p.up(3, 9900, false)).toBe('tap');
  });

  it('ignores a second pointer while one is down, an up for another pointer and an up without a down', () => {
    const p = createPress();
    expect(p.up(7, 10, true)).toBe('ignore');
    expect(p.down(1, 0)).toBe(true);
    expect(p.down(2, 50)).toBe(false);
    expect(p.up(2, 100, true)).toBe('ignore');
    expect(p.active).toBe(true);
    expect(p.up(1, 500, true)).toBe('hold');
    // pointerup followed by lostpointercapture for the same pointer: the second one is ignored
    expect(p.up(1, 501, true)).toBe('ignore');
  });

  it('reset() forgets the active press', () => {
    const p = createPress(200);
    p.down(4, 0);
    p.reset();
    expect(p.active).toBe(false);
    expect(p.up(4, 1000, true)).toBe('ignore');
    p.down(5, 0);
    expect(p.up(5, 200, true)).toBe('hold');
  });
});

describe('isKeyboardClick', () => {
  it('a click with detail 0 (Enter / Space / element.click()) is keyboard; a pointer click (detail >= 1) is not', () => {
    expect(isKeyboardClick({ detail: 0 }, true)).toBe(true);
    expect(isKeyboardClick({}, true)).toBe(true);
    expect(isKeyboardClick({ detail: 1 }, true)).toBe(false);
    expect(isKeyboardClick({ detail: 2 }, true)).toBe(false);
    // without Pointer Events every click is the press itself
    expect(isKeyboardClick({ detail: 1 }, false)).toBe(true);
  });
});

describe('swallowNextClick', () => {
  /** A stub document: capture-phase click listeners, dispatch() returns whether the click got through. */
  function stubDocument() {
    const listeners = new Set<(e: unknown) => void>();
    const doc = {
      addEventListener: (name: string, fn: (e: unknown) => void, capture?: boolean) => {
        if (name === 'click' && capture) listeners.add(fn);
      },
      removeEventListener: (name: string, fn: (e: unknown) => void) => {
        if (name === 'click') listeners.delete(fn);
      },
    };
    const dispatch = (detail: number): boolean => {
      let through = true;
      const e = { detail, preventDefault: () => undefined, stopPropagation: () => (through = false) };
      for (const fn of [...listeners]) fn(e);
      return through;
    };
    return { doc, dispatch, count: () => listeners.size };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('swallows exactly one pointer click after a release, lets keyboard clicks through, and gives up after CLICK_SWALLOW_MS', () => {
    vi.useFakeTimers();
    const d = stubDocument();
    vi.stubGlobal('document', d.doc);
    vi.stubGlobal('window', { PointerEvent: class {} });
    swallowNextClick();
    expect(d.count()).toBe(1);
    expect(d.dispatch(0)).toBe(true); // keyboard: untouched, still armed
    expect(d.dispatch(1)).toBe(false); // the touch tap's click (would have hit the scrim): swallowed
    expect(d.count()).toBe(0);
    expect(d.dispatch(1)).toBe(true); // the next click is a real one

    swallowNextClick();
    swallowNextClick(); // a second release before any click: still one listener, not two
    expect(d.count()).toBe(1);
    vi.advanceTimersByTime(CLICK_SWALLOW_MS - 1);
    expect(d.count()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(d.count()).toBe(0); // a hold produced no click: a later click (Cancel, Stop) must work
    expect(d.dispatch(1)).toBe(true);
  });

  it('is a no-op without a document (unit tests, SSR)', () => {
    vi.stubGlobal('document', undefined);
    expect(() => swallowNextClick()).not.toThrow();
  });
});
