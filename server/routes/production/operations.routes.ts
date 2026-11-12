/**
 * production/operations.routes.ts — OPERATIONS & LIMITS domain of the
 * production API.
 * ------------------------------------------------------------------
 * Admin Control programme, slice DZ-2 (audit §4): the bounded
 * operational limits G1 (lead bulk-import row cap), G2 (user
 * bulk-import row cap) and M1 (profile/logo image upload cap) are
 * real Settings values now, stored as Metadata Engine options by
 * OperationsSettingsService. Each has a code ceiling that is also
 * its default — an admin may lower a limit but never raise it above
 * the ceiling.
 *
 * Reads are open to any signed-in user (the values are not sensitive
 * and the Settings page needs them); writes require the
 * settings.manage permission code (DB-resolved) and are audit-logged
 * with old→new values, following the DZ-0 settings audit pattern
 * (Q7: every Settings change is logged).
 */
import { Router } from 'express';
import {
  getOperationsSettings,
  setOperationsSettings,
  validateOperationsValue,
  type OperationsSettings,
} from '../../services/OperationsSettingsService.js';
import {
  getCallerDbInfo,
  logAccessChange,
  requireAuth,
  requirePermissionCode,
  sendJson,
} from './shared.js';

const router = Router();

router.get('/settings/operations', requireAuth, async (_req, res) => {
  const settings = await getOperationsSettings();
  return sendJson(res, 200, { success: true, data: settings });
});

router.put('/settings/operations', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const patch: Partial<OperationsSettings> = {};
  for (const key of ['leadBulkImportMaxRows', 'userBulkImportMaxRows', 'imageUploadMaxMb'] as const) {
    if (body[key] !== undefined) {
      const problem = validateOperationsValue(key, body[key]);
      if (problem) {
        return sendJson(res, 400, { success: false, message: problem });
      }
      (patch as Record<string, number>)[key] = body[key] as number;
    }
  }
  if (Object.keys(patch).length === 0) {
    return sendJson(res, 400, { success: false, message: 'Nothing to update: send leadBulkImportMaxRows, userBulkImportMaxRows and/or imageUploadMaxMb.' });
  }
  const before = await getOperationsSettings();
  let after: OperationsSettings;
  try {
    after = await setOperationsSettings(patch);
  } catch (error: any) {
    return sendJson(res, 400, { success: false, message: error?.message || 'Could not save operations settings.' });
  }
  const changes: Record<string, { oldValue: number; newValue: number }> = {};
  for (const key of Object.keys(patch) as Array<keyof OperationsSettings>) {
    if (before[key] !== after[key]) changes[key] = { oldValue: before[key], newValue: after[key] };
  }
  if (Object.keys(changes).length > 0) {
    const caller = await getCallerDbInfo(req).catch(() => null);
    await logAccessChange({
      actorId: caller?.id || (req as any).currentUser?.id || null,
      actionCode: 'operations_settings.save',
      entityType: 'operations_settings',
      entityId: null,
      metadata: { changes },
    });
  }
  return sendJson(res, 200, { success: true, data: after });
});

export default router;
