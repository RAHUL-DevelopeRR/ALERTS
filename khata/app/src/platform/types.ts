/**
 * Everything the UI needs from the device, behind one interface so the same UI runs in the browser preview
 * (src/platform/web.ts) and on Android (src/platform/native.ts, Capacitor plugins).
 * Get the active implementation with `platform()` from src/platform/index.ts.
 */
export interface Platform {
  readonly isNative: boolean;
  /** Open an external URI: https://wa.me/..., smsto:..., tel:..., upi://... Resolves false if no app handles it. */
  openExternal(uri: string): Promise<boolean>;
  /** Android share sheet with plain text. */
  shareText(text: string, title?: string): Promise<void>;
  /** Write `content` to a cache file and open the share sheet (Drive, WhatsApp, Files...). */
  shareFile(fileName: string, content: string, mimeType: string, title?: string): Promise<void>;
  /** Copy to clipboard. */
  copyText(text: string): Promise<void>;
  /** App-private persistent files (rolling local snapshots). */
  writePrivateFile(name: string, content: string): Promise<void>;
  readPrivateFile(name: string): Promise<string | null>;
  listPrivateFiles(prefix: string): Promise<string[]>;
  deletePrivateFile(name: string): Promise<void>;
  /** Keystore-backed secret storage (device token). Web preview uses localStorage. */
  secretGet(key: string): Promise<string | null>;
  secretSet(key: string, value: string | null): Promise<void>;
  /** Online status + change events (used to trigger sync). */
  isOnline(): Promise<boolean>;
  onOnlineChange(cb: (online: boolean) => void): () => void;
  /** App foreground/background (used for the PIN lock timeout and foreground sync). */
  onAppStateChange(cb: (active: boolean) => void): () => void;
  /** Android back button; return true from the handler if it was consumed. Default: minimise app. */
  onBackButton(cb: () => boolean): () => void;
  /** Short vibration on save (no-op on web). */
  hapticTap(): Promise<void>;
  /** Device model, e.g. "Redmi Note 12" (used as default device name). */
  deviceModel(): Promise<string>;
  /** Hide the soft keyboard. */
  hideKeyboard(): Promise<void>;
  /** Exit the app (Android); no-op on web. */
  exitApp(): Promise<void>;
}
