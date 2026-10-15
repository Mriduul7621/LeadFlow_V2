/**
 * roleTemplates.ts — F16 Phase F (user-management §6 Phase F, part 1).
 * ------------------------------------------------------------------
 * Two families of role template, and the difference matters:
 *
 *   SYSTEM ("baseline") templates are DERIVED LIVE from the shipped standard
 *   roles — a template with the id `system:MANAGER` reads the `MANAGER` role's
 *   CURRENT grants, visibility and page set on every call. Nothing is copied,
 *   so an administrator who narrows MANAGER in Roles & Access narrows the
 *   baseline template in the same breath. This is the structural fix for the
 *   drift class F16 §3.3 describes (two hand-kept copies of "what a manager
 *   holds" answering differently).
 *
 *   SAVED templates are snapshots the administrator chose to keep (table
 *   `role_templates`, migration 047): "this exact configuration, under this
 *   name, so the next hire's role starts here".
 *
 * Neither kind grants anything by itself. A template is loaded into the role
 * editor, every toggle stays visible, and the save goes through the ONE
 * existing write path (POST /api/roles + PUT /api/roles/:id/permissions).
 * Templates that silently re-shape roles later would be a second source of
 * truth — exactly what the permission layer must not have.
 */

/** Roles that are never offered as a starting point (they bypass the matrix). */
const SYSTEM_ROLE_CODES = ['ADMIN', 'SUPERADMIN'];

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  source: 'system' | 'saved';
  /** The role the snapshot came from (system templates: the live role). */
  roleCode: string | null;
  dataVisibility: string;
  /** Canonical permission codes that are ALLOWED in this template. */
  grants: string[];
  /** Page visibility ({"/leads": true, ...}); {} = nothing configured. */
  menuAccess: Record<string, boolean>;
  createdAt?: string | null;
}

/** Read-only capability probe — never memoized (one process, many databases). */
export async function hasRoleTemplatesLayer(client: any): Promise<boolean> {
  try {
    const res = await client.query(`SELECT to_regclass('public.role_templates') IS NOT NULL AS present`);
    return res.rows[0]?.present === true;
  } catch {
    return false;
  }
}

function parseMenuAccess(raw: any): Record<string, boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [path, value] of Object.entries(raw)) {
    if (typeof value === 'boolean') out[String(path)] = value;
  }
  return out;
}

/**
 * One template per shipped standard role, built from what that role holds
 * RIGHT NOW. Rows without any grant still appear (a legitimate starting
 * point: "this role holds nothing") — the list is a catalogue, not a
 * recommendation.
 */
export async function listBaselineTemplates(client: any): Promise<RoleTemplate[]> {
  const roles = await client.query(
    `SELECT id, role_code, role_name, description, data_visibility, menu_access
       FROM roles
      WHERE UPPER(role_code) <> ALL($1::text[])
      ORDER BY hierarchy_level ASC NULLS LAST, role_code ASC`,
    [SYSTEM_ROLE_CODES]
  );
  if (roles.rows.length === 0) return [];

  const grants = await client.query(
    `SELECT r.role_code, p.permission_code
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.is_allowed = TRUE
      ORDER BY p.permission_code ASC`
  );
  const byRole = new Map<string, string[]>();
  for (const row of grants.rows) {
    const code = String(row.role_code || '').toUpperCase();
    const list = byRole.get(code) || [];
    list.push(String(row.permission_code));
    byRole.set(code, list);
  }

  return roles.rows.map((role: any) => {
    const code = String(role.role_code || '').toUpperCase();
    const granted = byRole.get(code) || [];
    const menuAccess = parseMenuAccess(role.menu_access);
    const pageCount = Object.values(menuAccess).filter(Boolean).length;
    return {
      id: `system:${code}`,
      name: `${role.role_name || code} baseline`,
      description:
        `${granted.length} action${granted.length === 1 ? '' : 's'}` +
        (pageCount > 0 ? `, ${pageCount} page${pageCount === 1 ? '' : 's'}` : ', pages not configured') +
        `, ${role.data_visibility || 'Own'} data scope — exactly what the ${code} role holds right now.`,
      source: 'system' as const,
      roleCode: code,
      dataVisibility: role.data_visibility || 'Own',
      grants: granted,
      menuAccess,
      createdAt: null,
    };
  });
}

/** Templates the administrator saved (newest first). */
export async function listSavedTemplates(client: any): Promise<RoleTemplate[]> {
  if (!(await hasRoleTemplatesLayer(client))) return [];
  const rows = await client.query(
    `SELECT id, template_name, description, source_role_code, data_visibility, grants, menu_access, created_at
       FROM role_templates
      ORDER BY created_at DESC`
  );
  return rows.rows.map((row: any) => ({
    id: String(row.id),
    name: String(row.template_name || ''),
    description: String(row.description || ''),
    source: 'saved' as const,
    roleCode: row.source_role_code || null,
    dataVisibility: row.data_visibility || 'Own',
    grants: Array.isArray(row.grants) ? row.grants.map(String) : [],
    menuAccess: parseMenuAccess(row.menu_access),
    createdAt: row.created_at || null,
  }));
}

/** Everything the picker shows: saved first (an admin's own work), then baselines. */
export async function listRoleTemplates(client: any): Promise<{ available: boolean; templates: RoleTemplate[] }> {
  const available = await hasRoleTemplatesLayer(client);
  const saved = await listSavedTemplates(client);
  const baseline = await listBaselineTemplates(client);
  return { available, templates: [...saved, ...baseline] };
}

/**
 * Snapshot a role into a saved template. The snapshot is read from the
 * database (never from the request body), so a template can only ever hold
 * what a role actually holds — a client cannot invent a grant.
 */
export async function saveRoleTemplate(
  client: any,
  opts: { name: string; description?: string; fromRoleCode: string; createdBy?: string | null }
): Promise<RoleTemplate> {
  if (!(await hasRoleTemplatesLayer(client))) {
    throw Object.assign(
      new Error('Saving a template needs the role-templates table (migration 047), which this database does not have.'),
      { statusCode: 503 }
    );
  }
  const role = await client.query(
    `SELECT id, role_code, role_name, data_visibility, menu_access
       FROM roles WHERE UPPER(role_code) = UPPER($1) OR id::text = $1 LIMIT 1`,
    [opts.fromRoleCode]
  );
  const row = role.rows[0];
  if (!row) {
    throw Object.assign(new Error(`Unknown role "${opts.fromRoleCode}".`), { statusCode: 400 });
  }
  const code = String(row.role_code || '').toUpperCase();

  const grants = await client.query(
    `SELECT p.permission_code
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1 AND rp.is_allowed = TRUE
      ORDER BY p.permission_code ASC`,
    [row.id]
  );
  const grantCodes = grants.rows.map((r: any) => String(r.permission_code));
  const menuAccess = parseMenuAccess(row.menu_access);

  const inserted = await client.query(
    `INSERT INTO role_templates (template_name, description, source_role_code, data_visibility, grants, menu_access, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
     RETURNING id, template_name, description, source_role_code, data_visibility, grants, menu_access, created_at`,
    [
      opts.name,
      opts.description || `Snapshot of the ${code} role`,
      code,
      row.data_visibility || 'Own',
      JSON.stringify(grantCodes),
      JSON.stringify(menuAccess),
      opts.createdBy || null,
    ]
  );
  const saved = inserted.rows[0];
  return {
    id: String(saved.id),
    name: String(saved.template_name),
    description: String(saved.description || ''),
    source: 'saved',
    roleCode: saved.source_role_code || null,
    dataVisibility: saved.data_visibility || 'Own',
    grants: Array.isArray(saved.grants) ? saved.grants.map(String) : [],
    menuAccess: parseMenuAccess(saved.menu_access),
    createdAt: saved.created_at || null,
  };
}

/** Remove a saved template. Baseline templates are not rows — nothing to delete. */
export async function deleteRoleTemplate(client: any, id: string): Promise<boolean> {
  if (!(await hasRoleTemplatesLayer(client))) return false;
  const res = await client.query(`DELETE FROM role_templates WHERE id::text = $1 RETURNING id`, [id]);
  return Boolean(res.rows[0]);
}
