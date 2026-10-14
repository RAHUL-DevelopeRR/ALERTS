/**
 * Full-screen "gates" shown above the navigation stack: boot loading/error, onboarding, the PIN lock and the
 * new-PIN entry. Only one gate at a time; the Android back button asks the gate first (see main.ts).
 */
import { t } from '../i18n';
import { clear, h, icon, type Child } from './components/dom';
import { keypad } from './components/keypad';
import { alertDialog, dismissAllLayers } from './components/overlay';

let gateEl: HTMLElement | null = null;
let gateBack: (() => boolean) | null = null;

export function showGate(cls: string, ...children: Child[]): HTMLElement {
  closeGate();
  dismissAllLayers();
  gateEl = h('div', { class: `gate ${cls}` }, children);
  document.body.appendChild(gateEl);
  return gateEl;
}

export function closeGate(): void {
  gateEl?.remove();
  gateEl = null;
  gateBack = null;
}

export function gateOpen(): boolean {
  return gateEl !== null;
}

/** The current gate's back handler: true = consumed; false = let the app minimise. */
export function setGateBack(fn: (() => boolean) | null): void {
  gateBack = fn;
}

export function gateHandleBack(): boolean {
  return gateBack ? gateBack() : false;
}

export function logo(): HTMLElement {
  return h('div', 'gate-logo', icon('book'));
}

// ------------------------------------------------------------------ PIN pad

interface PinPadOpts {
  title: string;
  help?: string;
  /** Called with the typed PIN when OK is pressed (4-6 digits). Return an error message to show, or null to accept. */
  submit: (pin: string) => Promise<string | null>;
  /** Seconds the pad is blocked (lockout); re-checked on every key. */
  blockedFor?: () => number;
  extra?: Child;
  onBack?: () => boolean;
}

/** Renders a PIN pad gate. Resolves when submit() accepts. */
export function pinPad(o: PinPadOpts): Promise<void> {
  return new Promise((resolve) => {
    let pin = '';
    let busy = false;
    const dots = h('div', { class: 'pin-dots', attrs: { 'data-testid': 'pin-dots' } });
    const msg = h('div', { class: 'pin-msg', attrs: { role: 'alert', 'data-testid': 'pin-msg' } });
    let timer: ReturnType<typeof setInterval> | null = null;
    const paintDots = (): void => {
      clear(dots);
      const n = Math.max(4, pin.length);
      for (let i = 0; i < n; i++) dots.appendChild(h('span', i < pin.length ? 'on' : ''));
    };
    const checkBlocked = (): boolean => {
      const s = o.blockedFor ? o.blockedFor() : 0;
      if (s > 0) {
        msg.textContent = t('pin.wait', { s });
        if (!timer) {
          timer = setInterval(() => {
            if (!checkBlocked()) {
              if (timer) clearInterval(timer);
              timer = null;
              msg.textContent = '';
            }
          }, 1000);
        }
        return true;
      }
      return false;
    };
    const onKey = async (k: string): Promise<void> => {
      if (busy || checkBlocked()) return;
      if (k === 'back') pin = pin.slice(0, -1);
      else if (k === 'clear') pin = '';
      else if (/^\d$/.test(k)) {
        if (pin.length < 6) pin += k;
        msg.textContent = '';
      } else if (k === 'ok') {
        if (pin.length < 4) return;
        busy = true;
        const err = await o.submit(pin);
        busy = false;
        if (err === null) {
          if (timer) clearInterval(timer);
          window.removeEventListener('keydown', onKeyDown);
          resolve();
          return;
        }
        pin = '';
        msg.textContent = err;
        checkBlocked();
      }
      paintDots();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!gateEl?.contains(dots)) {
        window.removeEventListener('keydown', onKeyDown);
        return;
      }
      if (/^\d$/.test(e.key)) void onKey(e.key);
      else if (e.key === 'Backspace') void onKey('back');
      else if (e.key === 'Enter') void onKey('ok');
    };
    window.addEventListener('keydown', onKeyDown);
    showGate(
      'pin-gate',
      h('div', 'gate-head', logo(), h('h2', { text: o.title }), o.help ? h('p', { text: o.help }) : null),
      dots,
      msg,
      keypad((k) => void onKey(k), { ok: true }),
      h('div', 'gate-spacer'),
      o.extra ?? null,
    );
    setGateBack(o.onBack ?? (() => false));
    paintDots();
    checkBlocked();
  });
}

/** Ask for a new PIN twice. Resolves the PIN, or null if the user backs out. */
export function askNewPin(opts: { help?: string; skipLabel?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let first: string | null = null;
    let done = false;
    const cancel = (): boolean => {
      if (done) return true;
      done = true;
      closeGate();
      resolve(null);
      return true;
    };
    const skip = h('button', { class: 'btn btn-outline-light btn-block', attrs: { type: 'button', 'data-testid': 'pin-skip' }, text: opts.skipLabel ?? t('common.cancel'), on: { click: () => void cancel() } });
    const step2 = (): void => {
      void pinPad({
        title: t('pin.confirm'),
        extra: skip,
        onBack: cancel,
        submit: async (pin) => {
          if (pin !== first) {
            first = null;
            setTimeout(() => step1(true), 0);
            return t('pin.mismatch');
          }
          return null;
        },
      }).then(() => {
        if (first && !done) {
          done = true;
          closeGate();
          resolve(first);
        }
      });
    };
    const step1 = (mismatch = false): void => {
      void pinPad({
        title: t('pin.new'),
        help: mismatch ? t('pin.mismatch') : opts.help,
        extra: skip,
        onBack: cancel,
        submit: async (pin) => {
          first = pin;
          return null;
        },
      }).then(() => step2());
    };
    step1();
  });
}

// ------------------------------------------------------------------ lock

const FAIL_KEY = 'kk-pin-fails';

function readFails(): { n: number; last: number } {
  try {
    const v = JSON.parse(window.localStorage.getItem(FAIL_KEY) ?? 'null') as { n: number; last: number } | null;
    if (v && typeof v.n === 'number' && typeof v.last === 'number') return v;
  } catch {
    /* storage unavailable */
  }
  return { n: 0, last: 0 };
}

function writeFails(v: { n: number; last: number } | null): void {
  try {
    if (v) window.localStorage.setItem(FAIL_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(FAIL_KEY);
  } catch {
    /* ignore */
  }
}

/** 5 wrong -> 30 s, then doubling for each further wrong PIN. */
export function lockoutSeconds(fails: number): number {
  return fails < 5 ? 0 : 30 * 2 ** Math.min(fails - 5, 10);
}

let locked = false;

export function isLocked(): boolean {
  return locked;
}

/** Show the lock screen until the right PIN is entered. */
export async function lock(verify: (pin: string) => Promise<boolean>): Promise<void> {
  if (locked) return;
  locked = true;
  const forgot = h('button', {
    class: 'link',
    attrs: { type: 'button', 'data-testid': 'pin-forgot' },
    text: t('pin.forgot'),
    style: { alignSelf: 'center' },
    on: { click: () => void alertDialog(t('pin.forgotTitle'), t('pin.forgotBody')) },
  });
  await pinPad({
    title: t('pin.enter'),
    extra: forgot,
    blockedFor: () => {
      const f = readFails();
      const until = f.last + lockoutSeconds(f.n) * 1000;
      return Math.max(0, Math.ceil((until - Date.now()) / 1000));
    },
    submit: async (pin) => {
      if (await verify(pin)) {
        writeFails(null);
        return null;
      }
      const f = readFails();
      const next = { n: f.n + 1, last: Date.now() };
      writeFails(next);
      return next.n >= 5 ? t('pin.wait', { s: lockoutSeconds(next.n) }) : t('pin.wrong', { n: 5 - next.n });
    },
    onBack: () => false,
  });
  locked = false;
  closeGate();
}
