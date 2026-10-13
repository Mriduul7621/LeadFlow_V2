# LeadFlow Android Debug APK

This workflow builds an installable **debug APK** for controlled pilot testing. It is not a Play Store/release build and is not signed with a production release key.

## What this APK does

- Installs as **LeadFlow** (com.shantalife.leadflow).
- Opens the hosted LeadFlow app over HTTPS at the URL in capacitor.config.ts.
- Uses the existing hosted API; business data and credentials are not bundled into the APK.
- Requires an internet connection. It is not an offline app.

## Build the APK

1. Open the repository Actions tab on GitHub.
2. Select **LeadFlow Android Debug APK**.
3. Select **Run workflow** on branch android-debug-apk.
4. Wait for the **Build Android debug APK** job to succeed.
5. Download the **LeadFlow-Android-Debug-APK** artifact and extract app-debug.apk.
6. Transfer the APK to an Android test device and allow installation from that file source when prompted.

A push to the android-debug-apk branch that changes relevant web/build files also triggers the workflow. Artifacts are retained for 14 days.

## Important access check before sharing

The configured host must be reachable from the tester device without a Vercel SSO/protection interstitial. If the deployment is protected, use an organization-approved public/custom domain or an approved protection-bypass approach before distributing the APK. Do not disable access protection or expose private business data just to make the APK work.

## Before a pilot

- Verify the app opens on a clean Android device and login works.
- Verify API requests succeed from the WebView.
- Test role-based access and data visibility with dedicated test accounts and synthetic leads.
- Do not use real customer information until the authorization and data-access tests pass.
