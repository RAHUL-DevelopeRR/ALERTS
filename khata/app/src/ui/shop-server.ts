/**
 * The shop server an APK can be built for, so nobody at the counter types an address: the release build passes
 * SHOP_SERVER_URL (tools/build-release-apk.sh), which Vite exposes as import.meta.env.VITE_SHOP_SERVER_URL. Empty in
 * a generic build: sign-in and Settings then ask for the address once.
 */
import { normalizeServerUrl } from '../sync/api';

function builtIn(): string {
  const raw = String(import.meta.env.VITE_SHOP_SERVER_URL ?? '').trim();
  if (!raw) return '';
  try {
    return normalizeServerUrl(raw);
  } catch {
    return '';
  }
}

/** Normalised https URL of the built-in shop server, or '' when this build has none. */
export const BUILT_IN_SERVER: string = builtIn();

/** "kadan-kanakku-api.example.workers.dev" for a URL (what the sign-in screen shows instead of the address). */
export function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
