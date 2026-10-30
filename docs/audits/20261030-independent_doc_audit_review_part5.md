---
date: "2026-10-30"
---
# Independent Documentation Audit: Team Review Of Part 5

This non-authorizing record documents the fifth part of the [independent documentation audit](20261023-independent_doc_audit.md) and its [supplement](20261025-independent_doc_audit_supplement.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records verdicts, amendments, stale record claims, and open contradictions. It does not authorize design.

## Scope

- Part 5 covers sixteen specifications in the vault, mediation, and agent-supply groups, plus the generated `docs/INDEX.md`.
- Vault: [OpenShell Internalization](../specs/20260703-openshell_mechanism_internalization.md), [Secret Injection](../specs/20260703-vault_secret_injection.md), [Vault Backend](../specs/20260704-vault_backend_implementation.md), and [Worker Credential Declarations](../specs/20260709-worker_credential_access_declarations.md).
- Mediation: [LLM Gateway](../specs/20260526-llm_gateway_responses_api.md), [Pi-ai Adoption](../specs/20260703-pi_ai_provider_gateway_adoption.md), [Worker Capabilities](../specs/20260703-worker_agent_capability.md), [Capability Usage](../specs/20260704-capability_usage_gateway_foundation.md), [Worker MCP Supply](../specs/20260704-worker_mcp_tool_supply.md), [Provider Subscriptions](../specs/20260721-provider_subscription_accounts.md), [Operation Definition](../specs/20261002-operation_definition.md), and [Interception](../specs/20261018-nanocore_interception_and_information_consolidation.md).
- Agent supply: [Agent Environment Package](../specs/20260616-agent_environment_package.md), [Manifest Resolution](../specs/20260703-agent_manifest_aep_resolution.md), [Data Source Catalog](../specs/20260704-workspace_data_source_catalog.md), and [Agent Plugins](../specs/20260907-agent_plugin_packaging_and_worker_supply.md).
- Source: combined audit `27c6812b3` against `44450f033`. All 32 hunks were refreshed against `main` `32c1741a0`; the landing branch starts there. None of these sixteen specifications changed between those main commits.
- The review judged authority, current code, semantic preservation, Core consistency, writing rules, and minimality, in that order. The refresh changes one amendment's text and no verdict.
- Only normative hunks are applied. The historical group records already landed with Part 1. Held documents under issue #440 and existing audit records remain unchanged.

## Verdicts

32 hunks in 16 normative documents: 26 accepted, 6 amended, 0 reverted. Vault: 5/1/0; mediation: 17/2/0; agent supply: 4/3/0.

The amendments follow existing owners and need no new decision:

- [Secret Injection](../specs/20260703-vault_secret_injection.md#current-implementation-projection): distinguish runtime-env delivery from runtime-file rejection before secret resolution. The executor persists receipts after accepted submission when a binding opens. Backend validation and receipt gating remain in `worker-governance-turn-executor.ts` and `turn-executor-factory.ts`.
- [Pi-ai Adoption](../specs/20260703-pi_ai_provider_gateway_adoption.md#current-implementation-projection): change “then maps” to “then map” for plural agreement. The [unified backend owner](../specs/20260708-pi_ai_unified_llm_backend.md#current-implementation-projection) still owns the module boundary.
- [Operation Definition](../specs/20261002-operation_definition.md): replace the stale streaming inventory and ordinary-user archive guidance. [Workspace Backup](../specs/20260704-workspace_backup_export_import.md#current-product-boundary) and [Policy](../core/policy.md#administrator-eligibility) own the accepted boundary, recorded in [administrator-only export](../decisions/20261027-workspace_export_administrator_only.md) and [scoped recovery](../decisions/20261027-online_workspace_snapshots_and_recovery.md). The paragraph includes backup download, excludes ordinary portable import, preserves MCP exclusion and owner-specific lifecycle semantics, and creates no Knowledge Web channel.
- [Agent Environment Package](../specs/20260616-agent_environment_package.md#authority-chain): distinguish the redacted AEP and retained setup from the in-memory resolver's private routes. [Manifest Resolution](../specs/20260703-agent_manifest_aep_resolution.md) owns setup resolution; `setup-resolver.ts:258`, `setup-ledger.ts:364-371`, and `agent-environment.ts:794-817` establish the projection boundary.
- [Data Source Catalog](../specs/20260704-workspace_data_source_catalog.md#current-implementation-projection): attribute `workspace_data_source_blocked` to Turn-admission callers. The schema resolver rejects references with ordinary errors and accepts no narrowing, Policy, or grant input.
- [Agent Plugins](../specs/20260907-agent_plugin_packaging_and_worker_supply.md#current-implementation-projection): refresh the gap statement under the existing [package identity](../specs/20260907-agent_plugin_packaging_and_worker_supply.md#package-identity-members-and-composition), [admission](../specs/20260907-agent_plugin_packaging_and_worker_supply.md#import-and-package-admission), and [update](../specs/20260907-agent_plugin_packaging_and_worker_supply.md#grouped-management-and-publication) owners. Current code validates MCP components separately, preserves member mappings, refuses different-source member collisions, and records uploaded-source provenance. Installation-requesting re-import checks overridden source members; complete member-delta computation and the listed management operations remain absent.

The three Permissions-to-Policy labels retain their original targets and rules. The streaming amendment resolves the blocking concern identified in the earlier review.

## Stale Record Claims

The audit records remain unchanged as dated history. These claims need qualification before reuse:

- MD-OD-02 in the [mediation record](20261024-independent_doc_audit_mediation.md): the eight-stream inventory and ordinary-user archive guidance are stale. Backup download is composed; accepted owners exclude ordinary portable import and require administrator export.
- AS-AEP-02 in the [agent-supply record](20261024-independent_doc_audit_agent_supply.md): another specification sentence did not prove that the resolver contained no Provider data. Private routes remain in memory; AEP and retained projections omit them.
- AS-DSC-01 in that record: the missing-input and remediation findings remain, but callers own the product error code.
- AS-PLG-03/04/06 and the per-component-admission claim in that record: current code fixes mapping, collision, provenance, overridden-member checks, and separate MCP admission. Invalid Skill admission still fails the package. Re-import moves an installation only when installation is requested; it still lacks the complete member delta.
- VA-CAD-01/04, relevant to VA-SI-08/VA-CAD-06 in the [vault record](20261024-independent_doc_audit_vault.md): complete declaration admission and backend validation precede material resolution. Runtime-file support remains absent.
- VA-SI-01 in that record: selected MCP use checks current `vault.use` before resolution and after awaited work; the “grant shape only” claim is stale.
- VA-CAD-03 / VA-SI-04 / VA-VB-05 in that record: revocation callers now await runtime binding cleanup, including backend-failure paths. This does not certify every revocation scenario.
- SUP-C-06 in the [supplement](20261025-independent_doc_audit_supplement.md#review): its global rename inventory is historical; Part 5 contains exactly three label replacements.

## Open Contradictions

This record decides none of the remaining questions in the three group records:

- The unchanged AEP implementation projection still overstates resolver alignment by saying the setup resolver retains no Provider-native route.
- [Core Policy](../core/policy.md#boundary) says no agent approver is activated, while Interception describes the implemented bounded agent gate. The implementation correction does not resolve that authority tension.
- Portable-import descriptors, handlers, and the unchanged Operation Definition implementation projection remain despite the accepted removal. The remote MCP Guide also retains ordinary-user archive guidance. These are flagged discrepancies, not import or export authority.
- Held #440 owners are not amended or adjudicated. Knowledge package transfer remains under its existing owner; this part establishes no additional transfer channel.

Verification covers repository consistency and the landing diff, not live runtime qualification. Final acceptance remains with the coordinator's review of the changed files.
