# Flexible Skip-Level Reporting Hierarchy

## 1. Business rule

An employee may report **directly** to a valid higher-level manager even when
the immediately preceding hierarchy level does not exist — or when the business
intentionally wants the employee to report to a higher authority.

```
Old (strict):     Level 4 employee → Level 3 manager → Level 2 manager
New (supported):  Level 4 employee → Level 2 manager   (skip-level)
```

There is **no** separate skip-level reporting model. The existing
`users.manager_id` column remains the single source of truth for the *direct*
reporting relationship. An employee still has exactly **one** direct manager.

## 2. Direct manager stays `users.manager_id`

- `users.manager_id` is the **direct** reporting relationship (self-referencing FK).
- `reporting_chain` / `subordinates` are always **recomputed** from the actual
  `manager_id` graph via `recomputeReportingChains(...)` after any change that
  can reshape the tree.
- No new column, no new table, no `skip_level_manager_id`, no exception tables.

## 3. Allowed hierarchy gap: 1–2

For normal in-ladder roles (roles with `hierarchy_level` between 1 and 98):

| Employee level | Allowed manager levels          |
| -------------- | ------------------------------- |
| 4              | 3, 2                            |
| 3              | 2, 1                            |
| 2              | 1                               |
| 1              | none (org root)                 |

- `employeeLevel - managerLevel` must be **1 or 2**.
- Reject: `0` (same level), negative (lower level), `> 2` (too far up).
- The manager's role must hold **strictly higher authority** than the employee's.

## 4. Department rule

- **Level 1 (CEO) manager**: cross-department reporting is allowed.
- **Any other manager**: employee and manager must belong to the same department.

## 5. Level-1 behavior

- Level 1 (CEO) is the org root and must have **no** manager (`manager_id = NULL`).
- A Level-1 employee is never counted as "missing a manager".

## 6. Manager-required rule

- Level 1: manager must be `NULL`.
- All normal hierarchy levels `> 1`: a manager is **required**.
- Roles outside the ladder (see §9) keep their existing optional-manager
  behavior. No new "no manager" states are invented for ordinary Level 2+
  employees.

## 7. Cycle prevention

Server validation is authoritative and does **not** rely on hierarchy level
alone. It rejects:

- self-manager (`employee.manager_id == employee.id`),
- an employee reporting to any descendant,
- any cycle (`A → B → A`, `A → B → C → A`, longer cycles).

The cycle guard walks the actual `manager_id` graph upward from the proposed
manager and stops if it re-encounters the employee.

## 8. DownTeam / Data Visibility semantics

- DownTeam visibility continues to use the **actual recursive
  `users.manager_id` relationships** (server `authz.ts` `getDownlineIds`).
- A skip-level direct report is therefore automatically visible under its
  direct manager's DownTeam scope, and recursively under that manager's own
  managers. No role-level assumptions override the actual manager graph.

## 9. Custom / unassigned roles (hierarchy_level 99)

- Roles at `hierarchy_level >= 99` (incl. `ADMIN` / `SUPERADMIN` system roles
  and custom roles) are **not** placed in the reporting ladder.
- Their existing behavior is **preserved and centralized**, not silently
  reinterpreted: they may omit a manager, and a level-99 employee is not
  subject to the gap/department rule. A level-99 **manager** still cannot
  manage an in-ladder employee (the manager's role must be in the ladder).

## 10. Shared validation

One server-authoritative rule powers every entry point, so the rule cannot
drift between flows:

- `server/utils/reportingRules.ts`
  - `validateReportingManagerCandidate(...)` — pure level + department rule.
  - `reportingManagerRequiredError(...)` — pure manager-required rule.
  - `allowedManagerLevels(...)` / `resolveRoleLevel(...)` helpers.
- Consumers:
  - `validateReportingLink(...)` (manual create / manual edit / bulk commit
    Phase B) — adds DB-aware checks (self, exists, active, cycle) on top.
  - `validateBulkRows(...)` (bulk import preview) — same rule, bulk-loaded maps.
  - `computeHierarchyHealth(...)` (hierarchy screen "invalid links").

## 11. Manual user management

- The create/edit manager dropdown is server-backed (`GET /api/users/reporting-options`)
  and now returns candidates whose role sits **one or two levels** above the
  selected role, in the same department (Level 1 across departments).
- Candidates show `Name — Employee ID — Role — Department`.
- Same-level, lower-level, and `> 2`-level candidates are excluded.
- The server still re-validates on every write regardless of UI filtering.

## 12. Bulk user import

- Bulk validation uses the **same** shared rule (gap 1–2).
  - Level 4 employee → Level 2 same-department manager: **allowed**.
  - Level 4 employee → Level 1 manager (`> 2`): **rejected**.
  - Level 3 employee → Level 1 manager: **allowed**.
  - Same level: **rejected**.
- Same-batch manager resolution and order-independent behavior are unchanged.
- Row atomicity (savepoints + compensating rollback) is unchanged.
- The Instructions sheet now reads: *"manager must hold a valid
  higher-authority role, normally one or two hierarchy levels above the
  employee, subject to department and cycle rules."* Reference Values remain
  DB-authoritative; no new columns.

## 13. Reporting chain & tree

- `reporting_chain` reflects the **actual** path (e.g. `BE → ASM → CEO`) and is
  never padded with a fabricated intermediate node.
- The hierarchy tree / organogram is generated from `users.manager_id`, so a
  skip-level direct report renders directly beneath its real manager. Role
  hierarchy level remains available as metadata.

## 14. No schema change

This change is validation/UI/documentation only. There is **no** database
migration; the existing `users.manager_id`, `roles.hierarchy_level`,
`reporting_chain` and `subordinates` columns are reused.

## 15. Deferred work (out of scope)

- Dotted-line / secondary managers.
- Multiple managers per employee.
- Arbitrary cross-department reporting.
- Any redesign of the role hierarchy editor, permissions model, Lead
  Pool/Workspace, password flows, or deployment recovery.
