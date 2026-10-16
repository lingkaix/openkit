---
status: Accepted
date: "2026-10-16"
decider: Coordinator under engineer delegation
---
# Inspect Interrupted Recurring Turn Publication

## Decision

Keep the accepted scheduler no-repair owner. Do not add a durable publication field or a publication-recovery exception. Attempt the initial fixed pending Turn publication once at source admission inside the existing Workspace mutation fence. A Core-accepted occurrence whose fixed Turn is missing or contradictory remains non-dispatchable `recovery_required`, with its cause visible in occurrence history and Web/CLI projections. Do not reconstruct, synchronize through an empty Turn update, replace the identity, or submit a Worker.

Cadence, committed admission attempts and history survive restart. The existing queue cancel operation releases a held queued occurrence so later nominal occurrences can proceed normally. Queue cancellation must not fabricate a missing Turn or modify a contradictory Turn. No repair command or runner is accepted. Regressions cover interruption before and after publication, fresh Store/Core restart, zero repair writes and Worker submits on refusal, queue cancellation, and later normal cadence.

## Reason

The coordinator chose the smaller current-owner route after independent Consultant scrutiny of a bounded pending/published proposal. The local publication crash window is narrow; adding another durable authority field, owner exception and projection obligations is not justified for this pre-stable slice. A retained queue proves acceptance, not complete pending Turn publication or successful execution. Explicit inspection preserves that distinction.

## Source

The coordinator answered the L-GO publication decision question in the active engineering session on 2026-10-16. The external proposal and independent Consultant review are execution evidence under `backlog-20261015/evidence/L-GO/`; neither is design authority. [Durable Scheduler](../specs/20260703-durable_scheduler_design.md) and [Recurring Triggers](../specs/20260711-scheduler_recurring_event_triggers.md) remain the owning specifications.
