/**
 * operationsLimits.ts — code ceilings for the DZ-2 bounded
 * operational limits (audit §4: G1, G2, M1).
 * ------------------------------------------------------------------
 * These numbers are the DEFAULTS and the CODE CEILINGS for the
 * Settings values served by OperationsSettingsService: an admin may
 * lower a limit but never raise it above the ceiling.
 *
 * This module intentionally has NO imports. It is imported by
 * `server/routes/userBulkImport.ts`, which several test suites import
 * at TOP LEVEL (before their before() sets process.env.JWT_SECRET) —
 * any import chain that reaches `routes/production/shared.ts` would
 * snapshot an empty JWT_SECRET at module load and break auth in
 * those suites (the DZ-2 regression in user-management-um1.test.ts).
 * Keep this file dependency-free.
 */
export const LEAD_BULK_IMPORT_MAX_ROWS_CEILING = 5000;
export const LEAD_BULK_IMPORT_MAX_ROWS_FLOOR = 100;
export const USER_BULK_IMPORT_MAX_ROWS_CEILING = 1000;
export const USER_BULK_IMPORT_MAX_ROWS_FLOOR = 10;
export const IMAGE_UPLOAD_MAX_MB_CEILING = 1.5;
export const IMAGE_UPLOAD_MAX_MB_FLOOR = 0.5;
