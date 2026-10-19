#!/usr/bin/env node
/**
 * Build guard: the Android speech plugin must carry this app's biasing patch
 * (patches/@capgo+capacitor-speech-recognition+8.3.2.patch, applied by `patch-package` on install). Without it the
 * stock plugin installs silently (its d.ts already declares contextualStrings, so tsc passes) and customer names
 * are never sent to the recogniser. Run by `npm run build:android`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = join(ROOT, 'node_modules', '@capgo', 'capacitor-speech-recognition', 'android', 'src', 'main', 'java', 'app', 'capgo', 'speechrecognition', 'SpeechRecognitionPlugin.java');

let src = '';
try {
  src = readFileSync(JAVA, 'utf8');
} catch (e) {
  console.error(`check-speech-patch: cannot read ${JAVA}: ${e.message}`);
  process.exit(1);
}
if (!src.includes('EXTRA_BIASING_STRINGS') || !src.includes('readContextualStrings')) {
  console.error('check-speech-patch: the speech plugin is NOT patched (no EXTRA_BIASING_STRINGS in SpeechRecognitionPlugin.java).');
  console.error('  Run `npx patch-package --error-on-fail` (or `npm install`) so patches/@capgo+capacitor-speech-recognition+8.3.2.patch is applied.');
  process.exit(1);
}
console.log('check-speech-patch: biasing patch present.');
