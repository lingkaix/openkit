# Core, Specification, Implementation, And Test Alignment Audit

Type: change-plan
Status: in-progress

## Intent

Audit OpenKit's complete current design hierarchy against its real implementation, tests, and practical product use, then reconcile every confirmed design defect, documentation drift, implementation defect, ownership conflict, test gap, and real-use gap in a controlled sequence.

This is a review-led alignment program rather than a documentation rewrite. Each Core document and each active specification must be examined together with its owning code paths, public projections, persistence, failure and recovery behavior, security boundaries, focused tests, integration tests, and relevant L6 stories before the document is declared aligned.

## Scope

- Add a dedicated `docs/core/foundation.md` that owns the highest-level OpenKit doctrine, human authority model, system responsibilities, and cross-aspect invariants.
- Retain `docs/core/metering.md` as a Core aspect and audit both its active non-gateway measurement foundation and its deferred system-wide aggregation, budget, and cost boundaries.
- Retain deliberate future Core concepts such as the Generative Kernel, Task Evaluator direction, workflow graphs, branches, joins, lineage, and recipes while keeping their activation and prerequisites visible in `docs/roadmap.md`.
- Audit all 20 current Core aspect documents, including Foundation and Metering as separate owners.
- Audit all 61 active root specifications against Core authority, implementation, tests, current use, and related change plans.
- Use the 57 archived specifications only as historical evidence, replacement evidence, or prior-art context; do not treat them as current implementation contracts.
- Audit related product, API, deployment, application, package, MCP, Skill, cookbook, story, and governance documents after their owning Core and specification contracts are settled.
- Correct unreasonable or infeasible design, stale or duplicated documentation, implementation divergence, unsafe or incomplete behavior, missing failure handling, and insufficient L0-L6 coverage discovered by the audit.
- Preserve explicit design direction while moving implementation-specific fields, routes, schemas, storage layouts, backend mappings, algorithms, and rollout details to the owning specification or implementation guide.
- Keep this change record as the canonical review list, checkpoint ledger, scope record, and final reconciliation summary.

## Non-Goals

- Do not remove `docs/core/metering.md` merely because its complete implementation is future work.
- Do not remove deliberate future Core boundaries merely because their specifications or implementations are still being completed.
- Do not assume that the document is correct and the code is wrong; the audit must be willing to classify the design itself as defective or impractical.
- Do not assume that passing unit tests proves the design works in realistic use, under failure, or across public projections.
- Do not create one change record, framework, repository abstraction, or tracking file per audited document.
- Do not rewrite archived specifications unless current authority, historical evidence, or broken links require a targeted correction.
- Do not preserve repository-owned backward compatibility for internal contracts, routes, schemas, layouts, names, or runtime behavior when a clean correction is approved.
- Do not combine unrelated worktree changes or silently override an active overlapping change plan.
- Do not use line count, file count, test count, or document count as a quality target.

## Related Context

- [Product Vision](../product-vision.md)
- [Design Roadmap](../roadmap.md)
- [Core Documentation Guide](../core/README.md)
- [Core Agent Rules](../core/AGENTS.md)
- [Specification Guide](../specs/README.md)
- [Specification Agent Rules](../specs/AGENTS.md)
- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Agent Workflow](../core/agent-workflow.md)
- [Protocol](../core/protocol.md)
- [Change Tracking](../change-tracking.md)
- [Application API Boundary](../app-api.md)
- [Product Design](../../DESIGN.md)
- [Test Strategy](../specs/20260529-test_strategy.md)
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md)
- [NanoCore Maintainability Recovery](./202607111531450001-nanocore_maintainability_recovery.md)
- Concurrent self-improvement implementation plan: `docs/changes/202607111600390001-self_improvement_loop_foundations.md`
- [Spec Lifecycle Governance](./202607111650190001-spec_lifecycle_governance.md)
- [Evidence Surface Simplification](./202607111848520001-evidence_surface_simplification.md)
- Concurrent worker runtime sub-agent provenance implementation plan: `docs/changes/202607111937290001-worker_runtime_subagent_provenance.md`

## Accepted Directional Decisions

1. `docs/core/foundation.md` will be added, and `docs/core/metering.md` will remain.
2. Future concepts intentionally retained in Core must also be represented in the roadmap or an active specification, but they do not need to be removed while implementation is catching up.
3. Foundation owns human final authority, agent execution accountability, Core ownership of durable product truth, observability and reviewability, projection boundaries, source-traceable learning, and explicit security boundaries.
4. Stable semantics to promote into existing Core owners include the complete `StopReason` vocabulary, the four Human Attention categories, generated-knowledge hypothesis semantics, Audit/Usage/Evidence separation, scheduler placement concepts, sandbox freedom principles, Quick Chat workspace semantics, workspace change governance, workspace data source identity, portability invariants, and worker-control authority.
5. Concrete fields, TypeScript and Zod shapes, API routes, transport choices, storage schemas, backend lists, algorithms, error encodings, rollout procedures, and current implementation snapshots belong in specifications, generated contracts, package guides, or change records rather than Core doctrine.
6. Every canonical concept must have one Core owner. Other Core documents may describe relationships but must not redefine the concept.
7. Existing consolidation candidates remain review targets rather than automatic deletions. A specification may be superseded or retired only after the audit proves that another current authority and implementation fully cover its contract.
8. Behavior corrections use tests first, preserve trust-boundary validation and data safety, and follow the repository's no-backward-compatibility rule.
9. Governed workers use one authenticated direct NanoCore `/api/worker-control` connection. The worker capability and MCP contracts remain accepted future design, but current AEPs advertise the capability plane as disabled with no routes; reimplementation must not restore a sidecar or create another control path.

## Current Baseline

The baseline was refreshed from the current worktree on 2026-07-13 after the Agent Skill Interface lifecycle change.

- Core now contains 20 accepted aspect documents. Foundation is the cross-aspect doctrine owner, while Metering remains the separate owner for system-wide measurement principles and non-gateway resource consumption.
- The active specification root contains 61 tracked specifications; 57 are Accepted and 4 are Draft.
- Current implementation alignment is 34 Implemented, 20 Partial, 0 Diverged, and 7 Not Started after completing the disposable local and remote OpenShell Cell lifecycle against stock `0.0.80` artifacts.
- Evidence Surface Simplification reconciled Audit/Usage/Evidence records and Workspace Synchronization divergence before this audit begins. The former AI Interface has since been superseded by the accepted Agent Skill Interface, and all current implementation claims still require the evidence-backed review assigned below.
- The active Not Started set includes the accepted Web rebuild, Agent Skill Interface, and Work/Resource Interaction designs plus the four Draft specifications for self-improvement, evaluation harness, recurring scheduler triggers, and Skill catalog versioning.
- The archive contains 57 lifecycle-classified specifications. They are evidence, not active authority.
- NanoCore workspace-review and synchronization implementation is being changed under the active maintainability recovery plan. This audit must inspect the settled slice or coordinate explicitly with that plan before editing overlapping code.
- Evidence surface simplification and self-improvement foundations have separate planned change records. Their accepted scope remains authoritative for implementation sequencing, while this record audits their design coherence and final alignment.
- The worker runtime sub-agent provenance specification and its dedicated implementation plan are included in this 61-spec ledger; its remaining real-runtime acceptance must complete and hand off before this audit edits overlapping runtime or evidence ownership.

## Finding Classification

| Code | Meaning | Required response |
| --- | --- | --- |
| `DESIGN-DEFECT` | The documented model is contradictory, unsafe, needlessly complex, operationally unrealistic, or infeasible in the owning implementation boundary. | Update the owning Core or specification decision first, record the rationale, then implement the corrected contract test-first. |
| `DOC-DRIFT` | The intended design and implementation are sound, but current documentation is stale, incomplete, duplicated, or in the wrong layer. | Update or move the documentation without changing behavior; verify all current links and projections. |
| `IMPLEMENTATION-DEFECT` | The accepted design is sound, but code behavior, persistence, API projection, or runtime handling diverges. | Add a failing regression test, fix the shared root cause, and update current implementation projections. |
| `TEST-GAP` | The design and apparent implementation exist, but the required invariant, failure path, integration, or acceptance behavior is not proved. | Add the smallest test at the lowest reliable L0-L6 layer and prove it fails before any behavior correction. |
| `REAL-USE-GAP` | Deterministic tests pass, but a realistic workflow, operator path, external runtime, or human review scenario is missing or impractical. | Add or update an L3-L6 scenario and fix the product or operational contract that causes the gap. |
| `OWNERSHIP-CONFLICT` | Two documents, packages, modules, records, or routes claim the same authority or can produce conflicting truth. | Choose one owner, remove the duplicate path, and update every projection and test in the same slice. |
| `SECURITY-GAP` | Authority, credential, redaction, policy, sandbox, tenant, or untrusted-input handling is incomplete or fail-open. | Stop the affected slice, add adversarial tests, and correct the trust boundary before continuing. |
| `DEFERRED-ALIGNMENT` | Core or roadmap declares a future boundary that is not yet fully specified or implemented, without contradicting current behavior. | Keep the boundary, ensure roadmap/spec ownership and prerequisites are explicit, and do not fabricate current implementation. |
| `NO-ACTION` | Design, implementation, tests, projections, and actual-use evidence align. | Record the evidence and mark the ledger item complete. |

## Per-Document Audit Protocol

Every ledger item must complete the following sequence before it can be marked complete.

1. Read the document in full together with its declared Core references, related active specifications, current implementation projection, linked changes, and relevant local README and AGENTS rules.
2. Identify the single authority owned by the document, what it must not own, and every duplicate or conflicting owner elsewhere in the active hierarchy.
3. Use CodeGraph before source search to trace the real entry points, dynamic call paths, record writers, public projections, consumers, and blast radius.
4. Inspect the implementation end to end across schemas, storage, runtime, App API, generated OpenAPI, Core Client, the end-user Agent Skill CLI, Web, worker MCP where applicable, and operator surfaces that participate in the contract.
5. Compare every normative requirement with implementation and test evidence; do not infer implementation from filenames, exports, or documentation claims.
6. Review normal behavior, invalid input, authorization, concurrency, interruption, retry, crash, restart, partial persistence, rollback, recovery, redaction, import/export, and degraded dependency behavior where relevant.
7. Decide whether each mismatch is a design defect, documentation drift, implementation defect, test gap, real-use gap, ownership conflict, security gap, or valid deferred alignment.
8. For behavior changes, choose the smallest cohesive implementation shape, write the failing test first, fix the root owner, and remove obsolete or duplicate behavior without compatibility shims.
9. Update the Core document, specification, implementation projection, local guides, generated contracts, and roadmap only where their authority requires it.
10. Run focused verification for the owning package and its consumers, then run the appropriate L0-L6 gates before marking the item complete.
11. Record only the material finding IDs, decision, affected authority, verification evidence, and commit or PR linkage in this change record; do not add a command transcript.

## Core Document Audit Ledger

| ID | Document | Primary implementation and test surfaces | Required review focus | State |
| --- | --- | --- | --- | --- |
| C00 | [Foundation](../core/foundation.md) | `README.md`, `docs/product-vision.md`, root and local `AGENTS.md`, the target `skills/openkit` package, all Core invariants | Keep the doctrine owner free of product marketing and implementation detail; verify human authority, agent accountability, Core truth ownership, projection boundaries, reviewability, learning provenance, and security boundaries against every aspect. | Initial alignment complete; cross-aspect audit ongoing |
| C01 | [Core Concepts](../core/core-concepts.md) | `packages/protocol/src/models/*`, `packages/protocol/src/common/ids.ts`, App API schemas, NanoCore storage and public records | Reduce duplicate definitions to owner links; verify the backbone and ID semantics; move manifest parsing, concrete ID registry mechanics, and schema-evolution implementation detail downward while preserving intentional reserved future concepts. | Pending |
| C02 | [Work Model](../core/work-model.md) | Protocol work records, NanoCore stores and route flows, Action Center, Chat/Task/Goal/Quick Chat, Agent Skill CLI and Web projections | Promote the four Human Attention categories and Quick Chat workspace semantics; preserve human acceptance; move exact item and Action Center shapes downward; test whether real workflows remain expressible without hidden product state. | Pending |
| C03 | [Architecture](../core/architecture.md) | Package import graph, NanoCore composition, protocol, Core Client, Agent Skill CLI, Web, worker and provider adapters | Verify module authority and internal roles; retain and roadmap the Generative Kernel and active Task Evaluator direction; move deployment, backend, record-layout, and role-procedure details downward; identify implementation boundary violations. | Pending |
| C04 | [Runtime Model](../core/runtime-model.md) | `apps/nanocore/src/runtime/*`, scheduler records and services, worker protocol, worker shim, runtime tests and e2e | Promote stable placement concepts; verify Turn, AgentSession, Worker, runtime and scheduler relationships; move exact trigger and lifecycle encodings downward; test concurrency, leases, restart and failure semantics. | Pending |
| C05 | [Agent Session](../core/agent-session.md) | Protocol agent models, `agent-session-continuity.ts`, scheduler leases, checkpoints, recovery, session snapshots | Preserve continuity and compatibility invariants; move exact state and compatibility-key shapes downward; verify resume, replace, fork, crash, rollback, static supply and dynamic turn behavior against real runtimes. | Pending |
| C06 | [Agent Workflow](../core/agent-workflow.md) | Internal agents, Chat/Task/Goal mode modules, goal runtime modules, Action Center, workspace review and evidence | Own coordination, acceptance and workspace-change governance; retain roadmap-backed graph and recipe direction; move current role procedures and mode defaults downward; test bounded steps, handoffs, gates, refinement, stop and evidence behavior. | Pending |
| C07 | [Protocol](../core/protocol.md) | `@openkit/protocol`, generated JSON Schema, NanoCore events and replay, Core Client, App API schemas, Agent Skill CLI and Web consumers | Promote complete StopReason semantics; keep authority, ordering, replay, terminal, idempotency and error principles; move exact payloads, routes, HTTP/SSE behavior, code types and authoring stack downward; verify conformance and unknown-feature handling. | Pending |
| C08 | [Communication](../core/communication.md) | Core Client transport/SSE, Agent Skill CLI process contract, worker protocol, worker control gateway, worker shim, OpenShell bridge | Promote worker-control authority; preserve plane boundaries; move concrete transports, commands, endpoint mappings, deployment topology and retry algorithms downward; test disconnect, replay, duplication, partial delivery and redaction. | Pending |
| C09 | [Storage](../core/storage.md) | NanoCore DB, migrations, filesystem layout, store, workspace export/import, backup/restore, indexes | Promote WorkspaceDataSource and portability invariants; preserve ownership and rebuildability; move SQLite, table, compaction, FTS/vector and backend choices downward; test crash consistency, atomicity, corruption, export and restore. | Pending |
| C10 | [Identity](../core/identity.md) | Better Auth, local/server identity, bootstrap and access tokens, workspace membership, auth middleware | Preserve credential-family and isolation semantics; keep team tenancy roadmap-backed; move exact membership records and status shapes downward; test local/server actors, token lifecycle, cross-workspace access and future membership boundaries. | Pending |
| C11 | [Vault](../core/vault.md) | Vault backends, references, grants, use records, injection plans and receipts, provider credential resolver | Preserve prohibited secret surfaces and explicit injection authority; move backend and target mappings downward; test locking, revocation, expiry, rebind, redaction, failed injection and secret absence from all public/evidence surfaces. | Pending |
| C12 | [Knowledge](../core/knowledge.md) | OKF storage, Knowledge Manager, search, retrieval, context packages, proposal and conflict ledgers | Promote generated-knowledge hypothesis semantics; preserve source traceability and human override; move pipeline, page, ingest, retrieval and UI detail downward; test stale, conflicting, sensitive, invalid and adversarial knowledge. | Pending |
| C13 | [Agent Supply](../core/agent-supply.md) | Config schemas, agent manifest and setup resolver, readiness, AEP resolution, supply catalogs and snapshots | Own AgentProfile, AgentCatalog, entry, setup and readiness concepts; move exact catalogs, enums and diagnostics downward; verify declared versus resolved versus materialized supply and future Skill pinning alignment. | Pending |
| C14 | [Agent Capability](../core/agent-capability.md) | Protocol capability/usage models, NanoCore capability ledger, current LLM gateway, and future worker capability/MCP gateway policy | Own CapabilityCall and UsageRecord semantics; preserve authorization, attribution and audit links; move fields, routing and deployment downward; test denied, failed, retried, partial and billable calls plus future budgets. | Pending |
| C15 | [Permissions](../core/permissions.md) | `@openkit/policy-kernel`, config policy schemas, permission decisions, approval gates, auth and App API enforcement | Preserve NGAC direction, default-deny and fail-closed authority; move exact decision fields and enforcement mappings downward; test policy conflict, stale decisions, revoked authority, cross-scope access and audit linkage. | Pending |
| C16 | [Sandbox](../core/sandbox.md) | OpenShell policy and backend, AEP materialization, worker governance, worker shim, container packaging | Promote broad process freedom with strict filesystem, network, credential and review boundaries; retain future summary direction; move backend lists and exact policy shapes downward; test escape, exfiltration, unavailable controls and degraded backends. | Pending |
| C17 | [Audit](../core/audit.md) | Protocol audit models, NanoCore audit writers, EvidenceBundle, RuntimeEvidence, usage ledger, export/import | Own Audit/Usage/Evidence separation and evidence authority; move exact record and retention schemas downward; verify complete producer coverage, idempotence, redaction, scope homing, quarantine and proof claims. | Pending |
| C18 | [Contract Evolution](../core/contract-evolution.md) | Protocol conformance, config schema evolution, import/export readers, worker protocol, generated schemas, lifecycle validator | Preserve additive and fail-closed evolution rules; move current removed fields, fixtures, loader errors and release snapshots downward; test unknown optional and authority-bearing features at every trust boundary. | Pending |
| C19 | [Metering](../core/metering.md) | Protocol usage records, capability usage ledger, LLM and future MCP usage producers, terminal runtime, workspace transfer, Git publication and scheduler evidence | Preserve the current runtime, storage, and network measurement foundation without collapsing Usage into billing; audit aggregation, duration, compute, retained storage, traffic, budgets, and cost projection only when real producers exist. | Initial producer boundary aligned; expansion audit pending |

## Active Specification Audit Ledger

Every active specification is listed exactly once below. Status and implementation values are the current baseline, not presumed audit conclusions. The audit may correct a value only after document, implementation, test, and practical-use evidence agree.

### A. Protocol, Public API, Product Projection, And Test Contracts

| ID | Specification and current alignment | Primary implementation and test surfaces | Required review focus | State |
| --- | --- | --- | --- | --- |
| S01 | [Protocol Contract Consolidation](../specs/20260628-protocol_contract_consolidation.md), Accepted / Partial | `@openkit/protocol`, App API schemas, Core Client, NanoCore routes/events, OpenAPI, Agent Skill CLI and Web consumers | Verify whether any concrete contract remains uniquely owned; move stable doctrine to Core and package guides; supersede only after all current entry-point and conformance responsibility is covered. | Pending |
| S02 | [Core Client Boundary](../specs/20260528-core_client_boundary.md), Accepted / Implemented | `packages/core-client/src/*`, package tests, Web, bundled CLI and temporary legacy MCP consumers, NanoCore black-box fixtures | Confirm the client is a thin typed public boundary, transport and errors are coherent, no NanoCore internals leak, and every public method has schema, failure and cancellation coverage. | Pending |
| S03 | [App API OpenAPI Projection](../specs/20260704-app_api_openapi_projection.md), Accepted / Implemented | App API schemas, NanoCore route registration, `openapi.ts`, generated artifact, Core Client and route/OpenAPI tests | Prove bidirectional route/OpenAPI parity, one schema owner, redaction and auth metadata, current generation reproducibility, and absence of hand-maintained competing inventories. | Pending |
| S04 | [OpenKit Agent Skill Interface](../specs/20260713-openkit_agent_skill_interface.md), Accepted / Not Started | Unified end-user Skill, bundled CLI, App API OpenAPI catalog, Core Client, shared schemas, NanoCore public routes and replacement stories | Verify progressive disclosure, complete public user/operator capability coverage, single ownership of route and payload contracts, secret and mutation boundaries, worker-MCP separation, and clean deletion of the user-facing MCP and four legacy Skills. | Pending |
| S05 | [Worker Turn Reliability Envelope](../specs/20260531-worker_turn_reliability_envelope.md), Accepted / Implemented | Protocol turn/events, worker turn loop, checkpoints, transcript import, host adapters, SSE replay and recovery tests | Verify one terminal outcome, complete StopReason mapping, interruption, continuation, checkpoint ordering, duplicate completion, partial streams, restart, adapter errors and evidence closeout. | Pending |
| S06 | [Human Attention Intervention Model](../specs/20260531-human_attention_intervention_model.md), Accepted / Partial | Protocol gates/items, Action Center, pending user turns, approval policy, Chat/Task/Goal, Agent Skill CLI and Web projections | Reconcile four intervention categories, blocking semantics, steering, review acceptance, row-kind ownership and active Draft dependencies; cover stale gates, repeated decisions, concurrent human action and recovery. | Pending |
| S07 | [Test Strategy](../specs/20260529-test_strategy.md), Accepted / Implemented | Root scripts, package tests, NanoCore e2e, Web e2e, smoke tests, story runner and CI | Audit whether L0-L6 definitions match actual scripts and failure coverage; remove redundant gates, close missing trust-boundary and real-runtime layers, and ensure deterministic tests do not impersonate L6 proof. | Pending |
| S08 | [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md), Accepted / Partial | `tests/stories/*`, `tests/story-runner/*`, temporary legacy MCP stories pending Skill/CLI replacement, real Codex/provider/task runners and Web stories | Verify story metadata, agent-first acceptance, environment preflight, skip semantics, evidence capture, real failure reporting and regression reduction into L1-L5. | Pending |
| S09 | [Web Product Surface Projection](../specs/20260628-web_product_surface_projection.md), Accepted / Implemented | Current Web app, Core Client, App API schemas, NanoCore APIs, Web tests and README | Verify only durable projection rules remain; move valid guidance to Web README and supersede after the rebuild contract lands and no independent design authority remains. | Pending |
| S10 | [Web UI Rebuild Stack](../specs/20260710-web_ui_rebuild_stack.md), Accepted / Not Started | `apps/web`, Core Client, app schemas, UI cookbooks, component and Playwright tests | Pressure-test framework, design-system, migration and accessibility choices against product needs and stable APIs; verify the rebuild can proceed without making Web a second workflow owner. | Pending |

### B. User Workflows, Internal Agents, And Evaluation

| ID | Specification and current alignment | Primary implementation and test surfaces | Required review focus | State |
| --- | --- | --- | --- | --- |
| S11 | [Chat Mode Assistant](../specs/20260704-chat_mode_assistant.md), Accepted / Implemented | Chat Mode App API schema/routes, internal quick-chat and mode runner, Core Client, MCP, focused and story tests | Verify lightweight assistant behavior, worker prohibition, context selection, persistence, stop and error behavior, and distinction from Quick Chat workspace kind and Task Mode. | Pending |
| S12 | [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md), Accepted / Implemented | Task Mode schema/routes, worker coordinator, goal-task delegation, scheduler/runtime, MCP and real/deterministic Task stories | Verify bounded scope, target selection, escalation, context refs, stop conditions, evidence, failures, retries, human gates and no hidden Goal lifecycle. | Pending |
| S13 | [Goal Mode Coordination](../specs/20260704-goal_mode_coordination.md), Accepted / Implemented | `goal-*` runtime modules, Action Center, schemas/routes, Core Client, MCP, Web and Goal stories | Trace objective, planning, approval, bounded steps, steering, verification, refinement and closeout; test concurrent actions, crashes, stale plans, worker failure and incomplete evidence. | Pending |
| S14 | [Quick Chat Workspace](../specs/20260709-quick_chat_workspace.md), Accepted / Implemented | Quick Chat workspace and route modules, internal agent, app schemas, storage, MCP/Web projections and tests | Verify it remains a real durable workspace while prohibiting workers, repositories and external side effects; repair the missing change link and test guard bypasses. | Pending |
| S15 | [Workflow Coordinator Internal Agent](../specs/20260704-workflow_coordinator_internal_agent.md), Accepted / Implemented | `internal-agents/worker-coordinator*`, delegation, runner, mode selection, context and workflow tests | Verify coordinator authority, deterministic boundaries, worker selection, plan drafting, stop/refine decisions and evidence use without duplicating scheduler, Knowledge Manager or runtime ownership. | Pending |
| S16 | [Work And Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md), Accepted / Not Started | Protocol work/resource records, NanoCore App API and internal-agent flows, unified Agent Skill CLI, Web projections and L6 stories | Verify the accepted judgment, delegation, interaction, artifact and resource model against current product paths; keep durable product authority in NanoCore and prevent presentation surfaces from inventing parallel workflow state. | Pending |
| S17 | [Knowledge Manager Internal Agent Runtime](../specs/20260704-knowledge_manager_internal_agent_runtime.md), Accepted / Implemented | `knowledge-manager.ts`, knowledge store/search/context, internal agent registry/runner, App API and MCP tests | Verify manager judgment boundaries, deterministic validators, proposal-only mutation, source and conflict handling, context preparation, failure recovery and separation from workflow coordination. | Pending |
| S18 | [Self-Improvement Evaluation Loop](../specs/20260710-self_improvement_evaluation_loop.md), Draft / Not Started | Linked self-improvement change plan, future internal agents, evidence/audit records, Skills and L6 stories | Resolve Reflector, Harness and Judge authority; test feasibility, feedback loops, proposal lifecycle, anti-self-approval controls, measurement quality, rollback and promotion before acceptance. | Pending |
| S19 | [Evaluation Harness Design](../specs/20260711-evaluation_harness_design.md), Draft / Not Started | Story runner, test strategy, evidence records, future evaluation modules and fixtures | Verify reproducibility, dataset and fixture provenance, scoring authority, false-positive controls, cost limits, isolation, result evidence and the boundary between deterministic verification and model judgment. | Pending |

### C. Agent Supply, Runtime, Session, Scheduler, And Sandbox

| ID | Specification and current alignment | Primary implementation and test surfaces | Required review focus | State |
| --- | --- | --- | --- | --- |
| S20 | [Agent Environment Package](../specs/20260616-agent_environment_package.md), Accepted / Partial | Config schema AEP, worker protocol, NanoCore agent environment/materialization, worker governance, worker shim and real OpenShell e2e | Audit the full declared-resolved-materialized-executed-evidence chain, fail-closed features, portability, redaction, lifecycle, backend mapping and whether the large contract still has cohesive ownership. | Pending |
| S21 | [Agent Setup Runtime Supply Contract](../specs/20260628-agent_setup_runtime_supply_contract.md), Accepted / Partial | Agent manifests, setup resolver/ledger/readiness, AEP, runtime selection and diagnostics | Determine whether this remains a useful contract or only a routing overview; merge unique obligations into AEP/setup owners and supersede only after entry-point coverage is preserved. | Pending |
| S22 | [Agent Manifest And AEP Resolution](../specs/20260703-agent_manifest_aep_resolution.md), Accepted / Implemented | `@openkit/config-schema`, NanoCore agent manifest/setup modules, runtime agent environment, setup ledgers and tests | Verify precedence, defaults, required features, readiness blockers, stable identity, source/vault/policy resolution, redacted snapshots, unknown fields and stale-session effects. | Pending |
| S23 | [Session Static Workspace Materialization](../specs/20260704-session_static_workspace_materialization.md), Accepted / Implemented | Config session-workspace schemas, runtime workspace materializer, AEP snapshots, sandbox roots and materialization tests | Verify static-versus-dynamic boundaries, catalog source identity, digest and compatibility keys, mount safety, refresh/replacement behavior and recovery after partial materialization. | Pending |
| S24 | [Agent Session Continuity](../specs/20260704-agent_session_continuity.md), Accepted / Implemented | Agent session continuity module, scheduler leases, checkpoints, snapshots, recovery and App API read models | Test snapshot/resume/replace/fork/rollback/crash precedence, expired leases, incompatible static setup, idempotence, user choice and private runtime state boundaries. | Pending |
| S25 | [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md), Accepted / Partial | Worker protocol, direct worker-control shim and transcript paths, AEP, disabled capability projection and workspace-sync integrations | Determine whether any unique contract remains beyond Core communication and owning worker specs; verify direct control failure behavior and future capability sequencing before consolidation. | Pending |
| S26 | [OpenShell Disposable Cell Lifecycle](../specs/20260715-openshell_disposable_cell_lifecycle.md), Accepted / Implemented | OpenShell Cell helper/controller, worker backend, deployment config, scheduler capacity, restart cleanup and real A1 e2e | Verified official artifact identity, single-slot ownership, prepare/recycle ordering, full-epoch termination, fresh stable-empty readiness, same-boot fail-closed retention, cross-boot and fenced retry, local-only diagnostics and absence of resource-delete success claims. | Completed 2026-07-15 |
| S27 | [OpenShell Mechanism Internalization](../specs/20260703-openshell_mechanism_internalization.md), Accepted / Partial | OpenShell schema snapshot, NanoCore policy/vault/audit/runtime adapters and conformance tests | Verify borrowed mechanisms are translated into OpenKit-owned contracts, external version drift is bounded, native ids never become product authority, and upgrade/failure behavior is explicit. | Pending |
| S28 | [Container Image Packaging](../specs/20260708-container_image_packaging.md), Accepted / Implemented | Dockerfiles, image manifests, build/run scripts, worker shim, NanoCore Docker tests and smoke | Verify reproducible contents, pinned tools, non-root behavior, architecture support, credential absence, health/readiness, upgrade path and real runtime compatibility. | Pending |
| S29 | [Runtime Scheduling Scale](../specs/20260703-runtime_scheduling_scale.md), Accepted / Partial | Scheduler records, placement, capacity and health modules, schemas and tests | Promote stable concepts to Core, verify manifest-intent versus scheduler-decision separation, then merge remaining concrete contract into Durable Scheduler and supersede only after coverage is complete. | Pending |
| S30 | [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md), Accepted / Partial | Scheduler admission, dispatch, capacity, health, lease, renewal, watch, recovery and service tests | Close current partial gaps in live reuse and parallel-safe dispatch; test fairness, starvation, races, stale workers, split-brain epochs, quarantine, retries, restart and Action Center projections. | Pending |
| S31 | [Worker Sandbox Freedom Policy](../specs/20260709-worker_sandbox_freedom_policy.md), Accepted / Implemented | OpenShell policy/backend, AEP, worker governance, worker shim, container tests and runtime diagnostics | Promote durable freedom/boundary principles to Core; verify process freedom, filesystem/network/credential limits, policy compilation, unsupported controls, bypass resistance and review gates. | Pending |
| S32 | [Worker Credential Access Declarations](../specs/20260709-worker_credential_access_declarations.md), Accepted / Implemented | Config AEP schemas, setup resolver, vault references/grants, injection plans/receipts and runtime materialization | Verify least privilege, declaration-to-grant binding, target visibility, revocation/expiry, provider mapping, redaction and absence of undeclared fallback credentials. | Pending |
| S33 | [Worker Runtime Sub-Agent Provenance And Inference Identity](../specs/20260711-worker_runtime_subagent_provenance.md), Accepted / Partial | Worker shim raw capture, worker protocol, transcript import, runtime evidence, capability ledger, LLM worker inference, prompt-cache keys and vendored runtime schemas | Audit the implemented raw-stream bounds, origin indexing, authority separation, trusted inference binding, cache lineage, quarantine and privacy contracts, then close the remaining real root-plus-two-child runtime acceptance gap. | Pending |
| S34 | [Skill Catalog Versioning And Pinning](../specs/20260711-skill_catalog_versioning_pinning.md), Draft / Not Started | Current runtime supply catalog, config schemas, future catalog persistence, Skills and setup diagnostics | Verify immutable identity, digest/version rules, pin behavior, promotion, rollback, workspace policy, missing versions and supply compatibility without designing a marketplace. | Pending |
| S35 | [Scheduler Recurring Event Triggers](../specs/20260711-scheduler_recurring_event_triggers.md), Draft / Not Started | Automation store/routes, scheduler records/services, trigger source schemas, Action Center and time-based tests | Verify durable schedule authority, timezone and clock behavior, catch-up, overlap, retries, disable/delete, idempotence, restart, missed events and policy before acceptance. | Pending |

### D. Worker Control, Capability, Context, Provider, And Vendor Contracts

| ID | Specification and current alignment | Primary implementation and test surfaces | Required review focus | State |
| --- | --- | --- | --- | --- |
| S36 | [Worker Agent Capability](../specs/20260703-worker_agent_capability.md), Accepted / Partial | Protocol capability/usage schemas, shared ledger, disabled AEP projection and future worker gateway/client | Verify the accepted target against the current disabled plane; rebuild authentication, catalog and grants, request identity, idempotence, denial/failure accounting, source lineage, redaction and backend-independent routing before advertisement. | Pending |
| S37 | [Worker Control Protocol](../specs/20260703-worker_control_protocol.md), Accepted / Implemented | Worker protocol, control routes/gateway/commands/records/sequences/rebuild, worker shim and tests | Verify narrow control authority, sequence ordering, authentication, replay, duplicate commands, stale sessions, rejected evidence, rebuild and the prohibition on direct product-state mutation. Same-snapshot renewal is active without a refresh acknowledgement; source-to-target refresh remains unimplemented until its request, negotiation, rebinding, rollback, and evidence contract exists. | Renewal and refresh boundary aligned; full audit pending |
| S38 | [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md), Accepted / Partial | Static runtime supply substrate and the future worker MCP gateway, tool schemas, vault/policy linkage, capability ledger and tests | Rebuild the executable plane before claiming availability; verify allowlists, schema validation, approval gates, credential grants, health, lifecycle, usage/audit, denied calls and separation from the end-user Agent Skill Interface. | Pending |
| S39 | [Worker Context Package](../specs/20260703-worker_context_package.md), Accepted / Partial | Context projection policy, LLM projection, Knowledge Manager context, AEP materialization, source catalog and tests | Close current scope and producer gaps; verify minimality, sensitivity, freshness, token bounds, source traceability, deterministic exclusions, runtime materialization and stale context behavior. | Pending |
| S40 | [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md), Accepted / Implemented | NanoCore LLM clients/converters/policy/usage/routes, OpenAPI, provider config and gateway tests | Verify streaming, Responses and Chat parity, tool and image inputs where supported, cancellation, errors, usage, cache, credential isolation, policy, provider feature negotiation and public contract accuracy. | Pending |
| S41 | [Pi AI Provider Gateway Adoption](../specs/20260703-pi_ai_provider_gateway_adoption.md), Accepted / Implemented | Pi client/usage, provider registry/dispatcher/config, gateway policy, models catalog and tests | Resolve contradictions with the unified backend spec; preserve only unique catalog, pinning and vocabulary-leak obligations, then supersede after current behavior and migration evidence are fully owned. | Pending |
| S42 | [Unified Pi AI LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md), Accepted / Implemented | Provider dispatcher/registry/config, Pi client/converters/usage, Codex-native exception path and tests | Verify one non-Codex owner, provider capability normalization, credentials, cancellation, streaming, usage, errors, health, real-provider behavior and no lingering native OpenAI duplicate path. | Pending |
| S43 | [Capability Usage Gateway Foundation](../specs/20260704-capability_usage_gateway_foundation.md), Accepted / Partial | Capability usage ledger, current LLM gateway usage, future worker MCP usage, protocol schemas and audit/evidence links | Determine whether this one-time foundation still owns a distinct contract; keep current LLM evidence separate from future MCP conformance and supersede only after all attribution and idempotence tests remain. | Pending |
| S44 | [Codex ChatGPT Subscription Login](../specs/20260526-codex_chatgpt_subscription_login.md), Accepted / Implemented | Codex OAuth account slots, provider profiles, server-owned account metadata, isolated Codex homes, secure pre-provisioned account files, App API, Core Client, Web diagnostics and tests | Verify multi-account isolation, browser/device flows, cancellation/logout, refresh, redaction, storage ownership, worker materialization and failure recovery without leaking auth state. | Secure real-L6 preflight aligned; full audit pending |
| S45 | [Vendor Snapshot Packages](../specs/20260522-vendor_snapshot_packages.md), Accepted / Implemented | Codex/OpenShell/models.dev snapshot packages, refresh scripts, conformance tests and update change records | Verify provenance, pinning, reproducible refresh, reviewable diffs, license/source metadata, consumer compatibility and fail-closed behavior when native contracts drift. | Pending |

### E. Storage, Workspace Data, Synchronization, Git, And Portability

| ID | Specification and current alignment | Primary implementation and test surfaces | Required review focus | State |
| --- | --- | --- | --- | --- |
| S46 | [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md), Accepted / Implemented | NanoCore DB/migrations/schema, filesystem layout, store, backups, workspace export/import and tests | Verify one writer and source of truth per record family, server/workspace scope homing, filesystem/SQLite atomicity, rebuildable indexes, lock behavior, deletion and current file-map accuracy. | Pending |
| S47 | [Schema Evolution Record Envelope](../specs/20260703-schema_evolution_record_envelope.md), Accepted / Implemented | Config schema evolution, protocol/worker schemas, JSONL readers and writers, workspace import/export and conformance tests | Remove its false claim to own general evolution; keep concrete record-envelope, naming, digest, registry and reader/writer contracts; test unknown optional and authority-bearing data. | Pending |
| S48 | [Workspace Data Source Catalog](../specs/20260704-workspace_data_source_catalog.md), Accepted / Implemented | Config source catalog, repository data-source catalog, AEP/source resolution, storage, capability and usage lineage tests | Verify declare-once/reference-by-ID behavior, path and kind validation, policy/vault linkage, portability, stale/missing sources, remote path mapping and lineage propagation. | Pending |
| S49 | [Workspace Synchronization](../specs/20260703-workspace_synchronization.md), Accepted / Implemented | Workspace sync/review/apply/filesystem/Git/reconciliation/quarantine modules, storage schemas, routes, MCP and tests | Coordinate with maintainability recovery; prove reads are non-mutating, worker output never becomes truth directly, staging/apply are isolated and atomic, unrelated Git state is safe, recovery is deterministic and every transition is audited. | Pending |
| S50 | [Git Write Workflow](../specs/20260704-git_write_workflow.md), Accepted / Implemented | Repository store/routes, Git push policy/records/command/executor, workspace review Git, MCP and tests | Verify commit-on-apply, isolated index/worktree behavior, protected branch policy, approval-gated push, request idempotence, remote errors, stale approvals and no inclusion of unrelated user changes. | Pending |
| S51 | [Workspace Backup, Export, And Import](../specs/20260704-workspace_backup_export_import.md), Accepted / Implemented | Data-root backup/restore, workspace export/import, config export schema, MCP portability runner and tests | Verify offline validation, atomic import, corrupt/truncated archives, identity rebinding, repository/vault rebind, no secrets, unsupported features, rollback and realistic cross-machine portability. | Pending |

### F. Identity, Bootstrap, Policy, Vault, Audit, And Knowledge

| ID | Specification and current alignment | Primary implementation and test surfaces | Required review focus | State |
| --- | --- | --- | --- | --- |
| S52 | [NanoCore Config And Identity Contract](../specs/20260628-nanocore_config_identity_contract.md), Accepted / Partial | Config loaders/data root/mode, auth identity, workspace membership, provider and agent config, diagnostics and tests | Verify local/server identity, config precedence and ownership, path safety, stale-session behavior, actor attribution and removal of obsolete passthrough or duplicate configuration owners. | Pending |
| S53 | [Remote Auth Credential Bootstrap](../specs/20260704-remote_auth_credential_bootstrap.md), Accepted / Partial | Bootstrap/access-token stores, auth middleware, Better Auth, bundled CLI credential store, App API schemas and server-flow tests | Verify one-time bootstrap, token scopes/rotation/revocation, secure storage, redaction, stable `openkit-cli` and `agent-skill` last-use labels, local versus server behavior, replay and expired or compromised credentials. | Pending |
| S54 | [NanoCore Bootstrap Readiness](../specs/20260704-nanocore_bootstrap_readiness.md), Accepted / Implemented | Bootstrap phases/readiness/lock/shutdown/vault/policy/audit, index startup, diagnostics and tests | Verify deterministic phase order, lock exclusivity, partial initialization, restart recovery, degraded dependencies, readiness truth, safe shutdown and operator-actionable diagnostics. | Pending |
| S55 | [OpenKit Policy Model](../specs/20260629-openkit_policy_model.md), Accepted / Implemented | `@openkit/policy-kernel`, config policy schema, conformance fixtures, permission decisions and approval gates | Verify the strict NGAC subset is coherent and sufficient, relation updates are deterministic, unsupported semantics fail closed and Core identity/resource/action mappings are unambiguous. | Pending |
| S56 | [Policy Enforcement Mapping](../specs/20260703-policy_enforcement_mapping.md), Accepted / Partial | Permission decision writers, approval gates, auth, capability, vault, workspace mutation and public route enforcement tests | Close missing enforcement points; prove every authority-bearing operation checks the correct subject/object/action context, decisions are immutable and stale or denied paths cannot mutate state. | Pending |
| S57 | [Vault Secret Injection](../specs/20260703-vault_secret_injection.md), Accepted / Implemented | Vault references/grants, injection plans/receipts, provider resolver, AEP materialization, OpenShell backend and tests | Verify grant lifecycle, visibility target, backend capability, expiry/revocation, cleanup, redaction, retry and that secrets never enter persistent product records or command arguments. | Pending |
| S58 | [Vault Backend Implementation](../specs/20260704-vault_backend_implementation.md), Accepted / Partial | OS keychain and encrypted-file backends, key files, unlock state, admin routes/audit and tests | Verify key-source security, lock/unlock, rotation, corruption, permissions, platform failure, fallback warnings, backup/export exclusions and no plaintext recovery path. | Pending |
| S59 | [Audit, Usage, And Evidence Records](../specs/20260703-audit_usage_evidence_records.md), Accepted / Implemented | Protocol records, audit writers, usage ledger, EvidenceBundle, RuntimeEvidence, workspace sync producers, export/import and tests | Coordinate with evidence simplification; prove distinct ownership, automatic trusted producers, scope homing, idempotence, redaction, retention, quarantine, import/export and complete required producer coverage. | Pending |
| S60 | [Knowledge Store Governance Rules](../specs/20260702-knowledge_store_governance_rules.md), Accepted / Partial | OKF validator/store, Knowledge Manager, observations/claims/conflicts/proposals, source refs and tests | Close governance gaps; verify accepted versus proposed knowledge, human override, conflicts, stale detection, sensitivity, path validation, source repair and no automatic promotion of generated claims. | Pending |
| S61 | [Knowledge Store Implementation](../specs/20260703-knowledge_store_implementation.md), Accepted / Partial | OKF files, search/index rebuild, retrieval traces, context packages, import/export, App API and future worker capability routes | Verify file-first truth, deterministic indexes, corrupt and concurrent edits, retrieval quality, traceability, context materialization, portability, future worker-route conformance and operational performance on realistic stores. | Pending |

## Supporting Documentation Projection Ledger

Supporting documents do not override Core or active specifications. They are audited after their owning contracts so they can be corrected as projections rather than becoming new design authorities.

| ID | Document group | Required review focus | State |
| --- | --- | --- | --- |
| D01 | `README.md`, `docs/product-vision.md`, `docs/roadmap.md` | Keep mission, current posture and future sequencing accurate; remove duplicated Core definitions, stale storage/provider claims and non-English repository text; preserve the newly aligned future-direction entries. | Pending |
| D02 | `AGENTS.md`, `CONTRIBUTING.md`, `docs/template-overview.md`, `docs/change-tracking.md` | Reconcile README-first governance, TDD, documentation ownership, no-backward-compatibility and commit sequencing without duplicate or contradictory rulebooks. | Pending |
| D03 | `docs/app-api.md`, generated OpenAPI and API-facing guides | Keep stable boundary and projection rules while making generated contracts own operation inventory; remove future provider, transport and implementation detail from the conceptual API guide. | Pending |
| D04 | `docs/deployment.md`, NanoCore deployment-mode guides and release/deployment cookbooks | Verify local/server/container/remote topology, auth, data roots, backup, health, rollout and operator commands against current runtime behavior and real smoke tests. | Pending |
| D05 | `DESIGN.md`, Web design docs and Web cookbook | Keep product IA, interaction, accessibility and visual rules; remove old Memory vocabulary, backend semantics and obsolete Solid-stack authority as the rebuild contract progresses. | Pending |
| D06 | `apps/nanocore/README.md` and local rules | Correct UI-first, remote-runtime, session, route, data-root, provider, auth and operational claims against the settled NanoCore implementation; move host-specific topology to runbooks. | Pending |
| D07 | `apps/web/README.md` and local rules | Align current versus target stack, public client-only boundary, available UI behavior, tests and rebuild sequencing; remove the deprecated cookbook reference when the accepted stack is ready. | Pending |
| D08 | `packages/README.md` plus every package README and local rule | Verify the complete package inventory, single ownership boundaries, generated artifacts, public exports, commands and consumer relationships, including `worker-shim`. | Pending |
| D09 | `mcp/README.md` and local rules | Keep the legacy package removal-only until deletion, then verify the README and local rules are deleted with the package and no active guide still routes users to MCP setup. | Pending |
| D10 | `skills/README.md` and all OpenKit Skill packages | Verify the single end-user `openkit` Skill target, progressive references, bundled CLI, human gates and credential rules, then verify the four legacy setup/loop variants are deleted without aliases. | Pending |
| D11 | `docs/cookbooks/*` | Verify each recipe against current CLIs, packages, stack, deployment and security behavior; delete obsolete recipes after inbound links are removed rather than preserving parallel setup paths. | Pending |
| D12 | `tests/stories/*`, story-runner guides and acceptance documentation | Align narrative acceptance criteria with runnable deterministic and real-agent paths; remove stale host-mode assumptions and ensure skips cannot be reported as proof. | Pending |
| D13 | `docs/changes/*` and any archived working logs | Verify active overlapping plans have distinct ownership, current statuses and final evidence; do not rewrite historical checkpoints, but prevent completed plans from remaining apparent current authority. | Pending |

## Design And Feasibility Review Questions

Every document audit must answer the questions that apply to its authority.

- Does the design solve a present OpenKit requirement, or has a hypothetical variant become mandatory complexity?
- Can one module and one durable record family own the behavior without a second writer, mirror ledger, or competing route?
- Does the design preserve `Workspace -> Thread -> Turn -> Item[]` and introduce a new Core entity only when it owns a distinct lifecycle or authority boundary?
- Can the complete path be traced from one public or runtime entry point through authorization, validation, persistence, effects, evidence, projection and recovery?
- Are current field, state and API choices required by stable semantics, or are they accidental projections that should remain replaceable?
- Can the design survive interruption between each persistent or external side effect without ambiguous truth, duplicate work, lost review state or unbounded repair?
- Are idempotence, concurrency, ordering, retries, cancellation, timeouts, stale state, clock behavior and process restart defined where they matter?
- Does every secret, identity, permission and sandbox claim have a real enforcement point and an adversarial test, or is it only descriptive documentation?
- Can a user understand what happened, what requires attention, what evidence supports the result and which action is safe without reading adapter-private state?
- Can an operator diagnose configuration, dependency, storage, provider, runtime and network failure without exposing credentials or host-private detail?
- Are derived indexes, projections, summaries and generated contracts rebuildable from one authoritative source?
- Does a deterministic test prove the invariant it claims, and is a real-runtime or story-level check required to expose integration behavior?
- Is a dependency, abstraction, schema, route, record, helper, configuration option or compatibility layer removable without losing required behavior?
- If implementation difficulty is high, is the difficulty intrinsic to the product requirement or caused by a poor ownership boundary in the design?

## Execution Plan

### Phase 0: Freeze Current Truth And Coordinate Active Work

- Recount Core, active specifications, archived specifications, status values and implementation values from the worktree at execution start.
- Reconcile the active-spec index with all 60 current root specifications, including the Agent Skill Interface and worker runtime sub-agent provenance, without overwriting concurrent spec authoring.
- Record active and planned change records that overlap each audit slice and choose one implementation owner before editing code.
- Preserve the current NanoCore maintainability worktree and defer overlapping workspace-review edits until that change reaches a stable checkpoint or explicitly hands off ownership.
- Keep the roadmap update in this change's first documentation slice: unified pi-ai current state, Workflow Graph and Recipe direction, active evaluation, recurring triggers, Skill pinning, sandbox freedom and worker sub-agent provenance.
- Establish the C, S and D ledger identifiers as the only audit checklist; do not create a second task database.
- Run the existing spec lifecycle validator, documentation link checks, repository status checks and a baseline focused test inventory, recording unrelated blockers separately.

Exit criteria: the current authority and implementation baseline is reproducible, concurrent work has explicit ownership, and no audit begins against a moving overlapping implementation without coordination.

### Phase 1: Foundation And Canonical Ownership

- Write `docs/core/foundation.md` as a compact doctrine document derived from current accepted product and Core principles, not as a duplicate product vision or architecture summary.
- Update the Core guide and term index for 20 aspect documents while retaining Metering.
- Establish the canonical concept-owner map for Workspace, Thread, Turn, Item, Artifact, AgentProfile, AgentSession, Agent supply, CapabilityCall, UsageRecord, AuditEvent, EvidenceBundle, workflow mechanisms, workspace changes and internal roles.
- Remove only duplicate definitions; preserve cross-aspect relationship text and deliberate roadmap-backed future boundaries.
- Define the allowed form of future Core declarations: stable boundary and invariant in Core, activation and prerequisite in roadmap, concrete design in a Draft or Accepted specification, and honest implementation alignment metadata.
- Verify that Foundation and every aspect use English, accepted terminology, direct invariants and no unresolved implementation questions disguised as doctrine.

Exit criteria: Foundation exists, Metering remains, the Core inventory is current, and every cross-aspect concept has one named owner before content is promoted or moved.

### Phase 2: Core Audit And Vertical Implementation Review

- Audit C00-C03 first to settle doctrine, backbone, work vocabulary and architecture boundaries.
- Audit C07, C08 and C18 next so protocol, communication and evolution rules are stable before their implementation-facing specifications are rewritten.
- Audit C04-C06 and C13-C16 next so runtime, session, workflow, supply, capability, permission and sandbox ownership is stable before worker and scheduler remediation.
- Audit C09-C12, C17 and C19 next so storage, identity, vault, knowledge, audit/evidence and metering boundaries are stable before data and governance remediation.
- For each Core item, inspect its related specifications and implementation before editing; do not mechanically shorten Core text when exact detail has no safe owning destination.
- Promote the accepted stable semantics listed in this plan and move implementation-specific material to an existing owning specification wherever possible.
- If the implementation shows that an accepted Core rule is infeasible, unsafe or incorrectly scoped, classify a `DESIGN-DEFECT` and review the corrected Core decision before code changes.
- Mark each C ledger item complete only when canonical ownership, related specs, implementation projections and evidence are aligned.

Exit criteria: all 20 Core items have one coherent authority, no unreviewed duplicate definition, an honest relationship to roadmap and specifications, and implementation evidence for every current invariant.

### Phase 3: Active Specification And Implementation Audit

- Process one S ledger item at a time, but group code changes into cohesive package slices when several documents project the same corrected owner.
- Within each group, audit Diverged items first, then Partial items, then Accepted Not Started and Draft feasibility, then items currently marked Implemented.
- Begin with Group A so protocol, public API, client, channel and verification contracts define the observable system boundary.
- Continue with Group C and Group D so runtime, scheduling, supply, sandbox, control, capability and provider contracts are proven before higher-level workflow claims.
- Continue with Group E and Group F so storage, workspace mutation, identity, policy, vault, audit, evidence and knowledge behavior is proven against failure and recovery.
- Complete Group B after the supporting kernel contracts are reliable, then re-run Chat, Task, Goal, Quick Chat, unified end-user Skill loop and evaluation reviews against the settled lower layers.
- For Accepted / Implemented items, distrust the label until normative requirements, call paths and tests are checked; correct the value if real gaps remain.
- For Draft and Accepted / Not Started items, review feasibility and ownership now, but do not fabricate implementation or mark acceptance merely because a plan exists.
- For every behavior defect, add the focused failing test before implementation and reduce any confirmed real-use defect into the lowest reliable L1-L5 regression layer.
- Update the specification's current implementation projection and `Implementation` value only after the complete owning path and required tests align.

Exit criteria: all 60 specifications have evidence-backed authority and implementation alignment, every current mismatch is resolved or explicitly owned by a deferred plan, and no specification claims implementation based only on scaffolding or deterministic fixtures.

### Phase 4: Promotion, Consolidation, And Layer Repair

- Promote stable conclusions into their Core owners only after the related document and implementation audit proves they are durable.
- Move concrete protocol, API, storage, backend, algorithm and rollout material out of Core into existing specifications, generated contracts or guides.
- Review the approved consolidation candidates: protocol contract consolidation, runtime scheduling scale, worker runtime communication model, agent setup runtime supply contract, capability usage gateway foundation, pi-ai provider gateway adoption and, after the rebuild, Web product surface projection.
- Supersede a candidate only when a named current owner absorbs every continuing contract, current entry points are updated and implementation/test evidence survives the move.
- Update Core and Specs indexes, related links, current-guidance references, roadmap activation entries and supporting documentation in the same reviewed slice.
- Add the smallest dependency-free L0 check only for repeated mechanically detectable drift that the existing lifecycle validator does not already cover, such as active-index completeness or repository-relative documentation links.

Exit criteria: stable semantics live once in Core, implementation contracts live once in active specs or generated contracts, obsolete routing specs no longer claim authority, and mechanical hierarchy drift fails L0 checks.

### Phase 5: Real-Use And Failure-Oriented Acceptance Review

- Execute the scenario matrix below through Agent-Skill-first and NanoCore-first paths, using Web only as a projection over settled contracts.
- Use deterministic adapters for reproducible lower-layer regression and real runtimes/providers only where they prove integration that fixtures cannot.
- Inspect durable records, audit, evidence, redaction, recovery and product-visible state after each failure-oriented scenario rather than checking only HTTP status or final text.
- Convert every confirmed scenario defect into the lowest reliable L1-L5 regression before the implementation fix is considered complete.
- Record external prerequisites, skipped real-runtime checks and environmental failures honestly; a skip is not acceptance evidence.

Exit criteria: every applicable scenario has deterministic regression evidence and the required real integration evidence, with no unexplained mutation, secret exposure, lost lineage, ambiguous recovery or false success.

### Phase 6: Supporting Documentation Projection Audit

- Audit D01-D13 only after their owning Core and specification slices settle.
- Remove duplicated canonical definitions and keep each README, guide, cookbook, Skill and story focused on its real audience and operational responsibility.
- Repair stale stack, route, provider, auth, runtime, deployment, path and test claims against verified implementation rather than copying a current implementation snapshot from another guide.
- Remove obsolete redirect or cookbook files after inbound links are updated; do not keep parallel instructions for internal compatibility.
- Ensure all repository text introduced or retained by the active guidance is English.

Exit criteria: all supporting documents project current authority correctly, no guide becomes a competing design owner, and setup and operational instructions are executable on their declared surface.

### Phase 7: Repository-Wide Verification And Closeout

- Re-run exact Core and specification inventories, lifecycle validation, active-index coverage, Markdown link validation, stale-term searches and canonical-owner checks.
- Run focused package verification after each slice and the full L0-L6 gates at final convergence.
- Review the final code and documentation for dead code, duplicate owners, pass-through layers, speculative configuration, obsolete schemas, unreachable routes, stale generated artifacts and accidental compatibility behavior.
- Close every C, S and D ledger item with `NO-ACTION` evidence or resolved finding IDs.
- Update this record with final document movements, design corrections, implementation corrections, test additions, scenario evidence, commits, remaining explicitly deferred work and final human approval.

Exit criteria: the hierarchy, implementation, tests and practical-use evidence agree; all required gates pass; and this record can move to `verified` without relying on undocumented exceptions.

## Real-Use Scenario Matrix

| ID | Scenario | Evidence required |
| --- | --- | --- |
| U01 | Fresh local-mode bootstrap and first Workspace creation | Deterministic startup, stable local actor, valid data root, readiness, no server-auth requirement, clean restart and inspectable initial records. |
| U02 | Fresh server-mode owner bootstrap, sign-up/sign-in and scoped token lifecycle | One-time token consumption, secure credential storage, correct scope, revocation/rotation, unauthenticated rejection, redacted audit and restart persistence. |
| U03 | Workspace onboarding with repository, data-source catalog, provider and agent setup | Path validation, source identity, readiness explanation, no secret-bearing config, remote-path clarity and deterministic resolved setup. |
| U04 | Chat Mode lightweight request and follow-up | Correct Assistant selection, durable thread/turn/items, no worker or external side effect, streaming/terminal behavior and recoverable provider failure. |
| U05 | Task Mode bounded worker delegation | Correct worker selection, context, lease, sandbox, stop condition, evidence, failure and Goal escalation without hidden workflow state. |
| U06 | Goal Mode planning through verified closeout | Human plan approval, bounded steps, steering, worker retry, artifact/evidence review, risk reporting, verification and terminal acceptance. |
| U07 | Approval, elicitation, steering and review occurring around active work | Correct blocking versus non-blocking semantics, stale-decision rejection, idempotence, Action Center truth and no action before authority exists. |
| U08 | Worker interruption, crash, NanoCore restart and session recovery | Durable checkpoint, no duplicate completion, valid resume/replace choices, lease recovery, pending input handling and preserved lineage. |
| U09 | Concurrent scheduling under limited capacity | Fair admission, stable queue positions, cancellation/retry, lease renewal, stale worker quarantine, no double dispatch and actionable attention records. |
| U10 | Local and remote OpenShell worker execution | Equivalent Core semantics, secure connectivity, version/capability negotiation, bounded data movement, cleanup and clear degraded diagnostics. |
| U11 | Sandbox attempts disallowed filesystem, network and credential access | Fail-closed enforcement, useful error, audit/evidence, no secret or host-path leak and no bypass through alternate tool or process paths. |
| U12 | Native Codex and unified pi-ai provider calls, including streaming, cancellation and error | Correct provider routing, credential isolation, StopReason, usage/cache accounting, policy, capability and real-provider evidence where configured. |
| U13 | Worker MCP tool allow, deny, approval and failure | Tool schema validation, grant and policy binding, approval gate, usage/audit, network and secret boundaries, timeout and clear separation from the end-user Agent Skill Interface. |
| U14 | Vault lock, unlock, injection, revocation, expiry and imported-reference rebind | No plaintext persistence, deterministic failure, cleanup, receipts, redacted diagnostics, cross-workspace isolation and safe operator recovery. |
| U15 | Worker workspace changes against clean, dirty, conflicting and externally modified Git state | Read-only inspection, isolated staging, review before apply, unrelated-change preservation, atomic commit, rollback/reconciliation and approval-gated push. |
| U16 | Workspace export/import and data-root backup/restore with valid, corrupt and unsupported input | Offline verification, no secrets, atomicity, quarantine/fail-closed behavior, identity/repository/vault rebind and no partial target state. |
| U17 | Knowledge ingest, generated proposal, conflict, stale source, retrieval and context materialization | Source traceability, hypothesis status, human override, deterministic validation, sensitivity filtering, stale/conflict visibility and reproducible selection trace. |
| U18 | Audit, Usage, Evidence and RuntimeEvidence inspection after success and failure | Complete producer coverage, distinct record meaning, common lineage, idempotence, redaction, retention, quarantine and no unsupported proof claim. |
| U19 | Unified end-user Skill and bundled CLI loops against local and server NanoCore | Progressive capability discovery, public-contract-only operation, safe credentials, correct mutation gates, recoverable failures, usable diagnostics and evidence-backed completion. |
| U20 | Web projection of the same current workflows | No second source of truth, client-only API use, accessible human attention, correct reconnect/replay, error states and parity with CLI-visible records. |
| U21 | Evaluation, recurring schedules, Skill pinning and runtime sub-agent provenance before implementation acceptance | Feasible authority and storage boundaries, adversarial design cases, bounded cost/data, explicit prerequisites and no false current product claim. |

## Test-First And Commit Discipline

- Choose the smallest cohesive implementation owner before writing a test; do not encode an already-fragmented shape into new fixtures.
- Commit behavior tests before implementation where the repository can keep the test commit reviewable and intentionally failing in sequence.
- Apply package changes in dependency order: Core/protocol documentation, `@openkit/protocol`, shared schemas and policy packages, NanoCore, Core Client, the transport-neutral operation catalog, bundled CLI and unified Skill, Web and supporting docs.
- Commit each changed package separately when behavior crosses package boundaries, as required by repository guidance.
- Keep generated artifacts with the owning package implementation commit unless a generator contract requires a separate mechanical commit.
- Update this record at completed audit groups, material design decisions, implementation handoffs, blockers and verification milestones, not after every command or file edit.
- Never stage or commit unrelated dirty files from the active maintainability, evidence, self-improvement or provenance work.
- Prefer deletion and direct ownership over compatibility shims, parallel routes, duplicated records, passthrough services or speculative configuration.

## Verification Plan

### Per-Item Verification

- Relevant package unit and conformance tests.
- Targeted NanoCore black-box or runtime tests for public and failure behavior.
- Generated schema and OpenAPI drift checks when public contracts change.
- Core Client and bundled CLI operation mapping tests for every public projection change.
- Web component or browser tests only when the Web projection changes.
- One applicable L6 story or explicit reason why the item is fully proved below L6.
- `git diff --check` for every completed slice.

### Documentation And Repository Gates

- `node --test tests/spec-lifecycle.test.mjs`
- `node scripts/validate-spec-lifecycle.mjs`
- Exact active Core/spec/archive inventory and active-spec index comparison.
- Repository-relative Markdown link validation, excluding documented literal syntax examples.
- Searches for invalid lifecycle values, stale archived authority, old paths, duplicate canonical definitions and obsolete terminology.
- `CI=true pnpm run check:repo`

### Package And Product Gates

- `CI=true pnpm run verify:l0-l2`
- `CI=true pnpm run test:e2e:nano`
- `CI=true pnpm run test:e2e:web` when Web is in scope.
- `CI=true pnpm run test:smoke`
- `CI=true pnpm run test:stories`
- `CI=true pnpm run verify:release`
- `CI=true pnpm run verify:full` at final convergence.
- Opt-in real Codex, real provider and real Task Mode stories for applicable runtime/provider slices, with explicit preflight and non-secret evidence.

## Expected Handoffs And Review Gates

- Human review is required before changing Foundation doctrine, replacing a canonical Core owner, accepting a Draft specification, or changing a security or data-loss boundary.
- Overlapping implementation must be handed off from the owning active change plan before this plan edits the same code path.
- Ambiguous documentation-versus-code mismatches must be classified from product intent, current Core authority and actual use rather than resolved by whichever artifact is newest.
- Specification consolidation requires explicit review of replacement coverage and lifecycle evidence before any move to `superseded/` or `retired/`.
- Final closeout requires human review of the canonical owner map, remaining deferred work, real-use evidence and every intentionally retained Partial or Not Started implementation status.

## Risks And Mitigations

- Risk: The audit becomes a permanent program with no completed slices. Mitigation: one ledger item at a time, explicit exit criteria, cohesive checkpoints and no parallel tracking system.
- Risk: Core cleanup deletes near-term product direction. Mitigation: retain deliberate future boundaries, mirror them in roadmap or active specs and distinguish `DEFERRED-ALIGNMENT` from stale doctrine.
- Risk: The document hierarchy is made internally elegant while implementation remains wrong. Mitigation: no document closes without call-path, persistence, test and actual-use evidence.
- Risk: Current implementation is treated as proof that an awkward design is feasible. Mitigation: require explicit design-feasibility review and classify intrinsic complexity separately from ownership-induced complexity.
- Risk: Test suites preserve accidental behavior. Mitigation: trace product intent and Core authority first, then rewrite tests when a documented or implementation behavior is itself defective.
- Risk: Deterministic adapters conceal provider, runtime, network, filesystem or timing failures. Mitigation: use real integration stories for the slices where those external properties are the subject of the contract.
- Risk: Consolidating specifications loses a unique invariant. Mitigation: maintain a replacement checklist and move a spec only after every continuing obligation has a named owner and passing evidence.
- Risk: Concurrent active changes invalidate audit conclusions or cause lost work. Mitigation: re-read status and diffs at every slice boundary, preserve unrelated work and require explicit ownership handoff for overlapping files.
- Risk: Security and secret-handling gaps are treated as ordinary follow-ups. Mitigation: stop the affected slice, add adversarial coverage and resolve the trust boundary before other cleanup continues.
- Risk: The plan adds validators, abstractions and process instead of fixing the system. Mitigation: reuse CodeGraph, existing tests, lifecycle validation and change tracking; add only the smallest mechanical check for proven recurring drift.

## Checkpoints

### 2026-07-11: Plan Established And Roadmap Preflight Completed

- Preserved all 19 current Core aspect documents, explicitly retained Metering and established Foundation as the twentieth planned Core aspect.
- Compared the previously identified future Core directions with the current roadmap.
- Corrected the pi-ai current-state description, added an explicit Workflow Graph and reusable Recipe roadmap entry, and recorded active Task evaluation, self-improvement, recurring scheduler, Skill pinning, sandbox freedom and worker runtime sub-agent provenance design work.
- Recounted the current hierarchy as 19 Core documents, 61 active specifications and 55 archived specifications, and recorded current status and implementation-alignment distributions.
- Used CodeGraph to identify the principal runtime, protocol, public API, storage, governance, provider and test call-path clusters before defining the implementation audit ledger.
- Identified active overlap with NanoCore maintainability recovery, evidence simplification, self-improvement foundations and concurrent worker runtime provenance work; this plan does not claim their in-flight files.
- Created the complete C00-C19, S01-S61 and D01-D13 review ledger plus the U01-U21 real-use scenario matrix before beginning implementation remediation.
- Verified exact Core and active-spec ledger coverage, all local Markdown links in the roadmap and this plan, spec lifecycle metadata and tests, whitespace, and the full `CI=true mise exec -- pnpm run check:repo` gate.

### 2026-07-13: Agent Skill Interface Lifecycle Alignment

- Replaced the superseded AI Interface entry with the accepted Agent Skill Interface, removed the retired Development Loop entry, and intentionally retained the stable ledger-id gap rather than renumbering later audit items.
- Refreshed the current hierarchy to 60 active specifications and 57 archived specifications, with implementation alignment of 41 Implemented, 13 Partial, 0 Diverged, and 6 Not Started.
- Replaced the MCP-first end-user audit path with the unified Skill and bundled CLI path while preserving worker-side MCP as a separate capability plane.

### 2026-07-13: Direct Worker Control And Capability Truth Reset

- Classified the mismatch as `DOC-DRIFT`: the implementation had already removed the worker control sidecar, worker capability client, NanoCore worker-capability routes, worker MCP gateway, and worker MCP smoke, while multiple canonical documents still described those surfaces as current.
- Recorded direct authenticated NanoCore `/api/worker-control` as the only governed worker-control path. Transcript files remain evidence and import input, not a fallback control mode; capability mediation must not become another control path.
- Preserved `capability.local`, worker Knowledge operations, and worker MCP tool supply as accepted future contracts, while aligning current AEP truth to `capabilities.mode: disabled` with no routes.
- Corrected the affected Core, roadmap, AEP, runtime communication, control, capability, MCP, usage-ledger, Knowledge, OpenShell, packaging, supply, synchronization, and audit-ledger documents without editing the dedicated worker runtime provenance specification or its change plan.
- Updated the active-spec baseline to 37 Implemented, 17 Partial, 0 Diverged, and 6 Not Started. The four corrected Partial classifications are explicit review work, not implementation regressions introduced by this documentation slice.
- Real L6 setup found that initial provider and agent writes require an explicit NanoCore restart. The runner must restart safely and prove that its idempotent rerun neither duplicates nor widens the configured authority.
- Authenticated repository linking materializes workspace data-source configuration. A rerun may consume only the exact safe session-scoped restart deferral and must then prove that the repository-link operation is a no-op.
- Real OpenShell preflight failed closed before worker launch when the local CLI was `0.0.63` and the gateway required `0.0.80`. The test environment now uses the officially validated `0.0.80` CLI; the failure remains evidence that exact-version negotiation is an enforced launch gate.
- The first Goal in another thread or workspace exposed a collision between user-store-global item IDs and thread-local Goal IDs. The regression test and objective-item identity correction are complete, so distinct Goal lineages no longer reuse one store-global item ID.

### 2026-07-14: Real Codex L6 Hardening And Initial Core Alignment

- Added the accepted Foundation Core document as the twentieth aspect, kept Metering as a separate Core owner, and aligned the Core inventory, term index, reading order, roadmap, and measurement doctrine with current runtime, workspace-transfer, and Git network UsageRecord producers.
- Aligned scheduler documentation and implementation around strict same-snapshot renewal, bounded renewal lifetime, terminal and stale lease recovery, and the rule that cross-snapshot supply refresh requires a future NanoCore-issued source-to-target request and atomic rebinding contract rather than an acknowledgement shortcut.
- Corrected Goal dispatch, lifecycle, identity, provider selection, cleanup, and lease paths found by repeated real-story execution, including scheduler recovery records being reopened under the originating admission owner instead of `user_local`.
- Preserved typed Codex provider failures, current `openai-codex/gpt-5.6-sol` selection, safe provider-message redaction, and actionable workspace-review rejection reasons without retaining the retired model or adding fallback compatibility.
- Replaced order-sensitive workspace-base comparison with structural comparison, then fixed the deeper real-use defect by capturing the host repository's immutable Git `HEAD` in the AEP before worker materialization. NanoCore and the worker now independently bind the same review base instead of weakening the review gate.
- Hardened the A1 topology used for the real story: the worker image is built natively on A1, the local runner and NanoCore connect to the A1 OpenShell gateway through explicit tunnels, the worker-control endpoint is reverse-forwarded, and the A1 Codex auth file is streamed only into the local server-owned account slot with strict file preflight and no worker exposure.
- Removed the remaining host-path Codex auth upload option from NanoCore and the OpenShell backend. Non-relay sandbox auth now has one owner, the vault-backed runtime-file path, while trusted-relay workers receive no Codex auth file.
- Corrected the Knowledge delivery projection: current Task Mode can retain selected Knowledge references in delegation metadata, but automatic binding into an AEP, worker input, or materialized Context Package remains unimplemented. Captured the missing durable deadline and restart-recovery path for stuck `releasing` leases in the scheduler spec and roadmap instead of calling the 5-minute release grace active.
- Extended the real L6 oracle to require the completed terminal `runtime.worker_turn` CapabilityCall and its single `sandbox_sessions` UsageRecord in addition to LLM inference, audit, evidence, RuntimeEvidence, review, Goal, and Git assertions.
- Reduced every deterministic defect in this hardening sequence to focused L1-L5 regression coverage before its implementation correction. The remaining Core and active-spec ledger rows remain open and will continue from this ledger rather than being declared complete by one successful story.
- Passed the real A1 acceptance run with the A1-built ARM64 Linux worker image, OpenShell `0.0.80`, `openai-codex/gpt-5.6-sol`, exact proof content, unchanged Git `HEAD`, one applied workspace review, one completed Goal task, exactly one terminal runtime CapabilityCall, exactly one linked `sandbox_sessions` UsageRecord, `0600` redacted evidence files, and zero residual A1 sandboxes.

### 2026-07-15: Stock OpenShell Causal Teardown Boundary

- Classified the late-create cleanup defect as a backend lifecycle design gap: stock OpenShell `0.0.80` resource deletion cannot prove that every previously accepted create has terminated before scheduler capacity is released.
- Removed the active OpenShell source patch dependency and prohibited any external dependency fork, patch queue, replacement Gateway, or private release artifact.
- Reviewed current NemoClaw prior art and retained its official artifact pinning, ownership-aware process control, fail-closed probes, and staged recovery lessons without claiming that its shared-Gateway sandbox delete path closes the late-create race.
- Proved on A1 that killing and discarding a complete stock OpenShell epoch containing the Gateway, containerd, dockerd, state roots, sockets, and JWT material fences a held Docker create without modifying OpenShell.
- Promoted the stable capacity-release invariant into the Core Sandbox document and accepted `docs/specs/20260715-openshell_disposable_cell_lifecycle.md` as the concrete single-slot, cold-Cell implementation contract.
- Local and A1 fork checkouts, patched build outputs, and test-epoch artifacts were removed; the GitHub fork was deleted and verified absent with `404 Not Found`; the retained A1 CLI and Gateway binaries remain stock `0.0.80`.
- The remote OpenShell Gateway specification was retired without a compatibility path; active-spec alignment is now 36 Implemented, 18 Partial, 0 Diverged, and 6 Not Started across 60 active specifications, with 58 archived specifications.
- The local controller, privileged helper, backend lifecycle, one-slot scheduler baseline, and helper-level A1 acceptance are implemented under C04, C16, S26, and S27. One real NanoCore Worker turn through the replacement Cell remains before the specification can become Implemented.
- Built `openkit/worker-codex:dev` natively on A1 with host-network package resolution, passed the isolated image smoke with Node `24.18.0` and Codex `0.144.1`, and saved the 899 MB arm64 worker archive beside the exact 14 MB stock supervisor archive in the root-owned Cell image cache.
- Exercised normal prepare/recycle, intentional fresh-start failure, same-owner recovery, idempotent recycle retry, wrong-owner recycle, and second-owner prepare against the installed helper. The final stock replacement is healthy and empty at epoch `7`; the retry retained `7 -> 7`, and ownership mismatches did not signal, delete, or change the epoch.
- Landed the official-artifact disposable Cell command surface in `eca6df8`, the NanoCore local/remote lifecycle, product scheduler projection, durable target binding, bounded CLI execution, retry-safe helper, and remote backend path in `5bcbf68`, and the A1-discovered worker-shim E2E fixture correction in `f156187`.
- Rebuilt and smoked the worker image natively on A1, ran the local worker-shim sandbox E2E, and ran the Mac-to-A1 remote backend E2E through an operator SSH local-forward. The remote E2E materialized a sandbox, executed a command, downloaded its result, and recycled the complete Cell into a fresh empty epoch.
- Proved same-boot Docker control-plane loss fails closed with the owner and roots retained, same-owner cross-boot recovery removes the stale epoch, and a post-fence root-removal failure persists the `fenced` marker and bridge identity for a Docker-independent retry. Wrong-owner recycle remained inert and same-owner idempotent retry preserved epoch `20 -> 20`.
- Verified the former `lingkaix/OpenShell` GitHub fork remains absent with HTTP 404, no active patch or fork artifact exists in the repository or A1 home, and A1's package-owned CLI and Gateway both report stock `0.0.80`.

## Implementation Summary

Active. The roadmap preflight, durable audit ledger, Foundation promotion, Metering current-state alignment, worker-capability truth reset, scheduler hardening, Codex provider hardening, workspace-review base correction, real Goal L6 slice, and S26 disposable OpenShell Cell audit are implemented. The remaining Core and specification rows stay open for sequential design, code, persistence, failure-path, security, and L0-L6 review.

## Final Verification

Program-level closeout remains pending until every ledger row is audited. The 2026-07-14 hardening slice passed focused regression tests, the complete NanoCore suite, NanoCore lint, typecheck and build, the repository-wide check, the real L6 runner suite, real A1 OpenShell/Codex Goal acceptance, exact proof-file and unchanged-`HEAD` checks, redacted evidence checks, and the zero-residual-sandbox check.
