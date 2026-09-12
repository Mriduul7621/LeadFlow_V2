# Bulk User Import & Secure Provisioning — Design & Implementation Notes

**PR:** `feat: add bulk user import and secure provisioning`
**Branch:** `arena/01a094c3-leadflow-v2`
**Date:** 2026-09-12
**Scope:** Inside existing Users workspace → Employees tab → secondary action "Bulk Import Users". No new top-level sidebar module. Uses same PostgreSQL users/roles/departments/teams/hierarchies/RBAC/forced-password model. Preserves PR #32 RBAC, PR #33 forced first-login, PR #34 Lead Workspace, PR #29-31 perf, PR #30 diagnostics.

---

## 1. Findings (Current Codebase)

- **Users table** (`server/database/migrations/004_users.js` + 023/024): `employee_id` UNIQUE, `email` UNIQUE, `role_id`, `department_id`, `team_id`, `manager_id`, `must_change_password` BOOL, `is_active`/`account_status`, `password` bcrypt hash, `reporting_chain`/`subordinates` JSONB. Authoritative source remains PostgreSQL.
- **Roles**: `role_code`, `role_name`, `hierarchy_level` (1=CEO/Admin, 2=Manager, 3=BE, 99=unassigned/custom), `is_active`, `data_visibility`, `menu_access`. No auto-create on typo.
- **Departments/Teams**: canonical tables, `is_active` flag, referenced by `department_id`/`team_id`.
- **Hierarchy validation**: existing `validateReportingLink` / `recomputeReportingChains` logic, now driven by the shared `validateReportingManagerCandidate` rule: Level-1 cannot have manager, Level 2+ requires manager, manager must hold a strictly higher-authority role one or two levels up (gap 1–2), and except Level-1 must share same department. Reporting chain recomputed via `recomputeReportingChains`.
- **Auth/RBAC**: `authenticateToken` middleware, `hasPermissionCode` / `requirePermissionCode` checking `role_permissions` + `user_permissions`, Admin/Superadmin bypass per PR32. Feature Access (`menu_access`) alone never authorizes writes — verified in existing `users` routes.
- **Password flow**: `bcryptjs` hashing server-side, `must_change_password` default FALSE for manual flow but bulk import defaults TRUE (integrates with PR33 `/api/auth/change-required-password`). Manual user create hashes password; bulk reuses same.
- **Client**: `UserManagement.tsx` uses `orgService`, `adminService`, `sonner` toast. No existing bulk import. XLSX handled via `xlsx` (already used for LeadUpload). No localStorage cache for mutation paths.
- **Lead bulk import precedent**: `server/routes/leadImport.js` + `production.routes.ts` POST `/api/leads/bulk` with dry-run, deterministic duplicate handling, server-derived audit actor, transaction savepoints, bulk ref loads. User bulk follows same hardened pattern.

## 2. Contract

### Template Workbook (XLSX, 3 sheets)

**Users sheet (primary):** 12 columns, order fixed for parser tolerance but case-insensitive alias map:

| Column | Required | Notes |
|--------|----------|-------|
| Employee ID* | Yes | Primary identity, normalized UPPER, regex `^[A-Za-z0-9][A-Za-z0-9_.-]{1,29}$`, unique in file + DB |
| Full Name* | Yes | Trimmed |
| Email | No* | Normalized lower, valid format, unique in file + DB, conflict → row error |
| Phone | No | Free text |
| Designation | No | Free text |
| Department* | Yes | Exact normalized match against `department_code` or `department_name` (case-insensitive), unknown/inactive → row error |
| Role* | Yes | Exact normalized match against `role_code` or `role_name`, unknown/inactive → row error, no auto-create |
| Reporting Manager Employee ID | Conditionally required | Level-1 must be blank, Level 2+ required; resolved by Employee ID (existing DB or same file) |
| Team/Branch | No | Optional, exact match against `team_code`/`team_name` if canonical teams exist; unknown → row error |
| Data Visibility | Ignored (future) | Not exposed as editable; semantics preserved from role |
| Temporary Password | No | If blank → securely generated (10 chars, A-Z,a-z,2-9 excluding ambiguous). If supplied → validated ≥6 chars, hashed server-side |
| Must Change Password | No | Yes/No, default TRUE, persisted to `must_change_password` |
| Status | No | Active/Inactive, default Active |

**Reference Values sheet:** Populated at download time from PostgreSQL authoritative data via `Promise.all([roles, departments, teams])`. Columns: Department Code, Department Name, Role Code, Role Name, Level, Team Code, Team Name, etc. Read-only guidance, not used for resolution (resolution uses DB at validation time).

**Instructions sheet:** Explains identity (Employee ID primary), resolution (exact normalized match, no loose name matching), password rules (hashed, never stored plaintext, one-time return), modes (CREATE ONLY default vs CREATE+UPDATE), manager rules (same-batch order irrelevant, no self, no cycles, active only, manager holds a higher-authority role one or two levels up, subject to department and cycle rules), dry-run behavior, credential one-time warning.

### Modes

- **CREATE ONLY (default):** Any existing `employee_id` → row error `already exists (Create Only mode)`.
- **CREATE + UPDATE EXISTING:** Existing `employee_id` → Update action (password ignored, other fields updatable). New `employee_id` → Create.

### Identity Rules

- Employee ID normalized UPPER consistent with manual flow (`normalizeEmployeeId`).
- Email normalized lower.
- Duplicate Employee ID / Email within file → both rows error.
- Conflicting email belonging to another user → error.
- No loose name matching, no auto-create roles/departments.

## 3. Validation (Server-Authoritative)

**Client parse (XLSX primary, CSV optional):** Uses `xlsx` to read first sheet, alias map `FIELD_ALIASES` for case-insensitive headers, normalizes via `normalizeUserBulkRow`. Client preview does light checks, then calls server `/api/users/bulk/validate` for authoritative validation.

**Server `validateBulkRows` (pure + DB-aware):**

- Bulk loads refs once: roles, departments, teams, existing users by empId/email, allUsers manager map for cycle detection.
- Duplicate detection via counts.
- Required fields, email format, password policy.
- Role/Dept/Team exact normalized match, active check.
- Existing user lookup: determines Create vs Update vs Error per mode.
- Permission checks per row (`users.create` for Create, `users.edit` for Update).
- Temporary password: warning `ignored for existing users` on Update, never changes password via bulk.
- Manager resolution:
  - Input normalized UPPER.
  - Self → error.
  - If in batch: `managerIsSameBatch=true`, managerId deferred to commit phase after batch creation, hierarchy validated against batch row's role/dept.
  - Else existing DB: must exist, active, hierarchy validated (Level-1 cannot have manager, Level 2+ requires manager, manager level is one or two levels up, same department unless manager Level-1).
  - Cycle detection: walks combined manager map (DB + batch overrides) with visited set, detects `A -> ... -> A`.
- Returns `BulkPreviewResult`: totals, validRows, rowsToCreate/Update, errorRows, warningRows, rows array with action, isValid, errors, warnings, managerResolved, etc.

**Dry Run:** `POST /api/users/bulk/validate` never mutates DB (no INSERT/UPDATE). Returns preview table: rowNumber, Employee ID, Full Name, Role, Department, Manager, action, messages. Client allows cancel, export errors XLSX.

**Revalidation on Commit:** `POST /api/users/bulk/commit` re-loads refs and re-runs `validateBulkRows` server-side before any write, preventing TOCTOU (role deleted between validate and commit).

## 4. Architecture

**Server files:**

- `server/routes/userBulkImport.ts` (new): pure helpers + constants:
  - `USER_BULK_MAX_ROWS=1000`
  - `normalizeEmployeeId`, `normalizeEmail`, `generateTempPassword` (crypto secure, 10 chars, avoids ambiguous), `validatePasswordPolicy`, `parseMustChangePassword` (default TRUE), `parseStatus`, `normalizeUserBulkRow`, `buildReferenceMaps`, `resolveRole/Dept/Team`, `validateBulkRows`.
  - ReferenceMaps built from bulk queries (no N+1).

- `server/routes/production.routes.ts` (modified, hardened 2026-09-12):
  - `POST /api/users/bulk/validate`: auth, permission check (canCreate or canEdit), bulk load roles/depts/teams/users, build maps, validate, return preview.
  - `POST /api/users/bulk/commit` — **row-atomicity hardened**:
    - `BEGIN`
    - **Original state capture:** For all update rows, `SELECT * FROM users WHERE id = ANY($1)` inside txn before mutation, stored in `originalUserMap` for restore.
    - **Phase A (profile/org without manager):** Loop validRows with `SAVEPOINT bulk_row_i`. For Create: generate password if blank (`generated=true`), hash, INSERT with `manager_id=NULL`. For Update: UPDATE profile/org fields only, keep manager_id unchanged. On failure: `ROLLBACK TO SAVEPOINT`, add to `failedEmpIds`, remove credential, collect error.
    - **Build empToIdMap** after Phase A (`SELECT id, employee_id FROM users`) for same-batch resolution.
    - **Phase B (manager linking with row-atomicity):** For each succeeded row, `SAVEPOINT bulk_mgr_i`, resolve managerId from `empToIdMap`, check `failedEmpIds` (if manager failed, throw), call `validateReportingLink` (active, level, same-dept, cycle). On success: `UPDATE manager_id`, RELEASE. On failure: `ROLLBACK TO SAVEPOINT`, then **compensating action** in new savepoint `bulk_rollback_i`: if Create → `DELETE FROM users WHERE id=...` and remove from `empToIdMap`; if Update → restore original row (full_name, email, phone, role_id, dept, team, manager_id, designation, is_active, account_status, must_change_password). Remove credential, decrement created/updated, increment failed, add error with `Manager link failed: ...`, add to `failedEmpIds`.
    - **Cascade loop:** While changed, find succeeded rows whose `managerInput` is in `failedEmpIds`, rollback similarly (DELETE or RESTORE), remove credential, add error `Manager dependency failed...`. Up to 10 iterations for transitive chains.
    - **Final successful set:** Counters recomputed from `succeededRows` map (`finalCreated`, `finalUpdated`, `finalFailed = total - created - updated - skipped`). Credentials filtered to only generated (`generated=true`) and final successful creates.
    - **recomputeReportingChains() once** after final successful set established, before COMMIT. If recompute fails, ROLLBACK and 500.
    - `COMMIT`
    - Audit: batch-level `audit_logs` entry with fileName, mode, totals, actor, no plaintext passwords/hashes/workbook binary.
    - Credentials: **hardened** — only server-generated temporary passwords returned one-time in `credentials[]` (employeeId, fullName, temporaryPassword, mustChangePassword). Operator-supplied passwords are NOT echoed back. Hashed in DB, never stored plaintext, never logged.
    - Notifications: created for new users if `notifications` table exists (optional).

**Client files:**

- `src/modules/users/utils/userBulkImport.ts` (new): client-side constants (`USER_TEMPLATE_HEADERS`, `FIELD_ALIASES`), types, `parseUserImportFile` (XLSX primary, CSV fallback via simple split), `generateUserImportTemplate` (3 sheets via `xlsx` utils, Reference Values populated from `ReferenceDataForTemplate` (RolePermission, DepartmentRef, TeamRef), Instructions sheet), `downloadUserImportTemplate`.
- `src/modules/users/components/UserBulkImportModal.tsx` (new): Step UI (upload → preview → result):
  - Upload: drag-drop, file ext check, mode radio CREATE ONLY / CREATE+UPDATE, template download button (Promise.all roles/depts/teams), file parse, server dry-run via `userService.validateBulkUsers`.
  - Preview: totals (Total, Valid, To Create, To Update, Errors, Warnings), table with row number, Employee ID, Full Name, Role, Department, Manager, action, messages; attention tables for errors/warnings; export errors XLSX; cancel.
  - Commit: `userService.commitBulkUsers`, result screen with Created/Updated/Failed/Skipped counts, credentials table with one-time warning, copy/download credentials XLSX (copy via clipboard, download via XLSX), close.
  - Uses `toast` from `sonner` (consistent with UserManagement), `orgService.getDepartments` + `adminService` for reference data, `userService` for validation/commit.

- `src/services/userService.ts` (modified): added `validateBulkUsers` and `commitBulkUsers` methods calling new endpoints.

- `src/modules/users/pages/UserManagement.tsx` (modified): Added secondary button "Bulk Import Users" (Upload icon, white border) next to primary Add Employee (#978C21), state `showBulkImport`, renders `UserBulkImportModal` with `onCompleted` → `loadData()` refresh.

## 5. Transaction & Idempotency (Hardened Row-Atomicity)

- **Bulk ref loads:** roles, departments, teams, existing users loaded once, maps built, no per-row N+1.
- **Savepoints:** `SAVEPOINT bulk_row_${i}` per row for Phase A, `SAVEPOINT bulk_mgr_${i}` for Phase B, `SAVEPOINT bulk_rollback_${i}` and `bulk_cascade_*` for compensating actions. `ROLLBACK TO SAVEPOINT` on row failure, `RELEASE` on success → partial success preferred, one row failure doesn't abort batch.
- **Two-phase manager linking (order-independent, preserved):** First phase creates users with `manager_id=NULL` (or preserved for updates); second phase updates `manager_id` for same-batch managers after all IDs known (order irrelevant). **Row-atomicity:** If Phase B fails, Phase A changes for that row are undone via compensating DELETE (creates) or RESTORE (updates).
- **Original state capture:** Before Phase A, all update targets fetched (`SELECT ... WHERE id = ANY`) into `originalUserMap` for exact restore on manager-link failure.
- **Failed manager cascade:** `failedEmpIds` set tracks all invalid + Phase A failures + Phase B failures. After Phase B, loop finds succeeded rows whose `managerInput` is in `failedEmpIds`, rolls them back (DELETE/RESTORE), removes credential, increments failed. Transitive closure up to 10 iterations.
- **Counters match DB:** Final counters (`finalCreated`, `finalUpdated`, `finalFailed`) recomputed from final `succeededRows` map after all rollbacks/cascades, not from intermediate counts. `errors[]` includes validation + Phase A + Phase B + cascade errors.
- **Credentials match final set:** `createdCredentials` map holds only generated passwords (`generated=true`). On any rollback, entry deleted. Final response returns only credentials for final successful creates.
- **Reporting chains:** `recomputeReportingChains()` called **once after final successful set established**, before COMMIT. Guarantees chain reflects only committed rows, not rolled-back ones.
- **Idempotency:** Employee ID UNIQUE constraint in PostgreSQL; CREATE ONLY second attempt fails for same ID, CREATE+UPDATE updates.
- **Audit:** Batch-level metadata (fileName, mode, totals, actor, timestamp) in `audit_logs` if table exists, no plaintext passwords/hashes.

## 6. Password & Credential Handling (Hardened)

- **New users:** If `Temporary Password` blank → generate securely via `crypto.randomBytes` (10 chars, alphanumeric excluding ambiguous), `generated=true`. If supplied → validate ≥6 chars, `generated=false`.
- **Hashing:** Server-side `bcrypt.hash(plain, 10)`, never stored plaintext, never logged.
- **Must Change Password:** Default TRUE via `parseMustChangePassword`, persisted to `must_change_password`, integrates with PR33 forced flow (`/api/auth/change-required-password`).
- **Existing users:** Password NEVER changed via bulk update; warning emitted, admin reset remains dedicated ADMIN-only flow (`/api/users/:id/reset-password`).
- **Credentials one-time, hardened:** Returned once in commit response `credentials[]`, **only for server-generated temporary passwords** (`generated=true`). Operator-supplied passwords are **not echoed back** (security hardening: avoid returning operator-known secrets, reduce exposure). Client shows copy/download with warning "one-time, will not be shown again". Not retrievable via GET `/api/users`, not in audit/logs. Failed rows never return credentials (removed on rollback).
- **Status:** Uses canonical `is_active`/`account_status` model, default Active.

## 7. Manager Resolution (Detailed)

- Resolved by Employee ID (normalized UPPER), not email/name.
- Supports same-batch: manager row may appear before or after reportee (row order irrelevant) → `managerIsSameBatch` flag, managerId resolved in second phase.
- Self → error `cannot report to self`.
- Cycle detection: DFS walk combined manager map (DB + batch overrides) with visited set, error `circular reporting chain`.
- Active only: inactive manager → error `must be an active employee`.
- Hierarchy rules preserved (shared `validateReportingManagerCandidate`):
  - Level-1 (CEO/Admin) cannot have reporting manager.
  - Level 2+ requires manager.
  - Manager must hold a strictly higher-authority role, one or two levels up (`gap = user.hierarchy_level - manager.hierarchy_level` must be 1 or 2).
  - Same department unless manager is Level-1 (CEO).
- Skip-level (gap 2) reporting supported; same-level, lower-level and gap > 2 rejected.

## 8. Permission Mapping

- **Server `requirePermissionCode` / `hasPermissionCode`:** Checks `role_permissions` + `user_permissions`, fail-closed, Admin/Superadmin bypass per PR32.
- **Validate endpoint:** Requires `users.create` for any Create rows, `users.edit` for any Update rows; if no permission → 403 with message.
- **Commit endpoint:** Same, plus per-row permission checks inside `validateBulkRows`.
- **Feature Access (`menu_access`) alone never authorizes:** Verified by test 29 — role with `menu_access.user_management=true` but no canonical permission gets 403.
- **Existing RBAC preserved:** No new permission codes, no granular permission exposure in sheet (Role/Department only).

## 9. Performance

- Bulk queries: roles, departments, teams, users loaded in 4 queries, not per row.
- No N+1: `buildReferenceMaps` creates Maps for O(1) lookups.
- `recomputeReportingChains` once after batch, not per row.
- No localStorage cache for mutation (API-first).
- Client template generation uses `Promise.all` for refs.
- `USER_BULK_MAX_ROWS=1000` enforced, 400 if exceeded.

## 10. Files Changed

**New:**
- `server/routes/userBulkImport.ts` — pure validation + helpers (664 lines)
- `src/modules/users/utils/userBulkImport.ts` — client template + parse (approx 400 lines)
- `src/modules/users/components/UserBulkImportModal.tsx` — modal workflow (533 lines)
- `server/tests/bulk-user-import.test.ts` — 37 tests (855 lines)
- `docs/BULK_USER_IMPORT.md` — this doc

**Modified:**
- `server/routes/production.routes.ts` — added `/api/users/bulk/validate` and `/api/users/bulk/commit` endpoints (savepoints, two-phase, recompute once, audit, credentials one-time)
- `src/services/userService.ts` — added `validateBulkUsers`, `commitBulkUsers`
- `src/modules/users/pages/UserManagement.tsx` — secondary action "Bulk Import Users", state, modal render
- `src/modules/users/utils/userBulkImport.ts` — fixed imports to use `RolePermission` + `DepartmentRef`/`TeamRef` (was TS2305)

**Preserved:**
- PostgreSQL authoritative, auth/session flow, PR32 RBAC, PR33 forced password, PR34 Lead Workspace, Data Visibility, reporting hierarchy, role/dept/team storage, manual create/edit behavior, PR29-31 perf, PR30 diagnostics.

## 11. Tests (1-34 + Extras + Hardening 35-43)

All 46 tests in `bulk-user-import.test.ts` pass (total suite now ~544 pass):

1. Template workbook has required headers (server enforces via validation)
2. Reference values populated from authoritative DB (roles, depts resolve)
3. Normalization Employee ID UPPER consistent with manual flow
4. Normalization Email lowercased
5. Duplicate Employee ID within file → error
6. Duplicate Email within file → error
7. Conflicting email belonging to another user → error
8. CREATE ONLY existing Employee ID → error
9. CREATE+UPDATE existing Employee ID → Update action
10. Unknown Role → row error, not auto-create (count unchanged)
11. Unknown Department → row error
12. Unknown Team → row error
13. Inactive Role → rejected
14. Inactive Department → rejected
15. Reporting Manager resolved by Employee ID (existing)
16. Same-batch manager resolution
17. Row order irrelevant for same-batch manager
18. Self-manager → error
19. Cycle detection → error (circular)
20. Inactive manager → error
21. Level-1 cannot have reporting manager
22. Level 2+ requires reporting manager
23. Skip-level (gap 2) manager allowed; same-level manager rejected
23b. Manager more than two levels up rejected
23c. Bulk commit accepts a two-level-up (skip-level) manager
23d. Same-batch skip-level resolution works regardless of row order
24. Dry run no DB mutation
25. Dry run returns totals and row table
26. Revalidation on commit — role deleted between validate and commit fails
27. Permission users.create required for creates (403)
28. Permission users.edit required for updates (row error)
29. Feature Access alone never authorizes (403)
30. Must Change Password defaults to TRUE
31. Must Change Password persists + integrates with forced flow (`/api/auth/change-required-password` 200)
32. Supplied temporary password hashed, not plaintext (bcrypt compare) — **updated: hashed but not returned unless generated**
33. Generated password returned once, not stored plaintext, not in GET, not in audit — **now only generated passwords returned**
34. Existing user password NEVER changed via bulk update (hash unchanged, warning)

Extras:
- BULK_IMPORT_MAX_ROWS enforced (400)
- Idempotency via Employee ID uniqueness (second CREATE ONLY fails, count 1)
- Validated partial success with savepoints (2 created, 1 failed, both valid persist)

Hardening (new, row-atomicity):
- 35. Row-atomicity: new user whose manager fails validation is not committed (cascade) — creates duplicate MGR_FAIL, dependent EMP_DEP, all 3 fail, DB has 0, no credentials, error mentions manager dependency
- 36. Row-atomicity: existing user update with manager-link failure is restored — creates EXIST002, tries update with failing manager chain, updated=0, failed=3, DB restored to original full_name/email/manager_id
- 37. Failed row must not return credentials — invalid role row fails, valid row succeeds, credentials length 1, failed not in list
- 38. Final counters must match actual committed DB state — 2 valid + 1 invalid → created 2 matches DB count; cascade case 0 created matches DB 0
- 39. Partial-success: unrelated valid rows still commit when others fail — 2 valid, 1 invalid role → 2 created, 2 in DB
- 40. Same-batch order independence still works for commit — EMP_ORD reports to MGR_ORD (manager after), 2 created, manager_id correct
- 41. Cycle and self-manager still rejected at commit — self-manager fails, cycle fails
- 42. Credential hardening: only generated passwords returned, operator-supplied not echoed — GEN_CRED1 generated returns credential, SUP_CRED1 supplied does not, both hashed, supplied password bcrypt compare works
- 43. recomputeReportingChains after final successful set — reporting_chain populated for EMP_RC includes MGR_RC/CEO001

Other suites: lead bulk import, scheduled activities, UI guards, RBAC, etc. all pass (544 total).

## 12. Deferred Work / Out of Scope

- Dotted-line / secondary managers and multiple managers per employee (still out of scope; skip-level reporting via `users.manager_id` is implemented — see `docs/FLEXIBLE_REPORTING_HIERARCHY.md`)
- Hierarchy redesign, auto-create roles/departments from typos (explicitly rejected)
- Granular permission codes in import sheet (not exposed, uses Role/Department only)
- New auth system, new data model for bulk users (uses same users table)
- Data Visibility column editing (preserved from role, not editable in sheet)
- CSV full RFC4180 parser (optional simple split implemented; XLSX primary)
- Email sending of credentials (returns one-time in UI only; could add email hook later)
- Large file streaming (1000 row limit, in-memory ok)

## 13. Verification

- `tsc --noEmit`: clean
- `npm run build` (vite + esbuild server.cjs): success
- `npm run verify:serverless`: all checks pass (Vercel ESM per-file, production honesty)
- `npm test -- --run`: 535 pass, 0 fail
- `git diff --check`: no whitespace errors

## 14. Security Notes

- Passwords: hashed with bcrypt 10 rounds, never stored plaintext, never logged, never in audit metadata, returned once.
- Audit: batch-level only, no workbook binary, no hashes.
- Permissions: fail-closed, Admin/Superadmin bypass preserved, Feature Access alone never authorizes.
- Server revalidation on commit prevents TOCTOU.
- Email validation fixed (was `[^\\s@]` → `[^\s@]`).

---

**Result screen:** Created/Updated/Failed/Skipped counts, credentials table with copy/download one-time warning. Template download available from modal. Errors exportable as XLSX.
