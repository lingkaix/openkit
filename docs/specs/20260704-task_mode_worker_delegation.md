# Task Mode Worker Delegation

Status: Accepted
Implementation: Implemented

## Owns

- Task Mode as the delegated-work path for bounded, near-term user requests.
- The V1 flow from Assistant or user request to Workflow Coordinator routing, worker selection, thread/turn creation, bounded worker execution, result collection, and user-facing completion.
- The single-worker default delegation contract.
- Task Mode item, artifact, evidence, and Action Center projection requirements.

## Does Not Own

- Chat Mode direct replies or Assistant tool boundaries. `docs/specs/20260704-chat_mode_assistant.md` owns those.
- Goal Mode planning, multi-step objective tracking, and long-running coordination. `docs/specs/20260704-goal_mode_coordination.md` owns those.
- Reusable Workflow Coordinator internals beyond this mode. `docs/specs/20260704-workflow_coordinator_internal_agent.md` owns the internal agent contract.
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
- Let Workflow Coordinator select a worker and assemble context without exposing adapter-private launch details to product surfaces.
- Return a clear completion, blocked, failed, or needs-review state.
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
- Workflow Coordinator owns Task Mode routing and worker delegation.
- The first Task Mode slice uses one selected worker agent and one bounded worker turn by default.
- Task Mode may ask clarifying questions before execution and may raise approval gates during execution.
- Task Mode may escalate to Goal Mode when the request becomes multi-step, ambiguous, high-risk, or long-running.

## Contract / Expected Behavior

### Entry points

Task Mode may start from:

- Assistant handoff
- direct product UI or AI Interface command
- user request in an existing thread
- retry, refinement, or handoff from a prior completed or failed task

Every entry must preserve the initiating user request, workspace id, thread id or thread creation decision, actor context, and request id for idempotency.

### Routing and worker selection

Workflow Coordinator must produce a `TaskDelegationDecision` containing:

- selected mode: `task`
- worker target id and agent setup summary
- confidence and routing rationale
- required context package references
- required approvals before launch, if any
- expected stop condition
- whether escalation to Goal Mode is recommended instead

Rules:

- If no suitable worker is ready, Task Mode must fail or wait with a typed readiness diagnostic instead of falling back to hidden local execution.
- Worker selection must respect agent catalog readiness, AEP constraints, workspace policy, runtime placement, and requested capabilities.
- Coordinator must not embed adapter-native launch payloads in product records.

### Worker execution

- Task Mode creates or reuses a thread, creates a worker turn, and launches one bounded worker step through the scheduler and worker control contracts.
- Worker execution must use the AEP, static workspace materialization, context package, vault injection, and capability gateway contracts where applicable.
- The worker may produce artifacts, evidence, workspace sync reviews, Action Center rows, and final status.
- Sensitive actions still require the relevant approval and permission decisions.

### Completion states

Task Mode must end each bounded attempt in one of these visible states:

- `completed`: worker delivered the requested result.
- `needs-review`: output, artifact, diff, or evidence requires user review.
- `awaiting-human`: the turn is paused on approval, question, or recovery choice.
- `blocked`: the task cannot continue without a missing dependency or unsupported capability.
- `failed`: execution failed with typed diagnostics.
- `escalated-to-goal`: the task was promoted to Goal Mode.

### Escalation to Goal Mode

Task Mode should escalate when:

- the worker identifies multiple dependent steps
- the task requires plan approval
- the task becomes high-risk or expensive
- the task needs multiple workers or long-running coordination
- the user asks to turn the task into a broader objective

Escalation must preserve the Task Mode history as input to the new Goal Mode objective and plan draft.

## Accepted Design

Task Mode composes existing lower-level services: Assistant or UI entry, Workflow Coordinator decision, context package assembly, scheduler placement, worker control, workspace sync/review/apply, Action Center, and evidence records. NanoCore should implement this as a thin workflow service over those contracts rather than a separate runtime.

## Current Implementation Projection

NanoCore now has the first distinct Task Mode App API contract and bounded worker-launch path. `@openkit/app-api-schemas` defines `StartTaskModeRequestSchema`, `TaskDelegationDecisionSchema`, and `StartTaskModeResponseSchema`; `@openkit/core-client` exposes `client.app.startTaskMode`; `@openkit/mcp` exposes `openkit.start_task`; and NanoCore serves `POST /api/app/workspaces/:workspaceId/threads/:threadId/task`.

The route runs the rule-based Workflow Coordinator before launch, rejects non-worker decisions with typed `task_mode_not_delegated` instead of falling back to hidden local execution, projects a Task Mode delegation decision, and starts one bounded worker turn through the existing durable scheduler, worker startup, AEP, repository workspace, sourceRef, and turn evidence paths. Chat Mode task handoff reuses this same Task Mode attempt path after the Assistant receives a Coordinator worker decision, so Assistant-originated bounded tasks no longer stop at a status-only projection. The delegation decision includes the Coordinator-selected context refs. In the first Knowledge Manager integration slice, matching workspace knowledge becomes `knowledge` refs alongside the default workspace and thread refs, so callers can inspect which accepted knowledge entries influenced the bounded worker delegation without seeing restricted payloads.

Task Mode now also escalates obvious Goal Mode requests before worker launch. The public Task Mode route creates a durable Goal Mode objective through the same Goal Mode start path, writes a visible status item, returns `state: escalated-to-goal` with `decision: null` and a typed Goal escalation projection, and does not start a worker turn before Goal Mode planning or explicit bounded steps.

The deterministic L6 MCP story `tests/stories/task-mode-mcp-smoke.story.md` now covers the Task Mode MCP entry point, a bounded self-check worker path, Action Center approval/question gates, artifact completion, and Task-to-Goal escalation without requiring real provider quota, real Codex credentials, or a live OpenShell worker backend. Task Mode responses now project state from the latest stored turn after the worker executor returns, so synchronous bounded completions surface as `completed` instead of stale `running`. Completed public Task Mode responses also project the final completed `assistant-message` item as `completion.itemId` and `completion.text`, reusing the existing thread item backbone instead of adding a Task-only result model; paused turns keep `completion: null` so progress is not mislabeled as terminal output. Task Mode responses now also project `evidence.itemIds`, `evidence.artifactIds`, and `evidence.reviewIds` from the existing turn, artifact, and staged workspace review records, so App API and MCP callers can follow the stable thread, artifact, and workspace review APIs for review evidence without a Task-only evidence store.

The opt-in real OpenShell/Codex L6 story `tests/stories/task-mode-real-worker-release.story.md` now validates the real worker path against an existing NanoCore deployment. Its runner requires explicit real-worker and provider-quota opt-in, links a disposable repository through MCP, calls `openkit.start_task`, requires an accepted Task Mode state, requires visible thread items, requires at least one completed assistant-message item from the worker path, and writes only redacted evidence. The a1 acceptance run passed against NanoCore on `http://127.0.0.1:54001` with `openkit/worker-codex:dev`, Codex auth/config injection, model `gpt-5.5`, and a real OpenShell sandbox. Worker-shim failure transcripts now preserve redacted stdout/stderr diagnostics for failed Codex launches, and NanoCore retries transient OpenShell provider detach conflicts so cleanup races do not mask worker outcomes.

## Alternatives Considered

- Use Goal Mode for every delegated task. Rejected: simple tasks should not require plan approval and objective lifecycle overhead.
- Let Assistant start worker turns directly. Rejected: worker delegation belongs to Workflow Coordinator.
- Support multi-worker task orchestration in V1 Task Mode. Rejected: multi-worker coordination belongs to Goal Mode unless a future accepted task recipe needs it.

## Consequences

- Users get a direct path from request to worker result for ordinary delegated work.
- Goal Mode remains reserved for larger objectives.
- Task Mode creates a clear implementation target for worker delegation before full long-running coordination.

## Rollout / Migration Plan

1. Add `TaskDelegationDecision` tests and schema.
2. Implement Coordinator routing from Assistant handoff or direct request.
3. Launch one bounded worker turn through existing scheduler and worker control contracts.
4. Project completion states and evidence into the thread and App API.
5. Add escalation to Goal Mode after Goal Mode coordination contract is available.

## Testing Strategy / Acceptance Criteria

- L1: routing and worker-selection unit tests.
- L2: contract tests for `TaskDelegationDecision`, item projection, idempotency, and completion states.
- L3: NanoCore black-box test for direct Task Mode execution with one deterministic worker.
- L3: escalation test from Task Mode to Goal Mode.
- L6: story acceptance where a user delegates a bounded task, sees worker progress, reviews output, and receives a final answer.

Acceptance: Task Mode always runs through Workflow Coordinator for bounded worker execution, escalates explicit Goal Mode work through the durable Goal Mode objective path, records visible state, and never silently becomes Goal Mode or hidden local execution.

## Risks & Mitigations

- Risk: Task Mode grows into an unbounded loop. Mitigation: one bounded worker attempt by default and explicit escalation to Goal Mode.
- Risk: Coordinator selection becomes opaque. Mitigation: record routing rationale and selected worker summary.
- Risk: simple task failures are hard to recover. Mitigation: stable completion states and Action Center recovery rows.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: Task Mode allows at most one automatic retry for typed transient worker failures and records the retry reason; Task Mode reuses the active thread when started from Chat Mode unless the user explicitly requests a new thread or the Coordinator must isolate the work for policy, visibility, or recovery reasons.

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
