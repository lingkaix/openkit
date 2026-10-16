---
type: change-plan
status: in-progress
date: "2026-10-17"
branch: lane/web-administration-admission
---
# Private Administration Candidate Admission

## Intent Revision 1

The P28 dispatcher authorized this bounded increment on 2026-10-17 from the accepted current-authority and private-administration outcome: repair only the demonstrated private Administration candidate admission gap at `77b63c58877ec6ad8aab9fa508da34b61e2d0a5d`. A denied private parent must hide private configuration and environment candidate facts and prevent effects, including already open activation and configuration confirmations. Pending, paused, failed or otherwise unresolved private reads cannot admit an effect from cached success. Preserve exact candidate identity and revisions, attempted-command locks, unknown results, command outcomes and dispatched mutation history. Source: the dispatch titled "Proceed as Builder on ONLY the proven private Administration candidate admission gap" in this session; the bounded preparatory report is `/home/simonx/AI/temp/backlog-20261015/evidence/L-WEB/remaining-administration-probe.md` and supplies evidence, not authority.

## Owners And Boundaries

[Thread Visibility And Explicit Sharing](../../specs/20260909-thread_visibility_and_sharing.md#contract--expected-behavior) owns current parent/source audience checks and the rule that caches cannot authorize private previews. [Permissions](../../core/permissions.md#technical-administration) owns current administrator and per-effect authority. [Persistent Worker Volumes](../../specs/20260910-persistent_worker_volumes.md) owns immutable authored/resolved candidates, exact activation confirmation and unknown-result handling. [Web Product Surface Projection](../../specs/20260628-web_product_surface_projection.md) owns the Web projection. [Change Execution](../../change-execution.md) owns coordination; this record adds no design authority.

The sole builder writes `apps/web/src/screens/settings/AdministrationScreen.tsx`, its adjacent test, `AdministrationConfigurationReview.tsx`, and this record on `lane/web-administration-admission` in the separate audit worktree. The parent extended exclusive ownership to the configuration review component so denied visibility can return null after its existing mutation hooks and retain an in-flight result. The parent owns the criterion projection, guides, manuals, browser evidence and integration after the preceding Recovery landing. Exclusions: the separate Workspace access recovery paused-state concern, Vault grant controls, Timeline and chat changes, Artifact API changes, backend checks, durable state, actor epochs, account lifecycle changes, permission abstractions, new dependencies, external publication, hosts, credentials and other lanes. Existing typed clients, TanStack read and mutation owners, accessible primitives and exact command identity remain in use.

## Acceptance Observations

A settled 401/403 for the private parent or candidate source removes its protected candidate facts and open confirmation without effect dispatch. Every current pending, paused or failed private dependency blocks configuration Apply, environment preparation/result recovery and activation, including callbacks from an already open confirmation. Restoring a successful read only restores review eligibility; it never replays an effect. Existing positive preparation, activation, configuration Apply, result recovery and unknown-result tests retain their original assertions. Previously dispatched command state and outcome remain owned across a temporary read failure.

## Working Checkpoint

The baseline is `77b63c58877ec6ad8aab9fa508da34b61e2d0a5d`. Inspection shows the parent Thread query can fail while cached candidate data still renders; only configuration Apply receives the parent failure, while environment review receives connection state alone. The current screen's existing query and mutation seams are reused, because they already own exact source identity and attempted command history. No production change has started.

Next Action: add the lowest sufficient regressions for a loaded private candidate whose exact parent read is denied and whose existing confirmation is open, then run them against unchanged production before editing it. Expected observable: candidate facts or an enabled environment confirmation survive, so the new check fails for the claimed behavior rather than collection or setup. Keep exact red, green, typecheck and focused lint output in `/home/simonx/AI/temp/backlog-20261015/evidence/L-WEB/admin-candidates/`. Use the pinned tools and assigned slot runner with one Vitest worker and no file parallelism. No independent acceptance is claimed.


## Intent Revision 2

The dispatcher clarified existing admission on 2026-10-17: each mount must recheck current administrator access and the exact private parent audience before cached candidate facts or effects are admitted. A current positive exact parent read can admit retained exact private Items; no shared Items mount policy is added. Existing Items and candidate reads must be successful and idle for a new effect. Typed denial hides candidate output through unresolved retry; ordinary failures need not erase retained command outcomes. Retry refetches the exact current parent and never changes candidate identity or repeats an effect. The parent's complementary criterion and guide commit is `c9e1f84f48ee5f2b61d890a8024c70eb4835fecf`; integration remains parent-owned.

## Baseline Evidence

The frozen test commit is `1681b3ee53214760c42356150612192daf2ff834`. With production still unchanged from `77b63c58877ec6ad8aab9fa508da34b61e2d0a5d`, the command `pnpm --filter @openkit/web exec vitest run src/screens/settings/AdministrationScreen.test.tsx -t 'hides the private' --maxWorkers=1 --no-file-parallelism` completed with exit 1: six denial cases failed and 53 cases were skipped. Each failure observed an open private confirmation still in the document after settled denial. This completed without a collection failure. Later verification showed that this immediate UI oracle could observe the frame before React query notification; this output is not a deciding defect proof until the synchronized replay reproduces it. Full output is retained in `/home/simonx/AI/temp/backlog-20261015/evidence/L-WEB/admin-candidates/parent-denial-red.log`. Production edits started only after this result.

The implementation uses native query mount freshness and cancellation for its own access, exact parent and candidate reads. Existing shared Items remain unchanged. Candidate command owners remain mounted while their protected output returns null; guards also cover existing open confirmations. The new fresh-cache remount regression holds current access and parent reads independently and requires both actual client reads before review returns. Focused green, typecheck and lint remain pending. No independent acceptance is claimed.


## Preparatory Review Correction

Review of `f16d98fcf92ee917706bdc84856f714311bfee28` found that a broad hidden wrapper could leave an unrelated portaled deletion confirmation mounted after administrator denial. It also identified the shared Items automatic-retry interval, where typed denial is in `failureReason` while `error` remains null. The deciding regressions were frozen at `7bc06f0f` with production unchanged from `f16d98fc`; both failed for their claimed behavior (open dialog remained) before correction. Full named output is `/home/simonx/AI/temp/backlog-20261015/evidence/L-WEB/admin-candidates/portal-retry-red.log`. The earlier queued full-check job was stopped before any CPU check ran, so it supplies no green evidence.

The correction removes ordinary Administration UI and portals when current administrator access is unavailable. Existing candidate command owners remain mounted with explicit hidden output; no generic CSS wrapper is used as a portal boundary. Typed source denial also examines the query's existing retry failure reason. This is a local correction within the original audience and effect boundary, not a new lifecycle or policy.


## Synchronized Oracle And Retry Checkpoint

The first corrected complete run observed 55 passing and seven failing tests; Web typecheck and focused lint passed. Six failures exposed premature immediate UI assertions after query invalidation, and the remount assertion reached a disabled review before the required candidate reread was idle. The tests now await actual dialog removal and actual eligible review without changing timeout bounds or weakening assertions. The original six-case output is retained as premature-oracle output, not deciding proof. The deletion regression also awaits dialog removal after the rendered Access denied state.

The retry fixture now uses actual retry 1 with a held second attempt: 403 first, 500 later, held observational retry, then success. Private output must stay hidden until that success. Existing Items or candidate error or retry failure reason hides output while the exact mounted command observer retains its outcome; no denial latch is added. The next sequential slot job formats the synchronized candidate, replays the six original denials against the exact production pair from `77b63c58877ec6ad8aab9fa508da34b61e2d0a5d`, replays the later-retry case against the exact production pair from `a004758e`, restores the synchronized production bytes, then runs the complete test file, Web typecheck and focused lint. Each source pair's Git blob hashes are printed in the replay log. These are explicitly post-implementation replays. No source edits occur during the job. Raw logs remain under the named evidence directory; results are pending.


## Observed Synchronized Replays

The stronger six-case replay against the original production tuple reproduced five failures and one pass. The original environment candidate-read denial already removed its candidate subtree; the other exact private source denials left private facts or confirmation content. The later-retry replay against `a004758e7e0a32ee6441d8e62f83dfede3e20c8c` failed after the held second attempt returned 500 and private configuration facts returned without success. Both replays used actual UI disappearance assertions with unchanged timeout bounds. These outputs supersede the original immediate-assertion red claim.

The restored candidate run then passed 61 of 62 tests. One existing negative fixture expected generic candidate-read failure to retain a disabled Apply dialog; the accepted criterion requires blocked effects and permits ordinary outcome retention, but does not require a stale dialog. Its connection failure branch retains the disabled-Apply assertion. Its candidate failure branch now requires both facts and dialog removed, clicks the captured old confirmation handle, and retains the original zero-effect assertion. Existing positive and command outcome predicates remain unchanged. Web typecheck also found a missing required `nextCursor` in the new held Items fixture; that response now includes null. The second run's raw failures are retained as `verification-attempt2-tests.log`, `verification-attempt2-typecheck.log` and `verification-attempt2-summary.log`. Final checks remain pending.


Independent preparatory oracle review requested a positive UI barrier for the terminal 500 frame. The retry regression now awaits ThreadStream's existing "Couldn't load this thread." banner before checking facts and dialog absence. The 24 pending, paused and failed cases first require an enabled open confirmation, then await its actual disabled-or-absent DOM transition before checking zero effects. The deletion case already awaits the rendered Access denied cue. These strengthen synchronization without new timeout bounds, state or harness. The preceding five-failure and later-retry replay outputs remain named observations; final later-retry proof must use this exact positive-frame oracle.
