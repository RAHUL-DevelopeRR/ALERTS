/**
 * Overlay layers (dialogs, bottom sheets) with a stack so the Android back button closes the top one first.
 * Toasts are not layers (back never targets them).
 */
import { t } from '../../i18n';
import { button, h, type Child } from './dom';

interface Layer {
  el: HTMLElement;
  dismiss: () => void;
}

const layers: Layer[] = [];

function host(): HTMLElement {
  let el = document.getElementById('overlays');
  if (!el) {
    el = h('div', { attrs: { id: 'overlays' } });
    document.body.appendChild(el);
  }
  return el;
}

/** Show `el` as a layer. `dismiss` is called for back button / scrim tap. Returns a remover. */
export function pushLayer(el: HTMLElement, dismiss: () => void): () => void {
  const layer: Layer = { el, dismiss };
  layers.push(layer);
  host().appendChild(el);
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    el.remove();
  };
}

/** Back button: dismiss the top layer. Returns true if one was open. */
export function dismissTopLayer(): boolean {
  const top = layers[layers.length - 1];
  if (!top) return false;
  top.dismiss();
  return true;
}

export function hasLayers(): boolean {
  return layers.length > 0;
}

/** Close everything (e.g. when the lock screen comes up). */
export function dismissAllLayers(): void {
  while (layers.length) {
    const n = layers.length;
    layers[layers.length - 1].dismiss();
    if (layers.length === n) layers.pop()?.el.remove();
  }
}

// ------------------------------------------------------------------ dialog

export interface DialogButton<T> {
  label: string;
  value: T;
  kind?: 'primary' | 'danger' | 'plain' | 'gave' | 'got';
  /** Disabled until `enable()` returns true (re-checked on every input event inside the dialog). */
  enable?: () => boolean;
}

export function dialog<T>(opts: {
  title?: string;
  body?: Child;
  buttons: DialogButton<T>[];
  dismissValue: T;
  /** Lay the buttons out one per row (for long Tamil labels or many choices). */
  vertical?: boolean;
}): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (v: T): void => {
      if (done) return;
      done = true;
      remove();
      resolve(v);
    };
    const btns = opts.buttons.map((b) => {
      const el = button(b.label, () => finish(b.value), `btn btn-${b.kind ?? 'plain'}`);
      return { b, el };
    });
    const refresh = (): void => {
      for (const { b, el } of btns) if (b.enable) el.disabled = !b.enable();
    };
    const box = h(
      'div',
      { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true' } },
      opts.title ? h('h2', { class: 'dialog-title', text: opts.title }) : null,
      opts.body != null ? h('div', 'dialog-body', opts.body) : null,
      h('div', opts.vertical || opts.buttons.length > 2 ? 'dialog-actions vertical' : 'dialog-actions', btns.map((x) => x.el)),
    );
    box.addEventListener('input', refresh);
    box.addEventListener('change', refresh);
    const scrim = h('div', { class: 'scrim', on: { click: (e) => { if (e.target === scrim) finish(opts.dismissValue); } } }, box);
    const remove = pushLayer(scrim, () => finish(opts.dismissValue));
    refresh();
    const first = box.querySelector<HTMLElement>('input, textarea, select') ?? btns.find((x) => x.b.kind === 'primary')?.el;
    setTimeout(() => first?.focus(), 30);
  });
}

export function confirmDialog(opts: { title?: string; message: Child; ok?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return dialog<boolean>({
    title: opts.title,
    body: typeof opts.message === 'string' ? h('p', { class: 'pre', text: opts.message }) : opts.message,
    buttons: [
      { label: opts.cancel ?? t('common.cancel'), value: false },
      { label: opts.ok ?? t('common.ok'), value: true, kind: opts.danger ? 'danger' : 'primary' },
    ],
    dismissValue: false,
  });
}

export function alertDialog(title: string, message: Child): Promise<void> {
  return dialog<void>({
    title,
    body: typeof message === 'string' ? h('p', { class: 'pre', text: message }) : message,
    buttons: [{ label: t('common.ok'), value: undefined, kind: 'primary' }],
    dismissValue: undefined,
  });
}

/** Single text field dialog. Resolves the trimmed value, or null on cancel. */
export async function promptDialog(opts: {
  title: string;
  label?: string;
  message?: string;
  placeholder?: string;
  ok?: string;
  danger?: boolean;
  inputmode?: string;
  /** OK stays disabled until this passes (default: non-empty). */
  valid?: (v: string) => boolean;
  initial?: string;
}): Promise<string | null> {
  const input = h('input', {
    class: 'input',
    attrs: { type: 'text', placeholder: opts.placeholder ?? '', inputmode: opts.inputmode, autocomplete: 'off', value: opts.initial ?? '' },
  });
  const valid = opts.valid ?? ((v: string) => v.trim().length > 0);
  const body = h(
    'div',
    null,
    opts.message ? h('p', { class: 'pre', text: opts.message }) : null,
    h('label', 'field', opts.label ? h('span', { class: 'field-label', text: opts.label }) : null, input),
  );
  const ok = await dialog<boolean>({
    title: opts.title,
    body,
    buttons: [
      { label: t('common.cancel'), value: false },
      { label: opts.ok ?? t('common.ok'), value: true, kind: opts.danger ? 'danger' : 'primary', enable: () => valid(input.value) },
    ],
    dismissValue: false,
  });
  return ok ? input.value.trim() : null;
}

// ------------------------------------------------------------------ bottom sheet

export interface SheetAction {
  label: string;
  sub?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

export function actionSheet(opts: { title?: string; subtitle?: string; actions: SheetAction[] }): void {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    remove();
  };
  const items = opts.actions.map((a) =>
    h(
      'button',
      {
        class: `sheet-item${a.danger ? ' danger' : ''}`,
        attrs: { type: 'button', disabled: !!a.disabled },
        on: { click: () => { close(); void a.run(); } },
      },
      h('span', { class: 'sheet-label', text: a.label }),
      a.sub ? h('span', { class: 'sheet-sub', text: a.sub }) : null,
    ),
  );
  const sheet = h(
    'div',
    { class: 'sheet', attrs: { role: 'dialog', 'aria-modal': 'true' } },
    h('div', 'sheet-grip'),
    opts.title ? h('div', { class: 'sheet-title', text: opts.title }) : null,
    opts.subtitle ? h('div', { class: 'sheet-subtitle', text: opts.subtitle }) : null,
    items,
    h('button', { class: 'sheet-item sheet-cancel', attrs: { type: 'button' }, on: { click: close } }, t('common.cancel')),
  );
  const scrim = h('div', { class: 'scrim scrim-sheet', on: { click: (e) => { if (e.target === scrim) close(); } } }, sheet);
  const remove = pushLayer(scrim, close);
}

// ------------------------------------------------------------------ toast

let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastHasAction = false;

export function toast(message: string, opts: { action?: { label: string; run: () => void }; ms?: number; error?: boolean } = {}): void {
  hideToast();
  const el = h(
    'div',
    { class: `toast${opts.error ? ' toast-error' : ''}`, attrs: { role: 'status', 'aria-live': 'polite' } },
    h('span', { class: 'toast-msg', text: message }),
    opts.action
      ? button(opts.action.label, () => {
          hideToast();
          opts.action!.run();
        }, 'toast-action')
      : null,
  );
  toastEl = el;
  toastHasAction = !!opts.action;
  document.body.appendChild(el);
  toastTimer = setTimeout(hideToast, opts.ms ?? (opts.action ? 10_000 : 3_000));
}

export function hideToast(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  toastEl?.remove();
  toastEl = null;
  toastHasAction = false;
}

/** Remove a toast that carries an action (Undo). Called on every navigation, so an Undo for one customer's entry
 *  is never left on top of another customer's screen. Plain info toasts may outlive the screen change. */
export function hideActionToast(): void {
  if (toastHasAction) hideToast();
}
