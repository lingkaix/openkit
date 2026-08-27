---
status: Accepted
implementation: Partial
---
# Human Attention And Intervention Model

## Owns

This spec owns the implementation-facing model for human attention in OpenKit workflows, including approval gates, elicitation gates, exact Goal-bound steering input, review and acceptance, Action Center projections, artifact review, recovery choices, budget choices, and S16-authorized pending-input decisions.

## Does Not Own

This spec does not own the stable core definitions for work, protocol records, communication routing, worker runtime execution, policy enforcement, vault secret handling, UI component layout, or database schemas.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

## Summary

OpenKit needs a clear human-in-the-loop model that covers more than approval prompts.

The product should treat human involvement as `human attention` first, then route each concrete interaction through the smallest stable primitive that fits: approval gates, elicitation gates, steering input, or review and acceptance.

The core protocol should stay small.

It should keep `awaiting_human` as the single blocking human turn state, keep `humanGate.kind` as the branch point for blocking gates, keep steering as ordinary user input accepted only where an exact delivery owner exists, and keep review, redo, and refinement attached to their exact owning records and ordinary Turns.

The app layer may expose a richer Action Center that combines pending approvals, questions, blocked work, accepted Goal pending input, artifact reviews, authorized budget decisions, recovery choices, and authorized follow-up conversions into one product surface.

Those Action Center rows are projections over existing protocol records, app-local runtime records, and future review or checkpoint records.

## Current Implementation Projection

The V1 NanoCore implementation exposes the main app-local surfaces through unified Action Center rows, version-owned Artifact Reviews, durable Goal Review records, pending Workspace Sync Reviews, knowledge proposal projections, and interrupted-worker recovery choices through product-facing read models. Interrupted-worker rows derive from the exact terminal scheduler, Turn, AgentSession, backend-cleanup, capacity-release, checkpoint, and mode-owner predicate; only eligible rows expose retry, while contradictory Goal lineage exposes inspection and guidance without an executable action. A version-owned Artifact Review is the decision owner for an ordinary exact Artifact version, while a durable Workspace Sync Review owns only its staged workspace changes and passes exactly `accepted`, `needs_refinement`, `rejected`, or `blocked`. Action Center keeps the generic Artifact Review projection inspect-only until the Stage 5 client dispatcher lands; direct decisions already use only the versioned owner route. An exact Artifact related to both owner families remains one inspect-only `recovery_required` risk row, and both direct decision routes fail closed. The generic unversioned Artifact Review route and generic Core Artifact metadata mutation route remain absent.

The current Goal Review path exposes one unresolved evidence row with explicit `accept`, `refine`, `retry`, and `abort` decisions and no verdict in its projection. Applying one decision resolves the Review, updates the addressed Goal Task, unlocks dependency-satisfied Tasks when applicable, and always leaves `currentTaskId=null` in one Workspace transaction; when every Task is complete, that same transaction terminalizes the Goal. Immutable `GoalTask.reviewPolicy` is now the sole review decision: `required=true` creates exactly one unresolved Goal Review, `required=false` takes the same closeout path without a Review, and Goal step requests reject caller-selected overrides.

The core protocol still stays small. `awaiting_human`, approval gates, elicitation gates, ordinary steering input, and review turns remain the stable mapping. Action Center rows remain App API projections until dogfooding proves which fields should become long-term contracts.

Current implementation gaps include budget decisions, vault grants, adapter-native checkpoint resume, the Stage 5 Artifact Review client dispatcher, and broader cross-channel review semantics.

## Goals / Non-goals

Goals:

- Define the common human attention and intervention modes for OpenKit.
- Preserve the `Workspace -> Thread -> Turn -> Item[]` backbone.
- Keep `ApprovalRequest` focused on permission, safety, budget, credential, irreversible, and external side-effect decisions.
- Keep agent questions, Plan Mode questions, and elicitation flows separate from approvals.
- Keep steering as user input during active work, not as a separate core object.
- Define the one accepted Goal safe-point steering path, its delivery proof, its terminal-Goal follow-up conversion and cancellation, and fail-closed rejection for every other busy input.
- Define how artifact review, result acceptance, redo, and refinement map to existing product concepts without authorizing a generic reviewer loop.
- List typical product scenarios so implementation work can test against realistic user flows.
- Establish which concepts belong in core protocol, which belong in NanoCore app-local runtime state, and which belong in Web read models.

Non-goals:

- Do not introduce `HumanAttention`, `TaskRun`, `AgentRun`, or a new execution graph as stable core objects.
- Do not add a new turn status such as `awaiting_approval`, `awaiting_question`, `needs_review`, or `blocked_by_review`.
- Do not make UI clients implement queueing, safe-point selection, retry promotion, or active-turn routing.
- Do not require every non-blocking user message to pause the worker.
- Do not promote the app-local Action Center, review flow, queue storage, or sustained-mode loop into stable core protocol objects.
- Do not promote app-local worker envelope state into `packages/protocol` until dogfooding proves the stable shape.

## Background

The current core model already has the right foundation.

`docs/core/work-model.md` defines steering as user input during active work, not a separate core object.

`docs/core/communication.md` says there is no separate Core concept for steer messages and that clients never own routing, pending delivery, retry promotion, or safe-point rules. Core applies those mechanics only where an owning specification authorizes them.

`docs/core/protocol.md` defines approval and user-input gates as item-backed pauses that share the `awaiting_human` turn state and branch by `humanGate.kind`.

`docs/specs/superseded/human-attention/20260515-codex_user_input_bridge.md` records the original separate `user-input-request` and `user-input-response` item types for Codex app-server questions.

`docs/specs/20260531-worker_turn_reliability_envelope.md` records the existing worker checkpoint and stop primitives and identifies its generic user or runtime follow-up queues as implementation divergence; S16 exclusively owns accepted Goal pending input and delivery proof.

The missing product layer is a unified vocabulary for when and why a human should intervene.

Without that vocabulary, approval, question, steer, queue, review, blocked, retry, and budget decisions can become overlapping UI concepts even when the core protocol is clean.

## Decision

`docs/core/work-model.md` owns the four human-attention modes and their stable product meanings. This specification maps those modes to concrete protocol, persistence, Action Center, delivery, and recovery behavior.

For example, an existing Goal or checkpoint owner may produce an elicitation gate for a missing choice; a selected path may require an approval gate for additional cost or side effects; a later Goal step may then produce an Artifact Review through its existing owner.

Composition is expected.

The four modes are product semantics, not four new core protocol objects.

Core protocol keeps these stable rules:

- Blocking human pauses use `Turn.status: "awaiting_human"`.
- Blocking approval pauses use `humanGate.kind: "approval"` and an `approval-request` item.
- Blocking elicitation pauses use `humanGate.kind: "user-input"` and a `user-input-request` item.
- Active-turn steering is submitted as ordinary input and recorded as normal user-message or equivalent item history.
- Review, redo, and refinement use the exact Review owner and create ordinary traceable Turns where its specification authorizes follow-up work; this rule does not authorize a generic review loop.
- The S16 Goal delivery owner decides safe-point application; UI clients and adapters submit or transport intent and render authoritative Items and Turn events without inventing delivery state.

The app layer may expose an `Action Center` read model that groups pending human attention across those modes.

## Terminology

`Human attention` is any state where the product should surface work to the user because a human decision, review, correction, or awareness is useful.

`Human intervention` is human attention that changes execution by approving, denying, answering, steering, accepting, rejecting, retrying, or changing direction.

`Human gate` is a blocking pause in a turn.

Only approval gates and elicitation gates are human gates in the current core protocol.

`Delivery policy` is the authoritative outcome for steering input accepted through an owning delivery contract. V1 accepts only the Goal-owned safe-point path defined by S16; other delivery ideas are not implementation authority.

`Escalation trigger` is a runtime, review, budget, policy, or quality condition that asks for human attention.

It is not a new protocol object by itself.

`Action Center` is a Web and App API projection that lists pending human attention across approvals, questions, blocked turns, artifact reviews, budget choices, recovery choices, and follow-up decisions.

## Design Principles

### Keep Core Small

Human-in-the-loop should not create a parallel workflow engine.

The core records remain workspace, thread, turn, item, artifact, approval request, and AgentSession.

App-local runtime envelopes may hold richer state while the product is still learning which fields are durable.

### Separate Meaning From Delivery

A user message can mean correction, added context, pause, budget concern, review verdict, or acceptance.

That meaning is separate from whether the message is applied immediately, queued to a safe point, converted into a follow-up turn, or used to resolve a blocking question.

UI should capture the user's intent when useful, but Core owns delivery.

### Prefer Elicitation Over Approval For Choices

Approval means authorize or deny.

Questions such as "which branch should I use?", "should I keep trying?", "which artifact should be accepted?", or "which reviewer should inspect this?" are elicitations, not approvals.

This distinction keeps audit semantics clean and avoids approval fatigue.

### Make Review Ownership Visible

The user should see the reviewed output, exact owning Review record, decision, reason, evidence, and resulting Turn lineage. Human Attention does not define reviewer iteration, caps, or continuation policy.

### Allow Composed Human Flows

Many real interactions combine modes.

A review failure can produce an elicitation.

An elicitation answer can produce steering.

A budget extension can require approval.

An approval decision can authorize the owning workflow to continue; it does not by itself authorize adapter-native AgentSession resume.

The model should support these compositions without adding one-off concepts for each scenario.

## Approval Gate Mapping

### Typical Triggers

- Permission escalation.
- Destructive filesystem actions.
- Irreversible storage operations.
- Credential or vault reference use.
- External side effects such as sending email, creating tickets, posting messages, spending credits, publishing content, or pushing to a remote.
- Budget extension beyond configured limits.
- Network access outside policy.
- Running a command outside the allowed sandbox.
- Accepting a risk that policy marked as requiring human authorization.

### Protocol Mapping

The turn emits an `approval-request` item and transitions to `awaiting_human`.

The turn carries `humanGate.kind: "approval"`.

The user responds through the approval response command.

Core records an `approval-decision` item.

The owning workflow then follows its documented continuation, failure, cancellation, or recovery predicate. In Goal worker V1, a gate response closes the waiting envelope and any further work uses a new step request and Turn; the approval record alone never resumes an AgentSession.

### Product Requirements

The UI should present approval as a clear authorization decision, not as a general question.

The approval copy should explain what action is being authorized, which agent or session requested it, which workspace or resource is affected, why policy requires approval, and what happens if the user denies it.

Approval cards should support grant and deny first.

Additional choices such as grant once, grant for this turn, grant for this workspace policy, or deny and explain can be added later only when backed by explicit policy semantics.

## Elicitation Gate Mapping

### Typical Triggers

- The planner needs the user to choose among viable approaches.
- The worker lacks required business context.
- The task has ambiguous scope or conflicting goals.
- The active turn is paused because the runtime cannot continue without a user answer.
- A checkpoint recovery path needs the user to inspect, use the request-bound retry-after-interruption command, review partial Artifacts, or request guidance.
- A provider, agent, or config problem needs the user to choose a fallback.
- An automation produced a draft that needs a human choice before follow-up.
- A knowledge proposal needs accept, reject, or defer; changed candidate bytes require a new proposal.

### Protocol Mapping

The turn emits a `user-input-request` item and transitions to `awaiting_human`.

The turn carries `humanGate.kind: "user-input"`.

The user responds through ordinary turn input scoped to the paused turn.

Core records a `user-input-response` item.

The owning workflow then follows its documented transition. A non-worker flow may continue the same Turn when its contract permits; a worker `ask_user` response remains attached to that Turn but resumes it only to close the waiting envelope under S05. Task Mode requires a new `task.start` for further execution, while Goal Mode returns the Goal Task to `ready` and requires a new `goal.step`; neither implies AgentSession resume.

### Plan Mode

Plan Mode should use elicitation gates when the agent needs structured user input.

The agent should emit bounded question schema rather than arbitrary UI.

The current question shape supports `id`, `header`, `question`, `options`, `isOther`, and `isSecret`.

No additional response mode, recommendation, default, validation, file-selection, or multi-select field is authorized by this specification. A demonstrated product need requires an accepted schema update with ownership, persistence, replay, redaction, and client fallback rules before implementation.

The key rule is that the model proposes structured choices, while the app renders known controls.

This is generative UI only in the bounded sense.

### Product Requirements

Question UI may show a recommended option only after an accepted question-schema contract carries it; the current shape does not.

Question UI should support free-form `Other` without losing the original options.

Secret answers must not be written to prompts, Knowledge Store records, normal item payloads, or diagnostics unless a future secret-answer protocol explicitly defines a safe vault path.

Until that safe path exists, a gate containing any `isSecret=true` question is visible but not answerable through ordinary turn input; submission returns `400 secret_input_not_supported` before a response Item or command write.

Question responses use an exact structured map rather than flattened text: `answers` is `{ [questionId]: [string] }`, and the one array member is non-empty. V1 has no multi-select question mode, so zero or multiple values are `400 invalid_request`. A request producer MUST reject duplicate question ids as `400 invalid_request` before creating the request Item. The answer keys MUST equal every and only question id in the referenced completed request Item; missing or extra answer keys are `400 invalid_request`. If an already durable request Item contains duplicate ids or contradicts the Turn gate, response submission returns `409 recovery_required` rather than blaming caller input. The same Turn's `humanGate` and the absence of a response Item own waiting state; the request Item itself is completed once its immutable payload is durable. Every failure occurs before business mutation.

## Steering Input Mapping

### Typical Triggers

- The user notices the agent is going in the wrong direction.
- The user adds a missing constraint.
- The user changes priority.
- The user asks the agent to stop expanding scope.
- The user asks the agent to wrap up before budget exhaustion.
- The user provides new evidence while the worker is running.
- The user asks to switch focus after seeing partial progress.
- The user asks to pause after the current safe point.
- The user requests a handoff to a different agent or profile.

### Protocol Mapping

Steering uses ordinary user Items and the existing Goal pending owner; there is no `steer` Core object.

If the active turn is paused on `humanGate.kind: "user-input"`, the input answers the elicitation gate.

If the active turn is paused on `humanGate.kind: "approval"`, the approval response command must be used instead.

Otherwise, input may be accepted only when an exact active Goal and worker Turn have the durable later-delivery owner required by S16. Admission is serialized by S16's single Thread-level pending-row constraint: exactly one competing transaction may create the input Item plus `PendingUserTurnRecord`, and every loser returns `conflict` without a second row or ordering claim. The accepted input remains `queued` until a matching immutable Context Package trace proves application.

Any other input submitted while a Thread has a non-terminal Turn returns `409 thread_busy` before Item, pending-row, or command writes. A delivery-unavailable Goal path returns its typed S16 error before writes.

### Delivery Policies

V1 has one accepted active-Turn policy: `safe_point_steering` under the exact Goal, Turn, Item, pending-row, and Context Package lineage in S16. After the original Goal becomes terminal, the same pending owner may be converted to a causally linked completed Core-local history Turn or cancelled through S16's exact terminal command records; neither path creates or executes an implicit worker Turn or S39 trace.

Generic `interrupt_then_apply`, `after_current_turn`, and automatic `follow_up_turn` policies are not authorized. A UI MUST NOT expose them as available delivery choices until an accepted specification names their owner, durable proof, failure behavior, restart behavior, and replay predicate.

### Runtime Constraints And Follow-up Input

A budget wrap-up, recovery constraint, or similar Core-generated instruction is request-scoped input supplied by the owning mode service to its next Coordinator decision. It has no queue or durable steering record. If the constraint must survive restart, the mode service recomputes it from the existing budget, checkpoint, lease, or recovery owner that made it necessary; it MUST NOT reconstruct it from process memory or add a system-steering queue.

V1 has no generic user follow-up queue. Accepted Goal input is owned only by the input Item plus `PendingUserTurnRecord`; follow-up conversion creates a real causally linked Turn before removing that row.

### Product Requirements

The UI should make accepted Goal pending steering visible and should not render rejected busy input as pending.

The user should be able to tell whether their message was applied, queued, converted into a follow-up turn, or blocked by a human gate.

The item log should remain coherent.

When input is proven applied inside the same Goal worker Turn, the exact immutable Context Package trace is the authority; UI message ordering is only a projection.

## Review And Acceptance Mapping

### Typical Triggers

- A worker produces an artifact.
- A reviewer agent emits a verdict.
- A plan is ready for user acceptance before execution.
- A diff or file bundle needs inspection.
- A generated report needs export or reuse.
- A knowledge proposal needs human review.
- A task result is complete but may need refinement.
- A failed result needs redo.
- A long-running loop hits a quality cap.

### Protocol Mapping

Review is represented as normal items and turns in a thread.

Artifacts are anchored by `artifact-reference` items and materialized artifact records.

Agent review should produce review items, status items, artifacts, or structured app-local review records that point back to items and artifacts.

An ordinary review comment may be submitted as follow-up user input, but it is not a decision. Every decision that changes acceptance, refinement, redo, retry, rejection, deferral, or Goal progression MUST claim and update the exact existing Artifact Review, Workspace Review, Knowledge Proposal, or Goal Review owner before creating downstream work. A comment, Thread Item, Action Center action, or UI selection MUST NOT bypass that owner or synthesize a generic verdict.

### Review Decision Ownership

Decision values are local to their owning record rather than members of one reusable verdict enum. S16's version-owned Artifact Review owns ordinary Artifact acceptance and its `needs_refinement` or `redo` follow-up reservation; S49 Workspace Sync Review owns exactly `accepted`, `needs_refinement`, `rejected`, or `blocked`; Knowledge Proposal owns exactly `accepted`, `rejected`, or `deferred`; Goal Review owns exactly `accept`, `refine`, `retry`, or `abort`. Each owner preserves the evaluated version, evidence, request identity, reason or instruction, and resulting lineage required by its specification. Adding or translating a decision requires changing that owner contract first; Action Center remains a projection.

For a Workspace Sync Review, `WorkspaceSyncReviewItem.artifactId` is the immutable relationship to its backing Artifact presentation and evidence snapshot. That Artifact is not a generic Artifact Review owner, and its availability or immutable snapshot status cannot replace the durable Workspace Sync Review. Action Center and routes MUST classify the relationship from the stored Workspace Sync Review lineage, never an Artifact id prefix or a verdict inferred from parsed Artifact content.

A `workspace_review` action MUST submit `accepted`, `needs_refinement`, `rejected`, or `blocked` directly to the S49 workspace-sync review decision route. It MUST NOT submit `accept`, `reject`, `defer`, `deferred`, or `redo`, use the generic Artifact Review route, or translate between the two vocabularies. Only `accepted` may authorize S49 apply; the other three values record no workspace mutation.

S16 now owns Material proposal and writeback vocabulary on one exact version-owned Artifact Review. An accepted non-null proposal applies through the existing Material owners and one Workspace SQLite transaction, while refinement and redo reserve the exact follow-up Turn; Workspace Sync Review defines no alias, apply semantics, verdict translation, or fallback for that path.

An unresolved Goal Review row carries no verdict in its Action Center source. It exposes the existing `accept_review`, `request_refinement`, `retry_work`, and `abort` action kinds against the same decision route; clients map those kinds to `accept`, `refine`, `retry`, and `abort` and submit the canonical Goal Review request. Refinement requires a non-empty revision instruction, retry and abort require a non-empty reason, and cancelling or failing to collect that text leaves the Review unresolved. A presentation that cannot collect required input must disable that action with a reason instead of synthesizing a decision or storing a verdict in the projection.

### Product Requirements

Artifact review should support inspect, accept, request refinement, redo, export, reuse, and preserve.

The UI should not delete earlier attempts when a redo or refinement happens.

The latest accepted artifact may be highlighted as the current deliverable.

Review decisions should be item-backed or item-linked so future replay explains why the next turn happened.

## Escalation Triggers

Escalation triggers create human attention from runtime, quality, budget, policy, or product conditions.

They do not define new core protocol objects.

They route into one or more of the four interaction modes.

### Budget Threshold Or Exhaustion

When a Thread or Turn approaches budget limits, the owning mode recomputes one request-scoped budget constraint from the existing budget and checkpoint owners and supplies it to its next Coordinator decision. It does not create a system-steering queue or inject input behind the mode owner.

If the budget is exhausted and no new substantive work should start, the system should surface an elicitation gate or approval gate depending on policy.

The row may offer only choices backed by an existing owner command, such as wrap up, request a larger budget, choose a permitted model, narrow scope, or pause a Goal at a safe boundary. It MUST NOT invent a generic abort or budget-override command.

### Blocked Worker

A worker may become blocked because of missing context, failing tests, unavailable dependencies, unsupported runtime capability, or repeated tool failure.

The system should prefer elicitation if a human choice can unblock the work.

It should prefer review if partial outputs need inspection.

It should prefer approval only if continuing requires a sensitive action.

### Runtime Checkpoint Recovery

After restart or crash, Core may know that a turn stopped at a checkpoint.

The Action Center shows an interrupted-worker recovery row only after the exact Turn, scheduler lease, backend cleanup, worker-control revocation, and capacity-release predicate in `docs/specs/20260531-worker_turn_reliability_envelope.md` is complete. A checkpoint alone, a live worker, `awaiting-reconnect`, or cleanup-owned `needs-evidence` state produces no interrupted-worker row.

The row may expose only actions already authorized by the checkpoint and mode owners. Adapter resume requires a replay-safe resume contract; `worker.recovery.retry` appears only when its stricter Goal-or-Task continuation predicate also holds, closes the authoritatively interrupted checkpoint without rewriting the old Turn, and releases its Goal Task when applicable, while a later Task or Goal command owns replacement execution. A row whose interruption authority is complete but Goal lineage is contradictory remains inspection and guidance only. Pending-input conversion is available only after the exact S16 Goal becomes terminal; otherwise the row is inspect, review partial Artifacts, request guidance, or a terminal action only where an owning command exists.

This is primarily an elicitation gate or Action Center recovery action.

### Pending User Input While Busy

NanoCore may accept input as pending while a Thread is busy only for the exact active Goal path whose durable later-delivery owner satisfies `docs/specs/20260713-work_resource_interaction_model.md`. That path preserves the input Item plus `PendingUserTurnRecord` under the original Goal and Turn until delivery, follow-up conversion, or cancellation is proven.

The generic direct-Turn path has no later-delivery owner and must return `409 thread_busy` before writing an Item, pending row, or accepted command. It must not present the rejected input as queued or recoverable.

The Action Center or Thread UI may show only accepted Goal pending input and the exact actions authorized by its owning delivery contract.

This belongs to the exact S16 steering owner and its terminal-Goal follow-up conversion, not a generic follow-up queue.

### Agent Readiness Or Config Failure

If the selected agent is missing, degraded, blocked, stale, or misconfigured, the system should surface an elicitation gate or Action Center row.

User choices may include refresh readiness, switch agent, reload config, fix settings, retry later, or use an available lightweight Core-only path.

### Knowledge Proposal

A completed task does not trigger an implicit Knowledge Manager hook. Reusable knowledge enters review only through an explicit governed proposal command with source references and the existing Knowledge Proposal owner.

Knowledge proposals should be reviewable, source-traceable, rejectable, and deferable; changed candidate bytes require a new proposal.

This is review and acceptance, not approval, unless storing the knowledge affects a sensitive policy boundary.

### External Side Effect

When an agent wants to send, publish, push, create remote issues, update CRM records, or call an external service with lasting effects, approval is usually required.

If the user must choose content or recipients, an elicitation gate may happen before approval.

### Ambiguous Product Direction

When the system detects multiple plausible task directions, it should ask a bounded question rather than guessing.

This is an elicitation gate.

If the user sends a correction unprompted while work is active, it is steering.

## Scenario Catalog

The following scenarios should guide implementation, tests, and product review.

| Scenario | Trigger | Primary mode | Secondary mode | Expected handling |
| --- | --- | --- | --- | --- |
| Approve shell command outside policy | Worker requests command escalation | Approval Gate | None | Create approval request, pause turn, resume or fail after decision. |
| Confirm destructive file deletion | Worker plans irreversible delete | Approval Gate | Review And Acceptance | Show affected paths and reason, deny should stop or reroute safely. |
| Use vault-backed credential | Agent needs a secret reference | Approval Gate | Elicitation Gate | Ask only if policy requires approval, never expose secret value. |
| Plan Mode asks for implementation strategy | Planner has multiple viable paths | Elicitation Gate | Review And Acceptance | Render the accepted bounded choices and allow user override, without an unowned recommendation field. |
| Agent asks which branch to target | Worker lacks required context | Elicitation Gate | None | Record the answer on the paused Turn; a Goal worker closes that envelope and continues only through a new step request and Turn carrying the answer lineage. |
| User notices wrong direction during an active Goal worker Turn with a proven later-delivery owner | User sends correction | Steering Input | None | Preserve the exact Goal and Turn lineage, accept as queued, and claim application only from the durable Context Package trace. Otherwise return `thread_busy` or the typed delivery-unavailable error before writes. |
| User wants immediate correction | User requests interrupt and correct | Steering Input | Elicitation Gate | V1 does not accept interrupt-then-apply; keep any already accepted Goal pending input unchanged and offer only the S16-authorized delivery, follow-up conversion, or cancellation path. |
| User adds extra requirements while an eligible Goal worker Turn is busy | New input arrives | Steering Input | None | Preserve the input Item plus pending row only when the Goal delivery owner is available; generic busy input returns `thread_busy` before writes. |
| Artifact is ready for inspection | Worker emits artifact | Review And Acceptance | Steering Input | Let user accept, refine, redo, export, reuse, or comment. |
| User requests refinement | Artifact is close but incomplete | Review And Acceptance | Steering Input | Start follow-up turn in same thread with accepted context. |
| User requests redo | Attempt is unsatisfactory | Review And Acceptance | Steering Input | Start new attempt in same thread without deleting prior attempt. |
| Budget nearing limit | Usage crosses configured watermark | Steering Input | Elicitation Gate | The owning mode supplies a request-scoped budget constraint to its next Coordinator decision and optionally asks the user for scope or budget choice; no queue record is created. |
| Budget exhausted | No more substantive work allowed | Elicitation Gate | Approval Gate if extension spends quota | Ask the user to wrap up, request an authorized extension, narrow scope, choose a permitted downgrade, or pause where the owning mode supports it. |
| Runtime crashes with checkpoint | Active Turn loses AgentSession continuity | Elicitation Gate | Review And Acceptance | Show product-safe recovery choices and partial Artifacts without exposing AgentSession identity or actions. |
| Accepted Goal pending input survives crash | Goal recovers from input Item plus pending row | Steering Input | Elicitation Gate | Show the original Goal and Turn lineage and only the delivery, follow-up conversion, or cancellation actions authorized by S16. |
| Agent configuration becomes incompatible | A later Turn cannot reuse the current AgentSession | Elicitation Gate | Steering Input | Explain product-safe availability and offer only an authorized Turn retry, a new Thread, or an available Agent choice; AgentSession retirement and replacement remain internal. |
| Agent readiness blocked | Agent cannot start | Elicitation Gate | None | Offer switch agent, refresh, fix config, or retry later. |
| Knowledge proposal after task | User or owning service submits an explicit governed proposal command with source references | Review And Acceptance | Elicitation Gate | Let user accept, reject, or defer; changed candidate bytes require a new proposal. |
| External publish action | Agent wants to publish or send output | Approval Gate | Review And Acceptance | User reviews content, then explicitly approves side effect. |
| Automation draft needs confirmation | Scheduled job prepared a follow-up | Review And Acceptance | Approval Gate if external effect | User accepts, edits, rejects, or approves send. |
| Conflicting user instructions | New steering conflicts with prior goal | Elicitation Gate | Steering Input | Ask user to choose which instruction wins. |
| Human accepts known risk | Reviewer flags issue but user wants continue | Approval Gate if policy-sensitive | Review And Acceptance | Record decision and rationale, continue only within policy. |
| User pauses long-running work | User asks to pause after safe point | Steering Input | Elicitation Gate for resume choice | Accept only through the exact Goal safe-point owner; otherwise reject before writes and require an explicit Goal pause command at an allowed boundary. |
| User asks for handoff | User wants different agent or profile | Steering Input | Elicitation Gate if target unclear | Accept only through the exact Goal safe-point owner; worker replacement or handoff remains unavailable until its separately owned command contract is satisfied. |

## Action Center Projection

The Action Center should be a unified attention list.

It should not collapse every row into approval semantics.

Candidate row kinds:

```ts
type HumanAttentionKind =
  | 'approval'
  | 'question'
  | 'artifact_review'
  | 'workspace_review'
  | 'blocked_turn'
  | 'review_cap'
  | 'budget'
  | 'checkpoint_recovery'
  | 'pending_input'
  | 'agent_readiness'
  | 'knowledge_review'
  | 'external_side_effect';
```

The explicit V1 self-improvement loop reuses `knowledge_review` for its existing pending Knowledge Proposal. It does not add an `improvement_proposal` attention kind, Harness evidence prerequisite, or parallel approval lifecycle. Proposal reversal remains an owner-local Knowledge operation rather than an Action Center decision kind.

Candidate row fields:

```ts
interface HumanAttentionRow {
  id: string;
  kind: HumanAttentionKind;
  workspaceId: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  artifactId?: string;
  goalId?: string;
  taskId?: string;
  title: string;
  summary: string;
  severity: 'info' | 'needs_input' | 'blocked' | 'risk';
  createdAt: string;
  recommendedAction?: string;
  source: HumanAttentionSource;
  actions: HumanAttentionAction[];
}
```

This should begin as `@openkit/app-api-schemas` and NanoCore read-model work.

Only rows backed by stable product concepts should expose their product-visible Core IDs. AgentSession identity is excluded from this ordinary App API projection.

An approval row is actionable only when the referenced Turn is `awaiting_human`, its approval gate names the exact request Item and Approval record, that Item is a completed `approval-request`, and the Approval remains `pending`. A question row is actionable only when the referenced Turn is `awaiting_human`, its user-input gate names the exact completed request Item and request id, that Item has unique question ids and no secret question, and no matching response Item exists. A valid secret-question gate remains visible only as an inspect-only or disabled row with reason `Secret answers require a future Vault-backed input contract.` Goal worker gates additionally require the exact `waiting_for_user` checkpoint and matching Goal and Goal Task lineage. Missing or contradictory owners may produce an inspect-only recovery row when an owning specification authorizes it, but they MUST NOT produce approval or answer actions. Item absence alone, identifier prefixes, or a missing response projection never proves actionability.

Rows backed by app-local runtime state should expose opaque app-local IDs until the shape stabilizes.

## Implementation Mapping

The first implementation is tracked as an App API and product read-model slice, not a core protocol expansion.

`packages/app-api-schemas/src/action-center.ts` owns the runtime-neutral `HumanAttentionKind`, `HumanAttentionSeverity`, `HumanAttentionActionKind`, `HumanAttentionAction`, `HumanAttentionSource`, `HumanAttentionRow`, `ListHumanAttentionResponse`, and Goal Review decision schemas. `packages/app-api-schemas/src/workspace-sync.ts` owns the separate durable Workspace Sync Review decision vocabulary.

The canonical target row kind for reusable knowledge proposal review is `knowledge_review`.

`packages/core-client/src/action-center.ts` exposes `client.actionCenter.listHumanAttention(workspaceId)` against `GET /api/app/workspaces/:workspaceId/action-center`.

`packages/core-client/src/app.ts` exposes version-owned Artifact Review listing and decisions through `client.app.listArtifactReviews(workspaceId, artifactId)` and `client.app.submitArtifactReviewDecision(workspaceId, artifactId, artifactVersion, input)`, durable Workspace Sync Review decisions through `client.app.submitWorkspaceSyncReviewDecision(workspaceId, reviewId, input)`, and Goal Review resolution through `client.app.submitGoalReviewDecision(workspaceId, threadId, goalId, reviewId, input)`. It exposes no generic unversioned Artifact Review method or cross-owner alias.

`apps/nanocore/src/action-center.ts` owns the unified projection over protocol approval/user-input items, scheduler admissions, worker checkpoints, Goal Mode lifecycle and Review records, version-owned Artifact Reviews, durable Workspace Sync Reviews, failed/offline agent readiness, and explicit knowledge proposal records. Its pending-input row source is exactly `{ type: "pending_input", workspaceId, threadId, pendingTurnId, requestId, contentItemId, goalId, activeTurnId, state }`, where `state` is `queued` or `applied` and every field is projected from the verified S16 pending owner plus the accepted S39 trace when applied. It contains no Item text, Material bytes or tuple, claim fields, receipt body, current Goal inference, or independently mutable status.

S16 Goal steering now uses only the exact Thread-unique `PendingUserTurnRecord`, original Item, immutable S39 Context Package proof, terminal outcome, and command receipt owners. It accepts input only for the original Goal and checkpoint-backed active Turn, reports queued or applied state from durable proof, and supports only the specified terminal follow-up conversion or cancellation. The deleted generic queue, delivery engine, recovery routes, import/export family, runner, and user-facing MCP facade remain absent; missing delivery capability returns the bounded fail-closed result without live worker mutation or substitute authority.

`apps/nanocore/src/policy/approval-gates.ts` creates the current `repo.push` policy approval Gate using the existing permission decision, `ApprovalRequest`, completed `approval-request` Item, and Turn `humanGate.kind: "approval"` owners. Its deterministic route identity and central receipt lookup replay the exact active Gate, reject changed input, and return `recovery_required` when Gate effects exist without a receipt. `require_escalation` remains a durable permission-decision outcome, but no current enforcement point produces an escalation workflow or higher-authority Action Center row.

`apps/nanocore/src/app.ts` serves the unified Action Center endpoint, lists version-owned Artifact Reviews under `GET /api/app/workspaces/:workspaceId/artifacts/:artifactId/reviews`, records their exact decisions under `POST /api/app/workspaces/:workspaceId/artifacts/:artifactId/versions/:artifactVersion/review/decision`, records durable Workspace Sync Review decisions under `POST /api/app/workspaces/:workspaceId/workspace-sync/reviews/:reviewId/decision`, resolves knowledge proposal decisions, and resolves Goal Review rows. The generic unversioned Artifact Review route, Artifact-to-Workspace Review fallback, and verdict translation remain deleted.

`apps/web/src/App.tsx` renders a first-class Action Center page, keeps inline thread approval/question cards for local context, links Goal Mode human attention warnings to the Action Center, and dispatches enabled approval, agent-readiness, durable Workspace Sync Review, and Goal Review actions through `@openkit/core-client`.

Knowledge proposal accept, reject, and defer decisions are the accepted Action Center projection. Changing a proposal title, summary, or content requires a new proposal; there is no `edited` decision and no mutation of a pending proposal. Claim-promotion and worker-control proposal-summary producers remain absent, and accepted Claims may guide only the ordinary complete `knowledge.proposal-draft` command. Durable Workspace Sync Review rows expose executable `accepted`, `needs_refinement`, `rejected`, and `blocked` decisions through App API, `@openkit/core-client`, and OpenAPI even when the backing Artifact is unavailable; no Artifact route can decide or apply them. Live Goal Review rows created by human-reviewed steps expose executable accept, refinement, retry, and abort actions with no preselected verdict; Core Client, Web, and the unified Skill's `goal.review-decide` CLI operation submit the canonical decision, and cancelling required text collection leaves the Review unresolved. Direct Task and Goal Gate response closeout, exact replay, and boot checkpoint classification use the existing Item, Turn, AgentSession, checkpoint, mode, backend, lease, capacity, and receipt owners; complete exact tuples close once, while incomplete or contradictory tuples remain `recovery_required`. If an AEP worker reports accepted `blocked` plus `ask_user` without a transport that names an exact Core Gate, NanoCore preserves that worker outcome, completes backend cleanup, marks the Product Turn and AgentSession `interrupted` with `worker_human_gate_unavailable`, and returns `recovery_required`; it does not synthesize a Gate or Action Center row. The mode checkpoint stays `preparing` with null `stopReason` and `workerSessionId`, so boot leaves it discoverable as `recovery_required` instead of claiming `waiting_for_user`. Capacity is released with `needs-evidence` only when that exact interruption, accepted final status, cleaned backend session, and releasing lease lineage agree, and restart uses the same bounded interruption projection. Interrupted-worker checkpoint rows expose inspection, request-human guidance, and retry-to-ready, while caller-selected terminal checkpoint cleanup remains absent because caller input cannot replace final-status and complete closeout proof. Retry remains unavailable while the scheduler lease is `awaiting-reconnect` or retains `needs-evidence`. Adapter-native in-flight AgentSession resume remains disabled because the checkpoint read model is not a replay instruction. Generic pending-user-turn persistence and every generic mutation or recovery projection remain absent; the exact S16 Goal pending owner, verified S39 delivery projection, terminal follow-up, and cancellation are implemented without restoring that platform. Scheduler admission rows expose retry for denied admissions and cancellation for queued or denied admissions through the same public surfaces. Known non-goals for this implementation are checkpoint AgentSession resume execution and Agent switching execution from the Action Center; those actions remain disabled with explicit reasons when projected.

## Layer Ownership

### `docs/core`

Core docs own the durable semantic rules:

- Steering is active-turn input, not a separate object.
- Review and refinement are normal turns in a thread.
- Approval and user-input gates share `awaiting_human`.
- Human gate UI branches by `humanGate.kind` and item type.

### `packages/protocol`

The protocol package owns stable schemas for:

- Turn status.
- Turn human gate.
- Approval request and decision items.
- User-input request and response items.
- Artifact reference items.
- Event envelopes and command idempotency.

It should not add `HumanAttentionRow`, review verdicts, or queue records in the first implementation.

### `apps/nanocore`

NanoCore owns app-local runtime behavior:

- Worker turn envelope state.
- Runtime-owned system steering input to the next Coordinator decision.
- Exact S16 Goal pending-input persistence and delivery proof.
- Runtime checkpoints.
- Review cap detection.
- Budget stop handling.
- Action Center read-model projection.

### `apps/web`

Web owns product rendering:

- Inline approval cards.
- Inline question cards.
- Eligible-Goal steering composer and rejected-busy states.
- S16-authorized pending-input affordances.
- Artifact review UI.
- Action Center list and filters.
- Existing Goal, Review, checkpoint, and recovery projections authorized by their owning specifications.

## Implementation Guidance

## Deferred / Future Work

- Adapter-safe in-flight checkpoint session resume remains disabled until checkpoint rows carry an explicit replay-safe resume contract.
- Agent switching from Action Center rows remains disabled until agent replacement policy, session compatibility, and worker package refresh semantics are explicit.
- A worker-reviewer iteration loop, review cap, reviewer-specific `needs_attention` or `block` verdicts, and cap-recovery UI or L6 stories are non-authorizing until one accepted specification defines their authority, lifecycle, replay, and stop predicates.

## Testing Strategy

Protocol tests should continue to assert that `awaiting_human` requires a valid human gate and that approval and user-input gates stay distinct.

NanoCore unit tests prove exact S16 Goal steering acceptance, pending preservation, S39-derived applied state, terminal follow-up and cancellation, generic busy-input rejection before writes, checkpoint recovery projection, and Workspace-scoped Action Center filtering. Every deleted generic route, queue, and recovery action remains absent; the tests use the exact pending owner rather than a generic queue fixture.

Workspace-review tests MUST prove that `workspace_review` actions submit only `accepted`, `needs_refinement`, `rejected`, or `blocked` to the exact S49 route; only `accepted` enters apply; the exact durable `artifactId` relationship excludes its backing Artifact from generic Artifact Review; and no id prefix, artifact-only fallback, or verdict translation selects or mutates Workspace Sync Review authority.

NanoCore black-box tests should currently cover the fail-closed Goal route and a generic busy Thread returning `thread_busy`. An eligible Goal worker accepting queued input becomes required only with the exact S16 owner, and neither path may race a second worker Turn.

Web component tests should cover distinct rendering for approval, question, artifact review, existing recovery, and authorized budget rows. Pending-input rendering is added only with the exact S16 owner and product projection.

Web e2e tests should cover a realistic flow where a user steers an eligible Goal, observes generic busy-input rejection, answers a Plan Mode question, approves a sensitive action, reviews an artifact, and requests refinement in the same thread.

## Risks & Mitigations

Risk: every human attention row becomes an approval prompt.

Mitigation: keep approval for authorization only and use elicitation or review for ordinary choices.

Risk: UI clients accidentally implement queueing semantics.

Mitigation: keep delivery policy as command intent and make Core/NanoCore emit authoritative item and state updates.

Risk: steering input disappears during crashes.

Mitigation: for an eligible Goal only, persist the input Item and `PendingUserTurnRecord` atomically before acknowledging acceptance; every other busy path rejects before writes.

Risk: review verdicts become a premature protocol object.

Mitigation: keep each verdict app-local to its existing Artifact, Workspace, Knowledge Proposal, or Goal Review owner until repeated real use proves product-independent semantics worth promoting.

Risk: Action Center hides thread narrative.

Mitigation: every actionable row should link back to thread, turn, item, artifact, checkpoint, or agent readiness context.

Risk: users are asked too many questions.

Mitigation: prefer accepted defaults, policy, and request-scoped mode constraints for low-risk cases; reserve blocking gates for decisions that materially affect outcome, safety, cost, or correctness.

## Resolved Decisions

- Steering delivery remains app-local but is accepted only under the exact S16 Goal owner and immutable proof; no generic queue or interrupt policy is authorized.
- Artifact review should produce durable app-local verdict or decision records before any item-backed or protocol-level review object is introduced.
- The current dogfooding Action Center row kinds are approval, question, artifact review, workspace review, blocked turn, authorized budget choice, checkpoint recovery, agent readiness, knowledge review, and external side effect; pending input joins this set only after the exact S16 owner is implemented.
- Plan Mode controls beyond the current bounded question schema require an accepted App API or app-local schema first; multi-select, recommended options, validation hints, file selection, and secret-answer affordances are not currently authorized, while core protocol keeps only the stable user-input gate semantics.
- Secret elicitation must use a vault-backed or explicitly safe app-local path. Normal item payloads, prompts, diagnostics, Knowledge Store records, and context packages must not carry secret answers.
- Budget handling is elicitation when the user chooses scope, priority, a permitted model downgrade, wrap-up, or an owner-supported pause; it becomes approval when the decision authorizes spending quota, cost, risk, credentials, or external side effects.
- The minimum pending-steering surface is a visible Thread or Action Center row showing the exact Goal and Turn lineage, queued or applied proof state, and only the S16-authorized open, cancel, or terminal-Goal follow-up-conversion action. It must not offer interrupt promotion.

## Deferred Work

- Define structured secret-answer transport only with the Vault model, not through ordinary user-input item payloads.
- Promote review verdicts to item-backed protocol records only after app-local artifact review, workspace review, and Goal Review flows prove a stable shape.
- Keep the accepted S16 version-keyed Artifact Review vocabulary owner-local; do not promote it into protocol records or inherit Workspace Sync Review decisions without a separately accepted contract.

## Links

- [Core Work Model](../core/work-model.md)
- [Core Communication Model](../core/communication.md)
- [Core Protocol](../core/protocol.md)
- [Codex User Input Bridge](./superseded/human-attention/20260515-codex_user_input_bridge.md)
- [Codex Approval Bridge](./superseded/human-attention/20260515-codex_approval_bridge.md)
- [NanoCore Lightweight Agents](./superseded/agent-workflow/20260526-nano_core_lightweight_agents.md)
- [Sustained Mode](./superseded/agent-workflow/20260525-sustained_mode_long_running_agent.md)
- [Worker Turn Reliability Envelope](./20260531-worker_turn_reliability_envelope.md)
- [Self-Improvement Evaluation Loop](./20260710-self_improvement_evaluation_loop.md)
