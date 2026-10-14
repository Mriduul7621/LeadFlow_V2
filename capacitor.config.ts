/**
 * Debug APK shell for LeadFlow.
 *
 * The app loads the hosted LeadFlow web application and uses its existing
 * HTTPS API. This keeps authentication and business data server-side.
 * The configured URL must be reachable by pilot users without a Vercel SSO
 * interstitial; use an approved public/custom domain for external testing.
 */
const config = {
  appId: 'com.shantalife.leadflow',
  appName: 'LeadFlow',
  webDir: 'dist',
  server: {
    url: 'https://lead-flow-jet.vercel.app',
    cleartext: false,
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
