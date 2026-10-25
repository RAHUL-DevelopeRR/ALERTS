declare const __NATIVE_BUILD__: boolean;

interface ImportMetaEnv {
  /** The shop server this APK was built for (tools/build-release-apk.sh SHOP_SERVER_URL=...); empty: typed at sign-in. */
  readonly VITE_SHOP_SERVER_URL?: string;
}
