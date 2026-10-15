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

Every published APK gets `versionCode = <workflow run number>`, so a new build
can always be installed **over** an older one. Android refuses an update whose
`versionCode` is not higher, so if you ever install an APK built by hand
(default code `1`), uninstall once before installing a CI build.

**Web-only changes need no new APK.** The wrapper is a shell: it opens the
deployed site, so status renames, dashboard changes and any other UI work
appear as soon as Vercel is serving the new build. A rebuild is only needed
when something inside `android/` changes (host, icon, label, libraries).

## How it's put together

| Piece | Where |
|---|---|
| Gradle project | `android/`
| App / package | `com.saudalmahi.leadflow`, `Shanta Life LeadFlow` |
| Website it opens | `https://app.saudalmahi.com` — `DEFAULT_URL` + the App Links host come from the `${appHost}` manifest placeholder (`-PappHost=…`, default branded domain) |
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

## Prerequisite: the host must be live

The wrapper opens `https://app.saudalmahi.com`. Two things must be true for
that to work, and both are hosting actions, not code:

1. the domain is added to the Vercel project (**Vercel → Project → Settings →
   Domains → Add**, then the CNAME/A records at the registrar), and
2. the deployment serves the app there (so `https://app.saudalmahi.com/` loads
   the SPA and `/.well-known/assetlinks.json` returns JSON).

`saudalmahi.com` / `app.saudalmahi.com` currently do not resolve, so an APK
built for the branded host shows only the browser error page until step 1 is
done. **Workaround while the domain is pending:** run the workflow manually
with `host = lead-flow-jet.vercel.app` (Actions → Run workflow → host). That
build opens the already-live Vercel URL and is fully usable for internal
testing; the site-side `assetlinks.json` is host-independent (it names the
package + signing certificate only), so App Links verify there too.

## Verifying a build

```bash
# 1. the site serves the statement (must be JSON, not the SPA's index.html)
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  https://<host>/.well-known/assetlinks.json

# 2. the statement's fingerprint matches the key that signed the APK
keytool -printcert -file <extracted META-INF/CERT.RSA> | grep -i SHA256
```

Both are checked automatically in CI: the workflow compares the keystore
fingerprint with `public/.well-known/assetlinks.json` before it builds, and
prints the effective host + `versionCode` into the run summary.

The root `vercel.json` routes `{ "handle": "filesystem" }` first, so the static
`/.well-known/assetlinks.json` (copied into `dist/` by Vite) is served as a
file and is never swallowed by the SPA fallback.

## Release builds later

Swap `android/app/debug.keystore` for the production signing key (keep it as
a GitHub Actions secret + base64), then add the release cert fingerprint as a
second entry in `public/.well-known/assetlinks.json`. Both entries may coexist.
