# Performance optimization phase 4 — parallel list reads

## Scope

This phase is layered on top of the query-profiling branch and makes only read-path changes.

- Follow-up Queue: run the bucket aggregate and page-list query concurrently.
- Follow-up Queue: remove the redundant total-count query. The existing bucket aggregate already calculates exact totals for `overdue`, `today`, `upcoming`, and `all`; pagination.total now uses that aggregate.
- Scheduled Activities: run the count and page-list queries concurrently.
- Lead Quality: expose timings for the lead scan, activity-history query, and scheduled-action query so the next optimization is based on evidence.

## Safety

- Query filters, visibility predicates, ordering, and page limits are unchanged.
- The follow-up total comes from the same filtered dataset and the same CASE expression used for the returned bucket.
- Count and list calls use separate parameter arrays; the shared base parameter array is not mutated with LIMIT/OFFSET.
- No schema changes, migrations, index changes, customer-data changes, or production deployments are included.

## Validation

1. Run the full CI suite and inspect failures. Existing source-guard failures in Dashboard/calendar UI are outside this phase and must not be silently attributed to these read-path changes.
2. Verify TypeScript typecheck, production build, and serverless bundle.
3. On the preview, capture diagnostics for follow-up buckets (today, upcoming, all, overdue), scheduled activities, and Dashboard.
4. Compare repeated runs, not a single cold request. Confirm follow-up count/list overlap in Server-Timing and check the new `db.qualityActivity`, `db.qualityScheduled`, and `db.qualityAggregate.*` labels.
5. Merge only after tests/build are green or any pre-existing failures are separately documented and explicitly reviewed.

## Expected impact

The Follow-up Queue removes one database round trip and overlaps the count aggregate with the page query. Scheduled Activities overlaps count and page reads. The actual gain depends on database/network latency and must be confirmed using repeated preview diagnostics.
