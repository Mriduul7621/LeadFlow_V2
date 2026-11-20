import type { CapacitorConfig } from '@capacitor/cli';

/**
 * capacitor.config.ts — the Android app is the LIVE WEB APP, remote-loaded.
 * ------------------------------------------------------------------
 * History, briefly (see docs/ANDROID_RELEASE.md for the full story):
 *
 * - The first wrapper was a Trusted Web Activity opening app.saudalmahi.com.
 *   That host had no DNS, so the launcher showed the browser's error page.
 * - The second wrapper (PR #84, Oct 2026) bundled the built web assets
 *   INSIDE the APK (webDir `dist`) and baked the API origin in at build
 *   time. It fixed the DNS failure, but every UI change then needed a new
 *   APK — and LeadFlow's web layer ships several times a day.
 * - This configuration reverses that deliberately: the shell loads the live
 *   production LeadFlow in its WebView (`server.url`). The web layer ships
 *   constantly, so bundling would recreate the version-fragmentation problem
 *   the app-deployment programme exists to remove. Remote-load also needs
 *   zero code changes: the client calls `/api/*` relative same-origin
 *   (src/lib/apiBase.ts falls back to same origin when VITE_API_BASE_URL is
 *   unset) and the CORS middleware passes same-origin traffic untouched.
 *   `webDir` therefore holds only the minimal local error page
 *   (`android-web/`), shown when the remote load fails — never a copy of
 *   the app. `server.url` MUST be the production URL, never a preview.
 *
 * Identity (Mahadi, 2026-11-21): this is a NEW app, not an update to the
 * old debug build. The old app (`com.saudalmahi.leadflow`) was signed with
 * a debug keystore that was committed to this public repo — compromised by
 * publication — so no release-signed build can ever update those installs
 * in place. The new app id is `com.shantalife.leadflow`; the old app is
 * uninstalled from field phones (see docs/ANDROID_RELEASE.md §5). The
 * package id can never change after the first release.
 *
 * - `server.androidScheme: 'https'` is BLOCKING: the page must be a secure
 *   context (service worker registration, clipboard, secure-context APIs).
 *   A non-HTTPS scheme would break those on every launch.
 *
 * - `server.allowNavigation` is EMPTY — deliberately. LeadFlow is a
 *   single-origin app: everything the user navigates to lives on
 *   lead-flow-jet.vercel.app. The only external navigation is wa.me
 *   (WhatsApp, opened via target="_blank"), which must open in the system
 *   browser and deep-link into WhatsApp — never inside the WebView. Never
 *   add wa.me (or any wildcard) here.
 *
 * - `server.errorPath` is the built-in no-connection screen: on a
 *   main-frame load error Capacitor loads this local page (served from the
 *   synced `webDir` at https://localhost/) instead of a blank WebView.
 *   The page's Retry is a full navigation to the live URL, which also
 *   clears any stale deployment the WebView was pinned to.
 *
 * - Back button: the @capacitor/app plugin walks WebView history natively
 *   when no JS listener is registered, and the web app registers a
 *   listener (src/native/backButton.ts) that exits only at the app root.
 *   Back never closes the app on first press.
 */
const config: CapacitorConfig = {
  appId: 'com.shantalife.leadflow',
  appName: 'Shanta Life LeadFlow',
  webDir: 'android-web',
  android: {
    allowMixedContent: false,
    backgroundColor: '#F7F7F2',
  },
  server: {
    url: 'https://lead-flow-jet.vercel.app',
    androidScheme: 'https',
    errorPath: 'index.html',
  },
};

export default config;
