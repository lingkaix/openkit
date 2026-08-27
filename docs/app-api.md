---
status: Accepted
date: 2026-05-31
updated: 2026-07-29
---
# App API

This guide answers one cross-cutting question: where does an App API contract live, and what may the App API layer decide for itself.

This is a platform reference under `docs/documentation-model.md`. It owns no contract: not a payload shape, route behavior, or generated artifact. Where this guide disagrees with an owner linked below, the owner wins and this document is the defect.

## Judgments

Calibrated premises about scope and priority for this layer, formed from how the product is built rather than derived from a contract. Per `docs/documentation-model.md` they are the only citable content here, they are not behavioral contracts, no implementation choice cites one as its sole authority, and any behavioral question resolves at the owning core document or specification.

### The App API Is A Replaceable Product Projection, Not A Public API

The App API exists to serve this repository's own Web UI, CLI, and Skill within one release, so it is optimized for reducing round trips and matching product workflows rather than for external stability.

Rests on: every first-party consumer shipping in the same release as the server, per `docs/core/contract-evolution.md`; the internal-development posture in root `AGENTS.md` that removes backward-compatibility obligations; and no third-party integrator depending on these endpoints today.

Overturned by: a consumer that ships on its own schedule — a published SDK, a customer integration, or a partner surface. At that point the release-coupled premise fails, and versioning and deprecation become contract questions for `docs/core/contract-evolution.md` rather than preferences stated here.

### Core Stability Outranks App API Convenience

When a product need could be met either by extending the Core protocol or by adding an App API projection over existing Core records, the projection is preferred, because Core semantics are the expensive thing to change and the App API is the cheap one.

Rests on: Core being the shared model behind every deployment shape, and App API payloads being replaceable within a release.

Overturned by: a product need that repeatedly forces projections to reconstruct state Core does not record. Recurring reconstruction is evidence that Core is missing a concept, and the answer is then a Core change rather than another projection.

## Owns

This guide owns no behavioral contract and no repository-operation decision. No payload, route, client, gateway, workflow, compatibility, security, or change-execution rule is authoritative here.

## Does Not Own

This guide does not own the semantic contracts, executable route facts, package schemas, clients, generated artifacts, consumer behavior, or change workflow linked below. The index exists only for discovery and is not a route inventory, payload contract, or statement of current implementation completeness.

## Owner And Generated Projection Index

- Stable concepts and protocol or communication semantics: `docs/core/core-concepts.md`, `docs/core/protocol.md`, `docs/core/communication.md`
- Accepted implementation-facing contracts: the owning specification indexed under Active Specifications in `docs/INDEX.md`
- App API payload schemas: `packages/app-api-schemas/README.md`
- NanoCore route registrations and behavior: `apps/nanocore/README.md`
- Generated OpenAPI ownership and artifact workflow: `docs/specs/20260704-app_api_openapi_projection.md`, `apps/nanocore/openapi/README.md`
- Typed Core Client projection: `packages/core-client/README.md`
- Web consumer: `apps/web/README.md`
- Change execution evidence: `docs/changes/`

## Receiving Contract Owners

- `docs/core/architecture.md`
- `docs/core/core-concepts.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/contract-evolution.md`
- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-capability.md`
- `docs/core/identity.md`
- `docs/core/permissions.md`
- `docs/core/knowledge.md`
- `docs/core/vault.md`
- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260528-core_client_boundary.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260704-app_api_openapi_projection.md`
- `docs/specs/20260704-capability_usage_gateway_foundation.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-git_write_workflow.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260704-remote_auth_credential_bootstrap.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260709-quick_chat_workspace.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260713-work_resource_interaction_model.md`
- `docs/specs/20260715-multi_user_workspace_system.md`
- `docs/specs/20260721-provider_subscription_accounts.md`

## Known Debt

### Source, Package, And Slice Generation Debt

The Owner And Generated Projection Index is a hand-written projection of facts that live in document headers, package guides, schemas, route registrations, and generated artifacts. Owner: the Generated Projections rules in `docs/documentation-model.md`, with those linked sources remaining authoritative. Activation: when a generator slice is authorized, generate the derivable owner and executable-surface links with a `--check` drift gate rather than restoring route, package, or feature inventories here.
