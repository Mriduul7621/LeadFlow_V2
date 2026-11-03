/**
 * production/metadata.routes.ts — METADATA domain of the production API.
 * ------------------------------------------------------------------
 * Phase 1 extraction (no behaviour change): the fourteen metadata
 * handlers that used to live inline in production.routes.ts —
 * metadata types, options, workflow rules and form fields — moved
 * verbatim, together with their exclusive row mappers. Shared helpers
 * are imported from ./shared.js (one definition, shared with the
 * monolith); requirePermissionCode also lives in ./shared.js as of
 * this step (it gates mutations across every remaining domain).
 *
 * production.routes.ts mounts this router at the exact position the
 * handlers originally occupied, so route registration order (and
 * therefore matching behaviour) is unchanged.
 */
import { Router } from 'express';
import { getPool } from '../../database/connection.js';
import { fallbackStore, createId } from '../../fallbackStore.js';
import {
  asUuid,
  clean,
  dbErrorStatus,
  demoModeAllowed,
  jsonbOr,
  requireAdmin,
  requireAuth,
  requirePermissionCode,
  sendDbUnavailable,
  sendJson,
  useDb,
} from './shared.js';

const router = Router();

function mapMetadataTypeRow(row: any) {
  return {
    key: row.key,
    label: row.label,
    description: row.description || '',
    isSystem: row.is_system === true,
    sortOrder: row.sort_order,
  };
}

function mapOptionRow(row: any) {
  return {
    id: row.id,
    type: row.field_key,
    value: row.option_value,
    label: row.option_label || row.option_value,
    status: row.is_active === false ? 'Inactive' : 'Active',
    sortOrder: row.sort_order,
    meta: jsonbOr(row.meta, {}),
    createdDate: row.created_at,
  };
}

function mapWorkflowRuleRow(row: any) {
  return {
    id: row.id,
    status: row.status,
    allowedNextStatuses: jsonbOr(row.allowed_next_statuses, null),
    requiresLossReason: row.requires_loss_reason === true,
    requiresMeetingType: row.requires_meeting_type === true,
    requiresFollowUpType: row.requires_followup_type === true,
    requiresNote: row.requires_note === true,
    isSystem: row.is_system === true,
    createdDate: row.created_at,
  };
}

function mapFormFieldRow(row: any) {
  return {
    id: row.id,
    fieldKey: row.field_key,
    label: row.label,
    fieldType: row.field_type,
    section: row.section || '',
    isMandatory: row.is_mandatory === true,
    isVisible: row.is_visible !== false,
    sortOrder: row.sort_order,
    metadataTypeKey: row.metadata_type_key || null,
    placeholder: row.placeholder || '',
    isSystem: row.is_system === true,
    createdDate: row.created_at,
  };
}

/* ====================================================================
   METADATA TYPES
==================================================================== */

router.get('/metadata-types', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackStore.metadataTypes);
  try {
    const result = await getPool().query('SELECT * FROM metadata_types ORDER BY sort_order ASC, label ASC');
    return sendJson(res, 200, result.rows.map(mapMetadataTypeRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Metadata type fetch failed' });
  }
});

router.post('/metadata-types', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  const { key, label, description } = req.body || {};
  const normalizedKey = String(key || label || '').trim().replace(/\s+/g, '_');
  if (!normalizedKey || !label) {
    return sendJson(res, 400, { error: 'Type key and label are required' });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const existing = fallbackStore.metadataTypes.find(item => item.key.toLowerCase() === normalizedKey.toLowerCase());
    if (existing) return sendJson(res, 200, existing);
    const item = { key: normalizedKey, label: String(label), description: String(description || ''), isSystem: false, sortOrder: fallbackStore.metadataTypes.length + 1 };
    fallbackStore.metadataTypes.push(item);
    return sendJson(res, 201, item);
  }
  try {
    const result = await getPool().query(
      `INSERT INTO metadata_types (key, label, description, is_system, sort_order, created_at)
       VALUES ($1, $2, $3, FALSE, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM metadata_types), NOW())
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description
       RETURNING *`,
      [normalizedKey, String(label), String(description || '')]
    );
    return sendJson(res, 200, mapMetadataTypeRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Metadata type save failed' });
  }
});

router.delete('/metadata-types/:key', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const idx = fallbackStore.metadataTypes.findIndex(item => item.key === req.params.key);
    if (idx < 0) return sendJson(res, 404, { error: 'Metadata type not found' });
    fallbackStore.metadataTypes.splice(idx, 1);
    return sendJson(res, 200, { success: true });
  }
  try {
    const result = await getPool().query('DELETE FROM metadata_types WHERE key = $1 RETURNING key', [req.params.key]);
    if (!result.rows[0]) return sendJson(res, 404, { error: 'Metadata type not found' });
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Metadata type delete failed' });
  }
});

/* ====================================================================
   OPTIONS (metadata values)
==================================================================== */

router.get('/options', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackStore.options);
  try {
    const result = await getPool().query('SELECT * FROM options ORDER BY sort_order ASC, option_value ASC');
    return sendJson(res, 200, result.rows.map(mapOptionRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Option fetch failed' });
  }
});

router.post('/options', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  const payload = req.body || {};
  const type = clean(payload.type || payload.fieldKey).slice(0, 100);
  const value = clean(payload.value || payload.optionValue);
  if (!type || !value) {
    return sendJson(res, 400, { error: 'Type and value are required' });
  }
  const label = clean(payload.label || payload.optionLabel) || value;
  const isActive = payload.status === undefined ? true : payload.status !== 'Inactive' && payload.status !== 'INACTIVE';
  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const existing = fallbackStore.options.find(item => item.type === type && item.value === value);
    const item = existing || { id: createId('option'), type, value, label, status: isActive ? 'Active' : 'Inactive', sortOrder: fallbackStore.options.length + 1, meta: {}, createdDate: new Date().toISOString() };
    Object.assign(item, { type, value, label, status: isActive ? 'Active' : 'Inactive', meta });
    if (!existing) fallbackStore.options.push(item);
    return sendJson(res, 200, item);
  }

  try {
    const result = await getPool().query(
      `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM options o WHERE o.field_key = $1::varchar)), FALSE, $5, $6, NOW(), NOW())
       ON CONFLICT (field_key, option_value) DO UPDATE SET
         option_label = EXCLUDED.option_label,
         is_active = EXCLUDED.is_active,
         meta = EXCLUDED.meta,
         updated_at = NOW()
       RETURNING *`,
      [type, value, label, payload.sortOrder != null ? Number(payload.sortOrder) : null, isActive, JSON.stringify(meta)]
    );
    return sendJson(res, 200, mapOptionRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Option save failed' });
  }
});

router.delete('/options/:type/:value', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    fallbackStore.options = fallbackStore.options.filter(o => !(o.type === req.params.type && o.value === req.params.value));
    return sendJson(res, 200, { success: true });
  }
  try {
    const result = await getPool().query(
      'DELETE FROM options WHERE field_key = $1 AND option_value = $2 RETURNING id',
      [req.params.type, req.params.value]
    );
    if (!result.rows[0]) return sendJson(res, 404, { error: 'Option not found' });
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Option delete failed' });
  }
});

router.post('/options/reorder', requireAuth, requirePermissionCode('settings.manage'), async (req, res) => {
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
  if (orderedIds.length === 0) {
    return sendJson(res, 400, { error: 'No option order supplied' });
  }
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (!asUuid(id)) continue;
      await client.query('UPDATE options SET sort_order = $1, updated_at = NOW() WHERE id = $2', [i + 1, id]);
    }
    await client.query('COMMIT');
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Option reorder failed' });
  } finally {
    client.release();
  }
});

/* ====================================================================
   WORKFLOW RULES
==================================================================== */

router.get('/workflow-rules', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, fallbackStore.workflowRules);
  try {
    const result = await getPool().query('SELECT * FROM workflow_rules ORDER BY status ASC');
    return sendJson(res, 200, result.rows.map(mapWorkflowRuleRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Workflow rule fetch failed' });
  }
});

router.post('/workflow-rules', requireAuth, requirePermissionCode('workflow.manage'), async (req, res) => {
  const payload = req.body || {};
  const status = clean(payload.status);
  if (!status) return sendJson(res, 400, { error: 'Status is required' });
  const allowed = payload.allowedNextStatuses == null ? null : (Array.isArray(payload.allowedNextStatuses) ? payload.allowedNextStatuses : []);
  const item = {
    id: payload.id || createId('workflow-rule'),
    status,
    allowedNextStatuses: allowed,
    requiresLossReason: !!payload.requiresLossReason,
    requiresMeetingType: !!payload.requiresMeetingType,
    requiresFollowUpType: !!payload.requiresFollowUpType,
    requiresNote: !!payload.requiresNote,
    isSystem: !!payload.isSystem,
  };

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const existing = fallbackStore.workflowRules.find(rule => rule.status === status);
    if (existing) Object.assign(existing, item);
    else fallbackStore.workflowRules.push(item);
    return sendJson(res, 200, item);
  }

  try {
    const result = await getPool().query(
      `INSERT INTO workflow_rules (status, allowed_next_statuses, requires_loss_reason, requires_meeting_type,
                                   requires_followup_type, requires_note, is_system, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (status) DO UPDATE SET
         allowed_next_statuses = EXCLUDED.allowed_next_statuses,
         requires_loss_reason = EXCLUDED.requires_loss_reason,
         requires_meeting_type = EXCLUDED.requires_meeting_type,
         requires_followup_type = EXCLUDED.requires_followup_type,
         requires_note = EXCLUDED.requires_note,
         updated_at = NOW()
       RETURNING *`,
      [status, allowed ? JSON.stringify(allowed) : null, item.requiresLossReason, item.requiresMeetingType,
        item.requiresFollowUpType, item.requiresNote, item.isSystem]
    );
    return sendJson(res, 200, mapWorkflowRuleRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Workflow rule save failed' });
  }
});

router.delete('/workflow-rules/:id', requireAuth, requirePermissionCode('workflow.manage'), async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    const idx = fallbackStore.workflowRules.findIndex(rule => rule.id === req.params.id || rule.status === req.params.id);
    if (idx < 0) return sendJson(res, 404, { error: 'Workflow rule not found' });
    fallbackStore.workflowRules.splice(idx, 1);
    return sendJson(res, 200, { success: true });
  }
  try {
    const result = await getPool().query('DELETE FROM workflow_rules WHERE id::text = $1 OR status = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return sendJson(res, 404, { error: 'Workflow rule not found' });
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Workflow rule delete failed' });
  }
});

/* ====================================================================
   FORM FIELDS
==================================================================== */

router.get('/form-fields', requireAuth, async (_req, res) => {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) return sendJson(res, 200, []);
  try {
    const result = await getPool().query('SELECT * FROM form_fields ORDER BY section ASC, sort_order ASC, label ASC');
    return sendJson(res, 200, result.rows.map(mapFormFieldRow));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Form field fetch failed' });
  }
});

router.post('/form-fields', requireAuth, requireAdmin, async (req, res) => {
  const payload = req.body || {};
  const fieldKey = clean(payload.fieldKey || payload.field_key || payload.label);
  const label = clean(payload.label || payload.fieldKey || payload.field_key);
  if (!fieldKey || !label) {
    return sendJson(res, 400, { error: 'fieldKey and label are required' });
  }
  const fieldType = clean(payload.fieldType || payload.field_type) || 'text';
  const isMandatory = !!payload.isMandatory;
  const isVisible = payload.isVisible === undefined ? true : !!payload.isVisible;
  const isSystem = !!payload.isSystem;
  const sortOrder = payload.sortOrder != null ? Number(payload.sortOrder) : 999;

  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, {
      id: createId('field'), fieldKey, label, fieldType, section: clean(payload.section),
      isMandatory, isVisible, sortOrder, metadataTypeKey: payload.metadataTypeKey || null,
      placeholder: clean(payload.placeholder), isSystem, createdDate: new Date().toISOString(),
    });
  }

  try {
    const result = await getPool().query(
      `INSERT INTO form_fields (field_key, label, field_type, section, is_mandatory, is_visible, sort_order,
                                metadata_type_key, placeholder, is_system, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       ON CONFLICT (field_key) DO UPDATE SET
         label = EXCLUDED.label,
         field_type = EXCLUDED.field_type,
         section = EXCLUDED.section,
         is_mandatory = EXCLUDED.is_mandatory,
         is_visible = EXCLUDED.is_visible,
         sort_order = EXCLUDED.sort_order,
         metadata_type_key = EXCLUDED.metadata_type_key,
         placeholder = EXCLUDED.placeholder,
         updated_at = NOW()
       RETURNING *`,
      [fieldKey, label, fieldType, clean(payload.section), isMandatory, isVisible, sortOrder,
        clean(payload.metadataTypeKey) || null, clean(payload.placeholder) || null, isSystem]
    );
    return sendJson(res, 200, mapFormFieldRow(result.rows[0]));
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Form field save failed' });
  }
});

router.delete('/form-fields/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true });
  }
  try {
    const found = await getPool().query('SELECT is_system FROM form_fields WHERE id::text = $1 OR field_key = $1', [req.params.id]);
    if (!found.rows[0]) return sendJson(res, 404, { error: 'Form field not found' });
    if (found.rows[0].is_system) {
      return sendJson(res, 400, { error: 'System fields cannot be deleted.' });
    }
    await getPool().query('DELETE FROM form_fields WHERE id = $1', [found.rows[0].id]);
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Form field delete failed' });
  }
});

router.post('/form-fields/reorder', requireAuth, requireAdmin, async (req, res) => {
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
  if (orderedIds.length === 0) return sendJson(res, 400, { error: 'No field order supplied' });
  if (!useDb()) {
    if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
    return sendJson(res, 200, { success: true });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (!asUuid(id)) continue;
      await client.query('UPDATE form_fields SET sort_order = $1, updated_at = NOW() WHERE id = $2', [i + 1, id]);
    }
    await client.query('COMMIT');
    return sendJson(res, 200, { success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Form field reorder failed' });
  } finally {
    client.release();
  }
});

export default router;
