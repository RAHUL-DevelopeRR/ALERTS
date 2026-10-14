/** Screen skeleton: coloured top bar (back, title, actions), scrolling body, optional footer. */
import { t } from '../../i18n';
import * as router from '../router';
import { h, icon, type Child, type IconName } from './dom';

export interface ShellOpts {
  title: string;
  sub?: string;
  back?: boolean;
  tone?: 'gave' | 'got';
  actions?: HTMLElement[];
  /** Extra row under the title row (e.g. sync pill). */
  below?: Child;
  bodyClass?: string;
}

export interface Shell {
  body: HTMLElement;
  footer: HTMLElement;
  header: HTMLElement;
}

export function iconButton(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': label, title: label }, on: { click: onClick } }, icon(name));
}

export function shell(root: HTMLElement, o: ShellOpts): Shell {
  const title = h('h1', null, o.title, o.sub ? h('span', { class: 'sub', text: o.sub }) : null);
  const header = h(
    'header',
    { class: `topbar${o.tone ? ` ${o.tone}` : ''}` },
    h(
      'div',
      'topbar-row',
      o.back ? iconButton('back', t('common.back'), () => router.back()) : h('span', { style: { width: '8px' } }),
      title,
      o.actions ?? [],
    ),
    o.below ?? null,
  );
  const body = h('main', { class: `body${o.bodyClass ? ` ${o.bodyClass}` : ''}` });
  const footer = h('footer', { class: 'footer hidden' });
  root.append(header, body, footer);
  return { body, footer, header };
}

export function showFooter(f: HTMLElement, ...children: Child[]): void {
  f.classList.remove('hidden');
  for (const c of children) if (c instanceof Node) f.appendChild(c);
}
