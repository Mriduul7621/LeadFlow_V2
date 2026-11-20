# LeadFlow — Android release guide

How the Android APK is signed, built and released. Read alongside the
Phase 1 audit (`ANDROID_AUDIT.md`) and checklist
(`ANDROID_CHECKLIST.md`) in the goal workspace
(`files/leadflow-android/`).

## The one thing that must never be lost: the release keystore

Android identifies an app by **package id + signing key**. An update
installs in place only if it carries the **same signer** and a higher
`versionCode`. If the release keystore is lost, no future APK can ever
update the installed app — every employee would have to uninstall and
reinstall.

LeadFlow already lived the bad version of this: the old debug app
(`com.saudalmahi.leadflow`) was signed with a debug keystore that was
**committed to this public repo** — compromised by publication, not by
a leak. Anyone could sign an update to it. That is why the release app
is a **new app id** (`com.shantalife.leadflow`) with a **new key**, and
why the old app is uninstalled from field phones instead of updated
(§5).

So: **one keystore, created once, kept in two places** — an offline copy
with the named custodian (Mahadi), and a base64 copy in GitHub Secrets
for CI. The keystore file and its passwords are **never committed** to
the repo, never pasted into chat, and never emailed.

## 1. Create the keystore (Mahadi, once, on his own machine)

Needs a JDK: install **Temurin 21** from <https://adoptium.net> (the
`.msi`, default options) — `keytool` then works in Git Bash. Run in Git
Bash, in a folder only he controls:

```bash
keytool -genkeypair \
  -keystore leadflow-release.keystore \
  -alias leadflow-release \
  -keyalg RSA -keysize 2048 -validity 9125 \
  -dname "CN=Shanta Life Insurance PLC, OU=Training and Development, O=Shanta Life Insurance PLC, L=Dhaka, ST=Dhaka, C=BD" \
  -storepass "<CHOOSE-A-STRONG-PASSWORD>" \
  -keypass "<SAME-PASSWORD>"
```

Notes:

- `-validity 9125` = 25 years. The key must outlive the app — Android
  refuses to install an update signed by an expired key.
- Store password and key password are the same value here (standard for
  a single-purpose keystore). Choose one strong password and keep it
  **separate from the file** (password manager, or written down
  somewhere other than where the file lives).
- Check it worked:
  `keytool -list -v -keystore leadflow-release.keystore -alias leadflow-release`
  — it prints the certificate, including its SHA-256 fingerprint. That
  fingerprint is public material (it identifies the key, it cannot sign
  anything) — record it in the handover so any APK's signer can be
  checked against it, and add it to
  `public/.well-known/assetlinks.json` (the fingerprints list is
  deliberately empty until the first release build records it).

Then:

1. **Offline backup:** copy `leadflow-release.keystore` to protected
   storage (encrypted USB / secure drive — not left on the Desktop).
   This copy is the recovery path if GitHub Secrets are ever lost.
2. **GitHub Secrets:** in Git Bash,
   `base64 -w0 leadflow-release.keystore | clip` copies the base64 of
   the file. In the repo → Settings → Secrets and variables → Actions →
   New repository secret, create these four (values only — the names
   are what the workflow reads):
   - `LEADFLOW_KEYSTORE_B64` — the base64 just copied
   - `LEADFLOW_KEYSTORE_PASSWORD` — the password
   - `LEADFLOW_KEY_ALIAS` — `leadflow-release`
   - `LEADFLOW_KEY_PASSWORD` — the same password
3. Delete the working copy of the `.keystore` file from the machine it
   was made on once the offline backup + the secret are confirmed.

**Current state (2026-11-21):** Mahadi created the release keystore
offline and set all four `LEADFLOW_KEYSTORE_*` secrets. The fingerprint
is recorded after the first release build (the workflow run summary
prints it).

## 2. Get the workflow into the repo (Mahadi, once)

`.github/workflows/android.yml` is prepared locally, but the Muse
GitHub App **cannot push workflow files** (deterministic 403 — the App
lacks `workflows: write`). Two routes:

1. **Mahadi uploads it** via the github.com web UI (repo → Add file →
   Upload files, onto `main`), or
2. **Mahadi grants the App the Workflows permission** in the
   installation settings, after which the prepared file can be pushed
   normally.

Do not retry a connector push of a workflow file — it cannot succeed.

**In the same change window, retire the old debug workflow:**
`.github/workflows/android-debug-apk.yml` rebuilds and republishes a
**debug-signed** APK on every push to `main`. Leaving it live next to
the release pipeline ships two signers — an installer could pick up
the debug build by mistake. Mahadi deletes that file via the web UI
(the same permission constraint applies to deleting workflow files).
Confirm on the Actions tab afterwards that no debug run is scheduled
or running.

**Note:** the debug workflow's next run after the release shell merges
will fail — it signs with `branding/android/debug.keystore`, which the
release shell removes from the tree. That failure is expected (the
retired pipeline dying); deleting the workflow file stops it.

## 3. Build a release (any release operator)

1. Bump the version first: edit `android/version.properties`
   (`versionCode` +1 exactly, `versionName` per the release) and commit
   it on `main`. The version is owned by this file, never by CI.
2. GitHub → Actions → **Android release APK** → Run workflow.
3. The run: installs Node 22 + JDK 21 + Gradle 8.14.3 + Android SDK 36,
   regenerates the launcher icons, syncs the Capacitor shell, restores
   the keystore from secrets, builds the signed release APK, then
   verifies it — signature valid, signer fingerprint matches the
   keystore (never a debug key), version matches `version.properties` —
   then publishes the APK to the rolling `latest` GitHub release (see
   §6) and uploads the same APK + its `.sha256` as a workflow artifact
   (90-day retention, backup only). The run summary prints the version,
   SHA-256 and the release link.
4. Distribute to the pilot group through the decided channel with the
   install instructions (§5) — the public download link is the rolling
   release (see §6), so there is nothing to re-send per version. The
   APK can also be archived outside Actions (Cloudinary raw file — the
   decided artifact home; Supabase Storage cannot carry release files).

## 4. Local builds (developers)

- Needs JDK 21 + Android SDK 36 + Gradle 8.14.3 installed locally (the
  Gradle wrapper jar is not committed — it is a binary; run
  `gradle wrapper --gradle-version 8.14.3` once if you want `./gradlew`).
- `npm ci && npm run android:assets && npx cap sync android`
- `gradle -p android :app:assembleDebug` — debug build, local
  validation only, **never distributed**. A release build needs the
  keystore injected from the custodian's copy via
  `LEADFLOW_KEYSTORE_PATH` (+ the three password/alias env vars) and
  the file must never be committed.

## 5. Version + update rules (the LH lessons, enforced) + migration

- `versionCode` only ever goes up, by exactly 1 per release. A lower
  code than the installed build is refused by Android
  (`INSTALL_FAILED_VERSION_DOWNGRADE`).
- Every release APK is signed by the **same** release keystore. A
  different signer is refused (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`).
- The first release is `versionCode 1`, `versionName 1.0.0`. It is a
  **new app id** (`com.shantalife.leadflow`) — a clean first install,
  nothing to outrank.
- **Migration from the old debug app (one time):** the old app
  (`com.saudalmahi.leadflow`, debug-signed) cannot update to the
  release signer. Every holder uninstalls the old LeadFlow first, then
  installs the new APK, then signs in again (the session does not
  survive an uninstall). Install instructions (Bangla + English) must
  carry this step — see the checklist's Phase 4.
- In-place update drill (before wider rollout): bump to `versionCode`
  2, build, install over the pilot build — it must update in place
  with data intact. If it does not, stop: the signing identity or the
  version is wrong.

## 6. GitHub Releases `latest` + the web download popup

Every dispatch publishes the APK to the rolling `latest` release
(public — no GitHub login needed to download). The downloaded file
carries the app name + version (Mahadi 2026-11-21):
`LeadFlow-V-1.0.0.1.apk` — `LeadFlow-V-<versionName>.<versionCode>.apk`,
set by the workflow's Publish step (the `.sha256` file carries the
same base name). Dashes, not spaces: GitHub turns spaces into dots in
release asset names (verified live on the Agent Hub), so a spaced
name would be served with dots. Because the asset name changes with
every version,
the web app does NOT link to GitHub directly: from one constant
(`ANDROID_APK_DOWNLOAD_URL` in `src/native/androidPromo.ts`) it links
to LeadFlow's own download route:

`/api/download-apk`

The route (`server/routes/downloadApk.ts`) asks the GitHub Releases
API for the `latest` release and redirects to its newest `.apk`
asset, which GitHub serves under its friendly stored name — so the
LeadFlow link never changes across versions and never 404s through a
version change. `latest` holds exactly one APK: the workflow deletes
the previous version's `.apk`/`.apk.sha256` assets before uploading
the new one. If GitHub is unreachable or no release exists yet, the
route sends the user to the releases page instead of failing.

**Sequencing:** the popup's download link only works AFTER the first
workflow dispatch publishes the first `latest` release. Until that
run, the route lands on the releases page — so ship the popup and run
the workflow before telling users about the download.

**Popup behaviour:** when a user opens LeadFlow in a browser on an
Android phone (and is signed in), a one-time popup appears —
"Get the Android App", with the line "Install the app for one-tap
access from your home screen.", a Download button (plain link to
`/api/download-apk`; Android Chrome downloads the APK directly) and a
close control. Tapping Download also dismisses the popup. It never
shows inside the native app itself (Capacitor native-platform
detection), never on iOS, never on desktop. Dismissal is stored in
localStorage under the versioned key
`leadflow-android-promo-dismissed-v1` — bump the suffix to re-show
the promo for a future major release. The login page carries the same
link (small, Android-only, hidden in the native app) for users who
dismissed the popup or never saw it.

## 7. Device smoke test (before wider rollout)

Run on a pilot phone, against the release APK:

1. Fresh install; sign-in (real credentials); Home / leads /
   follow-ups load.
2. **Blob export tap** (the audit's top risk): export leads / a KPI
   report — does the `.xlsx` actually land in Downloads? A plain
   WebView may silently swallow blob downloads. If it fails, scope
   the native fix before wider rollout — do not ship around it.
3. wa.me tap opens **WhatsApp**, never inside the WebView.
4. File upload opens the system chooser and the file reaches the app.
5. Back button walks router history; exits only at the app root.
6. Kill + relaunch — still signed in (expected: the session lives in
   `localStorage`).
7. Airplane-mode launch shows the no-connection screen (EN + BN);
   Retry recovers when connectivity returns.
8. Push opt-in shows as unavailable in-app (expected — `PushManager`
   does not exist in a WebView), with no error and no broken toggle.
9. Install the same build over itself (same `versionCode` refuses —
   expected, not an update path).
