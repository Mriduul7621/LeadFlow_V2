# Android APK (Trusted Web Activity)

LeadFlow ships as a **TWA** — a thin, zero-webview Android wrapper that opens
`https://app.saudalmahi.com` full-screen with the Shanta Life brand icon.

## Get the debug APK

- **Release page (permanent link):**
  https://github.com/Mriduul7621/LeadFlow_V2/releases/tag/android-debug
- **Or build artifacts:** Actions tab → "Android Debug APK (TWA)" run →
  artifact `leadflow-debug-apk` (valid 30 days).

The workflow runs automatically on every push to `main` and can be started
manually any time via **Actions → Android Debug APK (TWA) → Run workflow**.

## How it's put together

| Piece | Where |
|---|---|
| Gradle project | `android/`
| App / package | `com.saudalmahi.leadflow`, `Shanta Life LeadFlow` |
| Website it opens | `https://app.saudalmahi.com` (`DEFAULT_URL` in `AndroidManifest.xml`) |
| Launcher icons | `android/app/src/main/res/mipmap-*` (Shanta Life logo, legacy + adaptive) |
| Debug signing key | `android/app/debug.keystore` (standard `android`/`androiddebugkey`, PKCS#12) |
| Library | `com.google.androidbrowserhelper:androidbrowserhelper:2.5.0` |

## Address-bar hiding (Digital Asset Links)

`public/.well-known/assetlinks.json` is served with the web app and already
contains the debug certificate fingerprint:

```
85:9B:81:1A:D0:C2:4E:83:C3:DC:62:02:48:AC:65:E8:E6:7F:81:48:37:38:38:0F:8E:63:23:76:8A:04:D1:AC
```

Once the site deploys that file, App Links verify automatically and the APK
opens the app **without any address bar**. Until then it opens as a full
Custom Tab (also fine for internal testing).

## Release builds later

Swap `android/app/debug.keystore` for the production signing key (keep it as
a GitHub Actions secret + base64), then add the release cert fingerprint as a
second entry in `public/.well-known/assetlinks.json`. Both entries may coexist.
