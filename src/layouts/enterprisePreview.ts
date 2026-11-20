import { isAdminRole } from '../modules/auth/components/AdminRoute';
import { ENTERPRISE_ROLE_LABELS, type EnterpriseRole } from './enterpriseRole';

/**
 * enterprisePreview.ts — the super-admin role preview (Enterprise
 * Preview fix round, 2026-11-19).
 * ------------------------------------------------------------------
 * Mahadi's ask: "Super admin side bar theke drop down theke role
 * select kore onnano role er preview dekhte parbe." The sample
 * prototype's sidebar rolebox ("Preview role") comes back — but
 * ONLY for super admins, and ONLY as a display preview.
 *
 * Super-admin determination — the SAME as the Danger Zone gate:
 * server/services/DangerZoneService.ts SUPER_ADMIN_ROLE_CODES =
 * ["ADMIN", "SUPERADMIN"], DB-resolved on every Danger Zone
 * request (resolveSuperAdminCaller). The client-side equivalent
 * is isAdminRole (AdminRoute), which checks the server-confirmed
 * session user's role code against the same two codes — it is the
 * check the AdminRoute gate and Settings' isSystemAdmin already
 * use. Mahadi's own account (employee 2025019, role ADMIN)
 * qualifies under it. No new super-admin concept is invented
 * here, and the gate is not widened.
 *
 * Preview only, never access: the preview changes DISPLAY (the
 * sidebar nav + the overview composition) and nothing else. Data
 * stays scoped to the real logged-in user (every data hook keeps
 * reading the real session), and page access still enforces real
 * permissions — FeatureGate + ProtectedRoute + the server on
 * every request. A super admin previewing as Agent sees the
 * Agent layout with their OWN data, and can open no page their
 * real role could not open.
 *
 * The validation is re-applied on every render, never trusted
 * from client state alone: resolveDisplayRole takes the
 * canPreview verdict (fresh from the session user's role code)
 * alongside the selected preview role, and returns the real role
 * unless BOTH the verdict is true and a preview role is chosen.
 * The dropdown itself only renders when canPreview is true, so
 * a non-super-admin never sees the control — and even a
 * hand-crafted previewRole value (devtools, tampered state) is
 * discarded by resolveDisplayRole for anyone who fails the check.
 *
 * Pure functions, unit-testable without a React tree (the React
 * state lives in AppLayout; the context in enterpriseDisplayRole).
 */

/** Whether this session user may preview other roles. */
export function canPreviewRoles(userRole: string | null | undefined): boolean {
  return isAdminRole(userRole);
}

export interface DisplayRoleInput {
  /** The caller's derived enterprise role (useEnterpriseRole). */
  realRole: EnterpriseRole;
  /** The role chosen in the preview dropdown, or null (own view). */
  previewRole: EnterpriseRole | null;
  /** Fresh canPreviewRoles verdict for the session user. */
  canPreview: boolean;
}

/**
 * The role the shell renders as: the preview role only when the
 * caller is a super admin AND has chosen one; the real derived
 * role in every other case (including a preview choice equal to
 * the real role — then the indicator still shows, because the
 * user explicitly chose it).
 */
export function resolveDisplayRole(input: DisplayRoleInput): EnterpriseRole {
  if (input.canPreview && input.previewRole) return input.previewRole;
  return input.realRole;
}

/** Whether the shell is currently showing a previewed role. */
export function isPreviewingRole(input: DisplayRoleInput): boolean {
  return input.canPreview && input.previewRole !== null && input.previewRole !== input.realRole;
}

/** The dropdown options, in the sample's role order. */
export const ENTERPRISE_PREVIEW_ROLE_OPTIONS: EnterpriseRole[] = [
  'admin',
  'manager',
  'teamLead',
  'agent',
];

export { ENTERPRISE_ROLE_LABELS };
