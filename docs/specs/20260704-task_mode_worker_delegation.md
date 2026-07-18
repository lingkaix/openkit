# Task Mode Worker Delegation

Status: Accepted
Implementation: Partial

## Owns

- Task Mode as the delegated-work path for bounded, near-term user requests.
- The V1 flow from Assistant or user request to Workflow Coordinator routing, worker selection, thread/turn creation, bounded worker execution, result collection, and user-facing completion.
- The single-worker default delegation contract.
- Task Mode item, artifact, evidence, and Action Center projection requirements.

## Does Not Own

- Chat Mode direct replies or Assistant tool boundaries. `docs/specs/20260704-chat_mode_assistant.md` owns those.
- Goal Mode planning, multi-step objective tracking, and long-running coordination. `docs/specs/20260704-goal_mode_coordination.md` owns those.
- Reusable Workflow Coordinator internals beyond this mode. `docs/specs/20260704-workflow_coordinator_internal_agent.md` owns the Internal Core Role contract.
- Worker runtime communication, control protocol, scheduler, AEP, or workspace sync internals.
- Knowledge Store governance or Knowledge Manager maintenance.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/architecture.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/communication.md`

## Summary

Task Mode is for bounded delegated work: the user asks for a concrete task, NanoCore routes it through Workflow Coordinator, one worker agent performs one bounded execution path by default, and the result is returned with artifacts, evidence, and any pending human attention.

Task Mode is heavier than Chat Mode because it starts worker execution. It is lighter than Goal Mode because it does not require objective negotiation, plan approval, or a long-running multi-step loop unless the request escalates.

## Goals / Non-goals

### Goals

- Make simple delegated work first-class before long-running Goal Mode is needed.
- Keep worker execution traceable through thread, turn, item, artifact, evidence, and agent-session records.
- Let Workflow Coordinator select a worker and compose the semantic worker request while the Task Mode service persists, materializes, and delivers it without exposing adapter-private launch details to product surfaces.
- Return a Task projection derived from the exact Turn, Goal, Item, Artifact, review, evidence, and command-idempotency owners rather than a Task-only record.
- Allow escalation from Task Mode to Goal Mode when the task becomes larger than expected.

### Non-goals

- Do not require explicit plan approval for every Task Mode request.
- Do not run unbounded loops.
- Do not let worker agents write directly to product state outside Core-owned review/apply flows.
- Do not let Assistant bypass Workflow Coordinator to start worker execution.
- Do not support multi-worker orchestration as the default Task Mode path.

## Background

`docs/core/work-model.md` defines Task Mode as delegated work that needs worker-agent execution, progress tracking, artifacts, evidence, or review. `docs/core/agent-workflow.md` says Task Mode should route to Workflow Coordinator and use bounded worker steps when execution is required. Existing worker runtime, control, scheduler, AEP, and workspace sync specs supply the lower-level pieces but do not define the user-facing Task Mode contract.

## Decision

- Task Mode is the default delegated-work path for bounded tasks that do not need explicit plan negotiation.
- Workflow Coordinator owns the bounded routing, worker-selection, and semantic worker-request decision. Task Mode has no durable Task record: the command-idempotency row owns replay, Turn owns execution state, Items and Artifacts own output, review and evidence records own their own decisions, and GoalRecord owns escalation. The Task service validates and applies that owner tuple, persists and delivers context, requests scheduler launch, and projects the result.
- The first Task Mode slice uses one selected worker agent and one bounded worker turn by default.
- Task Mode requires a bounded executable request at entry and may raise existing approval gates during execution. A direct request that still needs clarification returns a typed non-delegation result without a Task Turn; clarification belongs to Chat Mode or a new caller request.
- Task Mode may escalate to Goal Mode when the request becomes multi-step, ambiguous, high-risk, or long-running.

## Contract / Expected Behavior

### Entry points

Task Mode may start from:

- Assistant handoff
- direct product UI or Agent Skill Interface operation
- user request in an existing thread
- a new user request after a prior completed or failed Task attempt

Every direct Task App API entry MUST include and preserve the initiating user request, Workspace id, Thread id or thread creation decision, authenticated actor context, and client-visible `requestId`; `@openkit/core-client` may generate it before sending, but NanoCore rejects a missing id. Direct `task.start` command identity is the command name, actor id, Workspace id, Thread id, and request id. Its canonical input hash covers only the caller-supplied `input` and optional `modelId`; Coordinator output, default-model resolution, eligible-worker snapshots, context selection, and current projections are execution results and MUST NOT be re-resolved before replay lookup. A user correction or retry is an ordinary new Task command with a new request id; the prior attempt remains visible in Thread history, but V1 adds no Task-only refinement, causation, or retry lifecycle. Typed refinement remains owned by Goal Review and Artifact Review where those specifications define it.

NanoCore looks up the direct Task command identity before Coordinator, worker, Goal, or current-state resolution. The same identity and input MUST replay the original Task response or Task-to-Goal escalation under the original Thread, Turn, and Goal lineage. Reusing that identity with different caller input returns `409 idempotency_key_conflict`; neither case may create another Turn, Goal, scheduler admission, or side effect. A worker delegation derives its Task Turn, status Item, and `preparing` checkpoint identities from the immutable command scope and request id; an escalation derives its Goal, objective Turn, objective Item, and Task-to-Goal status Item identities from that same scope. If the complete request-bound `preparing` checkpoint exists with no Turn or admission effect, exact replay may perform the one first launch authorized by S05. For that direct command only, a complete outcome tuple without its `task.start` receipt may publish that receipt; a missing checkpoint with effects, an incomplete checkpoint lineage, a second effect, or any contradictory tuple returns `recovery_required`. An `awaiting_human` Turn with its exact gate and `waiting_for_user` checkpoint is a complete acknowledged Task result and replay never relaunches it. No Task-specific pending command, settlement record, or recovery lifecycle is permitted.

Task terminal closeout uses the same derived classifier during the live request, exact replay, and boot recovery. For a direct Task command, a terminal checkpoint plus complete Turn, Session, canonical StopReason, evidence, review or workspace-handoff when required, backend, lease, and capacity owners may either validate an existing `task.start` receipt or publish that deterministic missing receipt when no Task closeout write exists. A Chat-to-Task attempt instead requires its sole outer Chat or clarification-response receipt; if that receipt is absent, closeout is `recovery_required` and MUST NOT create `task.start`. The classifier clears the checkpoint only after the applicable receipt is durable. Any partial receipt or projection tuple, missing required owner, or conflicting request identity remains discoverable as `recovery_required`; recovery never reruns Coordinator, starts the worker, or invents a Task record.

The complete closeout tuple is backend-specific without weakening its authority. When the Agent Session names an AEP snapshot, closeout MUST validate the exact AEP, accepted worker-control final status, cleaned backend session with complete workspace handoff, terminal scheduler lease and capacity release, Turn and Session state, canonical terminal event, immutable worker-input Item, and checkpoint evidence; absence or contradiction of any owner fails closed. The bounded in-process adapter compromise applies only when the exact Agent Session durably has no AEP snapshot and therefore owns no worker-control or backend-session records: a live or replayed already-terminal checkpoint may close only when its request-bound input Item parses as the accepted structured worker request and hashes to the checkpoint context digest, the exact Agent Session and terminal scheduler lease agree with the Turn and command admission, the canonical event or active Gate agrees with the StopReason, and checkpoint evidence still resolves. Such an adapter checkpoint in `preparing` or `running_worker` cannot be recovered after restart and remains `recovery_required`; the compromise creates no synthetic AEP, final status, backend record, recovery state, or compatibility path.

A direct Task Gate response closes the existing envelope and never calls the adapter to continue worker execution. The exact response command must own one matching `user-input-response` or `approval-decision` Item, clear the Turn Gate, terminalize the same Turn and Agent Session, move the checkpoint to `completed/completed` for an answer or granted approval or to `aborted/aborted` for a denied approval, retain the original `ask_user` request plus response or decision pair in checkpoint evidence, and close the exact scheduler lease and capacity before publishing its receipt. Replay projects a completed envelope with that Gate evidence as Task state `blocked`, with no completion payload, and an aborted denied envelope as `cancelled`; neither claims that the worker itself later returned `completed` or `aborted`. The response receipt is durable before checkpoint deletion, and exact replay may finish only deterministic missing writes under that tuple. The in-process adapter compromise permits this closeout only when the exact Agent Session has no AEP snapshot, no backend session, and no worker-control record. An AEP-backed Gate additionally requires its accepted `ask_user` worker-control record plus existing backend cleanup and workspace-handoff owners; until those owners can prove complete closeout, the command remains `recovery_required`. NanoCore does not synthesize those records, resume the worker Session, or add a Gate settlement owner.

Only that exact Core Gate tuple may project a Task as `awaiting-human`. An AEP accepted raw `blocked/ask_user` final status without an exact Core Gate uses S05's bounded unavailable-transport fallback instead: NanoCore preserves the accepted row, finishes backend cleanup, interrupts the Product Turn with `worker_human_gate_unavailable` and its Agent Session with the same bounded message, leaves the `preparing` checkpoint with null stop reason and worker Session id, releases only the exact matching lease as `released + needs-evidence`, and returns `409 recovery_required`. Task Mode MUST NOT synthesize a Gate, publish a Gate receipt, project `awaiting-human`, offer an answer or approval action, retry, or resume the worker from that tuple.

For Chat-to-Task handoff, the initiating Chat or clarification-response command remains the only ledger owner. Task Mode receives that immutable outer scope and causation, derives the downstream Task tuple from it, and does not publish a nested `task.start` receipt. For Task-to-Goal escalation, the initiating Task command likewise owns the receipt and Goal Mode creates the deterministic Goal tuple without publishing a nested `goal.start` receipt. Direct public Task and Goal requests continue to own their respective command records.

### Routing and worker selection

Workflow Coordinator must produce one `WorkerCoordinatorDecision`. `decision=worker_turn` enters the bounded delegation branch and the Task Mode service projects a `TaskDelegationDecision` containing:

- selected mode: `task`
- worker target id and agent setup summary
- confidence and routing rationale
- required context package references
- required approvals before launch, which is exactly empty in V1
- expected stop condition
- `escalationRecommended=false`; a Goal decision uses the separate escalation branch and returns no Task delegation decision

Rules:

- `decision=goal` enters the Task-to-Goal escalation contract below and creates no Task checkpoint or worker Turn. Any other non-worker decision returns `409 task_mode_not_delegated` before a Task command record, checkpoint, Turn, Goal, or scheduler effect. A direct caller may retry the same request id and input because no command was accepted; a Chat-originated attempt returns control to the outer Chat command, which must persist one clarification or refusal tuple rather than claiming a completed Task handoff.
- If no suitable worker is ready, Task Mode returns `409 task_mode_not_delegated` with a typed readiness diagnostic before writing a command record, checkpoint, Turn, pending Task state, or hidden local execution. Because the rejection owns no durable effect or accepted command, the same request id and input may be tried again after readiness changes; once any Task or Goal tuple is accepted, the normal replay rules apply.
- Before calling Coordinator, the Task Mode service must exclude candidates that fail agent catalog readiness, AEP constraints, workspace policy, runtime placement, or requested-capability eligibility. Coordinator selects only among the supplied eligible readiness summaries; neither boundary may restore an excluded candidate.
- Coordinator must not embed adapter-native launch payloads in product records.
- Direct `task.start` or an explicit Chat handoff authorizes only bounded delegation. It does not pre-authorize credential use, destructive operations, publication, or other governed effects; those use their existing in-Turn approval owners. A Coordinator decision that reports a non-empty prelaunch approval list is invalid for V1 and returns `409 task_mode_not_delegated` under the same no-command, no-effect, direct-retry or outer-Chat rule above.

### Worker execution

- Task Mode creates or reuses a Thread, then writes one `preparing` Worker Checkpoint containing the command request id, canonical input hash, deterministic reserved Turn id, and null Goal and Task ids before launch effects. The worker envelope creates only that Turn and its first scheduler admission; an exact checkpoint with no effects may authorize that one first launch, while a missing or contradictory checkpoint/Turn/admission tuple returns `recovery_required` and never creates a replacement.
- The accepted Task worker input is the complete Coordinator `workerRequest`, never the caller prompt or public Task decision summary. Task Mode sets its exact `reviewContext` field to null, schema-parses the request, and delivers the parsed value as compact JSON through the existing scheduler, AEP, worker, Turn, and `user-message` Item path defined by S15. This text-adapter compromise adds no Task payload row or delivery workflow.
- A direct Task has no approved Goal Task snapshot, so its fixed Coordinator defaults are part of this contract rather than caller-controlled pseudo-Task state: `acceptanceCriteria=['The bounded worker task satisfies the requested objective.', 'The worker reports verification evidence or a clear blocker.']`; `resources=[]`; `expectedArtifacts=[{ kind: 'code-change', description: 'Focused workspace changes needed to satisfy the objective.' }, { kind: 'test-result', description: 'Verification evidence from the focused checks.' }]`; `constraints={ maxContextTokens: 240000, maxWorkerIterations: 1 }`; `verification=[{ kind: 'manual', description: 'Run the checks named by the worker task or explain why they cannot run.' }]`; `reviewPolicy={ required: false, reviewers: ['human'], instructions: 'Review the worker result, changed files, and verification evidence.' }`; `escalationConditions=['Escalate if repository setup is missing or invalid.', 'Escalate if the task requires broader decomposition.']`; and `reviewContext=null`. The request contains no `requiresUserConfirmation` or generic stop-condition field; Task Mode has no Task Review producer or hidden completion gate, while independent Artifact, workspace, and governed-effect reviews retain their existing owners.
- Worker execution must use the AEP, static workspace materialization, context package, vault injection, and capability gateway contracts where applicable.
- The worker may produce artifacts, evidence, workspace sync reviews, Action Center rows, and final status.
- Sensitive actions still require the relevant approval and permission decisions.

### Completion states

Task Mode runs exactly one worker Turn with `remainingWorkerIterations=0`. Its state is a projection over the Turn, checkpoint, final-status availability, and evidence, not a second durable lifecycle:

| Projected state | Required owner tuple |
| --- | --- |
| `running` | The request-bound checkpoint is `preparing` or `running_worker` and the exact Task Turn is pending or running. |
| `completed` | The Turn and terminal checkpoint prove `stopReason=completed`; unresolved Artifact or Workspace reviews remain independently visible and do not rewrite Task state. |
| `awaiting-human` | The Turn is `awaiting_human` on its exact user-input or approval gate and the checkpoint is `waiting_for_user`; this is an acknowledged command result. The gate response Item attaches to this same Turn, which resumes only to close the old envelope under S05; further worker execution requires an ordinary new `task.start` command rather than Session resume. |
| `blocked` | Terminal evidence proves `length` or `budget_exhausted`; an answered `ask_user` envelope is closed but no new Task command exists; or no accepted final status exists and the exact scheduler-cleanup, interrupted Turn and Session, and nonterminal checkpoint predicate exposes interrupted-worker recovery. That last case is recoverable interruption projection, not terminal closeout. |
| `cancelled` | The Turn is cancelled or an accepted worker-control final status canonicalizes to `aborted`, including raw `status=interrupted` with raw `stopReason=aborted`. |
| `failed` | Terminal evidence proves `error` and the Turn carries typed failure diagnostics. |
| `escalated-to-goal` | No Task worker Turn starts; the outer command record, GoalRecord, objective Turn and Item, and Task-to-Goal status Item name one exact escalation lineage. |

A completed Turn without matching terminal stop evidence is incomplete, not `completed`. A lower-level `continue` outcome is invalid because V1 has no second Task iteration; it returns `task_stop_decision_invalid` without another Turn, checkpoint, or scheduler admission.

`needs-review` is not a V1 Task state. Review remains an independent durable review record and Action Center projection so Task Mode does not invent another review authority.

### Escalation to Goal Mode

Task Mode should escalate when:

- the worker identifies multiple dependent steps
- the task requires plan approval
- the task becomes high-risk or expensive
- the task needs multiple workers or long-running coordination
- the user asks to turn the task into a broader objective

Escalation must preserve the Task Mode history as input to the new Goal Mode objective and plan draft.

### Command response and replay authority

The public Task response is a projection of existing business owners, not a durable Task record and not a copy of the Workflow Coordinator decision. `StartTaskModeResponse` contains the response Turn, its owner-derived state, optional completion from the completed assistant Item, current Item, Artifact, and Review evidence identifiers, and an optional Goal escalation derived from the Goal record and its creation and status Items. The full `TaskDelegationDecision` is an internal launch input that must be persisted and delivered through the accepted worker-request and Context Package owners; it MUST NOT be copied into the command receipt or exposed as an otherwise unowned replay payload.

`task.start` uses ordinary current-resource replay and stores no payload snapshot. Its ledger row contains only the normal command metadata and the original response Turn identifier. On replay, NanoCore validates that Turn against the receipt Workspace and Thread. A Goal whose `createdByItemId` resolves to that Turn, together with the deterministic Task-to-Goal status Item, owns an `escalated-to-goal` projection; otherwise the existing bounded worker Turn owns the Task state, completion, and current evidence projection. Missing or contradictory Turn, Item, or Goal lineage returns `409 recovery_required`; replay never reruns Coordinator, launches another worker, or creates another Goal. Because this is a current-owner projection, later legitimate Turn progress may advance `state`, `completion`, and evidence while retaining the original lineage.

## Accepted Design

Task Mode composes existing lower-level services: Assistant or UI entry, Workflow Coordinator decision, context package assembly, scheduler placement, worker control, workspace sync/review/apply, Action Center, and evidence records. NanoCore should implement this as a thin workflow service over those contracts rather than a separate runtime.

## Current Implementation Projection

NanoCore now has the first distinct Task Mode App API contract and bounded worker-launch path. `@openkit/app-api-schemas` defines `StartTaskModeRequestSchema`, the internal launch projection `TaskDelegationDecisionSchema`, and `StartTaskModeResponseSchema`; `@openkit/core-client` exposes `client.app.startTaskMode`; the unified `openkit` Skill exposes the `task.start` bundled-CLI operation; and NanoCore serves `POST /api/app/workspaces/:workspaceId/threads/:threadId/task`.

The route runs the rule-based Workflow Coordinator before launch, rejects non-worker decisions or a worker decision whose required action is not `none` with typed `task_mode_not_delegated` instead of falling back to hidden local execution, and starts one bounded worker turn through the existing durable scheduler, worker startup, AEP, repository workspace, sourceRef, and turn evidence paths. Coordinator now returns `requiredUserAction=none` for an accepted worker Turn, so the internal Task projection no longer launders an unowned confirmation into an empty approval list. Chat Mode task handoff reuses this same Task Mode attempt path after the Assistant receives a Coordinator worker decision, so Assistant-originated bounded tasks no longer stop at a status-only projection. In the first Knowledge Manager integration slice, matching workspace knowledge becomes `knowledge` refs alongside the default Workspace and Thread refs. Direct Task and Chat-to-Task now schema-parse the complete Coordinator request with `reviewContext=null`, serialize it as compact JSON, and deliver those exact bytes through the scheduler, AEP, worker input, Turn input, and Turn-owned `user-message` Item. This proves reference-level request delivery; materialized Knowledge content and the immutable Context Package trace remain incomplete.

Task Mode now also escalates obvious Goal Mode requests before worker launch. The public Task Mode route creates a durable Goal Mode objective through the same Goal Mode start path, writes a visible status item, returns `state: escalated-to-goal` with a typed Goal escalation projection, and does not start a worker turn before Goal Mode planning or explicit bounded steps.

Historical deterministic L6 evidence covered the Task Mode entry point, a bounded approval Gate, Gate closeout without worker resume, exact blocked replay, and Task-to-Goal escalation without requiring real provider quota, real Codex credentials, or a live OpenShell worker backend. The retired MCP-only story is not an active release gate; the unified Skill contract covers `task.start`, while lower-layer tests retain the Task and Gate invariants. The historical evidence rejects the former simulator-only sequence that continued through a second question Gate into an Artifact. Completed worker results still project the final completed `assistant-message` as `completion.itemId` and `completion.text`; paused or Gate-closed blocked attempts keep `completion: null`. Task Mode evidence remains a projection of existing Turn Item, Artifact, and Workspace Review owners rather than a Task-only evidence store.

The opt-in real OpenShell/Codex L6 story `tests/stories/task-mode-real-worker-release.story.md` validates the real worker path against an existing NanoCore deployment. Its runner requires explicit real-worker and provider-quota opt-in, links a disposable repository through the public Core Client, invokes `client.app.startTaskMode`, requires owner-derived `completed` Task state, treats any returned reviews only as independent cleanup work, requires visible thread items, requires at least one completed assistant-message item from the worker path, and writes only redacted evidence. This runner proves the worker integration boundary; the unified Skill and `task.start` CLI projection are covered separately and do not require a duplicate real-worker runner. The a1 acceptance run passed against NanoCore on `http://127.0.0.1:54001` with `openkit/worker-codex:dev`, Codex auth/config injection, model `gpt-5.5`, and a real OpenShell sandbox. Worker-shim failure transcripts now preserve redacted stdout/stderr diagnostics for failed Codex launches, and NanoCore retries transient OpenShell provider detach conflicts so cleanup races do not mask worker outcomes.

The current direct `task.start` path derives its Turn and downstream scheduler lineage from the complete command identity, writes the request id and canonical caller-input hash into the existing checkpoint before launch, delivers the complete structured Coordinator worker request through the Turn-owned input Item, and validates replay or missing-receipt recovery against that Item, checkpoint, Turn, Agent Session, agent, lease, canonical event, evidence, and backend-specific closeout tuple. Exact receipt replay and owner-without-receipt classification do not rerun Coordinator or the worker; contradictory input, an incomplete owner tuple, or an unsafe receipt gap fails closed as `recovery_required`. Online and restart WorkerGovernance closeout preserve the same accepted non-Gate canonical outcome instead of laundering every non-completed worker status into `error`.

Direct Task structured user-input and approval Gates now use the exact shared closeout: the response or decision Item closes the old Turn and Session without adapter continuation, retains the Gate pair as evidence, applies the fixed Task projection, releases scheduler ownership, publishes the response receipt, and only then permits checkpoint deletion. This works for the bounded in-process tuple and for an AEP-backed Gate only when its accepted final status, backend cleanup, workspace handoff, and full Gate lineage agree. A raw AEP `blocked/ask_user` without an exact Core Gate takes the bounded S05 interruption fallback and remains `recovery_required`; it is not converted into a Task Gate. Partial or contradictory Gate writes remain inspectable as `recovery_required`, not repair instructions.

Boot now fences scheduler and worker-control state before scanning direct Task checkpoints with the same owner classifier used online. It closes or cleans only a complete direct-command tuple, preserves live or reconnecting work, and leaves every missing, conflicting, outer-command, or otherwise unprovable tuple discoverable while readiness reports `recovery_required`. This specification remains Partial because accepted Context Package trace materialization and complete Knowledge content delivery are still incomplete. Those gaps must reuse the named owners and may not add a Task row, settlement workflow, compatibility path, or Task-specific recovery state.

## Alternatives Considered

- Use Goal Mode for every delegated task. Rejected: simple tasks should not require plan approval and objective lifecycle overhead.
- Let Assistant start worker turns directly. Rejected: worker delegation belongs to Workflow Coordinator.
- Support multi-worker task orchestration in V1 Task Mode. Rejected: multi-worker coordination belongs to Goal Mode unless a future accepted task recipe needs it.

## Consequences

- Users get a direct path from request to worker result for ordinary delegated work.
- Goal Mode remains reserved for larger objectives.
- Task Mode creates a clear implementation target for worker delegation before full long-running coordination.

## Testing Strategy / Acceptance Criteria

- L1: routing and worker-selection unit tests.
- L2: contract tests for `TaskDelegationDecision`, required request identity, item projection, exact owner-derived states, and absence of a Task-only state or review record.
- L3: NanoCore black-box test for direct Task Mode execution with one deterministic worker.
- L3: prove the exact Coordinator-composed worker request and authorized context references reach the materialized worker input.
- L3: same-request replay returns the original Task or escalated Goal lineage, including the original scheduler admission or Goal records, while a conflicting payload returns `idempotency_key_conflict` and neither path duplicates effects.
- L3: escalation test from Task Mode to Goal Mode.
- L6: story acceptance where a user delegates a bounded task, sees worker progress, reviews output, and receives a final answer.

Acceptance: Task Mode always runs through Workflow Coordinator for bounded worker execution, escalates explicit Goal Mode work through the durable Goal Mode objective path, records visible state, and never silently becomes Goal Mode or hidden local execution.

## Risks & Mitigations

- Risk: Task Mode grows into an unbounded loop. Mitigation: one bounded worker attempt by default and explicit escalation to Goal Mode.
- Risk: Coordinator selection becomes opaque. Mitigation: record routing rationale and selected worker summary.
- Risk: simple task failures are hard to recover. Mitigation: stable completion states and Action Center recovery rows.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: Task Mode performs no automatic worker retry. A user-requested retry is an ordinary new Task invocation with a new request id and Turn, and the prior attempt remains unchanged in Thread history; there is no hidden replay, Session resume, Task-specific causation record, or retry lifecycle. Task Mode reuses the active Thread when started from Chat Mode unless the user explicitly requests a new Thread or policy requires isolation.

## Deferred / Future Work

- Multi-worker Task Mode recipes.
- Task templates.
- Automatic task decomposition without Goal Mode.
- Task-level saved presets.

## Links

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-workspace_synchronization.md`
