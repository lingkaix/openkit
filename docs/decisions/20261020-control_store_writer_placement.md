---
status: Superseded
date: "2026-10-20"
superseded-by: docs/decisions/20261020-control_store_mixed_writer_exception.md
decider: Engineer, on a coordinator proposal
---
# Control Store Writer Placement And Load Envelope

## Decision

Every write to an OpenKit-owned SQLite database runs in one dedicated database worker thread. The worker holds each database's only read-write connection and runs the complete read-check-write body of each accepted transition inside its transaction. It groups at most 32 ready transitions of one Workspace per transaction and waits at most 5 ms to coalesce them. Each transition gets its own savepoint. The worker acknowledges a transition only after the outer COMMIT with `synchronous=FULL`. The main thread keeps read-only WAL connections for pure reads, and those reads stay synchronous. Only writing callers become asynchronous.

The design load envelope is 640 offered transitions per second in total. The reference configuration is 8 concurrently active Turns in one Workspace plus three independently active sibling Workspaces. Within the envelope Core loses no accepted work, and main event-loop delay p99 is at most 25 ms. Beyond it Core refuses new work explicitly. [Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md) owns the rule.

This narrows an earlier implementation plan for the [control store decision](20261019-durable_execution_and_control_store.md). In that plan the worker also owned every read connection, and the main thread owned none.

## Reason

Source: the engineer approved the coordinator's proposal on 2026-10-20, after a bounded local measurement and an inventory of SQL call sites. The measurement used WAL, `synchronous=FULL` and a copy-on-write filesystem. It probed 8, 32 and 128 active Turns in one Workspace, alone and with three active sibling Workspaces, with two repeats each.

Durable COMMIT is what blocks. An ungrouped synchronous writer on the main thread held the event loop for one 12.7-second COMMIT. With the writer on its own thread, main event-loop delay p99 stayed at or below 11 ms in all 20 measured runs, and the maximum delay was 22 ms. That held even in a run where one database-thread COMMIT took 9.9 seconds. WAL readers do not wait for durability, so moving them to the worker adds no latency benefit.

Correctness needs atomic read-check-write transitions, and the worker transaction provides them. A pure read needs only a committed snapshot, and WAL provides that.

The inventory found 529 read sites in 115 files, against 301 write sites in 72 files. Making reads asynchronous would touch nearly every module. It would also add an await point at each read, where other work can interleave with code that assumed none. The engineer asked, translated from Chinese, that parallel work be planned so the end does not again become a bottleneck of merging each other's work: "large inconsistencies and conflicts caused by parallel work, and bugs caused by broken mechanisms".

The envelope comes from the same measurement. Grouping raised throughput in the reference configuration from 73-96 to 607-640 transitions per second, at 640 offered. The highest probe offered 3,040 transitions per second and completed about 820-890. Expected product peak is well below 100 transitions per second. WAL age exceeded 5 seconds in several runs, including runs with an intentionally pinned reader. WAL age therefore triggers backpressure; it is not a latency objective.

## Rejected Alternatives

- **Every connection in the worker, including reads.**
  - It gives no measured latency gain.
  - It turns 529 read sites into asynchronous calls across almost every module and adds interleaving points.
  - It concentrates merge conflicts.
- **A synchronous writer on the main thread.** One durable COMMIT stalled the event loop for seconds.
- **Weakening `synchronous=FULL`, or discarding committed WAL frames, to hide slow commits.** This loses acknowledged transitions on crash.
- **A writer thread per Workspace for `v0.1.0`.** It adds threads and coordination before any measured need. One worker accepts cross-Workspace SQL-service coupling instead.
- **The 3,040 transitions per second stress level, or a 5-second WAL-age ceiling, as release gates.**
  - The stress level is far above expected load.
  - The age ceiling measures filesystem tail behavior, not correctness.

## Revisit When

Revisit when any of these happens:

- Measured product load approaches the envelope.
- One Workspace's load measurably pushes main event-loop delay or another Workspace's commits past the objective.
- A caller shows a concrete correctness need to read a write that is not yet acknowledged.

## Affected Owners

- [Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md).
- [Runtime Scheduling Scale](../specs/20260703-runtime_scheduling_scale.md).
