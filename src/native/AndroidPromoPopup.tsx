import React from 'react';
import { Capacitor } from '@capacitor/core';
import { useAuthStore } from '../modules/auth/store/authStore';
import {
  ANDROID_APK_DOWNLOAD_URL,
  dismissAndroidPromo,
  isAndroidPromoDismissed,
  shouldShowAndroidPromo,
} from './androidPromo';

/**
 * AndroidPromoPopup — the one-time Android-app download popup.
 *
 * Shows once, shortly after the app opens, when the visibility rule in
 * ./androidPromo.ts holds (Android browser, not the native app, not
 * dismissed, signed in). Dismissing it (× or Download) writes the
 * versioned localStorage flag, so it never shows again. Mounted once in
 * App.tsx, outside the router, so it survives route changes.
 *
 * The Download button is a plain link to `ANDROID_APK_DOWNLOAD_URL`
 * (one constant in ./androidPromo.ts — the rolling `latest` GitHub
 * release asset, publicly downloadable). Android Chrome downloads the
 * APK directly. The URL only works after the first Android workflow
 * run publishes the first `latest` release
 * (docs/ANDROID_RELEASE.md §6).
 */
export default function AndroidPromoPopup(): React.ReactElement | null {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (!isInitialized) return;
    const show = shouldShowAndroidPromo({
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      isNative: Capacitor.isNativePlatform(),
      dismissed: isAndroidPromoDismissed(),
      isAuthenticated,
    });
    if (!show) return;
    const timer = window.setTimeout(() => setVisible(true), 1200);
    return () => window.clearTimeout(timer);
  }, [isInitialized, isAuthenticated]);

  const dismiss = React.useCallback(() => {
    dismissAndroidPromo();
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="android-promo-title"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 id="android-promo-title" className="text-lg font-bold text-[#263238]">
            Android app download koro
          </h2>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close"
            className="rounded-full px-2 text-xl leading-none text-[#788078] hover:text-[#263238]"
          >
            ×
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-[#575756]">
          LeadFlow ekhon Android app-e — home screen theke ek tap-e khulbe, ar browser-e khujte hobe na.
        </p>
        <a
          href={ANDROID_APK_DOWNLOAD_URL}
          onClick={dismiss}
          className="mt-4 block rounded-full bg-[#f37021] px-6 py-3 text-center text-base font-bold text-white hover:opacity-90"
        >
          Download
        </a>
        <p className="mt-3 text-center text-xs text-[#8a8a89]">
          Install korar shomoy “install unknown apps” allow korte hobe.
        </p>
      </div>
    </div>
  );
}
