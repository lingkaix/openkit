# Goal Mode Coordination

Status: Accepted
Implementation: Partial

## Owns

- Goal Mode as the V1 long-running objective-driven workflow mode.
- Objective intake, plan drafting, plan approval, bounded steps, review state, steering, evidence, and terminal status.
- Coordinator responsibilities for multi-step and potentially multi-worker execution.
- Goal Mode projection over thread, turn, item, Action Center, artifact, evidence, and worker state.
- The relationship between Goal Mode and Chat Mode or Task Mode escalation.

## Does Not Own

- Chat Mode direct replies. `docs/specs/20260704-chat_mode_assistant.md` owns that path.
- Bounded single-worker Task Mode delegation. `docs/specs/20260704-task_mode_worker_delegation.md` owns that path.
- Workflow Coordinator internal schemas that are reusable across modes. `docs/specs/20260704-workflow_coordinator_internal_agent.md` owns those.
- Agent Skill Interface operation schemas and loop guidance. `docs/specs/20260713-openkit_agent_skill_interface.md` owns that channel projection.
- Human Attention gate mechanics, worker reliability envelope, scheduler internals, or workspace sync internals.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/architecture.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/agent-session.md`
- `docs/core/audit.md`

## Summary

Goal Mode is the V1 mode for long-running, ambiguous, high-risk, multi-step, or multi-agent objectives. It starts from a user objective, works out a plan with the user when needed, runs bounded worker steps through Workflow Coordinator, collects evidence and review state, and continues until the goal is completed, blocked, cancelled, or explicitly paused.

Goal Mode must not become an invisible autonomous loop. It advances through explicit plans, bounded steps, visible progress, human attention gates, evidence, and stop decisions.

## Goals / Non-goals

### Goals

- Make long-running objectives first-class and durable.
- Require plan drafting and approval when the goal needs explicit sequencing or risk control.
- Support multiple bounded worker steps and, when needed, multiple worker agents.
- Keep user steering and human decisions visible and auditable.
- Preserve enough evidence to review and resume a goal after interruption.

### Non-goals

- Do not create unattended recursive self-improvement.
- Do not bypass Action Center, plan approval, permission gates, artifact review, repository readiness, or Git approval gates.
- Do not require every Goal Mode step to be planned in maximal detail upfront.
- Do not make Goal Mode a separate runtime or worker agent.
- Do not put raw adapter state, raw worker checkpoints, or backend-native task graphs into the public contract.

## Background

Goal Mode is already referenced by the AI Interface, Human Attention, worker reliability, and development loop specs. Those documents define channel projections and lower-level mechanisms, but Goal Mode itself needs a V1 contract that ties objective, plan, bounded execution, review, and recovery together.

## Decision

- Goal Mode is the built-in V1 workflow mode for objectives that exceed Chat Mode or Task Mode.
- Workflow Coordinator operates Goal Mode inside NanoCore.
- Goal Mode state is durable NanoCore state projected through thread items, App API, AI Interface, Action Center, artifacts, and evidence bundles.
- A goal may run one or more bounded worker steps; each step has an explicit stop decision before the next step starts.
- Plan approval is required before executing plan-controlled goals.

## Contract / Expected Behavior

### Goal records

A `GoalRecord` must carry:

- goal id
- workspace id
- thread id
- objective
- current status
- plan status
- active plan id when present
- current step id when present
- coordinator state summary
- human attention summary
- evidence summary
- created, updated, and terminal timestamps

Goal status values:

- `drafting`
- `awaiting-plan-approval`
- `ready`
- `running`
- `awaiting-human`
- `reviewing`
- `paused`
- `blocked`
- `completed`
- `cancelled`
- `failed`

### Planning

- Goal Mode must create a plan draft when the objective is ambiguous, multi-step, high-risk, or user-selected as planning-heavy.
- The plan must state objective, assumptions, scope, non-goals, steps, expected evidence, approval points, stop condition, and known risks.
- Plan approval must be explicit before executing a plan-controlled goal.
- Plan updates that materially change scope, risk, external side effects, or worker responsibilities require review or re-approval.

### Bounded steps

- Each Goal Mode step is a bounded work unit selected by Workflow Coordinator.
- A step may call one worker agent by default; multi-worker coordination is allowed only when the Coordinator records why it is needed and each worker step remains bounded.
- Each step must produce a stop decision: continue, ask user, approve action, review output, retry, handoff, pause, block, complete, or fail.
- A new step must not start while a required human gate is unresolved.

### Steering and user input

- User steering during Goal Mode is recorded against the active thread and goal.
- Low-risk steering may be queued for the next safe point.
- Steering that changes objective, scope, non-goals, risk, external side effects, or plan semantics must update the plan or ask for clarification.

### Evidence and review

- Goal Mode must attach evidence references to worker steps and terminal summaries.
- Evidence may include artifacts, command summaries, test results, workspace sync reviews, Git push records, Action Center decisions, and restricted diagnostics by reference.
- Review state must be visible enough for the user or an external coordinator to understand what happened without reading raw backend internals.

### Recovery

- Goal Mode resume must read durable goal, thread, Action Center, worker step, artifact, evidence, and agent-session records.
- It must not rely on coordinator conversation memory as the source of truth.
- Pending worker checkpoints, stale leases, failed worker steps, or interrupted sessions must surface as typed recovery choices.

### Relationship to other modes

- Chat Mode may hand off to Goal Mode when the Assistant identifies a large objective.
- Task Mode may escalate to Goal Mode when a bounded task becomes multi-step, risky, or long-running.
- Goal Mode may run a simple first step without a heavy plan only when policy and Coordinator routing classify it as low-risk and planless.

## Accepted Design

Goal Mode is a NanoCore workflow service operated by Workflow Coordinator. The service persists goal state, plan drafts, plan approvals, step records, stop decisions, and evidence references. It composes existing scheduler, worker control, context package, workspace sync, Action Center, and audit contracts rather than inventing a separate runtime.

## Current Implementation Projection

References to `@openkit/mcp` in this section describe the current removal-only kernel-test facade. New Goal product operations belong to the transport-neutral operation catalog, bundled CLI, and unified end-user Skill.

NanoCore and `@openkit/mcp` expose the accepted V1 Goal Mode operations for start, read, planning, approval, revision, pause, resume, bounded steps, Action Center reads, artifacts, evidence, and interrupted worker recovery. The steering operation remains reserved but fails closed with `goal_steering_delivery_unavailable` because the real worker path cannot yet persist and deliver its accepted Context Package trace. Chat Mode goal handoff and Task Mode escalation create durable Goal Mode objectives through the same Goal Mode start path and keep worker execution deferred until planning and bounded steps. Plan drafting returns a Workflow Coordinator planner summary with source agent identity, confidence, rationale, selected context references, and required plan approval while preserving deterministic V1 plan content. Plan revision requests return the goal from `awaiting_plan_approval` to `planning`, clear the active plan item, require a newly drafted plan before approval, and do not start a worker turn. Explicit pause persists a running goal as `paused` only at safe workflow boundaries with no active worker turn, blocks new `/goal/step` calls, and resume returns the same durable goal to `running` so the next bounded step can continue from persisted state. Real Goal Mode worker steps call the Workflow Coordinator before launch, expose the selected worker delegation summary in the App API and MCP step response, return a product-safe context assembly summary backed by the worker checkpoint diagnostics while the step is recoverable, and return a schema-versioned Coordinator stop decision with request id, source agent id, rationale, context refs, stop reason, outcome, and evidence refs. Interrupted and failed worker recovery rows include typed `inspect`, `record_terminal`, and `request_human` choices and are exposed through the App API, `@openkit/core-client`, and `@openkit/mcp` without adding replay or resume commands. Runtime config stale-session diagnostics include typed `inspect`, `restart_session`, and `request_human` choices through the existing diagnostics read model, and stale-session restart is exposed through the App API, `@openkit/core-client`, and the mutating `openkit.restart_runtime_config_stale_session` MCP tool by retiring the stale session record so the next worker launch uses the current runtime config version. The deterministic L6 story `tests/stories/goal-mode-mcp-smoke.story.md` runs through `pnpm -w test:stories:deterministic` and proves the MCP Goal Mode path from status and diagnostics through repository linking, plan approval, one bounded step, Action Center handling, read-only inspection of NanoCore-produced evidence bundles, and artifact read when present.

Each real Goal step reserves its turn identity before checkpointing and then starts that same turn through the durable scheduler. Scheduler admission owns the agent session, lease, and `lease-binding:` worker-control token lineage, and terminal Goal handling releases the lease. The objective user item id derives from the created turn id rather than a workspace-local counter, so independent workspaces and threads cannot collide in shared Core storage; cross-workspace and cross-thread regression coverage protects this invariant.

The current real-worker launch still passes only the delegation objective into the worker turn even though the accepted delegation and checkpoint retain acceptance criteria, context references, expected artifacts, stop conditions, verification instructions, and review policy. Implementation remains Partial until the launch path delivers those accepted boundaries and a focused test proves the actual worker input rather than only the delegation DTO.

`reviewPolicyOverride` accepts only `human` or `none`, and omission uses `human`. After worker completion, a human-reviewed step atomically persists an unresolved actionable Goal Review with the matching task and goal reviewing state. Accepting that review atomically resolves it and advances the task graph. `none` skips only the review for that completed step and still advances newly unblocked and remaining tasks.

NanoCore persists task-scoped verification evidence and projects it in goal and terminal summaries. Task Evaluator loops and an independent final-verifier completion gate remain deferred, so terminal state does not imply that either evaluator ran.

## Alternatives Considered

- Treat Goal Mode as an Agent Skill Interface-only flow. Rejected: Goal Mode must be NanoCore state, with the bundled CLI and Web as projections.
- Let the Coordinator run until completion without bounded steps. Rejected: bounded steps are required for review, recovery, cost control, and human attention.
- Force all goals into a full plan before any action. Rejected: some low-risk goals can start with lightweight planning, but the contract must still preserve stop decisions and evidence.

## Consequences

- Goal Mode becomes the central V1 mode for serious delegated work.
- Existing end-user Agent Skill and Web flows gain a clearer owning contract.
- Implementation must harden durable goal state and recovery before claiming release readiness.

## Rollout / Migration Plan

1. Align existing Goal Mode records and App API projections with this status and plan contract.
2. Add plan revision and re-approval checks.
3. Add explicit step stop decisions and evidence references. Done for real worker steps.
4. Wire Coordinator plan drafting and step selection through the internal agent contract. Done for plan summaries and step selection; complete delegation delivery into the real worker turn remains open.
5. Add recovery choices for interrupted worker steps and stale sessions. Done for interrupted worker checkpoint rows, failed worker checkpoint rows, runtime config stale-session rows, interrupted checkpoint retry-to-ready, and stale-session restart-by-retire execution.
6. Add L6 story acceptance for the Goal Mode path. Done through `tests/stories/goal-mode-mcp-smoke.story.md`; Chat-to-Goal and Task-to-Goal have lower-layer route coverage and remain candidates for future broader product stories.

## Testing Strategy / Acceptance Criteria

- L1: unit tests for status transitions, plan approval requirements, steering classification, and stop decisions.
- L2: contract tests for GoalRecord, plan, step, evidence, and Action Center projection shapes.
- L3: NanoCore black-box tests for start, draft plan, approve plan, run one step, handle pending attention, resume after restart, and complete.
- L3: prove that the real worker launch receives the complete accepted delegation rather than only its objective.
- L6: story acceptance where a user works out a plan with the system, approves it, runs multiple bounded worker steps, reviews evidence, and completes the objective.

Acceptance: Goal Mode can be resumed from durable state, never runs past unresolved human gates, and makes each worker step and terminal decision visible with evidence.

## Risks & Mitigations

- Risk: Goal Mode becomes too broad to implement. Mitigation: keep V1 to durable objective, plan, bounded steps, evidence, and recovery; defer dynamic planning and evaluation.
- Risk: users cannot tell whether work is ongoing or waiting. Mitigation: explicit status and Action Center projection.
- Risk: coordinator context loss breaks long goals. Mitigation: durable goal and evidence state are the source of truth.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: a thread may have only one active goal at a time; low-risk goals that do not need a user-visible planning ceremony use an implicit approved plan rather than a distinct planless status.

## Deferred / Future Work

- Dynamic planning from historical outcomes.
- Task Evaluator review loops.
- Independent final-verifier completion gate.
- Automatic multi-worker graph planning.
- Goal templates and reusable recipes.
- Team collaboration semantics for shared goal approval.

## Links

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
