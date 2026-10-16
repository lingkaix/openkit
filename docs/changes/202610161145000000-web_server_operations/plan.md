---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/web
---
# Web Server Operations

## Intent

Intent revision 1, 2026-10-16: L-WEB delivers the supported P28 administration and recovery surfaces, followed by P26 and P27 after their backend dependencies land. This increment adds a server-scoped operations destination for current health, Policy readiness, process and Telemetry configuration, update readiness, and bounded cleanup observations. Existing settings remain the owners of their actions. Whole-server recovery, new Policy administration semantics, P20 Skills and P29 update orchestration are outside this increment.

## Owners

- [Web product surface projection](../../specs/20260628-web_product_surface_projection.md).
- [Operational telemetry](../../specs/20260731-operational_telemetry_standardization.md#app-diagnostics-operational-sample).
- [App update delivery](../../specs/20260910-app_update_delivery.md).
- [Multi-user Workspace system](../../specs/20260715-multi_user_workspace_system.md).
- [Permissions](../../core/permissions.md) and [Audit](../../core/audit.md).

## Route and decisions

Reuse `diagnostics.app` and `administration.cleanup-read` through the composed Core Client. These operations already own current server-admin admission. Web adds no store, public operation, credential input, Policy file, cleanup action or host probe. Keep health and cleanup reads independent so a source failure remains local. Project known safe fields before caching. Refresh and retry only read current authority and state; denied or failed observations cannot remain visible as current. Show recorded cleanup state, unknown evidence and incomplete source coverage separately. Terminal product work and host Epoch observations do not prove physical cleanup or deployment idleness.

The cleanup helper owns only its new panel and regression file on `lane/web-cleanup` in a separate worktree. After the coordinator increased capacity to two helpers, an audit helper owns the existing Server audit screen, its regressions and its data hook on `lane/web-audit` in another worktree. The primary owns health, routing, documentation and browser acceptance. Merge the helper branch; obtain separate independent review after implementation. This record is execution evidence, not design authority.

## Checkpoint

The first P28 increment is implemented; local final verification and independent exact-head review are pending. Cleanup helper `ba7f9d23` and audit helper `d30f77b7` are merged. Current main `1fb33a24` is merged; P14, P19 and P17 are still absent at the latest fetch. Generated OpenAPI and CLI bytes remain unchanged. The independent reviewer inspects the actual diff and evidence and cannot accept its own artifact.

Review found two current-authority races. Pending read reuse across mounts required a consumed query cancellation signal and a new current-mount read. Successful account changes also retained Settings observations, and late command callbacks could restore a prior account's data after eviction. Account helper `b86cfdc0` is merged: successful sign-in, sign-up and sign-out remove only the Settings read prefix before admission resets. Unrelated queries and pending mutation owners remain intact. My admin access refreshes the authorized read; configuration marks the saved file stale without an immediate read that could replace a newer draft. Gateway preserves its immediate login response only while the exact query captured at command start still exists. No actor epoch, new durable owner or command cancellation claim is added.

After primary compaction, a separate context read the Consultant contract, source intent, checkpoint, actual diff and named checks, then returned Continue for this plan and primary context. The scoped cache corrections and trace-backed harness corrections still advance the first coherent P28 landing. The next observations are the account and late-command regressions, exact Material browser predicates, and a clean frozen diff. The independent context then resumed Reviewer work.

## Verification and closeout

Evidence is retained under the backlog `evidence/L-WEB/` directory. Initial setup and dependency builds passed; NanoCore build passed seven tasks. `generated.log` records successful OpenAPI generation, validation and CLI build with zero generated-byte diff. `repo-check.log` passed with three existing warnings and 28 information diagnostics. `integrated-gates.log` passed lint 14 tasks, typecheck 16 tasks, all 1,263 Web unit cases in 44 files, and the Web production build. The isolated server-operations browser journey passed 1/1. These checks precede the final account-cache correction and do not prove the final head.

The cleanup fresh-cache baseline failed on zero current reads. Independent QueryObserver probes reproduced pending-response reuse across mounts; final health cases passed 9/9 after the cancellation and mount corrections. `account-cache/red.log` shows six expected settled or pending Settings-cache failures and three failed-authentication preservation passes. `late-mutation-red.log` shows both old Gateway status and old saved configuration content overwriting a replacement account's query. Collection and setup failures from earlier attempts prove no behavior and are not counted as regression evidence.

Two complete browser attempts passed 23/24 and are retained as failures. The first unchanged Material scenario exceeded its exact 55-second aggregate deadline after 86 successful assertions. A separate Test Author found no accepted latency predicate and changed only that long scenario's budget to 120 seconds, matching the existing account-sharing scenario. The second attempt failed the exact visible-answer assertion at its five-second observation deadline: the answer operation returned 200, and its separate canonical Items and dashboard reads took 5,079 and 5,099 milliseconds. The exact answer was present in the returned Items. The two equivalent visible-answer observations now allow 15 seconds; their predicates and every other action and assertion remain intact. The independent reviewer inspected both traces and the bounded corrections. The complete browser rerun must pass before final approval.

Final combined settings/account tests, Web typecheck and full local browser suite are queued through the shared FIFO runner. Remaining gates are current repository checks, exact-head review and full CI. Acquire the landing window only after that CI succeeds, then use landing protocol v2 and watch main-push. Local simulator evidence does not prove real deployed-host authentication or recovery; that acceptance remains with L-OPS. No real host, release, cleanup or update effect was performed. Deferred dependency surfaces remain in the lane checkpoint.
