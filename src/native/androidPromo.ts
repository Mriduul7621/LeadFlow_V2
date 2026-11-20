/**
 * androidPromo.ts — the Android-app download promo (web app only).
 * ------------------------------------------------------------------
 * The LeadFlow Android APK is published to a rolling `latest` GitHub
 * release on every Android workflow dispatch (see
 * .github/workflows/android.yml). The downloaded file carries the app
 * name + version — "LeadFlow-V-1.0.0.1.apk" (Mahadi 2026-11-21) —
 * so the asset name changes with every version.
 *
 * THE DOWNLOAD URL IS ONE CONSTANT — `ANDROID_APK_DOWNLOAD_URL` below.
 * It points at LeadFlow's own download route, which redirects to the
 * newest .apk asset in `latest` (see server/routes/downloadApk.ts).
 * The route is same-origin, so the constant works on preview and on
 * production, never changes across versions, and never 404s through
 * a version change. The download itself is public — no login needed
 * (the repo is public). The popup and the login link both read this
 * one constant, so the download destination changes in exactly one
 * place if it ever moves.
 *
 * SEQUENCING: until the first workflow run publishes the first
 * `latest` release, the route lands on the releases page instead —
 * ship the promo and run the workflow before telling users about the
 * download (docs/ANDROID_RELEASE.md §6).
 *
 * Visibility rules (all of them, in one place — the component and the
 * login link both read this module, and the tests pin it):
 *
 *   - Android browsers ONLY (user-agent contains "Android").
 *   - NEVER inside the Capacitor app (Capacitor.isNativePlatform()).
 *   - NEVER on iOS (an iOS user-agent never contains "Android", so the
 *     Android check alone excludes it — but the rule is stated and
 *     tested explicitly).
 *   - The popup shows once per user: dismissing it (× or Download)
 *     writes a versioned localStorage flag, and it never shows again.
 *     Bump the key suffix to re-show the promo for a future release.
 *
 * This module is deliberately free of React and Capacitor imports so the
 * decision logic is unit-testable under node:test (see
 * server/tests/android-app-promo.test.ts). The native-platform check
 * lives in the components, which pass the result in.
 */

/**
 * THE download URL for the latest LeadFlow Android APK — the popup and
 * the login link both read this one constant.
 *
 * LeadFlow's own download route (same-origin relative — works on
 * preview and on production). It redirects to the newest .apk asset
 * in the public `latest` GitHub release, served under its friendly
 * stored name ("LeadFlow-V-<versionName>.<versionCode>.apk"). The
 * download is public — no login needed (the repo is public) — and
 * the URL never changes across versions.
 */
export const ANDROID_APK_DOWNLOAD_URL = '/api/download-apk';

/**
 * localStorage flag for "the user dismissed the Android promo".
 * Versioned: bump the suffix to re-show the promo for a future release.
 */
export const ANDROID_PROMO_DISMISSED_KEY = 'leadflow-android-promo-dismissed-v1';

/** True when the user-agent belongs to an Android browser. */
export function isAndroidBrowser(userAgent: string): boolean {
  return /Android/i.test(userAgent);
}

/** True when the user-agent belongs to an iOS device. */
export function isIosDevice(userAgent: string): boolean {
  return /iPhone|iPad|iPod/i.test(userAgent);
}

export interface AndroidPromoVisibility {
  /** navigator.userAgent (or '' when unavailable). */
  userAgent: string;
  /** Capacitor.isNativePlatform() — true inside the installed app. */
  isNative: boolean;
  /** Whether the user already dismissed the promo. */
  dismissed: boolean;
  /** Whether the user is signed in (the popup shows inside the app). */
  isAuthenticated: boolean;
}

/**
 * The popup's visibility rule, pure and total: Android browser + not
 * native + not dismissed + signed in. Every other combination hides it.
 */
export function shouldShowAndroidPromo(visibility: AndroidPromoVisibility): boolean {
  if (visibility.isNative) return false;
  if (visibility.dismissed) return false;
  if (!visibility.isAuthenticated) return false;
  if (!isAndroidBrowser(visibility.userAgent)) return false;
  if (isIosDevice(visibility.userAgent)) return false;
  return true;
}

/**
 * The login-page link's visibility rule: Android browser + not native.
 * No auth or dismissal gate — it is the fallback for users who dismissed
 * the popup or never saw it.
 */
export function shouldShowAndroidDownloadLink(userAgent: string, isNative: boolean): boolean {
  if (isNative) return false;
  if (!isAndroidBrowser(userAgent)) return false;
  if (isIosDevice(userAgent)) return false;
  return true;
}

/** Read the dismissal flag (false when storage is unavailable/locked). */
export function isAndroidPromoDismissed(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(ANDROID_PROMO_DISMISSED_KEY) === '1'
    );
  } catch {
    return false;
  }
}

/** Write the dismissal flag (no-op when storage is unavailable/locked). */
export function dismissAndroidPromo(): void {
  try {
    localStorage.setItem(ANDROID_PROMO_DISMISSED_KEY, '1');
  } catch {
    // Locked storage: the promo may show again next visit. Safe.
  }
}
