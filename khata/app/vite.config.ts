import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    // Android 7+ phones with an updated System WebView (Chrome 80+) can run this.
    target: ['es2020', 'chrome80'],
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode !== 'android',
  },
  define: {
    // Dead-code-eliminates the sql.js browser adapter from the Android bundle.
    __NATIVE_BUILD__: JSON.stringify(mode === 'android'),
  },
  server: { host: '127.0.0.1', port: 5173 },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
}));
