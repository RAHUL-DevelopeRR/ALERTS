import type { CapacitorConfig } from '@capacitor/cli';
// Type-only imports: they pull in each plugin's `PluginsConfig` augmentation without loading plugin code in Node.
import type { KeyboardResize } from '@capacitor/keyboard';
import type {} from '@capacitor/status-bar';

/**
 * System bars / edge-to-edge (targetSdk 36 makes edge-to-edge mandatory on Android 15+):
 * - Capacitor 8's built-in SystemBars plugin owns the insets. With `insetsHandling: 'css'` it pads the WebView
 *   natively on WebView < 140 (env(safe-area-inset-*) are then 0), and on WebView >= 140 it lets the page draw
 *   edge-to-edge only if index.html asks for `viewport-fit=cover`, in which case env(safe-area-inset-*) carry the
 *   real values. It also injects `--safe-area-inset-{top,right,bottom,left}` CSS variables with the correct values
 *   in both modes, so the UI can write `padding-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px))`.
 *   Either way no content ends up under the status or navigation bar.
 * - Behind the bars (padded mode) the window background shows; styles.xml sets it to the brand green #0f5132,
 *   so the bar icons must be light: style 'DARK' (= light icons on a dark background).
 * - @capacitor/status-bar defaults to overlaysWebView=true with a black bar, which would put the page under the
 *   status bar on Android <= 14. It is configured here to not overlay and to use the brand colour.
 * Keyboard: the amount screen uses an in-app keypad, so the soft keyboard only appears for text fields (name,
 *   search, note). The manifest's adjustResize plus SystemBars' IME padding shrink the WebView above the keyboard,
 *   which keeps the focused field and the Save button visible. `resize: 'native'` matches that on iOS (Android
 *   ignores the option). `resizeOnFullScreen` is deliberately omitted (SystemBars warns against it).
 */
const config: CapacitorConfig = {
  appId: 'live.zerox.kadankanakku',
  appName: 'Kadan Kanakku',
  webDir: 'dist',
  android: {
    // Older system WebViews cannot run the bundle; Capacitor shows a clear error page below this version.
    minWebViewVersion: 80,
    allowMixedContent: false,
    captureInput: true,
  },
  plugins: {
    // Route fetch() through the native HTTP stack so the WebView's CORS rules never apply to sync calls.
    CapacitorHttp: { enabled: true },
    CapacitorSQLite: {
      androidIsEncryption: false,
      androidBiometric: { biometricAuth: false },
    },
    SystemBars: {
      insetsHandling: 'css',
      style: 'DARK',
      initialViewportFitValueHint: 'cover',
    },
    StatusBar: {
      overlaysWebView: false,
      backgroundColor: '#0f5132',
      style: 'DARK',
    },
    Keyboard: { resize: 'native' as KeyboardResize },
  },
};

export default config;
