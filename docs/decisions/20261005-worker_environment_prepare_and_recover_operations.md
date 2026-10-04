---
status: Accepted
date: "2026-10-05"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Consultant's recommendation
---
# Worker Environment Preparation And Recovery Operations

## Decision

The Coordinator chose separate `worker-environment.prepare` and `worker-environment.recover` operations with strict object inputs and no public mode, owned by [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md). Both use the existing preparation and recovery owner. The family supplies the fixed internal mode before canonical command parsing and receipt comparison, preserving retained command identity, normalized input, exact replay and conflicts. The private administration entry derives two object Tools from the same family inputs and retains its current Turn and request-id binding.

## Reason

Preparation authors an image candidate; recovery resolves a previously authored candidate and cannot acquire or build an image. Two discoverable verbs express that existing distinction directly and preserve projected field requirements without extending the shared operation schema contract for one demonstrated case. Flattening the former mode union lost JSON Schema branch constraints and caused model views to re-require an omitted request id. First-party release-coupled interfaces carry no compatibility obligation; retained receipts do.

The Coordinator decided this in the engineer's absence under the standing delegation; this record does not attribute the choice to a new engineer approval. Source decision: temp/comm-redesign/engineer-queue.md, “Worker environment preparation and recovery become two operations”, dated 2026-10-05. Source consultation: temp/interface-unification/reports/b10-union-consult/consult-report.md, especially Alternative B and Recommendation and concrete owner text. These paths record provenance, not behavioral authority.

## Rejected Alternatives

- Extend the shared operation contract to root discriminated unions: feasible, but affects every projection and consumer for one current operation.
- Nest the variants under an action object: preserves constraints but retains an overloaded prepare verb and adds a wrapper to satisfy the schema boundary.
- Retain flattened fields with conditional schema patches or prose: duplicates the contract or leaves discovery inconsistent with runtime validation.

## Revisit When

A later indivisible operation needs root alternatives, or implementing the split requires a shared-layer algorithm or new durable lifecycle.

## Affected Owners

- [Persistent Worker Volumes](../specs/20260910-persistent_worker_volumes.md)
- [Operation Definition](../specs/20261002-operation_definition.md), implementation projection only.
- [Chat Mode Assistant](../specs/20260704-chat_mode_assistant.md), fixed private Tool projection.
