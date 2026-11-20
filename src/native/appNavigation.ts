/**
 * appNavigation — in-app navigation from outside React.
 *
 * The FCM tap listener (src/native/pushNotifications.ts) lives at
 * module level, outside any component, so it cannot use
 * `useNavigate`. Instead App.tsx registers the router's `navigate`
 * here once, at module scope, and the push module navigates through
 * `navigateApp`. No import of App.tsx (which would be a cycle:
 * App.tsx imports this module, not the other way round).
 *
 * Falls back to a full-page `window.location.assign` when no
 * navigator is registered (should not happen in the shipped app —
 * App.tsx always registers before any tap can arrive — but a tap
 * must never be swallowed silently).
 */
let appNavigator: ((path: string) => void) | null = null;

/** Register the router's navigate function (called once by App.tsx). */
export function registerAppNavigator(navigate: (path: string) => void): void {
  appNavigator = navigate;
}

/** Navigate inside the SPA (router when registered, else full load). */
export function navigateApp(path: string): void {
  if (appNavigator) {
    appNavigator(path);
    return;
  }
  if (typeof window !== 'undefined') {
    window.location.assign(path);
  }
}
