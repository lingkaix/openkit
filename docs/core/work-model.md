# Work Model

Status: Accepted

This document owns how OpenKit work appears to users and product surfaces.

It projects the canonical Core model without redefining root concepts, workflow mechanisms, protocol records, App API shapes, UI components, storage, runtime behavior, or agent-native protocols.

## Purpose

OpenKit is a workspace for delegating real work to agents.

Users should be able to ask quick questions, delegate bounded tasks or durable goals, watch progress, intervene through explicit human-attention modes, collaborate precisely against work resources, and preserve useful outputs and knowledge.

The work model uses the same backbone as the core protocol:

```text
Workspace -> Thread -> Turn -> Item[]
```

## Principles

- Delegation is the default posture, precise collaboration is available on demand, and governance remains visible throughout.
- Product surfaces should make work understandable without requiring users to understand agent sessions, runtime handles, storage layout, or adapter internals.
- Product-facing terms such as task, job, goal, deliverable, review, redo, and refinement must map to their owning durable records instead of creating parallel truth.
- The thread narrative and ordered Item history remain the user-visible source of truth even when surfaces group, summarize, or highlight work.
- Quick reply, delegated work, long-running goals, grounded collaboration, and human attention must preserve the same Core backbone.

## Product Projection

Core Concepts owns the canonical meanings of Workspace, Thread, Turn, Item, Artifact, ApprovalRequest, Channel, and TriggerSource. Product surfaces project them as follows:

- Workspace establishes the current work scope, defaults, authority, and visible resources.
- Thread is the durable narrative for resuming, reviewing, searching, and explaining related work.
- Turns make execution progress and boundaries understandable without exposing runtime internals.
- Items supply the ordered history from which visible messages, status, decisions, reviews, and outputs are projected.

A product projection may summarize or reorganize these records, but it must preserve their identity, order, lineage, and owning authority.

## Quick Chat Workspace

Quick Chat is each user's initial owner-only Workspace for lightweight conversation, ordinary Thread and Item history, and workspace Knowledge.

Quick Chat is a real Workspace, but it is not a project Workspace. It must not silently expose repository or workspace-data-source binding, Task Mode, Goal Mode, worker execution, or Git write behavior.

When work needs a project boundary, the product must ask the user to create or select an eligible Workspace instead of using Quick Chat as a hidden bridge.

Exact workspace kinds, seed behavior, route guards, record fields, error codes, and client selection mechanics belong to implementation-facing contracts.

## Product Modes

Product modes are user-facing projections over the same Core work backbone.

| Mode | Stable product boundary |
| --- | --- |
| Chat Mode | Immediate answers, clarification, and lightweight state lookup inside Core. It does not start worker execution unless an explicit visible handoff enters another mode. |
| Task Mode | Bounded, near-term delegated work with worker execution when needed. It does not require plan negotiation by default and escalates when work becomes multi-step, ambiguous, high-risk, multi-agent, or long-running. |
| Goal Mode | Durable objective-driven work for long-running, ambiguous, high-risk, multi-step, or multi-agent outcomes. It advances through visible planning when needed, bounded steps, evidence, human attention, review, and explicit stop decisions rather than an invisible autonomous loop. |
| Plan Mode | A product label for planning-heavy interaction. It does not require every workflow to begin with a plan or create a separate runtime. |

Transitions between modes must remain visible in Thread history. Workflow mechanisms such as plans, bounded steps, gates, decisions, evidence, and checkpoints belong to the workflow owner.

## Human Attention

Human attention is any state the product should surface because human authorization, information, correction, review, or awareness is useful.

OpenKit uses four composable product modes for human attention:

| Mode | Stable product meaning |
| --- | --- |
| Approval Gate | A blocking authorization decision for safety, policy, budget, credential use, irreversible operations, or external side effects. |
| Elicitation Gate | A blocking answer to a question, missing input, planning choice, or recovery choice. It is not authorization. |
| Steering Input | Non-terminal user input that corrects or extends active work and is delivered through the owning safe-point, interruption, queue, or follow-up behavior. |
| Review And Acceptance | Human or agent evaluation of plans, artifacts, diffs, knowledge proposals, evidence, or outcomes that may lead to acceptance, refinement, redo, rejection, deferral, escalation, or stop. |

Only Approval Gate and Elicitation Gate are blocking human gates. The four modes may compose without becoming four new Core objects or a parallel workflow engine.

Action Center is a product and App API projection over pending human attention across these modes. It helps users find required attention but must not replace Thread narrative, Item history, or the owning decision records.

Concrete gate fields, Item types, delivery policies, row kinds, actions, and API shapes belong to implementation-facing contracts.

## Conversation And Grounded Collaboration

Conversation is the narrative and coordination layer. When a product surface knows the exact resource, revision or freshness point, location, candidate, or bounded value under discussion, it should preserve that grounding instead of forcing the user or agent to reconstruct it from prose.

Grounded interaction must flow through ordinary input, Steering Input, Review And Acceptance, Elicitation Gate, or Approval Gate. It must not create a global strong-interaction mode, universal Resource entity, universal Artifact model, or hidden feedback log.

Product terms such as compare, select, annotate, adjust, patch, accept, reject, and redo describe intent. Exact resource planes, payload envelopes, locators, revision handling, delivery receipts, conflict checks, and editor controls belong to implementation-facing contracts.

## Artifacts And Deliverables

Product surfaces present an Artifact as a durable user-visible output that can be inspected, reused, exported, or referenced later. Artifact is an output role, not the universal identity for every editable material, source, external record, or piece of feedback.

When work creates or changes an Artifact, that mutation must be represented in ordered Item history and remain traceable to its Workspace, Thread, Turn, and Item lineage. Artifact indexes, read models, and byte stores must not become a competing work log.

A Workspace-only Artifact import or registration may omit an originating Thread and Turn only when it preserves explicit source and provenance. It must remain visibly imported or registered, must not masquerade as user or agent work output, and any later work-produced mutation must become Item-backed.

Deliverable, task, job, and goal are product-facing terms. A Deliverable normally projects one or more Artifacts plus Item-backed status or summary, and none of these labels creates parallel durable truth.

## Active Work Semantics

| Product term | Stable product meaning |
| --- | --- |
| Steering | User direction during active work. The product must show whether it was applied, queued, interrupted current work, or became follow-up work. |
| Review | Evaluation by a user, another agent, or both. Review remains visible through normal Thread history, evidence, decisions, and outputs. |
| Redo | A replacement attempt that preserves the prior result and its history. |
| Refinement | A follow-up that keeps the prior result as context while requesting changes. |
| Handoff | A visible transfer of responsibility that explains why it happened, what context and constraints moved, and who or what acts next. |
| Context compact | A traceable summary used for continuation, handoff, retry, recovery, or worker execution without replacing its source history. |

Reusable understanding produced by context compaction belongs to Knowledge. Runtime continuity produced by compaction belongs to the agent-session owner.

## Agent Visibility

Product surfaces may show the selected agent, current work status, readiness, effective capability and sandbox summaries, and agent-session health when those details help users understand responsibility or risk.

They must not expose raw adapter internals, process handles, provider payloads, secret-bearing diagnostics, or hidden agent-private task graphs as normal user concepts.

## Long-Running Work

Long-running work must keep progress, pending attention, evidence, review state, and stop conditions visible without requiring users to understand runtime handles or backend snapshots.

Persistence and resumption must use owning durable records rather than hidden coordinator conversation memory or agent-private state.

## Invariants

- Product projections MUST preserve canonical identity, order, lineage, and owning authority; they MUST NOT independently accept, apply, recover, or terminalize work.
- Quick Chat MUST remain an owner-only lightweight Workspace and MUST NOT silently become a project or worker-execution boundary.
- Chat Mode MUST NOT hide worker execution; entry into Task Mode or Goal Mode MUST be explicit in Thread history.
- Task Mode MUST remain bounded delegated work, while Goal Mode MUST remain durable governed objective work.
- Human attention MUST use the four composable product modes without turning Action Center into a new authority.
- Grounded collaboration MUST preserve exact subject and version context through owning records without creating a hidden feedback log.
- Work-produced Artifact mutations MUST remain Item-backed. A Workspace-only import or registration MAY omit Thread and Turn lineage only with explicit provenance; its first introduction into a Thread and every later work-produced mutation MUST create exact Item-backed lineage.
- Redo and refinement MUST create new traceable work without mutating or deleting prior attempts; refinement MUST explicitly carry the selected prior result as context.
- Accepted Steering Input MUST have one current owning delivery path and an authoritative outcome. If immediate receipt or durable later delivery cannot be proven, the input MUST NOT be accepted as Steering Input or represented as delivered.
- Concurrent and replayed commands MUST remain bound to their originally accepted Workspace, Thread, subject, and work lineage; a newer current projection MUST NOT retarget them or create duplicate Turns, Items, decisions, or side effects.
- After acceptance, failure or restart MUST leave work either durably pending and recoverable or explicitly terminal under its owning records; accepted input, decisions, lineage, and prior attempts MUST NOT be silently dropped, duplicated, or reconstructed from runtime memory or a latest-current projection.
- A failed mutation MUST NOT leave partially applied or contradictory durable truth visible as authoritative.
- Review, handoff, and context compact MUST preserve traceability to prior Thread history and Artifacts.
