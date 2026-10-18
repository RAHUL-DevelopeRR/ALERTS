import { defineConfig } from 'vite';

/**
 * Modes: (default) browser preview / e2e -> dist/; `android` -> dist/ with the sql.js adapter dead-code-eliminated;
 * `web` -> dist-web/, the production web app served by the Worker (khata/api) as static assets, cookie sessions.
 */
export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    // Android 7+ phones with an updated System WebView (Chrome 80+) can run this.
    target: ['es2020', 'chrome80'],
    outDir: mode === 'web' ? 'dist-web' : 'dist',
    emptyOutDir: true,
    sourcemap: mode !== 'android' && mode !== 'web',
  },
  define: {
    // Dead-code-eliminates the sql.js browser adapter from the Android bundle.
    __NATIVE_BUILD__: JSON.stringify(mode === 'android'),
    // The web app: login gate, cookie sessions, no pairing UI (src/ui/web/**).
    __WEB_APP__: JSON.stringify(mode === 'web'),
  },
  server: { host: '127.0.0.1', port: 5173 },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
}));
