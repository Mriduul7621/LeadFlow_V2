import { apiRequest, jsonBody } from '../../shared/api/http';

/**
 * operationsSettingsService.ts
 * ------------------------------------------------------------------
 * Client for the bounded operational limits (Admin Control programme,
 * DZ-2): GET/PUT /api/settings/operations, served by
 * OperationsSettingsService. The Settings → Operations & Limits
 * section reads these values and its inputs write them; the profile
 * image upload and the user bulk-import modal read the effective
 * caps from here too.
 *
 * Each limit has a code ceiling that is also its default (an admin
 * may lower a limit but never raise it above the ceiling); the
 * server refuses out-of-range writes with a 400.
 */

export interface OperationsSettings {
  leadBulkImportMaxRows: number;
  userBulkImportMaxRows: number;
  imageUploadMaxMb: number;
}

export const DEFAULT_OPERATIONS_SETTINGS: OperationsSettings = {
  leadBulkImportMaxRows: 5000,
  userBulkImportMaxRows: 1000,
  imageUploadMaxMb: 1.5,
};

export const OPERATIONS_LIMITS = {
  leadBulkImportMaxRows: { min: 100, max: 5000 },
  userBulkImportMaxRows: { min: 10, max: 1000 },
  imageUploadMaxMb: { min: 0.5, max: 1.5 },
} as const;

function normalize(settings: any): OperationsSettings {
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    leadBulkImportMaxRows: num(settings?.leadBulkImportMaxRows, DEFAULT_OPERATIONS_SETTINGS.leadBulkImportMaxRows),
    userBulkImportMaxRows: num(settings?.userBulkImportMaxRows, DEFAULT_OPERATIONS_SETTINGS.userBulkImportMaxRows),
    imageUploadMaxMb: num(settings?.imageUploadMaxMb, DEFAULT_OPERATIONS_SETTINGS.imageUploadMaxMb),
  };
}

export const operationsSettingsService = {
  async getSettings(): Promise<OperationsSettings> {
    const settings = await apiRequest<OperationsSettings>('/api/settings/operations');
    return normalize(settings);
  },

  async saveSettings(patch: Partial<OperationsSettings>): Promise<OperationsSettings> {
    const saved = await apiRequest<OperationsSettings>('/api/settings/operations', {
      method: 'PUT',
      ...jsonBody(patch),
    });
    return normalize(saved);
  },
};
