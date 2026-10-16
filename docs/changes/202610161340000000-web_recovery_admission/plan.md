---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/web
---
# Web Recovery Admission

## Intent

Intent revision 1, 2026-10-16: The coordinator assigns L-WEB P28 supported administration and recovery surfaces over capabilities already on main, with current authority checks and local UI and browser proof. This increment corrects existing Recovery, Portability, deployment data-root backup and App update controls and Operations read disposal at successful account transitions. Whole-server backup, new update orchestration, Vault grant semantics and the dependent P26/P27 surfaces remain outside this increment.

## Owners and boundary

[Permissions](../../core/permissions.md) owns current authority and truthful settlement of dispatched effects. [Web product surface projection](../../specs/20260628-web_product_surface_projection.md) owns truthful client states. [Workspace backup, export and import](../../specs/20260704-workspace_backup_export_import.md) and [App update delivery](../../specs/20260910-app_update_delivery.md) retain their effects and recovery contracts. Existing Worker checkpoint and scheduler command owners retain exact identities and settlement. No API, durable state, actor epoch, command runner or new readiness policy is needed.

## Route and observations

Direct source inspection found Recovery read-verification flags that survive later failed reads, retained Vault references and enabled Rebind after denial, backup and update admission that can reuse a fresh cached prior mount, and private Operations search data that survives successful account transitions. Existing query cancellation, current-mount reads and local action guards are sufficient. Preserve useful generic stale Recovery evidence, but hide protected prior rows after typed 401/403 and through unresolved retry. Block new effects without current successful reads. Keep every frozen command identity, mutation owner and unknown-result lock. Read retry never replays an effect. App update diagnostics 500 remains local after current admission; diagnostics denial is authority evidence.

An independent Consultant inspected accepted owners, source intent, actual source and named first-landing evidence and returned Continue. It confirmed this route for the primary context after compaction. Its external `evidence/L-WEB/recovery-direction.md` is direction advice, not implementation acceptance. Waiting for P19/P17 does not correct these already published paths; a new authorization store or backend contract would add an unnecessary owner.

## Write ownership

Builder `recovery_controls` owns Recovery, Portability, their regressions, Operations data hooks and the existing shared Vault read hook only, in its own worktree and branch. Builder `update_admission` owns only the backup and update screens and their regression files in a separate worktree and branch. The primary owns account read disposal, AppSearch rendering and its separate regressions, owner criteria, guides and browser evidence. Merge helper branches without cherry-pick. A separate independent reviewer inspects the final actual diff and exact head.

## Checkpoint and next observation

The first P28 feature is landed at `0f0673ba188e7cf7fec5cad99b66a27a1ce94abc`. Its main CI completed success. This increment starts from that head. All 12 selected Recovery and Portability baseline cases failed on real read, DOM and command-owner paths. The source retained protected rows and enabled actions, reused departed responses, omitted fresh mount reads and lost an unknown command owner through read retry. Root account/search and backup/update baselines remain queued through the shared CPU runner. Next, inspect those real-query regressions with production stale time and deferred transports. Expected failures are retained protected rows or action eligibility after a denied or failed current read, cached admission without a new mount read, and departed pending read reuse. Setup failures do not decide these hypotheses. To preserve the queued baseline bytes, the primary and helpers prepare corrections in separate own worktrees and merge them only after inspecting the baseline. These untested candidates are not accepted. Primary diff inspection also found that a fresh diagnostics cache can skip the update screen's delayed enable transition; the helper adds a focused regression and current-read correction without making diagnostics success a readiness prerequisite.

## Verification and landing

Preserve and run existing generic stale observation, frozen command, secret handling, source identity and unknown-result regressions with the new cases. Focused unit checks precede all Web unit suites and the local Web browser suite. Generate OpenAPI and CLI and require no unexpected byte drift. The engineer-approved Express method requires independent exact-head approval, push and `bin/local-gate.sh` on the committed head, with all changed-module tests and `pnpm run test:e2e:web`, then the landing window and `bin/land-express.sh`. Watch the containing main-push CI and fix or revert owned failures immediately. Do not dispatch branch full CI. Local simulator evidence does not prove deployed-host acceptance, which stays with L-OPS.
