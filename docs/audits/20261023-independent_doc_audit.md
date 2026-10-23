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
| `docs/core/doctrine.md` | foundation | open, pending | — |
| `docs/core/core-concepts.md` | foundation | open, pending | — |
| `docs/core/README.md` | foundation | open, pending | — |
| `docs/core/AGENTS.md` | foundation | open, pending | — |
| `docs/core/contract-evolution.md` | contract-evolution | open, pending | — |
| `docs/core/architecture.md` | architecture | open, pending | — |
| `docs/core/protocol.md` | protocol | open, pending | — |
| `docs/core/communication.md` | communication | open, pending | — |
| `docs/core/identity.md` | identity | open, pending | — |
| `docs/core/policy.md` | policy | open, pending | — |
| `docs/core/vault.md` | vault | open, pending | — |
| `docs/core/mediation.md` | mediation | open, pending | — |
| `docs/core/agent-supply.md` | agent-supply | open, pending | — |
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
| `docs/specs/20260709-quick_chat_workspace.md` | foundation | open, pending | — |
| `docs/specs/20260711-scheduler_recurring_event_triggers.md` | foundation | open, pending | — |
| `docs/specs/20260703-schema_evolution_record_envelope.md` | contract-evolution | open, pending | — |
| `docs/specs/20260715-contract_stability_baseline.md` | contract-evolution | open, pending | — |
| `docs/specs/20261017-retained_format_register.md` | contract-evolution | open, pending | — |
| `docs/specs/20260522-vendor_snapshot_packages.md` | contract-evolution | open, pending | — |
| `docs/specs/20261012-product_integrity_check.md` | contract-evolution | open, pending | — |
| `docs/specs/20260813-internal_agent_runtime.md` | architecture | open, pending | — |
| `docs/specs/20260909-internal_agent_resource_integration.md` | architecture | open, pending | — |
| `docs/specs/20260704-workflow_coordinator_internal_agent.md` | architecture | open, pending | — |
| `docs/specs/20260704-nanocore_bootstrap_readiness.md` | architecture | open, pending | — |
| `docs/specs/20260708-container_image_packaging.md` | architecture | open, pending | — |
| `docs/specs/20260909-deployment_host_requirements.md` | architecture | open, pending | — |
| `docs/specs/20260910-app_update_delivery.md` | architecture | open, pending | — |
| `docs/specs/20260628-web_product_surface_projection.md` | architecture | open, pending | — |
| `docs/specs/20260710-web_ui_rebuild_stack.md` | architecture | open, pending | — |
| `docs/specs/20260910-agent_operator_skill.md` | architecture | open, pending | — |
| `docs/specs/20261020-compute_neutrality_target.md` | architecture | open, pending | — |
| `docs/specs/20261021-protocol_identifiers_and_enums.md` | protocol | open, pending | — |
| `docs/specs/20260704-app_api_openapi_projection.md` | protocol | open, pending | — |
| `docs/specs/20260703-worker_control_protocol.md` | communication | open, pending | — |
| `docs/specs/20261002-remote_mcp_interface.md` | communication | open, pending | — |
| `docs/specs/20260528-core_client_boundary.md` | communication | open, pending | — |
| `docs/specs/20260628-nanocore_config_identity_contract.md` | identity | open, pending | — |
| `docs/specs/20260704-remote_auth_credential_bootstrap.md` | identity | open, pending | — |
| `docs/specs/20260715-multi_user_workspace_system.md` | identity | open, pending | — |
| `docs/specs/20260629-openkit_policy_model.md` | policy | open, pending | — |
| `docs/specs/20260703-policy_enforcement_mapping.md` | policy | open, pending | — |
| `docs/specs/20260909-thread_visibility_and_sharing.md` | policy | open, pending | — |
| `docs/specs/20260930-pending_requests.md` | policy | open, pending | — |
| `docs/specs/20260703-vault_secret_injection.md` | vault | open, pending | — |
| `docs/specs/20260704-vault_backend_implementation.md` | vault | open, pending | — |
| `docs/specs/20260709-worker_credential_access_declarations.md` | vault | open, pending | — |
| `docs/specs/20260703-openshell_mechanism_internalization.md` | vault | open, pending | — |
| `docs/specs/20261002-operation_definition.md` | mediation | open, pending | — |
| `docs/specs/20260703-worker_agent_capability.md` | mediation | open, pending | — |
| `docs/specs/20260704-capability_usage_gateway_foundation.md` | mediation | open, pending | — |
| `docs/specs/20260704-worker_mcp_tool_supply.md` | mediation | open, pending | — |
| `docs/specs/20260526-llm_gateway_responses_api.md` | mediation | open, pending | — |
| `docs/specs/20260703-pi_ai_provider_gateway_adoption.md` | mediation | open, pending | — |
| `docs/specs/20260708-pi_ai_unified_llm_backend.md` | mediation | open, pending | — |
| `docs/specs/20260721-provider_subscription_accounts.md` | mediation | open, pending | — |
| `docs/specs/20261018-nanocore_interception_and_information_consolidation.md` | mediation | open, pending | — |
| `docs/specs/20260616-agent_environment_package.md` | agent-supply | open, pending | — |
| `docs/specs/20260703-agent_manifest_aep_resolution.md` | agent-supply | open, pending | — |
| `docs/specs/20260711-skill_catalog_versioning_pinning.md` | agent-supply | open, pending | — |
| `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md` | agent-supply | open, pending | — |
| `docs/specs/20260907-mcp_catalog_management.md` | agent-supply | open, pending | — |
| `docs/specs/20260704-workspace_data_source_catalog.md` | agent-supply | open, pending | — |
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

Filled in Phase 1.

## Statistics Per Goal

Filled at close-out.

## Issues Opened

None yet.

## Decisions Awaiting Engineer Approval

None yet.

## Questions For The Engineer

None yet.
