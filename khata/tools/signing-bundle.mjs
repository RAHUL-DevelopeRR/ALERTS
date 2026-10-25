#!/usr/bin/env node
/**
 * The app's release signing key as ONE environment value, so a fresh cloud session (or another computer) can sign
 * APKs that install over the ones already on the shop's phones.
 *
 *   node khata/tools/signing-bundle.mjs pack /path/to/keystore.properties > kk-signing.txt   # make KK_SIGNING
 *   KK_SIGNING=... node khata/tools/signing-bundle.mjs unpack <dir>                        # prints a keystore.properties path
 *
 * KK_SIGNING = base64url(JSON {v, alias, password, keystore: base64 of the .jks}). It is as secret as the keystore and
 * its password together: keep it in the environment's secrets or a password manager, never in the repository.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const [cmd, arg] = process.argv.slice(2);

function readProps(file) {
  const props = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) props[m[1]] = m[2];
  }
  return props;
}

if (cmd === 'pack') {
  if (!arg) throw new Error('usage: pack /path/to/keystore.properties');
  const props = readProps(arg);
  const store = isAbsolute(props.storeFile) ? props.storeFile : resolve(dirname(arg), props.storeFile);
  if (props.storePassword !== props.keyPassword) throw new Error('storePassword and keyPassword differ: not supported by this bundle');
  const bundle = { v: 1, alias: props.keyAlias, password: props.storePassword, keystore: readFileSync(store).toString('base64') };
  process.stdout.write(Buffer.from(JSON.stringify(bundle)).toString('base64url') + '\n');
} else if (cmd === 'unpack') {
  const raw = (process.env.KK_SIGNING ?? '').trim();
  if (!raw || !arg) throw new Error('usage: KK_SIGNING=... unpack <dir>');
  const b = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  if (b.v !== 1 || !b.alias || !b.password || !b.keystore) throw new Error('KK_SIGNING is not a signing bundle');
  mkdirSync(arg, { recursive: true, mode: 0o700 });
  const jks = join(resolve(arg), 'release.jks');
  writeFileSync(jks, Buffer.from(b.keystore, 'base64'), { mode: 0o600 });
  const props = join(resolve(arg), 'keystore.properties');
  writeFileSync(props, `storeFile=${jks}\nstorePassword=${b.password}\nkeyAlias=${b.alias}\nkeyPassword=${b.password}\n`, { mode: 0o600 });
  chmodSync(props, 0o600);
  process.stdout.write(props + '\n');
} else {
  throw new Error('usage: signing-bundle.mjs pack <keystore.properties> | unpack <dir>');
}
