---
status: Accepted
implementation: Implemented
kind: concept
aspect: architecture
---

# Workflow Coordinator Internal Core Role

This specification owns the deterministic Workflow Coordinator: explicit Task selection and the structured worker request.

## Scope

Owns trusted explicit Task selection, worker selection, and the structured worker request. The Assistant owns conversation.

Does not own:
- User-facing mode semantics. [Work Model](../core/work-model.md) owns them.
- Assistant replies. [Chat Mode](20260704-chat_mode_assistant.md) owns them.
- Knowledge Manager behavior. [Knowledge Manager](20260704-knowledge_manager_internal_agent_runtime.md) owns that role.
- Goal truth and the model Coordinator. [Goal](20261002-goal.md) owns them.
- Worker control, the scheduler, and context-package delivery. Their existing owners retain them.

Core: [Architecture](../core/architecture.md), [Work Model](../core/work-model.md), [Agent Supply](../core/agent-supply.md).

## Goal Boundary

Goal progression, Goal Plan decisions, Goal stop decisions, and the model Coordinator role belong to [Goal](20261002-goal.md). This specification keeps trusted explicit Task selection and worker-request composition; the Assistant owns conversation. It does not own Goal truth and it does not perform Goal progression effects. [Goal Redesign Rulings](../decisions/20261002-goal_redesign_rulings.md) records the split. A test of this role requires neither a Goal stop conversion nor `remainingWorkerIterations=0`.

## Decision

- Workflow Coordinator is an Internal Core Role implemented as an app-local NanoCore service.
- It produces direct typed deterministic decisions; public route schemas validate the projections that leave NanoCore.
- Mode services call Coordinator; Coordinator does not own product routes by itself.
- Mode services perform authorized Knowledge Manager reads and provide the resulting source-traceable references to Coordinator. Coordinator owns their semantic inclusion in the structured worker request; the caller owns the read effect plus context persistence, materialization, and worker delivery.
- Coordinator selects a worker and composes the request only for trusted explicit Task entry; mode services apply accepted decisions through the named durable owner tuples. Task Mode has no durable mode record. The Assistant calls the Goal owner's create operation for a Goal handoff; Workflow Coordinator does not classify that handoff or call a Goal Plan or Goal stop function.
- The model Coordinator is one role over `docs/specs/20260813-internal_agent_runtime.md`, bound to one Goal, and `docs/specs/20261002-goal.md` owns that role. This specification admits no second mutation-capable coordinator.
- Evaluation is a pure deterministic function of the supplied inputs. It does not read or mutate scheduler, permission, Vault, worker-control, Knowledge, Action Center, Task-owner, or Goal state.

## Contract / Expected Behavior

### Coordinator inputs

The mode service supplies only trusted `explicit_task` entry intent for bounded Task delegation. That value comes from the operation or accepted handoff, never caller prose, retrieved content, or a model-supplied authorization claim. `WorkerCoordinatorInput` in `apps/nanocore/src/internal-agents/worker-coordinator.ts` is the admitted input. It does not carry routing context or a recent-failure field. Task Mode may omit bounded request details and use the fixed defaults in [Task Mode](20260704-task_mode_worker_delegation.md#worker-execution).

Callers retain request identity, policy, and durable lifecycle. They MUST NOT pass raw secrets, full unrestricted workspace files, backend handles, or adapter-native launch payloads. The mode service owns exact source reads. Coordinator alone combines the immutable prompt and authorized details with the ordered references, validates the exact output, and creates `workerRequest`.

### Request classification

For trusted explicit Task delegation, Workflow Coordinator deterministically selects only from the eligible worker candidates and composes the exact structured worker request from the preserved instruction and authorized context. It does not classify undecided conversation or reclassify explicit Task instructions by keyword. The V1 decision is exactly `worker_turn` or `blocked`; missing eligible supply produces `blocked`, and malformed Coordinator output remains invalid. The request-scoped decision owns no durable state and grants no permission for downstream effects.

Every decision includes confidence, a user-safe explanation, `requiredUserAction`, and nullable selected worker, delegation draft, and structured worker request. Only `worker_turn` may carry those worker fields.

For an accepted Task Mode `worker_turn`, `requiredUserAction=none` and the prelaunch approval list is empty. A `blocked` result uses `requiredUserAction=refine_request` and carries no worker payload. Explicit Task entry authorizes bounded delegation only; later governed effects use their existing approval gates. A blocked decision cannot create a checkpoint or worker Turn. Any `worker_turn` carrying another required-user-action value is invalid and the owning mode must reject it before mutation.

### Worker selection

Worker selection consumes only the caller-supplied candidate id, display name, `ready`, `blocked`, or `unknown` readiness, and optional bounded redacted reasons. Workflow Coordinator selects the first eligible ready candidate in caller-supplied order and omits the runtime label until it has a consumer. Goal discovery uses the release-registry runtime labels under [Goal](20261002-goal.md#worker-discovery).

When `task.start` supplies an exact `agentId`, the caller restricts the eligible candidates to that Agent. Workflow Coordinator selects it only when it is eligible and ready, and never substitutes another candidate. A missing, ineligible, or unready selection produces `blocked` with no worker payload; Task admission maps this to `409 task_mode_not_delegated` before effects. Omission keeps ordinary selection ([accepted #133 decision](../decisions/20261012-exact_task_agent_selection.md)).

If no eligible candidate is ready, the decision is `blocked` and has no worker payload. The selected worker summary may be product-visible; adapter-native launch payloads remain internal to the owning runtime contracts. Goal discovery's runtime-family inference and closed product runtime labels remain with its existing owners; Workflow Coordinator adds no runtime preference or label.

### Bounded Source Projection

Coordinator inputs, failure summaries, and structured worker requests use [bounded Context Package projections](20260703-worker_context_package.md#bounded-model-projection). Preserve exact admitted references and required request fields; do not inline large bodies or truncate required authority to fit. A required request that cannot fit fails before delegation. Mode services retain source storage, current disclosure, materialization, and replay ownership. This deterministic Coordinator gains no model loop; any model-using coordinator path follows the shared internal-runtime owner.

### Context reference handling

- Mode services request source-traceable knowledge or source material from Knowledge Manager and pass policy-filtered references or summaries to Coordinator.
- In V1, Coordinator composes the semantic worker request by placing the addressed Workspace and Thread references first, then every other caller-supplied reference exactly once in caller order together with the objective, acceptance criteria, resource declarations, expected artifacts, constraints, verification instructions, review policy, and escalation conditions.
- Resource declarations preserve the exact `kind`, `reference`, and `reason` accepted for the Task. They express semantic work inputs but do not grant access, resolve host paths, or prove that bytes were delivered; `contextRefs` name only the separately authorized owners actually selected for context delivery.
- The exact structured request also carries `reviewContext`, which is `null` for every Task Mode attempt.
- The context package remains a data projection, not an internal agent.
- Only the references and instructions returned in the Coordinator's structured worker request are authorized for that delegation. Mode services own persistence, materialization, replay, audit, restricted-payload handling, and delivery of the accepted request.

### Output shapes

`WorkerCoordinatorDecision` is the admitted decision. The structured worker request, including optional `reporting`, is the admitted request in `apps/nanocore/src/internal-agents/delegation.ts`. Only `decision=worker_turn` may make the worker fields non-null. `reviewContext` is null for every Task Mode attempt. `requiresUserConfirmation` is not a Coordinator field. Post-step human review is owned only by `reviewPolicy`. Escalation conditions remain a separate exact array.

After acceptance, the mode service schema-parses the exact structured request and serializes the parsed value as compact JSON. Those exact bytes become the scheduler Turn input, AEP Turn input, worker input, and the existing Turn-owned `user-message` Item; this JSON-over-text mapping is the V1 adapter compromise and does not authorize a second payload record, delivery receipt, or settlement workflow. A routing summary, request digest, checkpoint, or scheduler row cannot prove worker delivery by itself. Before the Turn-owned Item exists, the request remains prepared but unproved; after the Item exists with the same bytes, ordinary Turn and worker-runtime evidence determines whether execution started or failed.

Task Mode's Turn, Item, checkpoint, evidence, and command tuple, Context Packages, and public read models are consumers or projections of this shape. They are not additional Coordinator-owned records.

Coordinator outputs are request-scoped deterministic values, not durable records or a private lifecycle. After acceptance, the Task business-owner tuple above is durable authority; Task Mode has no mode record. Identical bounded input MUST produce the same decision; restart recomputes it from durable caller-owned inputs, and a failure before the owning business mutation leaves no Coordinator state to recover.

## Implementation

- `apps/nanocore/src/internal-agents/`

## Implementation Gaps

None.

## Decisions

- [Goal Redesign Rulings](../decisions/20261002-goal_redesign_rulings.md)
- [Explicit Task Agent Selection](../decisions/20261012-exact_task_agent_selection.md)
