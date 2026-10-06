---
status: Accepted
date: "2026-10-06"
decider: Engineer, on a Consultant-reviewed proposal
---
# Live Cancelled Task Checkpoint Removal

## Decision

The engineer approved option (i): a live synchronous Task invocation removes its own still-preparing checkpoint after rechecking durable cancellation of its exact never-leased first admission and absence of every execution owner, before returning the refusal. Durable Scheduler Design owns the proof and deletion boundary. The cancelled admission and preparation history remain authoritative, the same request cannot launch again, and no Turn, receipt, settlement record or recovery lifecycle is created. Post-lease refusal remains outside this exception. Core cancellation and Workspace removal are separate commits; a crash between them leaves the checkpoint for fail-closed inspection. Boot, replay and operator bulk deletion gain no authority.

## Reason

The engineer's recorded ruling was “i” on 2026-10-06, approving the Consultant's narrow attempt-local proposal. Ordinary capacity deferral followed by cancellation otherwise leaves a checkpoint requiring impossible worker recovery. The live invocation can prove its own preparation provenance without weakening historical inspection or inventing worker execution. Source: engineer queue entry “Cancelled never-leased Task checkpoint” and checkpoint-residue consultation, dated 2026-10-06. Those sources preserve decision provenance, not behavioral authority.

## Rejected Alternatives

- (ii) Write the checkpoint only after lease acquisition: still leaves a cross-database crash window and moves context preparation and launch authorization.
- (iii) Let boot collect cancelled never-leased checkpoints: loses live provenance and reverses the accepted boot-deletion prohibition to cover historical rows and the crash window.
- (iv) Reserve a durable Turn earlier: creates product history for work that never ran and broadens failure and receipt semantics.
- (v) Do nothing: ordinary capacity cancellation leaves permanent degraded diagnostics without a supported cleanup path.

## Revisit When

Automatic cleanup across the cancellation/removal crash window becomes an explicit requirement, or production evidence shows the live invocation cannot establish the complete no-execution proof.

## Affected Owners

- [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md#missing-turn-checkpoint-maintenance)
- [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md#worker-turn-envelope)
- [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md)
