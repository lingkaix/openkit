---
status: Accepted
implementation: Partial
kind: concept
aspect: work-model
---
# Human Attention And Intervention Model

This specification owns the four human-attention kinds and the Action Center projection of actionable work.

## Decision

`docs/core/work-model.md` owns the four human-attention kinds and their stable product meanings. This specification maps those kinds to concrete protocol, persistence, Action Center, delivery, and recovery behavior.

For example, a Task or checkpoint owner may produce an elicitation gate for a missing choice; a selected path may require an approval gate for additional cost or side effects; a later worker Turn may then produce an Artifact Review through its existing owner.

Composition is expected.

The four human-attention kinds are product semantics, not four new core protocol objects.

Core protocol keeps these stable rules:

- No Turn status pauses for a person. A request is blocking when the requesting agent ended its Turn while it was outstanding and no later Turn has run.
- An approval request uses an `approval-request` item and a pending `ApprovalRequest`.
- An elicitation request uses a `user-input-request` item.
- Active-turn steering is submitted as ordinary input and recorded as normal user-message or equivalent item history.
- Review, redo, and refinement use the exact Review owner and create ordinary traceable Turns where its specification authorizes follow-up work; this rule does not authorize a generic review loop.
- UI clients and adapters submit ordinary input and render authoritative Items and Turn events. They do not invent a delivery queue. Ordinary busy input while a Turn is non-terminal returns `409 thread_busy` before writes; explicit [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) uses its exact-target contract. The protocol does not add `HumanAttention`, `TaskRun`, `AgentRun`, or a Turn status `awaiting_approval`, `awaiting_question`, `needs_review`, or `blocked_by_review`.

The app layer may expose an `Action Center` read model that groups pending human attention across those kinds.

## Terminology

`Human attention` is any state where the product should surface work to the user because a human decision, review, correction, or awareness is useful.

`Human intervention` is human attention that changes execution by approving, denying, answering, steering, accepting, rejecting, retrying, or changing direction.

`Human gate` is a pending approval or user-input request: the governed effect, or the requesting agent's use of the answer, waits for it, and the Turn that raised it does not.

Only approval requests and elicitation requests are human gates in the current core protocol.

`Delivery policy` is the authoritative outcome for steering input. [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) owns exact running-Task delivery, including Goal-linked workers. It adds no Goal safe-point queue; other ordinary input while a Turn is non-terminal returns `409 thread_busy` before writes.

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

This distinction keeps audit semantics clean and avoids approval fatigue. Prefer accepted defaults, policy, and request-scoped constraints for a low-risk case. Reserve a blocking gate for a decision that materially affects outcome, safety, cost, or correctness. This preference adds no Policy grant, automatic answer, deadline, or steering mechanism.

### Make Review Ownership Visible

The user should see the reviewed output, exact owning Review record, decision, reason, evidence, and resulting Turn lineage. Human Attention does not define reviewer iteration, caps, or continuation policy.

### Allow Composed Human Flows

Many real interactions combine kinds.

A review failure can produce an elicitation.

An elicitation answer can produce steering.

A budget extension can require approval.

An approval grant authorizes the gateway or effect owner to re-evaluate and execute the exact captured effect once; it is not by itself authority to execute. It does not resume a paused Turn, because none is paused, and it neither closes nor resumes the requesting AgentSession. Its outcome is delivered on a later Turn of the same Thread; when the requesting binding has ended, that Turn uses the ordinary successor resume, which is not the approval's effect.

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

The raising Turn emits an `approval-request` item and continues; its status does not change.

The pending request record names the request, its raising Turn, and its responsible user.

The user responds through the approval response command.

Core records an `approval-decision` item.

The response is recorded in the pending request at once. For an approval that governs a call, the gateway re-evaluates and executes the captured call inside the response command and records its disposition. A later Turn on the same Thread delivers the decision and the disposition to the requesting agent. Grant and denial never close the requesting AgentSession and never terminalize the raising Turn. An unproved or contradictory request is inspect-only `recovery_required` and accepts no approval response; the approval record alone never resumes an AgentSession.

The internal Assistant MCP branch is owned by `20260909-internal_agent_resource_integration.md` and its conversation outcome by `20260704-chat_mode_assistant.md`. It has no Worker AgentSession, AEP, Harness interrupt, or waiting checkpoint. A pending request is actionable from the durable request, captured binding, request Item, no-contact denied CapabilityCall, and current authority in [Pending Requests](20260930-pending_requests.md); it does not require a stopped invocation or an `approval-required` `conversation.submit` receipt. A command that exists keeps its own receipt and immutable replay, and a completed receipt is not rewritten. Missing or contradictory evidence is inspect-only `recovery_required`. [Internal Agent Resource Integration](20260909-internal_agent_resource_integration.md) tracks that missing branch. An approval-required call on that branch returns a pending result immediately, the Assistant run may continue and complete with its ordinary result, a grant executes the captured operation once through the pending owner's single synchronous re-evaluation, grant, and claim inside the response command, and the outcome is delivered on a later Assistant Turn; the decision itself invokes no provider, and the model never re-issues the call. A Chat clarification is a pending user-input request whose answer is recorded by `user_input.answer` and starts a later Assistant Turn.

### Product Requirements

The UI should present approval as a clear authorization decision, not as a general question.

The approval copy should explain what action is being authorized, which agent or session requested it, which workspace or resource is affected, why policy requires approval, and what happens if the user denies it.

Approval cards show the bounded summary. Before grant is enabled, they show the responsible user the complete exact detail defined by [Pending Requests](20260930-pending_requests.md#exact-effect-disclosure). When that detail is unavailable, the card states `Exact effect unavailable; approval disabled` and offers only deny and withdraw, where these are otherwise permitted.

Approval cards should support grant and deny first, plus withdrawal by the responsible user. A request with a matching decision remains visible with its closed outcome and no decision controls; an ended request shows its reason, and a disconnected surface explains why controls are unavailable. A pending request stays decidable after its raising Turn has completed. Controls remain unavailable while the request's state is unknown, its read failed, or the request Item does not match its pending request record. The card shows the request's age, the number of Turns since it was raised, whether it is blocking, and what changed since, so the approver can judge a stale request; staleness is enforced by re-evaluation at execution, never by a clock. A pending command disables duplicate submission, a failure is visible with an explicit retry, and a retry preserves the exact original request identity. Only authoritative refreshed Items settle the displayed outcome.

Additional choices such as grant once, grant for this turn, grant for this workspace policy, or deny and explain can be added later only when backed by explicit policy semantics.

## Elicitation Gate Mapping

### Typical Triggers

- The planner needs the user to choose among viable approaches.
- The worker lacks required business context.
- The task has ambiguous scope or conflicting goals.
- The agent needs a user answer before later work can use it, and records that need as a pending user-input request without pausing the Turn.
- A checkpoint recovery path needs the user to inspect the thread, or to use the eligible retry command when its Task continuation predicate holds.
- A provider, agent, or config problem needs the user to choose a fallback.
- An automation produced a draft that needs a human choice before follow-up.
- A knowledge proposal needs accept, reject, or defer; changed candidate bytes require a new proposal.

### Protocol Mapping

The raising Turn emits a `user-input-request` item and continues; its status does not change.

The pending request record names the request, its raising Turn, and its responsible user.

The user responds through the `user_input.answer` command addressed to the pending request, as [Pending Requests](20260930-pending_requests.md) defines. The command persists the answer without changing the raising Turn.

Core records a `user-input-response` item.

The answer is recorded in the pending request at once and delivered to the requester on a later Turn of the same Thread, which for a worker is the next Turn of the same Task, for the Assistant is its next Chat Turn, and for the Coordinator is the next Turn on the Goal's Thread. The answer never attaches to the raising Turn and never closes the requesting AgentSession. A retained question stays readable. It starts no private Goal step.

### Plan Mode

Plan Mode should use elicitation gates when the agent needs structured user input.

The agent should emit bounded question schema rather than arbitrary UI.

`UserInputQuestionSchema` and `UserInputQuestionOptionSchema` in `packages/protocol/src/models/item.ts` own the question shape.

No additional response mode, recommendation, default, validation, file-selection, or multi-select field is authorized by this specification. A demonstrated product need requires an accepted schema update with ownership, persistence, replay, redaction, and client fallback rules before implementation.

The key rule is that the model proposes structured choices, while the app renders known controls.

This is generative UI only in the bounded sense.

### Product Requirements

Question UI may show a recommended option only after an accepted question-schema contract carries it; the current shape does not.

Question UI should support free-form `Other` without losing the original options.

Secret answers must not be written to prompts, Knowledge Store records, normal item payloads, or diagnostics unless a future secret-answer protocol explicitly defines a safe vault path.

Until that safe path exists, a pending user-input request containing any `isSecret=true` question is visible but not answerable through `user_input.answer`; submission returns `400 secret_input_not_supported` before a response Item or command write.

Question responses use an exact structured map rather than flattened text: `answers` is `{ [questionId]: [string] }`, and the one array member is non-empty. V1 has no multi-select question mode, so zero or multiple values are `400 invalid_request`. A request producer MUST reject duplicate question ids as `400 invalid_request` before creating the request Item. The answer keys MUST equal every and only question id in the referenced completed request Item; missing or extra answer keys are `400 invalid_request`. If an already durable request Item contains duplicate ids or contradicts its pending request record, response submission returns `409 recovery_required` rather than blaming caller input. The pending request record owns waiting state; the request Item itself is completed once its immutable payload is durable, and the response Item references it by id on the delivering Turn, anywhere later in the same Thread. Every failure occurs before business mutation.

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

A Goal work-intent edit is recorded on the Goal and does not change a running worker. There is no `steer` Core object. `PendingUserTurnRecord` leaves with the one-way Goal removal.

An answer to a pending user-input request uses the answer command addressed to that request, whether or not a Turn is active.

A pending approval is answered only by the approval response command, never by user input.

Ordinary input submitted while a Thread has a non-terminal Turn returns `409 thread_busy` before Item or command writes. Explicit [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) addresses its exact running Turn and owns admission and delivery. A Goal work-intent edit is recorded on the Goal and does not by itself change a running worker. Interrupting that worker uses the Task owner's interrupt. The [Task Live-Steer Rulings](../decisions/20261008-task_live_steer_rulings.md) record this scope.

### Delivery Policies

Goal-linked worker input uses [Task live steer](20260704-task_mode_worker_delegation.md#live-steer), with no Goal safe-point steering path. Generic `interrupt_then_apply`, `after_current_turn`, and automatic `follow_up_turn` policies are not authorized. A UI MUST NOT expose them as available delivery choices until an accepted specification names their owner, durable proof, failure behavior, restart behavior, and replay predicate.

### Runtime Constraints And Follow-up Input

A budget wrap-up, recovery constraint, or similar Core-generated instruction is request-scoped input supplied by the owning mode service to its next Coordinator decision. It has no queue or durable steering record. If the constraint must survive restart, the mode service recomputes it from the existing budget, checkpoint, execution-attempt, or recovery owner that made it necessary; it MUST NOT reconstruct it from process memory or add a system-steering queue.

V1 has no generic user follow-up queue and no Goal pending-input row.

### Product Requirements

The UI should not render rejected busy input as pending. A Goal work-intent edit appears on the Goal.

The UI distinguishes native acceptance, definite non-delivery, and delivery unknown under [Task live steer](20260704-task_mode_worker_delegation.md#live-steer). Native acceptance is distinct from model consumption or completion. Pending Request responses remain later-Turn delivery and are shown separately from unsolicited live input. The user should be able to tell whether a human gate blocked their message.

The item log should remain coherent.

A card edit does not steer a running worker. The Task owner owns explicit live steer and interruption as separate operations.

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

An ordinary review comment may be submitted as follow-up user input, but it is not a decision. Every decision that changes acceptance, refinement, redo, retry, rejection, or deferral MUST claim and update the exact existing Artifact Review, Workspace Review, or Knowledge Proposal owner before creating downstream work. Goal completion and Plan approval are Pending Requests, not review verdicts. A comment, Thread Item, Action Center action, or UI selection MUST NOT bypass that owner or synthesize a generic verdict.

### Review Decision Ownership

Decision values are local to their owning record rather than members of one reusable verdict enum. S16's version-owned Artifact Review owns ordinary Artifact acceptance and its `needs_refinement` or `redo` follow-up reservation; S49 Workspace Sync Review owns exactly `accepted`, `needs_refinement`, `rejected`, or `blocked`; Knowledge Proposal owns exactly `accepted`, `rejected`, or `deferred`. Each owner preserves the evaluated version, evidence, request identity, reason or instruction, and resulting lineage required by its specification. Adding or translating a decision requires changing that owner contract first; Action Center remains a projection.

For a Workspace Sync Review, `WorkspaceSyncReviewItem.artifactId` is the immutable relationship to its backing Artifact presentation and evidence snapshot. That Artifact is not a generic Artifact Review owner, and its availability or immutable snapshot status cannot replace the durable Workspace Sync Review. Action Center and routes MUST classify the relationship from the stored Workspace Sync Review lineage, never an Artifact id prefix or a verdict inferred from parsed Artifact content.

A `workspace_review` action MUST submit `accepted`, `needs_refinement`, `rejected`, or `blocked` directly to the S49 workspace-sync review decision route. It MUST NOT submit `accept`, `reject`, `defer`, `deferred`, or `redo`, use the generic Artifact Review route, or translate between the two vocabularies. Only `accepted` may authorize S49 apply; the other three values record no workspace mutation. The exact durable `artifactId` relationship excludes that backing Artifact from generic Artifact Review. No id prefix, artifact-only fallback, or verdict translation selects or mutates Workspace Sync Review authority. The Core Client exposes no generic unversioned Artifact Review method or cross-owner alias. A Workspace Sync Review decision remains available when its backing Artifact is unavailable. No Artifact route decides or applies that review. Action Center keeps a generic Artifact Review projection inspect-only. Direct decisions use the versioned owner route. An exact Artifact related to both an Artifact Review and a Workspace Sync Review remains one inspect-only `recovery_required` row, and both direct decision routes fail closed.

S16 now owns Material proposal and writeback vocabulary on one exact version-owned Artifact Review. An accepted non-null proposal applies through the existing Material owners and one Workspace SQLite transaction, while refinement and redo reserve the exact follow-up Turn; Workspace Sync Review defines no alias, apply semantics, verdict translation, or fallback for that path.

Action Center shows Plan approval and completion acceptance as pending requests. It does not project a Goal Review verdict. A worker completion does not close the Goal.

### Product Requirements

Artifact review should support inspect, accept, request refinement, redo, export, reuse, and preserve.

The UI should not delete earlier attempts when a redo or refinement happens.

The latest accepted artifact may be highlighted as the current deliverable.

Review decisions should be item-backed or item-linked so future replay explains why the next turn happened.

## Escalation Triggers

Escalation triggers create human attention from runtime, quality, budget, policy, or product conditions.

They do not define new core protocol objects.

They route into one or more of the four human-attention kinds. `require_escalation` remains a durable permission-decision outcome. Goal-scoped refusal can wake the Coordinator. No distinct higher-authority Action Center kind is added.

### Budget Threshold Or Exhaustion

When a Thread or Turn approaches budget limits, the owning mode recomputes one request-scoped budget constraint from the existing budget and checkpoint owners and supplies it to its next Coordinator decision. It does not create a system-steering queue or inject input behind the mode owner.

If the budget is exhausted and no new substantive work should start, the system should surface an elicitation gate or approval gate depending on policy.

The row may offer only choices backed by an existing owner command, such as wrap up, request a larger budget, choose a permitted model, or narrow scope. It MUST NOT invent a generic abort or budget-override command.

### Blocked Worker

A worker may become blocked because of missing context, failing tests, unavailable dependencies, unsupported runtime capability, or repeated tool failure.

The system should prefer elicitation if a human choice can unblock the work.

It should prefer review if partial outputs need inspection.

It should prefer approval only if continuing requires a sensitive action.

### Runtime Checkpoint Recovery

After restart or crash, Core may know that a turn stopped at a checkpoint.

The Action Center shows an interrupted-worker recovery row only after the exact Turn, execution attempt, exact backend cleanup/fencing, worker-control revocation, and exclusion-release predicate in `docs/specs/20260531-worker_turn_reliability_envelope.md` is complete. A checkpoint alone, a live worker, `awaiting-reconnect`, or cleanup-owned `needs-evidence` state produces no interrupted-worker row.

The row may expose only actions already authorized by the checkpoint and mode owners. There is no replacement compatibility path for the removed `ask_user` fallback, and this projection adds no interruption producer. Adapter resume requires a replay-safe resume contract. Retry stays unavailable while the scheduler lease is `awaiting-reconnect` or retains `needs-evidence`. Complete exact closeout tuples close once. An incomplete or contradictory tuple stays `recovery_required`. Caller-selected terminal cleanup cannot replace final-status and complete closeout proof. `worker.recovery.retry` appears only when its stricter Task continuation predicate also holds, and it closes the authoritatively interrupted checkpoint without rewriting the old Turn. A later Task command owns replacement execution. A missing Goal removed by the accepted deletion is known absence and does not by itself hide an otherwise eligible Task retry. Contradictory non-Goal lineage remains inspection only. The produced row offers thread inspection and eligible `worker.recovery.retry`. It does not project request guidance or a disabled native resume.

This is primarily an elicitation gate or Action Center recovery action.

### Pending User Input While Busy

Ordinary input submitted while a Thread has a non-terminal Turn returns `409 thread_busy` before an Item or command write. Explicit [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) has its own admitted Item and result; neither path creates queued follow-up input.

The direct-Turn path must not present the rejected input as queued or recoverable. No generic pending-user-turn record and no generic mutation or recovery projection is added.

Action Center shows pending approvals and questions. Queued scheduler admission projects `pending_input`. That row is not a Goal steering record. A denied admission may expose retry. A queued or denied admission may expose cancellation. Action Center does not show a Goal steering row.

Goal adds no steering owner or terminal follow-up conversion; linked workers use [Task live steer](20260704-task_mode_worker_delegation.md#live-steer).

### Agent Readiness Or Config Failure

If the selected agent is missing, degraded, blocked, stale, or misconfigured, the system should surface an elicitation gate or Action Center row.

User choices may include refresh readiness, switch agent, reload config, fix settings, retry later, or use an available lightweight Core-only path.

### Knowledge Proposal

A completed task does not trigger an implicit Knowledge Manager hook. Reusable knowledge enters review only through an explicit governed proposal command with source references and the existing Knowledge Proposal owner.

Knowledge proposals should be reviewable, source-traceable, rejectable, and deferable; changed candidate bytes require a new proposal. There is no `edited` decision and no mutation of a pending proposal. An accepted Claim may guide only the ordinary complete `knowledge.proposal-draft` command.

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

| Scenario | Trigger | Primary kind | Secondary kind | Expected handling |
| --- | --- | --- | --- | --- |
| Approve shell command outside policy | Worker requests command escalation | Approval Gate | None | Create a pending approval with the captured command; the worker continues; after a grant the effect is re-evaluated and executed once, and a later Turn delivers the outcome. |
| Confirm destructive file deletion | Worker plans irreversible delete | Approval Gate | Review And Acceptance | Show affected paths and reason, deny should stop or reroute safely. |
| Use vault-backed credential | Agent needs a secret reference | Approval Gate | Elicitation Gate | Ask only if policy requires approval, never expose secret value. |
| Plan Mode asks for implementation strategy | Planner has multiple viable paths | Elicitation Gate | Review And Acceptance | Render the accepted bounded choices and allow user override, without an unowned recommendation field. |
| Agent asks which branch to target | Worker lacks required context | Elicitation Gate | None | Record the answer on the pending request and deliver it on the next Turn of the same Thread. |
| User notices wrong direction during an active worker Turn | User sends correction | Steering Input | None | Use explicit [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) for the exact running Turn and display its native acceptance, refusal, or unknown result. A Goal work-intent edit remains a separate operation. |
| User wants immediate correction | User requests interrupt and correct | Steering Input | Elicitation Gate | V1 does not accept interrupt-then-apply. Ordinary busy input returns `thread_busy` before writes. Interrupting a worker uses the Task owner's interrupt; additional same-Turn input uses [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) without interrupting. |
| User adds extra requirements while a worker Turn is busy | New input arrives | Steering Input | None | Use explicit [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) for bounded text to the exact running Turn. A Goal card edit is recorded separately on the Goal. |
| Artifact is ready for inspection | Worker emits artifact | Review And Acceptance | Steering Input | Let user accept, refine, redo, export, reuse, or comment. |
| User requests refinement | Artifact is close but incomplete | Review And Acceptance | Steering Input | Start follow-up turn in same thread with accepted context. |
| User requests redo | Attempt is unsatisfactory | Review And Acceptance | Steering Input | Start new attempt in same thread without deleting prior attempt. |
| Budget nearing limit | Usage crosses configured watermark | Steering Input | Elicitation Gate | The owning mode supplies a request-scoped budget constraint to its next Coordinator decision and optionally asks the user for scope or budget choice; no queue record is created. |
| Budget exhausted | No more substantive work allowed | Elicitation Gate | Approval Gate if extension spends quota | Ask the user to wrap up, request an authorized extension, narrow scope, choose a permitted downgrade, or pause where the owning mode supports it. |
| Runtime crashes with checkpoint | Active Turn loses AgentSession continuity | Elicitation Gate | Review And Acceptance | Show product-safe recovery choices and partial Artifacts without exposing AgentSession identity or actions. |
| A crash occurs during a Goal | The Goal record is still the authority | Steering Input | None | A work-intent edit is durable on the Goal. There is no pending-input row to recover. Refused ordinary busy input was not stored; admitted [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) retains its Item and truthful result. |
| Agent configuration becomes incompatible | A later Turn cannot reuse the current AgentSession | Elicitation Gate | Steering Input | Explain product-safe availability and offer only an authorized Turn retry, a new Thread, or an available Agent choice; AgentSession retirement and replacement remain internal. |
| Agent readiness blocked | Agent cannot start | Elicitation Gate | None | Offer switch agent, refresh, fix config, or retry later. |
| Knowledge proposal after task | User or owning service submits an explicit governed proposal command with source references | Review And Acceptance | Elicitation Gate | Let user accept, reject, or defer; changed candidate bytes require a new proposal. |
| External publish action | Agent wants to publish or send output | Approval Gate | Review And Acceptance | User reviews content, then explicitly approves side effect. |
| Automation draft needs confirmation | Scheduled job prepared a follow-up | Review And Acceptance | Approval Gate if external effect | User accepts, edits, rejects, or approves send. |
| Conflicting user instructions | New steering conflicts with prior goal | Elicitation Gate | Steering Input | Ask user to choose which instruction wins. |
| Human accepts known risk | Reviewer flags issue but user wants continue | Approval Gate if policy-sensitive | Review And Acceptance | Record decision and rationale, continue only within policy. |
| User wants long-running work to stop | User asks to pause after a safe point | Steering Input | None | There is no Goal pause command or guaranteed safe-point pause. A text request to wrap up uses [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) and promises only native acceptance. Canceling the Goal, or canceling a card, asks the Task owner to interrupt linked running Tasks. |
| User asks for handoff | User wants different agent or profile | Steering Input | Elicitation Gate if target unclear | Ordinary submission returns `thread_busy` before writes when a Turn is non-terminal. [Task live steer](20260704-task_mode_worker_delegation.md#live-steer) accepts no agent or profile change; worker replacement remains the Task or worker owner's command. |

## Action Center Projection

The Action Center should be a unified attention list.

It should not collapse every row into approval semantics. Every actionable row links to its owning thread, turn, item, artifact, checkpoint, or agent-readiness context.

`packages/app-api-schemas/src/action-center.ts` names `HumanAttentionKind`. Current producers emit `approval`, `question`, `artifact_review`, `workspace_review`, `blocked_turn`, `checkpoint_recovery`, `pending_input`, and `knowledge_review`. `pending_input` is queued scheduler admission. It is not a Goal steering record. `agent_readiness`, `review_cap`, `external_side_effect`, and `budget` are not current produced kinds. `refresh_agent_readiness` and `switch_agent` are not live Action Center effects. The budget path below stays the accepted rule. Projection sources are the pending approval or user-input Item, a queued or denied scheduler admission, a worker checkpoint, a version-owned Artifact Review, a durable Workspace Sync Review, an explicit Knowledge proposal, a Workspace recovery blocker, a rejected worker-control request, and an unresolved scheduler execution attempt.

The same artifact names `HumanAttentionRow`. Its members include `reviewId`, `artifactVersion`, `origin`, `questionSummary`, `ageSeconds`, `turnsSince`, and `blocking`, plus the identity, text, severity, source, and action members. `origin` is the nullable derived attribution object admitted by `HumanAttentionRowSchema`. It is derived from the exact source Turn. Its initiating actor comes from that Turn's `triggerActor`. Missing, oversize, or foreign attribution becomes null. Viewer relationships stay nullable. A question row can carry `questionSummary`: the ordered question text of the canonical `user-input-request` Item, at most 1,024 serialized UTF-8 bytes, with a `truncated` flag. NanoCore sets it only when all of these are true: the pending request record and its request Item do not contradict; no question is secret; the viewer can currently read the exact source Thread. In every other case the value is null. A row carries no prompt, option label, answer value, other Item text, Material bytes, claim field or receipt body. The field does not change whether the row is actionable. `ageSeconds`, `turnsSince`, and `blocking` are derived. They are not a stored deadline. Encoded JSON string bounds are title 512, summary 1,024, recommended action 512, action label 128, and reason 256. Origin actor JSON is at most 512. A truncated summary is not the exact approval effect. Four declared actions have no row builder: `open_turn`, `run_follow_up`, `request_refinement`, and `resume_from_checkpoint`. They are not current row actions.


The explicit V1 self-improvement loop reuses `knowledge_review` for its existing pending Knowledge Proposal. It does not add an `improvement_proposal` attention kind, Harness evidence prerequisite, or parallel approval lifecycle. Proposal reversal remains an owner-local Knowledge operation rather than an Action Center decision kind.

Only rows backed by stable product concepts should expose their product-visible Core IDs. AgentSession identity is excluded from this ordinary App API projection.

An approval row is actionable only when its pending request is `pending`, its request Item is a completed `approval-request` matching the record, and the Approval remains `pending`. A question row is actionable only when its pending request is `pending`, its request Item is a completed `user-input-request` matching the record with unique question ids and no secret question, and no response is recorded. A valid secret question remains visible only as an inspect-only or disabled row with reason `Secret answers require a future Vault-backed input contract.` Actionability never depends on the status of the raising Turn, on a checkpoint, on a worker stop, or on the state of the requesting AgentSession. Missing or contradictory owners may produce an inspect-only recovery row when an owning specification authorizes it, but they MUST NOT produce approval or answer actions. Item absence alone, identifier prefixes, or a missing response projection never proves actionability. This version starts from a new data root and reads no earlier-version gate, as [the engineer decided](../decisions/20260930-earlier_version_data_not_carried.md); that cutover leaves the later data-continuity obligation in place.

Rows backed by app-local runtime state should expose opaque app-local IDs until the shape stabilizes.

Decision cards identify the recorded actor and matching request, distinguish a human decision from a repository-policy grant, and expose the recorded time with its provenance. A request whose raising Turn ended stays pending. An incomplete current-version record stays inspect-only `recovery_required` and is not repaired into a decision. Missing human reasons and client/channel evidence remain explicitly unrecorded; the current browser session cannot supply historical attribution. These are read-only Item projections under the protocol and audit owners, not a new decision ledger.

## Layer Ownership

### `docs/core`

Core docs own the durable semantic rules:

- Steering is active-turn input, not a separate object.
- Review and refinement are normal turns in a thread.
- Approval and user-input requests are pending requests that pause no Turn.
- Human gate UI branches by the request kind and item type.

### `packages/protocol`

The protocol package owns stable schemas for:

- Turn status.
- Approval request and decision items.
- User-input request and response items.
- Artifact reference items.
- Event envelopes and command idempotency.

It should not add `HumanAttentionRow`, review verdicts, or queue records in the first implementation.

### `apps/nanocore`

NanoCore owns app-local runtime behavior:

- Worker turn envelope state.
- Runtime-owned system steering input to the next Coordinator decision.
- No Goal pending-input record. Ordinary busy input returns `409 thread_busy` before writes; live-steer delivery follows [Task live steer](20260704-task_mode_worker_delegation.md#live-steer).
- Runtime checkpoints.
- Budget stop handling.
- Action Center read-model projection.

### `apps/web`

Web owns product rendering:

- Inline approval cards.
- Inline question cards.
- Rejected busy input, which is not rendered as pending.
- Plan approval and completion acceptance rendered as pending requests.
- Artifact review UI.
- Action Center list and filters.
- Checkpoint and recovery projections authorized by their owning specifications.

## Scope

- Pending Request lifecycle and Discord responses belong to [Pending Requests](20260930-pending_requests.md).
- Live worker delivery belongs to [Task mode](20260704-task_mode_worker_delegation.md).
- Review verdict vocabularies belong to storage layout, Workspace sync, and Knowledge governance.
- Goal lifecycle belongs to [Goal](20261002-goal.md).
- Vault secret transport belongs to [Vault](../core/vault.md).

## Implementation

- `apps/nanocore/src/`
- `apps/web/src/`
- `packages/app-api-schemas/src/`
- `packages/core-client/src/`

## Implementation Gaps

- A budget threshold recomputes one request-scoped constraint for the next Coordinator decision - On main, no attention producer builds that path - #784
- A visible secret question states the future Vault reason and stays disabled - On main, the row uses a shorter disabled reason - #733
- Action Center row kinds and members are exactly those a producer emits - On main, the schemas still declare kinds and members that no producer emits - #795

## Decisions

- [Earlier-version data](../decisions/20260930-earlier_version_data_not_carried.md) is not read by this projection.
