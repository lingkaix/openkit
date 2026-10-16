---
type: change-plan
status: implemented
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

## Implementation and current evidence

The first P28 feature is landed at `0f0673ba188e7cf7fec5cad99b66a27a1ce94abc` with green main CI. This second increment is implemented and integrated. The primary inspected actual source and merged each helper branch without cherry-pick. The final focused head `522b17079a5418800aee093d5b411b8b536b9c11` passed all seven affected test files, 215 cases in 104.67 seconds, Web typecheck, and Web lint. The lint result includes one pre-existing informational fragment diagnostic in Overview; it is not a failing check. Named external evidence is `evidence/L-WEB/recovery-final-focused-corrected.log` in the coordinator backlog. Main `8cf3158dfce3b88ad9ce53d352974a1410aa0cbb` was then merged cleanly; it changes no Web source or public App operation. Regeneration, final independent review, exact-head Express gate and landing remain open.

Abandoned UI reads cancel, while a dispatched command retains its own settlement read on the same query. Each existing ephemeral owner records whether its exact transport promise has settled; this is not proof of effect outcome. A read started before that fact cannot settle the command. Current UI reads remain scoped to the selected Workspace and require idle successful completion before another effect. Current backup and update admission preserve exact prepared source, explicit maintenance consent and known or unknown request ownership. A browser regression checks denied remount admission without invoking a backup or update effect.

Next, regenerate OpenAPI and CLI on the merged committed head and require zero byte drift, obtain independent approval, and run the exact-head gate with every Web unit file and the local Web browser suite. A setup or collection failure decides none of the behavior predicates. Final gate, review and landing receipts stay external so the proof head is stable.

## Verification and landing

The original affected-slice run passed 180 cases and failed six. It exposed a scope mismatch: a command's global worker read changed the query status used to admit a different Workspace. Independent scrutiny in `evidence/L-WEB/recovery-settlement-direction.md` returned Continue for Workspace-scoped cache keys and filtering before cache, with the existing strict empty API input unchanged. This reuses the existing read owner instead of adding per-origin coordination beside a global cache. Preserve command-owned reads with a temporary observer on the same query; query identity, a new successful update and idle state distinguish completed reads from cancellation that restores cached success. Actual two-observer probes show the existing query library follows replacement fetch promises, so no new coordination loop is needed. Tests must supply real current B reads and coherent post-mutation state while preserving exact commands, locks and failures.

The account baseline failed six Operations-cache cases and passed the other 13. After correcting an early error-banner observation race, the search baseline failed all six intended cases on retained hits, paused reads or missing new reads. The earlier three pre-render assertion failures are not behavior proof. Backup/update baseline failed 11 cases and passed 26; its complete corrected suites passed 38 cases, Web typecheck and focused Biome. The primary inspected the source and formatter delta before merging. These focused results precede final integration and are not exact-head gate evidence.

Preserve and run existing generic stale observation, frozen command, secret handling, source identity and unknown-result regressions with the new cases. Focused unit checks precede all Web unit suites and the local Web browser suite. Generate OpenAPI and CLI and require no unexpected byte drift. The engineer-approved Express method requires independent exact-head approval, push and `bin/local-gate.sh` on the committed head, with all changed-module tests and `pnpm run test:e2e:web`, then the landing window and `bin/land-express.sh`. Watch the containing main-push CI and fix or revert owned failures immediately. Do not dispatch branch full CI. Local simulator evidence does not prove deployed-host acceptance, which stays with L-OPS.

## Final integration corrections and scope

The first integrated generation and CLI build passed with zero generated-path drift, and 25 account/search cases passed; typecheck then found an optional QueryObserver query key. The correction explicitly supplies the captured Query's own key. The subsequent complete affected run passed 214 cases and failed one previously short-circuited Workspace-switch assertion: scheduler request invocation did not prove the separate Worker read had rendered. The correction awaits the same exact B Worker row, then checks both A rows absent at that completed state; strict API calls, unresolved scheduler controls, zero effects and exact B command lineage remain unchanged. Independent review inspected the raw failed output and this synchronization change. Normal formatting then passed. The final 215-case run above includes those later assertions and closes both failures; the failed and canceled attempts remain non-pass evidence.

The owned diff changes 21 files, including one owning specification. Five existing contracts govern the behavior: Web product projection, Permissions, Vault, Workspace backup and App update delivery. No closed registry, public operation, durable record or effect owner is added. The only consequential path outside the Settings, Operations and Portability screen areas is `apps/web/src/screens/account/session.ts`, which removes the Operations read prefix at the existing successful account-transition boundary. The next private Administration candidate correction remains on separate branches and is excluded from this landing.

## Browser gate corrections

The first exact-head gate passed all 1,327 Web unit tests and failed two of 25 browser cases. The local-mode stack correctly rejects server-only token administration, so the admission browser fixture now supplies that read explicitly and preserves the delayed denial on each remount. The existing Material sequence matched the previous answer before the second canonical Item refresh; it now waits for the answer count to increase within the existing 15-second budget. All proposal and prompt assertions remain. Raw failed output and browser traces remain in external lane evidence. These changes correct browser setup and observation; they add no production behavior or deployed-authentication claim.

The corrected full gate passed all 1,327 unit tests and 24 of 25 browser cases. The remaining existing Workspace self-check reached the General heading while its Workspace read was still pending; the form assertion used the default five seconds. Its retained trace shows the loading skeleton and no completed Workspace response. The exact Display name assertion now uses the same 15-second read budget already used in that case. The expected value, Debug checks and every other assertion remain unchanged. This is a bounded browser observation correction, not a production or latency-contract change.

## Intent Revision 2: Combined P28 Landing

The coordinator's 20:15Z instruction on 2026-10-16 lifts P14 priority after main553ea24b and Goal67153ca4, and requires combining ready candidates that touch the same modules. Land this Recovery feature with the implemented private Administration admission correction as one P28 cut. This supersedes the earlier separate-landing method; behavior, owners and exclusions remain unchanged. Use the complete affected Settings, Operations, Portability and Account module suites plus complete Web e2e and the standard local gate, rather than repeating whole-app suites covered by main CI. The Goal merge resolves the existing second-answer browser observation to exactly two recorded answers within its existing15-second budget, without removing later assertions. Prior failures remain external evidence. Final named-head independent review, generation, gate and containing main-push CI remain required.
