export interface SyncResult {
  success: boolean;
  usersSynced?: number;
  leadsSynced?: number;
  optionsSynced?: number;
  departmentsSynced?: number;
  rolesSynced?: number;
  teamsSynced?: number;
  hierarchiesSynced?: number;
}

export const syncService = {
  async syncToDatabase(): Promise<SyncResult> {
    const response = await fetch('/api/db-status');
    if (!response.ok) {
      return { success: false };
    }

    const status = await response.json() as { connected?: boolean };
    return { success: status.connected === true };
  },
};
