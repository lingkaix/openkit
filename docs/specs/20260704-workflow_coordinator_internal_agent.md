# Workflow Coordinator Internal Agent

Status: Accepted
Implementation: Implemented

## Owns

- The reusable Workflow Coordinator internal-agent contract.
- Request classification across Chat Mode handoff, Task Mode, Goal Mode, review, refinement, retry, and unsupported requests.
- Worker selection, routing decisions, delegation drafts, plan drafts, context assembly coordination, stop decisions, and escalation rules.
- The Coordinator interface to Knowledge Manager and worker execution services.

## Does Not Own

- User-facing mode semantics. `docs/core/work-model.md` and the mode specs own those projections.
- Core Assistant direct replies. `docs/specs/20260704-chat_mode_assistant.md` owns those.
- Knowledge Manager runtime behavior. `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` owns that role.
- Worker runtime control, scheduler, AEP, context package file format, workspace sync, or Git write execution.
- Future Task Evaluator behavior.

## Core References

- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/work-model.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/knowledge.md`
- `docs/core/permissions.md`

## Summary

Workflow Coordinator is the internal Core agent that turns user intent into governed worker execution. It classifies requests, chooses the appropriate mode, selects worker agents, requests knowledge material, assembles bounded worker context, drafts plans, advances Goal Mode steps, and records stop decisions.

It is not a worker runtime. It does not execute shell commands, edit files, push commits, or maintain the Knowledge Store directly. It coordinates NanoCore services and worker agents through existing contracts.

## Goals / Non-goals

### Goals

- Give Task Mode and Goal Mode one shared routing and coordination brain.
- Make Coordinator decisions structured, testable, and explainable.
- Keep context assembly explicit and source-traceable.
- Prevent mode-specific implementations from inventing parallel worker-selection or routing logic.
- Keep heavy execution delegated to worker agents.

### Non-goals

- Do not build a graph runtime, swarm planner, or generic agent framework.
- Do not let Coordinator bypass scheduler, worker control, permissions, vault, Action Center, or workspace sync.
- Do not let Coordinator write files or commit/push directly.
- Do not make Coordinator the Knowledge Manager.
- Do not require ML-based dynamic planning in V1.

## Background

`docs/core/architecture.md` defines Workflow Coordinator as the internal role for non-trivial worker-agent work. `docs/core/agent-workflow.md` says it selects workflow modes or recipes, prepares plans, advances bounded steps, chooses worker agents, assembles context, handles gates, collects evidence, and decides whether to continue, refine, retry, hand off, pause, block, accept, or close.

The missing contract is the implementation-facing interface shared by Task Mode and Goal Mode.

## Decision

- Workflow Coordinator is an internal NanoCore agent.
- It produces structured decisions that are validated before execution.
- Mode services call Coordinator; Coordinator does not own product routes by itself.
- Coordinator may call Knowledge Manager for source-traceable material, but Coordinator owns final worker-context assembly.
- Coordinator may recommend Task Mode or Goal Mode, but mode services own the durable mode records.

## Contract / Expected Behavior

### Coordinator inputs

Coordinator input must include:

- workspace id
- thread id when available
- initiating user request or system trigger
- current mode and goal/task state when available
- relevant thread summary
- available worker agents and readiness summaries
- policy and permission summaries
- context constraints and explicit user constraints
- request id

Input must not include raw secrets, full unrestricted workspace files, raw backend handles, or adapter-native launch payloads.

### Request classification

Coordinator must classify requests into:

- `chat-answer-possible`
- `task`
- `goal`
- `clarify`
- `review`
- `refine`
- `retry`
- `handoff`
- `unsupported`
- `blocked`

Classification must include rationale, confidence, and required next action.

### Worker selection

Worker selection must consider:

- agent catalog entries and readiness
- runtime placement and scheduler availability
- requested capabilities
- workspace roots and static workspace materialization constraints
- policy and permission requirements
- prior task or goal context
- user-selected agent preference when present

The selected worker summary may be product-visible. Adapter-native launch payloads must remain internal to the owning runtime contracts.

### Context assembly coordination

- Coordinator requests source-traceable knowledge or source material from Knowledge Manager when useful.
- Coordinator combines task instructions, goal state, thread summary, explicit constraints, artifacts, knowledge material, capability availability, stop condition, and review policy into the final worker context.
- The context package remains a data projection, not an internal agent.
- Coordinator must record enough context references for replay and audit without storing restricted payloads in public rows.

### Output records

Coordinator may produce:

- `RoutingDecision`
- `TaskDelegationDecision`
- `GoalPlanDraft`
- `GoalStepDecision`
- `WorkerDelegationDraft`
- `ContextAssemblySummary`
- `StopDecision`

Every output must be schema-versioned, scoped to workspace/thread, and linked to the originating request id.

### Stop decisions

After a worker step or planning phase, Coordinator must choose one:

- continue
- ask user
- request approval
- review output
- retry
- hand off
- pause
- block
- complete
- fail
- escalate to Goal Mode

The decision must cite evidence or diagnostics when available.

## Accepted Design

Implement Coordinator as a small app-local service with typed input/output schemas and narrow service dependencies: worker catalog/readiness, Knowledge Manager query, context package builder, scheduler launch service, Goal Mode service, Task Mode service, Action Center projection, and evidence reader. Keep prompts and model calls behind a direct coordinator runtime wrapper; do not add a generic agent framework in V1.

## Current Implementation Projection

NanoCore now has the implemented V1 rule-based Workflow Coordinator internal agent slice. `apps/nanocore/src/internal-agents/worker-coordinator.ts` defines the WorkerCoordinatorAgent identity, tool allowlist, structured decision schema, worker readiness input, deterministic classification, worker selection, delegation draft, and structured worker request shape. The internal-agent registry and runner validate structured WorkerCoordinatorAgent output, and the product mode path maps delegation through WorkerCoordinatorAgent before worker execution. Vague prompts such as "Help" produce a structured `clarify` decision, Goal Mode planning prompts produce a structured `goal` decision, worker-required requests with no ready Codex or OpenCode candidate produce a structured `blocked` decision instead of collapsing into `unsupported`, retry prompts such as "Retry the previous worker turn" produce a structured `retry` decision with confirmation required, and review, refinement, handoff, unsupported, quick-chat, and worker-turn decisions all stay structured without selecting a worker unless the decision is an actual worker turn.

Task Mode now consumes this slice through `POST /api/app/workspaces/:workspaceId/threads/:threadId/task`: NanoCore calls the Coordinator before launch, rejects non-worker decisions, projects a Task Mode `TaskDelegationDecision`, and starts the selected worker through the durable scheduler. The Task Mode path also prepares source-traceable context refs from Knowledge Manager when workspace knowledge matches the task prompt, passes those refs through the Coordinator delegation draft and structured worker request, and exposes the selected refs in the Task Mode App API decision. This proves the first Task Mode consumer of the Coordinator contract and the first Knowledge Manager integration point for bounded worker delegation.

Goal Mode now consumes this slice for plan drafting, real worker steps, context assembly summaries, post-worker stop decisions, and worker recovery visibility. `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan` returns a Workflow Coordinator planner summary with `mode: goal`, `sourceAgentId: worker-coordinator`, confidence, rationale, context refs, and `plan_approval` as the required approval while keeping deterministic V1 plan text. `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/step` asks the Coordinator to select the bounded worker before launch, exposes the same delegation decision shape with `mode: goal` in the step response, returns a context assembly summary with package digest, selected context refs, repository resource id, and queued steering or follow-up counts, and returns a schema-versioned Coordinator stop decision with request id, source agent id, rationale, context refs, stop reason, outcome, and evidence refs. Non-completed worker checkpoints preserve the same context assembly summary for recovery diagnostics and surface typed `inspect`, `record_terminal`, and `request_human` choices through the App API, `@openkit/core-client`, and `@openkit/mcp`. Runtime config stale-session diagnostics now surface typed `inspect`, `restart_session`, and `request_human` choices through the existing diagnostics read model, keeping stale-session visibility on the same public diagnostics path instead of adding a parallel Coordinator recovery tool.

Chat Mode now consumes this slice for explicit Assistant handoffs. Bounded worker requests create a Task Mode handoff through Workflow Coordinator and longer-running requests create a Goal Mode handoff from the Coordinator's `goal` decision through the shared Goal Mode objective path; `@openkit/mcp` exposes this entry through `openkit.start_chat`. When Coordinator returns a non-quick-chat decision that does not select a worker turn, such as `clarify`, `blocked`, `retry`, `review`, `refinement`, `handoff`, or `unsupported`, Chat Mode records a refused status item with the Coordinator explanation instead of falling through to Knowledge Manager or provider-backed quick chat. The deterministic Chat Mode MCP L6 story covers both paths: Task handoff creates the visible status item, starts bounded worker progress, and exposes the worker approval gate, while Goal handoff creates a durable planning goal.

The implementation is now complete for the accepted V1 contract. Dynamic planning, multi-worker graph planning, Task Evaluator integration, and workspace-authored workflow recipes remain deferred future work rather than blockers for the V1 Coordinator contract.

## Alternatives Considered

- Encode routing separately in each mode. Rejected: Task Mode and Goal Mode would drift and duplicate worker selection.
- Make Coordinator a user-selectable agent. Rejected: it is a Core coordination role, not worker supply.
- Use deterministic rules only. Rejected as a complete solution: rules are useful guards, but natural language user intent requires an internal agent path. Deterministic validation still gates its outputs.

## Consequences

- Task Mode and Goal Mode share one coordination contract.
- Internal-agent behavior becomes testable through structured outputs.
- The first slice must define enough schemas before route implementation can be clean.

## Rollout / Migration Plan

1. Add schemas and unit tests for routing, delegation, plan, context summary, and stop decisions.
2. Wire Task Mode routing to Coordinator.
3. Wire Goal Mode plan drafting and step selection to Coordinator. Done for real worker-step selection.
4. Add Knowledge Manager query integration. Done for Task Mode context refs.
5. Add evidence-backed stop decisions after worker steps. Done for Goal Mode worker steps.
6. Wire Assistant handoff through Coordinator. Done for the V1 Chat-to-Task and Chat-to-Goal paths.

## Testing Strategy / Acceptance Criteria

- L1: schema validation and classification tests.
- L1: worker-selection tests across unavailable, denied, unsuitable, and preferred worker cases.
- L2: contract tests for Coordinator outputs consumed by Task Mode and Goal Mode.
- L3: NanoCore black-box tests for Task Mode delegation and Goal Mode plan/step using Coordinator outputs.
- L6: story acceptance where a user request moves through Assistant, Coordinator, worker execution, evidence, and final result.

Acceptance: Coordinator decisions are structured, validated, traceable, and cannot bypass Core-owned scheduler, permission, vault, worker control, context, or review contracts.

## Risks & Mitigations

- Risk: Coordinator output becomes too free-form. Mitigation: schema-versioned outputs and deterministic validation before execution.
- Risk: Coordinator hides important reasoning. Mitigation: record concise rationale and evidence references.
- Risk: Coordinator over-calls workers. Mitigation: Assistant handles Chat Mode and Coordinator must classify low-confidence cases as clarify or goal planning.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the Coordinator uses one internal model profile for routing and planning until real usage justifies separate cheap-routing and stronger-planning profiles; Coordinator rationale is diagnostics-only by default, while user-visible surfaces may show a concise routing summary without exposing private chain-of-thought, ranking details, or policy-sensitive context.

## Deferred / Future Work

- Dynamic planning from history and measured outcomes.
- Multi-worker graph planning.
- Task Evaluator integration.
- Workspace-authored workflow recipes.

## Links

- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
