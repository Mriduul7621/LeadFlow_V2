# Lead Workflow Model

## Purpose

LeadFlow has two complementary lead surfaces over the same PostgreSQL `leads` record:

- **Lead Workspace** — `/leads` — execution for the current server-visible work set.
- **Lead Pool** — `/leads/all` — intake, routing, permitted record correction, audit review, and administrative controls.

The visible names changed, but the route paths, API paths, feature keys, database fields, authentication/session behavior, and existing RBAC/Data Visibility model remain compatible. `lead_tracking` and `all_leads` are internal feature keys; `leads.*` are canonical action permissions.

## One-record lifecycle

There is no pool copy and no workspace copy. A lead remains one PostgreSQL row in `leads` throughout this lifecycle:

1. Manual creation or bulk import writes the lead to PostgreSQL.
2. The Lead Pool reads the server-visible row and classifies it from canonical `assigned_to`/API `assignedTo` only.
3. An authorized assignment or reassignment updates that same row and appends assignment history/audit data.
4. The owner works the same row in Lead Workspace, where status, remarks, NCP values, and next-action dates are updated through the server-authoritative follow-up path.
5. Follow-up writes append-only `lead_activities` records and update the lead's current operational state in the same transaction. Pipeline and Converted outcomes remain on that record.

`custom_fields.assignedTo` is not an ownership authority. For PostgreSQL rows, a stale custom value cannot make a canonical unassigned row appear assigned or widen visibility.

## Responsibility split

### Lead Workspace (`/leads`)

The workspace is optimized for doing the next piece of work:

- call/message/follow-up context and the operational timeline;
- status/progress updates, remarks, NCP fields, and next-action scheduling;
- current status, owner, campaign/source context, and navigation to the lead timeline;
- existing advanced filters, cached user references, follow-up, scheduled activity, workbench, and dashboard integrations.

It intentionally does **not** load assignment-management data or make assignment/reassignment the primary workflow. Delete and campaign purge controls are not part of the workspace's normal execution path. Status and follow-up mutations require `leads.edit`; export is independently gated by `leads.export`.

### Lead Pool (`/leads/all`)

The pool is optimized for intake and routing:

- **Unassigned**, **Assigned**, and **All** tabs;
- summary counts for total, unassigned, assigned, and converted records;
- search and the existing advanced filter panel;
- assignment/reassignment (including explicit unassignment) and selection-based routing;
- lead detail/audit inspection and permitted demographic corrections;
- canonical delete and audit export controls;
- campaign purge only as a secondary danger-zone control.

Tab classification is deliberately small and canonical:

- Unassigned: `assignedTo` is null, blank, or whitespace;
- Assigned: trimmed `assignedTo` is non-empty;
- All: the complete server-visible result set.

No role query, `UserRole.ADMIN` query parameter, client employee id, or client visibility flag widens the result set. The server derives caller identity and Data Visibility from the authenticated session.

## Labels, routes, and keys

| Visible label | Stable route | Stable internal key |
| --- | --- | --- |
| Lead Workspace | `/leads` | `lead_tracking` |
| Add New Lead | `/leads/new` | `lead_generate` |
| Bulk Upload | `/leads/upload` | `lead_upload` |
| Lead Pool | `/leads/all` | `all_leads` |

The sidebar order under Leads is exactly the table order. Role editor labels use the same visible names while preserving the internal keys. Existing auth/session, forced-password, RBAC, historical import, performance, and diagnostics contracts are not replaced by these labels.

## Permission and visibility mapping

Feature Access controls whether a page is available in the UI. It does not grant a mutation. Action permissions are separate and are enforced again by the server.

| Operation | UI gate | Server authority |
| --- | --- | --- |
| View either surface | Feature visibility plus `leads.view` | session-derived caller, `leads.view`, Data Visibility |
| Create | `leads.create` | authenticated caller and create permission |
| Operational status/follow-up edit | `leads.edit` | authenticated caller, accessible row, status/activity validation |
| Demographic correction in Pool | `leads.edit` | authenticated caller, accessible row, field whitelist/normalization |
| Assignment/reassignment/unassignment | `leads.assign` | resolved user reference, authorized assignment scope, assignment history |
| Transfer-specific behavior | `leads.transfer` where a transfer-specific server path applies | remains distinct; not treated as generic Feature Access |
| Individual delete | `leads.delete` | authenticated caller, visible row, server-side delete check |
| Export | `leads.export` | endpoint/action-specific export authorization |
| Bulk import | `leads.import` and/or the established create/import contract | server validation, duplicate/history/date semantics |
| Campaign purge | admin/server purge boundary plus `leads.delete` | secondary danger zone; never a page-level visibility bypass |

The client uses role/permission state only to present or disable controls. It never impersonates ADMIN, supplies a broader role, or treats Feature Access as an action grant. Server visibility remains final for every list, detail, update, follow-up, scheduled activity, dashboard, and delete path.

## Ownership and audit rules

- PostgreSQL `leads.assigned_to` is the canonical owner reference.
- An explicit blank assignment is an unassignment; an update that omits an assignment preserves a canonical null owner and does not self-assign to the caller.
- Assignment/reassignment/unassignment is validated against the caller's permitted scope and recorded in assignment history with the authenticated actor.
- Status/follow-up actor, timestamps, and history are derived or validated server-side. Client-supplied actor fields cannot rewrite audit ownership.
- `lead_activities` is append-only for new follow-up activity. Existing status history and historical import semantics remain compatible.

## Regression boundaries

This workflow model preserves:

- `/leads` and `/leads/all`, API/database/internal keys, auth/session, RBAC, forced-password flow, and Data Visibility;
- historical Lead Date/import behavior and duplicate/upsert semantics;
- immutable activity history and follow-up/scheduled-activity/workbench/dashboard behavior;
- session reference caching/coalescing and PR #29–#31 performance/diagnostics work.

## Deferred optimization

Bulk selection currently performs the established N individual update requests because no safe bulk assignment endpoint exists in the current API contract. A future batch endpoint can reduce round trips only after it preserves per-row visibility, `leads.assign`, assignment history, notifications, and partial-failure behavior. No backend refactor is introduced solely for this UI separation.
