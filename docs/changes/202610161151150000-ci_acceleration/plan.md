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

## Intent Revision 2 — 2026-10-16

The coordinator confirmed the account's 20-job concurrent limit and changed the priority to total runner job-minutes first, wall time second. Keep exact-commit reuse unchanged; the fast main-push gate reuses the exact tested commit after land.sh fast-forwards main. Do not permit reuse across commits or amend that reuse rule. Optimize repeated setup and caches, group short suites, split only the long NanoCore and Worker Shim suites, and do not execute product tests twice. Landing is accepted when the comparison shows lower total job-minutes and no coverage loss, even if wall time improves less than the original ten-minute goal. Retain the two full branch runs, all required aggregate names, exact-head semantics, and the every-main-push gate.

## Intent Revision 3 — 2026-10-16

The engineer approved express landing for ordinary changes while the shared hosted pool is saturated. The coordinator requires every main push to run complete verification, including L4 Web e2e. Keep the existing one-pending-head concurrency group and never cancel an in-progress main run. Release candidates and changes to workflows or release scripts still require exact-head full CI before landing. The release admission job set and registry dependency now require L4 as well. The observer labels a complete main run `full`; admission consumes that actual label without relabeling it. A composed observation-to-admission regression catches the original mismatch; a missing, skipped, failed or duplicate L4 observation cannot admit a release.

## Owners And Boundaries

[Release Management](../../specs/20260829-release_management.md#candidate-ci-and-tag-reuse) owns complete deterministic admission and exact-head reuse. [Test Strategy](../../specs/20260529-test_strategy.md#coverage-expectations) owns collection equivalence, failure, skip and coverage criteria. The implementation extends the existing CI runner and release-test runner. Product suite selectors, thresholds and tests do not change. Publication jobs retain their bytes except the expressly required registry dependency on L4; the Web job adds main and complete release-gate conditions without changing its steps. A subsequent release still compares all invoked publication inputs with its proved baseline; this change does not extend the P15 scratch proof.

## Checkpoint

Two completed full runs, 38885937522 and 38892439146, took 21m30s and 21m52s. Each executed the same 511 Vitest files and 10,501 passing cases, including duplicate case-name cardinality. NanoCore had 366 files and 6,823 cases; Worker Shim had 30 files and 1,093 cases. The later root Node suite had 1,344 passing cases and its separate Python suite had 88. NanoHost and Retrieval Kernel retained their native and Python commands. These are observed baseline counts, not a promise that later source additions leave counts unchanged.

Eight Worker Shim partitions keep its three long adapter files separate. Four NanoCore partitions cover its complete suite; their largest historical file-work sum is about 474 seconds. The largest historical partition file-work sum is about 445 seconds; this is a planning input, not a wall-time proof. Static and native cache uploads took 190 to 223 seconds on the critical path. Restore-only build caching removes that non-test delay. Dependencies and compiled outputs remain optional cache inputs, never verdicts.

The implementation must retain each partition's covered and uncovered case inventories, actual execution report and coverage blob. The whole-owner merge requires a complete disjoint file union and original thresholds. Exact-source reuse downloads the original run-attempt artifacts instead of constructing a success from a missing execution report. Missing reports fail closed.

The first hosted trial used 33 execution jobs and two coverage merges. Its first job waited 81 seconds; at 12:17:17Z most matrix jobs were still queued and the two longest suites had not started. The hosted scheduler did not preserve matrix array order. This defeats the premise that listing slow suites first supplies scheduling priority. The trial continues as diagnostic evidence, with no sub-ten-minute result claimed.

An independent method check recommended a smaller 20-job trial: four NanoCore partitions, eight Worker Shim partitions, one complete Web suite, one group for seven other complete Vitest owners, three static groups that retain all four commands, two native groups that retain all four owners, and the unchanged root/Python job. Grouped owners retain separate reports and original thresholds. The two required whole-owner coverage merges remain. This removes thirteen dependency restores and installations per full run and reuses one prerequisite build for the seven short coverage owners. It changes scheduling and build duplication, not test selection. Shared hosted queue time and actual execution time remain separate observations; neither is waived.

The coordinator's runner-minute priority supersedes that unmeasured 20-job method. The next trial uses two NanoCore partitions and two Worker Shim partitions, with the same grouped short suites and required whole-owner coverage merges. It has twelve execution jobs and two merges. Compared with the 20-job plan, it removes eight more execution environments and their repeated prerequisite builds; compared with the original implementation it also removes synchronous build-cache uploads. Longer individual execution is an accepted trade for less total runner work under the shared limit. Keep this method only if two full measurements show lower summed runner minutes and unchanged complete test inventories. The reuse rule remains exact-commit only.

## Validation And Closeout

Pending: focused inventory, threshold, failure, skip and workflow regressions; repository, lint and type checks; independent exact-head review; two full CI runs with complete before/after case identities, summed job-minutes and measured wall times; guarded landing and the main-push gate. Timing, raw receipts and filtered inventories remain in private L-OPS evidence. The committed closeout will retain the final run links and counts.
