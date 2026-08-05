import { localDb } from './localDb';
import { User, Lead, DropdownOption } from '../types';
import { toast } from 'sonner';

export const syncService = {
  async syncToDatabase() {
    try {
      console.log('🔄 Initiating Local-to-PostgreSQL Database Synchronization...');

      // Load locally deleted IDs
      const deletedUserIds = new Set<string>(JSON.parse(localStorage.getItem('shanta_deleted_user_ids') || '[]'));
      const deletedLeadIds = new Set<string>(JSON.parse(localStorage.getItem('shanta_deleted_lead_ids') || '[]'));
      const deletedOptionIds = new Set<string>(JSON.parse(localStorage.getItem('shanta_deleted_option_ids') || '[]'));

      // Retrieve synchronized cache registration trackers to prevent resurrection of deleted items
      const syncedUserIds = new Set<string>(JSON.parse(localStorage.getItem('lf_synced_user_ids') || '[]'));
      const syncedLeadIds = new Set<string>(JSON.parse(localStorage.getItem('lf_synced_lead_ids') || '[]'));
      const syncedOptionIds = new Set<string>(JSON.parse(localStorage.getItem('lf_synced_option_ids') || '[]'));

      // Gather current local states
      let localUsers: User[] = [];
      try {
        localUsers = localDb.getUsers();
      } catch (e) {
        console.error(e);
      }

      let localLeads: Lead[] = [];
      try {
        localLeads = localDb.getLeads();
      } catch (e) {
        console.error(e);
      }

      let localOptions: DropdownOption[] = [];
      try {
        localOptions = localDb.getOptions();
      } catch (e) {
        console.error(e);
      }

      // ==========================================
      // 1. Bidirectional Users Synchronizer
      // ==========================================
      let usersSynced = 0;
      let usersDownloaded = 0;
      let finalUsersToKeep = [...localUsers];

      try {
        const userSyncRes = await fetch('/api/users/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localUsers: localUsers.filter(u => !deletedUserIds.has(u.id)),
            deletedUserIds: Array.from(deletedUserIds)
          })
        });

        if (userSyncRes.ok) {
          const data = await userSyncRes.json();
          if (data.success && Array.isArray(data.cloudUsers)) {
            const cloudUsers: User[] = data.cloudUsers;
            usersSynced = data.processed || 0;

            // Clear completed deletions from local tracker
            localStorage.setItem('shanta_deleted_user_ids', JSON.stringify([]));
            deletedUserIds.clear();

            // Refresh cache trackers
            cloudUsers.forEach(u => syncedUserIds.add(u.id));

            // Sync down new/updated cloud users to local db
            for (const cu of cloudUsers) {
              const localUser = localUsers.find(u => u.id === cu.id);
              if (!localUser) {
                localDb.createUser(cu);
                finalUsersToKeep.push(cu);
                usersDownloaded++;
              } else {
                const lTime = new Date(localUser.createdDate || 0).getTime();
                const cTime = new Date(cu.createdDate || 0).getTime();
                const needsLocalUpdate = cu.role !== localUser.role || 
                                         cu.name !== localUser.name ||
                                         cu.status !== localUser.status ||
                                         (!isNaN(cTime) && !isNaN(lTime) && cTime > lTime);
                if (needsLocalUpdate) {
                  localDb.updateUser(cu.id, cu);
                  const idx = finalUsersToKeep.findIndex(u => u.id === cu.id);
                  if (idx > -1) finalUsersToKeep[idx] = cu;
                  usersDownloaded++;
                }
              }
            }

            // Clean up old local users deleted on PostgreSQL
            const cloudUserIds = new Set(cloudUsers.map(u => u.id));
            const currentLocalUsers = [...finalUsersToKeep];
            for (const lu of currentLocalUsers) {
              if (lu.employeeId === 'ADMIN') continue; // Always keep primary admin
              if (!cloudUserIds.has(lu.id) && syncedUserIds.has(lu.id)) {
                localDb.deleteUser(lu.id);
                syncedUserIds.delete(lu.id);
                const idx = finalUsersToKeep.findIndex(u => u.id === lu.id);
                if (idx > -1) finalUsersToKeep.splice(idx, 1);
              }
            }
          }
        }
      } catch (err) {
        console.warn('⚠️ PostgreSQL Users Sync warning (reverting to offline state):', err);
      }

      // ==========================================
      // 2. Bidirectional Leads Synchronizer
      // ==========================================
      let leadsSynced = 0;
      let leadsDownloaded = 0;
      let finalLeadsToKeep = [...localLeads];

      try {
        const leadSyncRes = await fetch('/api/leads/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localLeads: localLeads.filter(l => !deletedLeadIds.has(l.id)),
            deletedLeadIds: Array.from(deletedLeadIds)
          })
        });

        if (leadSyncRes.ok) {
          const data = await leadSyncRes.json();
          if (data.success && Array.isArray(data.cloudLeads)) {
            const cloudLeads: Lead[] = data.cloudLeads;
            leadsSynced = data.processed || 0;

            // Clear completed deletions from local tracker
            localStorage.setItem('shanta_deleted_lead_ids', JSON.stringify([]));
            deletedLeadIds.clear();

            // Refresh cache trackers
            cloudLeads.forEach(l => syncedLeadIds.add(l.id));

            // Sync down new/updated cloud leads
            let hasLocalLeadChange = false;
            for (const cl of cloudLeads) {
              const localLead = localLeads.find(l => l.id === cl.id);
              if (!localLead) {
                finalLeadsToKeep.push(cl);
                leadsDownloaded++;
                hasLocalLeadChange = true;
              } else {
                const lTime = new Date(localLead.timestamp || localLead.creationDate || 0).getTime();
                const cTime = new Date(cl.timestamp || cl.creationDate || 0).getTime();
                const needsLocalUpdate = cl.currentStatus !== localLead.currentStatus ||
                                         cl.assignedTo !== localLead.assignedTo ||
                                         cl.collectedNCP !== localLead.collectedNCP ||
                                         (!isNaN(cTime) && !isNaN(lTime) && cTime > lTime);
                if (needsLocalUpdate) {
                  const idx = finalLeadsToKeep.findIndex(l => l.id === cl.id);
                  if (idx > -1) {
                    finalLeadsToKeep[idx] = cl;
                    leadsDownloaded++;
                    hasLocalLeadChange = true;
                  }
                }
              }
            }

            // Sync down deletes (clean up any local leads deleted in cloud)
            const cloudLeadIds = new Set(cloudLeads.map(l => l.id));
            const baseLeads = [...finalLeadsToKeep];
            const cleanLeadsList: Lead[] = [];
            
            baseLeads.forEach(localLead => {
              if (cloudLeadIds.has(localLead.id) || !syncedLeadIds.has(localLead.id)) {
                cleanLeadsList.push(localLead);
              } else {
                syncedLeadIds.delete(localLead.id);
                hasLocalLeadChange = true;
              }
            });

            if (hasLocalLeadChange) {
              finalLeadsToKeep = cleanLeadsList;
              localDb.saveLeads(finalLeadsToKeep);
            }
          }
        }
      } catch (err) {
        console.warn('⚠️ PostgreSQL Leads Sync warning (reverting to offline state):', err);
      }

      // ==========================================
      // 3. Bidirectional Dropdown Options Synchronizer
      // ==========================================
      let optionsSynced = 0;
      let optionsDownloaded = 0;

      try {
        const mappedLocalOpts = localOptions.map(o => ({
          ...o,
          id: `${o.type}_${o.value.trim().replace(/\s+/g, '_')}`
        }));

        const optionsSyncRes = await fetch('/api/options/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localOptions: mappedLocalOpts.filter(o => !deletedOptionIds.has(o.id)),
            deletedOptionIds: Array.from(deletedOptionIds)
          })
        });

        if (optionsSyncRes.ok) {
          const data = await optionsSyncRes.json();
          if (data.success && Array.isArray(data.cloudOptions)) {
            const cloudOptions = data.cloudOptions;
            optionsSynced = data.processed || 0;

            // Clear completed deleted option trackers
            localStorage.setItem('shanta_deleted_option_ids', JSON.stringify([]));
            deletedOptionIds.clear();

            // Refresh option cache trackers
            cloudOptions.forEach((o: any) => syncedOptionIds.add(o.id));

            // Sync down new cloud options
            for (const co of cloudOptions) {
              const existsLocally = localOptions.some(o => `${o.type}_${o.value.trim().replace(/\s+/g, '_')}` === co.id);
              if (!existsLocally) {
                localDb.addOption(co.type, co.value);
                optionsDownloaded++;
              }
            }

            // Sync down option deletes
            const cloudOptionIds = new Set(cloudOptions.map((o: any) => o.id));
            const currentLocalOptions = [...localDb.getOptions()];
            currentLocalOptions.forEach(opt => {
              const optionId = `${opt.type}_${opt.value.trim().replace(/\s+/g, '_')}`;
              if (!cloudOptionIds.has(optionId) && syncedOptionIds.has(optionId)) {
                localDb.deleteOption(opt.type, opt.value);
                syncedOptionIds.delete(optionId);
              }
            });
          }
        }
      } catch (err) {
        console.warn('⚠️ PostgreSQL Options Sync warning:', err);
      }

      // ==========================================
      // 4. Bidirectional Departments Synchronizer
      // ==========================================
      let departmentsSynced = 0;
      let departmentsDownloaded = 0;
      try {
        const localDeptStr = localStorage.getItem('lf_local_departments');
        const localDepts = localDeptStr ? JSON.parse(localDeptStr) : [];
        const deptSyncRes = await fetch('/api/departments/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localDepartments: localDepts,
            deletedDepartmentIds: []
          })
        });
        if (deptSyncRes.ok) {
          const deptData = await deptSyncRes.json();
          if (deptData.success && Array.isArray(deptData.cloudDepartments)) {
            departmentsSynced = deptData.processed || 0;
            localStorage.setItem('lf_local_departments', JSON.stringify(deptData.cloudDepartments));
            departmentsDownloaded = Math.max(0, deptData.cloudDepartments.length - localDepts.length);
          }
        }
      } catch (err) {
        console.warn('⚠️ PostgreSQL Departments Sync warning:', err);
      }

      // ==========================================
      // 5. Bidirectional Roles Synchronizer
      // ==========================================
      let rolesSynced = 0;
      let rolesDownloaded = 0;
      try {
        const localRolesStr = localStorage.getItem('lf_local_roles_permissions');
        const localRoles = localRolesStr ? JSON.parse(localRolesStr) : [];
        const roleSyncRes = await fetch('/api/roles/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localRoles: localRoles,
            deletedRoleIds: []
          })
        });
        if (roleSyncRes.ok) {
          const roleData = await roleSyncRes.json();
          if (roleData.success && Array.isArray(roleData.cloudRoles)) {
            rolesSynced = roleData.processed || 0;
            localStorage.setItem('lf_local_roles_permissions', JSON.stringify(roleData.cloudRoles));
            rolesDownloaded = Math.max(0, roleData.cloudRoles.length - localRoles.length);
          }
        }
      } catch (err) {
        console.warn('⚠️ PostgreSQL Roles Sync warning:', err);
      }

      // ==========================================
      // 6. Bidirectional Teams Synchronizer
      // ==========================================
      let teamsSynced = 0;
      let teamsDownloaded = 0;
      try {
        const localTeamsStr = localStorage.getItem('lf_local_teams');
        const localTeams = localTeamsStr ? JSON.parse(localTeamsStr) : [];
        const teamSyncRes = await fetch('/api/teams/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localTeams: localTeams,
            deletedTeamIds: []
          })
        });
        if (teamSyncRes.ok) {
          const teamData = await teamSyncRes.json();
          if (teamData.success && Array.isArray(teamData.cloudTeams)) {
            teamsSynced = teamData.processed || 0;
            localStorage.setItem('lf_local_teams', JSON.stringify(teamData.cloudTeams));
            teamsDownloaded = Math.max(0, teamData.cloudTeams.length - localTeams.length);
          }
        }
      } catch (err) {
        console.warn('⚠️ PostgreSQL Teams Sync warning:', err);
      }

      // ==========================================
      // 7. Bidirectional Hierarchies Synchronizer
      // ==========================================
      let hierarchiesSynced = 0;
      let hierarchiesDownloaded = 0;
      try {
        const localHierStr = localStorage.getItem('lf_local_hierarchies');
        const localHiers = localHierStr ? JSON.parse(localHierStr) : [];
        const hierSyncRes = await fetch('/api/hierarchies/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            localHierarchies: localHiers,
            deletedHierarchyIds: []
          })
        });
        if (hierSyncRes.ok) {
          const hierData = await hierSyncRes.json();
          if (hierData.success && Array.isArray(hierData.cloudHierarchies)) {
            hierarchiesSynced = hierData.processed || 0;
            localStorage.setItem('lf_local_hierarchies', JSON.stringify(hierData.cloudHierarchies));
            hierarchiesDownloaded = Math.max(0, hierData.cloudHierarchies.length - localHiers.length);
          }
        }
      } catch (err) {
        console.warn('⚠️ PostgreSQL Hierarchies Sync warning:', err);
      }

      // Save sync registration cache tracks back to localStorage
      localStorage.setItem('lf_synced_user_ids', JSON.stringify(Array.from(syncedUserIds)));
      localStorage.setItem('lf_synced_lead_ids', JSON.stringify(Array.from(syncedLeadIds)));
      localStorage.setItem('lf_synced_option_ids', JSON.stringify(Array.from(syncedOptionIds)));

      if (
        usersSynced > 0 || 
        usersDownloaded > 0 || 
        leadsSynced > 0 || 
        leadsDownloaded > 0 || 
        optionsSynced > 0 || 
        optionsDownloaded > 0 ||
        departmentsSynced > 0 ||
        departmentsDownloaded > 0 ||
        rolesSynced > 0 ||
        rolesDownloaded > 0 ||
        teamsSynced > 0 ||
        teamsDownloaded > 0 ||
        hierarchiesSynced > 0 ||
        hierarchiesDownloaded > 0
      ) {
        toast.success(`Supabase Synced! Uploaded updates and synchronized all records successfully! ✨`);
      }

      return {
        success: true,
        usersSynced,
        leadsSynced,
        optionsSynced,
        departmentsSynced,
        rolesSynced,
        teamsSynced,
        hierarchiesSynced,
        usersDownloaded,
        leadsDownloaded,
        optionsDownloaded,
        departmentsDownloaded,
        rolesDownloaded,
        teamsDownloaded,
        hierarchiesDownloaded
      };
    } catch (err) {
      console.error('Database Sync Error:', err);
      return {
        success: false,
        usersSynced: 0,
        leadsSynced: 0,
        optionsSynced: 0,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
};
