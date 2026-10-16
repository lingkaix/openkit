---
type: change-plan
status: in-progress
date: "2026-10-16"
---
# App Instance Lock Process Lifetime

## Intent Revision 1 — 2026-10-16

Source: coordinator at 19:05Z. A dead process must never block the next App boot, while a live second App on the same data root is refused. Use the smallest process-lifetime lock correction and one regression for each behavior. If the saved staging stop grace is shorter than the App's normal stop allowance, update only that application's saved setting. Do not redeploy now; retry only after a published fix. Do not create dev SSH credentials or bypass the Worker collector guard.

Authority: [NanoCore Bootstrap, Readiness, And Recovery](../../specs/20260704-nanocore_bootstrap_readiness.md), with its architecture, storage and audit Core references. The coordinator's requested correction is recorded in [Process-Lifetime Locking](../../decisions/20261016-data_root_lock_process_lifetime.md). The change record is execution evidence, not authority.

## Checkpoint

Base is a744277ba90932a62364315948dd96c6bfc99ef9, copied from Git. Branch is lane/ops-instance-lock. The target-only Docker journal proves a forced kill after the old App's 10-second SIGTERM grace. Its retained JSON lock named the old container, so the hostname-based local-dead-process test refused every replacement. The two-line cause and exact stop event are retained in private OPS evidence.

Two real-process regressions are written first: acquire after SIGKILL with prior-container metadata, and refuse a live second App. The expected red is the successor's DataRootLockError under the old hostname rule. Dependency installation and the affected dependency builds passed through the shared CPU scheduler. The old code produced eight passes and one failure, exactly the killed prior-container successor case. The corrected code passes all nine lock tests. A consumer run found one physical-cutover fixture that represented a live Core with only a JSON file; that fixture now acquires the real kernel lock and retains its refusal-before-backup assertions. No live redeploy occurred.

The correction locks the existing runtime directory through `flock`, retains its descriptor in Node, keeps holder metadata diagnostic and preserves the current audit summary. A probe rejected SQLite locking because ordinary reads can release its process-owned POSIX lock. The selected mechanism adds no file, canonical store, schema, persistent helper or recovery machinery. The existing App update helper grants its normal stop 60 seconds. The saved staging setting is now 60 seconds; readback proved every other saved field, the live service spec and the live container unchanged. This setting applies only on a future deployment after the fix is published.

## Verification And Landing

Run the two deciding regressions and the complete affected bootstrap, operator-recovery and cold-backup consumer suites, then focused formatting/type checks. Use one independent gpt-6.1-sol review and the express local gate. Merge P14 when it lands; do not land before it. Acquire the shared window only for land-express.sh, release immediately and observe main-push CI. No lane CI dispatch is needed. Record exact results and any unresolved boundary before closeout.


## Main-Push Fixture Repair

The initial landing passed its complete backend gate (636 cases) and App-entrypoint checks (11 cases). Its clean merged-head gate passed check:repo, lint and typecheck. Main-push CI then found a Web harness fixture that represented a live lock with diagnostic JSON alone. The fixture now holds the runtime-directory kernel lock through an inherited descriptor, retains the existing early-exit and data-root cleanup assertions, and closes the descriptor in finally. This changes no product code or acceptance predicate. Run the complete Web suites and Web e2e, obtain independent review and land the fixture correction as a main repair. Do not redeploy the App.
