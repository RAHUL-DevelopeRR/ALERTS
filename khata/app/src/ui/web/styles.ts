/** Styles that apply only in the web app (html.kk-web): hide phone-only controls. Injected once by boot.ts. */
import { WEB_HTML_CLASS } from './flag';

const CSS = `
html.${WEB_HTML_CLASS} [data-testid="act-call"] { display: none; }
html.${WEB_HTML_CLASS} .actions3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
html.${WEB_HTML_CLASS} .screen { max-width: 720px; margin: 0 auto; box-shadow: 0 0 24px rgba(0, 0, 0, .08); }
html.${WEB_HTML_CLASS} body { background: #e6ebe8; }
`;

export function injectWebStyles(): void {
  document.documentElement.classList.add(WEB_HTML_CLASS);
  const el = document.createElement('style');
  el.setAttribute('data-kk-web', '');
  el.textContent = CSS;
  document.head.appendChild(el);
}
