# Scheduler Recurring And Event Triggers

Status: Draft
Implementation: Not Started

## Owns

- The entry conditions and minimum safety boundaries for any future recurring or event-triggered worker admission capability.
- The future requirement to retain an exact responsible actor, recheck that actor's current authority, and reuse the existing durable admission owner.

## Does Not Own

- Any current V1 capability, implementation, schema, route, service, runner, test obligation, or release gate.
- Audit group G07, WP-6, or the current self-improvement loop. Those scopes use explicit human-requested reflection and do not depend on recurring or event-triggered automation.
- Turn admission, queue ordering, placement, leases, dispatch, or worker-effect recovery, which remain owned by `docs/specs/20260703-durable_scheduler_design.md` and the applicable worker runtime specifications.
- A generic event bus, workflow engine, job registry, fire ledger, recovery coordinator, or product automation platform.
- The semantics of any domain operation that might later request scheduled execution.

## Core References

- `docs/core/foundation.md`
- `docs/core/runtime-model.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`

## Summary

This Draft is a non-authorizing future boundary. OpenKit V1 does not provide recurring or event-triggered worker execution, and G07/WP-6 does not require it. Reflection remains an explicit human action. A future design may proceed only after a concrete user automation need identifies the responsible actor, the existing operation to invoke, and why explicit invocation is insufficient.

The smallest acceptable future shape is a timing record in front of an existing owner. It is not a second execution or recovery system. Worker work must enter through the existing durable admission path, and non-worker work must remain with its domain owner instead of being generalized into scheduler jobs.

## Goals / Non-goals

### Goals

- Prevent a future automation feature from bypassing current authority or creating a parallel executor.
- Preserve the minimum lifecycle, failure, restart, and acceptance decisions that must be settled before this Draft can become implementation guidance.
- Make the current human-triggered compromise explicit and truthful.

### Non-goals

- Do not authorize scheduled reflection, event-driven reflection, recurring product automation, or replacement of the current in-memory automation-definition surface.
- Do not predesign cron syntax, catch-up history, overlap policies, budgets, Action Center projections, APIs, or UI.
- Do not add fire records, scheduler epochs, settlement states, automatic repair, or exhaustive crash-point recovery.

## Decision

No implementation may be derived from this Draft. Promotion to an accepted, implementation-ready contract requires a concrete user story and an accompanying change plan that narrows the feature to one existing operation family.

The current V1 compromise is explicit human invocation. For reflection, a human asks an agent to compose existing work-history reads and the existing Knowledge Proposal operation; there is no reflection run or scheduler admission to automate. Missing recurring execution is an unavailable capability, not a condition to hide behind an in-memory timer or best-effort background loop.

## Contract / Expected Behavior Before Promotion

### Definition and authority

- A future trigger may own only when an already-defined operation should be requested. It must not become the authority for the operation's result, lifecycle, or recovery.
- The durable trigger authority must retain the exact responsible `ActorRef`, target workspace, requested operation identity, and the complete inputs needed by that operation's existing admission boundary. Owner inference, actor reassignment, and ambient-system authority are forbidden fallbacks.
- Every due attempt must recheck that the stored actor still has the required current authority for the same target, including `runtime.launch` for worker admission. Missing, disabled, or unauthorized actors must fail closed without admission.
- Read models and history, if later required by a concrete UI, are projections of the trigger and existing admission records and must not become another work-state authority.

### Admission and lifecycle

- Worker execution must reuse the existing durable scheduler admission primitive. A trigger-specific queue, executor, lease, or result state is out of scope.
- If a later event needs immediate worker work, its owning domain should create the normal admission directly. It must not create a one-shot schedule merely to obtain a generic event-delivery mechanism.
- A promoted recurring design must define creation, update, pause, resume, cancellation, and due-time advancement under the stored actor's current authority. It must also choose one explicit missed-time rule for the concrete user story; the default small-deployment compromise should be one coalesced admission rather than replaying every missed interval.
- A future accepted design must first identify whether trigger authority and scheduler admission share one Core SQLite effect domain. If they do, admission creation and due-time advancement use one transaction and one deterministic request identity. If they do not, the owning spec must choose a bounded typed failure or retry compromise; either case must avoid a separate fire record or recovery state machine.

### Failure and restart

- NanoCore restart may discover an overdue trigger from its durable due time and retry the same admission boundary. Restart must not require a fire ledger, epoch protocol, or trigger-owned recovery scan beyond reading the authoritative trigger row.
- A duplicate request must resolve through the existing admission idempotency behavior. Trigger code must not reconstruct worker receipts or settle worker effects.
- Missing targets, stale configuration, denied authority, or invalid admission inputs must produce a typed fail-closed result and leave the trigger inspectable. A future design may choose bounded pause or cancellation behavior, but it must not silently select another actor, target, or operation.
- Core storage and worker execution remain separate effect domains. If the worker effect is interrupted or unknown after admission, the existing Turn and worker-runtime contracts own that outcome; the trigger must not promise transparent repair.

## Current Implementation Projection

`apps/nanocore/src/lib/automation-store.ts` and its routes retain process-local automation definitions without persistence or an executor. They do not implement this Draft and must not be treated as evidence that recurring execution exists. The durable scheduler already owns worker admission; any future accepted trigger design must reuse that owner rather than extend the in-memory definition store into an execution platform.

## Testing Strategy / Acceptance Criteria

This Draft creates no current test obligation. Before it can be accepted for implementation, one concrete user story must define observable acceptance for all of the following:

- an authorized actor creates or changes the trigger and an unauthorized actor cannot;
- a due attempt rechecks the same actor's current authority and submits exactly one existing admission request;
- the accepted storage boundary uses one coherent rule: an atomic Core transaction when trigger and admission are co-located, or an explicit bounded typed compromise when they are not, with deterministic duplicate handling and no recovery workflow;
- restart coalesces overdue work according to the chosen rule without a second recovery workflow;
- missing authority, stale targets, invalid inputs, and unknown worker effects remain typed, inspectable, and fail closed.

The accepted change should use the lowest sufficient deterministic tests. It must not add a dedicated acceptance runner, crash matrix, or automation harness unless a separately documented need justifies that scope.

## Open Questions

- [Blocking] What concrete user automation need cannot be served by explicit invocation, and which one existing operation family owns the requested effect?
- [Blocking] What is the minimum cadence representation and missed-time compromise required by that user story?
- [Blocking] Do trigger authority and scheduler admission share one Core transaction, and if not, what bounded failure or retry compromise replaces cross-domain atomicity?
- [Blocking] Which existing admission request identity provides duplicate handling across restart without a fire ledger?

## Deferred / Future Work

Cron expressions, event subscriptions, broad automation APIs, fire history, overlap controls, budget-aware scheduling, multi-target coordination, and multi-process tick ownership remain unapproved possibilities. Each requires a separate concrete need and accepted owning contract; none is implied by this Draft.

## Links

- `docs/changes/202607172152230001-openkit_execution_program.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260529-test_strategy.md`
