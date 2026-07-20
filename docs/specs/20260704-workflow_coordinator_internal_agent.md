# Workflow Coordinator Internal Core Role

Status: Accepted
Implementation: Implemented

## Owns

- The reusable Workflow Coordinator Internal Core Role contract.
- Request classification across Chat Mode handoff, Task Mode, Goal Mode, review, refinement, retry, and unsupported requests.
- Worker selection, routing decisions, semantic structured-worker-request composition, delegation drafts, complete request-scoped Goal Plan decisions, and Goal stop decisions.
- The structured boundary by which mode services supply knowledge, readiness, context, and evidence summaries and consume Coordinator decisions.

## Does Not Own

- User-facing mode semantics. `docs/core/work-model.md` and the mode specs own those projections.
- Core Assistant direct replies. `docs/specs/20260704-chat_mode_assistant.md` owns those.
- Knowledge Manager service behavior. `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` owns that role.
- Worker runtime control, scheduler, AEP, context package file format, workspace sync, or Git write execution.
- Durable Chat or Task owner tuples, Goal state, workflow progression effects, or context persistence, materialization, and delivery.
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

Workflow Coordinator is the Internal Core Role that turns caller-supplied intent and authorized summaries into structured coordination decisions. It classifies requests, chooses the appropriate mode, selects worker agents, semantically composes bounded worker requests, drafts delegation and Goal plan projections, and produces Goal-level stop decisions from lower-level outcomes and supplied evidence.

It is not a worker runtime. It does not execute shell commands, edit files, push commits, or maintain the Knowledge Store directly. It coordinates NanoCore services and worker agents through existing contracts.

## Goals / Non-goals

### Goals

- Give Task Mode and Goal Mode one shared routing and coordination brain.
- Make Coordinator decisions structured, testable, and explainable.
- Preserve caller-supplied context references in worker delegation.
- Prevent mode-specific implementations from inventing parallel worker-selection or routing logic.
- Keep heavy execution delegated to worker agents.

### Non-goals

- Do not build a graph runtime, swarm planner, or generic agent framework.
- Do not let Coordinator bypass scheduler, worker control, permissions, vault, Action Center, or workspace sync.
- Do not let Coordinator write files or commit/push directly.
- Do not make Coordinator the Knowledge Manager.
- Do not require ML-based dynamic planning in V1.

## Background

`docs/core/architecture.md` defines Workflow Coordinator as the semantic decision role for non-trivial worker-agent work. `docs/core/agent-workflow.md` separates its bounded routing, selection, worker-context, plan, and stop decisions from the durable state and effects owned by workflow boundaries.

This specification fixes the implementation-facing deterministic interface shared by Chat Mode, Task Mode, and Goal Mode.

## Decision

- Workflow Coordinator is an Internal Core Role implemented as an app-local NanoCore service.
- It produces direct typed deterministic decisions; public route schemas validate the projections that leave NanoCore.
- Mode services call Coordinator; Coordinator does not own product routes by itself.
- Mode services perform authorized Knowledge Manager reads and provide the resulting source-traceable references to Coordinator. Coordinator owns their semantic inclusion in the structured worker request; the caller owns the read effect plus context persistence, materialization, and worker delivery.
- Coordinator may recommend Task Mode or Goal Mode, but the mode services apply decisions through the named durable owner tuples; Task Mode has no durable mode record.

## Contract / Expected Behavior

### Coordinator inputs

The V1 routing input contains exactly the user prompt, optional `user_prompt` or `goal_step` routing context, available worker candidates and their readiness summaries, one Workspace summary, one Thread state summary, optional redacted recent failures, optional prepared context references, and optional bounded `workerRequestDetails`. `workerRequestDetails` contains exactly acceptance criteria, resource declarations, expected artifacts, constraints, verification instructions, review policy, escalation conditions, and nullable Review context; it contains no objective, context references, schema version, request id, adapter payload, or durable owner fields. Task Mode may omit it and use the fixed bounded defaults in S12. Goal Mode MUST pass the selected immutable Goal Task objective as the routing prompt, derives every other task-specific value from that same Goal Task, derives only Review context from the latest eligible Review, and supplies S13's validated latest Gate request/response Item pair through prepared context references when the Task pointer is non-null.

The V1 input has no request id, policy engine result, permission record, raw evidence, provider prompt, or durable lifecycle fields. Callers retain those responsibilities and MUST NOT pass raw secrets, full unrestricted workspace files, backend handles, or adapter-native launch payloads. The bounded details are authorized facts rather than a second worker request: the mode service owns their exact source reads and derives only `reviewContext` from the latest eligible Review, while Coordinator alone combines the immutable prompt and details with the ordered references, validates the exact output, and creates `workerRequest`.

Goal stop-decision input is a separate exact shape containing Workspace, Thread, request, Goal, Goal Task, and worker Turn ids; the lower-level `StopAfterTurnDecision`; Item and Artifact evidence ids; and `hasOtherIncompleteTasksAfterAddressedTaskCompletion`, computed by the Goal service before mutation from durable Goal Task records by treating the addressed task as completed and excluding it from the remaining-task check.

### Request classification

The V1 routing decision is exactly one of `quick_chat`, `worker_turn`, `goal`, `clarify`, `review`, `refinement`, `retry`, `handoff`, `unsupported`, or `blocked`.

Every routing decision includes confidence, a user-safe explanation, one required-user-action value, and nullable selected worker, delegation draft, and structured worker request. Only `worker_turn` may carry a selected worker, delegation draft, or worker request.

For an accepted Task Mode `worker_turn`, `requiredUserAction=none` and the prelaunch approval list is empty. Explicit Task entry authorizes bounded delegation only; later governed effects use their existing approval gates. `clarify`, `blocked`, and other non-worker decisions may describe the required next user action but cannot create a checkpoint or worker Turn. Any `worker_turn` carrying another required-user-action value is invalid and the owning mode must reject it before mutation rather than treating it as an unowned prelaunch gate.

### Worker selection

Worker selection consumes only the caller-supplied candidate id, display name, `codex` or `opencode` runtime label, `ready`, `blocked`, or `unknown` readiness, and optional redacted reasons. V1 may use prompt hints to prefer a runtime and otherwise selects only a ready candidate.

If no eligible candidate is ready, the decision is `blocked` and has no worker payload. The selected worker summary may be product-visible; adapter-native launch payloads remain internal to the owning runtime contracts. Runtime-family inference and the closed V1 runtime label set are audited by the Worker Agent Adapter Boundary plan, not expanded here.

### Context reference handling

- Mode services request source-traceable knowledge or source material from Knowledge Manager and pass policy-filtered references or summaries to Coordinator.
- In V1, Coordinator composes the semantic worker request by placing the addressed Workspace and Thread references first, then the validated latest Goal Gate request/response Item pair in canonical Thread Item order when present, then every other caller-supplied reference exactly once in caller order together with the objective, acceptance criteria, resource declarations, expected artifacts, constraints, verification instructions, review policy, and escalation conditions.
- Resource declarations preserve the exact `kind`, `reference`, and `reason` accepted for the Task. They express semantic work inputs but do not grant access, resolve host paths, or prove that bytes were delivered; `contextRefs` name only the separately authorized owners actually selected for context delivery.
- The exact structured request also carries `reviewContext`, which is `null` for an initial Goal attempt and every Task Mode attempt. For a Goal continuation authorized by a resolved `refine` or `retry` Review, it is exactly `{ reviewId, verdict, reason, revisionInstruction, priorTurnId, evidence: { itemIds, artifactIds } }`; `refine` requires a non-null `revisionInstruction`, `retry` requires a non-null `reason`, and the field that does not apply is null. The Review's verification evidence remains owned by the Review and is not copied into this request.
- The context package remains a data projection, not an internal agent.
- Only the references and instructions returned in the Coordinator's structured worker request are authorized for that delegation. Mode services own persistence, materialization, replay, audit, restricted-payload handling, and delivery of the accepted request.

### Output shapes

V1 produces three concrete shapes. `WorkerCoordinatorDecision` contains `decision`, `confidence`, `explanation`, `selectedWorkerCandidate`, `requiredUserAction`, `delegationDraft`, and `workerRequest`; only `decision=worker_turn` may make the last three worker fields non-null. Its `workerRequest` is the semantic worker-context decision and contains exactly `schemaVersion`, `objective`, `acceptanceCriteria`, ordered `contextRefs`, `resources`, `expectedArtifacts`, `constraints`, `verification`, `reviewPolicy`, `escalationConditions`, and nullable `reviewContext`. `constraints` contains exactly `maxContextTokens` and `maxWorkerIterations`; `requiresUserConfirmation` is not a Coordinator field because accepted worker selection has no prelaunch gate, while post-step human review is owned only by `reviewPolicy`. Escalation conditions remain a separate exact array and are not renamed or truncated into generic stop conditions. `WorkerCoordinatorGoalPlanDecision` contains `mode=goal`, `sourceAgentId`, confidence, rationale, Workspace and Thread context references, `requiredApprovals=['plan_approval']`, and one complete `plan` using S13's exact `GoalPlanRecord` payload fields: `schemaVersion=1`, `goalSummary`, `assumptions`, bounded task entries, `risks`, `questions`, and `verificationApproach`. It has no lifecycle or request-id field; the Goal service supplies command identity and persists an immutable Plan record only after validation. `WorkerCoordinatorGoalStopDecision` contains `schemaVersion=1`, `mode=goal`, `sourceAgentId`, the originating request id, `outcome`, `shouldStop`, `stopReason`, `rationale`, Workspace and Thread context references, and Item and Artifact evidence ids.

After acceptance, the mode service schema-parses the exact structured request and serializes the parsed value as compact JSON. Those exact bytes become the scheduler Turn input, AEP Turn input, worker input, and the existing Turn-owned `user-message` Item; this JSON-over-text mapping is the V1 adapter compromise and does not authorize a second payload record, delivery receipt, or settlement workflow. A routing summary, request digest, checkpoint, or scheduler row cannot prove worker delivery by itself. Before the Turn-owned Item exists, the request remains prepared but unproved; after the Item exists with the same bytes, ordinary Turn and worker-runtime evidence determines whether execution started or failed.

Task Mode's Turn, Item, checkpoint, evidence, and command tuple; Goal Mode's Goal, immutable Plan, Goal Task, Review, Turn, checkpoint, evidence, and command tuple; Context Packages; and public read models are consumers or projections of these shapes. They are not additional Coordinator-owned records.

Coordinator outputs are request-scoped deterministic values, not durable records or a private lifecycle. After acceptance, the named Task or Goal business-owner tuple above is durable authority; Task Mode has no mode record. Identical bounded input MUST produce the same decision; restart recomputes it from durable caller-owned inputs, and a failure before the owning business mutation leaves no Coordinator state to recover.

### Stop decisions

For a Goal worker step, Coordinator converts the lower-level worker-step decision into the Goal-level stop decision. `review`, `ask_user`, `block`, and `abort` remain unchanged. Goal Mode V1 always supplies `remainingWorkerIterations=0` to the lower-level worker envelope, so a lower-level `continue` is invalid and returns `goal_stop_decision_invalid` before Goal, Goal Task, Goal Review, terminal-reason, checkpoint-success-clear, or next-step mutation. The already durable worker Turn, checkpoint, and Item or Artifact evidence remain unchanged for diagnosis. Lower-level `complete` becomes Goal-level `continue` when `hasOtherIncompleteTasksAfterAddressedTaskCompletion=true` and remains `complete` only when no other incomplete Goal Task remains. `shouldStop` is false only for the generated Goal-level `continue`. Coordinator copies caller-supplied Item and Artifact evidence ids and MUST NOT infer evidence, launch another step, or mutate Goal state.

## Accepted Design

Implement Coordinator as pure deterministic functions over caller-supplied request, worker-readiness, Thread, Workspace, authorized context-reference, Goal progression, and evidence or failure summaries. Task Mode persists and applies its Turn, Item, checkpoint, evidence, and command tuple; Goal Mode persists and applies Goal, Plan, Goal Task, Review, Turn, checkpoint, evidence, and command state. Both mode services perform Knowledge Manager reads, context persistence and materialization, scheduler requests, Action Center source mutations, and evidence reads through their existing owners. A future provider-backed implementation requires an accepted design and demonstrated need; it must remain concrete to this role and must not add a generic agent framework.

## Current Implementation Projection

NanoCore has the functional V1 deterministic Workflow Coordinator routing, worker-request, Goal-plan, and Goal-stop slice. `apps/nanocore/src/internal-agents/worker-coordinator.ts` owns its typed readiness input, classification, worker selection, semantic worker request, delegation, complete Goal Plan decision, and Goal stop decision functions. Goal Mode consumes the Plan inside that one Coordinator decision and persists it through the immutable Plan owner; the planning service no longer assembles a separate executable Plan. Product mode services call these functions directly and public App API schemas validate the resulting route projections. The unused provider-output schema, generic registry definition, tool allowlists, runner, private event lifecycle, and diagnostics projection have been deleted; Coordinator is neither registered nor diagnosed as a provider-backed agent. Vague prompts such as "Help" produce `clarify`, Goal Mode planning prompts produce `goal`, worker-required requests with no ready Codex or OpenCode candidate produce `blocked` instead of `unsupported`, retry prompts produce `retry`, and review, refinement, handoff, unsupported, quick-chat, and worker-turn decisions do not select a worker unless the decision is `worker_turn`.

Task Mode now consumes this slice through `POST /api/app/workspaces/:workspaceId/threads/:threadId/task`: NanoCore calls the Coordinator before launch, rejects non-worker decisions or any worker decision with a non-`none` required action, and starts the selected worker through the durable scheduler. Coordinator returns `requiredUserAction=none` for a selected worker Turn. The Task Mode path also prepares source-traceable context refs from Knowledge Manager when workspace knowledge matches the task prompt and passes those refs to Coordinator. Direct Task and Chat-to-Task schema-parse the one Coordinator-composed request with `reviewContext=null`, serialize compact JSON, and use the exact bytes for scheduler, AEP, worker, Turn, and Turn-owned Item input. The shared request has the accepted resource and escalation arrays and no caller-confirmation or generic-stop field. The public Task response and command receipt do not copy that otherwise unowned decision merely to support replay. S39 now persists and verifies the immutable Worker Context Package trace for the exact request bytes; complete materialized Knowledge content remains incomplete under its owning specification.

Goal Mode consumes the implemented slice for complete plans, worker selection, exact approved-Task worker requests, and post-worker stop summaries. `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan` returns the Workflow Coordinator decision with `mode: goal`, `sourceAgentId: worker-coordinator`, confidence, rationale, context refs, `plan_approval`, and the complete deterministic V1 Plan persisted by the Goal service. `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/step` currently reads the selected immutable Goal Task, verifies its exact active Plan lineage, and gives Coordinator its objective, acceptance criteria, ordered resources, expected Artifacts, context budget, verification checks, review policy, escalation conditions, and eligible Review context. Missing, malformed, or mismatched Task facts return `recovery_required` before launch rather than being repaired from defaults, caller input, Plan content, or the lightweight Plan Item. Coordinator composes the only final request, and Goal Mode delivers its compact JSON through the existing Turn path. Initial attempts carry `reviewContext=null`, and a new attempt after a coherently resolved latest `refine` or `retry` Review carries the exact sticky verdict-specific context and prior evidence without changing historical owners. Goal Gate closeout persists `latestGateContextItemId`, validates the exact Gate Item pair, and includes that pair in later prepared context without making Coordinator its owner. The Goal Mode service, not Coordinator, owns immutable Plan and Goal Task persistence, approval, context assembly summary, package digest, selected refs, repository resource id, checkpoint recovery projection, and runtime stale-session diagnostics. S16 owns the exact pending steering state and S39 delivery proof; neither service synthesizes queued-input counts from Coordinator output or checkpoints.

Chat Mode now consumes this slice for explicit Assistant handoffs. Bounded worker requests create a Task Mode handoff through Workflow Coordinator and longer-running requests create a Goal Mode handoff from the Coordinator's `goal` decision through the shared Goal Mode objective path; the unified `openkit` Skill exposes this entry through the `chat.start` bundled-CLI operation. When Coordinator returns a non-quick-chat decision that does not select a worker turn, such as `clarify`, `blocked`, `retry`, `review`, `refinement`, `handoff`, or `unsupported`, Chat Mode records a refused status item with the Coordinator explanation instead of falling through to Knowledge Manager or provider-backed quick chat. Historical deterministic L6 evidence covered both paths: Task handoff created the visible status item, started bounded worker progress, and exposed the worker approval gate, while Goal handoff created a durable planning goal. The retired MCP-only story is not an active release gate.

The deterministic V1 routing, complete Goal Plan decision, exact worker-request composition and byte delivery, immutable Goal Task request-fact path, and Goal stop decision are implemented, and the generic runtime and diagnostics boundary defect is closed. Goal Mode supplies lower-level `remainingWorkerIterations=0` and the pre-mutation `hasOtherIncompleteTasksAfterAddressedTaskCompletion` predicate; Coordinator rejects lower-level `continue`, converts an accepted Task completion to Goal `continue` or `complete`, and returns the decision before the Goal service mutates its owners. The Goal service then validates and commits the matching owner tuple rather than treating the Coordinator output as an after-the-fact summary. The Worker Context Package and Work Resource Interaction Model specifications still own materialized Context Package delivery, while Goal command replay and launch recovery remain Goal Mode Coordination and Worker Turn Reliability Envelope work rather than Coordinator state. Dynamic planning, multi-worker graph planning, Task Evaluator integration, and workspace-authored workflow recipes remain deferred future work rather than blockers for the V1 decision contract.

## Alternatives Considered

- Encode routing separately in each mode. Rejected: Task Mode and Goal Mode would drift and duplicate worker selection.
- Make Coordinator a user-selectable agent. Rejected: it is a Core coordination role, not worker supply.
- Use deterministic rules for V1. Accepted because every current consumer needs bounded classification and selection rather than open-ended reasoning; a provider-backed extension is justified only by observed cases the deterministic contract cannot represent.

## Consequences

- Task Mode and Goal Mode share one coordination contract.
- Coordinator behavior remains testable through structured outputs without a second runtime.

## Testing Strategy / Acceptance Criteria

- L1: exact input, classification, worker selection, delegation, complete Goal Plan decision, and Goal stop decision tests.
- L1: worker-selection tests across unavailable, denied, unsuitable, and preferred worker cases.
- L2: contract tests for Coordinator outputs consumed by Task Mode and Goal Mode.
- L3: NanoCore black-box tests for Task Mode delegation and Goal Mode plan/step using Coordinator outputs.
- L3: Goal Mode fixes lower-level `remainingWorkerIterations=0`, rejects any lower-level `continue`, supplies the durable pre-mutation `hasOtherIncompleteTasksAfterAddressedTaskCompletion` summary, validates the Coordinator stop decision, and consumes it before mutating Goal, task, review, or evidence state.
- L6: story acceptance where a user request moves through Assistant, Coordinator, worker execution, evidence, and final result.

Acceptance: Coordinator decisions match the three exact V1 shapes, public projections validate at their owning route boundary, worker selection uses only supplied readiness, and no Coordinator function reads or mutates scheduler, permission, vault, worker control, Knowledge, Action Center, Task-owner, or Goal state.

## Risks & Mitigations

- Risk: Coordinator output becomes too free-form. Mitigation: closed TypeScript return shapes, exact deterministic unit tests, and public schema validation at route boundaries.
- Risk: Coordinator hides important reasoning. Mitigation: record concise rationale and evidence references.
- Risk: Coordinator over-calls workers. Mitigation: Assistant handles Chat Mode and Coordinator must classify low-confidence cases as clarify or goal planning.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the Coordinator is deterministic and has no internal model profile; user-visible surfaces may show its concise routing rationale without exposing ranking details or policy-sensitive context.

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
