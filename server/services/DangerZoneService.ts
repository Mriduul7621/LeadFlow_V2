import { getPool } from "../database/connection.js";

/**
 * DangerZoneService.ts — the data layer of the Danger Zone
 * (Admin Control programme, slice DZ-0).
 * ------------------------------------------------------------------
 * The Danger Zone (Settings → Danger Zone) is where the app's system
 * rules will live. DZ-0 builds ONLY the gate and the shell:
 *
 *   - WHO may enter: a super admin is a caller whose role code,
 *     resolved FROM THE DATABASE (never from the JWT claim — audit
 *     finding A7: a token keeps its minted role for up to 7 days),
 *     is ADMIN or SUPERADMIN and whose account is active.
 *   - The step-up: re-entering the login password creates ONE unlock
 *     row per user in `danger_zone_unlocks` (migration 057), valid
 *     10 minutes, NON-sliding (owner decision 2026-11-11).
 *   - What the shell shows: the read-only rule cards (audit §2 items
 *     recommended "Read-only display") plus the §3.4 hard invariants.
 *     Later slices append editable groups to this same payload.
 *
 * Fail-closed everywhere: no DB row / inactive account / non-bcrypt
 * stored password / expired unlock all mean NO access.
 */

export const SUPER_ADMIN_ROLE_CODES = ["ADMIN", "SUPERADMIN"] as const;

/** Owner decision 2026-11-11: 10 minutes, non-sliding. */
export const DANGER_ZONE_UNLOCK_MINUTES = 10;

export interface SuperAdminCaller {
  id: string;
  employee_id: string;
  email: string;
  role_code: string;
  is_active: boolean;
}

export interface DangerZoneIdent {
  id?: string | null;
  employeeId?: string | null;
  email?: string | null;
}

/**
 * Resolve the caller from the DB by any of the token's identifiers
 * and return the row ONLY when it is an ACTIVE super admin. This is
 * the deliberate A7 fix for this gate: the role is read fresh from
 * `roles`, so a demoted admin's still-valid token opens nothing.
 */
export async function resolveSuperAdminCaller(ident: DangerZoneIdent): Promise<SuperAdminCaller | null> {
  const id = String(ident.id || "").trim();
  const emp = String(ident.employeeId || "").trim();
  const email = String(ident.email || "").trim();
  if (!id && !emp && !email) return null;
  const result = await getPool().query(
    `SELECT u.id, u.employee_id, u.email, u.is_active, r.role_code
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE (u.id::text = $1 OR UPPER(u.employee_id) = UPPER($2) OR UPPER(u.email) = UPPER($3))
        AND UPPER(r.role_code) = ANY($4::text[])
        AND u.is_active = TRUE
      LIMIT 1`,
    [id || emp || email, emp || id, email || id, [...SUPER_ADMIN_ROLE_CODES]]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    employee_id: row.employee_id,
    email: row.email || "",
    role_code: String(row.role_code || "").toUpperCase(),
    is_active: row.is_active === true,
  };
}

/** The stored password hash for the unlock's bcrypt-only compare. */
export async function getStoredPasswordHash(userId: string): Promise<string | null> {
  const result = await getPool().query(`SELECT password FROM users WHERE id = $1 LIMIT 1`, [userId]);
  const value = result.rows[0]?.password;
  return value == null ? null : String(value);
}

export interface DangerZoneUnlock {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  created_ip: string | null;
}

/** Create (or replace) the caller's single unlock row. */
export async function createDangerZoneUnlock(userId: string, ip: string | null): Promise<DangerZoneUnlock> {
  const result = await getPool().query(
    `INSERT INTO danger_zone_unlocks (user_id, created_at, expires_at, created_ip)
     VALUES ($1, NOW(), NOW() + ($2 || ' minutes')::interval, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET created_at = EXCLUDED.created_at,
           expires_at = EXCLUDED.expires_at,
           created_ip = EXCLUDED.created_ip
     RETURNING id, user_id, created_at, expires_at, created_ip`,
    [userId, String(DANGER_ZONE_UNLOCK_MINUTES), ip]
  );
  return result.rows[0];
}

/** The caller's unlock when it exists AND is unexpired, else null. */
export async function getActiveDangerZoneUnlock(userId: string): Promise<DangerZoneUnlock | null> {
  const result = await getPool().query(
    `SELECT id, user_id, created_at, expires_at, created_ip
       FROM danger_zone_unlocks
      WHERE user_id = $1 AND expires_at > NOW()
      LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function getDangerZoneUnlockStatus(userId: string): Promise<{ unlocked: boolean; secondsRemaining: number; unlockedUntil: string | null }> {
  const unlock = await getActiveDangerZoneUnlock(userId);
  if (!unlock) return { unlocked: false, secondsRemaining: 0, unlockedUntil: null };
  const remaining = Math.max(0, Math.floor((new Date(unlock.expires_at).getTime() - Date.now()) / 1000));
  return { unlocked: true, secondsRemaining: remaining, unlockedUntil: unlock.expires_at };
}

/**
 * Revoke every unlock of a user. Called by the re-lock triggers:
 * explicit Lock, logout (client-initiated), the user's own password
 * change, an admin password reset, deactivation and role change.
 * Best-effort by contract of its callers (it must never fail the
 * password/user write it rides along with) — callers wrap it.
 */
export async function revokeDangerZoneUnlocks(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM danger_zone_unlocks WHERE user_id = $1`, [userId]);
}

/* ====================================================================
   READ-ONLY RULE CARDS (audit §2, recommendation "Read-only display")
   --------------------------------------------------------------------
   Data-driven on purpose: later DZ slices append editable groups to
   this payload. `currentValue` states today's effective behaviour —
   read live where that is cheap and safe (A13 bootstrap state),
   otherwise the value verified by the audit against the code,
   labelled with its source in `source`.
==================================================================== */

export interface DangerZoneRuleCard {
  id: string;
  title: string;
  rule: string;
  currentValue: string;
  source: string;
}

const STATIC_RULE_CARDS: DangerZoneRuleCard[] = [
  {
    id: "C6",
    title: "Who can see a lead",
    rule: "A lead is visible exactly when its assignee is inside your visibility scope OR its creator is. Everything else looks like the lead does not exist (404) — its existence is never revealed.",
    currentValue: "Assignee in scope OR creator in scope; one definition used by every lead surface.",
    source: "Audit C6 — server/routes/production (buildDashboardVisibilitySql, isLeadAccessible)",
  },
  {
    id: "C7",
    title: "What the visibility scopes mean",
    rule: "Own = only yourself. DownTeam = your reporting subtree. FullTeam = your department memberships plus your downline. Organization = everyone. The reporting-chain walk is capped at depth 100.",
    currentValue: "Own / DownTeam / FullTeam / Organization, exactly as defined here.",
    source: "Audit C7 — server/authz.ts",
  },
  {
    id: "D7",
    title: "Follow-up next steps on the calendar",
    rule: "Each lead follow-up keeps at most ONE open calendar entry; a new next step replaces the old one. A meeting beats a call, a call beats a plain follow-up. Converted completes the entry, Not Interested cancels it, clearing the date cancels it.",
    currentValue: "Active for every follow-up entry point (lead update, calendar complete, lead create, bulk, import).",
    source: "Audit D7 — server/services/NextStepCalendarSync.ts",
  },
  {
    id: "E2",
    title: "How auto-assignment picks a person",
    rule: "When auto-assignment is on, an unassigned lead goes to the least-loaded active member of the creator's visibility scope; ties go to whoever was assigned least recently, then by employee ID.",
    currentValue: "Rule: least_loaded (the only rule that exists today).",
    source: "Audit E2 — server/services/AutoAssignmentService.ts",
  },
  {
    id: "E5",
    title: "What happens when the first-contact SLA is breached",
    rule: "The assignee is notified; the upline is notified on escalation. A re-assignment re-arms the alert, so the same assignment never alerts twice.",
    currentValue: "Assignee alert + upline escalation, deduplicated per assignment.",
    source: "Audit E5 — server/services/LeadSlaService.ts",
  },
  {
    id: "G4",
    title: "Exact-duplicate protection on import",
    rule: "Every imported row is fingerprinted over 20 fields (including the normalised phone). A row that exactly matches another row in the same upload, or one just imported, is skipped.",
    currentValue: "20-field fingerprint, always on.",
    source: "Audit G4 — server/routes/leadImport.ts",
  },
  {
    id: "G6",
    title: "Import status wording",
    rule: "Free-text statuses in an upload are translated to the status dictionary (for example 'Unreachable' becomes 'No Response', 'Follow up' becomes 'Follow-up Set'). Unknown wording is flagged on that row instead of guessed.",
    currentValue: "Fixed alias table; the dictionary itself is editable in Settings.",
    source: "Audit G6 — server/routes/leadImport.ts",
  },
  {
    id: "G8",
    title: "Adding a dropdown value from the Add Lead form",
    rule: "Anyone who can create leads may add a missing value to the form's dropdown lists, and it appears for everyone. A value an admin deactivated is refused, never quietly brought back. Geography lists and lead statuses are not extendable this way.",
    currentValue: "7 core lists (Profession, Occupation, Priority, MaritalStatus, Product, Source, Campaign) plus Form Builder dropdown lists; values up to 255 characters.",
    source: "Audit G8 — POST /options/quick-add",
  },
  {
    id: "J1",
    title: "Roadshow creator is always assigned",
    rule: "The person who creates a roadshow is always one of its assignees and cannot be removed from their own roadshow — on create and on every later edit.",
    currentValue: "Always on (owner's decision, PR #109).",
    source: "Audit J1 — server/routes/production/roadshows.routes.ts",
  },
  {
    id: "J3",
    title: "A roadshow may have no assists",
    rule: "A roadshow assigned to only its creator is valid — assists are optional.",
    currentValue: "Allowed.",
    source: "Audit J3 — server/routes/production/roadshows.routes.ts",
  },
  {
    id: "L3",
    title: "The morning push summary",
    rule: "One daily digest per user: due and overdue follow-ups, SLA breaches and today's meeting count, for users who turned push on.",
    currentValue: "Every day at 08:30 Asia/Dhaka (deploy schedule — changing the time is a deploy change, or an external scheduler like the meeting reminders).",
    source: "Audit L3 — PushReminderService + vercel.json cron",
  },
  {
    id: "L10",
    title: "Email notifications",
    rule: "There are none, anywhere in the app. Notifications are in-app and web push only — this was decided deliberately (PR #109), it is not a missing feature.",
    currentValue: "No email is ever sent.",
    source: "Audit L10 — owner's decision on record",
  },
  {
    id: "M3",
    title: "File uploads to the server",
    rule: "The server accepts no file uploads at all. Spreadsheets are read in the browser and sent as rows of data, never as files.",
    currentValue: "No upload endpoint exists.",
    source: "Audit M3 — server architecture",
  },
  {
    id: "N1",
    title: "Clear ALL leads",
    rule: "Deleting every lead at once requires a super admin AND typing the confirmation CLEAR_ALL. A snapshot of what was deleted is written to the audit log first, and the leads are soft-deleted (recoverable).",
    currentValue: "Super admin + typed CLEAR_ALL + pre-delete snapshot.",
    source: "Audit N1 — invariant, never a setting",
  },
  {
    id: "N2",
    title: "Delete one campaign's leads",
    rule: "Purging a campaign's leads requires a super admin AND typing the campaign's exact name as the confirmation, with the same audit snapshot first.",
    currentValue: "Super admin + exact campaign name + pre-delete snapshot.",
    source: "Audit N2 — invariant, never a setting",
  },
  {
    id: "N3",
    title: "Deleting a user",
    rule: "A user can never delete their own account, and the last active administrator can never be deleted. The deleted person's direct reports move to that person's own manager, and open leads must be transferred first through deactivation.",
    currentValue: "Self-delete refused; last-admin delete refused; reports re-pointed skip-level.",
    source: "Audit N3 — invariant, never a setting",
  },
  {
    id: "N4",
    title: "Deactivating a user",
    rule: "An account that still owns open leads cannot be switched off — a person must choose who receives the leads; nothing is auto-transferred. The last active administrator cannot be deactivated or demoted either.",
    currentValue: "Blocked while open leads are owned; last-admin guard active.",
    source: "Audit N4 — invariant, never a setting",
  },
  {
    id: "B8",
    title: "Menu visibility is not security",
    rule: "The client's per-role menu/feature switches only decide what is RENDERED. Every server request re-checks the real permission, so a hidden menu never grants — and a shown menu never guarantees — access.",
    currentValue: "Client layer is presentation only; the server is the gate.",
    source: "Audit B8 — client access layer + server permission codes",
  },
];

/** §3.4 hard invariants, in plain words. These never change, not even here. */
export const DANGER_ZONE_INVARIANTS: string[] = [
  "The lead-visibility rule (who can see whose leads) can never be edited — it is the confidentiality boundary between employees.",
  "The typed confirmations for destructive actions (CLEAR_ALL, the exact campaign name) and their audit snapshots can never be weakened or switched off.",
  "Who may open the Danger Zone — super admins only, with a fresh password entry — can never be changed from inside the Danger Zone.",
  "The last active super admin can never be deleted, deactivated or demoted: someone must always be able to open this page.",
  "Super admins always keep full access and Organization-wide visibility, so a broken permission setup can always be repaired.",
  "When a permission cannot be resolved — missing definition, missing grant, database error — the answer is always NO (fail closed).",
  "All dates and times are computed on Asia/Dhaka, with timestamps stored in UTC. This convention can never change.",
  "Secrets (login signing key, push keys, cron secret, database address) live in the deployment environment and never appear in any Settings page.",
  "Notification dedupe and import validate-then-commit can never be switched off: no duplicate alerts, no unvalidated bulk writes.",
  "The system roles (ADMIN, SUPERADMIN) can never be deleted or placed inside the business reporting ladder.",
];

export interface DangerZoneOverview {
  unlock: { unlockedUntil: string; secondsRemaining: number };
  invariants: string[];
  cards: DangerZoneRuleCard[];
}

/**
 * The overview payload for the unlocked shell. A13 (first-admin
 * bootstrap) is read LIVE: the endpoint that creates the first admin
 * refuses as soon as any super admin exists.
 */
export async function buildDangerZoneOverview(unlock: DangerZoneUnlock): Promise<DangerZoneOverview> {
  let bootstrapValue = "Closed — an administrator account already exists, so the one-time first-admin setup can never run again.";
  try {
    const result = await getPool().query(
      `SELECT COUNT(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
        WHERE UPPER(r.role_code) = ANY($1::text[])`,
      [[...SUPER_ADMIN_ROLE_CODES]]
    );
    if (Number(result.rows[0]?.n || 0) === 0) {
      bootstrapValue = "OPEN — no administrator exists yet; the one-time first-admin setup is still armed. Create the first admin immediately.";
    }
  } catch {
    bootstrapValue = "State could not be read from the database just now; the guard itself is unchanged and still enforced by the server.";
  }

  const cards: DangerZoneRuleCard[] = [
    ...STATIC_RULE_CARDS,
    {
      id: "A13",
      title: "First-admin setup (bootstrap)",
      rule: "The unauthenticated endpoint that creates the very first ADMIN works only while zero administrator accounts exist. The moment one exists, it refuses forever.",
      currentValue: bootstrapValue,
      source: "Audit A13 — read live from the users table",
    },
  ];
  const remaining = Math.max(0, Math.floor((new Date(unlock.expires_at).getTime() - Date.now()) / 1000));
  return {
    unlock: { unlockedUntil: unlock.expires_at, secondsRemaining: remaining },
    invariants: DANGER_ZONE_INVARIANTS,
    cards,
  };
}
