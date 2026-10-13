---
id: goal-completion-with-plan-approval
title: Finish one goal with an approved plan and one worker task
persona: Person responsible for one small piece of work
entrypoint: web
default_tool: playwright
timeout_seconds: 1200
requires_real_provider: true
requires_real_codex: false
contracts: docs/specs/20261002-goal.md, docs/specs/20260930-pending_requests.md, docs/specs/20260704-task_mode_worker_delegation.md, docs/core/protocol.md, docs/specs/20260713-work_resource_interaction_model.md
---

## Intent

Persona: A person responsible for one small piece of work.

Ask: Get this small piece of work done. I will approve the plan and I will accept the finished result myself.

## Starting World

One workspace can take a Goal. One small contribution is designated, such as a short acceptance note. One Worker is available.

## Setup

The stage manager supplies the provider through the private parameter file. The stage manager does not put a credential value in the story or in the ask. The stage manager designates the small contribution in that file.

## Outcome Predicates

- Channel inside-out, tier required. The approved Plan is the exact immutable version that was approved, and that approval is the Pending Request for that version. The records are the Plan version and the Pending Request. `docs/specs/20261002-goal.md` owns the Plan version. `docs/specs/20260930-pending_requests.md` owns the Pending Request.
- Channel inside-out, tier required. No Worker Turn for this Goal exists from creation alone or from Plan approval alone. The approved Plan then authorizes one ordinary Task linked to the current card revision and that Plan, without a second per-Task approval. The records are the Goal, the card revision, the Plan, and the Task. `docs/specs/20261002-goal.md` owns that ordering. `docs/specs/20260704-task_mode_worker_delegation.md` owns the Task.
- Channel inside-out, tier required. The Task's actual output is readable as an Artifact. The public read of that Artifact and the Item that carries its Task lineage decide this predicate. The records are that Artifact and that Item. `docs/core/protocol.md` owns the Artifact's canonical semantics. `docs/specs/20260713-work_resource_interaction_model.md` owns the Artifact record and its Item-backed lineage.
- Channel inside-out, tier required. Completion is accepted with the exact candidate and evidence through its Pending Request, that request is then consumed, and the terminal Goal disposition names the accepted candidate. The records are the completion Pending Request and the Goal disposition. `docs/specs/20261002-goal.md` owns the disposition. `docs/specs/20260930-pending_requests.md` owns the Pending Request.
- Channel inside-out, tier required. Worker completion leaves the Goal open until that completion grant is consumed. The records are the Goal status and the completion Pending Request. `docs/specs/20261002-goal.md` owns that order.
- Channel inside-out, tier optional. When the chosen Task needs an effect-specific approval, that approval is a separate Pending Request and is not the Plan approval. The judge skips this predicate when the Task needs no such approval. The record is that Pending Request. `docs/specs/20260930-pending_requests.md` owns it.

## Perturbations

None.

## Integrity Invariants

None.

## Evidence To Collect

The stage manager keeps the public Goal read with intent, card, Plan identity, and digest. The stage manager keeps the public read of the linked Task Thread and its terminal Turns. The stage manager keeps the public read of the Task's output Artifact and the Item that carries that Artifact's Task lineage. The stage manager keeps the Plan and completion Pending Requests with their exact intents and deciding actors.

## Cleanup

The stage manager does not delete the Goal until the public Goal read is in the evidence.

## Failure Triage Notes

- A product failure means a Worker starts before the Plan grant is consumed, the Task needs a second approval, the Goal closes before the completion grant is consumed, or the disposition names a different candidate.
- An environment failure means no Worker is available, the provider is missing, or the workspace is missing.
- A tool failure means the browser-control tool fails on its own.
- An inconclusive result means the Plan gate or the completion gate was never witnessed.
- The likely lower layer is the Goal operation tests under `docs/specs/20261002-goal.md`.
