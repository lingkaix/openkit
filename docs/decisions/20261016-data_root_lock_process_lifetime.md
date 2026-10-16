---
status: Accepted
date: "2026-10-16"
decider: Coordinator, under the L-OPS product-fix assignment
---
# Data-Root Lock Ownership Follows Process Lifetime

## Decision

The coordinator directed the 2026-10-16 19:05Z correction: "Make the smallest fix so that a lock held by a dead process never blocks boot", while "a live second App on the same data root is still refused". Kernel advisory locking was an accepted example. At 19:35Z the coordinator approved a 60-second saved stop grace, `flock` on the runtime-directory inode, the two regressions and the App smoke projection. [NanoCore Bootstrap, Readiness, And Recovery](../specs/20260704-nanocore_bootstrap_readiness.md#boot-phases) owns those predicates.

The implementation applies `flock` to an inherited descriptor for the existing runtime directory. Node keeps the open file description after the utility exits and closes it on release; process death also releases kernel ownership. This adds no file, package dependency, persistent helper, table, migration or recovery state machine. JSON metadata and its heartbeat remain diagnostic and keep their existing orderly-release lifecycle. The App image already supplies the utility; source hosts must supply a compatible version.

## Reason

A real App redeploy exhausted Docker's 10-second stop grace and received a forced kill. The JSON lock remained, and its old container hostname prevented the new process from proving it dead. This contradicted the existing crash-only boot contract. Kernel ownership ends even when shutdown handlers cannot run, while the same kernel still excludes a live contender.

## Rejected Alternatives

PID and hostname inference cannot prove process ownership across container namespaces. A heartbeat timeout can reject a dead holder or admit a delayed live holder. Operator deletion on every crash is not automatic recovery. An exclusive SQLite transaction was probed and rejected: its process-owned POSIX locks can be released when ordinary file inventory closes another descriptor for the same inode. `flock` ownership is attached to the retained open file description, so those reads cannot release it. A new native dependency or a persistent helper is unnecessary. Product-database transactions do not protect the whole data root.

## Revisit When

Revisit if a supported data-root filesystem cannot provide the directory's operating-system file locks, or if another product process must own the same root concurrently. Do not weaken live exclusion or add a fallback that guesses process liveness.

## Affected Owners

- [NanoCore Bootstrap, Readiness, And Recovery](../specs/20260704-nanocore_bootstrap_readiness.md)
