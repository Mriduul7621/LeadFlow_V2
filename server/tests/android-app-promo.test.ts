/**
 * android-app-promo.test.ts
 * ------------------------------------------------------------------
 * The Android-app download promo (web app only): a one-time popup on
 * Android browsers + a small download link on the login page.
 *
 * These tests pin the visibility rules (Android shows, iOS hides,
 * native hides, dismissed stays hidden), the download URL (one
 * constant, currently the stable GitHub `latest` release asset), and
 * the wiring (the popup is mounted in App, the link is on the login
 * page, the workflow publishes the exact asset the constant points
 * at).
 *
 * The decision logic lives in src/native/androidPromo.ts — deliberately
 * free of React and Capacitor imports so it is unit-testable here.
 * The components themselves are covered by source assertions (this
 * suite has no DOM harness).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ANDROID_APK_ASSET_NAME,
  ANDROID_APK_DOWNLOAD_URL,
  ANDROID_PROMO_DISMISSED_KEY,
  isAndroidBrowser,
  isIosDevice,
  shouldShowAndroidDownloadLink,
  shouldShowAndroidPromo,
} from '../../src/native/androidPromo';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(`${repoRoot}${rel}`, 'utf8');

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

describe('Android download promo — visibility rules', () => {
  it('shows on an Android browser when signed in and not dismissed', () => {
    assert.equal(
      shouldShowAndroidPromo({ userAgent: ANDROID_UA, isNative: false, dismissed: false, isAuthenticated: true }),
      true,
    );
    assert.equal(isAndroidBrowser(ANDROID_UA), true);
    assert.equal(isIosDevice(ANDROID_UA), false);
  });

  it('hides inside the native app', () => {
    assert.equal(
      shouldShowAndroidPromo({ userAgent: ANDROID_UA, isNative: true, dismissed: false, isAuthenticated: true }),
      false,
      'a user who already has the app must never be offered it again',
    );
  });

  it('hides on iOS', () => {
    assert.equal(isAndroidBrowser(IOS_UA), false, 'an iOS user-agent never contains "Android"');
    assert.equal(isIosDevice(IOS_UA), true);
    assert.equal(
      shouldShowAndroidPromo({ userAgent: IOS_UA, isNative: false, dismissed: false, isAuthenticated: true }),
      false,
    );
  });

  it('hides on desktop', () => {
    assert.equal(isAndroidBrowser(DESKTOP_UA), false);
    assert.equal(
      shouldShowAndroidPromo({ userAgent: DESKTOP_UA, isNative: false, dismissed: false, isAuthenticated: true }),
      false,
    );
  });

  it('stays hidden once dismissed', () => {
    assert.equal(
      shouldShowAndroidPromo({ userAgent: ANDROID_UA, isNative: false, dismissed: true, isAuthenticated: true }),
      false,
      'one dismissal is forever (until the versioned key is bumped)',
    );
  });

  it('hides when signed out — the login page carries the link instead', () => {
    assert.equal(
      shouldShowAndroidPromo({ userAgent: ANDROID_UA, isNative: false, dismissed: false, isAuthenticated: false }),
      false,
    );
  });

  it('the login link shows on Android browsers, never native or iOS', () => {
    assert.equal(shouldShowAndroidDownloadLink(ANDROID_UA, false), true);
    assert.equal(shouldShowAndroidDownloadLink(ANDROID_UA, true), false, 'hidden inside the native app');
    assert.equal(shouldShowAndroidDownloadLink(IOS_UA, false), false, 'hidden on iOS');
    assert.equal(shouldShowAndroidDownloadLink(DESKTOP_UA, false), false, 'hidden on desktop');
  });
});

describe('Android download promo — the download URL', () => {
  it('is one constant, currently the stable GitHub latest-release asset', () => {
    assert.equal(
      ANDROID_APK_DOWNLOAD_URL,
      'https://github.com/Mriduul7621/LeadFlow_V2/releases/download/latest/leadflow-android-latest.apk',
    );
    assert.equal(ANDROID_APK_ASSET_NAME, 'leadflow-android-latest.apk');
    assert.ok(
      ANDROID_APK_DOWNLOAD_URL.endsWith(`/${ANDROID_APK_ASSET_NAME}`),
      'the URL ends with the stable asset name',
    );
  });

  it('the constant is the only download URL the web app uses', () => {
    const popup = read('src/native/AndroidPromoPopup.tsx');
    const link = read('src/native/AndroidAppDownloadLink.tsx');
    assert.ok(popup.includes('ANDROID_APK_DOWNLOAD_URL'), 'the popup reads the constant');
    assert.ok(link.includes('ANDROID_APK_DOWNLOAD_URL'), 'the login link reads the constant');
    assert.equal(popup.includes('releases/download/latest'), false, 'no literal URL in the popup — the constant owns it');
    assert.equal(link.includes('releases/download/latest'), false, 'no literal URL in the login link — the constant owns it');
    const promoModule = read('src/native/androidPromo.ts');
    assert.ok(
      promoModule.includes('no login needed'),
      'the constant documents that the GitHub release asset is public (no login needed)',
    );
  });

  it('the popup is mounted in App and the link is on the login page', () => {
    assert.ok(read('src/App.tsx').includes('<AndroidPromoPopup />'), 'App mounts the popup once, outside the router');
    assert.ok(
      read('src/modules/auth/pages/Login.tsx').includes('<AndroidAppDownloadLink />'),
      'the login page carries the fallback link',
    );
  });

  it('the popup dismisses on Download and on close', () => {
    const popup = read('src/native/AndroidPromoPopup.tsx');
    assert.ok(popup.includes('dismissAndroidPromo'), 'the popup writes the dismissal flag');
    assert.ok(popup.includes('onClick={dismiss}'), 'both the Download button and the close control dismiss');
    assert.ok(popup.includes('Android app download koro'), 'the popup title is the agreed Bangla line');
  });

  it('the workflow publishes the same stable asset to the latest release', () => {
    const workflow = read('.github/workflows/android.yml');
    assert.ok(workflow.includes('gh release upload latest'), 'each dispatch publishes to the rolling latest release');
    assert.ok(
      workflow.includes(ANDROID_APK_ASSET_NAME),
      'the workflow publishes the exact asset name the constant points at',
    );
  });

  it('the docs name the same URL and the first-run sequencing', () => {
    const docs = read('docs/ANDROID_RELEASE.md');
    assert.ok(docs.includes(ANDROID_APK_DOWNLOAD_URL), 'the release guide names the download URL');
    assert.ok(docs.includes('only works AFTER the first'), 'the sequencing caveat is documented');
    assert.ok(docs.includes('no GitHub login needed'), 'the public-download note is documented');
  });

  it('the dismissal key is versioned', () => {
    assert.equal(ANDROID_PROMO_DISMISSED_KEY, 'leadflow-android-promo-dismissed-v1');
  });
});
