---
status: Accepted
date: "2026-10-16"
decider: Coordinator under engineer delegation
---
# Inspect Interrupted Recurring Turn Publication

## Decision

Keep the accepted scheduler no-repair owner. Do not add a durable publication field or a publication-recovery exception. Attempt the initial fixed pending Turn publication once at source admission inside the existing Workspace mutation fence. A Core-accepted occurrence whose fixed Turn is missing or contradictory remains non-dispatchable `recovery_required`, with its cause visible in occurrence history and Web/CLI projections. Do not reconstruct, synchronize through an empty Turn update, replace the identity, or submit a Worker.

Cadence, committed admission attempts and history survive restart. The existing queue cancel operation releases the series waiting slot held by that queued occurrence. It leaves ordinary Thread single-flight intact, so a damaged pending Turn can still hold its original Thread; later dispatch in the regression follows an authorized paused target edit to another existing Thread. Queue cancellation must not fabricate a missing Turn or modify a contradictory Turn. No repair command or runner is accepted. Regressions cover interruption before and after publication, fresh Store/Core restart, zero repair writes and Worker submits on refusal, queue cancellation, and later normal cadence.

### Operation-Local Errors And Canonical Export

On 2026-10-16, the coordinator applied the engineer's simplicity rules to this implementation. An uncertain file operation fails with a clear error and keeps its files. It does not lock Workspace writes for the life of a Store. A retry or restart is the recovery. The cache is a derivative, so portable export uses canonical Turn and Item data when the cache disagrees. It may ignore or rebuild the cache; that disagreement is not an export refusal. Missing or contradictory canonical publication still follows the no-repair rule above.

The earlier implementation choice to retain an uncertain candidate behind a Store-lifetime Workspace refusal is withdrawn. The full-cache-equality export refusal is also withdrawn. One regression covers operation-local failure with retained files and later Workspace writes; one covers canonical export after a real failed Turn update. No new recovery field, lock, ledger or runner replaces either rejected choice.

## Reason

The coordinator chose the smaller current-owner route after independent Consultant scrutiny of a bounded pending/published proposal. The local publication crash window is narrow; adding another durable authority field, owner exception and projection obligations is not justified for this pre-stable slice. A retained queue proves acceptance, not complete pending Turn publication or successful execution. Explicit inspection preserves that distinction.

## Rejected Alternatives

The bounded pending/published amendment would add durable authority, an owner exception, projection, migration and portability obligations for a rare interruption. Unconditional missing-Turn reconstruction and empty-input persistence retries conflict with the retained no-repair owner. Neither route is accepted.

## Revisit When

Revisit only when interruption evidence justifies a new owner amendment and the engineer explicitly accepts its authority and recovery consequences.

## Affected Owners

The coordinator answered the L-GO publication decision question in the active engineering session on 2026-10-16. The external proposal and independent Consultant review are execution evidence under `backlog-20261015/evidence/L-GO/`; neither is design authority. [Durable Scheduler](../specs/20260703-durable_scheduler_design.md) and [Recurring Triggers](../specs/20260711-scheduler_recurring_event_triggers.md) remain the owning specifications.
