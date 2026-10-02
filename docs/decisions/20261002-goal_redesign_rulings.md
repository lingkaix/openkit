---
status: Accepted
date: "2026-10-02"
decider: Engineer, on a Consultant-reviewed proposal
---
# Goal Redesign Rulings

## Decision

The engineer activated the Goal Mode redesign on 2026-10-02 and ruled on its direction.

1. Goal Mode is not an independent system. It orchestrates, uses, generates, and extends existing NanoCore capabilities and shares the operation primitive, mechanisms, and interface of the interface unification. A Goal is a continuously pursued outcome plus the authority delegated to pursue it; the redesign adds only the Goal record, its work-intent cards, and the Coordinator role, with execution as ordinary Tasks and human decisions as Pending Requests.
2. Plan versions are immutable, and a person approves one exact version through a Pending Request.
3. Approving a Plan authorizes the Coordinator to dispatch and adjust bounded Tasks within that commitment without a per-Task confirmation. A new material commitment needs a new exact approval, and effect-specific approvals stay with their own owners.
4. The responsible person accepts an exact, evidence-backed completion candidate. The Coordinator, eval, and reviewers recommend; a worker completion or a review verdict does not complete the Goal.
5. Conventions are Knowledge records with scope, evidence, and lifecycle. No Convention entity is added; a typed entity layer comes later through the Generative Kernel.
6. Existing Goal data is deleted, not migrated and not kept as read-only history. Records outside Goal ownership that reference a Goal stay usable.

The Goal specification that replaces Goal Mode Coordination owns rules 1 to 4 and 6 for Goal records; Pending Requests owns the approval mechanics; the knowledge owners own rule 5.

## Reason

Translated from Chinese. On the framing, the engineer said the shared ChatGPT and Grok conversations express the product design philosophy for Goal Mode, that Goal Mode is the full orchestration and extension of NanoCore's capabilities rather than a separate system, and that it should combine the unified system and mechanisms with that philosophy and the Business World Model theory. "It does not have to be perfect at once; we first settle our principles and direction, then stabilize the concrete framework and mechanisms in our system, laying a solid foundation for later development, upgrades, and extension."

On rules 2 to 5, the engineer answered "1 agree, 2 the recommended option, 3 agree, 4 agree, 5 delete" to the primary agent's direction draft, accepting these recommended reasons. Exact version approval keeps what a person authorized distinguishable from intent that keeps changing, and reusing Pending Requests avoids a second approval mechanism. Dispatching within an approved Plan spends human attention on commitments rather than on each Task. Human acceptance keeps final authority over whether the outcome is achieved, while agents supply evidence. Knowledge already has scope, evidence, review, and lifecycle, so a separate convention store would duplicate it.

On rule 6, the engineer chose deletion over migration or read-only history, consistent with the instruction for this program that old-version data and sessions need not be considered.

The direction, its principles, and the minimal concept set were drafted by the primary agent from the engineer's framing, a clean-room Consultant design, and a census of the current implementation, and were grounded against the code by a second Consultant. Rule 1's reduction to the Goal record, cards, and the Coordinator originated in that draft and was not contested by the engineer; rules 2 to 6 are the engineer's rulings on the draft's questions.

Source: change record 202610020530000000-goal_redesign.

## Rejected Alternatives

- A per-Task proposal under delegated authority instead of exact Plan versions. Rejected under rule 2.
- Per-Task confirmation within an approved Plan. Rejected under rule 3.
- Completion decided by the Coordinator, an eval verifier, or the last accepted Task review. Rejected under rule 4.
- A Convention entity. Rejected under rule 5.
- One-way migration of existing Goal data, or keeping it as read-only history. Rejected under rule 6.
- A planning session, a Coordinator run record, a generic proposal entity, an inbox, or a workflow engine. Excluded by the direction and by the interface unification rulings.

## Revisit When

- A Goal needs a commitment that a Plan version cannot express without per-Task approval, which reopens rules 2 and 3.
- Eval verification is designed and proves reliable enough that a person wants it to close Goals, which reopens rule 4.
- The Generative Kernel typed entity layer is designed, which revisits where conventions and business entities live under rule 5.
- Independent agent identities and Policy Kernel grants are designed, which changes how the Coordinator's delegated authority is represented.

## Affected Owners

- docs/specs/20261002-goal.md
- docs/specs/20260704-goal_mode_coordination.md
- docs/specs/20260704-workflow_coordinator_internal_agent.md
- docs/specs/20260930-pending_requests.md
- docs/specs/20260704-chat_mode_assistant.md
- docs/specs/20260704-task_mode_worker_delegation.md
- docs/specs/20260531-human_attention_intervention_model.md
- docs/core/work-model.md
- docs/core/agent-workflow.md
- docs/core/knowledge.md
- docs/specs/20260704-workspace_backup_export_import.md
