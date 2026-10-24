---
date: "2026-10-23"
---
# Independent Documentation Audit Before v0.1.0

This non-authorizing record summarizes the independent documentation audit that the engineer directed before the first OpenKit release, `v0.1.0`. It is an engineer-directed repository-integrity audit, so its owning rule is [Change Execution Governance](../change-execution.md). The audit follows the audit-record contract in [Documentation Model](../documentation-model.md#audit-records). It records observations, dispositions, open questions, and proposed decisions. It does not authorize design, and no correction in this branch takes effect until the engineer's review merges it.

## Method

- Audit base SHA: `996085376c65d973ce9e3c899779ba78d5297fec` (`main` on 2026-10-23).
- Readiness channel: GitHub issue #440. A held group is not audited.
- Roles: one primary context performs the Auditor function, which writes the findings and the dated records, and the Writer function, which writes the documentation corrections. Read-only inspector contexts collect G3 evidence. One fresh Reviewer context checks each group's diff.
- Goals: G1 product vision to design, G2 Core against specifications, G3 specifications against implementation, G4 specification organization, and G5 writing rules under [Documentation Writing](../writing.md).
- Branch: the session's designated branch is `audit/independent-docs-ag29v9`. The engineer's instruction named `audit/independent-docs-<yyyymmdd>`; the session harness fixed the branch name, so the date form was not used.

## Inventory At The Base SHA

`git ls-files` at the base SHA lists:

- `docs/core/`: 22 files, which are 20 aspect documents, `README.md`, and `AGENTS.md`.
- `docs/specs/` root: 101 dated specifications, `README.md`, and `AGENTS.md`.
- `docs/specs/retired/` and `docs/specs/superseded/`: 67 files for the archive check.
- Evidence only: 235 files under `docs/decisions/`, 176 files under `docs/changes/`, the files under `docs/audits/`, and the two OKF snapshots.

## Coverage Ledger

The ledger lists every Core document and every active specification with its home group and state. The home group is the Core document that owns the primary concept in the specification's `## Owns` section. A state is `open, pending` until its group record lands, then `audited` with a link to the group record. A held group keeps `held (#440)`.

### Core Documents

| Core document | Group | State | Group record |
| --- | --- | --- | --- |
| `docs/core/doctrine.md` | foundation | audited | [foundation](20261024-independent_doc_audit_foundation.md) |
| `docs/core/core-concepts.md` | foundation | audited | [foundation](20261024-independent_doc_audit_foundation.md) |
| `docs/core/README.md` | foundation | audited | [foundation](20261024-independent_doc_audit_foundation.md) |
| `docs/core/AGENTS.md` | foundation | audited | [foundation](20261024-independent_doc_audit_foundation.md) |
| `docs/core/contract-evolution.md` | contract-evolution | audited | [contract-evolution](20261024-independent_doc_audit_contract_evolution.md) |
| `docs/core/architecture.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/core/protocol.md` | protocol | audited | [protocol](20261024-independent_doc_audit_protocol.md) |
| `docs/core/communication.md` | communication | audited | [communication](20261024-independent_doc_audit_communication.md) |
| `docs/core/identity.md` | identity | audited | [identity](20261024-independent_doc_audit_identity.md) |
| `docs/core/policy.md` | policy | audited | [policy](20261024-independent_doc_audit_policy.md) |
| `docs/core/vault.md` | vault | audited | [vault](20261024-independent_doc_audit_vault.md) |
| `docs/core/mediation.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/core/agent-supply.md` | agent-supply | audited | [agent-supply](20261024-independent_doc_audit_agent_supply.md) |
| `docs/core/sandbox.md` | sandbox | open, pending | — |
| `docs/core/agent-session.md` | agent-session | open, pending | — |
| `docs/core/knowledge.md` | knowledge | open, pending | — |
| `docs/core/generative-apps.md` | generative-apps | open, pending | — |
| `docs/core/storage.md` | storage | held (#440) | — |
| `docs/core/runtime-model.md` | runtime-model | held (#440) | — |
| `docs/core/fault-tolerance.md` | fault-tolerance | held (#440) | — |
| `docs/core/evidence.md` | evidence | held (#440) | — |
| `docs/core/work-model.md` | work-model | held (#440) | — |

### Active Specifications

| Specification | Group | State | Group record |
| --- | --- | --- | --- |
| `docs/specs/20260709-quick_chat_workspace.md` | foundation | audited | [foundation](20261024-independent_doc_audit_foundation.md) |
| `docs/specs/20260711-scheduler_recurring_event_triggers.md` | foundation | audited | [foundation](20261024-independent_doc_audit_foundation.md) |
| `docs/specs/20260703-schema_evolution_record_envelope.md` | contract-evolution | audited | [contract-evolution](20261024-independent_doc_audit_contract_evolution.md) |
| `docs/specs/20260715-contract_stability_baseline.md` | contract-evolution | audited | [contract-evolution](20261024-independent_doc_audit_contract_evolution.md) |
| `docs/specs/20261017-retained_format_register.md` | contract-evolution | audited | [contract-evolution](20261024-independent_doc_audit_contract_evolution.md) |
| `docs/specs/20260522-vendor_snapshot_packages.md` | contract-evolution | audited | [contract-evolution](20261024-independent_doc_audit_contract_evolution.md) |
| `docs/specs/20261012-product_integrity_check.md` | contract-evolution | audited | [contract-evolution](20261024-independent_doc_audit_contract_evolution.md) |
| `docs/specs/20260813-internal_agent_runtime.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20260909-internal_agent_resource_integration.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20260704-workflow_coordinator_internal_agent.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20260704-nanocore_bootstrap_readiness.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20260708-container_image_packaging.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20260909-deployment_host_requirements.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20260910-app_update_delivery.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20260628-web_product_surface_projection.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20260710-web_ui_rebuild_stack.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20260910-agent_operator_skill.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20261020-compute_neutrality_target.md` | architecture | audited | [architecture](20261024-independent_doc_audit_architecture.md) |
| `docs/specs/20261021-protocol_identifiers_and_enums.md` | protocol | audited | [protocol](20261024-independent_doc_audit_protocol.md) |
| `docs/specs/20260704-app_api_openapi_projection.md` | protocol | audited | [protocol](20261024-independent_doc_audit_protocol.md) |
| `docs/specs/20260703-worker_control_protocol.md` | communication | audited | [communication](20261024-independent_doc_audit_communication.md) |
| `docs/specs/20261002-remote_mcp_interface.md` | communication | audited | [communication](20261024-independent_doc_audit_communication.md) |
| `docs/specs/20260528-core_client_boundary.md` | communication | audited | [communication](20261024-independent_doc_audit_communication.md) |
| `docs/specs/20260628-nanocore_config_identity_contract.md` | identity | audited | [identity](20261024-independent_doc_audit_identity.md) |
| `docs/specs/20260704-remote_auth_credential_bootstrap.md` | identity | audited | [identity](20261024-independent_doc_audit_identity.md) |
| `docs/specs/20260715-multi_user_workspace_system.md` | identity | audited | [identity](20261024-independent_doc_audit_identity.md) |
| `docs/specs/20260629-openkit_policy_model.md` | policy | audited | [policy](20261024-independent_doc_audit_policy.md) |
| `docs/specs/20260703-policy_enforcement_mapping.md` | policy | audited | [policy](20261024-independent_doc_audit_policy.md) |
| `docs/specs/20260909-thread_visibility_and_sharing.md` | policy | audited | [policy](20261024-independent_doc_audit_policy.md) |
| `docs/specs/20260930-pending_requests.md` | policy | audited | [policy](20261024-independent_doc_audit_policy.md) |
| `docs/specs/20260703-vault_secret_injection.md` | vault | audited | [vault](20261024-independent_doc_audit_vault.md) |
| `docs/specs/20260704-vault_backend_implementation.md` | vault | audited | [vault](20261024-independent_doc_audit_vault.md) |
| `docs/specs/20260709-worker_credential_access_declarations.md` | vault | audited | [vault](20261024-independent_doc_audit_vault.md) |
| `docs/specs/20260703-openshell_mechanism_internalization.md` | vault | audited | [vault](20261024-independent_doc_audit_vault.md) |
| `docs/specs/20261002-operation_definition.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/specs/20260703-worker_agent_capability.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/specs/20260704-capability_usage_gateway_foundation.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/specs/20260704-worker_mcp_tool_supply.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/specs/20260526-llm_gateway_responses_api.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/specs/20260703-pi_ai_provider_gateway_adoption.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/specs/20260708-pi_ai_unified_llm_backend.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/specs/20260721-provider_subscription_accounts.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/specs/20261018-nanocore_interception_and_information_consolidation.md` | mediation | audited | [mediation](20261024-independent_doc_audit_mediation.md) |
| `docs/specs/20260616-agent_environment_package.md` | agent-supply | audited | [agent-supply](20261024-independent_doc_audit_agent_supply.md) |
| `docs/specs/20260703-agent_manifest_aep_resolution.md` | agent-supply | audited | [agent-supply](20261024-independent_doc_audit_agent_supply.md) |
| `docs/specs/20260711-skill_catalog_versioning_pinning.md` | agent-supply | audited | [agent-supply](20261024-independent_doc_audit_agent_supply.md) |
| `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md` | agent-supply | audited | [agent-supply](20261024-independent_doc_audit_agent_supply.md) |
| `docs/specs/20260907-mcp_catalog_management.md` | agent-supply | audited | [agent-supply](20261024-independent_doc_audit_agent_supply.md) |
| `docs/specs/20260704-workspace_data_source_catalog.md` | agent-supply | audited | [agent-supply](20261024-independent_doc_audit_agent_supply.md) |
| `docs/specs/20260709-worker_sandbox_freedom_policy.md` | sandbox | open, pending | — |
| `docs/specs/20260715-openshell_disposable_cell_lifecycle.md` | sandbox | open, pending | — |
| `docs/specs/20260721-worker_execution_environment_images.md` | sandbox | open, pending | — |
| `docs/specs/20260910-persistent_worker_volumes.md` | sandbox | open, pending | — |
| `docs/specs/20260922-delegated_worker_policy_maintenance.md` | sandbox | open, pending | — |
| `docs/specs/20260703-workspace_synchronization.md` | sandbox | open, pending | — |
| `docs/specs/20260629-worker_runtime_communication_model.md` | sandbox | open, pending | — |
| `docs/specs/20260704-agent_session_continuity.md` | agent-session | open, pending | — |
| `docs/specs/20260704-session_static_workspace_materialization.md` | agent-session | open, pending | — |
| `docs/specs/20260716-codex_worker_adapter.md` | agent-session | open, pending | — |
| `docs/specs/20260716-opencode_worker_adapter.md` | agent-session | open, pending | — |
| `docs/specs/20260716-pi_worker_adapter.md` | agent-session | open, pending | — |
| `docs/specs/20260930-deepseek_worker_adapter.md` | agent-session | open, pending | — |
| `docs/specs/20260702-knowledge_store_governance_rules.md` | knowledge | open, pending | — |
| `docs/specs/20260703-knowledge_store_implementation.md` | knowledge | open, pending | — |
| `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` | knowledge | open, pending | — |
| `docs/specs/20260909-personal_memory_and_knowledge_learning.md` | knowledge | open, pending | — |
| `docs/specs/20260909-knowledge_notebook_editing.md` | knowledge | open, pending | — |
| `docs/specs/20261014-retrieval_kernel.md` | knowledge | open, pending | — |
| `docs/specs/20260703-worker_context_package.md` | knowledge | open, pending | — |
| `docs/specs/20260710-self_improvement_evaluation_loop.md` | knowledge | open, pending | — |
| `docs/specs/20260908-generative_kernel_data_operations.md` | generative-apps | open, pending | — |
| `docs/specs/20260908-generative_ui_interaction.md` | generative-apps | open, pending | — |
| `docs/specs/20260529-test_strategy.md` | process | open, pending | — |
| `docs/specs/20260529-l6_story_acceptance.md` | process | open, pending | — |
| `docs/specs/20260719-verification_calibration.md` | process | open, pending | — |
| `docs/specs/20260729-documentation_field_contract.md` | process | open, pending | — |
| `docs/specs/20260811-execution_residue_measurement.md` | process | open, pending | — |
| `docs/specs/20260829-release_management.md` | process | open, pending | — |
| `docs/specs/20260909-persistent_deployment_acceptance.md` | process | open, pending | — |
| `docs/specs/20260711-evaluation_harness_design.md` | process | open, pending | — |
| `docs/specs/20260703-storage_layout_record_ownership.md` | storage | held (#440) | — |
| `docs/specs/20261018-file_storage_and_knowledge_packages.md` | storage | held (#440) | — |
| `docs/specs/20260801-nanohost_workspace_data_boundary.md` | storage | held (#440) | — |
| `docs/specs/20260921-work_data_retention_format.md` | storage | held (#440, named) | — |
| `docs/specs/20260704-workspace_backup_export_import.md` | storage | held (#440, named) | — |
| `docs/specs/20260802-nanohost_runtime_and_transport.md` | runtime-model | held (#440) | — |
| `docs/specs/20260703-durable_scheduler_design.md` | runtime-model | held (#440) | — |
| `docs/specs/20260703-runtime_scheduling_scale.md` | runtime-model | held (#440, named) | — |
| `docs/specs/20260531-worker_turn_reliability_envelope.md` | runtime-model | held (#440) | — |
| `docs/specs/20260711-worker_runtime_subagent_provenance.md` | runtime-model | held (#440) | — |
| `docs/specs/20261019-durable_execution_and_control_store.md` | fault-tolerance | held (#440, named) | — |
| `docs/specs/20260703-audit_usage_evidence_records.md` | evidence | held (#440) | — |
| `docs/specs/20260731-operational_telemetry_standardization.md` | evidence | held (#440) | — |
| `docs/specs/20260704-chat_mode_assistant.md` | work-model | held (#440) | — |
| `docs/specs/20260704-task_mode_worker_delegation.md` | work-model | held (#440) | — |
| `docs/specs/20260531-human_attention_intervention_model.md` | work-model | held (#440) | — |
| `docs/specs/20260713-work_resource_interaction_model.md` | work-model | held (#440) | — |
| `docs/specs/20261017-evaluation_foundation.md` | work-model | held (#440) | — |
| `docs/specs/20261002-goal.md` | work-model | held (#440, named) | — |
| `docs/specs/20260902-agent_runtime_context_compaction.md` | work-model | held (#440) | — |
| `docs/specs/20260831-unified_conversation_composer.md` | work-model | held (#440) | — |

### Archive Check

The 67 files under `docs/specs/retired/` and `docs/specs/superseded/` receive the archive check only: lifecycle metadata, `current-guidance` targets, and inbound links. State: pending.

## Phase 0 Grouping

### Group Order

Open groups run first in dependency order, then the held groups after a release in #440, then the periphery group: foundation, contract-evolution, architecture, protocol, communication, identity, policy, vault, mediation, agent-supply, sandbox, agent-session, knowledge, generative-apps, process; held: storage, runtime-model, fault-tolerance, evidence, work-model; last: periphery.

The `process` group has no Core home. Its eight specifications own engineering, verification, release, and documentation methods, and `docs/core/` owns product semantics only. This is recorded as finding P0-G2-01 below.

### Code Map

| Group | Main implementation paths |
| --- | --- |
| foundation | `apps/nanocore/src/thread-*`, `apps/nanocore/src/turn-*`, `apps/nanocore/src/workspace-*`, `apps/nanocore/src/scheduler-records.ts`, `apps/nanocore/src/runtime/`, `packages/protocol` |
| contract-evolution | `packages/storage`, `packages/config-schema`, `packages/protocol`, `packages/codex-app-server-schema`, `packages/models-dev-catalog`, `apps/nanocore/src/storage/` |
| architecture | `apps/nanocore/src/internal-agents/`, `apps/nanocore/src/bootstrap/`, `apps/nanocore/src/app-update/`, `apps/nanocore/src/docker/`, `apps/web/`, `skills/openkit-ops/`, `docker/`, `.github/workflows/` |
| protocol | `packages/protocol`, `packages/app-api-schemas`, `apps/nanocore/src/openapi*.ts` |
| communication | `packages/worker-protocol`, `packages/worker-shim`, `packages/core-client`, `apps/nanocore/src/remote-mcp-routes.ts`, `apps/nanocore/src/runtime/` |
| identity | `apps/nanocore/src/auth/`, `apps/nanocore/src/config/`, `apps/nanocore/src/workspace-membership.ts`, `apps/nanocore/src/workspace-sharing*.ts`, `packages/config-schema` |
| policy | `packages/policy-kernel`, `apps/nanocore/src/policy/`, `apps/nanocore/src/pending-request-operations.ts`, `apps/nanocore/src/thread-read-state.ts` |
| vault | `apps/nanocore/src/vault/`, `apps/nanocore/src/vault-injection-*.ts`, `apps/nanohost/src/credential_slots.rs`, `apps/nanohost/src/openshell_policy.rs` |
| mediation | `apps/nanocore/src/operation-*.ts`, `apps/nanocore/src/capability/`, `apps/nanocore/src/llm/`, `apps/nanocore/src/providers/`, `apps/nanocore/src/worker-mcp-routes.ts` |
| agent-supply | `apps/nanocore/src/agents/`, `apps/nanocore/src/catalog/`, `apps/nanocore/src/context/`, `packages/config-schema` |
| sandbox | `apps/nanohost/`, `apps/nanocore/src/worker-environments/`, `apps/nanocore/src/runtime/`, `packages/worker-shim` |
| agent-session | `apps/nanocore/src/runtime/`, `packages/worker-shim`, `packages/pi-runtime-host`, `packages/codex-app-server-schema` |
| knowledge | `apps/nanocore/src/knowledge/`, `apps/nanocore/src/knowledge-*.ts`, `apps/nanocore/src/memory-operations.ts`, `apps/nanocore/src/retrieval-*.ts`, `packages/retrieval-kernel`, `apps/nanocore/src/context/` |
| generative-apps | `apps/nanocore/src/generative-kernel/`, `apps/nanocore/src/generative-ui/`, `apps/web/src/generative/` |
| process | `tests/`, `stories/`, `scripts/`, `.github/workflows/` |

Inspectors locate exact files at each group base SHA; the map above is a starting point, not a claim of completeness.

### Specifications With No Clear Or With Two Equal Homes

Each row is finding P0-G4-NN. The chosen home decides only the audit group; it changes no document.

| ID | Specification | Candidate homes | Chosen home and reason |
| --- | --- | --- | --- |
| P0-G4-01 | `20260930-pending_requests.md` | `core-concepts.md` (`ApprovalRequest`), `policy.md` (approval gates), `work-model.md` (Human Attention Gate) | policy: it cites Policy eight times and owns approval execution authority. |
| P0-G4-02 | `20260909-thread_visibility_and_sharing.md` | `core-concepts.md` (Thread visibility), `policy.md` (disclosure authorization) | policy: the owned decisions are disclosure and eligibility. |
| P0-G4-03 | `20260629-worker_runtime_communication_model.md` | `sandbox.md`, `communication.md`, `runtime-model.md` | sandbox: it owns the Sandbox Integration boundary and cites Sandbox five times. |
| P0-G4-04 | `20260703-openshell_mechanism_internalization.md` | `vault.md`, `policy.md` | vault: credential injection is the first owned mechanism. |
| P0-G4-05 | `20260704-chat_mode_assistant.md` | `work-model.md` (Chat Mode), `architecture.md` (Core Assistant) | work-model (held): the first owned item is Chat Mode. |
| P0-G4-06 | `20260703-worker_context_package.md` | `knowledge.md` (Context Package), `mediation.md` | knowledge: Context Package is a Knowledge term. |
| P0-G4-07 | `20260704-workspace_data_source_catalog.md` | `agent-supply.md`, `storage.md` | agent-supply: manifests reference the catalog by name. |
| P0-G4-08 | `20260711-worker_runtime_subagent_provenance.md` | `runtime-model.md`, `evidence.md` | runtime-model (held): the owned boundary is one worker execution. |
| P0-G4-09 | `20260703-workspace_synchronization.md` | `sandbox.md`, `storage.md` | sandbox: `sandbox.md` names workspace synchronization. |
| P0-G4-10 | `20260704-capability_usage_gateway_foundation.md` | `mediation.md` (`CapabilityCall`), `evidence.md` (usage) | mediation: the shared ledger serves `CapabilityCall` producers. |
| P0-G4-11 | `20260715-multi_user_workspace_system.md` | `identity.md`, `policy.md` | identity: membership and invitation are Identity terms. |
| P0-G4-12 | `20260721-provider_subscription_accounts.md` | `mediation.md`, `vault.md` | mediation: the binding is a Gateway route decision. |
| P0-G4-13 | `20260711-scheduler_recurring_event_triggers.md` | `core-concepts.md` (`TriggerSource`), `runtime-model.md` | foundation: the schedules are trigger sources of Turn admission. |
| P0-G4-14 | `20260831-unified_conversation_composer.md` | `work-model.md`, `communication.md` | work-model (held): the targets are product work modes. |
| P0-G4-15 | `20261020-compute_neutrality_target.md` | `architecture.md`, `sandbox.md` | architecture: `architecture.md` owns Compute And Harness Neutrality. |

### Phase 0 Finding

- P0-G2-01 (G2/G4, no action yet): eight active `process` specifications have no Core home: test strategy, L6 story acceptance, verification calibration, documentation field contract, execution residue measurement, release management, persistent deployment acceptance, and evaluation harness design. Core owns product semantics, so the missing home is expected. The finding is that no governance document indexes these method owners as one family. Disposition is decided in the process group.

## G1 Whole-System Findings

### Method

- Top-down derivation: each capability that [Product Vision](../product-vision.md) requires was mapped to the Core document and the specification that should own it. The derivation used `git grep` over `docs/core/` and the active specifications at the base SHA.
- Clean-room probe: `git archive 996085376c65d973ce9e3c899779ba78d5297fec docs AGENTS.md` was extracted into an empty directory outside the repository. Eight fresh read-only inspector contexts, one per module, received only that directory and a written brief: domain and protocol, identity and Policy, Vault and mediation, worker execution, storage and recovery, knowledge, the work model, and generative and deployment surfaces. Each wrote an implementation plan and a gap list. The brief and raw outputs stay uncommitted under the audit's temporary working space.
- The probe produced 237 candidate gaps: 149 guesses, 47 contradictions, 17 dangling references, and 24 code dependences. A candidate is not reported as a fact until the group that owns it verifies it against the documents at the group base SHA. Each group record lists the candidates it verified and their dispositions.

### Top-Down Derivation

| ID | Vision capability | Finding | Owning group |
| --- | --- | --- | --- |
| G1-TD-01 | Multi-channel communication gateway (Product Vision 6.2: Discord, Signal, Slack) | `docs/core/communication.md` names Discord as the first external team channel and refers to a "common channel contract". No active specification owns that common channel contract. The Discord binding, pairing, and response rules live in a section of `20260930-pending_requests.md`. Signal and Slack have no owner and no recorded deferral. | communication |
| G1-TD-02 | Dynamic orchestration through an `agent config pack` (Product Vision 6.1) | No Core document or specification uses the term or states that the direction is deferred. Workflow Coordinator owns worker selection only. | architecture |
| G1-TD-03 | Compute and agent-platform neutrality, external platforms as peers, and return of user data (Product Vision 4.4) | `docs/core/architecture.md` states the doctrine. The only specification is `20261020-compute_neutrality_target.md` (`Draft`, `Not Started`). No accepted document defines the capability declaration that Policy uses to refuse a placement, or the data-return contract. | architecture |
| G1-TD-04 | Unified proxy with LLM fallback, load balancing, and rate limiting (Product Vision 6.5) | The LLM Gateway owns ordered failover. No owner decides load balancing; `20260721-provider_subscription_accounts.md` excludes an account load balancer. `docs/core/mediation.md` lets early implementations omit rate-limit controls. | mediation |
| G1-TD-05 | Minimum management and configuration burden: the NanoCore built-in agent generates and updates AEP and Policy, selects and maintains Worker Agent and sandbox image, and monitors work in the middle (Product Vision 9.1) | Only `20260922-delegated_worker_policy_maintenance.md` covers a bounded class of worker sandbox and network configuration. No Core document or specification owns AEP generation, Worker Agent or image selection and maintenance by an internal agent, or in-the-middle monitoring. | architecture |
| G1-TD-06 | Task Evaluator internal agent (Product Vision 6.4) | `docs/core/architecture.md` reserves the role. No action: the reservation is explicit. | architecture |
| G1-TD-07 | Tauri desktop packaging (Product Vision 1) | Deferred beyond `v0.1.0` by an engineer decision that `20260710-web_ui_rebuild_stack.md` cites. No action. | architecture |

### Clean-Room Probe Themes

| Theme | Candidate examples | Owning groups |
| --- | --- | --- |
| G1-CR-T1. Retained and wire shapes are defined by code, not by documents. Field sets of Workspace, Thread, Turn, Item, `CapabilityCall`, `UsageRecord`, Vault records, Policy statements, SQLite tables, and migrations are owned by schema packages, source files, and migration journals. | DOMAIN-02, DOMAIN-13, DOMAIN-14, AUTHZ-04, AUTHZ-20, MEDIATION-05, MEDIATION-10, MEDIATION-11, STORAGE-03, STORAGE-04 | protocol, contract-evolution, every held storage group; question Q-01 |
| G1-CR-T2. Closed enumerations are named but not listed: Workspace, Thread, and Item status, `TriggerSource` values, `stopReason`, and the mapping from error code to HTTP status. | DOMAIN-01, DOMAIN-04, DOMAIN-09, DOMAIN-12, MEDIATION-13 | protocol, foundation, mediation |
| G1-CR-T3. Contradictions between a Core document and a specification, between two specifications, or inside one specification. | DOMAIN-07, DOMAIN-15, AUTHZ-01, AUTHZ-05, AUTHZ-08, AUTHZ-14, AUTHZ-27, MEDIATION-08, MEDIATION-09, STORAGE-01, STORAGE-02 | the group of each cited owner |
| G1-CR-T4. A specification interleaves its target contract and its current implementation, so a rebuilder cannot tell which behavior conforms. | DOMAIN-07, MEDIATION-19, MEDIATION-22 | mediation, vault, communication |
| G1-CR-T5. An external library defines observable behavior or retained bytes, so a rebuild in another stack cannot reproduce it: pi-ai provider transport and credential serialization, Better Auth credentials and sessions. | MEDIATION-16, MEDIATION-17, AUTHZ-10 | mediation, identity; question Q-02 |
| G1-CR-T6. Experience-chosen numbers, such as retry delays, idle bounds, and grace periods, are not stated. | MEDIATION-03, MEDIATION-14, MEDIATION-18, AUTHZ-07 | No action unless a number defines a wire or retained format: [Documentation Writing](../writing.md#normative-text) makes such numbers current defaults. |

Raw candidate counts per module: domain 20, identity and Policy 34, Vault and mediation 27, worker execution 29, storage and recovery 27, knowledge 33, work model 32, surfaces 35.

## Statistics Per Goal

Filled at close-out.

## Issues Opened

| Issue | Group | Finding | Severity hint |
| --- | --- | --- | --- |
| #454 `[workspace-sharing] Personal Workspace share refusal emits a code outside the published error enum` | foundation | FND-PW-01 | ordinary |
| #455 `[dashboard] Default Agent projection skips the User preference` | foundation | FND-CC-01 | ordinary |
| #456 `[recurring-schedules] A very large fixed interval can stop every recurring scan` | foundation | FND-RT-04 | blocking candidate (recovery) |
| #457 `[record-envelope] Envelope readers skip schemaVersion, minCoreVersion and Gateway requiredFeatures checks` | contract-evolution | CE-ENV-01, 02, 03, 05 | blocking candidate (retained data) |
| #458 `[record-envelope] Required feature recurring-history-v1 does not use the registered identifier form` | contract-evolution | CE-ENV-REG | blocking candidate (retained data) |
| #460 `[bootstrap] Signal handlers register after boot, and readiness does not derive vault, LLM gateway or knowledge index state` | architecture | AR-WFB-06, 07, 08 | blocking candidate (recovery) for the signal handlers |
| #461 `[app-update] Status for a missing update ID returns app_update_unavailable instead of recovery_required` | architecture | AR-DEP-01 | blocking candidate (recovery) |
| #462 `[internal-agent] A Tool result sanitizer exception becomes a correctable Tool error instead of a failed exit` | architecture | AR-IAR-02 | ordinary |
| #463 `[nanohost] Harness-control routes forward client binding headers when the path has a query string` | communication | CM-WCP-03 | blocking candidate (authorization) |
| #464 `[worker-control] Artifact notice, heartbeat persistence and final status differ from the specification` | communication | CM-WCP-01, 02, 10 | ordinary |
| #465 `[core-client] Remove unused hand-maintained transport helpers after the definition-table cutover` | communication | CM-CCB-05 | low |
| #466 `[auth] Plaintext transport gate trusts the TCP peer, so the bundled App image accepts bearer tokens over public plaintext HTTP` | identity | ID-RA-01 | blocking candidate (credentials) |
| #467 `[config] Local mode accepts a non-loopback bind host and then grants every caller local administrator authority` | identity | ID-CFG-01 | blocking candidate (authorization) |
| #468 `[auth] Bootstrap notice omits that the credential cannot be recovered, and the token file stays after consumption` | identity | ID-RA-07 | low |
| #469 `[workspace-sharing] Access-change residue remains after the equal-member cutover, and the Workspace summary is not closed` | identity | ID-MU-06, 07 | low |
| #470 `[config] knowledgeMaintenance parsing strips unknown keys although the contract gives it a strict shape` | identity | ID-CFG-05 | ordinary |
| #471 `[thread] Thread records never emit the thread-entry and thread-visibility required features` | policy | PO-TVS-01 | blocking candidate (retained data) |
| #472 `[discord] A paired Discord account gains administrator eligibility from an owned server-admin Token` | policy | PO-PR-04 | blocking candidate (authorization) |
| #473 `[pending-requests] A repeated command-intent approval with a new request id is not deduplicated` | policy | PO-PR-01 | ordinary |
| #474 `[vault] Worker MCP Gateway releases Vault material after a tool.use check, without the vault.use current-authority predicate` | vault | VA-SI-01 | blocking candidate (credentials) |
| #475 `[vault] Worker credential declarations resolve secret material before the backend visibility check and before later declarations are validated` | vault | VA-CAD-01, 04 | blocking candidate (credentials) |
| #476 `[vault] Credential revocation does not interrupt the resident binding or terminate the affected sandbox` | vault | VA-CAD-03, VA-SI-04, VA-VB-05 | blocking candidate (credentials) |
| #477 `[vault] Credential declaration failures use free text instead of the stable error codes` | vault | VA-CAD-02 | ordinary |
| #478 `[vault] Administrator MCP discovery preview checks grant provenance by id prefix, not by the issuance field` | vault | VA-SI-02 | low |
| #479 `[vault] Restart re-resolution of collection runtime-env values reads the raw backend and writes no VaultUse` | vault | VA-VB-01, VA-SI-05 | ordinary |
| #480 `[vault] Persistent Worker images refuse every runtime-file credential, so runtime-file visibility cannot launch` | vault | VA-SI-08, VA-CAD-06 | ordinary |
| #481 `[mcp] A Workspace-origin captured call skips the catalog digest and credential recheck before dispatch` | mediation | MD-MCP-05 | blocking candidate (credentials) |
| #482 `[providers] Account status never returns unavailable, so a locked Vault makes the status read fail with 503` | mediation | MD-PSA-01 | ordinary |
| #483 `[mcp] An oversized tools/list fails with mcp-server-unavailable instead of mcp-result-too-large` | mediation | MD-MCP-03 | low |
| #484 `[gateway] Prompt cache scope lets caller metadata override the trusted caller scope` | mediation | MD-LLM-04 | low |
| #486 `[catalog] Agent Plugin import merges a name-derived id collision into an existing entry and records no source provenance` | agent-supply | AS-PLG-03, 04, 06 | blocking candidate (retained data) |
| #487 `[catalog] Agent Plugin management has only list and import, and authored setup does not expand an installation` | agent-supply | AS-PLG-01, 02, 05 | enhancement |
| #488 `[mcp] Plugin MCP import treats SSE as Streamable HTTP, skips the format version, and does not contain an explicit stdio cwd` | agent-supply | AS-MCC-05, 06 | ordinary |
| #489 `[mcp] Workspace MCP management has no stage-version or remove, and selection names no expected current digest` | agent-supply | AS-MCC-02, 03, 07 | ordinary |
| #490 `[mcp] Plugin MCP package data key derives from the entry id, so installations do not get their own key` | agent-supply | AS-MCC-04 | ordinary |
| #491 `[aep] Build egress host accepts URL, path, and port forms at package resolution` | agent-supply | AS-MAR-02 | ordinary |
| #492 `[catalog] Skill directory walk rejects a directory at depth 32 although 32 levels are allowed` | agent-supply | AS-SKL-05 | low |

## Decisions Awaiting Engineer Approval

None yet.

## Questions For The Engineer

Each question states the context and evidence, the options, the recommendation with its first-principles reason, and what the audit did meanwhile.

### Q-01. Does the rebuild test read schema packages and conformance fixtures as part of the documents?

- Context: [Documentation Writing](../writing.md) and [Engineering Doctrine](../engineering-doctrine.md) make the documents the source of truth and test them by a rebuild from the documents alone. The doctrine also says that boundary conformance tests are part of the executable specification. `20260704-app_api_openapi_projection.md` makes the shared schema packages the single App API contract source, and `20261017-retained_format_register.md` names source readers and fixtures for retained formats. The clean-room probe could not recover field sets, SQLite tables, or migrations from `docs/` (theme G1-CR-T1).
- Options: (A) The rebuild corpus includes the machine-readable schema packages, conformance fixtures, and migration files, and the documentation model says so. (B) Specifications state every retained and wire field in prose. (C) Durable retained formats get a generated, committed reference projection under the Generated Projections type, while release-coupled wire shapes stay in the schema packages under option A.
- Recommendation: C. Retained data carries the only compatibility obligation (NONNEG-001), so its format must survive a rebuild in another stack. A generated projection keeps one fact in one place and cannot drift, and prose copies of schemas would violate One Fact, One Place.
- Meanwhile: no document was changed for this theme. Group records cite the affected candidates.

### Q-02. How are retained bytes that an external library defines governed?

- Context: Better Auth owns password credentials and sessions (`20260628-nanocore_config_identity_contract.md`), and pi-ai owns the subscription credential serialization stored in the Vault (`20260721-provider_subscription_accounts.md`). A rebuild in another stack cannot open those retained records (theme G1-CR-T5).
- Options: (A) Record each such format in the retained format register as externally owned, with its pinned dependency version and the continuity rule that applies to it. (B) Specify the bytes in OpenKit documents. (C) Accept that a rebuild resets these records.
- Recommendation: A. It states the obligation where retained formats are already inventoried, and it does not copy a third-party format into prose.
- Meanwhile: no change.

### Questions Recorded In Group Records

Each group record states the full context, options, recommendation, and interim action.

| Question | Group | Subject | Recommendation |
| --- | --- | --- | --- |
| Q-03 | foundation | Keep the Quick Chat file name of the personal Workspace specification | Keep the path |
| Q-04 | foundation | Drop the Quick Chat name from code and identifier derivation input | Rename code symbols only |
| Q-05 | foundation | Must the origin-Thread handoff Item reference the receiving Thread | Add the reference to the Item |
| Q-06 | foundation | Do stale pending expiries share the expired-range write bound | Read the bound per phase and say so |
| Q-07 | foundation | Does the "Migration preserves" acceptance bullet still apply | Replace its first clause |
| Q-08 | foundation | A past audit record contains a local absolute path | Approve a one-time redaction |
| Q-09 | contract-evolution | Is the Pi coding agent patch an accepted exception to the no-patch rule | Record a bounded exception, then remove the patch upstream |
| Q-10 | contract-evolution | Snapshot evidence for registry and rolling-API sources | Name three source kinds and their identities |
| Q-11 | contract-evolution | Does the snapshot contract cover the Retrieval Kernel dictionary archive | State that build-supply archives are outside it |
| Q-12 | contract-evolution | Re-derive the Terminal Turn Consistency read design against the control store | Re-derive it when the operation is implemented |
| Q-13 | contract-evolution | Mechanism for the release-coupled contract identity gate | State the protocol version, doctor check and strict parsing |
| Q-14 | contract-evolution | Narrow the L0 testing statement of the stability baseline | Narrow it to the frontmatter check |
| Q-15 | contract-evolution | Casing of required features in Knowledge frontmatter | Add a named exception |
| Q-16 | contract-evolution | When to re-baseline the retained format register against the control store | With the held control-store specification |
| Q-17 | architecture | Keep the ten-kind Coordinator classification contract | Narrow it to explicit entry with the work-model release |
| Q-18 | architecture | Drop planning and stopping from the Coordinator row in Core Architecture | Drop them after the Goal release |
| Q-19 | architecture | Limits for a profile-less Knowledge Manager or Goal Coordinator run | Use the schema default for every role |
| Q-20 | architecture | A maximum for `deadlineMs` | Add a schema maximum at the Node timer limit |
| Q-21 | architecture | Does worker selection consume a runtime label | Remove it with the Goal release |
| Q-22 | architecture | Name of Workspace quarantine | Name the error and reason codes with the fault-tolerance release |
| Q-23 | architecture | Marking of experience-chosen numbers | Engineer states each property; mark as current defaults |
| Q-24 | architecture | Default Core mode of a formal release App image | Change the image default to `server` |
| Q-25 | architecture | Does the model-delivery refusal cover `app-update.preflight` | State that preflight is allowed |
| Q-26 | architecture | May Vault screens show an AgentSession id | Vault owner defines a user-facing grant target |
| Q-27 | architecture | The virtualization MUST | Replace with a measured-need rule |
| Q-28 | architecture | Undefined plan labels | Link or replace each label |
| Q-29 | protocol | `context-injection` or `knowledge-injection` | Change the documents to the retained `knowledge-injection` |
| Q-30 | protocol | List `generative-ui-reference` and `context-summary` in the item-to-delta table | Add both rows |
| Q-31 | protocol | What the error-code namespace rule requires | Allow flat Core command codes |
| Q-32 | protocol | List the remaining closed enums in the identifiers specification | Add the five lists with Q-01 |
| Q-33 | protocol | Owner of cross-event delta correlation | State a producer obligation proved by fixtures |
| Q-34 | protocol | Closed OpenAPI exclusion list versus the coverage test | Add the three surfaces, drop test-support |
| Q-35 | protocol | Actor allowed to read `/api/openapi.json` | State "authenticated" |
| Q-36 | protocol | NanoCore reads the generated document for route identity | Derive from the catalog and definitions |
| Q-37 | protocol | Property protected by the seven-day receipt expiry | Engineer states it; mark as current default |
| Q-38 | communication | Structured credential reference in the remote MCP audit | Set `authentication` from the Token actor |
| Q-39 | communication | Queued valid events when a stream envelope fails validation | Deliver them before the error |
| Q-40 | communication | Inputs of the Harness `operationId` | Amend the wording to the Harness binding ref |
| Q-41 | communication | Active Turns per Harness | State the per-AgentSession rule and `maxActiveTurns`, with the scheduling release |
| Q-42 | communication | Which verification failures store quarantined evidence | Only authenticated, lineage-bearing rejections |
| Q-43 | communication | The 1000 ms poll maximum under the serial loop | Add a priority path for `turn.interrupt` |
| Q-44 | communication | Marking of worker-control timing numbers | As Q-23 |
| Q-45 | communication | Worker-control labels S61, A1, #179 ruling | As Q-28 |
| Q-46 | communication | Remote MCP exclusion list | State the non-JSON binding rule |
| Q-47 | identity | May an administrator accept or decline another user's invitation | Limit it to the administrator's own invitations |
| Q-48 | identity | Pending invitations after the inviter loses membership | Revoke them |
| Q-49 | identity | Sign-up before bootstrap completes (high priority) | Refuse sign-up while no `server-admin` Token exists |
| Q-50 | identity | Declared fronting proxy (CFG and RA conflict) | Add one explicit TLS-proxy declaration and amend CFG |
| Q-51 | identity | `knowledgeMaintenance.schedule` member | Name `schedule` in the specification |
| Q-52 | identity | Fields of the Server configuration file | State a reference rule and list `user.jsonc` |
| Q-53 | identity | `BETTER_AUTH_TRUSTED_ORIGINS` override | Remove the override |
| Q-54 | identity | Token expiry bound and rate limits | Add a maximum lifetime and state the rate limit |
| Q-55 | identity | Synchronous last-used update | Amend the Risks text |
| Q-56 | identity | Recovery request id source | State the path derivation |
| Q-57 | identity | Private-Thread administrator gap and MU line 656 | Open a low issue |
| Q-58 | identity | Identity numbers and labels | As Q-23 and Q-28 |
| Q-59 | identity | "Roles" in Identity Core | Replace with policy attributes |
| Q-60 | policy | Kernel trace names for a missing grant and a prohibition | Name the Kernel codes; keep the product reasons |
| Q-61 | policy | Goal-domain activation and Task join status (PM and PEM conflict) | Amend PM to the PEM status when the Goal group is released |
| Q-62 | policy | Did the three new Policy families land with their consumers | Restate in the present tense and name active consumers |
| Q-63 | policy | `knowledge-manager` as a `Thread.entryPath` value | Add the value to TVS |
| Q-64 | policy | Interim contract for an explicit `workspace` conversation Thread | Formal work only; refuse in a personal Workspace |
| Q-65 | policy | Outcome Turn trigger actor for a withdrawal, and "first" | Ending actor; readiness order |
| Q-66 | policy | Policy-grant actor clause | Mark as retained-read validation |
| Q-67 | policy | Target id and `turnId` fields of response commands | Name them in Resolve |
| Q-68 | policy | Order of authority, state, and shape checks | Authority, state, shape |
| Q-69 | policy | Unreadable request rows in Thread lists | Count against the bound; refuse archive with `recovery_required` |
| Q-70 | policy | Agent-principal status sentence in Core Doctrine | Move the status to the specifications |
| Q-71 | policy | Policy numbers and labels | As Q-23 and Q-28 |
| Q-72 | policy | Local-mode Discord administrator eligibility | Treat channel input as an ordinary actor in both modes |
| Q-73 | vault | Grant validation in the audited Vault wrapper | Remove the any-`grantId` exception |
| Q-74 | vault | Whole-store decryption on each audited resolve | Read only the addressed reference |
| Q-75 | vault | Grant for server-owned provider credentials | State the server-owned provider exception |
| Q-76 | vault | Decision lineage for administrator-issued grants | Record a `PermissionDecision` for worker-visible grants |
| Q-77 | vault | Destruction trigger for expired prior versions | Destroy at the next rotation or inventory pass |
| Q-78 | vault | Same-PID temporary file blocks revoke (high priority) | Random temporary suffix; revoke destroys writer temporaries |
| Q-79 | vault | Master key in the unlock request and empty-store initialization | Same key; initialize only from the key file |
| Q-80 | vault | Duplicate endpoint names and raw host in NanoHost policy | Reject duplicates; render the canonical host |
| Q-81 | vault | Revocation-driven sandbox termination current or deferred | Keep the MUST; state the gap until #476 lands |
| Q-82 | vault | Backend and file inventories in Core Vault and projections | Move the backend sentence to VB; name owners |
| Q-83 | vault | Per-Turn or session-static runtime material | Amend SI to session-static |
| Q-84 | vault | Vault labels, history, and example ids | As Q-28; use a canonical grant id |
| Q-85 | mediation | Ownership of capability rate limits and budgets | Mediation owns the enforcement point; a named owner owns limit values |
| Q-86 | mediation | Three-way ownership of the Operation definition | State the Core, OD, and Policy Enforcement split in each |
| Q-87 | mediation | Boot self-check row I36 marked for later routing | Mark I36 Kernel-only |
| Q-88 | mediation | Revoked actor call record: CUG versus Pending Requests | Add the after-claim record to CUG |
| Q-89 | mediation | `schemaSnapshotId` as a replay attribution field | Add it to CUG and fix list-tools replay |
| Q-90 | mediation | Null actor accepted by the shared recorder | Fail closed in the recorder |
| Q-91 | mediation | No CapabilityCall for a repeated pending call | Record one denied, no-contact call |
| Q-92 | mediation | Worker-visible capability error vocabulary | Document the MCP set; fold Policy-origin codes into `mcp-denied` |
| Q-93 | mediation | `stdio` teardown on revocation | Add a revocation hook |
| Q-94 | mediation | Discovery contact and usage | Only `tools/call` contact counts |
| Q-95 | mediation | Remote MCP refusal codes and call annotations | Name the codes and the worst-case annotation rule |
| Q-96 | mediation | Descriptor credential procedures and table facts | Update the OD lists |
| Q-97 | mediation | Goal checks in common admission | Move them behind a Goal-owned strategy |
| Q-98 | mediation | Header-carried request identity rule | State it once in OD |
| Q-99 | mediation | Unmigrated operations and OD `Partial` | Remove the sentence after a route check; list open work |
| Q-100 | mediation | Unconditional Work supply of `automation.event-admit` | Supply it only to the scheduled-poll Worker |
| Q-101 | mediation | `work_artifact_submit` media-type refusal | Remove it from WAC |
| Q-102 | mediation | Inactive advise and transform dispatch code | Remove until an owner exists |
| Q-103 | mediation | Pi runtime host pi-ai dependency | State it is outside PIA |
| Q-104 | mediation | Unhashed explicit prompt cache keys | Hash with provider and slot |
| Q-105 | mediation | Unknown provider model metadata fields | Ignore with a diagnostic, per COMPAT-001 |
| Q-106 | mediation | Startup reconciliation of subscription accounts | Reword to read-time reconciliation |
| Q-107 | mediation | Quota `label` and `activeUntil` fields | Remove both |
| Q-108 | mediation | Account-directory residue recovery | Clean own create residue; state the cleanup gate |
| Q-109 | mediation | Audited reconcile on each Codex attempt | Read the setting without reconcile |
| Q-110 | mediation | Create slot-id error code | Move the check to the owner |
| Q-111 | mediation | Mediation labels, numbers, and OD paragraph length | As Q-28; split OD line 306 after Q-99 |
| Q-112 | mediation | Knowledge package transfer channel | Administrator CLI in the Knowledge package owner |
| Q-113 | agent-supply | Product-visible readiness vocabulary | MAR states the Core vocabulary; `stale` goes to the protocol summary |
| Q-114 | agent-supply | Direct-Provider route arms in the package schema | Remove them |
| Q-115 | agent-supply | Stale Provider references in MAR | Gateway endpoint bullet; drop `providers` |
| Q-116 | agent-supply | Withdrawn after review (decided by SKL; issue #492) | — |
| Q-117 | agent-supply | Skill conflict outcome and expected digest | The diagnostic is `conflict`; field mandatory |
| Q-118 | agent-supply | Withdrawn after review (decided by PLG and MCC; issue #487) | — |
| Q-119 | agent-supply | HTTPS-only Git data sources | State HTTPS and the key set |
| Q-120 | agent-supply | Source-id lineage on capability rows | Applies to future source-aware producers |
| Q-121 | agent-supply | Agent-supply history, status, numbers, time-relative text | As Q-28 |
