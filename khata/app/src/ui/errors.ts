/** Map RepoError / SyncError / ledger Error('CODE') to a localized sentence. */
import { RepoError } from '../data/types';
import { SyncError } from '../sync/types';
import { hasKey, t } from '../i18n';

export function errorCode(e: unknown): string | null {
  if (e instanceof RepoError || e instanceof SyncError) return e.code;
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  if (e instanceof Error && /^[A-Z_]+$/.test(e.message)) return e.message;
  return null;
}

export function errorText(e: unknown): string {
  const code = errorCode(e);
  if (code) {
    if (e instanceof SyncError || hasKey(`serr.${code}`)) {
      const k = `serr.${code}`;
      if (hasKey(k)) return t(k, { msg: e instanceof Error ? e.message : '' });
    }
    const k = `err.${code}`;
    if (hasKey(k)) return t(k);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return t('err.generic', { msg });
}

/** Localized label for a server reject reason ("DISCARDED:" prefix stripped). */
export function reasonText(reason: string): string {
  const r = reason.replace(/^DISCARDED:/, '');
  const k = `reason.${r}`;
  return hasKey(k) ? t(k) : r;
}
