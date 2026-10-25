#!/usr/bin/env node
/**
 * Creates the shop and the OWNER's login on a freshly deployed server, so every phone (the owner's too) only ever
 * uses "Sign in" with a user id and password: nobody types a setup key or a code on a phone.
 *
 *   KK_OWNER_USER=rahul KK_OWNER_PASSWORD=... [KK_SHOP_NAME='Rahul Stores'] [SETUP_KEY=...] \
 *     node khata/tools/create-owner.mjs https://kadan-kanakku-api.<name>.workers.dev
 *
 * SETUP_KEY comes from the environment or khata/api/.deploy-secrets (deploy-server.sh writes it). Steps, through the
 * same API the app uses: POST /setup (owner code) -> /pair (a temporary "Go-live setup" device) -> if the shop has no
 * users yet, POST /users {role: owner, link_me} (allowed without step-up only while the shop has no users) ->
 * /auth/logout (the temporary device is revoked). Safe to re-run: when the shop already has users it creates
 * nothing and says who they are. The temporary device took a block of customer numbers; go-live.sh hands them back
 * while the shop has no customers, so the first real phone still starts at C-0001.
 * The password is stretched here exactly like the app does (PBKDF2-SHA256, 600,000 rounds); the server never sees it.
 * Leading/trailing spaces are dropped from KK_OWNER_PASSWORD (a value pasted into a settings box often carries one).
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ITER = 600_000; // PBKDF2_DEFAULT_ITERATIONS in shared/protocol.ts
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/; // shared/protocol.ts
const PASSWORD_MIN = 8; // app/src/sync/password.ts

const die = (msg) => {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
};
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const derive = (password, salt) => b64url(pbkdf2Sync(password.normalize('NFC'), Buffer.from(salt, 'base64url'), ITER, 32, 'sha256'));

function setupKey() {
  if (process.env.SETUP_KEY) return process.env.SETUP_KEY.trim();
  const file = join(HERE, '..', 'api', '.deploy-secrets');
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('SETUP_KEY='));
  return line ? line.slice('SETUP_KEY='.length).trim() : '';
}

async function api(base, method, path, { token, headers = {}, body } = {}) {
  const r = await fetch(`${base}/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, body: json ?? text };
}

function must(res, what) {
  if (res.status !== 200) die(`${what}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+$/.test(base)) die('usage: node create-owner.mjs https://<server> (the server address, no path)');
const key = setupKey();
if (!key) die('no SETUP_KEY (environment or khata/api/.deploy-secrets). Re-run deploy-server.sh --rotate-setup-key.');
const shopName = (process.env.KK_SHOP_NAME ?? '').trim().slice(0, 80) || undefined;

const setup = must(await api(base, 'POST', '/setup', { headers: { 'X-Setup-Key': key }, body: shopName ? { shop_name: shopName } : {} }), 'setup');
const dev = must(await api(base, 'POST', '/pair', { body: { code: setup.code, device_name: 'Go-live setup' } }), 'pair');
const signOut = async () => {
  const r = await api(base, 'POST', '/auth/logout', { token: dev.token });
  if (r.status !== 200) console.warn(`warning: could not revoke the temporary setup device (HTTP ${r.status}); remove "Go-live setup" in Settings → Phones`);
};

const { users } = must(await api(base, 'GET', '/users', { token: dev.token }), 'list users');
if (users.length > 0) {
  await signOut();
  const list = users.map((u) => `${u.username} (${u.role}${u.disabled_at ? ', disabled' : ''})`).join(', ');
  console.log(`The shop "${dev.shop?.name ?? ''}" already has logins: ${list}. Nothing created.`);
  process.exit(0);
}

const username = (process.env.KK_OWNER_USER ?? '').trim().toLowerCase();
const password = (process.env.KK_OWNER_PASSWORD ?? '').trim();
if (!USERNAME_RE.test(username)) {
  await signOut();
  die('set KK_OWNER_USER: 3-32 characters, lower-case letters, digits, dot, dash or underscore (e.g. rahul)');
}
if (password.length < PASSWORD_MIN) {
  await signOut();
  die(`set KK_OWNER_PASSWORD: at least ${PASSWORD_MIN} characters`);
}
const salt = b64url(randomBytes(16));
const created = await api(base, 'POST', '/users', {
  token: dev.token,
  body: { username, display_name: username, role: 'owner', link_me: true, salt, iterations: ITER, client_key: derive(password, salt) },
});
await signOut();
const user = must(created, 'create the owner login').user;
console.log(`Owner login created: user id "${user.username}" (shop "${dev.shop?.name ?? shopName ?? ''}").`);
