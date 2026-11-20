import React from 'react';
import { Capacitor } from '@capacitor/core';
import { ANDROID_APK_DOWNLOAD_URL, shouldShowAndroidDownloadLink } from './androidPromo';

/**
 * AndroidAppDownloadLink — the small download link on the login page.
 *
 * For users who dismissed the popup or never saw it (e.g. they signed
 * out). Shows only on Android browsers, never inside the native app,
 * never on iOS. Renders nothing otherwise, so the login page is
 * unchanged on desktop, iOS and inside the app.
 */
export default function AndroidAppDownloadLink(): React.ReactElement | null {
  const [show, setShow] = React.useState(false);

  React.useEffect(() => {
    setShow(
      shouldShowAndroidDownloadLink(
        typeof navigator !== 'undefined' ? navigator.userAgent : '',
        Capacitor.isNativePlatform(),
      ),
    );
  }, []);

  if (!show) return null;

  return (
    <p className="leadflow-login-help">
      <a href={ANDROID_APK_DOWNLOAD_URL} className="text-[#f36b21] underline">
        Android app download koro
      </a>
    </p>
  );
}
