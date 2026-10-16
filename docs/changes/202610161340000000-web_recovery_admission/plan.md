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

The first P28 feature is landed at `0f0673ba188e7cf7fec5cad99b66a27a1ce94abc` with green main CI. All second-increment production changes are integrated locally. Root account/search baselines and both helper baselines reached their expected failures. Backup/update corrected suites passed; final Recovery suites are queued after the observed first-candidate failures were corrected. Independent review and integrated checks remain open.

The primary inspected the actual source and merged each helper branch without cherry-pick. Abandoned UI reads cancel, while a dispatched command retains its own settlement read on the same query. Each existing ephemeral owner records whether its exact transport promise has settled; this is not proof of effect outcome. A read started before that fact cannot settle the command. Current UI reads remain scoped to the selected Workspace and require idle successful completion before another effect.

Next, run the integrated account/search regressions, generation and typecheck, then inspect the final Recovery suite and independent review. Expected observations are current cache disposal and admission, preserved frozen command ownership, complete affected-suite success and zero generated-byte drift. A setup or collection failure decides none of these predicates.

## Verification and landing

The original affected-slice run passed 180 cases and failed six. It exposed a scope mismatch: a command's global worker read changed the query status used to admit a different Workspace. Independent scrutiny in `evidence/L-WEB/recovery-settlement-direction.md` returned Continue for Workspace-scoped cache keys and filtering before cache, with the existing strict empty API input unchanged. This reuses the existing read owner instead of adding per-origin coordination beside a global cache. Preserve command-owned reads with a temporary observer on the same query; query identity, a new successful update and idle state distinguish completed reads from cancellation that restores cached success. Actual two-observer probes show the existing query library follows replacement fetch promises, so no new coordination loop is needed. Tests must supply real current B reads and coherent post-mutation state while preserving exact commands, locks and failures.

The account baseline failed six Operations-cache cases and passed the other 13. After correcting an early error-banner observation race, the search baseline failed all six intended cases on retained hits, paused reads or missing new reads. The earlier three pre-render assertion failures are not behavior proof. Backup/update baseline failed 11 cases and passed 26; its complete corrected suites passed 38 cases, Web typecheck and focused Biome. The primary inspected the source and formatter delta before merging. These focused results precede final integration and are not exact-head gate evidence.

Preserve and run existing generic stale observation, frozen command, secret handling, source identity and unknown-result regressions with the new cases. Focused unit checks precede all Web unit suites and the local Web browser suite. Generate OpenAPI and CLI and require no unexpected byte drift. The engineer-approved Express method requires independent exact-head approval, push and `bin/local-gate.sh` on the committed head, with all changed-module tests and `pnpm run test:e2e:web`, then the landing window and `bin/land-express.sh`. Watch the containing main-push CI and fix or revert owned failures immediately. Do not dispatch branch full CI. Local simulator evidence does not prove deployed-host acceptance, which stays with L-OPS.
