/**
 * Android back-button behaviour for the Capacitor shell — the one piece of
 * web-side code the Android app needs (besides the download promo).
 *
 * How it composes with the native side (verified against the Capacitor
 * 8.6.2 sources in node_modules, @capacitor/app AppPlugin.java):
 *
 * - The plugin registers an OnBackPressedCallback. When NO JS listener is
 *   registered it walks WebView history itself (`canGoBack() → goBack()`).
 * - When a JS listener IS registered (this module) the plugin notifies it
 *   instead, with the `canGoBack` flag. LeadFlow is a single-origin app
 *   (react-router-dom SPA), so `canGoBack` is false exactly at the app
 *   root — back there exits the app; anywhere else it walks back.
 *
 * The listener is (re-)registered on `pageshow` as well as on load, so a
 * page restored from the WebView's back-forward cache still exits on back
 * at the root instead of swallowing the press.
 *
 * Outside the app this module is inert: `Capacitor.isNativePlatform()`
 * is false in the browser and in the PWA, so the plugin is never even
 * imported there. The @capacitor/app import is dynamic — the web bundle
 * pays nothing for it on the web.
 */
import { Capacitor } from '@capacitor/core';

export function initAndroidBackButton(): void {
  if (!Capacitor.isNativePlatform()) return;

  let listener: { remove: () => Promise<void> } | null = null;

  const register = async (): Promise<void> => {
    try {
      const { App } = await import('@capacitor/app');
      // Drop any previous registration (pageshow can fire after load).
      await listener?.remove().catch(() => undefined);
      listener = await App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) {
          window.history.back();
        } else {
          // App root: the only place back exits the app.
          void App.exitApp();
        }
      });
    } catch {
      // No plugin (should not happen in the shipped shell) — the native
      // plugin fallback still walks WebView history; only the exit-at-root
      // behaviour is lost, which is safe.
    }
  };

  void register();
  // Back-forward-cache restores do not re-run this module; re-register.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void register();
  });
}
