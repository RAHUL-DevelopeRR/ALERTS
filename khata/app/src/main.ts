/**
 * Boot: loading gate -> openRepo() -> platform() -> sync engine -> onboarding or PIN lock -> home.
 * A database failure shows a full-screen error with "Copy details" (how the developer debugs a real phone).
 */
import './styles/app.css';
import { openRepo } from './data/index';
import { platform } from './platform/index';
import { createSyncEngine } from './sync/index';
import { t } from './i18n';
import { app, refreshSettings } from './ui/app';
import { snapshotIfDue } from './ui/backup';
import { h } from './ui/components/dom';
import { dismissTopLayer, toast } from './ui/components/overlay';
import { closeGate, gateHandleBack, gateOpen, isLocked, lock, logo, showGate } from './ui/gate';
import * as router from './ui/router';
import { customerScreen } from './ui/screens/customer';
import { customerEditScreen } from './ui/screens/customer-edit';
import { dayBookScreen } from './ui/screens/daybook';
import { entryScreen } from './ui/screens/entry';
import { homeScreen } from './ui/screens/home';
import { runOnboarding } from './ui/screens/onboarding';
import { quickScreen } from './ui/screens/quick';
import { settingsScreen } from './ui/screens/settings';
import { statementScreen } from './ui/screens/statement';
import { APP_VERSION } from './ui/version';

function errorDetails(e: unknown, stage: string): string {
  const err = e as { name?: string; code?: string; message?: string; stack?: string } | null;
  return [
    `Kadan Kanakku ${APP_VERSION} — ${stage}`,
    `time: ${new Date().toISOString()}`,
    `error: ${err?.name ?? typeof e}${err?.code ? ` [${err.code}]` : ''}: ${err?.message ?? String(e)}`,
    `ua: ${navigator.userAgent}`,
    err?.stack ? `stack:\n${err.stack}` : '',
  ].filter(Boolean).join('\n');
}

async function copyFallback(text: string): Promise<void> {
  try {
    await platform().copyText(text);
    return;
  } catch {
    /* fall through */
  }
  const ta = h('textarea', { style: { position: 'fixed', top: '-1000px' } });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    ta.remove();
  }
}

function showBootError(e: unknown, stage: string): void {
  console.error('[boot] failed at', stage, e);
  const details = errorDetails(e, stage);
  const copy = h('button', { class: 'btn btn-primary btn-big btn-block', attrs: { type: 'button', 'data-testid': 'copy-details' }, text: t('boot.copyDetails') });
  copy.addEventListener('click', () => {
    void copyFallback(details).then(() => toast(t('common.copied')), () => undefined);
  });
  showGate(
    'boot-error',
    h('h1', { text: t('boot.failed') }),
    h('p', { style: { marginBottom: '12px' }, text: t('boot.failedHelp') }),
    h('pre', { attrs: { 'data-testid': 'boot-error' }, text: details }),
    h('div', 'gate-spacer'),
    copy,
    h('button', { class: 'btn btn-block', style: { marginTop: '10px' }, attrs: { type: 'button' }, text: t('boot.retry'), on: { click: () => location.reload() } }),
  );
}

function registerScreens(): void {
  router.registerScreen('home', homeScreen);
  router.registerScreen('customer', customerScreen);
  router.registerScreen('customer-edit', customerEditScreen);
  router.registerScreen('entry', entryScreen);
  router.registerScreen('daybook', dayBookScreen);
  router.registerScreen('statement', statementScreen);
  router.registerScreen('settings', settingsScreen);
  router.registerScreen('quick', quickScreen);
}

/** Back: gate, then the top dialog/sheet, then the screen stack. At the root it is NOT consumed, so the platform
 *  minimises the app (moveTaskToBack) instead of finishing the activity: coming back is then a warm resume, not a
 *  cold boot with WebView reload, DB open, PIN and sync restart. */
function onBack(): boolean {
  if (gateOpen()) return gateHandleBack();
  if (dismissTopLayer()) return true;
  return router.back();
}

async function lockNow(): Promise<void> {
  await lock((pin) => app.repo.verifyPin(pin));
}

async function boot(): Promise<void> {
  const host = document.getElementById('app')!;
  showGate('boot', logo(), h('div', 'spinner'), h('p', { text: t('app.loading') }));

  let stage = 'platform';
  try {
    app.platform = platform();
    stage = 'database';
    const { repo, db } = await openRepo();
    app.repo = repo;
    app.db = db;
    stage = 'settings';
    await refreshSettings();
    stage = 'sync';
    app.sync = createSyncEngine(repo, app.platform);
  } catch (e) {
    showBootError(e, stage);
    return;
  }

  registerScreens();
  router.mountRouter(host);
  app.platform.onBackButton(() => onBack());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') onBack();
  });

  // Lock after `lock_timeout_min` in the background.
  let hiddenAt: number | null = null;
  app.platform.onAppStateChange((active) => {
    if (!active) {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    void snapshotIfDue();
    if (app.settings?.pin_set && !isLocked() && away >= app.settings.lock_timeout_min * 60_000) {
      void lockNow().then(() => router.rerender());
    }
  });

  try {
    const onboarded = await app.repo.getMeta('onboarded');
    if (!onboarded) {
      closeGate();
      await runOnboarding();
    } else if (app.settings.pin_set) {
      closeGate();
      await lockNow();
    }
    closeGate();
    await router.reset('home', { fresh: '1' });
  } catch (e) {
    showBootError(e, 'start');
    return;
  }

  try {
    app.sync.start();
  } catch (e) {
    console.error('[boot] sync start failed', e);
  }
  void snapshotIfDue();
}

window.addEventListener('unhandledrejection', (ev) => console.error('[unhandled]', ev.reason));
void boot();
