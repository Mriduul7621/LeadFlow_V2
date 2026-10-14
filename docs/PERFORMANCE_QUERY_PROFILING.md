# Query-level performance profiling

## Purpose

This change adds measurement only; it does not change SQL predicates, response payloads, authorization, visibility, or request concurrency. It is intended to identify the expensive stage before making query/index changes.

## New Server-Timing labels

### `GET /api/dashboard`

- `authz.caller`, `authz.permission`, `authz.visibility`: sequential authorization stages.
- `db.metricQuery`: dashboard status/pipeline metrics SQL.
- `db.followUpCounts`: grouped follow-up bucket counts.
- `db.agentQuery`: agent/team member aggregation.
- `db.qualityAggregate`: quality aggregation query work.
- `db.queries`: elapsed wall time across the parallel database/aggregation stage. This is not the sum of the individual query durations.

The four measured operations remain inside `Promise.all`; timings are captured independently so diagnostics do not serialize them.

### `GET /api/leads/follow-ups`

- `authz.caller`, `authz.permission`, `authz.visibility`
- `db.countBuckets`: grouped overdue/today/upcoming counts.
- `db.countTotal`: count for the selected bucket.
- `db.list`: paginated queue rows, including the latest-activity lateral join.
- `db.qualitySignals`: the two bulk quality-signal reads.

### `GET /api/scheduled-activities`

- `authz.caller`, `authz.permission`, `authz.visibility`
- `db.countTotal`: matching activity count.
- `db.list`: scheduled activity rows joined to lead data.
- `db.qualitySignals`: bulk parent-lead quality-signal reads.

## How to validate

1. Wait for the preview deployment for this branch to become Ready.
2. Sign in and open the Dashboard, then capture Performance Diagnostics.
3. Navigate to the Workbench or Scheduled Activities view and capture diagnostics again.
4. Compare browser duration against the new `Server-Timing` labels. The `total` header is server-side duration; browser duration also includes network, browser queueing, and other client-side work.
5. Repeat once after a reload. Do not add indexes or rewrite SQL until the slowest specific query stage is consistent across multiple samples.

A high `db.list` with low `db.qualitySignals` points toward the queue/list SQL; a high `db.qualitySignals` points toward quality-signal queries. For Dashboard, compare the four independent duration labels; because work runs in parallel, the slowest operation is often the primary contributor to wall time.

## Safety

No production data migration is added by this profiling change. Do not merge based on a successful preview build alone; require typecheck/tests and a production-like diagnostic sample first.
