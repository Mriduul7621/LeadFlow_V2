/**
 * production/dangerZone.routes.ts — DANGER ZONE domain
 * (Admin Control programme, slice DZ-0: gate & shell).
 * ------------------------------------------------------------------
 * Settings → Danger Zone holds the app's system rules. DZ-0 builds
 * the gate and the shell only — nothing moves here yet:
 *
 *   POST /danger-zone/unlock    requireAuth + super admin (resolved
 *                               from the DATABASE, never the token's
 *                               role claim) + the caller's OWN
 *                               password, compared with bcrypt ONLY.
 *                               The legacy plaintext fallback used by
 *                               login is deliberately NOT honoured —
 *                               a non-bcrypt stored value fails
 *                               closed. Wrong password → 401 with a
 *                               generic message; failures count
 *                               against the existing auth rate
 *                               limiter and are audit-logged.
 *   GET  /danger-zone/status    super admin only: locked/unlocked +
 *                               seconds remaining (non-sliding).
 *   POST /danger-zone/lock      super admin only: ends the unlock.
 *   GET  /danger-zone/overview  requires a VALID unlock: the
 *                               read-only rule cards (audit §2) +
 *                               the §3.4 hard invariants. The view
 *                               itself is audit-logged, once per
 *                               unlock session.
 *   GET  /danger-zone/lead-quality
 *                            requires a VALID unlock: the current
 *                            effective Lead Quality config (DZ-3,
 *                            audit §2.6 F1–F6) + the code defaults +
 *                            the version + the last change (who/when/
 *                            old→new, from the audit log).
 *   PUT  /danger-zone/lead-quality
 *                            requires a VALID unlock: saves one
 *                            versioned config (version +1) and writes
 *                            an audit row with old→new values.
 *   GET  /danger-zone/security-policy
 *                            requires a VALID unlock: the current
 *                            effective security policy (DZ-4, audit
 *                            §2.1 A1/A5/A8/A9) + the code defaults +
 *                            the bounds + the version + the last change.
 *   PUT  /danger-zone/security-policy
 *                            requires a VALID unlock: saves one
 *                            versioned policy (version +1) and writes
 *                            an audit row with old→new values.
 *   GET  /danger-zone/role-defaults
 *                            requires a VALID unlock: the current
 *                            effective role-defaults table (DZ-5,
 *                            audit §2.2 B6) + the code defaults + the
 *                            canonical permission codes + the roles
 *                            holding zero grants + the last change.
 *   PUT  /danger-zone/role-defaults
 *                            requires a VALID unlock: saves one
 *                            versioned defaults table (version +1)
 *                            and writes an audit row with old→new
 *                            values. Saving alone changes no role.
 *   POST /danger-zone/role-defaults/apply
 *                            requires a VALID unlock: runs the guarded
 *                            apply routine (zero-grant roles only,
 *                            visibility only while still 'Own') and
 *                            audit-logs what it actually changed.
 *   GET  /danger-zone/stage-rules
 *                            requires a VALID unlock: the current
 *                            effective stage rules (DZ-6, audit §2.4
 *                            D2/D3) — per-status required fields
 *                            keyed by dictionary-entry id + the
 *                            terminal flags — + the code defaults +
 *                            the version + the last change
 *                            (who/when/old→new, from the audit log).
 *   PUT  /danger-zone/stage-rules
 *                            requires a VALID unlock: saves one
 *                            versioned rule set + terminal flags
 *                            (version +1) and writes an audit row
 *                            with old→new values. The follow-up
 *                            endpoint enforces the saved rules from
 *                            the next request on; every "open lead"
 *                            definition reads the saved terminal flags.
 *
 * Unlock lifetime: 10 minutes, non-sliding (owner decision
 * 2026-11-11). Re-lock triggers: expiry, Lock, logout (the client
 * calls /lock on sign-out), the admin's own password change or an
 * admin reset of their password, deactivation or role change (the
 * user write paths delete the unlock row).
 *
 * Error contract: `danger_zone_locked` (403) when the gate is fine
 * but the step-up is missing/expired, so the UI shows the password
 * prompt instead of an error. It is deliberately NOT a 401: the
 * client's shared HTTP layer treats a 401 that carried the active
 * session token as a dead session and logs the user out — a locked
 * Danger Zone must never do that. 403 also covers anyone who is not
 * (DB-) a super admin. Unlock responses never reveal whether the
 * password or the role was the problem (and the client calls unlock
 * with a raw fetch, like the change-password flow, for the same
 * 401 reason).
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authLimiter } from '../../middleware.js';
import {
  buildDangerZoneOverview,
  createDangerZoneUnlock,
  DANGER_ZONE_UNLOCK_MINUTES,
  getActiveDangerZoneUnlock,
  getDangerZoneUnlockStatus,
  getStoredPasswordHash,
  resolveSuperAdminCaller,
  revokeDangerZoneUnlocks,
  type SuperAdminCaller,
} from '../../services/DangerZoneService.js';
import {
  getLeadQualityConfigForEdit,
  LEAD_QUALITY_SCALE,
  LeadQualityConfigValidationError,
  setLeadQualityConfig,
  type LeadQualityConfigInput,
} from '../../services/LeadQualityConfigService.js';
import {
  getSecurityPolicyForEdit,
  SECURITY_POLICY_BOUNDS,
  SecurityPolicyValidationError,
  setSecurityPolicy,
  type SecurityPolicyInput,
} from '../../services/SecurityPolicyService.js';
import {
  applyRoleDefaults,
  getRoleDefaultsForEdit,
  RoleDefaultsValidationError,
  setRoleDefaults,
  type RoleDefaultsInput,
} from '../../services/RoleDefaultsService.js';
import {
  getStageRulesForEdit,
  setStageRules,
  StageRulesValidationError,
  type StageRulesInput,
} from '../../services/StageRulesService.js';
import {
  dbErrorStatus,
  logAccessChange,
  requireAuth,
  sendDbUnavailable,
  sendJson,
  useDb,
} from './shared.js';

const router = Router();

const UNLOCK_FAILED_MESSAGE = 'Unlock failed. Check your password and try again.';
const LOCKED_MESSAGE = 'The Danger Zone is locked. Re-enter your password to continue.';

/** Unlock ids whose overview view has already been audit-logged. */
const viewLoggedUnlockIds = new Set<string>();

function clientIp(req: any): string | null {
  const ip = String(req?.ip || req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return ip ? ip.slice(0, 100) : null;
}

/**
 * Gate 2 of the Danger Zone: the caller must be a super admin
 * resolved FROM THE DATABASE (audit §3.1/§3.2). The JWT's role claim
 * is never consulted — a token minted before a demotion opens
 * nothing (finding A7, fixed for this gate by construction).
 * The Danger Zone needs the database: no DB (or dev demo mode) is a
 * 503, never a silent pass.
 */
async function requireSuperAdmin(req: any, res: any, next: any): Promise<void> {
  if (sendDbUnavailable(res)) return;
  if (!useDb()) {
    sendJson(res, 503, { success: false, message: 'The Danger Zone requires the database.' });
    return;
  }
  try {
    const claim = req.currentUser || {};
    const admin = await resolveSuperAdminCaller({
      id: claim.id,
      employeeId: claim.employeeId,
      email: claim.email,
    });
    if (!admin) {
      sendJson(res, 403, { success: false, message: 'You do not have permission to perform this action.' });
      return;
    }
    (req as any).dangerZoneAdmin = admin;
    next();
  } catch (error: any) {
    sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Danger Zone check failed.' });
  }
}

/** Gate 3: a valid, unexpired unlock row for this super admin. */
async function requireDangerZoneUnlock(req: any, res: any, next: any): Promise<void> {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  try {
    const unlock = await getActiveDangerZoneUnlock(admin.id);
    if (!unlock) {
      sendJson(res, 403, { success: false, error: 'danger_zone_locked', message: LOCKED_MESSAGE });
      return;
    }
    (req as any).dangerZoneUnlock = unlock;
    next();
  } catch (error: any) {
    sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Danger Zone check failed.' });
  }
}

router.post('/danger-zone/unlock', requireAuth, authLimiter, requireSuperAdmin, async (req: any, res) => {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  const password = String(req.body?.password || '');
  const ip = clientIp(req);
  try {
    const stored = await getStoredPasswordHash(admin.id);
    // bcrypt ONLY, fail closed: a stored value that is not a bcrypt
    // hash (legacy plaintext — audit finding A4) can never unlock,
    // even if the typed password equals it character for character.
    const ok = !!stored && stored.startsWith('$2') && password.length > 0
      ? await bcrypt.compare(password, stored)
      : false;
    if (!ok) {
      await logAccessChange({
        actorId: admin.id,
        targetUserId: admin.id,
        actionCode: 'danger_zone.unlock_failed',
        entityType: 'danger_zone',
        entityId: admin.id,
        metadata: { ip },
      });
      return sendJson(res, 401, { success: false, message: UNLOCK_FAILED_MESSAGE });
    }
    const unlock = await createDangerZoneUnlock(admin.id, ip);
    await logAccessChange({
      actorId: admin.id,
      targetUserId: admin.id,
      actionCode: 'danger_zone.unlock',
      entityType: 'danger_zone',
      entityId: admin.id,
      metadata: { ip, unlockedUntil: unlock.expires_at, lifetimeMinutes: DANGER_ZONE_UNLOCK_MINUTES },
    });
    return sendJson(res, 200, {
      success: true,
      unlocked: true,
      unlockedUntil: unlock.expires_at,
      expiresInSeconds: DANGER_ZONE_UNLOCK_MINUTES * 60,
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Unlock failed.' });
  }
});

router.get('/danger-zone/status', requireAuth, requireSuperAdmin, async (req: any, res) => {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  try {
    const status = await getDangerZoneUnlockStatus(admin.id);
    return sendJson(res, 200, {
      success: true,
      isSuperAdmin: true,
      unlocked: status.unlocked,
      unlockedUntil: status.unlockedUntil,
      secondsRemaining: status.secondsRemaining,
      unlockLifetimeMinutes: DANGER_ZONE_UNLOCK_MINUTES,
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Danger Zone status failed.' });
  }
});

router.post('/danger-zone/lock', requireAuth, requireSuperAdmin, async (req: any, res) => {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  try {
    await revokeDangerZoneUnlocks(admin.id);
    await logAccessChange({
      actorId: admin.id,
      targetUserId: admin.id,
      actionCode: 'danger_zone.lock',
      entityType: 'danger_zone',
      entityId: admin.id,
      metadata: { ip: clientIp(req) },
    });
    return sendJson(res, 200, { success: true, unlocked: false });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lock failed.' });
  }
});

router.get('/danger-zone/overview', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  const unlock = (req as any).dangerZoneUnlock;
  try {
    // "Who looked" is on record (audit §3.3) — once per unlock
    // session, not per request, so a screen left open does not flood
    // the audit log; each new unlock logs its first view again.
    if (!viewLoggedUnlockIds.has(unlock.id)) {
      viewLoggedUnlockIds.add(unlock.id);
      if (viewLoggedUnlockIds.size > 500) viewLoggedUnlockIds.clear();
      await logAccessChange({
        actorId: admin.id,
        targetUserId: admin.id,
        actionCode: 'danger_zone.view',
        entityType: 'danger_zone',
        entityId: admin.id,
        metadata: { ip: clientIp(req) },
      });
    }
    const overview = await buildDangerZoneOverview(unlock);
    return sendJson(res, 200, { success: true, data: overview });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Danger Zone overview failed.' });
  }
});

/* ====================================================================
   LEAD QUALITY CONFIG (DZ-3 — audit §2.6 F1–F6)
   --------------------------------------------------------------------
   The scorer's weights live in one versioned config row (Metadata
   Engine, type 'LeadQuality'). GET returns the current effective
   config + the code defaults + the version + the last change
   (who/when/old→new from the audit log, rendered only inside the
   Danger Zone per Q2). PUT saves one versioned config (version +1)
   and audit-logs old→new. Both sit behind the same three gates as
   the overview: requireAuth → DB-resolved super admin (403) →
   valid unlock else 403 danger_zone_locked (never 401 — a 401 logs
   the admin out via the shared HTTP layer).
==================================================================== */

router.get('/danger-zone/lead-quality', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  try {
    const data = await getLeadQualityConfigForEdit();
    return sendJson(res, 200, {
      success: true,
      data: { ...data, scale: LEAD_QUALITY_SCALE },
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Lead Quality config failed.' });
  }
});

router.put('/danger-zone/lead-quality', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  try {
    const saved = await setLeadQualityConfig(req.body as LeadQualityConfigInput, {
      actorId: admin.id,
      ip: clientIp(req),
    });
    return sendJson(res, 200, {
      success: true,
      data: { ...saved, scale: LEAD_QUALITY_SCALE },
    });
  } catch (error: any) {
    // Validation failures are the caller's fault (400, clear message);
    // anything else is a server/database failure (503 via dbErrorStatus).
    if (error instanceof LeadQualityConfigValidationError) {
      return sendJson(res, 400, { success: false, message: error.message });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Could not save Lead Quality config.' });
  }
});

/* ====================================================================
   SECURITY POLICY (DZ-4 — audit §2.1 A1/A5/A8/A9, §4)
   --------------------------------------------------------------------
   One versioned policy a super admin edits in the Danger Zone:
   minimum password length (A1, default 8, floor 5), per-account
   lockout on/off + threshold + duration (A9, default on / 10 / 30
   min, migration-022 columns), token lifetime in days (A5, default
   7, bounded 1–30, newly issued tokens only) and the failed-sign-in
   limit per 15 min per IP (A8, default 20, bounded 5–100; the window
   stays in code). No complexity toggles — the owner decided
   length-only (Q3). GET returns the current effective policy + the
   code defaults + the bounds + the version + the last change
   (who/when/old→new from the audit log, rendered only inside the
   Danger Zone per Q2). PUT saves one versioned policy (version +1)
   and audit-logs old→new. Both sit behind the same three gates as
   the overview: requireAuth → DB-resolved super admin (403) →
   valid unlock else 403 danger_zone_locked (never 401 — a 401 logs
   the admin out via the shared HTTP layer).
==================================================================== */

router.get('/danger-zone/security-policy', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  try {
    const data = await getSecurityPolicyForEdit();
    return sendJson(res, 200, {
      success: true,
      data: { ...data, bounds: SECURITY_POLICY_BOUNDS },
    });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Security policy failed.' });
  }
});

router.put('/danger-zone/security-policy', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  try {
    const saved = await setSecurityPolicy(req.body as SecurityPolicyInput, {
      actorId: admin.id,
      ip: clientIp(req),
    });
    return sendJson(res, 200, {
      success: true,
      data: { ...saved, bounds: SECURITY_POLICY_BOUNDS },
    });
  } catch (error: any) {
    // Validation failures are the caller's fault (400, clear message);
    // anything else is a server/database failure (503 via dbErrorStatus).
    if (error instanceof SecurityPolicyValidationError) {
      return sendJson(res, 400, { success: false, message: error.message });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Could not save security policy.' });
  }
});

/* ====================================================================
   ROLE DEFAULTS (DZ-5 — audit §2.2 B6, §4)
   --------------------------------------------------------------------
   The defaults table — which permission codes and which data
   visibility scope a standard role holds before anyone configures
   it — is editable here. GET returns the current effective table +
   the code defaults + the canonical permission codes (from the
   permissions table, so the editor never invents a code) + the
   roles currently holding zero grants (what Apply would touch) +
   the last change (who/when/old→new, rendered only inside the
   Danger Zone per Q2). PUT saves one versioned table (version +1)
   and audit-logs old→new; saving alone changes NO role. POST
   .../apply runs the guarded apply routine (zero-grant roles only,
   visibility only while still 'Own') and audit-logs what it
   actually changed. All three sit behind the same three gates as
   the overview: requireAuth → DB-resolved super admin (403) →
   valid unlock else 403 danger_zone_locked (never 401 — a 401 logs
   the admin out via the shared HTTP layer).
==================================================================== */

router.get('/danger-zone/role-defaults', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  try {
    const data = await getRoleDefaultsForEdit();
    return sendJson(res, 200, { success: true, data });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Role defaults failed.' });
  }
});

router.put('/danger-zone/role-defaults', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  try {
    const saved = await setRoleDefaults(req.body as RoleDefaultsInput, {
      actorId: admin.id,
      ip: clientIp(req),
    });
    return sendJson(res, 200, { success: true, data: saved });
  } catch (error: any) {
    // Validation failures are the caller's fault (400, clear message);
    // anything else is a server/database failure (503 via dbErrorStatus).
    if (error instanceof RoleDefaultsValidationError) {
      return sendJson(res, 400, { success: false, message: error.message });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Could not save role defaults.' });
  }
});

router.post('/danger-zone/role-defaults/apply', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  try {
    const result = await applyRoleDefaults({
      actorId: admin.id,
      ip: clientIp(req),
    });
    return sendJson(res, 200, { success: true, data: result });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Could not apply role defaults.' });
  }
});

/* ====================================================================
   STAGE RULES + TERMINAL (DZ-6 — audit §2.4 D2/D3, §4, §5 Finding 5)
   --------------------------------------------------------------------
   The per-status required-field rules and the terminal flags live
   here now: the rules in the lead_stage_rules table (migration 060,
   keyed by FollowUpStatus dictionary-entry id, so a rename keeps
   its rule) and the terminal flags on the dictionary rows
   themselves (meta.isTerminal — the single source every "open lead"
   definition reads). GET returns the current effective rules +
   the code defaults + the field vocabulary + the per-status
   options (terminal / won / lost / current rule) + the version +
   the last change (who/when/old→new, rendered only inside the
   Danger Zone per Q2). PUT saves one versioned set (version +1)
   and audit-logs old→new; saving alone changes no lead, but the
   follow-up endpoint enforces the saved rules from the next
   request on. Both sit behind the same three gates as the overview:
   requireAuth → DB-resolved super admin (403) → valid unlock else
   403 danger_zone_locked (never 401 — a 401 logs the admin out via
   the shared HTTP layer).
==================================================================== */

router.get('/danger-zone/stage-rules', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  try {
    const data = await getStageRulesForEdit();
    return sendJson(res, 200, { success: true, data });
  } catch (error: any) {
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Stage rules failed.' });
  }
});

router.put('/danger-zone/stage-rules', requireAuth, requireSuperAdmin, requireDangerZoneUnlock, async (req: any, res) => {
  const admin = (req as any).dangerZoneAdmin as SuperAdminCaller;
  try {
    const saved = await setStageRules(req.body as StageRulesInput, {
      actorId: admin.id,
      ip: clientIp(req),
    });
    return sendJson(res, 200, { success: true, data: saved });
  } catch (error: any) {
    // Validation failures are the caller's fault (400, clear message);
    // anything else is a server/database failure (503 via dbErrorStatus).
    if (error instanceof StageRulesValidationError) {
      return sendJson(res, 400, { success: false, message: error.message });
    }
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Could not save stage rules.' });
  }
});

export default router;
