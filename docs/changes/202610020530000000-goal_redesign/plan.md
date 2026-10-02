---
type: change-plan
status: in-progress
date: "2026-10-02"
---
# Goal Redesign

## Intent Revision 1 — 2026-10-02

This plan records the Goal Mode redesign discussion between the engineer and the primary agent (Claude Code, Opus) held on 2026-10-02. The engineer's verbatim statements are kept uncommitted in `temp/goal-redesign/`: the framing in `engineer-g1.md` and the rulings on the direction draft in `engineer-g2.md`. The direction draft is `temp/goal-redesign/direction-g1.md`; the clean-room and grounded Consultant reports are in `temp/goal-redesign/reports/`.

**The engineer's outcome.** Goal Mode is not an independent system. It is the orchestration, use, generation, and extension of NanoCore's existing capabilities, including knowledge management, sandbox and worker manifest configuration and scheduling, Generative UI and the Generative Kernel, permissions, audit, the gateway, eval, and the Chat and Task mechanisms, guided by the product philosophy in the two conversations the engineer shared (an opinionated, Linear-like control plane for small professional teams; convention over configuration) and by the Business World Model theory. It shares the operation primitive, mechanisms, and interface of the interface unification (change record 202610020440000000-interface_unification). The engineer's translated words: it does not need to be perfect at once; first settle the principles and direction, then stabilize the framework and mechanisms in the system as the foundation for later development, upgrades, and extension.

**Acceptance observations.**
- A person creates a Goal, the Coordinator proposes an exact Plan version, and the person approves that version through a Pending Request.
- Within the approved Plan the Coordinator dispatches ordinary Tasks on a real worker runtime without asking the person to approve each Task.
- After a Task ends or a person edits a card, the Coordinator's next admitted Turn rereads Goal state and acts, including after a restart.
- A worker completion never closes the Goal; the responsible person accepts an evidence-backed completion candidate.
- Existing Goal data and the old Goal implementation are gone, and every non-Goal record that referenced a Goal stays usable.

**Non-negotiables.** Root `AGENTS.md`, including NONNEG-001 data continuity for all non-Goal data and no compatibility layers for first-party interfaces; the Safety Kernel; DOC-018. Ruling 5 is the engineer's explicit authorization to delete Goal-owned data.

**Exclusions.** Convention compilation into Skills, manifest defaults, or generated views, typed BWM entities in the Generative Kernel, eval verification, and Policy Kernel grants for agents (later stages); `docs/product-vision.md`; `docs/changes/202609290900000001-chat_task_stability_handoff/`.

**Effect boundary.** Local code, tests, and documentation; live verification on the disposable A2 staging host and pushing `main`, under the engineer's standing instructions for the communication redesign program given in the coordinator's sessions (2026-10-01: deploy the latest main to A2, live-test it, and the coordinator may push `main` itself; 2026-10-02: A2 is a disposable test server). No other external publication.

## Accepted Decisions

Sources are `temp/goal-redesign/engineer-g1.md` and `engineer-g2.md`. The decisions and their reasons are recorded in [the Goal redesign rulings](../../decisions/20261002-goal_redesign_rulings.md).

1. A Goal is a continuously pursued outcome plus the authority delegated to pursue it. Goal Mode adds only the Goal record, its work-intent cards, and the Coordinator role; execution is ordinary Tasks, decisions are Pending Requests, and every other piece is an existing NanoCore owner composed through the same operations.
2. Plan versions are immutable, and approval selects one exact version through a Pending Request.
3. Approving a Plan lets the Coordinator dispatch and adjust bounded Tasks inside it without per-Task confirmation; a new material commitment needs a new exact approval; effect-specific approvals stay independent.
4. The responsible person accepts an exact evidence-backed completion candidate; the Coordinator, eval, and reviewers only recommend.
5. Conventions are Knowledge records with scope, evidence, and lifecycle; no Convention entity; typed entities come later through the Generative Kernel.
6. Existing Goal data is deleted, not migrated and not kept as read-only history.

## Owners And Seams

The new Goal specification replaces [Goal Mode Coordination](../../specs/20260704-goal_mode_coordination.md) as the active contract and owns the Goal, cards, Plan versions, the wake marker, the completion disposition, and the Goal operations. Amended: [Workflow Coordinator](../../specs/20260704-workflow_coordinator_internal_agent.md), [Pending Requests](../../specs/20260930-pending_requests.md), [Chat Mode Assistant](../../specs/20260704-chat_mode_assistant.md), [Task Mode](../../specs/20260704-task_mode_worker_delegation.md), [Human Attention](../../specs/20260531-human_attention_intervention_model.md), [Work Model](../../core/work-model.md), [Agent Workflow](../../core/agent-workflow.md), [Worker Context Package](../../specs/20260703-worker_context_package.md), [Durable Scheduler](../../specs/20260703-durable_scheduler_design.md), [Runtime Scheduling Scale](../../specs/20260703-runtime_scheduling_scale.md), and [Workspace Backup, Export and Import](../../specs/20260704-workspace_backup_export_import.md). The knowledge owners need no stage-1 amendment.

Goal operations are implemented through the accepted operation-definition shape after its first slice lands, so they are not written twice and no separate Goal catalog is introduced. Deletion of the Goal tables and implementation lands together with the new Goal implementation as one one-way removal, because dropping them first would make export, conversation replay, checkpoint recovery, and Sandbox pin checks fail before the amendments that keep non-Goal records usable exist.

The primary coordinates; a writer drafts the owner amendments and an independent verifier checks them before landing.

## Working Checkpoint

State on 2026-10-02: the engineer ruled on the direction; the grounded Consultant report (`temp/goal-redesign/reports/consult-goal-grounded.md`) found no further engineer decision open. Running: the owner amendments in the `goal-owners` worktree. Next action: verify and land the owner amendments, then implement stage 1 after the first operation-definition slice lands; the first proof is section 8 of the grounded report, including showing that the wake marker is written by the same Core commit that records a Task's terminal fact.
