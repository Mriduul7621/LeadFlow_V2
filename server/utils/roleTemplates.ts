/**
 * roleTemplates.ts — F16 Phase F (user-management §6 Phase F, part 1).
 * ------------------------------------------------------------------
 * A role template is what an ADMINISTRATOR saved: a named snapshot of one
 * role's access (data visibility + granted canonical action codes + the page
 * set) that the next hire's role can start from.
 *
 * There are deliberately NO built-in templates. The product ships no
 * "Manager baseline", no hardcoded entitlement list and no second copy of
 * "what a manager can do": the shipped roles themselves are the starting
 * point (open one and press Configure), and everything in the picker is
 * something an administrator chose to keep. A template list that mixed
 * invented defaults with the admin's own work would be exactly the drift
 * class F16 §3.3 records — two answers to one question.
 *
 * A template never grants anything by itself: it is loaded into the role
 * editor, every toggle stays visible, and the save goes through the ONE
 * existing write path (POST /api/roles + PUT /api/roles/:id/permissions).
 */

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  /** The role the snapshot was taken from (informational). */
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

/** The administrator's templates (newest first). Nothing else exists. */
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
    roleCode: row.source_role_code || null,
    dataVisibility: row.data_visibility || 'Own',
    grants: Array.isArray(row.grants) ? row.grants.map(String) : [],
    menuAccess: parseMenuAccess(row.menu_access),
    createdAt: row.created_at || null,
  }));
}

/** Everything the picker shows: the administrator's own saved templates.
 *  `available` says whether this database can STORE one (migration 047);
 *  an empty list on a fresh install is the correct, honest answer. */
export async function listRoleTemplates(client: any): Promise<{ available: boolean; templates: RoleTemplate[] }> {
  const available = await hasRoleTemplatesLayer(client);
  const templates = await listSavedTemplates(client);
  return { available, templates };
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
    roleCode: saved.source_role_code || null,
    dataVisibility: saved.data_visibility || 'Own',
    grants: Array.isArray(saved.grants) ? saved.grants.map(String) : [],
    menuAccess: parseMenuAccess(saved.menu_access),
    createdAt: saved.created_at || null,
  };
}

/** Remove a template. Ids that are not rows of this table simply answer false. */
export async function deleteRoleTemplate(client: any, id: string): Promise<boolean> {
  if (!(await hasRoleTemplatesLayer(client))) return false;
  const res = await client.query(`DELETE FROM role_templates WHERE id::text = $1 RETURNING id`, [id]);
  return Boolean(res.rows[0]);
}
