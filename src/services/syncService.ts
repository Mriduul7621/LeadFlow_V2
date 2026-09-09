/**
 * syncService.ts
 * ------------------------------------------------------------------
 * With DB-first writes (see the module services), every create/update/
 * delete already goes straight to the API and therefore to PostgreSQL -
 * there is no local queue left to "sync". What remains useful is an
 * accurate DATABASE CONNECTION STATUS check, exposed here as
 * `databaseStatusService.checkDatabaseStatus()`.
 *
 * `syncService.syncToDatabase()` is kept only as a deprecated alias so
 * legacy call sites compile; it performs the same connection-status
 * check and NEVER fabricates sync counts.
 */

export interface DatabaseStatus {
  success: boolean;
  connected: boolean;
  mode: string;
  message: string;
}

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

async function checkDatabaseStatus(): Promise<DatabaseStatus> {
  try {
    const response = await fetch('/api/db-status');
    const body = await response.json().catch(() => ({}));
    const connected = body?.connected === true;
    const mode = body?.mode || (response.ok ? 'unknown' : 'error');
    const message =
      body?.message ||
      (connected
        ? 'Connected to the database.'
        : 'Database is not available. Changes cannot be persisted right now.');
    return { success: connected && response.ok, connected, mode, message };
  } catch {
    return {
      success: false,
      connected: false,
      mode: 'unreachable',
      message: 'Unable to reach the server. Please check your connection.',
    };
  }
}

export const databaseStatusService = {
  checkDatabaseStatus,
};

/** @deprecated Use databaseStatusService.checkDatabaseStatus() instead. */
export const syncService = {
  async syncToDatabase(): Promise<SyncResult> {
    const status = await checkDatabaseStatus();
    if (status.connected) {
      return { success: true };
    }
    return { success: false };
  },
};
