import type { CapacitorConfig } from '@capacitor/cli';

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
    Keyboard: { resize: 'body' },
  },
};

export default config;
