# Independent Documentation Audit Before v0.1.0

This record is the summary of the independent documentation audit that runs before the first OpenKit release, `v0.1.0`. The engineer directed the audit, so [Change Execution](../change-execution.md) is its owning rule. The record is non-authorizing evidence. It does not accept a design, waive a requirement, or approve a decision. The engineer's review of the audit pull request decides what takes effect.

## Scope And Independence

The auditor saw this repository and its GitHub issues and pull requests, and nothing else. The repository is meant to be the single source of truth. A fact that the auditor could know only from outside the repository is itself a finding.

The engineer assigned two roles to one agent. As [Auditor](../roles/auditor.md), it writes the findings and these dated audit records. As [Writer](../roles/writer.md), it writes the documentation corrections. The findings live in the audit records. The corrections live in their own commits. The auditor did not change code, tests, CI, package manifests, or generated files, except for the regeneration of `docs/INDEX.md` by its generator.

Development continued on `main` during the audit. Issue [#440](https://github.com/lingkaix/openkit/issues/440) is the readiness channel. A group that #440 holds was not audited. The auditor read #440 before each group and did not edit it.

## Method

### Base And Inventory

The audit base is `67d3e5a68453b9efd76c3313768c01dd87ae8cdb`, the head of `main` on 2026-10-23. Each group record states its own group base, because the branch is rebased onto `main` before each group.

`git ls-files` at the audit base gives this inventory:

| Corpus | Files | Treatment |
| --- | --- | --- |
| `docs/core/` | 22, including `README.md` and `AGENTS.md` | Full audit; `AGENTS.md` receives proposals only |
| Active specifications at the root of `docs/specs/` | 101 dated files, plus `README.md` and `AGENTS.md` | Full audit; `AGENTS.md` receives proposals only |
| `docs/specs/retired/` and `docs/specs/superseded/` | 67 | Archive check only |
| `docs/decisions/` | 235 | Evidence only |
| `docs/changes/` | 176 | Evidence only |
| `docs/audits/` | 8 | Evidence only |
| Other files at the root of `docs/` | 16, including the two OpenKit Knowledge Format (OKF) snapshots | Periphery group; the snapshots are evidence only |
| `docs/manual/`, `docs/cookbooks/`, `docs/roles/` | 25 | Periphery group |
| `README.md` files under `apps/` and `packages/` | 55 | Periphery group |

### Goals

The audit has five goals:

- G1 compares the product vision with the design. The test is whether an agent could build the system that `docs/product-vision.md` describes from the documents alone. Two methods apply: a top-down derivation from the vision, and a clean-room probe that reads only an export of `docs/` and `AGENTS.md`.
- G2 compares the Core documents with the specifications. It finds conflicts, missing alignment, and content in the wrong document type.
- G3 compares the specifications with the implementation. Accepted Core documents and specifications own behavior, decision records explain intent, and code establishes implementation facts only.
- G4 reorganizes the specifications so that strongly related content goes together. It uses the clause test in the Auditor role contract.
- G5 checks every audited document against `docs/writing.md` and rewrites violations without a change of meaning.

### Grouping Rule

Core documents link decision records and not specifications. Specifications cite Core documents in their `Core References` section. The auditor therefore gave each specification one home group: the Core document that owns the primary concept in the specification's `## Owns` section. The term index in `docs/core/README.md` decided the owner of each concept.

The auditor applied two further rules:

- A specification whose primary concept has no Core owner goes to a group named for its kind, `process` or `topology`. Each such specification is a G2 or G4 finding.
- A specification with two equally strong homes is a finding. When one of the two homes is held under #440, the specification is held too, because the held design can change it.

### Order

The open groups come first, in an order that audits foundations before their consumers. The held groups follow when #440 releases them. The periphery group comes last.

1. `doctrine`, with `docs/core/README.md` and `docs/core/AGENTS.md`
2. `core-concepts`
3. `architecture`
4. `contract-evolution`
5. `protocol`
6. `communication`
7. `identity`
8. `policy`
9. `mediation`
10. `vault`
11. `sandbox`
12. `agent-supply`
13. `agent-session`
14. `knowledge`
15. `generative-apps`
16. `process`
17. `topology`
18. `specs-index`, which is `docs/specs/README.md` and `docs/specs/AGENTS.md`
19. Held groups: `work-model`, `runtime-model`, `fault-tolerance`, `storage`, `evidence`
20. `periphery`

### Code Map

| Group | Implementation paths |
| --- | --- |
| core-concepts | `packages/protocol`, Thread and sharing modules under `apps/nanocore/src` |
| architecture | `apps/web`, `apps/nanocore/src/internal-agents`, `apps/nanocore/src/runtime`, `packages/worker-shim`, `packages/pi-runtime-host`, `packages/codex-app-server-schema` |
| contract-evolution | `packages/codex-app-server-schema`, `packages/models-dev-catalog`, `packages/worker-shim/snapshots`, canonical envelope writers under `apps/nanocore/src/storage` |
| protocol | `packages/protocol`, `apps/nanocore/src/pending-request-operations.ts` and its peers |
| communication | `packages/core-client`, `packages/app-api-schemas`, `apps/nanocore/openapi`, `packages/worker-protocol`, `apps/nanocore/src/remote-mcp-routes.ts` |
| identity | `apps/nanocore/src/auth`, `apps/nanocore/src/config`, `apps/nanocore/src/administration`, `packages/config-schema` |
| policy | `packages/policy-kernel`, `apps/nanocore/src/policy` |
| mediation | `apps/nanocore/src/llm`, `apps/nanocore/src/providers`, `apps/nanocore/src/capability`, operation modules under `apps/nanocore/src`, `apps/nanocore/src/internal-agents` |
| vault | `apps/nanocore/src/vault`, `apps/nanocore/src/providers` |
| sandbox | `apps/nanocore/src/worker-environments`, `apps/nanocore/src/runtime`, `apps/nanohost`, `containers` |
| agent-supply | `apps/nanocore/src/agents`, `apps/nanocore/src/catalog`, `packages/worker-shim` |
| agent-session | `apps/nanocore/src/runtime` |
| knowledge | `apps/nanocore/src/knowledge`, `apps/nanocore/src/context`, `packages/retrieval-kernel` |
| generative-apps | `apps/nanocore/src/generative-kernel`, `apps/nanocore/src/generative-ui`, `apps/web/src/generative` |
| process | `tests`, `scripts`, `.github/workflows` |
| topology | `containers`, release scripts under `scripts`, `apps/nanocore/src/app-update`, `skills/openkit-ops` |

### Roles And Checks

The primary auditor read and wrote every document change itself. Read-only inspectors checked one specification or one clause set each against the mapped code at the group base. The auditor verified every inspector finding before it used it; an unverified finding is not reported. A fresh reviewer checked each group's diff, record, and claim inventory, and the group record states its findings and their resolution.

Before each commit the auditor ran `node scripts/validate-doc-model.mjs`, `node scripts/generate-doc-index.mjs`, `pnpm check:repo`, and a content scan for credentials, private hosts, local absolute paths, and Vietnamese text. The audit container has Node.js 22.22.0, while `package.json` requires 24.18.0. At the audit base, `pnpm check:repo` passed in that container with an engine warning only.

## Coverage Ledger

The state `held` means that #440 holds the group and the auditor did not audit it. The state `pending` means that the audit of the group has not started.

| Path | Group | State | Group record |
| --- | --- | --- | --- |
| `docs/core/AGENTS.md` | doctrine | pending | - |
| `docs/core/README.md` | doctrine | pending | - |
| `docs/core/agent-session.md` | agent-session | pending | - |
| `docs/core/agent-supply.md` | agent-supply | pending | - |
| `docs/core/architecture.md` | architecture | pending | - |
| `docs/core/communication.md` | communication | pending | - |
| `docs/core/contract-evolution.md` | contract-evolution | pending | - |
| `docs/core/core-concepts.md` | core-concepts | pending | - |
| `docs/core/doctrine.md` | doctrine | pending | - |
| `docs/core/evidence.md` | evidence | held | - |
| `docs/core/fault-tolerance.md` | fault-tolerance | held | - |
| `docs/core/generative-apps.md` | generative-apps | pending | - |
| `docs/core/identity.md` | identity | pending | - |
| `docs/core/knowledge.md` | knowledge | pending | - |
| `docs/core/mediation.md` | mediation | pending | - |
| `docs/core/policy.md` | policy | pending | - |
| `docs/core/protocol.md` | protocol | pending | - |
| `docs/core/runtime-model.md` | runtime-model | held | - |
| `docs/core/sandbox.md` | sandbox | pending | - |
| `docs/core/storage.md` | storage | held | - |
| `docs/core/vault.md` | vault | pending | - |
| `docs/core/work-model.md` | work-model | held | - |
| `docs/specs/20260522-vendor_snapshot_packages.md` | contract-evolution | pending | - |
| `docs/specs/20260526-llm_gateway_responses_api.md` | mediation | pending | - |
| `docs/specs/20260528-core_client_boundary.md` | communication | pending | - |
| `docs/specs/20260529-l6_story_acceptance.md` | process | pending | - |
| `docs/specs/20260529-test_strategy.md` | process | pending | - |
| `docs/specs/20260531-human_attention_intervention_model.md` | work-model | held | - |
| `docs/specs/20260531-worker_turn_reliability_envelope.md` | runtime-model | held | - |
| `docs/specs/20260616-agent_environment_package.md` | agent-supply | pending | - |
| `docs/specs/20260628-nanocore_config_identity_contract.md` | identity | pending | - |
| `docs/specs/20260628-web_product_surface_projection.md` | architecture | pending | - |
| `docs/specs/20260629-openkit_policy_model.md` | policy | pending | - |
| `docs/specs/20260629-worker_runtime_communication_model.md` | communication | pending | - |
| `docs/specs/20260702-knowledge_store_governance_rules.md` | knowledge | pending | - |
| `docs/specs/20260703-agent_manifest_aep_resolution.md` | agent-supply | pending | - |
| `docs/specs/20260703-audit_usage_evidence_records.md` | evidence | held | - |
| `docs/specs/20260703-durable_scheduler_design.md` | runtime-model | held | - |
| `docs/specs/20260703-knowledge_store_implementation.md` | knowledge | pending | - |
| `docs/specs/20260703-openshell_mechanism_internalization.md` | sandbox | pending | - |
| `docs/specs/20260703-pi_ai_provider_gateway_adoption.md` | mediation | pending | - |
| `docs/specs/20260703-policy_enforcement_mapping.md` | policy | pending | - |
| `docs/specs/20260703-runtime_scheduling_scale.md` | runtime-model | held | - |
| `docs/specs/20260703-schema_evolution_record_envelope.md` | contract-evolution | pending | - |
| `docs/specs/20260703-storage_layout_record_ownership.md` | storage | held | - |
| `docs/specs/20260703-vault_secret_injection.md` | vault | pending | - |
| `docs/specs/20260703-worker_agent_capability.md` | mediation | pending | - |
| `docs/specs/20260703-worker_context_package.md` | knowledge | pending | - |
| `docs/specs/20260703-worker_control_protocol.md` | communication | pending | - |
| `docs/specs/20260703-workspace_synchronization.md` | storage | held | - |
| `docs/specs/20260704-agent_session_continuity.md` | agent-session | pending | - |
| `docs/specs/20260704-app_api_openapi_projection.md` | communication | pending | - |
| `docs/specs/20260704-capability_usage_gateway_foundation.md` | mediation | pending | - |
| `docs/specs/20260704-chat_mode_assistant.md` | work-model | held | - |
| `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` | knowledge | pending | - |
| `docs/specs/20260704-nanocore_bootstrap_readiness.md` | fault-tolerance | held | - |
| `docs/specs/20260704-remote_auth_credential_bootstrap.md` | identity | pending | - |
| `docs/specs/20260704-session_static_workspace_materialization.md` | sandbox | pending | - |
| `docs/specs/20260704-task_mode_worker_delegation.md` | work-model | held | - |
| `docs/specs/20260704-vault_backend_implementation.md` | vault | pending | - |
| `docs/specs/20260704-worker_mcp_tool_supply.md` | mediation | pending | - |
| `docs/specs/20260704-workflow_coordinator_internal_agent.md` | architecture | pending | - |
| `docs/specs/20260704-workspace_backup_export_import.md` | storage | held | - |
| `docs/specs/20260704-workspace_data_source_catalog.md` | agent-supply | pending | - |
| `docs/specs/20260708-container_image_packaging.md` | topology | pending | - |
| `docs/specs/20260708-pi_ai_unified_llm_backend.md` | mediation | pending | - |
| `docs/specs/20260709-quick_chat_workspace.md` | work-model | held | - |
| `docs/specs/20260709-worker_credential_access_declarations.md` | vault | pending | - |
| `docs/specs/20260709-worker_sandbox_freedom_policy.md` | sandbox | pending | - |
| `docs/specs/20260710-self_improvement_evaluation_loop.md` | knowledge | pending | - |
| `docs/specs/20260710-web_ui_rebuild_stack.md` | architecture | pending | - |
| `docs/specs/20260711-evaluation_harness_design.md` | process | pending | - |
| `docs/specs/20260711-scheduler_recurring_event_triggers.md` | runtime-model | held | - |
| `docs/specs/20260711-skill_catalog_versioning_pinning.md` | agent-supply | pending | - |
| `docs/specs/20260711-worker_runtime_subagent_provenance.md` | agent-session | pending | - |
| `docs/specs/20260713-work_resource_interaction_model.md` | work-model | held | - |
| `docs/specs/20260715-contract_stability_baseline.md` | contract-evolution | pending | - |
| `docs/specs/20260715-multi_user_workspace_system.md` | identity | pending | - |
| `docs/specs/20260715-openshell_disposable_cell_lifecycle.md` | runtime-model | held | - |
| `docs/specs/20260716-codex_worker_adapter.md` | architecture | pending | - |
| `docs/specs/20260716-opencode_worker_adapter.md` | architecture | pending | - |
| `docs/specs/20260716-pi_worker_adapter.md` | architecture | pending | - |
| `docs/specs/20260719-verification_calibration.md` | process | pending | - |
| `docs/specs/20260721-provider_subscription_accounts.md` | vault | pending | - |
| `docs/specs/20260721-worker_execution_environment_images.md` | sandbox | pending | - |
| `docs/specs/20260729-documentation_field_contract.md` | process | pending | - |
| `docs/specs/20260731-operational_telemetry_standardization.md` | evidence | held | - |
| `docs/specs/20260801-nanohost_workspace_data_boundary.md` | storage | held | - |
| `docs/specs/20260802-nanohost_runtime_and_transport.md` | runtime-model | held | - |
| `docs/specs/20260811-execution_residue_measurement.md` | process | pending | - |
| `docs/specs/20260813-internal_agent_runtime.md` | architecture | pending | - |
| `docs/specs/20260829-release_management.md` | process | pending | - |
| `docs/specs/20260831-unified_conversation_composer.md` | work-model | held | - |
| `docs/specs/20260902-agent_runtime_context_compaction.md` | work-model | held | - |
| `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md` | agent-supply | pending | - |
| `docs/specs/20260907-mcp_catalog_management.md` | agent-supply | pending | - |
| `docs/specs/20260908-generative_kernel_data_operations.md` | generative-apps | pending | - |
| `docs/specs/20260908-generative_ui_interaction.md` | generative-apps | pending | - |
| `docs/specs/20260909-deployment_host_requirements.md` | topology | pending | - |
| `docs/specs/20260909-internal_agent_resource_integration.md` | mediation | pending | - |
| `docs/specs/20260909-knowledge_notebook_editing.md` | knowledge | pending | - |
| `docs/specs/20260909-persistent_deployment_acceptance.md` | process | pending | - |
| `docs/specs/20260909-personal_memory_and_knowledge_learning.md` | knowledge | pending | - |
| `docs/specs/20260909-thread_visibility_and_sharing.md` | core-concepts | pending | - |
| `docs/specs/20260910-agent_operator_skill.md` | topology | pending | - |
| `docs/specs/20260910-app_update_delivery.md` | topology | pending | - |
| `docs/specs/20260910-persistent_worker_volumes.md` | sandbox | pending | - |
| `docs/specs/20260921-work_data_retention_format.md` | storage | held | - |
| `docs/specs/20260922-delegated_worker_policy_maintenance.md` | policy | pending | - |
| `docs/specs/20260930-deepseek_worker_adapter.md` | architecture | pending | - |
| `docs/specs/20260930-pending_requests.md` | protocol | pending | - |
| `docs/specs/20261002-goal.md` | work-model | held | - |
| `docs/specs/20261002-operation_definition.md` | mediation | pending | - |
| `docs/specs/20261002-remote_mcp_interface.md` | communication | pending | - |
| `docs/specs/20261012-product_integrity_check.md` | storage | held | - |
| `docs/specs/20261014-retrieval_kernel.md` | knowledge | pending | - |
| `docs/specs/20261017-evaluation_foundation.md` | work-model | held | - |
| `docs/specs/20261017-retained_format_register.md` | storage | held | - |
| `docs/specs/20261018-file_storage_and_knowledge_packages.md` | storage | held | - |
| `docs/specs/20261018-nanocore_interception_and_information_consolidation.md` | mediation | pending | - |
| `docs/specs/20261019-durable_execution_and_control_store.md` | storage | held | - |
| `docs/specs/20261020-compute_neutrality_target.md` | architecture | pending | - |
| `docs/specs/20261021-protocol_identifiers_and_enums.md` | protocol | pending | - |
| `docs/specs/README.md` | specs-index | pending | - |
| `docs/specs/AGENTS.md` | specs-index | pending (proposals only) | - |

## G1 Whole-System Findings

Phase 1 ran two methods over the whole system at the audit base. The top-down derivation mapped each capability of the product vision to its owners. The clean-room probe asked eight fresh inspectors to plan a rebuild of one module each from the documents alone. The [G1 probe record](20261023-independent_doc_audit_g1_probe.md) holds the method, the 296 probe findings, and the group that owns each one. Each finding stays an observation until the group record of its owner verifies it.

### Headline

A rebuild from the documents alone could not open or continue an existing data root. Two themes cause this. First, the SQLite schemas, the migration ledgers, and the field schemas of retained records exist only in code (theme T1). Second, the documents disagree about whether files or the control store hold the authority for Workspace, Thread, Turn, and Item records (theme T2). Both themes sit mainly in the storage group, which #440 holds. [The pre-stable data continuity decision](../decisions/20261014-pre_stable_data_continuity.md) starts the retained-data obligation at `v0.1.0`, so these gaps decide whether the released data can be read by a later rebuild. Question Q1 asks the engineer how to close T1.

### Top-Down Derivation

The auditor derived the capabilities that `docs/product-vision.md` requires and mapped each one to the Core document and specification that should own it. The table lists the result. "Owned" means that an accepted Core document and an accepted specification state the contract. "Partial" means that an owner exists but a part of the vision capability has no contract. "Gap" means that no accepted design owns the capability.

| Vision capability (section) | Core owner | Specification owner | Result |
| --- | --- | --- | --- |
| Agent-native operations: one semantic operation per capability, discoverable and invocable by agents (1) | `doctrine.md`, `mediation.md` | Operation Definition, Remote MCP Interface | Owned |
| `App + Core + Agent`, Core as the hub, heavy execution in agents (4.1–4.3) | `architecture.md` | Internal Agent Runtime, the four worker adapter specifications | Owned |
| Compute and agent-platform neutrality, with NanoHost as a peer of external platforms (4.4) | `architecture.md` | Compute Neutrality Target, which is a Draft | Partial: no accepted specification defines an external placement or harness adapter. [The neutrality decision](../decisions/20261020-compute_and_harness_neutrality.md) puts design and neutrality validation before the `v0.1.0` freeze and platform integrations after it, but the specification is still a Draft. |
| Conversation-first UI that shows ownership, progress, handoffs, artifacts, and intervention points (5.1, 5.2) | `work-model.md` (held) | Web Product Surface Projection, Human Attention Intervention Model (held), Unified Conversation Composer (held) | Owned; the work-model group is held |
| `Tauri` desktop app (1, 5) | none | Web UI Rebuild Stack defers all desktop work beyond `v0.1.0` | Gap by decision: [Discord First And Desktop Deferred](../decisions/20261015-discord_first_and_desktop_deferred.md) |
| Agent orchestration with dynamic selection of an `agent config pack` (6.1) | `work-model.md`, `agent-supply.md` | Workflow Coordinator, Agent Manifest And AEP Resolution | Partial: the vision term `agent config pack` has no mapping in the glossary or in Core. The Workflow Coordinator is deterministic, and dynamic planning is deferred work. |
| Multi-channel communication gateway: Discord, Signal, Slack, and others (6.2) | `communication.md` | Pending Requests, section External Attention And Discord Responses | Partial: Discord is the only admitted channel, and its adapter contract sits inside the Pending Requests specification. [The Discord decision](../decisions/20261015-discord_first_and_desktop_deferred.md) keeps Slack, Signal, and broader Email actions as separate later channel scope. |
| Quick answers and lightweight tasks in Core (6.3) | `work-model.md` (held), `architecture.md` | Chat Mode Assistant (held), Quick Chat Workspace (held) | Owned; held |
| Internal agents: Knowledge Manager, Task Evaluator, Workflow Coordinator (6.4) | `architecture.md`, `knowledge.md` | Knowledge Manager Internal Agent Runtime, Workflow Coordinator, Evaluation Harness Design (Draft), Evaluation Foundation (held) | Partial: the Task Evaluator is a reserved direction, and the Evaluation Harness Draft authorizes no harness. |
| Unified proxy: LLM provider proxy with fallback and load balancing, MCP proxy, third-party resource proxy, network proxy (6.5) | `mediation.md`, `sandbox.md` | LLM Gateway Responses API, Pi-ai Unified LLM Backend, Worker MCP Tool Supply, Worker Agent Capability, Worker Sandbox Freedom Policy | Partial: the Gateway specification excludes weighted or randomized balancing, and rate limits and budgets are stated only as a baseline direction in Worker Agent Capability. |
| Secret Vault with proxy-side injection (6.6) | `vault.md` | Vault Secret Injection, Vault Backend Implementation, Worker Credential Access Declarations | Owned |
| Knowledge Base and Notebook (6.7, 7) | `knowledge.md` | the Knowledge specifications, Retrieval Kernel, Personal Memory And Knowledge Learning | Owned |
| Generative Kernel and Generative UI, including scheduled agent tasks over Kernel data (6.8) | `generative-apps.md` | Generative Kernel Data And Operations, Generative UI Interaction, Scheduler Recurring Event Triggers (held) | Owned |
| Ownership-scoped, inspectable, portable storage without an external database (8) | `storage.md` (held) | the storage specifications (held) | Held |
| Minimal user management burden: NanoCore agents generate and update AEP and Policy, and select and maintain Worker Agents and sandbox images (9.1) | `architecture.md`, `policy.md` | Delegated Worker Policy Maintenance covers only non-secret sandbox and network configuration | Gap: roadmap outcomes R039 (OpenKit maintains Agent and Policy configuration) and R040 (OpenKit selects or builds a sandbox image) in Phase 4 have no accepted design owner |
| All-in-one Workspace that connects existing systems (9.2) | `core-concepts.md`, `architecture.md` | Workspace Data Source Catalog, MCP Catalog Management | Partial: no Core document owns the data-source concept, although `architecture.md` says that Storage owns data-source boundaries |
| Improve through work and optimize agents over time (9.3) | `knowledge.md`, `agent-supply.md` | Self-Improvement Evaluation Loop, Skill Catalog Versioning And Pinning, Evaluation Foundation (held) | Partial: roadmap outcome R080 in Phase 7 (exact configuration recorded for comparable work outcomes) has no single owner |
| Security by design at the Core and proxy layer (9.3) | `policy.md`, `vault.md`, `mediation.md`, `sandbox.md` | Policy and Vault specifications | Owned |

### Cross-Cutting Themes

Each theme collects probe findings that share one cause. The owning group fixes each finding, and the group record names the theme.

| Theme | Statement | Example findings | Owner |
| --- | --- | --- | --- |
| T1 | The SQLite schemas, the migration ledgers, and the field schemas of retained records exist only in code. The storage layout specification does not own the schema text. | M1-G02, M1-G15, M2-G02, M2-G03, M3-G01, M4-G02, M5-G03, M8-G08 | storage (held); Question Q1 |
| T2 | Record authority for Workspace, Thread, Turn, and Item records is files in some documents and the control store in others. The G3 inspection of the Thread visibility specification found Threads in the `control_threads` table. | M1-G01, M2-G01, M2-G25, M5-G01, M8-G27 | storage (held) |
| T3 | The operation inventory and the per-operation input and output schemas exist only in code or in the generated OpenAPI document. | M1-G11, M3-G16, M4-G15, M8-G03 | mediation, communication |
| T4 | Closed vocabularies are not enumerated, or their values are scattered across specifications. Examples are statuses, trigger sources, capability families, approval kinds, and error codes. | M1-G03, M1-G04, M1-G21, M3-G28, M4-G01, M4-G04, M4-G17, M8-G16 | protocol, and each vocabulary owner |
| T5 | A reader cannot tell whether a number is a format contract or a current default. [Documentation Writing](../writing.md) requires the distinction. | M2-G28, M3-G38, M5-G19, M6-G34, M7-G28, M8-G19 | each owning group |
| T6 | Status and target statements blur in normative text. A reader cannot tell what the release must build. | M3-G14, M3-G39, M4-G33, M4-G37, M5-G02, M8-G27 | each owning group |
| T7 | Authored configuration schemas are incomplete. Key names, defaults, and precedence are missing. | M3-G10, M4-G10, M4-G11, M6-G05, M6-G23, M7-G10, M8-G28, M8-G29 | identity, mediation |
| T8 | External formats carry retained or wire data without a pinned description in the repository. | M3-G36, M4-G35, M5-G24, M8-G22 | vault, mediation, sandbox, generative-apps |
| T9 | Paths and layouts contradict each other across specifications. | M2-G06, M3-G12, M5-G08, M5-G09, M5-G10 | sandbox, storage (held) |
| T10 | Normative text cites tracker labels, such as S12, R035, D04, and #133, without saying what they mean. | M7-G30 | each owning group |

## Statistics Per Goal

No group has been audited yet.

## Issues Opened

None yet.

## Decisions Awaiting Engineer Approval

None yet.

## Questions For The Engineer

### Q1: How should retained SQLite formats be documented?

- Context: theme T1. The retained-data obligation starts at `v0.1.0`. A rebuild must read the released data roots.
- Evidence: the storage layout specification says "Do not define table DDL in this spec." The retained format register names the table groups of each database but not their columns or constraints. The schema text exists only in the packaged migrations under `apps/nanocore/drizzle` (M2-G02, M3-G01, M5-G03, M8-G08).
- Options:
  - (a) Write the schemas by hand into the storage specifications.
  - (b) Generate a schema projection from the packaged migrations into `docs/`, with a drift check, under the owner of generated projections.
  - (c) Accept the code as the only schema record, and say so in the register.
- Recommendation: option (b). A generated projection keeps one fact in one place, because the migrations stay the source and the document follows them. Option (a) creates a second copy that drifts. Option (c) fails the rebuild test that [Documentation Writing](../writing.md) states.
- Meanwhile: the auditor changed no storage document. The storage group is held, and a generated projection needs an accepted owner.

### Q2: Should the Compute Neutrality Target be accepted before the `v0.1.0` freeze?

- Context: the top-down derivation, vision section 4.4.
- Evidence: [the neutrality decision](../decisions/20261020-compute_and_harness_neutrality.md) says that design and neutrality validation precede the `v0.1.0` freeze. The specification `docs/specs/20261020-compute_neutrality_target.md` has `status: Draft`.
- Options:
  - (a) Accept the specification before the freeze.
  - (b) Record that the freeze proceeds with the Draft, and amend the decision.
- Recommendation: option (a), or an explicit amendment. A freeze that silently drops a decided precondition leaves the decision and the release in conflict.
- Meanwhile: the auditor recorded the gap. The architecture group record checks the Draft for its own G2 and G5 findings.
