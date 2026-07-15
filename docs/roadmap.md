# Design Roadmap

Status: Living document

This document records design areas that are acknowledged as necessary for the complete OpenKit system but are intentionally not being designed or implemented yet. It exists so that deferred areas stay visible, keep their boundary declarations in core docs, and do not silently re-enter scope through implementation drift.

This is not a release plan and not a task list. Release-scoped implementation plans and lifecycle records live under `docs/changes/`, and active design contracts live under `docs/specs/`. When a deferred area becomes active, it leaves this document and gains a spec.

## How to use this document

Each entry states what the area is, why it is deferred, where its boundary is currently declared, and what must be true before design starts. Entries are grouped by the layer they belong to. Do not begin implementation design for an entry here without first writing or updating the owning spec.

## Deferred Design Areas: Kernel And Below

### Unified proxy: third-party resource proxy, network egress

The product vision (§6.5) defines a unified proxy covering LLM providers, MCP servers, third-party APIs, and network egress, with auth injection, access control, rate limiting, and audit. The LLM provider plane is active (`docs/specs/20260526-llm_gateway_responses_api.md`, `docs/specs/20260708-pi_ai_unified_llm_backend.md`). Worker-side MCP supply has an accepted target contract (`docs/specs/20260704-worker_mcp_tool_supply.md`) but no current implementation. Authenticated third-party resource access and unified network egress are also deferred. Boundary declarations live in `docs/core/agent-capability.md`. Implementation should start only after the worker capability plane has a reviewed catalog and budget model, since proxy access control composes with capability grants; credential-bearing paths must reuse the vault injection contract (`docs/specs/20260703-vault_secret_injection.md`, `docs/specs/20260703-openshell_mechanism_internalization.md`) rather than inventing a parallel mechanism.

### Worker capability plane and MCP tool supply

The accepted worker capability and MCP contracts remain the target design in `docs/specs/20260703-worker_agent_capability.md` and `docs/specs/20260704-worker_mcp_tool_supply.md`. The earlier implementation was removed during the direct worker-control reset: current Agent Environment Packages require `capabilities.mode: disabled` with no routes, `@openkit/worker-shim` has no capability client, and NanoCore exposes no `/api/worker-capabilities/*` routes or worker MCP gateway. This area stays visible here until a dedicated implementation slice rebuilds it from the accepted contracts after direct worker control and runtime provenance pass real OpenShell/Codex acceptance. Reimplementation must begin with current trust-boundary tests and must not restore the removed sidecar or create a second control path.

### Capability catalog and rate-limit/budget model

The worker capability plane (`docs/specs/20260703-worker_agent_capability.md`) defers the full capability catalog schema, per-capability rate limits, and budget enforcement. The shared durable usage foundation for LLM gateway producers is active in `docs/specs/20260704-capability_usage_gateway_foundation.md`, but it deliberately does not implement budget or rate-limit policy. The deferred model remains the economic backbone for multi-agent concurrency and is a prerequisite for the proxy planes above. Design should start after at least one non-LLM worker capability family is durably implemented and real usage rows show the required control dimensions.

### Metering expansion, budgets, and cost projection

`docs/core/metering.md` now owns an active system-wide measurement model. Durable producers cover gateway usage, terminal worker-session counts, workspace export and import file and byte inventories, and governed Git publication request counts. Continuous sandbox duration, CPU and memory allocation, retained storage, network traffic volume, scheduler reservations, aggregation policy, budget enforcement, and cost projection remain deferred. Expansion should begin only when a concrete producer can observe a meaningful unit with durable attribution and idempotency, and real dogfooding shows that the measurement changes an operational or economic decision.

### LLM provider gateway later slices

The LLM provider plane is active through the NanoCore-native Codex Responses path and the unified pi-ai backend for non-Codex providers (`docs/specs/20260708-pi_ai_unified_llm_backend.md`). Several provider-expansion choices stay deferred until the routed-provider paths are stable in real use. Deferred slices include pi-ai OAuth-based provider logins such as Anthropic subscription, GitHub Copilot, or Gemini CLI; image generation through pi-ai's image API surface; explicit policy-directed cross-provider handoff using pi-ai context replay; and migrating the Codex path from the NanoCore-native Codex Responses client to pi-ai's `openai-codex-responses` API. Design should start only when gateway usage records, credential isolation tests, and provider catalog reconciliation have enough evidence to prove that these choices reduce maintenance cost without weakening audit, credential, or protocol boundaries.

### Workflow Coordinator dynamic planning

The V1 Workflow Coordinator internal-agent contract is active in `docs/specs/20260704-workflow_coordinator_internal_agent.md` and covers explicit routing, worker selection, context assembly coordination, plan drafting, and stop decisions. The deferred evolution target from the product vision (§6.1) is dynamic planning from accumulated outcomes: selecting agent config packs, workers, context assembly, and handoff patterns from task characteristics and historical performance. Boundary declarations live in `docs/core/agent-workflow.md`, which also gates graph semantics (dependencies, branches, joins) as "earned" only when real workflows require them. Prerequisite: accumulated task history plus the active evaluation and self-improvement design listed under Recently Activated, since dynamic planning without outcome measurement cannot improve.

### Workflow graphs and reusable recipes

`docs/core/agent-workflow.md` intentionally reserves workflow dependencies, attempts, branches, joins, lineage, and reusable recipes without forcing runtime-private task graphs into the Core model. The full graph contract remains deferred until active Goal, Task, automation, and evaluation workflows require scheduling or reviewing relationships that cannot be represented by normal thread, turn, item, causation, checkpoint, and handoff semantics. The owning design must define graph authority, persistence, retry and cancellation behavior, branch and join failure semantics, human review projection, evidence lineage, and the boundary between Core-visible workflow structure and agent-private planning before these concepts become implementation requirements.

### Git provider adapters beyond GitHub

The V1 Git write workflow is active through `docs/specs/20260704-git_write_workflow.md` and supports GitHub only. GitLab, Gitea, and generic Git server adapters are deferred provider slices over the same commit-on-apply, approval, policy, protected-branch, and `GitPushRecord` contracts. Design should start after the GitHub path is dogfooded and the system has evidence about which provider differences belong in adapter configuration versus durable product records.

### Multi-channel communication gateway

The product vision (§6.2) targets Core as a gateway for external messaging channels (Discord, Slack, Signal, and similar). `docs/core/communication.md` already fixes the invariant that channels are projections that must not implement their own workflow truth. The concrete channel adapter contract, identity mapping, and notification routing are deferred until the Web and end-user Agent Skill Interface are stable in real use, since another channel type would currently expand surface area while the workflow mechanisms are still hardening.

### Generative Kernel data plane

The product vision (§6.8) defines the Generative Kernel: data structure contracts and storage that let agents build and operate user-generated internal tools, with end users consuming data through product surfaces and agents through skills and CLIs. `docs/core/architecture.md` marks it as a future component requiring separate design. This is post-v1 by design; it should not begin before the Knowledge Store implementation (`docs/specs/20260703-knowledge_store_implementation.md`) is stable, because both compete for the same governance machinery and the kernel must reuse, not duplicate, policy, vault, and audit boundaries.

### Knowledge v2: knowledge-driven improvement

The product vision (§7.2) sequences knowledge synthesis — extracting task summaries, stable preferences, and agent/task fit from history with confidence, freshness, source traceability, conflict handling, and human override — strictly after v1 retrieval quality is proven. Owned boundaries live in `docs/core/knowledge.md` and the Knowledge Store specs. Deferred until v1 retrieval, proposal, and review loops have real usage history.

### Scheduler release closeout, scale-out, warm-session reuse, and multi-node placement

The durable scheduler design (`docs/specs/20260703-durable_scheduler_design.md`) covers durable records, admission, leases, same-snapshot renewal, and initial recovery, and explicitly defers durable release deadlines for stuck `releasing` leases, warm pools, live AEP refresh across immutable snapshots, and multi-node scheduling. Before the accepted 5-minute release grace becomes active, the lease record, watch loop, restart recovery, evidence closeout, and capacity accounting must handle `releasingAt`, `releaseDeadline`, and deadline expiry without leaking capacity. Same-snapshot lease renewal is active and does not require a refresh declaration. The first stock OpenShell runtime is now a single-slot disposable Cell with local and remote placement (`docs/specs/20260715-openshell_disposable_cell_lifecycle.md`); remote placement binds one fixed SSH lifecycle target to one explicit Gateway origin and sandbox-reachable worker-control URL instead of using a naked shared Gateway. Multiple Cells, target selection, warm reuse, and multi-node scheduling remain deferred until each Cell has independent capacity and network identity plus whole-runtime teardown proof. Until a future design defines a NanoCore-issued source-to-target refresh request, adapter and shim support negotiation, atomic lease and token rebinding, rollback, and audit evidence, an incompatible AEP snapshot makes the session stale and the next bounded step requires a new plan and lease. The scale and refresh areas become relevant only after local and remote Cell continuity and release closeout are proven through real OpenShell use.

## Deferred Design Areas: Product Surface And UI

The current development posture is NanoCore-first and end-user Agent-Skill-first: kernel contracts stabilize before the unified `openkit` Skill, bundled CLI, or Web UI projects them as a product surface (`README.md`, `docs/specs/20260713-openkit_agent_skill_interface.md`, `docs/specs/20260628-web_product_surface_projection.md`). The areas below are product commitments from the vision whose design work is deliberately sequenced after kernel stabilization. They are projections over kernel contracts and MUST NOT become a second source of workflow or protocol truth.

### Web UI product surface completion

The vision (§5.1–§5.3) commits to a conversation-first interface where users manage agents like a real team: who owns what, where each task stands, which communications and handoffs happened, which artifacts are done, and when human intervention is needed — plus the config interface for agents, runtimes, environments, and preferences. The posture spec fixes the projection boundary; the actual product design (information architecture, task and communication tracking surfaces, Action Center presentation, notebook views over the Knowledge Store) is a 0.x milestone per the README roadmap. Prerequisite: stable protocol, App API, and workflow mechanisms proven through the end-user Agent Skill Interface.

### Artifacts presentation and interactive rendering

The vision (§5.2) references LibreChat-style artifact interaction: structured outputs and work products rendered as first-class reviewable objects rather than chat text. Artifact records, storage, and review flows exist at the kernel layer; the presentation contract — which artifact kinds get rich rendering, preview versus export behavior, and how artifact review actions map to the human-attention model — is undesigned. Belongs with Web UI completion but is called out separately because the Agent Skill Interface and future desktop channels also consume artifact presentation metadata.

### Generative UI

The vision (§5.2) plans generative interfaces where model output produces rich visual and interactive results in suitable scenarios, and §6.8 makes Generative UI the end-user consumption surface of the Generative Kernel: users query and manage kernel-held structured data through generated interfaces while agents access the same data through skills and CLIs. This is a major post-v1 design area with two halves that must be designed together but staged separately: the rendering and safety contract for model-generated UI (sandboxing, capability limits, what generated code may touch), and the data-plane binding to the Generative Kernel. Prerequisites: the Generative Kernel data plane entry above, and policy/audit boundaries extended to generated-surface actions so generated UI never becomes an ungoverned side channel.

### Desktop application packaging

The vision (§1) targets wrapping the SPA into a Tauri desktop app after the SPA form is mature. Packaging, update channels, local NanoCore bundling versus remote connection, and OS keychain integration for local credentials are undesigned. Prerequisite: Web UI completion.

### Team collaboration and multi-user tenancy

The vision (§2) targets 3–5 person expert teams sharing a workspace, and the workspace concept reserves future collaboration scope (`README.md` core model). The localhost MVP explicitly excludes multi-user tenancy and production auth. Identity foundations exist (`docs/specs/20260628-nanocore_config_identity_contract.md`), but membership, roles, shared review authority, per-member knowledge scopes, and concurrent human attention are undesigned. Prerequisite: single-user v1 loops proven; the NGAC policy model was chosen partly to make this extension tractable.

### Skill and plugin distribution

OpenKit-authored Skills ship in-repo today (`skills/README.md`), and immutable catalog version identity, pinning, and promotion are now active design work in `docs/specs/20260711-skill_catalog_versioning_pinning.md`. A general plugin marketplace remains an explicit MVP non-goal. Third-party packaging, publisher trust, signature policy, discovery, installation, and distribution should not be designed until versioned first-party and workspace-local supply has been dogfooded and demonstrates a real need for an external ecosystem.

## Recently Activated (moved out of this list)

- Cross-aspect Foundation doctrine, with Metering retained as a separate active Core owner: `docs/core/foundation.md`, `docs/core/metering.md`, and `docs/changes/202607111941330001-core_spec_implementation_alignment_audit.md`.
- System-wide measurement now has durable non-gateway runtime, storage, and Git network producers; broader resource measurement, budgets, and cost projection remain in the deferred entry above: `docs/core/metering.md`.
- Unified non-Codex LLM routing through `@earendil-works/pi-ai`: `docs/specs/20260708-pi_ai_unified_llm_backend.md`.
- Task evaluation and self-improvement through the Reflector, Harness, and Judge design, which is the active path for resolving the Task Evaluator placeholder: `docs/specs/20260710-self_improvement_evaluation_loop.md` and `docs/specs/20260711-evaluation_harness_design.md`.
- Durable recurring scheduler and event-trigger design: `docs/specs/20260711-scheduler_recurring_event_triggers.md`.
- Immutable Skill catalog version identity, pinning, and promotion: `docs/specs/20260711-skill_catalog_versioning_pinning.md`.
- Worker sandbox freedom and explicit process, filesystem, network, credential, and review boundaries: `docs/specs/20260709-worker_sandbox_freedom_policy.md`.
- Worker runtime sub-agent provenance, trusted inference identity, and runtime-cache lineage design accepted and in phased implementation: `docs/specs/20260711-worker_runtime_subagent_provenance.md`.
- Local and remote single-slot disposable OpenShell Cells with fixed lifecycle ownership and whole-runtime teardown: `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`.
- Vault injection, audit import, and NGAC policy enforcement mechanics via OpenShell mechanism borrowing with internalized definitions: `docs/specs/20260703-openshell_mechanism_internalization.md`.
- Knowledge Store implementation with pinned OKF 0.1: `docs/specs/20260703-knowledge_store_implementation.md`.
- Durable scheduler design: `docs/specs/20260703-durable_scheduler_design.md`.
- Chat Mode and Core Assistant: `docs/specs/20260704-chat_mode_assistant.md`.
- Task Mode worker delegation: `docs/specs/20260704-task_mode_worker_delegation.md`.
- Goal Mode coordination: `docs/specs/20260704-goal_mode_coordination.md`.
- Workflow Coordinator internal agent: `docs/specs/20260704-workflow_coordinator_internal_agent.md`.
- Knowledge Manager internal agent runtime: `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`.
- Worker MCP tool-supply design remains accepted, while implementation has returned to the deferred worker-capability entry above: `docs/specs/20260704-worker_mcp_tool_supply.md`.
- Shared capability usage ledger and durable LLM producers are active; the worker MCP producer remains pending: `docs/specs/20260704-capability_usage_gateway_foundation.md`.
- NanoCore boot, readiness, and recovery: `docs/specs/20260704-nanocore_bootstrap_readiness.md`.
- Remote auth bootstrap and channel credential storage: `docs/specs/20260704-remote_auth_credential_bootstrap.md`.
- Vault backends (OS keychain and encrypted local store): `docs/specs/20260704-vault_backend_implementation.md`.
- Workspace backup, export, import, and data-root migration: `docs/specs/20260704-workspace_backup_export_import.md`.
- Agent session continuity (snapshot, resume, rollback, crash recovery records): `docs/specs/20260704-agent_session_continuity.md`.
- Git write workflow (commit-on-apply, review branches, GitHub-only approval-gated push): `docs/specs/20260704-git_write_workflow.md`.

## Links

- `docs/product-vision.md`
- `docs/specs/README.md`
- `docs/core/README.md`
