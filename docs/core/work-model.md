# Work Model

Status: Accepted

This document defines OpenKit's user-facing work model.

This document owns how work appears to users and product surfaces.

This document does not own product-level mission, audience, marketing positioning, app endpoints, UI component structure, database tables, or agent-native protocols.

It explains how workspace, thread, turn, item, artifact, approval, agent visibility, chat, task work, workflow modes, human attention, steering, review, redo, refinement, handoff, and context compaction appear to users and product surfaces.

## Purpose

OpenKit is a workspace for delegating real work to agents.

Users should be able to ask quick questions, start work, watch progress, review deliverables, approve sensitive actions, steer active work, ask for refinement, redo failed or unsatisfactory work, hand work to another agent or mode, and preserve useful outputs and knowledge.

The work model uses the same backbone as the core protocol:

```text
Workspace -> Thread -> Turn -> Item[]
```

## Principles

- Product surfaces should make work understandable without requiring users to understand agent sessions, runtime handles, storage layout, or adapter internals.
- Product-facing terms such as task, job, goal, deliverable, review, redo, and refinement are projections unless a core aspect promotes a stable record.
- The thread narrative and item order remain the user-visible source of truth even when surfaces group, summarize, or highlight work.
- Human attention should stay visible, actionable, and traceable to item-backed history.
- Quick reply, task work, Goal Mode, Plan Mode, and Action Center should present the same Core backbone rather than separate product models.

## Workspace

`Workspace` is the top-level product environment.

It contains the user's work history, agent profiles, files, artifacts, knowledge, vault references, settings, audit records, and future collaboration membership.

A workspace is closer to a Slack workspace than to a folder. It may contain many threads, many agents, and many long-running tasks over time.

Product surfaces should make the current workspace explicit because it controls default knowledge, agent catalog, vault references, storage, permissions, sandbox defaults, and audit scope.

## Thread

`Thread` is the durable user-facing container for one stream of related work.

A thread can begin from:

- direct user input
- a planned instruction
- a cron job
- an automation
- a handoff
- a redo or refinement request
- imported context

A thread may involve one agent or many agents over time. It may include parallel work, handoff, implementation and review loops, human steering, and final deliverables.

Thread is the primary product object for resuming, reviewing, searching, and explaining a piece of work.

## Product Modes

Product surfaces may present several modes over the same Core work backbone.

Mode names are user-facing projections unless the relevant core aspect promotes them as stable workflow mechanisms.

`Chat Mode` or quick reply is the lightweight path for simple answers, clarification, and state lookup.

Chat Mode should feel immediate and should not imply that a worker agent has started.

When a request needs non-trivial work, product surfaces should make the transition from quick reply into task workflow visible enough that users understand that work is now being delegated, tracked, and reviewed.

`Task Mode` is the user-facing shape for delegated work that needs worker-agent execution, progress tracking, artifacts, evidence, or review.

`Goal Mode` is the current built-in objective-driven task mode for low-configuration, reviewable worker-agent work.

`Plan Mode` is a user-facing label for planning-heavy interaction, not a requirement that every workflow start with an explicit plan.

The core workflow owner for mechanisms such as planning, bounded steps, gates, decisions, evidence, and checkpoints is `agent-workflow.md`.

## Turn

`Turn` is one execution attempt or step inside a thread.

A turn is assigned to one agent session when it runs.

Users do not need to think in terms of agent sessions. Product surfaces may display a turn as "working", "reviewing", "waiting for approval", "failed", or "completed".

New user input starts a new turn when no turn is active. If a turn is active, follow-up user input belongs to that active turn by default and is applied when Core reaches a safe point.

## Item

`Item` is the visible unit of work history.

Items may represent user messages, assistant messages, status updates, reasoning summaries, tool summaries, command summaries, file changes, approval requests, approval decisions, handoffs, artifact events, and errors.

The item log is the source of truth for replaying what happened.

Product surfaces may group or summarize items, but they should preserve the underlying item order and lineage.

## Artifact

`Artifact` is a durable output the user can inspect, reuse, export, or reference later.

Examples:

- report
- diff
- generated file bundle
- design asset
- spreadsheet
- plan
- test result
- exported document

Artifacts are anchored in workspace, thread, turn, and item history. Product surfaces may show artifacts in sidebars, dashboards, galleries, or result lists, but artifact creation and updates remain item-backed.

## Approval

`ApprovalRequest` is a human decision point.

Approvals are used for sensitive or irreversible actions, permission escalation, credential use, destructive operations, external side effects, or user choices that must be made before work can continue.

Approvals should be visible in the item log, actionable in the UI, and auditable after the fact.

Agent questions and elicitations are a distinct human-decision primitive, separate from `ApprovalRequest`. The protocol carries them as user-input-request and user-input-response items backed by a dedicated user-input human gate, mirroring the two human-gate kinds (approval and user-input). Product surfaces should present an agent asking the user a question differently from an agent requesting approval to act, even though both pause the turn for a human decision.

## Human Attention And Action Center

Human attention is any visible point where work needs a user decision, answer, review, approval, recovery choice, or follow-up instruction.

Action Center is a product and App API projection that groups pending human attention across approvals, questions, blocked work, artifact reviews, goal or task reviews, budget choices, recovery choices, and follow-up decisions.

Action Center should help users find pending decisions, but it should not hide the thread narrative or replace item-backed history.

Core workflow mechanisms such as gates, decisions, evidence, and checkpoints are owned by `agent-workflow.md`; Action Center presentation and read-model details belong to App API and product surfaces.

## Agent Visibility

Product surfaces may show agent information to help users understand who or what is doing the work.

Useful agent visibility includes:

- selected agent
- agent display name
- agent session health
- current turn status
- readiness problems
- capability summary
- sandbox summary
- approval requirements

Product surfaces should not expose raw adapter internals, process handles, provider payloads, or hidden agent-private task graphs as normal user concepts.

## Steering

Steering is user input during active work.

Steering is not a separate core object. It is ordinary user input routed into the active turn unless Core or the agent adapter closes that turn first.

Product surfaces may label the interaction as steering, correction, follow-up, or refinement, but the protocol treats it as input associated with a turn.

Core owns safe-point routing. UI clients should submit the input and then render the resulting items and turn events.

## Review

Review is the process of evaluating work before accepting it.

Review may be done by the user, by another agent, or by both.

An implementation-and-review flow should be represented as normal turns in a thread. The reviewer can read prior items, artifacts, diffs, files, and test results, then emit review items or artifacts.

Review does not require a separate `TaskRun` model.

Product surfaces may show review as artifact review, goal review, task review, implementation review, or acceptance review.

Those labels should map back to visible items, artifacts, evidence, and decisions.

## Redo And Refinement

Redo and refinement are follow-up turns in the same thread unless the user intentionally starts a new thread.

Redo means the previous result should be replaced or attempted again.

Refinement means the previous result is accepted as context but needs changes.

Both should preserve history. Product surfaces can highlight the latest accepted deliverable without deleting earlier attempts.

## Handoff

Handoff is a visible transfer of work to another agent, profile, role, workflow mode, channel, or future workspace collaborator.

Users should be able to understand why a handoff happened, what context moved forward, what evidence or constraints were preserved, and who or what is now responsible for the next step.

Handoff should preserve thread history instead of creating an unexplained new work stream.

Runtime routing belongs to `runtime-model.md`; workflow handoff mechanics belong to `agent-workflow.md`.

## Context Compact

Context compact is a product-visible explanation that long or complex work has been summarized into a smaller working context for continuation, handoff, retry, recovery, or worker execution.

Users should not need to read every raw item to understand the compacted state, but the compact must remain traceable to the underlying thread history, artifacts, evidence, knowledge pages, sources, and decisions.

If compacted context becomes reusable workspace understanding, it should become a knowledge proposal or knowledge update under `knowledge.md`.

If compacted context preserves runtime continuity, it belongs to the agent-session boundary.

## Deliverables

`Deliverable` may be a product-facing read model.

It is not a separate required core object at this stage.

Most deliverables should be represented by artifacts plus item-backed status or summary items. If later product behavior needs a first-class deliverable record, it should still map to workspace, thread, turn, item, and artifact lineage.

## Task And Job Terms

Product surfaces may use words like task, job, goal, or deliverable when they improve user comprehension.

Those names are projections unless promoted by a future core document.

Core records remain workspace, thread, turn, item, artifact, approval request, agent, and agent session.

## Long-Running Work

Threads may remain active for a long time.

A long-running thread may include periodic turns, cron-triggered turns, background agent activity, review checkpoints, and final deliverables.

The product should make long-running state visible without requiring users to understand agent sessions, sandbox snapshots, or runtime handles.

## Invariants

- Product surfaces MUST NOT redefine workspace, thread, turn, item, artifact, approval request, agent, or agent session semantics.
- Chat Mode MUST NOT imply worker-agent execution when Core has stayed in lightweight quick reply.
- Task Mode and Goal Mode MUST map back to Core workflow, turn, item, artifact, approval, evidence, and review records.
- Action Center MUST remain a projection over pending human attention, not a replacement for item-backed history.
- Redo, refinement, review, handoff, and context compact MUST preserve traceability to prior thread history and artifacts.
