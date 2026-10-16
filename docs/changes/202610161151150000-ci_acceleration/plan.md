---
type: change-plan
status: in-progress
date: "2026-10-16"
started: "2026-10-16"
branch: lane/ops-ci-accel
---
# CI Acceleration

## Intent Revision 1 — 2026-10-16

The engineer requested a complete full gate below ten minutes without reducing coverage. The coordinator assigned L-OPS to split the long NanoCore and Worker Shim Vitest executions, run independent static checks in parallel, preserve the required L0-L2, L3 and L4 aggregate names, retain exact-head reuse and every-main-push gating, and prove complete execution with two full branch runs. No publication or deployment is in scope. Landing uses the shared v2 protocol: review and full CI before the short guarded main window.

## Owners And Boundaries

[Release Management](../../specs/20260829-release_management.md#candidate-ci-and-tag-reuse) owns complete deterministic admission and exact-head reuse. [Test Strategy](../../specs/20260529-test_strategy.md#coverage-expectations) owns collection equivalence, failure, skip and coverage criteria. The implementation extends the existing CI runner and release-test runner. Product suite selectors, thresholds and tests do not change. Publication jobs retain their bytes. A subsequent release still compares all invoked publication inputs with its proved baseline; this change does not extend the P15 scratch proof.

## Checkpoint

Two completed full runs, 38885937522 and 38892439146, took 21m30s and 21m52s. Each executed the same 511 Vitest files and 10,501 passing cases, including duplicate case-name cardinality. NanoCore had 366 files and 6,823 cases; Worker Shim had 30 files and 1,093 cases. The later root Node suite had 1,344 passing cases and its separate Python suite had 88. NanoHost and Retrieval Kernel retained their native and Python commands. These are observed baseline counts, not a promise that later source additions leave counts unchanged.

Eight partitions keep the three long Worker Shim files separate. The largest historical partition file-work sum is about 445 seconds; this is a planning input, not a wall-time proof. Static and native cache uploads took 190 to 223 seconds on the critical path. Restore-only build caching removes that non-test delay. Dependencies and compiled outputs remain optional cache inputs, never verdicts.

The implementation must retain each partition's covered and uncovered case inventories, actual execution report and coverage blob. The whole-owner merge requires a complete disjoint file union and original thresholds. Exact-source reuse downloads the original run-attempt artifacts instead of constructing a success from a missing execution report. Missing reports fail closed.

## Validation And Closeout

Pending: focused inventory, threshold, failure, skip and workflow regressions; repository, lint and type checks; independent exact-head review; two full CI runs with complete before/after case identities and measured elapsed times; guarded landing and the main-push gate. Timing, raw receipts and filtered inventories remain in private L-OPS evidence. The committed closeout will retain the final run links and counts.
