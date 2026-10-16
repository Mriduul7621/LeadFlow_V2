# Android app (Capacitor)

LeadFlow ships as an installable Android app built with **Capacitor**: the built
web app is packaged **inside the APK** and rendered in the device's WebView.
Opening it does **not** depend on any domain resolving — the shell always
starts.

The previous wrapper was a **Trusted Web Activity** (a shell that opened a
remote URL). It looked fine in CI and was broken on a phone: the URL it opened
(`app.saudalmahi.com`) had no DNS, a TWA has no fallback, so the launcher showed
the browser's error page. A bundled app cannot fail that way. The trade-off is
stated below and is the reason this file exists.

## Get the debug APK

- **Release page (permanent link):**
  https://github.com/Mriduul7621/LeadFlow_V2/releases/tag/android-debug
- **Or build artifacts:** Actions tab → "Android Debug APK (Capacitor)" run →
  artifact `leadflow-debug-apk` (valid 30 days).

The workflow runs automatically on every push to `main` and can be started
manually any time via **Actions → Android Debug APK (Capacitor) → Run workflow**.

Every published APK gets `versionCode = <workflow run number>`, so a new build
always installs **over** an older one (Android refuses an update whose
`versionCode` is not higher). It is signed with the committed debug key
(`branding/android/debug.keystore`), the same certificate the previous wrapper
used — so it upgrades the app already on the phone instead of refusing to
install next to it.

## What the app is, and what it needs

| Piece | Where |
|---|---|
| Capacitor config | `capacitor.config.ts` (`appId` `com.saudalmahi.leadflow`, `webDir` `dist`) |
| Bundled web assets | built by `npm run build:web` (Vite only — the server bundle is not shipped in the APK) |
| API origin | baked at build time from `VITE_API_BASE_URL` (see `src/lib/apiBase.ts`); the workflow default is the live production URL |
| Launcher icons | `branding/android/res/` (copied over the generated project by CI) |
| Signing key | `branding/android/debug.keystore` (standard `android` / `androiddebugkey`, PKCS#12) |
| Library | `@capacitor/android` + `@capacitor/core` (generated platform: `npx cap add android`) |

**The APK needs network access to its API origin.** The app itself loads
instantly from the bundle; every screen then talks to
`https://<api_base>/api/...`.

### Why this shape (and its price)

- ✅ Opens on a device with no DNS dependency, no address bar, brand icon, SPA
  routing handled (Capacitor's local server falls back to `index.html` for
  paths without an extension).
- ⚠️ **A UI change needs a new APK.** The assets are bundled, not fetched.
  Publishing to `main` rebuilds and republishes automatically (~4–6 min), so the
  release link is always current.
- ⚠️ **The API origin is fixed at build time.** Pointing the app at another
  backend = run the workflow with a different `api_base` input.
- ⚠️ **The API must allow the WebView origin.** Capacitor serves the app from
  `https://localhost` inside the WebView, so cross-origin requests need CORS:
  `server/middleware.ts` allows `https://localhost`, `capacitor://localhost`
  and `http://localhost` (plus anything in `CORS_ALLOWED_ORIGINS`). Without it
  the app installs, opens, and fails on its first request.

### Switching the API origin

Run the workflow manually with `api_base = https://app.saudalmahi.com` (or any
origin that serves `/api`), or change `DEFAULT_API_BASE` in the workflow. The
run summary and the release page both print the origin the APK was built for,
and the build itself fails if the origin is not found inside the produced APK.

## Verifying a build

```bash
# 1. the app is bundled and knows its API origin
unzip -o app-debug.apk -d /tmp/apk
ls /tmp/apk/assets/public/index.html          # the web app is inside
grep -rlF "https://lead-flow-jet.vercel.app" /tmp/apk/assets/public/assets

# 2. the API answers that origin with CORS headers (run against the origin above)
curl -s -D - -o /dev/null -X OPTIONS https://<api_base>/api/db-status \
  -H "Origin: https://localhost" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization" | grep -i access-control
```

Both are checked automatically in CI: the bundle is grepped for the API origin
before Gradle runs, and again inside the produced APK before it is published.

## The branded domain (`app.saudalmahi.com`)

Not needed for the app to work — it is only relevant as the API origin (and for
the web app). To connect it: **Vercel → Project → Settings → Domains → Add**,
then create the DNS records the dashboard shows at the `saudalmahi.com`
registrar. `public/.well-known/assetlinks.json` is kept so an App Links / TWA
setup remains possible later; it is not used by the Capacitor build.

## Release builds later

Swap `branding/android/debug.keystore` for a production key (keep it as a
GitHub Actions secret + base64) and update the signing block in the workflow.
The `appId` must stay `com.saudalmahi.leadflow` to remain the same app on
devices that already installed it.
