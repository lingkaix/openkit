---
type: change-plan
status: verified
date: 2026-08-13
---
# NanoCore Agent Function Model

## Intent

Turn the converged NanoCore Agent design into accepted owning documents and then into implementation, and give the two stalled predicates that converge on this subject an execution owner.

Two programs stopped here. `chat_to_task_runtime_completion` landed its runtime candidate and then failed its one browser oracle on a NanoCore restart-recovery property. `web_client_functional_completion` WP-10 proved exact revision delivery and same-Data-Root recovery, then stopped because the current Codex and OpenCode images fail the real Responses relay while a real text-only Chat bridge passes and its owner-required function-tool boundary fails. Both are the same subject seen from two sides: NanoCore Agent function under restart and under real provider relay. Neither could be resolved inside a consumer, which is the evidence that the subject needs an owner.

Separately, the whole Agent design converged in discussion between 2026-08-09 and 2026-08-13 and is recorded in uncommitted working space. That discussion decided a function model, a record model, a Tool boundary, and a runtime topology. None of it is authoritative today, and `[AUTH-003]` forbids production code, test infrastructure, or public contracts ahead of an accepted owner. The first six packages of this program therefore land decisions into their owning documents, and every implementation package after them cites those owners rather than the discussion.

## How To Use This Record

This record owns coordination, task detail, and verification evidence. It owns no design.

Each absorption package carries a **Decisions** block naming which decision lands in which owner, stated tightly enough that a builder adopts the settled decision instead of inventing one. Those statements are **not authority**. They carry no force until the owning document states them, and once it does, that document is authoritative and this block is a stale copy. A rule that exists only here is not in force. Improving the wording during absorption is expected and needs no escalation; changing what it decides is a design change and does.

What this record deliberately does not carry is the **argument**. The originating discussion is `temp/20260809-nanocore-agent-function-model-proposal.md`, an uncommitted 3593-line working proposal whose own Authority Boundary states that it amends nothing and authorizes no implementation. Inlining its reasoning here would move converged discussion into a location that carries execution authority, which is the inversion `docs/documentation-model.md` forbids. The reasoning stays in the input and a builder reads it there.

Absorption is distillation, not copying. `[DOC-015]` binds it: no criterion that could change implementation, tests, failure, recovery, ownership, or responsibility may be dropped, and `[DOC-016]`'s bar is that two independent implementers make the same material choices from the resulting owners alone. Discussion narrative, rejected alternatives, and the history of how a decision was reached do not travel; the criterion does.

**The input must survive until WP-6 closes.** `temp/` is uncommitted and this program's first six packages are the only mechanism that moves these decisions into durable ownership. Deleting the proposal before then loses them, and no other artifact carries them. After WP-6 the proposal is disposable and this record is authoritative about nothing.

## Authority And Related Context

- [`AGENTS.md`](../../../AGENTS.md)
- [`docs/change-execution.md`](../../change-execution.md)
- [`docs/documentation-model.md`](../../documentation-model.md)
- [`docs/engineering-doctrine.md`](../../engineering-doctrine.md)
- [`docs/core/foundation.md`](../../core/foundation.md)
- [`docs/core/work-model.md`](../../core/work-model.md)
- [`docs/core/agent-session.md`](../../core/agent-session.md)
- [`docs/core/agent-workflow.md`](../../core/agent-workflow.md)
- [`docs/core/agent-capability.md`](../../core/agent-capability.md)
- [`docs/core/sandbox.md`](../../core/sandbox.md)
- [`docs/core/runtime-model.md`](../../core/runtime-model.md)
- [`docs/core/communication.md`](../../core/communication.md)
- [`docs/core/permissions.md`](../../core/permissions.md)
- [`docs/core/storage.md`](../../core/storage.md)
- [`docs/core/knowledge.md`](../../core/knowledge.md)
- [`docs/specs/20260529-test_strategy.md`](../../specs/20260529-test_strategy.md)
- [`docs/specs/20260704-chat_mode_assistant.md`](../../specs/20260704-chat_mode_assistant.md)
- [`docs/specs/20260704-task_mode_worker_delegation.md`](../../specs/20260704-task_mode_worker_delegation.md)
- [`docs/specs/20260704-goal_mode_coordination.md`](../../specs/20260704-goal_mode_coordination.md)
- [`docs/specs/20260704-workflow_coordinator_internal_agent.md`](../../specs/20260704-workflow_coordinator_internal_agent.md)
- [`docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`](../../specs/20260704-knowledge_manager_internal_agent_runtime.md)
- [`docs/specs/20260704-agent_session_continuity.md`](../../specs/20260704-agent_session_continuity.md)
- [`docs/specs/20260704-session_static_workspace_materialization.md`](../../specs/20260704-session_static_workspace_materialization.md)
- [`docs/specs/20260709-quick_chat_workspace.md`](../../specs/20260709-quick_chat_workspace.md)
- [`docs/specs/20260802-nanohost_runtime_and_transport.md`](../../specs/20260802-nanohost_runtime_and_transport.md)
- [`docs/specs/20260703-runtime_scheduling_scale.md`](../../specs/20260703-runtime_scheduling_scale.md)
- [`docs/specs/20260703-worker_control_protocol.md`](../../specs/20260703-worker_control_protocol.md)
- [`docs/specs/20260703-workspace_synchronization.md`](../../specs/20260703-workspace_synchronization.md)
- [`docs/specs/20260703-audit_usage_evidence_records.md`](../../specs/20260703-audit_usage_evidence_records.md)
- [`docs/specs/20260616-agent_environment_package.md`](../../specs/20260616-agent_environment_package.md)
- [`docs/specs/20260713-work_resource_interaction_model.md`](../../specs/20260713-work_resource_interaction_model.md)
- Input, uncommitted: `temp/20260809-nanocore-agent-function-model-proposal.md`
- Input, uncommitted: `temp/20260813-successor-bundle-annotations.md`, Part 2 and Part 3

## Scope

- Land the converged Agent decisions into their owning Core documents and specifications, before any production write.
- Build the role-agnostic bounded internal Agent loop and its model-facing Tool boundary.
- Replace the direct Quick Chat provider call with an Assistant role assembly over that loop, with true multi-turn context and a fixed per-entry-path Tool set.
- Split the conflated worker backend session record into Sandbox, Harness, AgentSession binding, and execution lease, and settle the inherited restart-recovery predicate.
- Support multiple open AgentSessions in one Harness inside one Sandbox, with serial execution.
- Build the Goal-scoped Orchestrator role assembly, its three Goal autonomy fields, and bounded automatic progression.
- Preserve the owner-private Side Chat, direct-addressing, and typed-promotion criteria in Backlog until an accepted owner admits their implementation; the 2026-08-20 necessity recheck found no accepted Side Chat lifecycle contract.
- Settle the inherited real-provider-relay predicate for the worker images.
- Distribute the former bundled end-to-end proof across the lowest sufficient owning package gates: WP-9 owns restart reconstruction, WP-10 owns separate Worker AgentSessions, WP-11 owns dependency-ordered Goal progression and independent completion verification, WP-13 owns real relay, the accepted Goal-steering owner and its focused checks already own safe-point input, and the Side Chat criterion remains in Backlog.

## Non-Goals

- **No design decided here.** Every decision this program lands is owned by the document it amends, and this record cites that owner rather than restating it. A rule that exists only here is not in force.
- No implementation ahead of its owning document. An implementation package that finds its owner silent stops and returns to the absorption package that owed it, rather than deciding in code.
- No Web Search, no realtime voice channel, no Goal Supervisor, no cross-Goal Program or Portfolio owner, no Personal or Deployment Knowledge scope, no Work Overview product surface. Each is a Backlog Disposition below with an owner and an activation condition.
- No concurrent Turns across AgentSessions, no multiple Harness instances or families, no idle-eviction policy, no cross-session cache sharing. These are runtime Phases 2 to 4 and are backlog.
- No new product `Conversation`, `ChatSession`, `WorkerThread`, `AgentRun`, or `TaskRun` entity; no durable `BoundToolsetSnapshot`; no generic event bus, workflow engine, second scheduler, or duplicate durable Agent Harness.
- No claim that shared-Sandbox co-residency is hard security isolation.
- No reopening of a decision this program's input already settled. A package that believes a decision is wrong stops and escalates; it does not re-derive.

## Inherited Predicates

These are this program's own unmet predicates, not citations of another record. Both source records are or will be gone, so a predicate surviving only as a reference survives nowhere.

**IP-1 — NanoCore restart reconstruction.** From `chat_to_task_runtime_completion` RT-3, 2026-08-05, restated here as this program's own predicate.

- **Observed:** the one unchanged Chat browser sequence failed. After the **second** in-place NanoCore restart, the visible Gate answer returned `409 recovery_required` because no exact active owner tuple remained. The first restart survived; the second did not, so the defect is in what a restart reconstructs rather than in whether it reconstructs at all.
- **The owner tuple** is the lineage the current Worker Backend Session record binds as one unit: exact Workspace, Thread, Turn, AgentSession, package snapshot, and execution lease. WP-9 splits that record, which is why the predicate lands there and not in a UI package — the tuple has no single owner to reconstruct today.
- **Oracle artifact:** `apps/web/e2e/openkit-local-self-check.spec.ts`, unchanged. It was read-only in the predecessor's lease and stays read-only here. A failure that can only be made green by editing it is a finding against the product, not against the check.
- **Preserved boundary:** the accepted Chat-subordinate Gate identity — a non-secret Chat-subordinate Gate under the sole outer `chat.start` receipt with no nested `task.start`. WP-8 and WP-9 must both preserve it, and a reconstruction that produces a nested `task.start` receipt fails this predicate even if the Gate answer becomes visible.
- **Not established:** whether the correct outcome after an unreconstructible restart is a reconstructed tuple or a truthful interruption. RT-3 proved only that a bare `409 recovery_required` standing in for lost ownership is wrong. WP-9's entry gate decides which, and `[SCOPE-007]` binds it: do not invent cross-domain atomicity or automatic repair when an explicit `interrupted` or `unknown` plus a new-request retry is safe and truthful.

Admitted to **WP-9**.

**IP-2 — Real Responses relay and the function-tool boundary.** From `web_client_functional_completion` WP-10, 2026-08-05, recorded there as `WEB-RUNTIME-001` and `TST-044` through `TST-046`, restated here as this program's own predicate.

- **Observed:** Web and the Agent Skill Interface proved exact revision-2 delivery plus same-Data-Root recovery. Against real dependencies the current Codex and OpenCode worker images **fail** the real Responses relay. A real text-only Chat bridge **passes**, and the function-tool boundary its owner requires **fails**.
- **What the split means:** text-only carriage works and tool carriage does not, so the defect is in the function-calling path rather than in transport or authentication generally. That is the localization the failing evidence supports; WP-13 must confirm or refute it rather than inherit it as settled.
- **Two failures, not one.** The image relay failure and the function-tool boundary failure are separate and may have separate causes. WP-13 settles both or explicitly carries the unsettled one; settling the relay and declaring the package done would leave the boundary the owner requires still open.
- **Named source records:** `WEB-RUNTIME-001` and `TST-044` through `TST-046` were the consumer-side names of this failure. They are restated here as **IP-2**; this package does not have to discover them from a pruned record.
- **Deliberately unfrozen:** artifact inventory and oracle. Under the instrument-first-run rule an instrument reaching a real dependency needs its own prior execution unit, so the oracle is built, run once against the dependency, and reviewed with that run in hand, before the unit whose predicate depends on it opens. Freezing an oracle here that nobody has run would be the weak-oracle failure that rule exists to prevent.

Admitted to **WP-13**.

### What Already Landed

The predecessor record's RT-1 and RT-2 checkpoints both read `Commit/PR: pending`, and that is wrong. Current-tree `apps/nanocore/src/internal-agents/worker-coordinator.ts` is the primary RT-2 evidence: it contains the concrete-imperative `use` classification. The candidate's test-first and independent-review history is real and is not repeated by this program. Only RT-3 was unfinished.

Commit `14f1e47b` and its diffstat (`+3181/-613` while uncommitted, later `+3272/-613` on 22 files, and 29 files at `+4112/-620` for the whole commit) are historical and non-reproducible evidence of that landing, not a current-tree probe and not a property later packages may compare against.

This correction is load-bearing: a successor that treated RT-1 and RT-2 as unfinished would rebuild work that is already in the current tree and already reviewed.

The accepted Chat-subordinate Gate identity carries forward unchanged — a non-secret Chat-subordinate Gate under the sole outer `chat.start` receipt with no nested `task.start`. WP-8 and WP-9 must preserve it.

## Impacted Surfaces

| Surface | Files |
| --- | --- |
| Conversation record model | `docs/core/work-model.md`, `docs/core/agent-session.md` |
| Agent mechanism and Tool boundary | `docs/core/agent-workflow.md`, `docs/core/agent-capability.md` |
| Assistant and interaction semantics | `docs/specs/20260704-chat_mode_assistant.md`, `docs/specs/20260709-quick_chat_workspace.md`, `docs/core/communication.md`, `docs/core/permissions.md` |
| Goal orchestration | `docs/specs/20260704-goal_mode_coordination.md`, `docs/specs/20260704-workflow_coordinator_internal_agent.md`, `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` |
| Runtime topology | `docs/core/sandbox.md`, `docs/core/runtime-model.md`, `docs/specs/20260802-nanohost_runtime_and_transport.md`, `docs/specs/20260703-runtime_scheduling_scale.md`, `docs/specs/20260703-worker_control_protocol.md` |
| Continuity, materialization, retention | `docs/specs/20260704-agent_session_continuity.md`, `docs/specs/20260704-session_static_workspace_materialization.md`, `docs/specs/20260703-workspace_synchronization.md`, `docs/specs/20260704-workspace_data_source_catalog.md`, `docs/core/storage.md`, `docs/specs/20260703-audit_usage_evidence_records.md` |
| NanoCore internal roles | `apps/nanocore/src/internal-agents/**`, `apps/nanocore/src/mode-entry-routes.ts`, `apps/nanocore/src/turn-routes.ts` |
| NanoCore runtime | `apps/nanocore/src/runtime/**`, `apps/nanocore/src/context/**`, `apps/nanocore/src/agents/**` |
| Worker runtime | `packages/worker-shim/**`, `containers/workers/**`, NanoHost transport routing |
| Web projection | `apps/web/src/screens/chat/**`, `apps/web/e2e/**` |
| Local guides | `apps/nanocore/src/internal-agents/README.md`, `apps/nanocore/README.md`, `apps/web/README.md` |

## Documentation Synchronization

Two rules apply beyond the ordinary ones.

**A local guide that forbids what an accepted owner now requires is a defect from the moment the owner is accepted.** `apps/nanocore/src/internal-agents/README.md` currently states that the direct Quick Chat provider call belongs to `mode-entry-routes.ts` and that no generic runner, registry, hook system, private event protocol, or streaming facade may be introduced in that directory. WP-2 accepts a role-agnostic bounded loop that lives exactly there. The guide is corrected inside WP-7, the package that makes it stale, and the correction narrows rather than deletes: the prohibition on a registry, hook system, private event protocol, and streaming facade survives, because the accepted loop has none of them.

**Each package updates the projections its own change makes stale.** Deferring them to closeout leaves the repository describing a state it is not in for the length of a long program.

## Coverage Map

Every decision and finding the input raised, each with exactly one disposition. Grouped by disposition rather than by subject so that what is *not* being built is as visible as what is.

### Admitted

| Decision | Package |
| --- | --- |
| Thread and Turn cardinalities, including `Thread to active Turn 1 -> 0..1` and `AgentSession to Thread N -> 1` | WP-1 |
| One Thread is addressed to exactly one counterpart; every handoff creates a new Thread in the executing Workspace | WP-1 |
| Turn terminal states `completed`, `interrupted`, `failed`, with `interrupted` first-class | WP-1 |
| Turn interruption is append-only; the in-flight Item is finalized from server-accumulated content as truncated | WP-1 |
| Thread classification fields `threadSource` and `parentThreadId` | WP-1 |
| Concurrent Goal worker executions each receive their own Thread; the Goal Main Thread keeps one reference Item per execution | WP-1 |
| `AgentSession` is the Core runtime-continuity identity for one governed conversation and is not the connection; internal roles have none | WP-1 |
| Worker runtime-internal child activity stays private provenance until it needs an independent responsibility | WP-1 |
| Role-agnostic bounded internal Agent loop, its input shape, three in-loop fuses, and four typed exits | WP-2 |
| Streaming is a transport concern; only finalized content becomes an Item; the increment observer is discardable | WP-2 |
| Minimal model-facing Tool shape; only name, description, and schema reach the provider; `execute` is server-bound | WP-2 |
| Canonical dotted Tool ID namespace, verb vocabulary, no wildcard authority, provider-safe alias mapping | WP-2 |
| Per-call Core reauthorization; Tool presence is not authority; publication guard as defense in depth | WP-2 |
| Tool admission is fixed per entry path in a deterministic order; absence is reserved for unreachability; a refused Tool returns its typed reason to the model | WP-2 |
| Minimal prompt contract, deterministic assembly order and owners, refresh and pinning, default exclusions | WP-2 |
| No durable toolset snapshot; restart reconstructs a new Turn from durable owners | WP-2 |
| Safety fuses are not capacity targets; conversational latency and cost objectives, and the four-times separation from the deadline fuse | WP-2 |
| Internal role execution profile: Turn pinning, compatible pre-dispatch fallback, fixed role evaluations, bounded rollout, configuration rollback | WP-2 |
| `AssistantReadScope` and `OutputAudience` as two separately governed decisions | WP-3 |
| No ambient Workspace injection; a selected Workspace is a scope hint | WP-3 |
| The fixed Assistant seed set for the ordinary conversational entry path | WP-3 |
| `workspace.create` is onboarding, not administration; Quick Chat work requests are never a dead end | WP-3 |
| Administration is a narrowed Assistant Turn on its own entry path and Thread, propose-shaped, human-approved | WP-3 |
| Approval strength graded by reversibility and blast radius, not by operation category | WP-3 |
| Conversation, observation, and command as three explicit semantic classes | WP-3 |
| Context and continuity precedence; provider memory is a replaceable cache | WP-3 |
| Human actor attribution; NanoCore does not arbitrate contradictory human intent | WP-3 |
| Goal Orchestrator is an independent role with exactly one Goal scope per Turn; no ambient global orchestrator | WP-4 |
| Goal `autonomyClass`, `budget`, and `completionVerification` fields, replacing the rejected `GoalDelegationEnvelope` | WP-4 |
| The eight Goal Orchestrator Tools, with `goal.task.cancel` replacing in-flight steering | WP-4 |
| The role is long-lived and its Turns are short; dispatch returns on admission; a Turn never blocks on a human or Worker | WP-4 |
| Single-flight is ordinary Turn admission on the Goal Main Thread; the only new durable state is one pending revision and optional `nextTurnAt` | WP-4 |
| Plan revision classification: execution refinement, material in-envelope adjustment, mandate expansion | WP-4 |
| Goal-owned repeated-work circuit breaker, distinct from the loop fuses | WP-4 |
| Knowledge Manager stays deterministic by default; semantic activation is propose-only | WP-4 |
| Independent quality roles and their three independence dimensions | WP-4 |
| Shared Sandbox co-residency, its compatibility and security envelope, and the three isolation levels | WP-5 |
| Capacity model: `maxOpenSessions`, `maxActiveTurns`, Sandbox aggregate bounds, NanoCore as capacity grantor | WP-5 |
| `SandboxCompatibilityKey` and `AgentSessionCompatibilityKey`; `HarnessCompatibilityKey` reserved for a later phase | WP-5 |
| Fixed typed Harness control operations; no arbitrary command, argv, environment, or shell protocol | WP-5 |
| Runtime record decomposition into Sandbox, Harness, AgentSession binding, and execution lease | WP-5 |
| Lifecycle and failure semantics per boundary, including fail-closed widening when local cleanup is unprovable | WP-5 |
| Per-Turn AEP and Context Package; no sandbox-wide authorization package or credential | WP-5 |
| Thread-affine AgentSession reuse, replacing the current warm-reuse deferral | WP-6 |
| Runtime setup generations, rolling replacement, and immediate security revocation | WP-6 |
| Workspace as a logical resource boundary; composite Turn input snapshot; source identity and locality | WP-6 |
| Workspace freshness without full rematerialization; AgentSession-persistent versus Turn-scoped slots | WP-6 |
| Non-canonical shared working material as a Sandbox-scoped class with four edge constraints | WP-6 |
| Agent data retention mapped onto existing Core classes; no raw audio or private reasoning by default; deletion by ownership | WP-6 |
| The Turn terminal-state set collapses from four to three: `cancelled` is removed and cancellation becomes an asynchronous request for interruption rather than a distinct terminal state | WP-1 states it in `docs/core/protocol.md`; WP-9 reconciles the runtime, which still returns `cancelled` |
| The Nano Server role map and its boundary column, and that Role, Agent, AgentSession, Harness, and Sandbox are different axes so no physical relationship transfers authority | WP-2, in `docs/core/architecture.md` which owns internal role definitions |
| Sanitized model-visible Tool failure content: useful for bounded correction, revealing no secret, restricted-resource existence, raw exception, host path, provider payload, private identifier, or policy internal | WP-2 |
| The five-class Assistant information-source table — Thread history, governed Knowledge, external observation, operational context, orchestration interaction — with per-class freshness and persistence rules | WP-3 |
| Goal wake conditions, coalescing, and the deterministic watcher preferred over a fixed ten-minute model poll, with that poll admitted only as a bounded fallback | WP-4 absorbs it; WP-11 implements it |
| Internal Agent loop and Tool contract implementation | WP-7 |
| Assistant role assembly, multi-turn context, seed Tool set, typed refusal | WP-8 |
| Runtime record decomposition and Thread-affine AgentSession implementation; IP-1 | WP-9 |
| Multiple open AgentSessions in one Harness, serial execution | WP-10 |
| Goal-scoped Orchestrator role assembly and bounded automatic progression | WP-11 |
| Real Responses relay and function-tool boundary for the worker images; IP-2 | WP-13 |

### Rejected

| Item | Authority for the rejection |
| --- | --- |
| A durable `BoundToolsetSnapshot` | A temporary immutable Tool array plus per-call Core admission preserves the boundary without another durable identity, expiry lifecycle, or authorization cache. Lands as an explicit exclusion in WP-2. |
| A broad permanent model-visible Tool catalog | Increases prompt cost, ambiguity, and accidental authority coupling, and makes internal extensibility appear supported before it is designed. WP-2. |
| Automatic Workspace context injection from UI selection | Selection narrows defaults and disambiguates references; it does not make Workspace data relevant to every conversation. WP-3. |
| A separate administration Agent role | A model role here is a proposer holding no authority, so a second role adds no fourth check and adds a second proposer, prompt, assembler, evaluation set, routing decision, and user-visible mode switch. Blast-radius separation comes from Turn-scoped Tool assembly. WP-3. |
| A separate intent-routing Agent before every Assistant response | Its purpose would be a perfectly minimal Tool list, and its failure mode is a false refusal. WP-2. |
| Decode-time masking, logit bias, or per-request tool-choice as a permission boundary | Masking exists to preserve a cached prefix, not to enforce authority; a boundary built on it is a per-request configuration rather than a structural fact. WP-2. |
| Per-message Tool selection of any kind, including a zero-Tool assembly chosen from the message | Classifying intent before answering is the rejected routing Agent. WP-2. |
| A per-Tool consecutive-failure rule | A fourth in-loop counter with no observed failure trace behind it. WP-2. |
| `goal.task.steer` and in-flight Task steering | Requires safe-point delivery, revision-bound payloads, a queued-versus-applied distinction, and delivery proof, and makes the Orchestrator a second writer into a running Turn. Cancel and re-dispatch is simpler and more truthful. WP-4. |
| `GoalDelegationEnvelope` | Six of its eight field groups already have exact owners; duplicating them creates competing authority. Dissolved into three Goal fields. WP-4. |
| A second mutation-capable persistent Orchestrator | Duplicate authority, competing dispatch, plan oscillation, and continuous token cost with no demonstrated unsatisfied need. WP-4. |
| A new Core `Conversation` entity, or concurrent Turns inside one AgentSession | Thread owns durable conversation history and AgentSession owns runtime continuity; a third entity duplicates truth. WP-1. |
| A shared writable canonical Workspace tree | Completion order would become an implicit merge policy and one AgentSession could take another's unreviewed output as input. WP-5. |
| One Sandbox-wide authority token | Would let one AgentSession impersonate another and merge worker-control, inference, capability, provider, and Vault authority. WP-5. |
| A duplicate durable internal Agent Harness | NanoCore already owns durable Thread, Turn, Goal, Task, Knowledge, command, usage, audit, and evidence state. WP-2. |
| WP-12 as an implementation package without an accepted Side Chat lifecycle owner | The 2026-08-20 search of `docs/core/communication.md` and `docs/specs/20260704-chat_mode_assistant.md` found zero `Side Chat` or `Side Thread` definitions. Its full owner-private Side Thread, subject binding, observation, addressing, promotion, replay, and failure criteria move to the Backlog row below and require an accepted owner before implementation under `[AUTH-003]`. |
| WP-14 as one bundled exact-trajectory proof | `docs/specs/20260529-l6_story_acceptance.md` now rejects a mechanical exact trajectory at L6 and warns against accumulating unrelated restart, steering, review, and recovery assertions in one story. Its criteria are not dropped: WP-9 receives restart reconstruction, WP-10 receives separate AgentSessions, WP-11 receives Goal progression and independent completion verification, WP-13 receives real relay, safe-point steering is already owned and checked by S16, and Side Chat moves to Backlog. |

### Backlog

Non-authorizing until a later change record admits it. Each names an owner and an activation condition.

| Item | Owner | Activation |
| --- | --- | --- |
| `web.search` bounded external observation | A new accepted external-observation specification | An accepted capability contract covering provider selection, query and content bounds, citation, freshness, untrusted-content treatment, usage, failure, and Knowledge promotion |
| Realtime voice Channel | A future accepted realtime Assistant Channel specification | An accepted Side Chat contract is implemented and verified, so text Thread, scope, Side Chat, addressing, interruption, and command semantics are stable |
| Goal Supervisor Turn | `docs/specs/20260704-goal_mode_coordination.md` | Goal traces show planning drift or missed anomalies that deterministic breakers and independent completion verification do not catch |
| Cross-Goal Program or Portfolio owner | None today | One accepted cross-Goal objective needs its own lifecycle, budget, dependencies, verification, and recovery |
| Personal and Deployment Knowledge scopes | `docs/core/knowledge.md` | An accepted ownership, visibility, retrieval, storage, export, and deletion contract |
| Work Overview product surface and cross-Workspace discovery | A new accepted work-discovery specification | WP-8 shows the bounded `work.search` and `work.read` reads insufficient for the Assistant journey |
| Rich user-driven Task-to-Goal promotion | `docs/specs/20260704-task_mode_worker_delegation.md` | The admitted lower-layer handoff predicates are verified and a user-driven promotion story independently satisfies current L6 admission; the existing rule-based escalation path stands until then |
| Runtime Phase 2, concurrent Turns across AgentSessions | `docs/specs/20260703-runtime_scheduling_scale.md` | WP-10 verified and one Harness adapter proves safe native multiplexing under real-runtime test |
| Runtime Phase 3, multiple Harness instances and families | `docs/specs/20260802-nanohost_runtime_and_transport.md` | A review requiring agent-runtime-family independence, which same-family review may not silently satisfy |
| Runtime Phase 4, eviction policy, read-only cache sharing, placement heuristics | `docs/specs/20260703-runtime_scheduling_scale.md` | Measured latency or memory need from production traces |
| Deferred `tool.find` progressive discovery | `docs/core/agent-capability.md` | Measured catalog scale or representative model selection errors that role routing cannot fix |
| Parallel Tool execution, dynamic Tool registration, generic hook pipelines, exact Turn replay | `docs/core/agent-workflow.md` | A concrete accepted need; none exists |
| Unattended administration without per-action human approval | A separately accepted durable owner | An accepted requirement for an unattended, event-triggered administration lifecycle with its own budgets, breakers, evidence, and recovery |
| Unversioned object-source manifests and large-data lazy access | `docs/specs/20260704-workspace_data_source_catalog.md` and its source adapters | One real source requires it |
| Human-centered usability principles: experience outcomes, progressive disclosure, grounded and honest progress, action clarity, cross-channel parity, scale without cognitive overload | `docs/core/work-model.md` and `docs/core/communication.md` for the parts they own; a product-surface specification for the rest | The Work Overview surface activates, since these principles describe the surface that displays it. Approval strength graded by reversibility is the one member already admitted, to WP-3, because WP-8 binds consequential Tools that need it |
| Warm Harness residency policy: at most one compatible default warm Harness for a recently active project Workspace, with activation signal, idle lifetime, memory ceiling, and eviction order | `docs/specs/20260703-runtime_scheduling_scale.md` | WP-10 verified, so a Sandbox can hold more than one AgentSession and residency has something to optimize |
| Off-peak Sandbox rebuild as drift control: close an idle aged Sandbox, discard local state, re-materialize from the current desired setup generation | `docs/specs/20260703-runtime_scheduling_scale.md` with `docs/specs/20260704-session_static_workspace_materialization.md` | Measured residency traces exist to set the idle and age thresholds. Accepted 2026-08-13 as a cost and hygiene mechanism only; per-Turn freshness is already guaranteed by the freshness barrier, so a stale resident Sandbox makes a Turn slower and never wrong |
| Layered autonomous cost and human-attention policy: deployment, user, Goal, and runtime-capacity ceilings; what is metered; attention severity, deduplication, rate limiting, and quiet periods | Deployment policy and `docs/core/metering.md` for the ceilings; `docs/specs/20260531-human_attention_intervention_model.md` for attention | WP-11 verified, so unattended progression exists to bound. The per-Goal `budget` field is the one member already admitted, to WP-4, because the Orchestrator cannot be built without it |
| Product acceptance definition as five end-to-end journeys: Assistant, Task, Goal, portfolio, and channel parity | A product-surface specification | WP-7 through WP-11 and WP-13 are verified and each proposed journey independently satisfies current L6 admission, so product journeys are layered over settled lower-level owners rather than over the discarded WP-14 trajectory |
| Owner-private Side Chat, direct addressing, and typed promotion | A new accepted Side Chat specification grounded in `docs/core/communication.md`, `docs/core/permissions.md`, and `docs/specs/20260704-chat_mode_assistant.md` | An accepted owner defines the exact Side Thread and subject binding, read and disclosure authority, creation through termination and restart, stale, replay, conflict, transport-uncertain, and terminal failure semantics, typed promotion causation and exactly-once outcome, and externally observable acceptance predicates; only a later change record may then admit implementation |
| The forty-eight remaining `validate` and `freeze-before-slice` triage items | Their named owners in the input's Question Triage | The feature slice that needs each one pulls it; unrelated slices proceed |

### Inherited Debt

The 2026-08-20 probe `rg -n -A 4 "^## Known Debt" docs/verification-instruments.md` returned `None.`; the two Known Debt entries this plan formerly inherited no longer exist. WP-13 still must assert the environment identity required by the current real-use rules, but that is a live gate input owned by `docs/change-execution.md`, `docs/verification-instruments.md`, and `docs/toolchain.md`, not inherited debt, and WP-14 is superseded before entry.

## Stalled-Program Reconciliation — 2026-08-20

This revision applies the queued-package necessity recheck, named-failure rule, and acquire-do-not-ask rule to present repository evidence without rewriting historical program state.

### Re-verified Program State

The read-only `jq` probe over `temp/state/202608130741380001-nanocore_agent_function_model.state.json` returned `revision=9`, `events=75`, `assignment_opened=18`, `assignment_closed=18`, `gate_recorded=4`, `escalation_raised=5`, and `verifier assignment_opened=0`. The first `status_changed` event states that revision 1 was written retroactively after the first two packages had already run and that its timestamps were reconstructed from git and a transcript; the file therefore cannot serve as contemporaneous evidence for those events even though its schema is valid.

| State observation | Re-verified result |
| --- | --- |
| Escalations | 5, all with `frameworkHypothesis: none` |
| Package status | WP-0 `verified`; WP-1 through WP-6 `implemented` at the same `2026-08-13T16:15:00Z` timestamp; none of WP-1 through WP-6 `verified` |
| Never-opened packages | WP-7 through WP-15 have zero assignments |
| Assignment-to-gate gap | 18 assignments closed but only 4 gates recorded, so closure of an assignment is not treated as package verification evidence |
| Verifier participation | No verifier assignment was ever opened anywhere in this program |

### What Closes WP-1 Through WP-6

The shared current precondition for every row is a fresh entry and exit gate over the current accepted owners, because the repository has moved since the 2026-08-13 build and assignment closure alone did not verify any package. Every row also requires the unconditional verifier that `docs/change-execution.md` requires before this change plan closes; no verifier ever ran in the recorded program.

| Package | What closes it | Did a verifier ever run? |
| --- | --- | --- |
| WP-1 | An independent reviewer reruns the ten-decision and reversed-Core residue checks over the final corrected owners, every named documentation command passes in an admitted environment, the package exit gate is recorded, and a coherence verifier attempts to falsify the final Thread, Turn, AgentSession, handoff, and terminal-state corpus. The existing WP-1 gate is `FAIL`; later builder releases have no subsequent recorded gate. | No; the state file contains zero verifier assignments. |
| WP-2 | The three reviewer-returned defects are repaired and independently rechecked: fuse scalars have closed finite positive domains and deadline grammar, latency and cost objectives name their observation population, interval, exclusions, and normalization, and `docs/core/architecture.md` states the independent Role, Agent, AgentSession, Harness, and Sandbox axes. All sixteen decisions and attributed rejections then pass, the exit gate is recorded, and a coherence verifier runs; WP-7 separately owns the relocated no-product-import predicate. | No; the state file contains zero verifier assignments. |
| WP-3 | The content review is rerun on current owners, the bounded pre-change Quick Chat comparison passes, the strong doc-model oracle runs in the required Node environment, direct human scrutiny accepts the binding read-scope, audience, publication, and authorization-failure rules, a Tier-4 different-family verifier runs when available, and the exit gate is recorded. The historical reviewer found the wording sound but raised Tier 4 and was environment-blocked; the 2026-08-20 `node --test tests/doc-model.test.mjs` probe now passes 66 of 66. | No; the state file contains zero verifier assignments. |
| WP-4 | The engineer-selected accepted owner resolves the current conflict between Core's rule that internal roles have no AgentSession and the Workflow Coordinator specification's separate-AgentSession quality-role wording, the Goal repeated-work breaker gains a closed trigger set, threshold, and comparison window, an independent reviewer clears all decisions and routed findings, the exit gate is recorded, and a coherence verifier runs. | No; the state file contains zero verifier assignments. |
| WP-5 | A refrozen exact owner inventory reconciles every active shared-Sandbox isolation claim, including the AgentSession-continuity and four out-of-lease specifications the reviewer named; the exact enumeration command and result are recorded; every claim names its isolation level; direct human scrutiny and a Tier-4 different-family verifier run when available; and the exit gate is recorded. | No; the state file contains zero verifier assignments. |
| WP-6 | WP-5 is verified first; an accepted owner either names who may authorize bounded raw-audio and runtime-private-reasoning capture or forbids that override; an independent reviewer reruns the six-decision list, baseline retention vocabulary, four shared-working-material edges, and closed F-3 disposition; a Tier-4 verifier runs; and the exit gate is recorded. | No; the state file contains zero verifier assignments. |

### Probes Acquired Under `[EVID-001]`

| Probe | Observed result | Decision changed or confirmed |
| --- | --- | --- |
| Read-only `jq` aggregation over the live state file | 75 events at revision 9; 18 opened and 18 closed assignments; 4 gates; 5 escalations all `none`; zero verifier assignments; WP-1 through WP-6 only `implemented` | Replaced the stale planned queue statuses, made every WP-1 through WP-6 closure obligation explicit, and prevented assignment closure from being treated as verification. |
| `rg -n "internalAgentLoop\|runInternalAgentLoop\|runInternalAgent" apps/nanocore/src apps/nanocore/e2e` plus current owner headers | Zero matches; `docs/specs/20260813-internal_agent_runtime.md` is `implementation: Not Started`; `apps/nanocore/src/internal-agents/README.md` still assigns the direct Quick Chat provider call to `mode-entry-routes.ts` | Confirmed WP-7 remains necessary. |
| `rg` over `mode-entry-routes.ts` and the Assistant owners, then `mise exec -- pnpm --filter @openkit/nanocore exec vitest run src/quick-chat.test.ts` | The source still calls one direct no-Tool Quick Chat provider path; the focused current-path suite passed 20 of 20 under Node 24.16.0 | Confirmed the current deterministic Chat path is healthy but does not satisfy the accepted role assembly, so WP-8 remains necessary. |
| `rg` over the continuity owner, `apps/nanocore/src/runtime/worker-backend-sessions.ts`, and production Turn status sites | `docs/specs/20260704-agent_session_continuity.md` says idle Thread-affine reuse is not implemented; `WorkerBackendSessionRecord` still carries lease, Workspace, Thread, Turn, AgentSession, package snapshot, runtime target, and physical backend identity together; production Turn paths still admit `cancelled`; the current Web self-check no longer contains the original second-restart Chat-subordinate Gate oracle | Confirmed WP-9 remains necessary and that its entry freeze must derive a new lowest-sufficient IP-1 regression instead of calling the changed browser file unchanged. |
| Current NanoHost and runtime-scheduling implementation projections | `docs/specs/20260802-nanohost_runtime_and_transport.md` explicitly says multiple open AgentSessions, the long-lived Harness monitor, fixed Harness operations, runtime-record decomposition, compatibility keys, and separate open-session capacity are not implemented | Confirmed WP-10 remains necessary. |
| Current Goal owners plus `rg -n "autonomyClass\|nextTurnAt\|goal\.completion\.propose\|goal\.task\.cancel" apps/nanocore/src --glob '!**/*.test.ts'` | The production search returned zero matches, and `docs/specs/20260704-workflow_coordinator_internal_agent.md` explicitly says the Goal-scoped Orchestrator, eight-Tool boundary, and independent completion verifier are not implemented | Confirmed WP-11 remains necessary. |
| `rg -n -i "side chat\|side thread" docs/core/communication.md docs/specs/20260704-chat_mode_assistant.md` | Zero matches | Found WP-12 is not admitted by a current owner; its criteria move intact to Backlog instead of opening an implementation lease. |
| `mise exec -- pnpm --filter @openkit/nanocore exec vitest run src/llm/gateway-converters.test.ts src/llm/pi-ai-client.test.ts` and `node apps/nanocore/e2e/pi-ai-real-provider-runner.mjs` | The deterministic function-tool and pi-ai boundary passed 31 of 31; the real-provider runner returned `SKIP ... set OPENKIT_L6_REAL_PROVIDER=1` | Confirmed lower-layer function conversion has landed but real relay evidence has not, so WP-13 remains necessary and its real run still requires explicit opt-in and an asserted environment identity. |
| `mise exec -- pnpm --filter @openkit/nanocore exec vitest run src/goal-steering-authority.test.ts` plus current L6 admission text | The S16 steering owner passed 9 of 9 under Node 24.16.0; the current L6 owner rejects an exact mechanical trajectory and warns against accumulating unrelated risks in one story | Settled the safe-point component outside WP-14 and superseded the bundled WP-14 proof while routing every other criterion to a named owner. |
| Initial focused app probes under ambient Node 22, followed by `mise current node` and exact rerun under `mise exec` | The first Quick Chat and steering runs failed on the Node native-module ABI and were classified as setup failures; `mise current node` returned 24.16.0, after which the same suites passed 20 of 20 and 9 of 9 | Demonstrated the `[TEST-013]` rule in this plan: environment failure settles no product predicate, and the cheap environment probe precedes escalation. |

### Queued-Package Necessity Recheck

| Package | Necessity verdict | Naming observation and disposition |
| --- | --- | --- |
| WP-7 | Still necessary | `docs/specs/20260813-internal_agent_runtime.md` is `Not Started`, the current loop-symbol search returned zero matches, and the local guide still names the direct provider path; refreeze from exact implementation and test files before entry. |
| WP-8 | Still necessary | `docs/specs/20260704-chat_mode_assistant.md` remains `Partial` and its Current Implementation Projection says fallback uses one direct no-Tool Quick Chat provider call; the current focused suite passed 20 of 20, proving the old path rather than the accepted role assembly. |
| WP-9 | Still necessary | The continuity owner says later-Turn Thread-affine reuse is absent, the backend session remains conflated, production still admits `cancelled`, and the former browser oracle has changed; refreeze a new lowest-sufficient IP-1 regression and exact runtime lease. |
| WP-10 | Still necessary | The current NanoHost implementation projection explicitly lists multiple open AgentSessions, long-lived Harness operations, record decomposition, compatibility keys, and separate open-session capacity as not implemented. |
| WP-11 | Still necessary | The current Workflow Coordinator implementation projection explicitly states that the Goal-scoped Orchestrator, exact eight-Tool boundary, and independent completion-verifier path are not implemented, and the production key-term search returned zero matches. |
| WP-12 | No longer necessary as a queued implementation package; superseded before entry | The current owning communication and Assistant documents contain zero `Side Chat` or `Side Thread` definitions, so `[AUTH-003]` does not admit implementation. The Backlog row named above replaces the package and preserves every Side Thread, authority, addressing, promotion, replay, and failure criterion until an accepted owner exists. |
| WP-13 | Still necessary | Deterministic gateway and function-tool tests pass 31 of 31, but the current Gateway owner remains `Partial` pending owner-governed Codex real-use evidence and the real-provider probe skipped without explicit opt-in; refreeze around the current pi-ai and worker-shim path rather than the eight-day-old predicted inventory. |
| WP-14 | No longer necessary as one bundled proof; superseded before entry | The current L6 owner rejects its exact mechanical trajectory and unrelated-risk aggregation, while S16 steering already passes 9 of 9. Its remaining criteria are transferred to WP-9, WP-10, WP-11, and WP-13, and the Side Chat criterion transfers to Backlog; no criterion is discarded. |
| WP-15 | Still necessary, but not admitted to open | The state file shows no verifier ever ran, WP-1 through WP-6 remain unverified, six still-necessary implementation or real-use packages remain unopened, and two superseded packages require their named dispositions to survive closeout; WP-15 remains the sole summary, final verifier, state-bundle, findings, and status-transition package. |

## Work Package Queue

The original queue has sixteen numbered packages. WP-0 through WP-4 are verified. WP-5 and WP-6 have landed implementation artifacts but are blocked: WP-5 on deferred F-9 unmet acceptance gates, and WP-6 on WP-5 verification or F-9. WP-7 is blocked by deferred F-15. WP-8 is blocked by deferred F-11, F-12, and WP-7. WP-9 is blocked by deferred F-9, F-11, and WP-8. WP-10 is blocked by deferred F-9 and WP-9. WP-11 is blocked by deferred F-10, F-12, WP-8, and WP-10. WP-12 and WP-14 are superseded. WP-13's relay-only focused suite passed 26/26 with ordinary independent reviewer PASS, but its predicate remains blocked by deferred F-13 and F-14. WP-15 is verified closeout: `mise exec -- pnpm -w verify:full` exit 0; `mise exec -- pnpm run check:repo` exit 0 with one unrelated informational Biome notice; relay focused 26/26; storage focused 24/24; NanoCore typecheck exit 0; targeted Biome exit 0; `git diff --check` exit 0; ordinary closeout reviewer PASS; critical Cursor CLI Claude Opus 5 final verifier/auditor PASS after inspecting the actual full diff.

Ordering rationale. WP-1 precedes the owners expressed through its record model; WP-2 precedes the Assistant and Orchestrator assemblies; WP-5 precedes WP-6; and all six absorption packages require verification before dependent implementation under `[AUTH-003]`. WP-7 precedes WP-8 because a role assembly needs the accepted loop, WP-9 precedes WP-10 because decomposition makes more than one resident AgentSession expressible, and WP-10 precedes WP-11 because Goal progression requires its admitted execution topology. WP-13 depends on WP-6 for its instrument, while its remaining predicate is blocked by deferred F-13 and F-14. WP-15 opens only when every Coverage Map item is verified, rejected with authority, blocked with a named dependency, or deferred with an owner and activation condition, and both superseded-package dispositions are accounted for.

The 2026-08-13 predicted queue is not an authorizing freeze after the 2026-08-20 recheck. Every still-necessary unopened package must refreeze all nine gate fields, the named predicate failure, smallest sufficient shape, exact non-overlapping artifact and apparatus inventory, risk tier, and expected magnitude from present observations before writes; the historical package blocks below preserve criteria and planning evidence and cannot themselves open a lease.

| Package | Mode | Status | Depends on |
| --- | --- | --- | --- |
| WP-0 Predecessor Retirement And Reference Repair | deletion | verified | none |
| WP-1 Conversation Record Model | implementation | verified | WP-0 |
| WP-2 Internal Agent Mechanism And Tool Boundary | implementation | verified | WP-1 |
| WP-3 Assistant Contract And Interaction Semantics | implementation | verified | WP-2 |
| WP-4 Goal Orchestration And Delegation Authority | implementation | verified | WP-2 |
| WP-5 Shared Sandbox Topology And Capacity | implementation | blocked | WP-1; artifacts exist; blocked deferred F-9 unmet acceptance gates |
| WP-6 Continuity, Materialization, And Agent Data | implementation | blocked | WP-5; artifacts exist; blocked on WP-5 verification or F-9 |
| WP-7 Internal Agent Loop And Tool Contract | implementation | blocked | WP-2; blocked deferred F-15 |
| WP-8 Assistant Role Assembly | implementation | blocked | WP-3, WP-4, WP-7; blocked deferred F-11, F-12, WP-7 |
| WP-9 Runtime Record Decomposition And Thread-Affine AgentSession | implementation | blocked | WP-5, WP-6, WP-8; blocked deferred F-9, F-11, WP-8 |
| WP-10 Multiple Open AgentSessions In One Harness | implementation | blocked | WP-9; blocked deferred F-9, WP-9 |
| WP-11 Goal-Scoped Orchestrator And Bounded Progression | implementation | blocked | WP-4, WP-8, WP-10; blocked deferred F-10, F-12, WP-8, WP-10 |
| WP-12 Side Chat, Direct Addressing, And Promotion | implementation | superseded | no accepted implementation owner; criteria moved to Backlog |
| WP-13 Real Responses Relay For Worker Images | implementation | blocked | WP-6; artifacts exist; relay-only focused suite 26/26 with ordinary independent reviewer PASS; predicate blocked deferred F-13, F-14 |
| WP-14 Primary End-To-End Proof | real-use verification | superseded | criteria distributed to WP-9, WP-10, WP-11, WP-13, S16, and Side Chat Backlog |
| WP-15 Closeout | closeout | verified | Coverage Map items verified, rejected, blocked, or deferred with owner/activation; WP-12 and WP-14 superseded; completed `mise exec -- pnpm -w verify:full` exit 0, `mise exec -- pnpm run check:repo` exit 0 with one unrelated informational Biome notice, relay focused 26/26, storage focused 24/24, NanoCore typecheck exit 0, targeted Biome exit 0, `git diff --check` exit 0, ordinary closeout reviewer PASS, critical Cursor CLI Claude Opus 5 final verifier/auditor PASS |

### WP-0 — Predecessor Retirement And Reference Repair — landed 2026-08-13

The deleted predecessor identified as `202608051330120001-chat_to_task_runtime_completion` had one unmet predicate, now carried as IP-1 above. Deletion is correct rather than a `superseded` status because that record's remaining function was to hold one unmet predicate, and a predicate held by a record nobody opens is not held.

What was done:

1. Recorded IP-1 and the What Already Landed correction in this record, before deleting the source. This is the pruning precondition in `docs/change-execution.md`: durable content is promoted before the record is removed.
2. Deleted the predecessor record.
3. Repaired the three forward-looking references that had named the predecessor as the owner of the transferred Chat-to-Task runtime correction and as the dependency releasing the Web S23 browser oracle. They now name this record.
4. Left two historical NanoHost prose mentions as written at the time. Those mentions sat inside a closed package's frozen artifact lease and a checkpoint deviation; they were not forward-looking links.
5. Regenerated `docs/INDEX.md`.

`temp/state/202608051330120001-chat_to_task_runtime_completion.state.json` is untracked working space and is left to the record-retention program that owns the twelve non-conforming state files.

**Open obligation, discharged 2026-08-13.** Independent review of this package and of this record's freeze block was owed, because the primary agent authored both under engineer direction and `[GOV-017]` is satisfied only by an adjudicator that wrote neither. It was discharged by two independent review passes with deliberately disjoint scopes — one over factual claims against the repository, one over internal coherence, ownership, tier, and dependency claims — both of which reached exactly the stated scope and returned findings that changed the plan: two artifact inventories named documents whose own headers disclaim the concern, four tiers were understated, two dependency edges were missing, and the coverage map was incomplete. The queue's ordering claim survived; the ownership and tier claims did not.

Two defects in how that review was run are recorded in `findings.md` rather than here, because a package's own record is the wrong place to grade the adjudication of that package: the primary agent produced WP-0 at all (`F-4`), and the orchestrator re-rated the reviewer's severities in place instead of returning an inflated report to a second adjudicator (`F-5`).

### WP-1 — Conversation Record Model

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/documentation-model.md`; `docs/core/core-concepts.md`; `docs/core/runtime-model.md`; `docs/core/protocol.md`; `docs/core/agent-session.md`
- **Seam:** the durable conversation record model — what a Thread, a Turn, and an AgentSession are, and what each may not be
- **Artifact inventory:** `docs/core/core-concepts.md`; `docs/core/runtime-model.md`; `docs/core/protocol.md`; `docs/core/agent-session.md`; `docs/core/work-model.md` as a projection updated by the same change
- **Scope:** the eight admitted WP-1 decisions in the Coverage Map. Excludes runtime topology, capacity, the Agent mechanism, and every role contract
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 3. Changing an owned Core decision is Tier 3 under `[TIER-007]`; no security, authorization, credential, sandbox-containment, data-loss, or irreversible external surface is touched. This package reverses an accepted Core decision, which raises the review bar within Tier 3 rather than the tier itself
- **Dependencies:** WP-0 independently reviewed
- **Predicate, decided half:** every decision in this package's Decisions block is stated by its named owner and satisfies `[DOC-017]`'s five decision classes or explicitly states which class does not apply; and the three accepted-Core statements this package reverses no longer appear anywhere in `docs/core/`
- **Predicate, open obligation:** that no owner contradicts another anywhere in the corpus is an unbounded search and is **not** decided by this package's oracle. It is carried openly under Verification below and is discharged by the coherence verifier at package exit, which owns the accumulated-corpus question
- **Oracle:** `strong`; the finite decision list checked item by item against the named owners by an independent reviewer, plus `node scripts/validate-doc-model.mjs`, `node scripts/validate-spec-lifecycle.mjs`, `node scripts/generate-doc-index.mjs --check`, and `node --test tests/doc-model.test.mjs`. Each is prior, finite, reproducible, and re-runnable. The named predicate failure is that the reviewer identifies one missing, misowned, incomplete, or contradicting decision or one surviving reversed-Core statement, or that a named command reports its own documentation-model, lifecycle, index, or test assertion failure; setup, permission, or collection failure leaves the predicate undecided. The reviewer's judgement about whether wording reads well informs and decides nothing
- **Failure disposition:** a decision the owner cannot express without contradicting an accepted specification is a design conflict and stops under `[PRECEDENCE-003]`; ordinary wording defects repair in place
- **Next owner:** test author for the standing admission matrix, builder, independent reviewer, then WP-2

#### Expected magnitude

Two files, roughly 120 to 200 added lines. The estimate exists to be wrong in a detectable way: a package that lands 500 lines in these two Core documents has stopped distilling and started copying, which is the `[DOC-015]` failure in the opposite direction from omission.

#### Decisions

Each line names a decision and its owner. The argument for each lives in the input; what must survive here is the criterion.

**Owner correction, 2026-08-13.** An earlier freeze of this package assigned every decision below to `docs/core/work-model.md`. That was wrong and an independent review caught it. `work-model.md` states at its head that it owns how work appears to users and product surfaces, and `docs/core/protocol.md` states that `docs/core/core-concepts.md` owns the `Workspace -> Thread -> Turn -> Item[]` hierarchy and the canonical definitions of those records. `work-model.md` is a projection here and is updated to follow, never to lead.

**This package reverses an accepted Core decision.** `docs/core/runtime-model.md` currently admits "parallel turns assigned to different agents" inside one thread and states under `## Parallel Work` that parallel work is represented by multiple turns inside one thread; `docs/core/core-concepts.md` currently says a Thread may involve parallel turns. The accepted direction is the opposite. The engineer decided on 2026-08-13 that Core yields and the direction stands. Reversing an accepted decision is this package's work rather than a side effect of it, so the reversal is stated explicitly in each owner and the superseded wording is deleted rather than left standing beside its replacement.

1. `docs/core/core-concepts.md` — the cardinality set, including `Thread to active Turn 1 -> 0..1` and `AgentSession to Thread N -> 1`, and the invariant that parallel work is parallel Threads rather than parallel Turns in one lane. Delete the `parallel turns` admission from the Thread definition.
2. `docs/core/runtime-model.md` — replace `## Parallel Work` so that parallel work is multiple Threads, each with at most one Turn in flight, and remove `parallel turns assigned to different agents` from the list of what a thread may contain. This is the reversal named above and is the single most consequential edit in the package.
3. `docs/core/core-concepts.md` — one Thread is a durable narrative addressed to exactly one conversational counterpart; a handoff always creates a new Thread in the Workspace that will own execution, and the originating Thread retains a handoff Item referencing it, so no Thread spans two Workspaces. A worker execution Thread has no conversational counterpart and is classified rather than addressed, which the wording must not blur.
4. `docs/core/protocol.md` — Turn terminal states are `completed`, `interrupted`, and `failed`. `protocol.md` already owns lifecycle states, cancellation, and interruption semantics and already lists `interrupted` among its terminal states, so this decision narrows and confirms an existing owner rather than introducing a state.
5. `docs/core/protocol.md` — interruption is append-only: nothing is rolled back, rewritten, or deleted, and the in-flight Item is finalized from server-accumulated content and marked truncated rather than discarded. For a media channel the truncation point is what was generated, which the record must not assert the user perceived.
6. `docs/core/core-concepts.md` — Thread classification fields `threadSource` and `parentThreadId`.
7. `docs/core/runtime-model.md` — each concurrently scheduled Goal worker execution receives its own Thread and its own AgentSession; the Goal Main Thread retains one reference Item per execution and does not accumulate worker Items.
8. `docs/core/work-model.md` — projection only. Update the user-facing description of parallel work so it no longer describes several agents working inside one Thread. This file states no cardinality and defines no record.
9. `docs/core/agent-session.md` — AgentSession is the Core runtime-continuity identity for one independently governed conversation. It is not the connection to the sandbox; the Harness Instance is the connection and may hold many AgentSessions, and the backend-private conversation inside it is the NativeConversationHandle. Internal roles such as Assistant and the Goal Orchestrator run no worker runtime and have no AgentSession.
10. `docs/core/agent-session.md` — worker runtime-internal child activity remains private provenance beneath the owning AgentSession and Turn until it needs independent permission, budget, scheduling, retry, recovery, review, user-visible ownership, or terminal status, at which point NanoCore schedules it as a separate Turn rather than promoting a hidden child retrospectively.

### WP-2 — Internal Agent Mechanism And Tool Boundary

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/core/architecture.md`; `docs/core/agent-workflow.md`; `docs/core/agent-capability.md`; `docs/core/core-concepts.md` as amended by WP-1
- **Seam:** the boundary between a role and the mechanism it runs on, and between the model and the environment
- **Artifact inventory:** one new narrow specification under `docs/specs/` owning the internal Agent runtime; `docs/core/agent-capability.md`; `docs/core/agent-workflow.md` and `docs/core/architecture.md` as pointers only
- **Scope:** the fourteen admitted WP-2 decisions plus the explicit rejection list. Excludes every role contract and every runtime placement decision
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 3. This package changes governing documentation for the mechanism and Tool contract but does not enforce authorization, handle credentials, alter containment, delete data, or cause an irreversible external effect; WP-7 and WP-8 own enforcement and carry their own current tiers. New evidence may raise this classification under `[TIER-005]`, but the entry gate does not delegate tier discovery to the reviewer
- **Dependencies:** WP-1 verified
- **Predicate, decided half:** every decision in this package's Decisions block is stated by its named owner and satisfies `[DOC-017]`'s five decision classes or explicitly states which class does not apply
- **Predicate, relocated:** that the mechanism is expressible without the loop knowing a Thread, Turn, Goal, or Workspace exists is **not** decided here. Review cannot settle it and an executable check can, so it moves to WP-7, whose oracle asserts the module's imports directly
- **Oracle:** `strong`; same instrument as WP-1, over the decided half only. The named predicate failure is that the reviewer identifies one of the sixteen decisions or attributed rejections as missing, misowned, incomplete, or contradictory, or that a named command reports its own documentation-model, lifecycle, index, or test assertion failure; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** a decision requiring the loop to know a product concept is a design conflict and stops; a decision that needs more implementation detail than a Core document may carry moves into the new narrow specification within this package rather than being dropped
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-3 and WP-4

#### Owner correction, 2026-08-13

An earlier freeze assigned the loop to `docs/core/agent-workflow.md`. That document states at line 8 that it does **not** own agent runtime substrate, agent session continuity, agent supply, or agent capability routing, and the role-agnostic bounded loop is exactly agent runtime substrate. `docs/core/architecture.md` owns the internal role definitions for Core Assistant, Workflow Coordinator, and Knowledge Manager, which this package's role assemblies sit under.

The correction is therefore not to widen `agent-workflow.md`'s scope but to create the narrow specification the disclaimer already anticipates and to align the Core owners without a forbidden direct Core-to-spec dependency path. `[QUALITY-003]` asked whether that specification is needed at all; the disclaimer answers yes, because no existing owner may hold it. The accepted result now observed in `docs/specs/20260813-internal_agent_runtime.md`, `docs/core/agent-capability.md`, `docs/core/agent-workflow.md`, and `docs/core/architecture.md` settles the former placement question: the specification owns the loop, `agent-capability.md` owns capability admission and projection, and the two other Core documents preserve their boundaries without downward links.

#### Expected magnitude

One new specification of roughly 200 to 300 lines, plus 40 to 80 lines across `agent-capability.md`, `agent-workflow.md`, and `architecture.md` for the ownership pointers and the narrowed exclusions.

#### Decisions

1. The role-agnostic bounded loop: its input shape, its ownership boundary, and the rule that it consumes an already assembled prompt, messages, Tools, model, limits, and signal.
2. The three in-loop fuses — provider round trips, environment touches, wall clock — and why token, cost, and no-progress limits are excluded because each has a better existing owner.
3. The four typed exits and the absence of a fifth; a role ending a Turn early cancels through the abort signal.
4. The loop algorithm, including refusal to execute a truncated or incomplete Tool call and the rule that model text cannot set an authoritative stop flag.
5. Sequential Tool execution as the first implementation, with parallel batches, in-loop asynchronous injection, dynamic model changes, hook pipelines, and exact replay deferred.
6. Streaming as a transport concern: the return value is unchanged, the increment observer carries no product semantics and may be ignored, only finalized content becomes an Item, and role progress travels on Item and status projections instead.
7. The minimal Tool shape, with only name, description, and schema eligible for provider projection and the `execute` closure and internal details server-side.
8. Sanitized model-visible errors: useful for bounded correction, revealing no secret, restricted-resource existence, raw exception, host path, provider payload, private identifier, or policy internal.
9. The canonical dotted Tool ID form, the verb vocabulary, the rule that a namespace is not a capability hierarchy, and provider-safe aliasing that never reconstructs authority by parsing.
10. Authority-bound execution: server-created closures, per-call Core reauthorization, Tool presence as permission to request rather than proof of authorization, and the final publication guard as defense in depth.
11. Tool admission fixed per entry path in a deterministic order; absence reserved for unreachability rather than rarity; a present-but-refused Tool returns its typed reason to the model as a Tool result; a cross-entry-path request produces a proposed new Thread rather than a refusal.
12. The minimal four-part prompt contract, the deterministic assembly order and its owners, refresh and pinning, and the default exclusion list.
13. No durable toolset snapshot; restart abandons the in-memory run and reconstructs a new Turn from durable owners under existing idempotent command identity.
14. Fuses are emergency fuses, not capacity targets; the conversational latency and cost objectives and their four-times separation from the deadline fuse; and the placement of those objectives as limit-profile configuration values so that revising one changes no design document and branches no code path.
15. The internal role execution profile: one Turn pinned to its resolved provider, model, prompt, Tool definitions, context policy, and limits; compatible pre-dispatch fallback only; fixed role evaluations before a default change; bounded rollout and configuration rollback.
16. The explicit rejection list, stated as exclusions in the owning documents rather than only in this record.

### WP-3 — Assistant Contract And Interaction Semantics

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/specs/20260704-chat_mode_assistant.md`; `docs/specs/20260709-quick_chat_workspace.md`; `docs/core/communication.md`; `docs/core/permissions.md`; `docs/core/agent-capability.md` as amended by WP-2
- **Seam:** what the Assistant may read, what it may disclose, and what counts as a command
- **Artifact inventory:** `docs/specs/20260704-chat_mode_assistant.md`; `docs/specs/20260709-quick_chat_workspace.md`; `docs/core/communication.md`; `docs/core/permissions.md`
- **Scope:** the nine admitted WP-3 decisions. Excludes Web Search, Personal and Deployment Knowledge, the Work Overview surface, and realtime voice, all of which are backlog
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 4. The recorded WP-3 escalation observed that `docs/core/permissions.md` now carries binding Assistant read-scope, output-audience, publication, and authorization-failure rules, so authorization is the highest touched surface; this package does not touch credentials, sandbox containment, irreversible external effects, or data deletion
- **Dependencies:** WP-2 verified
- **Predicate, decided half:** as WP-1, over this package's decision list
- **Predicate, bounded comparison:** the accepted Quick Chat boundary is unchanged in capability and changed only in that a work request can no longer terminate in a bare refusal. This claim is quantified over one named document rather than over the corpus, so it is decided here — but by a clause-by-clause comparison against the pre-change revision, never by a reviewer's impression of the finished text
- **Oracle:** `strong`; same instrument as WP-1, plus `git diff` of `docs/specs/20260709-quick_chat_workspace.md` against its pre-change revision, read clause by clause against the capability list that revision states. Both are prior, finite, reproducible, and re-runnable. The named predicate failure is that the reviewer identifies one missing, misowned, incomplete, or contradicting Assistant decision, the comparison shows any pre-change Quick Chat capability widened or removed beyond replacing the bare work-request refusal, or a named command reports its own documentation-model, lifecycle, index, or test assertion failure; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** a disclosure decision that cannot be stated without widening an accepted permission boundary stops and escalates under `[SCOPE-004]`
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-8

#### Expected magnitude

Four files, roughly 250 to 400 added lines.

### WP-4 — Goal Orchestration And Delegation Authority

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/specs/20260704-goal_mode_coordination.md`; `docs/specs/20260704-workflow_coordinator_internal_agent.md`; `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`; `docs/core/agent-workflow.md` as amended by WP-2
- **Seam:** the boundary between deterministic Goal control and bounded semantic judgement, and the record of what a Goal may do unattended
- **Artifact inventory:** `docs/specs/20260704-goal_mode_coordination.md`; `docs/specs/20260704-workflow_coordinator_internal_agent.md`; `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`; `docs/specs/20260704-task_mode_worker_delegation.md`, added 2026-08-13 to settle `F-1`, which found that this file was in no package's lease while holding a live contradiction against WP-1; the Goal owner that must carry `autonomyClass`, `budget`, and `completionVerification`
- **Scope:** the nine admitted WP-4 decisions, plus `F-1` and `F-2` from `findings.md`, which are the two places where accepted Goal and Task delegation still derive a worker Turn from the originating Thread and therefore contradict what WP-1 accepted. Excludes the Goal Supervisor and any cross-Goal owner
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 3. This package changes governing documentation for Goal delegation and narrows existing permission through autonomy fields but does not itself enforce authorization, run an unattended effect, handle credentials, alter containment, delete data, or cause an irreversible external effect; WP-11 owns enforcement at Tier 4. New evidence may raise this classification under `[TIER-005]`, but the entry gate does not delegate tier discovery to the reviewer
- **Dependencies:** WP-2 verified
- **Predicate, decided half:** as WP-1, over this package's decision list; additionally, the three autonomy fields narrow existing permissions and can never widen them, checked against `docs/core/permissions.md` and the Goal owner named in the artifact inventory
- **Predicate, open obligation:** that no accepted document anywhere lets model confidence close a Goal is quantified over the whole corpus, is an unbounded search, and is **not** decided by this package's oracle. It is carried openly under Verification and discharged by the coherence verifier at program exit, which owns the accumulated-corpus question
- **Oracle:** `strong`; same instrument as WP-1, over the decided half only. The named predicate failure is that the reviewer identifies one missing, misowned, incomplete, or contradictory Goal decision, one autonomy field that widens existing permission, one unresolved routed finding, or one Goal repeated-work breaker without a closed trigger set, threshold, and comparison window, or that a named command reports its own documentation-model, lifecycle, index, or test assertion failure; corpus-wide model-confidence wording outside the finite inventory remains the separately named verifier obligation rather than a gate failure
- **Failure disposition:** an autonomy field that would widen an existing permission stops and escalates
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-11

#### Expected magnitude

Three to four files, roughly 200 to 350 added lines. Net line count may be negative in `goal_mode_coordination.md`, because dissolving the envelope returns six field groups to owners that already hold them.

#### Ownership boundary this package must change

`docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` states under `## Does Not Own` that it does not own provider or model execution, a generic internal-role runner or registry, event hooks, private lifecycle state, or scheduling, and that any future provider-backed operation requires its own accepted design. The optional semantic Knowledge Manager Turn is exactly a provider-backed operation. This package therefore amends that disclaimer rather than assuming the specification already covers the case, and the amendment is itself the accepted design the disclaimer asks for. Landing the Turn while the disclaimer stands would leave the specification contradicting its own contents.

### WP-5 — Shared Sandbox Topology And Capacity

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/core/sandbox.md`; `docs/core/runtime-model.md`; `docs/specs/20260802-nanohost_runtime_and_transport.md`; `docs/specs/20260703-runtime_scheduling_scale.md`; `docs/specs/20260703-worker_control_protocol.md`
- **Seam:** what may be shared inside one Sandbox and what may never be
- **Artifact inventory:** the five documents above
- **Scope:** the seven admitted WP-5 decisions. Excludes runtime Phases 2 through 4
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 4. Co-residency, credential visibility class, and containment are sandbox-containment surfaces under `[SCOPE-004]`, so this package requires direct human scrutiny and, where available, a reviewer or verifier from a different model family
- **Dependencies:** WP-1 verified
- **Predicate, decided half:** as WP-1, over this package's decision list; additionally, within the document set enumerated at package entry — every file under `docs/core/` and `docs/specs/` matching a recorded search for Sandbox co-residency, sharing, and isolation, whose exact invocation is written into the package's evidence — no document presents shared-Sandbox co-residency as hard security isolation, and every isolation claim states which of the three levels it makes
- **Predicate, open obligation:** that no document outside that enumerated set makes such a claim in wording the search did not match is not decided by the oracle. Under `[SCOPE-004]` it is not deferred either: it is the specific question put to the Tier-4 human gate and to the different-family verifier, who search by meaning rather than by term
- **Oracle:** `strong`; same instrument as WP-1, plus the recorded enumeration search, plus direct human scrutiny at the Tier-4 gate. The enumeration is prior, finite, reproducible, and re-runnable; the human gate decides only the residue the enumeration cannot reach. The named predicate failure is that the finite search finds one shared-Sandbox co-residency or isolation statement with no named isolation level, direct human scrutiny identifies one semantically equivalent hard-isolation claim outside the matched set, or a named command reports its own documentation-model, lifecycle, index, or test assertion failure; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** any wording that could be read as claiming security isolation from logical namespacing blocks and returns to the engineer
- **Next owner:** test author, builder, independent reviewer, different-family verifier, engineer, then WP-6

#### Expected magnitude

Five files, roughly 200 to 350 added lines. `nanohost_runtime_and_transport.md` is 1527 lines and already carries the target transport; most of this package is narrowing and correcting rather than adding.

#### Ownership boundary this package must change

`docs/specs/20260802-nanohost_runtime_and_transport.md` states that one sandbox may host a worker harness with multiple runtime-native agents or provider sessions **only after another accepted owner defines that harness behavior**, and that such multiplicity creates no additional Core AgentSessions, scheduling slots, transport authorities, or current implementation scope under that specification. The present accepted NanoHost specification now carries the topology decision and its explicit current non-implementation projection, so the former question about whether to create a separate owner is settled by observation rather than deferred to a reviewer. Closure still requires the refrozen exact owner enumeration described above because the historical lease omitted four active projections named by its reviewer.

### WP-6 — Continuity, Materialization, And Agent Data

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/specs/20260704-agent_session_continuity.md`; `docs/specs/20260704-session_static_workspace_materialization.md`; `docs/specs/20260703-workspace_synchronization.md`; `docs/specs/20260704-workspace_data_source_catalog.md`; `docs/core/storage.md`; `docs/specs/20260703-audit_usage_evidence_records.md`
- **Seam:** what a later Turn may reuse, and what an Agent feature is allowed to retain
- **Artifact inventory:** the six documents above
- **Scope:** the six admitted WP-6 decisions, plus `F-3` from `findings.md`, which is the concrete test of this package's own retention predicate: WP-1 made an ephemeral Thread select the shortest existing Core retention class, and that class turns out to be `ephemeral-diagnostic`, defined for health checks rather than for conversation content. Excludes large-data lazy access and unversioned object manifests, which are backlog
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 4. The package governs retention, deletion, raw-audio capture, and runtime-private-reasoning capture, and the recorded WP-6 escalation found no authority holder for the capture override; authorization and data-loss are therefore the highest touched surfaces. It does not touch credentials, sandbox containment, or an irreversible external effect outside the governed retention and deletion boundary
- **Dependencies:** WP-5 verified
- **Predicate:** as WP-1, over this package's decision list; additionally, Agent data introduces no new retention class or vocabulary, checked against the class list `docs/core/storage.md` states before this change, and the non-canonical shared working material class carries all four edge constraints, without which it is a bypass around staged apply. Both additions are quantified over named documents and a fixed four-item list, so both are decided here
- **Oracle:** `strong`; same instrument as WP-1, plus two fixed checklists: the retention class list `docs/core/storage.md` states before this change, and the four named edge constraints. Both are prior, finite, reproducible, and re-runnable. The named predicate failure is that the comparison finds one new retention class or vocabulary term, a checklist finds one missing shared-working-material edge constraint, the reviewer finds one omitted or misowned decision or unresolved `F-3` disposition, or a named command reports its own documentation-model, lifecycle, index, or test assertion failure; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** a retention mapping that needs a class the Core owner does not have stops and escalates rather than inventing one
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-7

#### Expected magnitude

Six files, roughly 200 to 300 added lines. `agent_session_continuity.md` is where the current warm-reuse deferral is replaced, which is a rewrite of one section rather than an addition.

### WP-7 — Internal Agent Loop And Tool Contract

- **Authority:** `AGENTS.md`; `docs/change-execution.md`; `docs/core/agent-workflow.md` and `docs/core/agent-capability.md` as amended by WP-2; `docs/specs/20260529-test_strategy.md`
- **Seam:** one NanoCore-local module implementing the accepted loop and Tool contract, with no product surface consuming it yet
- **Artifact inventory:** new modules under `apps/nanocore/src/internal-agents/`; `apps/nanocore/src/internal-agents/README.md`
- **Scope:** the loop, the Tool contract, the fuses, the typed exits, the truncated-call refusal, the sanitized error path, the discardable increment observer, and the alias mapping. Excludes every role assembly and every Tool implementation that reaches a real owner
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 2; one owner, no public contract, no durable state
- **Dependencies:** WP-2 verified
- **Predicate:** the loop completes a no-Tool Turn, validates arguments, rejects an unknown Tool, sanitizes a failure, feeds results sequentially, honors abort, reports provider failure, trips each of the three fuses, and reports exactly one typed terminal outcome; an execution with no increment observer produces identical messages, Items, evidence, and outcome to one with an observer; the module imports no Thread, Turn, Goal, Workspace, or Worker type
- **Oracle:** `strong`; L1 focused tests written before production under `[TEST-002]`, plus package typecheck, build, and Biome. The named predicate failure is one focused assertion that a no-Tool Turn, argument validation, unknown-Tool rejection, error sanitization, sequential result feeding, abort, provider failure, any one fuse, exactly-one terminal outcome, observer equivalence, or the forbidden product-type import violates the predicate, or a named typecheck, build, or Biome command reports its own subject failure; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** a loop that cannot be written without importing a product type is a finding against WP-2's accepted boundary and returns there
- **Next owner:** test author, builder, independent reviewer, then WP-8

#### Local guide correction

`apps/nanocore/src/internal-agents/README.md` currently forbids a generic runner in this directory. WP-2 accepts one, so the guide is corrected here rather than at closeout. The correction narrows: a registry, hook system, private event protocol, and streaming facade remain forbidden, because the accepted loop has none of them, and the boundary that produced the original prohibition is the one being preserved.

### WP-8 — Assistant Role Assembly

- **Authority:** `docs/specs/20260704-chat_mode_assistant.md` and `docs/specs/20260709-quick_chat_workspace.md` as amended by WP-3; `docs/core/agent-capability.md` as amended by WP-2
- **Seam:** the Assistant entry path, from `mode-entry-routes.ts` through the loop to a finalized Item
- **Artifact inventory:** `apps/nanocore/src/mode-entry-routes.ts`; new role-assembler modules under `apps/nanocore/src/internal-agents/`; Tool implementations binding `knowledge.search`, `work.search`, `work.read`, `workspace.create`, `task.start`, and `goal.start` to their existing owners; `apps/nanocore/README.md`
- **Scope:** true multi-turn Thread context assembly, the fixed seed Tool set in deterministic order, per-call reauthorization, typed refusal returned to the model, and the Quick Chat handoff path that resolves or creates the executing Workspace inside one confirmation. Excludes `web.search`, administration Tools, and the Work Overview surface
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 4. This package puts `AssistantReadScope` and `OutputAudience` into enforcement, so a defect here discloses material to an audience that lacks authority; that is an authorization surface under `[SCOPE-004]` and needs direct human scrutiny and a different-family reviewer or verifier when available. An earlier freeze called it Tier 3 on the grounds that it changes public Chat behaviour, which named the visible half of the change and missed the enforcing half
- **Dependencies:** WP-3 verified; WP-4 verified, because `goal.start` creates a Goal and the three Goal autonomy fields are resolved at creation from the handoff package, so binding that Tool before WP-4 would create Goals with no autonomy contract; WP-7 verified
- **Predicate:** a general question completes with no Workspace, Knowledge, operational, Web, Goal, Task, or Worker read; the Turn carries its entry path's complete fixed Tool set in a stable order regardless of the message; a Workspace question retrieves only bounded selected data after reauthorization and preserves provenance and freshness; a refused Tool returns its typed reason to the model as a Tool result; a Quick Chat work request reaches an accepted Task or Goal through one confirmation that also resolves or creates the executing Workspace, or produces a durable refusal Item naming the exact missing authorization; the accepted Chat-subordinate Gate identity is unchanged
- **Oracle:** `strong`; L1 and L2 focused tests written before production, plus the existing Chat suites. The named predicate failure is one assertion showing message-dependent Tool admission, an unauthorized or over-broad read or publication, a typed refusal not returned as Tool feedback, a Quick Chat handoff that neither settles nor durably names the missing authorization, or changed Chat-subordinate Gate identity, or a named suite reports its own subject failure; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** exact-lease defects repair in place; a Tool that cannot be bound without widening an owner's contract stops
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-9

### WP-9 — Runtime Record Decomposition And Thread-Affine AgentSession

- **Authority:** `docs/core/sandbox.md`, `docs/core/runtime-model.md`, and `docs/specs/20260703-runtime_scheduling_scale.md` as amended by WP-5; `docs/specs/20260704-agent_session_continuity.md` as amended by WP-6
- **Seam:** the current Worker Backend Session record, which conflates lease, Workspace, Thread, Turn, AgentSession, package, physical backend session, and cleanup lifecycle
- **Artifact inventory:** `apps/nanocore/src/runtime/**`; `apps/nanocore/src/agents/**`; the worker backend session store and its recovery path
- **Scope:** split the conflated record into Sandbox binding, Harness instance, AgentSession runtime binding, and execution lease; implement Thread-affine AgentSession reuse with compatibility and hygiene checks; reconcile the runtime `TurnStatus` enum with the three-state terminal set WP-1 states in `docs/core/protocol.md`, which requires retiring `cancelled` as a terminal value and re-expressing every path that currently produces it as an interruption request against a Turn that still terminates `interrupted`; settle IP-1. Excludes a second resident AgentSession, which is WP-10
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 3; durable state and lifecycle change
- **Dependencies:** WP-5 and WP-6 verified; WP-8 verified, because this package must prove the then-current Chat path rather than a path the program is about to discard
- **Predicate:** a second Turn in one Task Thread reuses the exact compatible idle AgentSession and receives fresh authority, or visibly replaces it when compatibility or revocation forbids reuse; no runtime path, recovery path, control record, or public type admits a terminal Turn status outside `completed`, `interrupted`, and `failed`, and a cancellation that previously produced `cancelled` now produces `interrupted` with its cause preserved rather than a fourth state or a silently dropped one; **IP-1**: after two in-place NanoCore restarts the exact active owner tuple is either reconstructed or the outcome is a truthful interruption, and the visible Gate answer is never a bare `409 recovery_required` standing in for lost ownership
- **Oracle:** `strong`; L1 state and recovery tests written before production, plus L3 NanoCore process tests for restart adoption, plus a new lowest-sufficient IP-1 regression derived at entry from the current Chat and Gate path because the 2026-08-20 observation found that the former browser file no longer contains the exact second-restart oracle. The named predicate failure is one assertion showing incompatible AgentSession reuse, any surviving terminal `cancelled` state, loss or substitution of the active owner tuple, or a second-restart Gate answer of bare `409 recovery_required` rather than exact reconstruction or truthful interruption, or a named suite reports its own subject failure; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** a restart case that cannot be reconstructed truthfully must produce an explicit interrupted or unknown outcome, never a substituted compatible session; inability to express that stops and escalates
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-10

### WP-10 — Multiple Open AgentSessions In One Harness

- **Authority:** `docs/core/sandbox.md`, `docs/core/runtime-model.md`, `docs/specs/20260802-nanohost_runtime_and_transport.md`, `docs/specs/20260703-worker_control_protocol.md`, and `docs/specs/20260704-session_static_workspace_materialization.md` as amended by WP-5 and WP-6
- **Seam:** one Sandbox, one Harness, several open AgentSessions, one active Turn across the Harness
- **Artifact inventory:** `packages/worker-shim/**`; NanoHost transport demultiplexing; `apps/nanocore/src/runtime/**`; per-AgentSession workspace namespaces
- **Scope:** AgentSession creation and native-handle binding, per-AgentSession namespaces and route separation, exact interrupt and close isolation, capacity accounting, restart adoption, and AgentSession-local cleanup proof with fail-closed widening. Serial execution only; concurrency across AgentSessions is backlog
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 4; sandbox containment and credential isolation
- **Dependencies:** WP-9 verified
- **Predicate:** one Sandbox and one Harness retain at least two independent AgentSessions; each maps to exactly one Core identity and one restricted native handle; neither can authenticate to the other's routes or write into the other's namespaces; interrupting or closing one does not affect the other when local isolation is proved; unprovable local cleanup drains and fences the wider boundary before capacity returns; no public record, log, audit, or evidence contains a native conversation id, backend sandbox id, process key, or sibling content
- **Oracle:** `strong`; L1 isolation and capacity tests, L2 Harness routing and interrupt tests, L3 NanoCore process tests, plus strict cross-AgentSession security tests; direct human scrutiny at the Tier-4 gate. The named predicate failure is one assertion showing cross-AgentSession authentication or namespace write, sibling interruption or close, capacity return before required fencing, wrong Core-to-native binding, or public leakage of a private runtime identifier or sibling content, or direct human scrutiny identifies an equivalent isolation breach; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** any isolation predicate that cannot be proved blocks the package rather than being downgraded to a claim
- **Next owner:** test author, builder, independent reviewer, different-family verifier, engineer, then WP-11

### WP-11 — Goal-Scoped Orchestrator And Bounded Progression

- **Authority:** `docs/specs/20260704-goal_mode_coordination.md` and `docs/specs/20260704-workflow_coordinator_internal_agent.md` as amended by WP-4
- **Seam:** the Goal control path, from a wake condition to one bounded Orchestrator Turn to an admitted Goal Task
- **Artifact inventory:** `apps/nanocore/src/internal-agents/**`; the Goal service and its record; the Goal step and progression route
- **Scope:** the three Goal autonomy fields; the eight Goal Tools; wake conditions, coalescing, and `nextTurnAt`; single-flight through ordinary Turn admission on the Goal Main Thread; each concurrent worker execution in its own Thread with a reference Item in the Main Thread; the Goal-owned repeated-work breaker. Excludes the Supervisor
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 4. `autonomyClass` is what decides which effects run without returning to the user, so this is the package that makes irreversible effects reachable unattended; `[SCOPE-004]` binds regardless of ordinary proportionality
- **Dependencies:** WP-4, WP-8, and WP-10 verified
- **Predicate:** after one delegation and any required Plan approval, an ordinary multi-step Goal advances through more than one ready Task without a per-step user action; an Orchestrator Turn settles in seconds to minutes and never blocks on a human or a Worker; an effect outside the Goal's autonomy class stops at a typed Approval even when the initiating actor holds the underlying permission; budget exhaustion pauses and requests attention; ending a Turn without a Tool call mutates nothing; only an accepted completion proposal plus its verifier can close the Goal; no separate claiming protocol exists
- **Oracle:** `strong`; L1 Orchestrator Turn tests written before production, plus L3 Goal progression tests. The named predicate failure is one assertion showing a required per-step user action, an Orchestrator Turn waiting on a human or Worker, an out-of-class effect executing without typed Approval, progression continuing after budget exhaustion, a no-Tool Turn mutating state, Goal closure without an accepted completion proposal and independent verifier, or a separate claiming protocol, or a named suite reports its own subject failure; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** a progression that cannot stop reliably at a gate, review, policy boundary, budget, pause, failure, or recovery uncertainty blocks
- **Next owner:** test author, builder, independent reviewer, verifier, then WP-15 after every other necessary package

### WP-12 — Side Chat, Direct Addressing, And Promotion

**Necessity disposition, 2026-08-20:** Superseded before entry because no accepted Side Chat owner admits implementation. This historical block preserves every criterion under `[DOC-015]`, but it opens no artifact lease; the Backlog row above replaces it and names the accepted-owner precondition.

- **Authority:** `docs/core/communication.md` and `docs/specs/20260704-chat_mode_assistant.md` as amended by WP-3
- **Seam:** the owner-private Side Thread, its subject binding, and the typed promotion bridge
- **Artifact inventory:** `apps/nanocore/src/**` Side Thread projection and promotion commands; `apps/web/src/screens/**`
- **Scope:** one owner-private Side Thread per actor and work subject; bounded actor-authorized subject observation with a freshness point; the default non-effect boundary; the four-stage promotion bridge over existing commands; addressee routing for Assistant, Orchestrator, and an exact Worker. Excludes realtime voice
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 4. One user's owner-private Side Thread and Personal Knowledge must not reach another user who can observe the same Goal, which is an authorization surface rather than a presentation one
- **Dependencies:** none; superseded before entry, with every criterion preserved in the named Backlog row
- **Predicate:** Side Chat answers progress questions without pausing, steering, rescheduling, or consuming worker context; another user cannot read its Items merely because both observe the Goal; no Side Item enters the Goal Main Thread, Orchestrator context, Worker AgentSession, Context Package, Artifact, or Knowledge Store without one explicit target-specific promotion; a promotion preserves causation, transfers only selected content, and produces exactly one authoritative result under replay; a failed, stale, conflicted, terminal, or transport-uncertain promotion is never represented as delivered and never retargets
- **Oracle:** `strong`; L1 promotion and routing tests, L2 visibility tests, plus L3 story tests. If a future accepted owner readmits these retained criteria, the named predicate failure is one assertion showing a co-observer reading owner-private Items, unselected Side content reaching a Main Thread, Orchestrator, Worker, Context Package, Artifact, or Knowledge Store, promotion losing causation or duplicating its authoritative outcome, or failed, stale, conflicted, terminal, or transport-uncertain delivery being represented as successful; setup, permission, or collection failure leaves the predicate undecided
- **Failure disposition:** any path by which unselected Side transcript content reaches worker context blocks
- **Next owner:** the Backlog owner; no implementation role until an accepted Side Chat specification admits a later change record

### WP-13 — Real Responses Relay For Worker Images

- **Authority:** `docs/specs/20260802-nanohost_runtime_and_transport.md`; `docs/specs/20260526-llm_gateway_responses_api.md`; `docs/specs/20260721-worker_execution_environment_images.md`; `docs/verification-instruments.md`; `docs/toolchain.md`
- **Seam:** the provider relay between a worker image's native runtime and the LLM Gateway, and the function-tool boundary the owner requires
- **Artifact inventory:** refrozen at entry from a CodeGraph caller trace and an `rg` inventory of the current pi-ai client, Gateway converter, worker-shim relay, governed worker-image, real-provider runner, fixtures, and focused tests; the historical `containers/workers/**`, `packages/worker-shim/**`, and Gateway-relay globs are predictions and authorize no write
- **Scope:** settle IP-2. The current Codex and OpenCode images fail the real Responses relay while a real text-only Chat bridge passes and its owner-required function-tool boundary fails
- **Mode and permitted writes:** implementation
- **Risk tier:** Tier 4 from entry. An earlier freeze said Tier 3 raised to Tier 4 at any step reaching a real remote host or real credentials, which was wrong: this package's predicate is a real provider relay, so it cannot be settled without reaching them and there is no Tier-3 portion to open first
- **Dependencies:** WP-6 verified. Independent of WP-7 through WP-11 and may open whenever the one-writer and Tier-4 gates permit
- **Predicate:** **IP-2**: the governed worker images complete a real Responses relay, and the owner-required function-tool boundary holds, under a declared environment identity
- **Oracle:** to be declared at entry without weakening the required class; the run against the real dependency is its own execution unit under the instrument-first-run rule, and the instrument's first contact is scheduled before the unit whose predicate depends on it. The named predicate failure is that, after environment assertion and the first provider-relay observable, at least one governed worker image fails to complete the real Responses relay or the owner-required function Tool call-and-result boundary fails; fixture setup, permission, collection, missing opt-in, or environment-assertion failure before that observable returns the fixture and leaves the predicate undecided
- **Failure disposition:** an attempt terminating in fixture-owned setup before the predicate's first observable is a fixture return and consumes no attempt budget; a missing environment identity blocks under the current real-use gate instead of being improvised inside the attempt
- **Next owner:** test author, builder, independent reviewer, verifier, engineer, then WP-15 after every other necessary package

#### Note on the dependent record

`docs/specs/20260713-work_resource_interaction_model.md` owns the deferred Web and Work-Resource remainder that waited on this predicate. This program does not resume that remainder; when WP-13 settles, that specification's next owning change record decides what it does with the result.

### WP-14 — Primary End-To-End Proof

**Necessity disposition, 2026-08-20:** Superseded before entry because the current L6 owner rejects this bundled exact trajectory. This historical block preserves the criteria under `[DOC-015]`; WP-9 owns restart reconstruction, WP-10 owns separate AgentSessions, WP-11 owns dependency-ordered progression and independent completion verification, WP-13 owns real relay, accepted S16 and its focused check own safe-point steering, and the Side Chat Backlog owns the remaining criterion.

- **Authority:** `docs/specs/20260529-l6_story_acceptance.md` for the necessity disposition; the receiving owners named above for the preserved criteria
- **Seam:** the whole direction, exercised once
- **Artifact inventory:** none; superseded before entry, with the historical one-story-check prediction authorizing no apparatus or fixture write
- **Scope:** one Goal with two dependency-ordered Tasks in separate Threads and separate Worker AgentSessions, one owner-private Side Chat, one human safe-point steering input, one restart reconstruction, and one independent completion verification. Excludes parallel writes, multiple Harness families, a Supervisor, realtime voice, Web Search, and a global Orchestrator
- **Mode and permitted writes:** real-use verification
- **Risk tier:** Tier 4
- **Dependencies:** none; superseded before entry, with each receiving package carrying its own current prerequisites
- **Predicate:** the sequence completes with every Turn retaining its own AgentSession, lease, context, evidence, and terminal outcome, and with completion produced by the accepted verification path rather than by the Orchestrator that planned the work
- **Oracle:** declared at entry without weakening the required class; the instrument's first run against its real dependency would have been a separate prior execution unit. The retained named predicate failure is that one step of the sequence fails or any Turn loses its own AgentSession, lease, context, evidence, or terminal outcome, or the planning Orchestrator produces completion without the independent accepted verification path; because the package is superseded, no run is admitted and each named failure is now owned by the receiving package above
- **Failure disposition:** a failure isolates to the owning package and returns there; this package opens no production lease
- **Next owner:** the receiving packages named in the necessity disposition; no WP-14 lease opens

### WP-15 — Closeout

- **Scope:** implementation summary, final verification evidence, remaining follow-ups, commit and PR links, `findings.md`, and status transition. No new behavior. The legacy `temp/state/202608130741380001-nanocore_agent_function_model.state.json` remains absent and is not reconstructed as bundle `state.json`
- **Mode and permitted writes:** closeout
- **Risk tier:** Tier 1
- **Dependencies:** every Coverage Map item verified, rejected with authority, blocked with a named dependency, or deferred with an owner and activation condition; WP-12 and WP-14 dispositions preserved
- **Predicate:** every Coverage Map item is verified, rejected with authority, blocked with a named dependency, or deferred with an owner and activation condition; no projection describes a superseded state; the input proposal is no longer required by any accepted document
- **Oracle:** `strong`; `pnpm -w verify:full` and `pnpm run check:repo`, plus one verifier run unconditionally before close. The named predicate failure is either command returning nonzero for its own repository check or the independent verifier naming one unresolved Coverage Map item, stale projection, missing required input disposition, incoherent receiving-package transfer, or other falsified closeout predicate; setup, permission, or collection failure leaves closeout undecided
- **Failure disposition:** an unmet Coverage Map item blocks closeout and receives a disposition rather than a summary
- **Next owner:** engineer

## Closeout Summary

This closeout documents the stable NanoCore-user, NanoCore-NanoHost, and NanoCore-Worker-Agent interaction boundaries. Nullable NanoCore-private `pinnedGoalId` physical storage and migration landed on ordinary `SandboxRuntimeRecord` with no production selection, read, write, reuse, or queue behavior. The relay-only default-off harness landed and passed 26/26 but does not prove real provider, governed images, or function-tool. WP-1 through WP-4 are verified; WP-5 through WP-11 and WP-13 are blocked through deferred F-9 through F-15; WP-12 and WP-14 are superseded. This closeout adds no special Sandbox, public field, denial state, compatibility path, or legacy state reconstruction.

## Verification

Tests precede every production change under `[TEST-002]`. Producers release exact leases before independent adjudication, and no producer adjudicates its own artifact under `[GOV-017]`.

- **Absorption packages, WP-1 through WP-6.** `node scripts/validate-doc-model.mjs`, `node scripts/validate-spec-lifecycle.mjs`, `node scripts/generate-doc-index.mjs --check`, `node --test tests/doc-model.test.mjs`, and `git diff --check`, plus the finite per-package decision list checked item by item by an independent reviewer.
- **Implementation packages, WP-7 through WP-11.** Focused L1 and L2 tests at the lowest sufficient layer under `[TEST-009]`, package typecheck, build, scoped Biome, and independent review; L3 NanoCore process tests where a predicate names restart, isolation, or progression. WP-12 opens no lease unless a later accepted owner and change record readmit its preserved criteria.
- **Real use, WP-13 only.** One recorded session per predicate against real dependencies, with the environment identity asserted before the attempt, distilled into this record and then discarded. WP-14 opens no session because its criteria are distributed to their lowest sufficient owners.
- **Program exit, WP-15 only.** `pnpm -w verify:full` and `pnpm run check:repo`, plus one verifier unconditionally before close.

**2026-08-28 final evidence.** `mise exec -- pnpm -w verify:full` exit 0; `mise exec -- pnpm run check:repo` exit 0 with one unrelated informational Biome notice; relay focused 26/26; storage focused 24/24; NanoCore typecheck exit 0; targeted Biome exit 0; `git diff --check` exit 0; ordinary closeout reviewer PASS; critical Cursor CLI Claude Opus 5 final verifier/auditor PASS after inspecting the actual full diff. A1 action was only read-only `pnpm host:assert a1` at identity digest `8b9f2b84ba56f9284e45466f096b9b3f4c70238a20433892e783332861948e97`; no service start, stop, or mutation. Commit is this single closeout commit; PR not requested.

The legacy `temp/state/202608130741380001-nanocore_agent_function_model.state.json` remains absent and must not be appended or reconstructed as this bundle's `state.json`. Out-of-scope findings go to `findings.md` in the same bundle.

A coherence verifier runs at each work-package exit, because every package here touches two or more owners.

**One open obligation runs the length of the absorption phase.** Each absorption package's oracle decides that its own named decisions reached their named owners. It does **not** decide that no owner anywhere in the corpus contradicts another, because that is an unbounded search over roughly twenty Core documents and seventy-three specifications, and an unbounded judgement may inform a gate but may not decide one. That question belongs to the coherence verifier at each package exit, which owns the accumulated-corpus claim and carries the attribution requirement: a contradiction it names must identify the diff in which this program introduced or worsened it, or it is dispositioned as pre-existing.

Stating this openly is the point. An earlier freeze declared the absorption oracle `strong` over a predicate that included corpus-wide non-contradiction, which would have recorded a decision the instrument never made. The independent review that found it also demonstrated the cost of the gap: it discovered, by reading owners the packages had not named, that `docs/core/runtime-model.md` asserted the opposite of this program's central invariant. Nothing in the declared oracle would have caught that, because the contradicting document was not in the artifact inventory.

## Risks

| Risk | Mitigation |
| --- | --- |
| The input is uncommitted and could be lost before WP-6 lands its decisions. | Stated as an explicit retention obligation under How To Use This Record. WP-1 through WP-6 are ordered first for this reason, not only for `[AUTH-003]`. |
| Absorption becomes copying, and 3593 lines of discussion enter the owning documents. | The `[DOC-016]` two-implementers bar is the accept criterion, the expected-magnitude figures are deliberately falsifiable, and a package that overshoots them is evidence of copying rather than of thoroughness. |
| Absorption becomes compression, and a criterion that changes implementation is dropped. | `[DOC-015]` binds, each package carries a finite named decision list, and the reviewer checks membership item by item rather than reading for impression. |
| The program is long, and a later package silently re-decides something an earlier one accepted. | Every implementation package's Authority field names the amended owner rather than this record, and a package that finds its owner silent stops and returns to the absorption package that owed it. |
| Sixteen packages exceed what one plan can hold, and the queue drifts. | The planning-drift breaker counts against each package's independently reviewed pre-write execution-unit denominator, and the sixty-event budget applies per package. Reaching either stops for engineer disposition rather than re-planning in place. |
| Shared-Sandbox co-residency is described or implemented as hard isolation. | WP-5 is Tier 4 with a predicate that every isolation claim names which of three levels it makes, and WP-10's isolation predicates block rather than downgrade. |
| The Assistant gains disclosure reach ahead of its audience boundary. | `AssistantReadScope` and `OutputAudience` land together in WP-3, before WP-8 binds a single read Tool. |
| An implementation package invents an owner because absorption left a gap. | The gap is a finding against the absorption package, recorded in `findings.md` and returned there; `[AUTH-002]` forbids deciding it in code. |
| WP-13 reaches a real host with no environment identity, reproducing the four-return sequence the instrument-first-run rule was written for. | The current real-use authority and exact preflight probe are named explicitly, the attempt budget is consumed only at the predicate's first observable, and a missing environment assertion returns or blocks rather than being improvised. |

## Checkpoints

- 2026-08-28 — Verdict: verified. Bounded landing: stable three interaction boundaries documented; nullable NanoCore-private `pinnedGoalId` physical storage and migration on ordinary `SandboxRuntimeRecord` with no production selection, read, write, reuse, or queue behavior; relay-only default-off harness 26/26 without real provider, governed-image, or function-tool proof. Unresolved findings F-9 through F-15 remain deferred. Ordinary closeout reviewer PASS. Critical Cursor CLI Claude Opus 5 final verifier/auditor PASS after inspecting the actual full diff. Commit/PR: this single closeout commit; PR not requested.
- 2026-08-20 — Verdict: stalled plan reconciled against current authority, repository observations, and the unmodified historical state file; no queued package opened. Commit/PR: pending. Predicate: each never-opened package has a present-evidence necessity disposition, each package oracle names its predicate failure, WP-1 through WP-6 have explicit closure obligations and verifier status, and repeated tier, dispatch, and lease falsifications change future entry and handoff behavior. Deviation: WP-12 is superseded before entry because no accepted Side Chat owner exists, WP-14 is superseded because the current L6 owner rejects its bundled exact trajectory, and `F-8` records that revision 9 and 75 retroactively reconstructed or incompletely gated events cannot substantiate contemporaneous execution history.
- 2026-08-13 — Verdict: WP-1 built and independently reviewed; review returned PREDICATE NOT MET; correction round opened; WP-2 opened. Commit/PR: pending. Predicate: every WP-1 decision is stated by the owner this record names and carries `[DOC-017]`'s five classes, and no accepted document contradicts what WP-1 accepted. Deviation: the reviewer found that the Goal Main Thread's reference Item was stated with no lifecycle and no failure semantics, that `docs/core/runtime-model.md` still permitted sequential Turns by different Agents inside one Thread while a neighbouring line removed the only reason that would happen, and that `docs/core/agent-session.md` converted an optional binding list into whole-life mandatory bindings this record never admitted. Deviation: retiring `cancelled` left four accepted documents still producing it, which is the corpus-wide contradiction this record had carried as an open obligation and which the review made finite and therefore fixable now rather than at program exit. Deviation: three further contradictions were routed to `findings.md` as `F-1`, `F-2`, and `F-3` because their owners are WP-4 and WP-6, and `docs/specs/20260704-task_mode_worker_delegation.md` was found to be in no package's lease while holding one of them. Deviation: WP-2 opened before WP-1 was verified, recorded as `F-6`. The oracle claims on WP-3 through WP-6 were also corrected, and the correction was not uniform: only WP-4 and WP-5 carried a genuinely corpus-quantified claim and were split, while WP-3 and WP-6 were quantified over named documents all along and needed their instrument named rather than their predicate reduced.
- 2026-08-13 — Verdict: freeze block independently reviewed by a different model family and corrected; WP-1 opened. Commit/PR: pending. Predicate: the absorption packages name the documents that actually own the decisions they land, and no package declares an oracle that decides more than it can. Deviation: the review found WP-1 and WP-2 assigned to the wrong owners — `docs/core/work-model.md` is a product projection while `docs/core/core-concepts.md` owns the canonical Thread and Turn definitions and `docs/core/protocol.md` owns lifecycle states and interruption, and `docs/core/agent-workflow.md` explicitly disclaims agent runtime substrate. Deviation: it also found that `docs/core/runtime-model.md` and `docs/core/core-concepts.md` currently assert the opposite of this program's central invariant, a conflict neither the input nor this record had recorded; the engineer decided under `[PRECEDENCE-003]` that Core yields, which makes WP-1 a reversal of an accepted Core decision rather than a statement of a new one. Deviation: WP-8, WP-11, and WP-12 were reclassified from Tier 3 to Tier 4, WP-13 to Tier 4 from entry, and nine decisions absent from the Coverage Map were dispositioned.
- 2026-08-13 — Verdict: program opened; WP-0 implemented and pending independent review. Commit/PR: pending. Predicate: the predecessor's unmet predicate and the two converging stalled predicates have an execution owner, and no accepted document depends on a deleted record. Deviation: the predecessor's RT-1 and RT-2 checkpoints recorded `Commit/PR: pending` while their complete 22-file candidate is committed in `14f1e47b`; this record corrects that rather than reproducing it, because a successor that treated those packages as unfinished would rebuild reviewed work.

## Adaptive-loop pilot cutover

### Intent Epoch 1 — 2026-08-20 / 515a7e9cd1154e4b39a24574dc71885f5f32b94a (append-only)

The accepted product, ownership, and strict-risk intent in this record is unchanged. Its earlier package queue, matrices, assignments, gates, events, exact leases, ceilings, denominators, and fixed role sequence remain historical Evidence only and no longer authorize dispatch. Accepted decisions, observed facts, and produced artifacts remain inputs to current work; none is deleted or reconstructed.

### Intent Epoch 2 — 2026-08-28 / engineer's current request (append-only)

Finish and close this plan, then make one commit. Independent Claude consultant review of blockers continues, and a consultant PASS authorizes continuation. Execution uses Herdr with an independent Cursor Grok test-author or tester and builder and a Claude verifier or auditor. A1 and local `~/.codex/auth.json` are authorized only when a slice needs them. Small in-scope issues are fixed in place; large out-of-scope architecture or module gaps are recorded in findings. Accepted product, ownership, and strict-risk intent from Epoch 1 is unchanged.

### Intent Epoch 3 — 2026-08-28 / engineer's Goal pin and boundary-stability clarification (append-only)

Internal agent implementation and Goal scheduling may change substantially, while the NanoCore-user, NanoCore-NanoHost, and NanoCore-Worker-Agent interaction boundaries remain stable. The Goal Mode Orchestrator must not dispatch Goal work through the default standby-worker selection; on first worker-bearing admission it pins one compatible ordinary Sandbox to that Goal as a NanoCore scheduling strategy, retains it warm for later compatible Goal worker AgentSessions, and uses an ordinary Sandbox rather than a GoalSandbox, new isolation class, NanoHost verb, AEP or worker-control field, or user or App API field.

### Current checkpoint

- **Next Action:** Terminal handoff to the engineer; this plan is verified.
- **Expected change:** Artifact — closeout documentation now matches current bytes: WP-1 through WP-4 verified, WP-5 and WP-6 blocked with landed artifacts preserved, physical Goal-pin schema landed without production behavior, WP-13 relay-only focused suite 26/26 with ordinary independent reviewer PASS, and F-9 through F-15 deferred with named receivers.
- **Expected observable:** plan frontmatter is `status: verified`; findings Follow-up Index lists deferred F-9 through F-15; WP-15 is verified; Sandbox Core names the existing queued admission and non-terminal Goal outcome with no new denial branch.
- **Evidence that changes route:** a later Goal-aware placement selector, NanoCore-private receiving-Thread projection, Goal-creation autonomy-field write, function-call correlation oracle, real-relay environment, WP-7 classifier decision, or WP-5/WP-6 Tier-4 gates would reframe the matching deferred finding rather than this checkpoint's package table.
- **Human-only decision:** This slice used only the read-only `pnpm host:assert a1`; no service start, stop, or mutation. A1 and local `~/.codex/auth.json` remain authorized only when a later slice needs them.

WP-1 through WP-4 are verified. WP-5 and WP-6 have landed implementation artifacts but are blocked: WP-5 on deferred F-9 unmet acceptance gates, and WP-6 on WP-5 verification or F-9. WP-7 is blocked by deferred F-15. WP-8 is blocked by deferred F-11, F-12, and WP-7. WP-9 is blocked by deferred F-9, F-11, and WP-8. WP-10 is blocked by deferred F-9 and WP-9. WP-11 is blocked by deferred F-10, F-12, WP-8, and WP-10. WP-12 and WP-14 remain superseded. WP-13's deterministic relay-only focused suite passed 26/26 with ordinary independent reviewer PASS; Harness Admission dynamically covers detached success, nonzero, timeout/SIGKILL, cleanup settlement, timeout and cleanup independent attribution, malformed or exact-credential RESULT rejection, and exactly-one terminal evidence. That instrument remains relay-only and does not prove real NanoCore, provider, image, or function-tool behavior and does not discharge IP-2; the real-relay half is blocked by deferred F-14 and the function half by deferred F-13. WP-15 is verified: ordinary closeout reviewer PASS and critical Cursor CLI Claude Opus 5 final verifier/auditor PASS after inspecting the actual full diff; `mise exec -- pnpm -w verify:full` exit 0; `mise exec -- pnpm run check:repo` exit 0 with one unrelated informational Biome notice; relay focused 26/26; storage focused 24/24; NanoCore typecheck exit 0; targeted Biome exit 0; `git diff --check` exit 0. F-9 through F-15 are deferred with named receivers and activation conditions and are not discharged here. The nullable private `SandboxRuntimeRecord.pinnedGoalId` physical schema, migration, and harness-record physical-home plus wire-boundary test landed with reviewer PASS; production placement still has no Goal-aware selector, read, or write, current admission lacks Goal, and same-Goal reuse plus other-Goal existing-scheduler queued retry with a non-terminal Goal remain unimplemented. No public, wire, special-Sandbox, or new-denial pin is claimed. The current WP-7 observer-equivalence oracle concerns only loop-owned messages and exit; caller tests own Items and evidence. The historical WP-7 package block retains its original predicate text as evidence and is not rewritten. The legacy `temp/state/202608130741380001-nanocore_agent_function_model.state.json` remains absent and must not be appended or reconstructed. `refs/stash` currently protects `515a7e9c`, `14f1e47b`, and `e70ad9d9`; do not drop, pop, or clear it, and create no preservation refs.

### Pilot start boundary

Resume by reading actual artifacts, owners, diffs, and check output, not by replaying the former queue. Continue from WP-1 toward the smallest observed material gap, preserving accepted criteria while allowing the method and necessary independent functions to adapt. One writer owns a path at a time, and artifact acceptance must inspect the artifact rather than rely on its producer's report.
