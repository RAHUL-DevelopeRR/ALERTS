import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            PEPPER: 'test-pepper',
            SETUP_KEY: 'test-setup-key',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // All test files share one local D1; each test wipes it first, so files run one at a time.
      fileParallelism: false,
    },
  };
});
