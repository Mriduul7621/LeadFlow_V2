/**
 * effectiveAccess.ts — F16 Phase F (user-management §6 Phase F, part 2).
 * ------------------------------------------------------------------
 * "What can this person actually do?" — answered holistically, per the
 * industry guidance this project follows: evaluate access across every layer
 * at once, including overlaps and inherited permissions, instead of asking
 * the administrator to mentally combine three screens.
 *
 * The precedence below is NOT invented here: it is the exact rule the
 * security boundary already enforces in `hasPermissionCode()` —
 *
 *     1. a per-user override row exists    -> its value wins (ALLOW or DENY)
 *     2. else a role grant row exists      -> its value
 *     3. else                              -> DENY (fail closed)
 *
 * (`permissionSheet.ts` on the client mirrors the same rule; the parity test
 * keeps all three answers identical.)
 *
 * Three extra facts make the answer useful rather than merely correct:
 *
 *   - **source**: WHICH layer decided — "user-override", "role-grant" or the
 *     fail-closed default. An administrator looking at a red row needs to know
 *     whether to fix the role or the person.
 *   - **no-op overrides**: an override that repeats what the role already says
 *     changes nothing today but becomes a landmine when the role changes —
 *     reported, not hidden.
 *   - **explicit deny over an allow**: the strongest signal in a review
 *     ("explicit deny overrides allow"), listed separately.
 */

export type PermissionSource = 'user-override' | 'role-grant' | 'deny-default';

export interface EffectivePermissionRow {
  code: string;
  module: string;
  action: string;
  /** The final answer: this is what the server will do. */
  allowed: boolean;
  /** Which layer produced `allowed`. */
  source: PermissionSource;
  /** The layer below, for context: role grant (null = no row => deny). */
  roleAllowed: boolean | null;
  /** The layer above (null = no override row = follow the role). */
  overrideAllowed: boolean | null;
  /** An override that agrees with the role — it changes nothing today. */
  overrideIsNoop: boolean;
}

export interface EffectivePageRow {
  path: string;
  allowed: boolean;
}

export interface EffectiveAccess {
  permissions: EffectivePermissionRow[];
  /** Explicit deny that beats a role allow — "does not do what it looks like". */
  deniedOverAllow: string[];
  /** Overrides that exist but agree with the role (no-op today, trap tomorrow). */
  noopOverrides: string[];
  warnings: string[];
  summary: {
    total: number;
    allowed: number;
    denied: number;
    roleGrants: number;
    overridesAllow: number;
    overridesDeny: number;
  };
}

export interface RawPermissionRow {
  permission_code?: unknown;
  module_name?: unknown;
  action_name?: unknown;
  /** Role grant row: COALESCE(rp.is_allowed, FALSE) in the query. */
  is_allowed?: unknown;
  /** Null when no override row exists. */
  user_override?: unknown;
  has_role_grant?: unknown;
}

const hasValue = (v: unknown) => v !== null && v !== undefined;

/**
 * Pure resolver — the whole precedence in one place, so it can be unit-tested
 * against `hasPermissionCode()` without a database.
 */
export function resolveEffectivePermissions(rows: RawPermissionRow[] | null | undefined): EffectiveAccess {
  const permissions: EffectivePermissionRow[] = [];
  const deniedOverAllow: string[] = [];
  const noopOverrides: string[] = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const code = String(row?.permission_code ?? '').trim();
    if (!code) continue;

    const hasOverride = hasValue(row.user_override);
    const overrideAllowed = hasOverride ? row.user_override === true : null;
    // `is_allowed` is COALESCEd to FALSE in the query, but a row WITH a grant
    // row that is false and a row with NO grant row are different stories on
    // the screen — `has_role_grant` (when the caller provides it) separates
    // them; without it we treat a false as "no allow".
    const hasRoleGrant = row.has_role_grant === undefined ? row.is_allowed === true : row.has_role_grant === true;
    const roleAllowed = hasRoleGrant ? row.is_allowed === true : null;

    let allowed: boolean;
    let source: PermissionSource;
    if (hasOverride) {
      allowed = overrideAllowed === true;
      source = 'user-override';
    } else if (roleAllowed !== null) {
      // The role has a row for this code — whether it allows or explicitly
      // denies, the ROLE is what decided. Only a code with no row at all is
      // "denied by default".
      allowed = roleAllowed === true;
      source = 'role-grant';
    } else {
      allowed = false;
      source = 'deny-default';
    }

    const overrideIsNoop = hasOverride && roleAllowed !== null && overrideAllowed === roleAllowed;
    if (overrideIsNoop) noopOverrides.push(code);
    if (hasOverride && overrideAllowed === false && roleAllowed === true) deniedOverAllow.push(code);

    permissions.push({
      code,
      module: String(row?.module_name ?? ''),
      action: String(row?.action_name ?? ''),
      allowed,
      source,
      roleAllowed,
      overrideAllowed,
      overrideIsNoop,
    });
  }

  const summary = {
    total: permissions.length,
    allowed: permissions.filter(p => p.allowed).length,
    denied: permissions.filter(p => !p.allowed).length,
    roleGrants: permissions.filter(p => p.roleAllowed === true).length,
    overridesAllow: permissions.filter(p => p.overrideAllowed === true).length,
    overridesDeny: permissions.filter(p => p.overrideAllowed === false).length,
  };

  return { permissions, deniedOverAllow, noopOverrides, warnings: [], summary };
}

/**
 * The human-readable findings for one person's access review. Kept next to the
 * resolver so the screen and the API can never disagree about what is worth
 * flagging.
 */
export function buildAccessWarnings(input: {
  effective: EffectiveAccess;
  roleCode: string;
  roleName?: string;
  isActive: boolean;
  mustChangePassword: boolean;
  isAdminBypass: boolean;
  menuAccessConfigured: number;
  dataVisibility: string;
}): string[] {
  const warnings: string[] = [];
  const { effective } = input;

  if (input.isAdminBypass) {
    warnings.push(
      `This account holds ${input.roleCode}, which bypasses the permission matrix entirely — every action and every page is allowed, and data visibility is organization-wide.`
    );
  }
  if (!input.isActive) {
    warnings.push('The account is deactivated: it cannot sign in, so none of these permissions are usable until it is switched back on.');
  }
  if (input.mustChangePassword) {
    warnings.push('The person must change their password before the app lets them work.');
  }
  if (!input.isAdminBypass && effective.summary.roleGrants === 0) {
    warnings.push(
      `The ${input.roleCode} role holds no action grants — every action is denied until an administrator grants it on the role.`
    );
  }
  if (!input.isAdminBypass && input.dataVisibility === 'Own') {
    warnings.push('Data visibility is "Own": even with every action granted, this person only ever sees their own records.');
  }
  if (effective.deniedOverAllow.length > 0) {
    warnings.push(
      `Explicit deny overrides the role grant for: ${effective.deniedOverAllow.join(', ')}. ` +
      'Deny wins over allow — the role says yes, this person is refused.'
    );
  }
  if (effective.noopOverrides.length > 0) {
    warnings.push(
      `These per-person overrides repeat what the role already says, so they change nothing today: ${effective.noopOverrides.join(', ')}. ` +
      'They will start mattering the moment that role changes — worth removing.'
    );
  }
  if (!input.isAdminBypass && input.menuAccessConfigured === 0) {
    warnings.push(
      'The role has no page set configured, so page access falls back to the shipped defaults for this role.'
    );
  }
  return warnings;
}
