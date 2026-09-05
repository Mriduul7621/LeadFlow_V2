import { useAuthStore } from '../store/authStore';
import { RolePermission } from '../types';
import { useEffect, useState } from 'react';

/**
 * usePermissions - Custom React context hook for fine-grained functional permission checking.
 * Built with staff-level scalability in mind, including passive cross-tab state syncing 
 * & cached authorization checks to ensure 0-lag animations and high frame rates.
 */
export function usePermissions() {
  const { user } = useAuthStore();
  const [roles, setRoles] = useState<RolePermission[]>([]);

  useEffect(() => {
    const loadRoles = () => {
      const data = localStorage.getItem('lf_local_roles_permissions');
      if (data) {
        try {
          setRoles(JSON.parse(data));
        } catch (e) {
          console.error('Failed to parse roles permissions in usePermissions hook', e);
        }
      }
    };

    // Initialize immediate values
    loadRoles();

    // Listen to storage events to keep updated in case other tabs or screens modify roles
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'lf_local_roles_permissions') {
        loadRoles();
      }
    };
    window.addEventListener('storage', handleStorage);
    
    // Periodically poll local storage to stay up to date with same-tab updates
    const interval = setInterval(loadRoles, 3000);

    return () => {
      window.removeEventListener('storage', handleStorage);
      clearInterval(interval);
    };
  }, []);

  const userRoleNormalized = (user?.role || '').toUpperCase();

  /**
   * canAccess - checks if the current logged-in user is permitted to run a specific functional action
   * under a given core operational module.
   * 
   * @param featureId - Core feature block name (e.g., 'dashboard', 'lead_generate', 'lead_upload', 'lead_tracking', 'all_leads', 'analytics', 'team_progress', 'user_management')
   * @param actionKey - Specific key signature inside that feature block's schema (e.g. 'export_summary_pdf', 'delete_destroy_leads', etc.)
   * @returns boolean - Whether the access check succeeded.
   */
  const canAccess = (featureId: string, actionKey: string): boolean => {
    // 1. System Admin overrides ALL granular security checks - universal clearance
    if (userRoleNormalized === 'ADMIN') {
      return true;
    }

    if (!user) {
      return false;
    }

    // 2. Identify the active clearance level's security attributes
    const matchedRole = roles.find(
      (r) => r.roleId === user.role || r.roleId === userRoleNormalized
    );

    if (!matchedRole) {
      // Return false if the user has an unrecognized role ID
      return false;
    }

    // Determine normalized feature key
    let mappedFeatureId = featureId;
    let finalActionKey = actionKey;
    if (featureId === 'lead_upl_gen') {
      if (actionKey === 'bulk_generate_crm_leads') {
        mappedFeatureId = 'lead_generate';
      } else {
        mappedFeatureId = 'lead_upload';
      }
    } else if (featureId === 'team_progress') {
      mappedFeatureId = 'team_management';
    } else if (featureId === 'admin_settings') {
      mappedFeatureId = 'settings_control';
      if (actionKey === 'configure_global_metadata') {
        finalActionKey = 'configure_parameters';
      }
    } else if (featureId === 'all_leads') {
      mappedFeatureId = 'lead_tracking';
    }

    // Map Action Key to the 5 keys: view | create | edit | delete | upload
    let actionType: 'view' | 'create' | 'edit' | 'delete' | 'upload' = 'view';
    const createKeys = ['capture_new_leads', 'save_draft_leads', 'assign_lead_to_anyone', 'deploy_new_teams', 'onboard_new_employees', 'bulk_generate_crm_leads', 'create'];
    const editKeys = ['perform_status_transitions', 'record_followup_logs', 'allocate_projected_ncp', 'reassign_own_leads', 'reassign_global_leads', 'manage_team_memberships', 'modify_credentials_clearance', 'toggle_activation_status', 'configure_global_metadata', 'edit'];
    const deleteKeys = ['delete_destroy_leads', 'delete'];
    const uploadKeys = ['upload_excel_csv', 'upload_raw_csv_xlsx', 'validate_bulk_schema', 'commit_bulk_database', 'upload'];

    if (createKeys.includes(finalActionKey)) {
      actionType = 'create';
    } else if (editKeys.includes(finalActionKey)) {
      actionType = 'edit';
    } else if (deleteKeys.includes(finalActionKey)) {
      actionType = 'delete';
    } else if (uploadKeys.includes(finalActionKey)) {
      actionType = 'upload';
    } else if (finalActionKey.startsWith('view') || finalActionKey.startsWith('explore') || finalActionKey.startsWith('monitor') || finalActionKey.startsWith('visualize') || finalActionKey.startsWith('evaluate')) {
      actionType = 'view';
    } else {
      const keyNormalized = finalActionKey.toLowerCase();
      if (['view', 'create', 'edit', 'delete', 'upload'].includes(keyNormalized)) {
        actionType = keyNormalized as any;
      }
    }

    // 3. Match the feature group structure to check umbrella menu permission first
    // This maintains alignment with side navigation entries.
    const featurePathMapping: Record<string, string[]> = {
      dashboard: ['/'],
      lead_generate: ['/leads/new'],
      lead_upload: ['/leads/upload'],
      lead_tracking: ['/leads', '/follow-up'],
      all_leads: ['/leads/all'],
      analytics: ['/execution-intelligence', '/ncp-progress', '/trend-charts', '/campaign-breakdown'],
      team_management: ['/team'],
      user_management: ['/users'],
      settings_control: ['/settings'],
    };

    const targetPaths = featurePathMapping[featureId] || featurePathMapping[mappedFeatureId];
    if (targetPaths) {
      const hasMenuAccess = targetPaths.some(p => !!matchedRole.menuAccess?.[p]);
      if (!hasMenuAccess) {
        return false;
      }
    }

    // 4. Primary check: dynamic page-by-page mapping on standard feature permissions
    const actionsMap = matchedRole.featurePermissions?.[mappedFeatureId];
    if (actionsMap) {
      if (!actionsMap.view) {
        return false;
      }
      if (actionsMap[finalActionKey] !== undefined) {
        return actionsMap[finalActionKey];
      }
      if (actionsMap[actionType] !== undefined) {
        return actionsMap[actionType];
      }
      return true;
    }

    // If undefined or check fails, fall back to safe default (unauthorized)
    return false;
  };

  return {
    canAccess,
    roles,
    userRole: user?.role,
    userRoleNormalized,
    user,
  };
}
