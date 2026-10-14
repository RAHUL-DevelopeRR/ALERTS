/**
 * Small DOM helpers. Text always goes in through textContent / text nodes; user data never touches innerHTML.
 * The only innerHTML use is icon(): constant SVG markup defined in this file.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
}

function append(el: Node, c: Child): void {
  if (c == null || c === false) return;
  if (Array.isArray(c)) {
    for (const x of c) append(el, x);
    return;
  }
  el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | string | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (typeof props === 'string') el.className = props;
  else if (props) {
    if (props.class) el.className = props.class;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v === false || v == null) continue;
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (props.style) Object.assign(el.style, props.style);
    if (props.dataset) Object.assign(el.dataset, props.dataset);
    if (props.on) {
      for (const [k, fn] of Object.entries(props.on)) if (fn) el.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) append(el, c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** A <button type="button"> with a click handler. */
export function button(label: Child, onClick: (ev: MouseEvent) => void, cls = 'btn', attrs: Props['attrs'] = {}): HTMLButtonElement {
  return h('button', { class: cls, attrs: { type: 'button', ...attrs }, on: { click: onClick } }, label);
}

// ------------------------------------------------------------------ icons (constant markup only)

const ICONS = {
  back: '<path d="M15.5 4.5 8 12l7.5 7.5" />',
  more: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  plus: '<path d="M12 5v14M5 12h14" />',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  book: '<path d="M5 4.5h10.5a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10.5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  phone: '<path d="M6.6 3.5h2.6l1.4 4.2-2 1.5a11 11 0 0 0 6.2 6.2l1.5-2 4.2 1.4v2.6a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.6 5.5a2 2 0 0 1 2-2z"/>',
  chat: '<path d="M4.5 19.5 5.8 15A7.8 7.8 0 1 1 9 18.3z"/>',
  doc: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6"/>',
  chevL: '<path d="M14.5 6 8.5 12l6 6" />',
  chevR: '<path d="M9.5 6l6 6-6 6" />',
  cal: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  bolt: '<path d="M13 3 5.5 13.5H12L11 21l7.5-10.5H12z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  warn: '<path d="M12 4 2.8 20h18.4z"/><path d="M12 10v4.5M12 17.3v.2"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .6-8A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z"/>',
  cloudOff: '<path d="M7 18.5h10a4 4 0 0 0 .6-8A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z"/><path d="M4 4l16 16"/>',
  phoneOnly: '<rect x="7" y="2.8" width="10" height="18.4" rx="2"/><path d="M11 18h2"/>',
  backspace: '<path d="M9 5.5h11v13H9L3.5 12z"/><path d="m12 9.5 5 5M17 9.5l-5 5"/>',
  share: '<circle cx="6.5" cy="12" r="2.3"/><circle cx="17.5" cy="6" r="2.3"/><circle cx="17.5" cy="18" r="2.3"/><path d="m8.5 11 7-4M8.5 13l7 4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-3a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3"/>',
  sms: '<path d="M4 5.5h16v11H10l-4.5 3.5v-3.5H4z"/><path d="M8 11h.01M12 11h.01M16 11h.01"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = 'ic'): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  const svg = t.content.firstChild as SVGSVGElement;
  svg.setAttribute('class', cls);
  return svg;
}

/** Append children (strings, nodes, arrays; null/false skipped). */
export function add(el: Node, ...children: Child[]): void {
  for (const c of children) append(el, c);
}
