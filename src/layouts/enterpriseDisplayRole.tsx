import React, { createContext, useContext } from 'react';
import type { EnterpriseRole } from './enterpriseRole';
import { useEnterpriseRole } from './useEnterpriseRole';

/**
 * enterpriseDisplayRole.tsx — the display-role context (Enterprise
 * Preview fix round, 2026-11-19).
 * ------------------------------------------------------------------
 * AppLayout derives the caller's REAL role (useEnterpriseRole),
 * applies the super-admin preview choice (enterprisePreview), and
 * provides the resulting DISPLAY role to the page content through
 * this context. EnterpriseHome renders the overview for the
 * display role — so a super admin previewing as Team Lead sees
 * the Team Lead overview — while every data hook underneath keeps
 * reading the real user's scope. The context carries display
 * only; it never carries access (routes and data still enforce
 * the real role).
 *
 * Outside a provider (tests, a page rendered without the shell)
 * the hook falls back to the derived role with previewing off,
 * so no caller can observe a preview that AppLayout did not
 * authorize.
 */

export interface EnterpriseDisplayRoleValue {
  /** The role the shell renders as (preview role, or the real one). */
  role: EnterpriseRole;
  /** True while the role is still deriving. */
  loading: boolean;
  /** True when the display role is a super-admin preview. */
  isPreviewing: boolean;
  /** The caller's real derived role (for the "Back to my view" label). */
  realRole: EnterpriseRole;
}

const EnterpriseDisplayRoleContext = createContext<EnterpriseDisplayRoleValue | null>(null);

export function EnterpriseDisplayRoleProvider(props: {
  value: EnterpriseDisplayRoleValue;
  children: React.ReactNode;
}) {
  return (
    <EnterpriseDisplayRoleContext.Provider value={props.value}>
      {props.children}
    </EnterpriseDisplayRoleContext.Provider>
  );
}

export function useEnterpriseDisplayRole(): EnterpriseDisplayRoleValue {
  const provided = useContext(EnterpriseDisplayRoleContext);
  const derived = useEnterpriseRole();
  if (provided) return provided;
  return {
    role: derived.role,
    loading: derived.loading,
    isPreviewing: false,
    realRole: derived.role,
  };
}
