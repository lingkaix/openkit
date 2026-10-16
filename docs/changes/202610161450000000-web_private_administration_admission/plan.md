---
type: change-plan
status: in-progress
date: "2026-10-17"
branch: lane/web-administration-admission
---
# Private Administration Candidate Admission

## Intent Revision 1

The P28 dispatcher authorized this bounded increment on 2026-10-17 from the accepted current-authority and private-administration outcome: repair only the demonstrated private Administration candidate admission gap at `77b63c58877ec6ad8aab9fa508da34b61e2d0a5d`. A denied private parent must hide private configuration and environment candidate facts and prevent effects, including already open activation and configuration confirmations. Pending, paused, failed or otherwise unresolved private reads cannot admit an effect from cached success. Preserve exact candidate identity and revisions, attempted-command locks, unknown results, command outcomes and dispatched mutation history. Source: the dispatch titled "Proceed as Builder on ONLY the proven private Administration candidate admission gap" in this session; the bounded preparatory report is `/home/simonx/AI/temp/backlog-20261015/evidence/L-WEB/remaining-administration-probe.md` and supplies evidence, not authority.

## Intent Revision 2

The dispatcher clarified existing admission on 2026-10-17: each mount must recheck current administrator access and the exact private parent audience before cached candidate facts or effects are admitted. A current positive exact parent read can admit retained exact private Items; no shared Items mount policy is added. Existing Items and candidate reads must be successful and idle for a new effect. Typed denial hides candidate output through unresolved retry; ordinary failures need not erase retained command outcomes. Retry refetches the exact current parent and never changes candidate identity or repeats an effect. The parent's complementary criterion and guide commit is `c9e1f84f48ee5f2b61d890a8024c70eb4835fecf`; integration remains parent-owned.

## Owners And Boundaries

[Thread Visibility And Explicit Sharing](../../specs/20260909-thread_visibility_and_sharing.md#contract--expected-behavior) owns current parent/source audience checks and the rule that caches cannot authorize private previews. [Permissions](../../core/permissions.md#technical-administration) owns current administrator and per-effect authority. [Persistent Worker Volumes](../../specs/20260910-persistent_worker_volumes.md) owns immutable authored/resolved candidates, exact activation confirmation and unknown-result handling. [Web Product Surface Projection](../../specs/20260628-web_product_surface_projection.md) owns the Web projection. [Change Execution](../../change-execution.md) owns coordination; this record adds no design authority.

The sole builder writes `apps/web/src/screens/settings/AdministrationScreen.tsx`, its adjacent test, `AdministrationConfigurationReview.tsx`, and this record on `lane/web-administration-admission` in the separate audit worktree. The parent extended exclusive ownership to the configuration review component so denied visibility can return null after its existing mutation hooks and retain an in-flight result. The parent owns the criterion projection, guides, manuals, browser evidence and integration after the preceding Recovery landing. Exclusions: the separate Workspace access recovery paused-state concern, Vault grant controls, Timeline and chat changes, Artifact API changes, backend checks, durable state, actor epochs, account lifecycle changes, permission abstractions, new dependencies, external publication, hosts, credentials and other lanes. Existing typed clients, TanStack read and mutation owners, accessible primitives and exact command identity remain in use.

## Acceptance Observations

Current administrator access and the exact parent audience admit private candidate facts and effects. Typed denial hides candidate facts and open confirmations through unresolved retry. Existing private source reads must be successful and idle before a new preparation, recovery, Apply or activation. Read recovery never repeats an effect. Existing exact identities, candidate revisions, attempted locks, unknown outcomes and dispatched command results remain intact.

## Current Checkpoint

The implementation rechecks its own access, exact parent and candidate queries with native freshness and cancellation; it does not change the shared Items hook. It retains the existing Items query identity after access has succeeded so an access failure does not switch the candidate query key and unmount its pending command observer. Current authority and source read state still gate output and callbacks. Candidate components return null after their mutation hooks when private output is unavailable. Ordinary Administration UI and portals are removed explicitly when current access is unavailable. Retry reads the exact current parent.

The engineer's Simplicity ruling reduced coverage to two demonstrated parent-denial cases, four representative dependency cases, the two distinct pending-command outcome paths, fresh-cache remount, deletion portal and actual Items retry. Existing positive and unknown-outcome tests remain. The configuration outcome path now denies administrator access; the environment path denies the parent. There is no Cartesian source-by-kind matrix. No new state, registry, ledger, latch, fence, harness, backend API or reconstruction logic is added.

The parent owns complementary criteria, guides, manual and browser evidence, integration and acceptance. This increment remains separate from Recovery, and landing remains subject to the coordinator's P14 priority. No independent acceptance is claimed.

## Verification Evidence

Raw logs are retained under `/home/simonx/AI/temp/backlog-20261015/evidence/L-WEB/admin-candidates/`. The early `parent-denial-red.log` used premature immediate UI assertions; its six failures are not deciding defect proof. `portal-retry-red.log` retains the early review probe; its deletion case used the rendered Access denied barrier, while its early automatic-retry oracle is superseded. Failed intermediate complete runs remain in `verification-attempt1-*` and `verification-attempt2-*`.

The synchronized `parent-denial-stable-red-replay.log` ran the revised tests against the original production pair from `77b63c58877ec6ad8aab9fa508da34b61e2d0a5d`, printing Git blob hashes. It observed five failures and one pass: environment candidate-read denial already removed its card; the remaining cases left protected facts or confirmation content. `later-retry-red-replay.log` ran against the production pair from `a004758e7e0a32ee6441d8e62f83dfede3e20c8c` and observed the later 500 restore private facts without success. These are post-implementation replays, not the initial test-first baseline. Final retry coverage also waits for ThreadStream's rendered failure banner before checking the terminal-500 frame.

The prior candidate at `fa80079e803fb892f345f4897b8e94b22e14121a` passed the complete 62-case file, Web typecheck and focused lint before the requested coverage reduction. Preserve this observation separately from the final reduced-file check. The access-outcome probe at `861d60369c72ddfd29ec38d6793b8dffcf1a6f31` observed one failure and 37 skipped: after a settled administrator denial, the original mutation succeeded but Configuration command result did not return after observational Retry. `access-outcome-probe.log` retains that deciding failure. The earlier selector miss skipped all tests and is retained as `access-outcome-probe-selection-miss.log`; it proves nothing. The local Items-key correction follows this demonstrated loss.

Final commands use pinned Node 24.18.0 and pnpm 10.33.3, the assigned slot runner, `TMPDIR=/home/simonx/.cache/openkit-tmp/L-WEB-admin-candidates`, `CARGO_BUILD_JOBS=1`, one Vitest worker and no file parallelism. Required final commands are `pnpm --filter @openkit/web exec vitest run src/screens/settings/AdministrationScreen.test.tsx --maxWorkers=1 --no-file-parallelism`, `pnpm --filter @openkit/web typecheck`, and `pnpm exec biome check` on the three owned source/test paths. Their retained logs are `administration-green.log`, `web-typecheck.log`, `focused-lint.log` and the slot summary `verification-run.log`. Final reduced-file results remain pending.

## Scope And Remaining Limits

The diff changes four paths, edits no owning specification, and adds no closed set or registry. Four accepted design owners are referenced above: Thread Visibility, Permissions, Persistent Worker Volumes and Web Product Surface Projection. All evidence here is component-level evidence; it does not certify backend admission, Worker execution, host replacement or integration acceptance. Parent-owned guide and criterion integration and independent judgment remain outstanding. No adjacent recovery path or Vault grant behavior is changed.
