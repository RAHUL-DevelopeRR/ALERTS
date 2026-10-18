import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Every test starts from an empty database (the change-log sequence restarts too).
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('PRAGMA defer_foreign_keys = on'),
    env.DB.prepare('DELETE FROM changelog'),
    env.DB.prepare('DELETE FROM entries'),
    env.DB.prepare('DELETE FROM customers'),
    env.DB.prepare('DELETE FROM code_blocks'),
    env.DB.prepare('DELETE FROM seq'),
    env.DB.prepare('DELETE FROM pair_codes'),
    env.DB.prepare('DELETE FROM pair_failures'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM login_throttle'),
    env.DB.prepare('DELETE FROM auth_failures'),
    env.DB.prepare('DELETE FROM login_locks'),
    env.DB.prepare('DELETE FROM used_nonces'),
    env.DB.prepare('DELETE FROM auth_events'),
    env.DB.prepare('DELETE FROM shops'),
    env.DB.prepare('DELETE FROM sqlite_sequence'),
  ]);
});
