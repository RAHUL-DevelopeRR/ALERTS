/**
 * Is this the web app (served by the Worker from app/dist-web)? False in the Android build, the dev preview and tests.
 * Guarded with typeof so modules that import it also run where the define is absent (Vitest).
 */
export function isWebApp(): boolean {
  return typeof __WEB_APP__ !== 'undefined' && __WEB_APP__ === true;
}

/** CSS class on <html> in the web app: hides phone-only controls (see styles.ts). */
export const WEB_HTML_CLASS = 'kk-web';
