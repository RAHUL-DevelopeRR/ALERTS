/**
 * Backup copy (share sheet), restore from file, the rolling daily private snapshots (newest 7 kept), a private
 * safety copy before every restore and before "Erase all entries", and restoring any of those private copies
 * (Settings → Backup).
 */
import { bizDateIST, formatDay, todayIST } from '../core/ledger';
import { validateBackup } from '../data/index';
import type { BackupFile } from '../data/types';
import { getLang, t } from '../i18n';
import { afterWrite, app } from './app';
import { confirmDialog, toast } from './components/overlay';
import { errorText } from './errors';
import { when } from './format';

export const SNAPSHOT_PREFIX = 'snapshot-';
export const SNAPSHOTS_KEPT = 7;
/** Safety copy written just before a restore replaces the data: pre-restore-<epoch ms>.json, newest 3 kept. */
export const PRE_RESTORE_PREFIX = 'pre-restore-';
const PRE_RESTORE_KEPT = 3;
/** The same, just before "Erase all entries": pre-erase-<epoch ms>.json, newest 3 kept. */
export const PRE_ERASE_PREFIX = 'pre-erase-';
const SNAPSHOT_RE = /^snapshot-(\d{4}-\d{2}-\d{2})\.json$/;
const PRE_RESTORE_RE = /^pre-restore-(\d+)\.json$/;
const PRE_ERASE_RE = /^pre-erase-(\d+)\.json$/;

export async function saveBackupCopy(): Promise<boolean> {
  try {
    const file = await app.repo.exportBackup();
    const name = `kadan-kanakku-backup-${todayIST(app.settings?.clock_offset_ms ?? 0)}.json`;
    const shared = await app.platform.shareFile(name, JSON.stringify(file), 'application/json', t('set.saveBackup'));
    if (!shared) {
      // Share sheet closed without picking an app: nothing left the phone, so keep the backup reminder alive.
      toast(t('set.backupNotSent'));
      return false;
    }
    await app.repo.setMeta('last_backup_at', new Date().toISOString());
    toast(t('set.backupSaved'));
    return true;
  } catch (e) {
    console.error('[backup] export failed', e);
    toast(errorText(e), { error: true });
    return false;
  }
}

/** Write today's snapshot when the repo says one is due, then keep only the newest SNAPSHOTS_KEPT. Never throws. */
export async function snapshotIfDue(): Promise<void> {
  try {
    const snap = await app.repo.snapshotIfDue();
    if (!snap) return;
    await app.platform.writePrivateFile(`${SNAPSHOT_PREFIX}${todayIST()}.json`, JSON.stringify(snap));
    const names = (await app.platform.listPrivateFiles(SNAPSHOT_PREFIX)).filter((n) => SNAPSHOT_RE.test(n)).sort();
    for (const old of names.slice(0, Math.max(0, names.length - SNAPSHOTS_KEPT))) {
      await app.platform.deletePrivateFile(old).catch((e) => console.warn('[backup] delete snapshot failed', old, e));
    }
  } catch (e) {
    console.warn('[backup] snapshot failed', e);
  }
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsText(file);
  });
}

function parseBackup(text: string): BackupFile | null {
  try {
    const parsed = JSON.parse(text) as BackupFile;
    validateBackup(parsed);
    return parsed;
  } catch (e) {
    console.warn('[backup] invalid file', e);
    return null;
  }
}

/** Keep a private copy of what is on the phone right now, before a restore replaces it. Throws on failure. */
async function writeSafetyCopy(current: BackupFile, prefix = PRE_RESTORE_PREFIX): Promise<void> {
  if (current.customers.length === 0 && current.entries.length === 0) return; // nothing to lose
  const re = prefix === PRE_ERASE_PREFIX ? PRE_ERASE_RE : PRE_RESTORE_RE;
  await app.platform.writePrivateFile(`${prefix}${Date.now()}.json`, JSON.stringify(current));
  const byStamp = (a: string, b: string): number => Number(re.exec(a)?.[1] ?? 0) - Number(re.exec(b)?.[1] ?? 0);
  const names = (await app.platform.listPrivateFiles(prefix)).filter((n) => re.test(n)).sort(byStamp);
  for (const old of names.slice(0, Math.max(0, names.length - PRE_RESTORE_KEPT))) {
    await app.platform.deletePrivateFile(old).catch((e) => console.warn('[backup] delete safety copy failed', old, e));
  }
}

/** The copy kept just before "Erase all entries" (Restore a daily copy → "Before erasing" brings it back). Throws on failure. */
export function keepCopyBeforeErase(current: BackupFile): Promise<void> {
  return writeSafetyCopy(current, PRE_ERASE_PREFIX);
}

/**
 * Confirm (strongly, with what is lost on each side) and import. Before anything is replaced, the current data
 * is written to a private safety copy; if that fails, nothing is replaced. Returns true if data was replaced.
 */
async function restoreParsed(parsed: BackupFile): Promise<boolean> {
  let current: BackupFile;
  try {
    current = await app.repo.exportBackup();
  } catch (e) {
    toast(errorText(e), { error: true });
    return false;
  }
  const exported = typeof parsed.exported_at === 'string' && !Number.isNaN(Date.parse(parsed.exported_at))
    ? formatDay(bizDateIST(new Date(parsed.exported_at)), getLang())
    : '?';
  const ok = await confirmDialog({
    title: t('set.restoreConfirmTitle'),
    message: t('set.restoreConfirm', {
      date: exported, c: parsed.customers.length, e: parsed.entries.length,
      cc: current.customers.length, ce: current.entries.length,
    }),
    ok: t('set.restoreYes'),
    danger: true,
  });
  if (!ok) return false;
  try {
    await writeSafetyCopy(current);
  } catch (e) {
    console.error('[backup] safety copy failed', e);
    toast(t('set.safetyFailed'), { error: true });
    return false;
  }
  try {
    const r = await app.repo.importBackup(parsed);
    afterWrite();
    toast(t('set.restored', { c: r.customers, e: r.entries }));
    return true;
  } catch (e) {
    toast(errorText(e), { error: true });
    return false;
  }
}

/** Read, validate, confirm and import a backup file picked by the user. Returns true if data was replaced. */
export async function restoreFromFile(file: File): Promise<boolean> {
  let parsed: BackupFile | null = null;
  try {
    parsed = parseBackup(await readFileText(file));
  } catch (e) {
    console.warn('[backup] read failed', e);
  }
  if (!parsed) {
    toast(t('err.BAD_BACKUP'), { error: true });
    return false;
  }
  return restoreParsed(parsed);
}

export interface LocalCopy {
  name: string;
  label: string;
}

/** The private copies kept on this phone (daily snapshots and pre-restore safety copies), newest first. */
export async function listLocalCopies(): Promise<LocalCopy[]> {
  const [snaps, pre, erased] = await Promise.all([
    app.platform.listPrivateFiles(SNAPSHOT_PREFIX),
    app.platform.listPrivateFiles(PRE_RESTORE_PREFIX),
    app.platform.listPrivateFiles(PRE_ERASE_PREFIX),
  ]);
  const out: { name: string; label: string; at: number }[] = [];
  for (const n of snaps) {
    const m = SNAPSHOT_RE.exec(n);
    if (m) out.push({ name: n, label: t('set.dailyCopy', { date: formatDay(m[1], getLang()) }), at: Date.parse(`${m[1]}T23:59:59+05:30`) });
  }
  for (const n of pre) {
    const m = PRE_RESTORE_RE.exec(n);
    if (m) {
      const at = Number(m[1]);
      out.push({ name: n, label: t('set.preRestoreCopy', { when: when(new Date(at).toISOString()) }), at });
    }
  }
  for (const n of erased) {
    const m = PRE_ERASE_RE.exec(n);
    if (m) {
      const at = Number(m[1]);
      out.push({ name: n, label: t('set.preEraseCopy', { when: when(new Date(at).toISOString()) }), at });
    }
  }
  return out.sort((a, b) => b.at - a.at).map(({ name, label }) => ({ name, label }));
}

/** Restore one of the private copies (same confirm + safety copy as a file restore). */
export async function restoreLocalCopy(name: string): Promise<boolean> {
  let parsed: BackupFile | null = null;
  try {
    const text = await app.platform.readPrivateFile(name);
    parsed = text === null ? null : parseBackup(text);
  } catch (e) {
    console.warn('[backup] read copy failed', name, e);
  }
  if (!parsed) {
    toast(t('err.BAD_BACKUP'), { error: true });
    return false;
  }
  return restoreParsed(parsed);
}
