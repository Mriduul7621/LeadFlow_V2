import { Router } from 'express';
import { getPool } from '../database/connection.js';

import authRouter from './production/auth.routes.js';
import notificationsRouter from './production/notifications.routes.js';
import operationsRouter from './production/operations.routes.js';
import metadataRouter from './production/metadata.routes.js';
import calendarRouter from './production/calendar.routes.js';
import dangerZoneRouter from './production/dangerZone.routes.js';
import roadshowsRouter from './production/roadshows.routes.js';
import usersRouter from './production/users.routes.js';
import leadsRouter from './production/leads.routes.js';
import dashboardRouter from './production/dashboard.routes.js';
import {
  demoModeAllowed,
  sendJson,
  useDb,
} from './production/shared.js';

// The caller-resolution surface stays importable from this module (the
// test suite and the remaining domains consume it here); the single
// definition lives in ./production/shared.js.
export { getCallerDbInfo, hasPermissionCode, resolveCallerVisibility, isLeadAccessible, resolveAssignedTo, isAssignedToAllowed, type CallerDbInfo, type CallerVisibilityResult } from './production/shared.js';

// The reporting-ladder validators moved with the users/access domain;
// they stay importable from this module (the test suite imports them
// here) via this re-export of the single definition in users.routes.
export { validateReportingLink, recomputeReportingChains } from './production/users.routes.js';

// The hardened lead-record helpers moved with the leads domain; they
// stay importable from this module (the test suite imports them here)
// via this re-export of the single definition in leads.routes.
export { FORBIDDEN_CUSTOM_KEYS, sanitizeCustomFields, buildSecureLeadRecord } from './production/leads.routes.js';

/**
 * production.routes.ts — LeadFlow mounted API.
 * ------------------------------------------------------------------
 * ARCHITECTURE
 *   Frontend UI -> /api/* -> this router -> PostgreSQL (Supabase)
 *
 * RULES ENFORCED HERE
 *   1. When DATABASE_URL is configured, every database-backed entity is
 *      read/written exclusively through PostgreSQL. In-memory stores are
 *      NEVER used as a fallback after a database failure.
 *   2. In production (NODE_ENV=production / VERCEL) a missing DATABASE_URL
 *      yields HTTP 503 - data is never silently kept in memory.
 *   3. In development only, when no DATABASE_URL exists, an explicit
 *      in-memory demo mode is used so the UI stays usable locally. It is
 *      clearly labelled (X-Data-Mode: dev-demo) and never active in
 *      production.
 *   4. Every mutation returns the persisted record and a meaningful
 *      error/status on failure; nothing is reported as success unless the
 *      database committed it.
 *   5. Authorization is enforced here, never trusted from the UI: admin
 *      mutations require the ADMIN role, user-scoped routes require the
 *      caller to be the subject or an admin, lead deletion requires
 *      admin/grant/ownership, and admins cannot strand the org without
 *      an administrator or lock out their own account.
 * ------------------------------------------------------------------
 */

const router = Router();


/* ====================================================================
   DB STATUS / HEALTH
==================================================================== */

router.get('/db-status', async (_req, res) => {
  if (!useDb()) {
    const status = demoModeAllowed() ? 200 : 503;
    return sendJson(res, status, {
      connected: false,
      message: demoModeAllowed()
        ? 'DATABASE_URL is not set. Running in development demo mode (in-memory, not persistent).'
        : 'DATABASE_URL is not configured. The application cannot persist data in production.',
      mode: demoModeAllowed() ? 'dev-demo' : 'db-unconfigured',
    });
  }
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    return sendJson(res, 200, { connected: true, message: 'Database connected.', mode: 'database' });
  } catch (error: any) {
    return sendJson(res, 503, {
      connected: false,
      message: error?.message || 'Database is unavailable.',
      mode: 'database-unreachable',
    });
  }
});

/* ====================================================================
   AUTH — extracted to ./production/auth.routes.ts (Phase 1). Mounted
   here, at the position the handlers originally occupied, so route
   registration order is unchanged.
==================================================================== */

router.use(authRouter);

/* ====================================================================
   USERS / ACCESS — extracted to ./production/users.routes.ts
   (Phase 1, no behaviour change); mounted here to preserve the
   original registration position.
==================================================================== */

router.use(usersRouter);

/* ====================================================================
   METADATA — extracted to ./production/metadata.routes.ts
   (Phase 1, no behaviour change); mounted here to preserve the
   original registration position.
==================================================================== */

router.use(metadataRouter);

/* ====================================================================
   CALENDAR SETTINGS — ./production/calendar.routes.ts (calendar
   upgrade PR C): weekend config + government holidays. New paths
   (/calendar/*) — no overlap with the domains above.
==================================================================== */

router.use(calendarRouter);

/* ====================================================================
   OPERATIONS & LIMITS — ./production/operations.routes.ts (Admin
   Control programme, slice DZ-2): bounded import caps + image
   upload limit as real Settings values. New paths
   (/settings/operations) — no overlap with the domains above.
==================================================================== */

router.use(operationsRouter);

/* ====================================================================
   DANGER ZONE — ./production/dangerZone.routes.ts (Admin Control
   programme, slice DZ-0): super-admin gate + password step-up +
   read-only rule shell. New paths (/danger-zone/*) — no overlap
   with the domains above.
==================================================================== */

router.use(dangerZoneRouter);

/* ====================================================================
   NOTIFICATIONS — extracted to ./production/notifications.routes.ts
   (Phase 1, no behaviour change); mounted here to preserve the
   original registration position.
==================================================================== */

router.use(notificationsRouter);

/* ====================================================================
   LEADS — extracted to ./production/leads.routes.ts (Phase 1, no
   behaviour change); mounted here to preserve the original
   registration position.
==================================================================== */

router.use(leadsRouter);


/* ====================================================================
   ROADSHOWS + SCHEDULED ACTIVITIES — extracted to
   ./production/roadshows.routes.ts (Phase 1, no behaviour change);
   mounted here to preserve the original registration position.
==================================================================== */

router.use(roadshowsRouter);


/* ====================================================================
   DASHBOARD — extracted to ./production/dashboard.routes.ts
   (Phase 1, no behaviour change); mounted here to preserve the
   original registration position.
==================================================================== */

router.use(dashboardRouter);

export default router;
