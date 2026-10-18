/** The microphone icon (constant SVG markup, same style as components/dom.ts icon()). */
export function micIcon(cls = 'ic'): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>';
  const svg = t.content.firstChild as SVGSVGElement;
  svg.setAttribute('class', cls);
  return svg;
}
