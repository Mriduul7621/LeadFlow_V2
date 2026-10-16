import type { CapacitorConfig } from '@capacitor/cli';

/**
 * capacitor.config.ts — the Android app is the WEB APP, bundled.
 * ------------------------------------------------------------------
 * The previous wrapper was a Trusted Web Activity: a shell that opened a remote
 * URL, which meant the app was only as alive as that host's DNS. It was not —
 * the launcher showed the browser's error page and the install looked broken.
 *
 * This configuration bundles the built web assets INSIDE the APK instead
 * (`webDir: 'dist'`), so the shell always starts: no domain has to resolve for
 * the app itself to open. Only the API is remote, and where it lives is baked
 * into the bundle by `VITE_API_BASE_URL` at build time (src/lib/apiBase.ts) —
 * the CI workflow passes the live production origin.
 *
 * Consequences worth stating plainly, because they are the price of this:
 *   - UI changes ship with a NEW APK (the assets are not fetched from the web);
 *   - the API origin is fixed at build time — pointing the app at another
 *     backend is a rebuild with a different `api_base` input;
 *   - the API must allow the WebView origin (see the CORS middleware in
 *     server/middleware.ts; the WebView runs as https://localhost).
 *
 * `appId` and `appName` match what the product already ships, so an install of
 * this build REPLACES the previous wrapper (same package, higher versionCode)
 * instead of sitting next to it.
 */
const config: CapacitorConfig = {
  appId: 'com.saudalmahi.leadflow',
  appName: 'Shanta Life LeadFlow',
  webDir: 'dist',
  // Bundled assets are served to the WebView from https://localhost. Keeping
  // the https scheme (the Capacitor default) means the page is a secure
  // context — service workers, clipboard and geolocation APIs behave the same
  // way they do on the web deployment.
  server: {
    androidScheme: 'https',
  },
  android: {
    // The API is https; mixed content stays off so a mistaken http:// base
    // fails loudly in development instead of being silently downgraded.
    allowMixedContent: false,
  },
};

export default config;
