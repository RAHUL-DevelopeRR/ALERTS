/** Backup copy (share sheet), restore from file, and the rolling daily private snapshots (newest 7 kept). */
import { bizDateIST, formatDay, todayIST } from '../core/ledger';
import { validateBackup } from '../data/index';
import type { BackupFile } from '../data/types';
import { getLang, t } from '../i18n';
import { afterWrite, app } from './app';
import { confirmDialog, toast } from './components/overlay';
import { errorText } from './errors';

export const SNAPSHOT_PREFIX = 'snapshot-';
export const SNAPSHOTS_KEPT = 7;

export async function saveBackupCopy(): Promise<boolean> {
  try {
    const file = await app.repo.exportBackup();
    const name = `kadan-kanakku-backup-${todayIST(app.settings?.clock_offset_ms ?? 0)}.json`;
    await app.platform.shareFile(name, JSON.stringify(file), 'application/json', t('set.saveBackup'));
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
    const names = (await app.platform.listPrivateFiles(SNAPSHOT_PREFIX)).filter((n) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
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

/** Read, validate, confirm (strongly) and import a backup file. Returns true if data was replaced. */
export async function restoreFromFile(file: File): Promise<boolean> {
  let parsed: BackupFile;
  try {
    const text = await readFileText(file);
    parsed = JSON.parse(text) as BackupFile;
    validateBackup(parsed);
  } catch (e) {
    console.warn('[backup] invalid file', e);
    toast(t('err.BAD_BACKUP'), { error: true });
    return false;
  }
  const exported = typeof parsed.exported_at === 'string' && !Number.isNaN(Date.parse(parsed.exported_at))
    ? formatDay(bizDateIST(new Date(parsed.exported_at)), getLang())
    : '?';
  const ok = await confirmDialog({
    title: t('set.restoreConfirmTitle'),
    message: t('set.restoreConfirm', { date: exported, c: parsed.customers.length, e: parsed.entries.length }),
    ok: t('set.restoreYes'),
    danger: true,
  });
  if (!ok) return false;
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
