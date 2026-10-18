/**
 * Google Identity Services button for the web login (only when GET /config returns a google_client_id). The GIS
 * script is loaded from accounts.google.com (allowed by api/web/_headers CSP); the nonce comes from POST /auth/nonce
 * so the ID token's nonce claim can be checked and consumed by /auth/google. Nothing is stored here.
 */
const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface GisIdApi {
  initialize(cfg: { client_id: string; callback: (r: { credential?: string }) => void; nonce?: string; ux_mode?: 'popup'; itp_support?: boolean; use_fedcm_for_prompt?: boolean }): void;
  renderButton(el: HTMLElement, opts: { theme?: string; size?: string; width?: number; text?: string; locale?: string; shape?: string }): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GisIdApi } };
  }
}

let loading: Promise<GisIdApi> | null = null;

function loadGis(): Promise<GisIdApi> {
  if (loading) return loading;
  loading = new Promise<GisIdApi>((resolve, reject) => {
    const ready = (): boolean => {
      const api = window.google?.accounts?.id;
      if (api) {
        resolve(api);
        return true;
      }
      return false;
    };
    if (ready()) return;
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => {
      if (!ready()) reject(new Error('gis: api missing after load'));
    };
    s.onerror = () => reject(new Error('gis: script failed to load'));
    document.head.appendChild(s);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/**
 * Renders the Google button into `host`. `onCredential` receives the ID token (JWT) to pass to the server with the
 * same nonce. Rejects when GIS cannot load (the caller hides the button).
 */
export async function renderGoogleButton(host: HTMLElement, opts: { clientId: string; nonce: string; locale: 'ta' | 'en'; onCredential: (idToken: string) => void }): Promise<void> {
  const api = await loadGis();
  api.initialize({
    client_id: opts.clientId,
    nonce: opts.nonce,
    ux_mode: 'popup',
    itp_support: true,
    callback: (r) => {
      if (r.credential) opts.onCredential(r.credential);
    },
  });
  api.renderButton(host, { theme: 'outline', size: 'large', width: 300, text: 'signin_with', shape: 'pill', locale: opts.locale === 'ta' ? 'ta' : 'en' });
}
