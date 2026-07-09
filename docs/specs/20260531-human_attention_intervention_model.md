# Human Attention And Intervention Model

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the implementation-facing model for human attention in OpenKit workflows, including approval gates, elicitation gates, steering input, review and acceptance, Action Center projections, pending user turns, artifact review, recovery choices, budget choices, and follow-up decisions.

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

It should keep `awaiting_human` as the single blocking human turn state, keep `humanGate.kind` as the branch point for blocking gates, keep steering as ordinary user input associated with an active turn, and keep implementation-review loops represented as normal turns in a thread.

The app layer may expose a richer Action Center that combines pending approvals, questions, blocked loops, pending user turns, artifact reviews, budget decisions, recovery choices, and follow-up decisions into one product surface.

Those Action Center rows are projections over existing protocol records, app-local runtime records, and future review or checkpoint records.

## Current Implementation Projection

The V1 NanoCore implementation exposes the main app-local surfaces through unified Action Center rows, Goal Review records, artifact review decisions, pending workspace synchronization reviews, knowledge proposal projections, and interrupted-worker recovery choices through product-facing read models.

The core protocol still stays small. `awaiting_human`, approval gates, elicitation gates, ordinary steering input, and review turns remain the stable mapping. Action Center rows remain App API projections until dogfooding proves which fields should become long-term contracts.

Current implementation gaps include budget decisions, vault grants, adapter-native checkpoint resume, and cross-channel review semantics.

## Goals / Non-goals

Goals:

- Define the common human attention and intervention modes for OpenKit.
- Preserve the `Workspace -> Thread -> Turn -> Item[]` backbone.
- Keep `ApprovalRequest` focused on permission, safety, budget, credential, irreversible, and external side-effect decisions.
- Keep agent questions, Plan Mode questions, and elicitation flows separate from approvals.
- Keep steering as user input during active work, not as a separate core object.
- Define how queueing, interrupting, safe-point application, and follow-up turns should relate to steering.
- Define how artifact review, result acceptance, redo, refinement, and implementation-review loops map to existing product concepts.
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

`docs/core/communication.md` says there is no separate core concept for steer messages, and that Core owns input routing, queueing, retry promotion, and safe-point logic.

`docs/core/protocol.md` defines approval and user-input gates as item-backed pauses that share the `awaiting_human` turn state and branch by `humanGate.kind`.

`docs/specs/retired/human-attention/20260515-codex_user_input_bridge.md` records the original separate `user-input-request` and `user-input-response` item types for Codex app-server questions.

`docs/specs/20260531-worker_turn_reliability_envelope.md` introduces app-local worker continuation primitives, including `prepareNextTurn`, `shouldStopAfterTurn`, a system-owned steering queue, a user-owned or runtime-owned follow-up queue, runtime checkpoints, and pending user turns.

The missing product layer is a unified vocabulary for when and why a human should intervene.

Without that vocabulary, approval, question, steer, queue, review, blocked, retry, and budget decisions can become overlapping UI concepts even when the core protocol is clean.

## Decision

OpenKit will model human involvement through four primary interaction modes.

1. `Approval Gate`: a blocking human decision that authorizes or denies a sensitive action.

2. `Elicitation Gate`: a blocking human answer to a question, missing input, planning choice, blocked-state choice, or runtime continuation choice.

3. `Steering Input`: non-terminal user input submitted while work is active, routed by Core to a safe point, interruption path, or follow-up queue.

4. `Review And Acceptance`: human or agent evaluation of work products, artifacts, diffs, plans, knowledge proposals, and loop outcomes.

These modes can compose.

For example, a stuck implementation-review loop may produce an elicitation gate asking the user to choose a recovery path; one recovery path may require an approval gate to extend budget; the chosen response may produce a steering message; and the next worker turn may later produce an artifact review.

Composition is expected.

The four modes are product semantics, not four new core protocol objects.

Core protocol keeps these stable rules:

- Blocking human pauses use `Turn.status: "awaiting_human"`.
- Blocking approval pauses use `humanGate.kind: "approval"` and an `approval-request` item.
- Blocking elicitation pauses use `humanGate.kind: "user-input"` and a `user-input-request` item.
- Active-turn steering is submitted as ordinary input and recorded as normal user-message or equivalent item history.
- Review, redo, refinement, and implementation-review loops are normal turns in the same thread.
- Core and adapters decide safe-point application; UI clients submit intent and render authoritative items and turn events.

The app layer may expose an `Action Center` read model that groups pending human attention across those modes.

## Terminology

`Human attention` is any state where the product should surface work to the user because a human decision, review, correction, or awareness is useful.

`Human intervention` is human attention that changes execution by approving, denying, answering, steering, accepting, rejecting, retrying, or changing direction.

`Human gate` is a blocking pause in a turn.

Only approval gates and elicitation gates are human gates in the current core protocol.

`Approval gate` is a blocking decision that authorizes a sensitive action.

It exists to protect safety, policy, cost, credentials, irreversible operations, and external side effects.

`Elicitation gate` is a blocking request for information or a choice.

It exists when the agent, coordinator, or worker envelope cannot continue responsibly without human input.

`Steering input` is user input while work is already active.

It may correct direction, add constraints, ask the agent to pause, request faster wrap-up, change priority, or provide new information.

`Delivery policy` is how accepted steering input should be applied.

Examples include apply at the next safe point, interrupt then apply, queue after current work, or turn into a follow-up turn after completion.

`Review and acceptance` is evaluation of a work product or intermediate result.

It may lead to accept, refine, redo, export, preserve, propose knowledge, escalate, or stop.

`Escalation trigger` is a runtime, review, budget, policy, or quality condition that asks for human attention.

It is not a new protocol object by itself.

`Action Center` is a Web and App API projection that lists pending human attention across approvals, questions, blocked turns, artifact reviews, budget choices, recovery choices, and follow-up decisions.

## Design Principles

### Keep Core Small

Human-in-the-loop should not create a parallel workflow engine.

The core records remain workspace, thread, turn, item, artifact, approval request, and agent session.

App-local runtime envelopes may hold richer state while the product is still learning which fields are durable.

### Separate Meaning From Delivery

A user message can mean correction, added context, pause, budget concern, review verdict, or acceptance.

That meaning is separate from whether the message is applied immediately, queued to a safe point, converted into a follow-up turn, or used to resolve a blocking question.

UI should capture the user's intent when useful, but Core owns delivery.

### Prefer Elicitation Over Approval For Choices

Approval means authorize or deny.

Questions such as "which branch should I use?", "should I keep trying?", "which artifact should be accepted?", or "which reviewer should inspect this?" are elicitations, not approvals.

This distinction keeps audit semantics clean and avoids approval fatigue.

### Make Review Loops Visible

Implementation-review loops should be visible as normal work in the thread.

The user should see the worker output, reviewer verdict, iteration count, cap, reason for stop, and recovery choices.

The loop should not silently continue after configured limits.

### Allow Composed Human Flows

Many real interactions combine modes.

A review failure can produce an elicitation.

An elicitation answer can produce steering.

A budget extension can require approval.

An approval decision can resume a worker turn.

The model should support these compositions without adding one-off concepts for each scenario.

## Interaction Mode 1: Approval Gate

### Purpose

Approval gates protect operations that should not proceed without explicit human authorization.

They should become less frequent as agent sandboxes, runtime defaults, and workspace policies improve.

They remain necessary for sensitive cases.

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

The turn then resumes, fails, cancels, or enters another recoverable state according to implementation semantics.

### Product Requirements

The UI should present approval as a clear authorization decision, not as a general question.

The approval copy should explain what action is being authorized, which agent or session requested it, which workspace or resource is affected, why policy requires approval, and what happens if the user denies it.

Approval cards should support grant and deny first.

Additional choices such as grant once, grant for this turn, grant for this workspace policy, or deny and explain can be added later only when backed by explicit policy semantics.

## Interaction Mode 2: Elicitation Gate

### Purpose

Elicitation gates collect missing user input or choices required for responsible continuation.

They cover agent questions, Plan Mode questions, blocked-state recovery, runtime checkpoint recovery, ambiguous task scope, and human choices that are not authorization decisions.

### Typical Triggers

- The planner needs the user to choose among viable approaches.
- The worker lacks required business context.
- The task has ambiguous scope or conflicting goals.
- The active turn is paused because the runtime cannot continue without a user answer.
- A long-running loop hit a review cap and needs user direction.
- A checkpoint recovery path needs the user to choose resume, retry, review partial artifacts, or abort.
- A provider, agent, or config problem needs the user to choose a fallback.
- An automation produced a draft that needs a human choice before follow-up.
- A knowledge proposal needs edit, accept, reject, or defer.

### Protocol Mapping

The turn emits a `user-input-request` item and transitions to `awaiting_human`.

The turn carries `humanGate.kind: "user-input"`.

The user responds through ordinary turn input scoped to the paused turn.

Core records a `user-input-response` item.

The turn then resumes, fails, cancels, or transitions according to the runtime or coordinator result.

### Plan Mode

Plan Mode should use elicitation gates when the agent needs structured user input.

The agent should emit bounded question schema rather than arbitrary UI.

The current question shape supports `id`, `header`, `question`, `options`, `isOther`, and `isSecret`.

Future Plan Mode can extend the app-local schema with response mode, recommended option, default answer, validation hints, file selection, and multi-select behavior.

The key rule is that the model proposes structured choices, while the app renders known controls.

This is generative UI only in the bounded sense.

### Product Requirements

Question UI should show the recommended option when the agent provides one.

Question UI should support free-form `Other` without losing the original options.

Secret answers must not be written to prompts, Knowledge Store records, normal item payloads, or diagnostics unless a future secret-answer protocol explicitly defines a safe vault path.

Question responses should preserve enough structure for later replay and audit.

## Interaction Mode 3: Steering Input

### Purpose

Steering lets the user influence active work without waiting for a terminal result.

It is the core "human as leader" interaction for long-running agents.

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

Steering is ordinary user input associated with the active turn by default.

There is no `steer` core object.

If the thread has an active non-terminal turn, new input belongs to that turn unless Core or the adapter closes the turn first.

If the active turn is paused on `humanGate.kind: "user-input"`, the input answers the elicitation gate.

If the active turn is paused on `humanGate.kind: "approval"`, the approval response command must be used instead.

Accepted steering input is ordered by Core receive order, recorded in item history, and applied at safe points according to Core and adapter policy.

### Delivery Policies

Delivery policy is app-local or command-level metadata, not a new core object in the first implementation.

Candidate policies:

```ts
type SteeringDeliveryPolicy =
  | 'safe_point'
  | 'interrupt_then_apply'
  | 'after_current_turn'
  | 'follow_up_turn';
```

`safe_point` means Core applies the input at the next safe point in the active turn.

`interrupt_then_apply` means Core asks the adapter to interrupt or cancel the current execution before applying the input.

`after_current_turn` means Core preserves the input until the current turn reaches a terminal state.

`follow_up_turn` means Core starts a new turn after the active turn completes.

The UI may expose these as product choices such as "send now", "interrupt and correct", "queue after this step", or "run after completion".

The command handler and worker envelope decide the exact behavior.

### Steering Queue And Follow-up Queue

The steering queue is system-owned.

It holds system-generated steering messages such as budget wrap-up instructions, recovery instructions, or coordinator-generated continuation prompts.

The follow-up queue is user-owned or runtime-owned.

It holds user input that should not race a second worker execution while the thread is already busy.

The worker envelope should preserve pending user turns durably enough that a crash does not silently drop user input.

### Product Requirements

The UI should make pending steering visible.

The user should be able to tell whether their message was applied, queued, converted into a follow-up turn, or blocked by a human gate.

The item log should remain coherent.

When follow-up input is applied inside the same turn, the current assistant message should be completed before a new assistant message begins.

## Interaction Mode 4: Review And Acceptance

### Purpose

Review and acceptance covers evaluation of plans, artifacts, diffs, generated files, knowledge proposals, test evidence, and loop outcomes.

It is not the same thing as approval unless a policy-sensitive action is being authorized.

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

Human review decisions can initially be represented as follow-up user input in the same thread.

If product behavior later requires structured durable verdicts, the first step should be an App API read model or app-local record, not an immediate core protocol object.

### Candidate Review Verdicts

Candidate app-local verdicts:

```ts
type ReviewVerdict =
  | 'accepted'
  | 'needs_refinement'
  | 'redo'
  | 'blocked'
  | 'rejected'
  | 'deferred';
```

`accepted` means the current deliverable is good enough.

`needs_refinement` means the current result is useful context but needs changes.

`redo` means the previous attempt should be replaced or attempted again.

`blocked` means progress cannot continue without a changed assumption, new input, different worker, policy decision, or manual investigation.

`rejected` means the output should not be used.

`deferred` means the user will decide later.

### Product Requirements

Artifact review should support inspect, accept, request refinement, redo, export, reuse, and preserve.

The UI should not delete earlier attempts when a redo or refinement happens.

The latest accepted artifact may be highlighted as the current deliverable.

Review decisions should be item-backed or item-linked so future replay explains why the next turn happened.

## Escalation Triggers

Escalation triggers create human attention from runtime, quality, budget, policy, or product conditions.

They do not define new core protocol objects.

They route into one or more of the four interaction modes.

### Review Cap Exceeded

An implementation-review loop may run worker, reviewer, refinement, and reviewer again.

If the reviewer keeps returning `needs_attention` or `block` after the configured cap, the loop should stop.

The system should create an elicitation gate with choices such as:

- Inspect the worker output and reviewer findings.
- Continue for a limited number of extra iterations.
- Change acceptance criteria.
- Change task scope.
- Change worker agent or model.
- Change reviewer agent or model.
- Accept current output despite findings.
- Mark the task blocked.
- Abort the task.

If the chosen path extends budget, weakens policy, uses credentials, publishes output, or performs an external side effect, it may also require an approval gate.

### Budget Threshold Or Exhaustion

When a thread or turn approaches budget limits, the system may inject system-owned budget steering.

If the budget is exhausted and no new substantive work should start, the system should surface an elicitation gate or approval gate depending on policy.

User choices may include wrap up, continue with a larger budget, downgrade model, narrow scope, pause, or abort.

### Blocked Worker

A worker may become blocked because of missing context, failing tests, unavailable dependencies, unsupported runtime capability, or repeated tool failure.

The system should prefer elicitation if a human choice can unblock the work.

It should prefer review if partial outputs need inspection.

It should prefer approval only if continuing requires a sensitive action.

### Runtime Checkpoint Recovery

After restart or crash, Core may know that a turn stopped at a checkpoint.

The Action Center should show a recovery row.

User choices may include resume from worker session when safe, retry from checkpoint, review partial artifacts, convert pending input to follow-up turn, or abort.

This is primarily an elicitation gate or Action Center recovery action.

### Pending User Input While Busy

If a user submits input while a thread is already busy, NanoCore should preserve it as pending input instead of racing another worker execution.

The Action Center or thread UI should show the pending input and its planned delivery policy.

The user may edit, cancel, promote to interrupt, or leave it queued.

This belongs to steering and follow-up queue behavior.

### Agent Readiness Or Config Failure

If the selected agent is missing, degraded, blocked, stale, or misconfigured, the system should surface an elicitation gate or Action Center row.

User choices may include refresh readiness, switch agent, reload config, fix settings, retry later, or run a lighter internal agent.

### Knowledge Proposal

After a completed task, an internal agent may propose reusable knowledge.

Knowledge proposals should be reviewable, editable, source-traceable, and rejectable.

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
| Plan Mode asks for implementation strategy | Planner has multiple viable paths | Elicitation Gate | Review And Acceptance | Render structured choices with recommendation and allow user override. |
| Agent asks which branch to target | Worker lacks required context | Elicitation Gate | None | Pause turn with user-input gate and resume with answer. |
| User notices wrong direction mid-run | User sends correction during active turn | Steering Input | None | Accept input, record item, apply at safe point or requested delivery policy. |
| User wants immediate correction | User selects interrupt and correct | Steering Input | Elicitation Gate if unsafe | Interrupt current execution, then apply correction or ask if ambiguous. |
| User adds extra requirements while busy | New input arrives during worker turn | Steering Input | Follow-up queue | Preserve pending input and show queued state. |
| Artifact is ready for inspection | Worker emits artifact | Review And Acceptance | Steering Input | Let user accept, refine, redo, export, reuse, or comment. |
| User requests refinement | Artifact is close but incomplete | Review And Acceptance | Steering Input | Start follow-up turn in same thread with accepted context. |
| User requests redo | Attempt is unsatisfactory | Review And Acceptance | Steering Input | Start new attempt in same thread without deleting prior attempt. |
| Reviewer rejects worker output | Critic verdict is `needs_attention` | Review And Acceptance | Steering Input | Produce refinement turn with findings in context. |
| Review loop cap exceeded | Repeated `needs_attention` or `block` | Elicitation Gate | Approval Gate if budget extends | Stop loop and ask user to choose recovery path. |
| Budget nearing limit | Usage crosses configured watermark | Steering Input | Elicitation Gate | Inject system steering to wrap up and optionally ask user for scope or budget choice. |
| Budget exhausted | No more substantive work allowed | Elicitation Gate | Approval Gate if extension spends quota | Ask user to wrap up, extend, narrow scope, downgrade, pause, or abort. |
| Runtime crashes with checkpoint | Active turn loses worker session | Elicitation Gate | Review And Acceptance | Show recovery choices and partial artifacts. |
| Pending user input survives crash | Thread recovers with queued input | Steering Input | Elicitation Gate | Show pending input and let user keep, edit, promote, or cancel. |
| Agent config becomes stale | Runtime config changes mid-session | Elicitation Gate | Steering Input | Ask whether to continue current session, restart, or switch agent. |
| Agent readiness blocked | Agent cannot start | Elicitation Gate | None | Offer switch agent, refresh, fix config, or retry later. |
| Knowledge proposal after task | Internal agent proposes reusable knowledge | Review And Acceptance | Elicitation Gate | Let user accept, edit, reject, or defer. |
| External publish action | Agent wants to publish or send output | Approval Gate | Review And Acceptance | User reviews content, then explicitly approves side effect. |
| Automation draft needs confirmation | Scheduled job prepared a follow-up | Review And Acceptance | Approval Gate if external effect | User accepts, edits, rejects, or approves send. |
| Conflicting user instructions | New steering conflicts with prior goal | Elicitation Gate | Steering Input | Ask user to choose which instruction wins. |
| Human accepts known risk | Reviewer flags issue but user wants continue | Approval Gate if policy-sensitive | Review And Acceptance | Record decision and rationale, continue only within policy. |
| User pauses long-running work | User asks to pause after safe point | Steering Input | Elicitation Gate for resume choice | Queue pause request and transition to recoverable state. |
| User asks for handoff | User wants different agent or profile | Steering Input | Elicitation Gate if target unclear | Apply at safe point and start handoff turn if needed. |

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
  agentSessionId?: string;
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

Only rows backed by stable core concepts should expose core IDs.

Rows backed by app-local runtime state should expose opaque app-local IDs until the shape stabilizes.

## Implementation Mapping

The first implementation is tracked as an App API and product read-model slice, not a core protocol expansion.

`packages/app-api-schemas/src/action-center.ts` owns the runtime-neutral `HumanAttentionKind`, `HumanAttentionSeverity`, `HumanAttentionActionKind`, `HumanAttentionAction`, `HumanAttentionSource`, `HumanAttentionRow`, `ListHumanAttentionResponse`, artifact review decision schemas, and Goal Review decision schemas.

The canonical target row kind for reusable knowledge proposal review is `knowledge_review`.

`packages/core-client/src/action-center.ts` exposes `client.actionCenter.listHumanAttention(workspaceId)` against `GET /api/app/workspaces/:workspaceId/action-center`.

`packages/core-client/src/app.ts` exposes app-local artifact review decisions through `client.app.submitArtifactReviewDecision(workspaceId, artifactId, input)`, durable workspace review decisions through `client.app.submitWorkspaceSyncReviewDecision(workspaceId, reviewId, input)`, and app-local Goal Review resolution through `client.app.submitGoalReviewDecision(workspaceId, threadId, goalId, reviewId, input)` so Web does not call App API routes directly.

`apps/nanocore/src/action-center.ts` owns the unified projection over protocol approval/user-input items, scheduler admissions, pending user turns, worker checkpoints, Goal Mode lifecycle/review records, failed/offline agent readiness, app-local artifact review decisions, and explicit knowledge proposal records.

`apps/nanocore/src/runtime/pending-user-turns.ts` stores pending user turn rows in workspace-scoped storage and now emits durable workspace `AuditEvent` rows when pending input is first enqueued, consumed, edited, converted to follow-up delivery, promoted to an active-turn interrupt, or cancelled. Duplicate enqueue attempts and missing consume, edit, follow-up conversion, or cancel attempts do not duplicate audit rows. Pending user-turn recovery rows, pending input edits, pending input follow-up conversion, pending input interrupt promotion, and pending input cancellation are exposed through App API, `@openkit/core-client`, and `@openkit/mcp`.

`apps/nanocore/src/policy/approval-gates.ts` creates the first policy-originated approval gate using the existing approval primitives: a durable permission decision, an `ApprovalRequest`, an item-backed `approval-request`, and a turn-level `humanGate.kind: "approval"`. It also creates the first policy escalation row using a durable `require_escalation` permission decision and a marked `status` item. The Action Center sees these through existing approval and `blocked_turn` projections rather than separate policy-specific row types.

`apps/nanocore/src/app.ts` serves the unified Action Center endpoint, records artifact review decisions under `POST /api/app/workspaces/:workspaceId/artifacts/:artifactId/review`, records durable workspace review decisions under `POST /api/app/workspaces/:workspaceId/workspace-sync/reviews/:reviewId/decision`, resolves knowledge proposal decisions under `POST /api/app/workspaces/:workspaceId/knowledge/proposals/:proposalId/decision`, and resolves Goal Review rows under `POST /api/app/workspaces/:workspaceId/threads/:threadId/goals/:goalId/reviews/:reviewId/decision`.

`apps/web/src/App.tsx` renders a first-class Action Center page, keeps inline thread approval/question cards for local context, links Goal Mode human attention warnings to the Action Center, and dispatches enabled approval, agent-readiness, artifact-review, durable workspace-review, and Goal Review actions through `@openkit/core-client`.

Knowledge proposal accept, edit, reject, and defer decisions are now executable from the Action Center projection. The edited decision updates the pending proposal title and summary before recording the review decision, while accepted claim-derived proposals continue to create the corresponding source-linked knowledge entry. Durable workspace review rows now expose executable accept, refinement, reject, and block decisions through App API, `@openkit/core-client`, and OpenAPI even when the original artifact row is no longer present in the current store projection. Interrupted-worker checkpoint rows expose recovery choices, terminal checkpoint cleanup, and retry-to-ready recovery through App API, `@openkit/core-client`, and `@openkit/mcp`; adapter-safe in-flight session resume remains disabled because the current checkpoint read model is not a replay instruction. Pending user-turn edit, follow-up conversion, interrupt promotion, and cancellation are available through App API, `@openkit/core-client`, and `@openkit/mcp`. Scheduler admission rows expose retry for denied admissions and cancellation for queued or denied admissions through the same public surfaces. Known non-goals for this implementation are checkpoint session resume execution and agent switching execution from the Action Center; those actions remain disabled with explicit reasons when projected.

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
- Steering queue.
- Follow-up queue.
- Pending user turn persistence.
- Runtime checkpoints.
- Review cap detection.
- Budget stop handling.
- Action Center read-model projection.

### `apps/web`

Web owns product rendering:

- Inline approval cards.
- Inline question cards.
- Active-turn steering composer states.
- Pending input affordances.
- Artifact review UI.
- Action Center list and filters.
- Long-running loop status, iteration count, cap, and recovery choices.

## Implementation Guidance

### First Slice

The first slice should not change core protocol.

It should improve the app read model and UI around existing approvals and questions.

It should add a typed Action Center projection that can eventually include more row kinds.

It should keep approval response commands separate from turn input commands.

### Second Slice

The second slice should implement pending user input and delivery policy in NanoCore.

It should preserve user input while a thread is busy.

It should expose whether input is pending, applied, converted to a follow-up turn, or cancelled.

### Third Slice

The third slice should add artifact review and result acceptance.

It can begin as app-local read models and follow-up turns.

It should not introduce a core `ReviewDecision` until user flows prove the stable shape.

### Fourth Slice

The fourth slice should connect sustained-mode review caps, budget stops, and checkpoint recovery to Action Center rows.

It should produce clear elicitation gates when the system needs explicit user direction.

It should use approval gates only when continuing would authorize cost, risk, credentials, or external side effects.

## Deferred / Future Work

- Adapter-safe in-flight checkpoint session resume remains disabled until checkpoint rows carry an explicit replay-safe resume contract.
- Agent switching from Action Center rows remains disabled until agent replacement policy, session compatibility, and worker package refresh semantics are explicit.

## Testing Strategy

Protocol tests should continue to assert that `awaiting_human` requires a valid human gate and that approval and user-input gates stay distinct.

NanoCore unit tests should cover pending input preservation, delivery policy selection, review cap escalation, budget stop escalation, checkpoint recovery row generation, and Action Center projection filtering.

NanoCore black-box tests should cover a busy thread receiving user input without racing a second worker turn.

Web component tests should cover distinct rendering for approval, question, pending input, artifact review, blocked loop, and budget rows.

Web e2e tests should cover a realistic flow where a user steers active work, answers a Plan Mode question, approves a sensitive action, reviews an artifact, and requests refinement in the same thread.

L6 story acceptance should include a long-running delegation story where a worker-reviewer loop exceeds its cap and the user chooses a recovery path.

## Risks & Mitigations

Risk: every human attention row becomes an approval prompt.

Mitigation: keep approval for authorization only and use elicitation or review for ordinary choices.

Risk: UI clients accidentally implement queueing semantics.

Mitigation: keep delivery policy as command intent and make Core/NanoCore emit authoritative item and state updates.

Risk: steering input disappears during crashes.

Mitigation: persist pending user turns before long-running or non-idempotent boundaries.

Risk: review verdicts become a premature protocol object.

Mitigation: keep review verdicts app-local until artifact review and sustained-mode loops are dogfooded.

Risk: Action Center hides thread narrative.

Mitigation: every actionable row should link back to thread, turn, item, artifact, checkpoint, or agent readiness context.

Risk: users are asked too many questions.

Mitigation: prefer defaults, policy, and system-owned steering for low-risk cases; reserve blocking gates for decisions that materially affect outcome, safety, cost, or correctness.

Risk: review cap escalation stops useful autonomous progress too early.

Mitigation: make caps configurable per mode and provide a bounded continue option with visible iteration and budget impact.

## Resolved Decisions

- Steering delivery policy stays app-local and NanoCore-owned until pending-turn behavior stabilizes; it should not become a core protocol field in this slice.
- Artifact review should produce durable app-local verdict or decision records before any item-backed or protocol-level review object is introduced.
- The default dogfooding Action Center row kinds are approval, question, artifact review, workspace review, blocked turn, review cap, budget, checkpoint recovery, pending input, agent readiness, knowledge review, and external side effect.
- Plan Mode structured questions, multi-select controls, recommended options, validation hints, file selection, and secret-answer affordances belong in App API or app-local schemas first; core protocol keeps only the stable user-input gate semantics.
- Secret elicitation must use a vault-backed or explicitly safe app-local path. Normal item payloads, prompts, diagnostics, Knowledge Store records, and context packages must not carry secret answers.
- Budget extension is an elicitation when the user chooses scope, priority, model downgrade, wrap-up, pause, or abort; it becomes an approval when the decision authorizes spending quota, cost, risk, credentials, or external side effects.
- The minimum pending-steering surface is a visible thread or Action Center row showing received input, queue mode, planned delivery, current state, and available choices such as open thread, keep queued, cancel, promote to interrupt when supported, or convert to follow-up.

## Deferred Work

- Define structured secret-answer transport only with the Vault model, not through ordinary user-input item payloads.
- Promote review verdicts to item-backed protocol records only after app-local artifact review, workspace review, and Goal Review flows prove a stable shape.

## Links

- [Core Work Model](../core/work-model.md)
- [Core Communication Model](../core/communication.md)
- [Core Protocol](../core/protocol.md)
- [Codex User Input Bridge](./retired/human-attention/20260515-codex_user_input_bridge.md)
- [Codex Approval Bridge](./retired/human-attention/20260515-codex_approval_bridge.md)
- [NanoCore Lightweight Agents](./retired/agent-workflow/20260526-nano_core_lightweight_agents.md)
- [Sustained Mode](./retired/agent-workflow/20260525-sustained_mode_long_running_agent.md)
- [Worker Turn Reliability Envelope](./20260531-worker_turn_reliability_envelope.md)
