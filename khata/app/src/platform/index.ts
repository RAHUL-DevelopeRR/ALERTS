/**
 * `platform()` returns the one Platform implementation for this run:
 * - Android build (`vite build --mode android`, __NATIVE_BUILD__ = true) or any Capacitor native runtime: native.ts.
 * - Browser preview (`npm run dev`): web.ts.
 * __NATIVE_BUILD__ is a compile-time constant, so the web implementation is tree-shaken out of the Android bundle.
 */
import { Capacitor } from '@capacitor/core';
import { createNativePlatform } from './native';
import type { Platform } from './types';
import { createWebPlatform } from './web';

export type { Platform } from './types';

let instance: Platform | null = null;

export function platform(): Platform {
  if (!instance) {
    instance = __NATIVE_BUILD__ || Capacitor.isNativePlatform() ? createNativePlatform() : createWebPlatform();
  }
  return instance;
}
