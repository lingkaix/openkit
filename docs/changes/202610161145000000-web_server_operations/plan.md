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

Active. Root implementation committed and pushed at `4f8577a2`; cleanup helper `ba7f9d23` merged through `4d776d12`; current main `1fb33a24` merged through `f910c4f6`. P14, P19 and P17 were not yet on main at that fetch. Existing APIs and generated shapes remain unchanged. The audit helper owns its pending three-file delta in a separate worktree. A separate independent reviewer has inspected the surrounding source and owners and is awaiting the final exact head.

The initial missing-component and missing-package collection failures prove no behavior. The first actual health run passed five cases and exposed two incorrect ApiCallError test fixtures; the corrected fixture run passed seven cases. The cleanup helper's actual cached-response regression failed, then its final 13 cases passed. Its earlier Web typecheck passed before its final mount gate; integrated typecheck remains required. Root inspection found the app's five-second default cache requires forced mount refresh; the regression now uses that default. The queued fresh-cache check reached the baseline before the correction: its exact current-mount assertion failed because the read had zero calls. The corrected source forces mount refresh.

Independent review reproduced pending-read reuse across mounts with a QueryObserver probe, even with zero cache retention. Health and cleanup now consume the query cancellation signal and discard an unmounted pending response; the audit helper is applying the same correction. New component regressions require a new call and prove the old response cannot supply the new mount. The final health suite passed all nine cases after these corrections, including old pending response rejection, cached remount, safe errors and duplicate retry prevention. Cleanup and audit corrections still need their final integrated results. Pending refresh also removes retry controls to prevent overlapping reads.

## Verification and closeout

Observed: dependency build five successful cached tasks; NanoCore build seven successful tasks; initial repository check exit 0 with three existing warnings and 28 information diagnostics. Focused Biome passes on current root panel files. OpenAPI generation/validation and the administrator CLI build completed with no generated-byte diff. The new isolated local browser journey passed 1/1 in 15.4s, including real supported reads, narrow layout, read-only refresh and injected authority denial. This simulator proof does not establish deployed-host authentication or recovery. Integrated lint passed 14 tasks, typecheck passed 16 tasks (15 cached), full Web unit passed 1,263 cases in 44 files, and the Web production build passed. The full browser suite passed 23 cases and failed the unchanged Material journey at its exact 55-second whole-test timeout near the final readback. Teardown then cleared the shared stack and caused a secondary null access. The retained trace shows no earlier failed Material assertion. A separate Test Author confirmed 86 completed assertions with no failed assertion before the deadline and found no owner latency predicate. Its correction `3becc54f` was merged through `50e7c7d0`: only this scenario whole-test budget changes to 120 seconds, matching the existing long account-sharing scenario. Every action, assertion, expected value and action/assertion timeout stays unchanged. The independent reviewer inspected the trace and exact diff and accepted this bounded harness correction. The original failure remains retained; the complete 24-case browser rerun is pending and is required before approval. No real host, authentication account, release, cleanup or update effect was performed.

Before landing, merge current main, finish generated-interface and local gates, freeze and push the final head, obtain the independent exact-head review and run full CI. Acquire the landing window only after that CI succeeds. Deferred dependency surfaces remain in the lane checkpoint. No completion or acceptance claim is made by this checkpoint.
