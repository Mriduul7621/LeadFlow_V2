# Android app (Capacitor, remote-load)

LeadFlow ships as an installable Android app built with **Capacitor**:
the shell loads the **live production LeadFlow** in the device's
WebView (`https://lead-flow-jet.vercel.app`). The APK contains no copy
of the web app — every installed app always runs the current web app,
so **a UI change needs no new APK** (the shell only changes when the
shell itself changes: icon, config, native fixes).

This reverses the previous architecture deliberately. The old app
(PR #84, Oct 2026) bundled the built web assets inside the APK, which
meant every UI change needed a rebuild + redistribute — and LeadFlow's
web layer ships several times a day. Remote-load is also the
zero-change option: the client already calls `/api/*` relative
same-origin and the CORS middleware already passes same-origin traffic
untouched, so no web or server change was needed. The full history and
the audit are in `docs/ANDROID_RELEASE.md` and the Phase 1 audit in
the goal workspace (`files/leadflow-android/`).

## Get the release APK

- **Download link (permanent, never changes):**
  https://github.com/Mriduul7621/LeadFlow_V2/releases/download/latest/leadflow-android-latest.apk
- **Or build artifacts:** Actions tab → "Android release APK" run →
  artifact `leadflow-android-<version>-<code>` (valid 90 days).

The workflow runs **only on manual dispatch** (Actions → Android
release APK → Run workflow) — no APK is ever produced by accident.
Each run publishes the signed APK to the rolling `latest` GitHub
release and uploads it as a workflow artifact. The run summary prints
the version and SHA-256.

**The download link only works after the first workflow run** — until
then the `latest` release does not exist and the URL 404s.

## What the app is, and what it needs

| Piece | Where |
|---|---|
| Capacitor config | `capacitor.config.ts` (`appId` `com.shantalife.leadflow`, `server.url` production) |
| Shell (committed) | `android/` — generated once with `npx cap add android`, then edited (signing, version, theme) |
| Offline screen | `android-web/index.html` (EN + BN, Retry + auto-recover; the only local page) |
| Launcher icons | generated in CI from `public/icon.svg` (`npm run android:assets`) — never committed |
| Version | `android/version.properties` (`versionCode 1`, `versionName 1.0.0` first release) — never `github.run_number` |
| Signing key | release keystore, offline with Mahadi + base64 in GitHub Secrets (`LEADFLOW_KEYSTORE_*`) |
| Library | `@capacitor/android` + `@capacitor/core` 8.x + `@capacitor/app` (back button) |

**The APK needs network access.** The app itself is the live web app;
with no connection the shell shows the no-connection screen instead of
a blank WebView.

### What the shell does (and does not do)

- ✅ Loads the live web app; sign-in and session work exactly as in
  the browser (the session lives in `localStorage` and survives
  killing + relaunching the app).
- ✅ Android back button walks the router history; exits only at the
  app root.
- ✅ WhatsApp (`wa.me`) opens in the system browser and deep-links
  into WhatsApp — never inside the WebView.
- ✅ File uploads open the system file chooser.
- ⚠️ **Web Push reminders do not fire inside the app** — `PushManager`
  does not exist in an Android WebView, so the opt-in shows as
  unavailable. Same as the old app; native push (FCM) is a future
  scope decision, not release 1.
- ⚠️ **Blob downloads (Excel/PDF export) are the one behaviour to
  verify on a device** — a plain WebView may silently swallow them.
  See the smoke test in `docs/ANDROID_RELEASE.md` §7.

### The old debug app (migration, one time)

The previous app (`com.saudalmahi.leadflow`) was signed with a debug
keystore that was **committed to this public repo** — compromised by
publication. No release-signed build can update those installs in
place, so the release app is a **new app id** and every holder of the
old app uninstalls it once, installs the new APK, and signs in again.
The old debug workflow (`.github/workflows/android-debug-apk.yml`) is
retired in the same change window — Mahadi deletes it via the web UI
(the GitHub App cannot delete workflow files).

## Verifying a build

```bash
# 1. the signature verifies and the signer is the release keystore
apksigner verify app-release.apk
apksigner verify --print-certs app-release.apk | grep SHA-256

# 2. the version matches the checked-in version source
aapt2 dump badging app-release.apk | head -1
grep -E '^(versionCode|versionName)=' android/version.properties
```

All three are checked automatically in CI before the APK is published
(the fingerprint compare normalises both sides — apksigner prints
lowercase without colons, keytool uppercase with colons).

## The branded domain (`app.saudalmahi.com`)

Not needed for the app to work. The shell loads the live Vercel URL,
which is what the whole field force already uses in the browser. The
branded domain remains an open hosting item (Vercel → Project →
Settings → Domains → Add, then DNS at the registrar), not an app item.
`public/.well-known/assetlinks.json` names the new package id; its
fingerprints list is empty until the first release build records the
release keystore's fingerprint there.
