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

Phase 1 has not run yet.

## Statistics Per Goal

No group has been audited yet.

## Issues Opened

None yet.

## Decisions Awaiting Engineer Approval

None yet.

## Questions For The Engineer

None yet.
