# Worker Agent Capability

Status: Accepted
Implementation: Partial

## Summary

This spec defines the target design for worker-facing agent capabilities beyond the current LLM gateway.

The clean target is one governed worker agent capability plane at `https://capability.local/v1`, plus one AEP-resolved OpenAI-compatible LLM route. Backend-local inference may use `https://inference.local/v1`; packages that require complete attribution use the exact authenticated NanoCore worker-inference base URL instead. Worker agents should not directly discover, install, authenticate, or route privileged services. NanoCore owns the catalog, policy check, routing, credential injection, metering, audit, error normalization, and gateway projection.

## Owns

- The worker-facing agent capability plane and its gateway projection.
- Runtime capability families, catalog entries, request lineage, and capability-call summaries.
- The relationship between the future `capability.local` projection, backend-local inference, trusted AEP-resolved worker-inference routes, and durable capability, usage, and audit records.
- Gateway-mediated MCP, knowledge, external API, network, vault-mediated credential use, LLM, artifact, and diagnostic capability boundaries.
- Capability error normalization, rate-limit hooks, budget hooks, metering hooks, and audit hooks for worker-facing capability calls.

## Does Not Own

- Agent supply declarations or agent manifest authoring.
- Worker control liveness, commands, event append, or final status.
- Knowledge semantics, notebook governance, or context package assembly.
- Vault storage or raw secret material.
- Global audit projection outside gateway-mediated capability calls.
- Non-gateway runtime, sandbox, storage, or workspace-sync metering.
- Runtime-internal sub-agent provenance, trusted worker-inference session binding, and runtime cache lineage.
- End-user Agent Skill Interface behavior.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/communication.md`
- `docs/core/knowledge.md`
- `docs/core/vault.md`
- `docs/core/metering.md`
- `docs/core/audit.md`

## Goals

- Define the worker agent capability boundary and its gateway projection.
- Add MCP, knowledge, external API, network proxy, vault-mediated credential use, and generic tool calls to the capability model.
- Keep the existing LLM gateway as a specialized OpenAI-compatible endpoint while aligning it with the same capability records.
- Define durable `CapabilityCall` ownership and lineage.
- Make capability access policy-controlled, metered, auditable, and catalog-backed.

## Non-goals

- Do not absorb or replace the end-user Agent Skill Interface.
- Do not expose NanoCore internals or database access to workers.
- Do not let workers install arbitrary MCP servers or tools at runtime.
- Do not define provider-specific API payload schemas except for gateway envelopes.
- Do not make `inference.local` a generic capability endpoint.

## Background

`docs/core/agent-capability.md` defines the conceptual boundary. `docs/specs/20260629-worker_runtime_communication_model.md` reserves the future `capability.local` plane plus one AEP-resolved inference projection: backend-local `inference.local` or the authenticated worker-inference base URL when complete attribution is required.

The missing design is the first complete non-LLM worker agent capability contract.

## Current Implementation Projection

The worker capability plane is not currently implemented. `packages/config-schema` and NanoCore emit `capabilities: { protocol: "openkit-worker-capability-v1", mode: "disabled", routes: [] }`; `packages/worker-shim` has no capability client; NanoCore exposes no `/api/worker-capabilities/*` routes and has no worker MCP gateway. Static Skill and MCP supply does not grant a callable route.

The protocol and storage foundations remain: `packages/worker-protocol` defines `WorkerCapabilityCallSummary` as a transcript/import summary schema, `packages/protocol` defines product-level `CapabilityCall`, `UsageRecord`, and `AuditEvent`, and the shared usage ledger supports implemented LLM producers. A worker-reported summary is evidence for import and does not prove that NanoCore offered or executed a capability call.

The generic public LLM gateway and the separately governed worker-inference path are independent of this disabled capability plane. Runtime provenance and trusted worker-inference remain governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`, whose production proof is complete; that result does not implement or authorize this capability plane.

Network egress, external API routing, generic future credential classes, the full Capability Catalog, baseline rate-limit and budget enforcement, transformer-pipeline routing, Knowledge and artifact routes, diagnostics, and MCP tool supply all remain future implementation work under this accepted contract.

Server capability flags exposed through NanoCore metadata and consumed by `packages/core-client/src/capabilities.ts` are feature discovery flags. They are not worker agent capability declarations.

## Decision

All privileged worker agent capability access goes through one NanoCore-owned gateway projection.

The worker-visible endpoints are:

```text
https://capability.local/v1
https://inference.local/v1                     # backend-local inference
<AEP workerInferenceBaseUrl>                    # complete attributed inference
```

When implemented, `capability.local` will carry OpenKit capability calls. The AEP-resolved LLM route carries OpenAI-compatible requests through either backend-local inference or the authenticated worker-inference route. Every governed projection must produce capability, usage, and audit records with the same lineage model.

The first route projection may use family-specific routes such as `/knowledge/search` and `/knowledge/read` because they are easier for runtime-native clients and policy schemas to type. A generic `POST /calls` route is optional future work, not the first canonical requirement.

## Capability Families

The accepted target capability families are:

- `mcp`: call an MCP tool exposed through NanoCore.
- `knowledge.search`: search governed knowledge and source indexes.
- `knowledge.read`: read selected knowledge pages, source summaries, or derived representations.
- `external-api`: call a configured external API through a provider profile. Deferred beyond V1.
- `network`: access an allowed network target through a proxy policy. Deferred beyond V1.
- `vault.use`: use a vault-mediated credential without exposing the secret value where possible. Logical provider declarations, Codex auth JSON runtime-file, and Git push credential paths are separate implementation mechanisms; non-transient OpenShell provider materialization is currently fail-closed, and none of these paths makes this future gateway route active.
- `llm`: call an LLM through the AEP-resolved backend-local or trusted worker-inference gateway path.
- `artifact.read`: read declared artifacts as context.
- `artifact.write-notice`: announce an artifact that must be collected through the data plane.

Filesystem mutation is not a gateway family. Workspace writes belong to workspace change sets and review gates.

## Catalog Model

NanoCore owns a workspace-visible `CapabilityCatalog`.

Catalog entries include:

- capability id
- family
- display name
- description
- provider or service reference
- required policy domain
- required vault grant category
- input schema reference
- output schema reference
- rate limit class
- usage unit class
- audit category
- redaction policy
- availability state
- degraded reason when applicable

The catalog is resolved into the AEP snapshot. A worker sees only the catalog entries selected for that session.

Catalog source records should be file-system-first or manifest-backed where possible. SQLite may index catalog availability and runtime diagnostics. The AEP contains the resolved per-session snapshot, not the canonical catalog source.

## Request Envelope

The future thin worker client supplies:

- capability call id or idempotency key
- worker sequence when emitted by the shim
- operation
- input payload
- content digests for large payload references
- request timestamp

NanoCore derives authoritative workspace, thread, turn, agent-session, package-snapshot, capability-id, and family context from the authenticated package session, selected route, and resolved catalog. Worker-supplied lineage is never authority.

## CapabilityCall Record

`CapabilityCall` is the durable record for one call through an agent capability route or gateway projection.

It should store:

- call id
- lineage ids
- capability id and family
- operation
- policy decision id
- vault grant ids used
- upstream provider summary
- request redaction summary
- response redaction summary
- status
- normalized error code when failed
- usage record ids
- audit event ids
- start and finish timestamps
- digest of large request or response references when retained

Raw provider payloads should not be stored by default.

## MCP Gateway

Under the accepted target, worker-side MCP access will use NanoCore as the mediator. This section does not describe a currently callable route.

MCP catalog entries may represent:

- a NanoCore-spawned local MCP server
- a remote MCP server NanoCore connects to
- a built-in OpenKit capability exposed through an MCP-compatible adapter

Workers do not receive arbitrary MCP server command lines, tokens, or remote URLs. They receive a capability id and a gateway route.

MCP tool calls must produce `CapabilityCall`, `UsageRecord` where measurable, and `AuditEvent` records.

## MCP Schema Retention Baseline

MCP catalog entries should preserve enough schema evidence for replay and debugging without storing raw privileged payloads by default.

Catalog entries should retain:

- tool name or operation id
- input schema reference
- output schema reference when available
- schema version or source revision
- schema digest
- redaction policy
- replay retention policy

Capability calls should retain:

- capability id
- MCP server or adapter summary
- tool name or operation id
- input digest
- output digest when available
- redacted input summary
- redacted output summary
- schema reference and digest used for validation
- artifact or evidence references when policy retains payload evidence

Raw MCP request or response payloads should not be durable by default. If a task, policy, or debugging mode requires payload retention, the payload must be stored as governed evidence or artifact material with sensitivity labels, retention policy, and audit linkage.

## Knowledge Gateway

Under the accepted target, Knowledge capability calls are retrieval and read operations, not direct notebook access. Current Workflow Coordinator paths can record selected Knowledge references in delegation metadata, but they do not automatically bind those references or material into the AEP or worker turn. Workers cannot call these operations while the capability plane is disabled.

`knowledge.search` returns ranked, redacted candidates with source references and reasons.

`knowledge.read` returns selected pages, snippets, or derived representations only when policy allows the worker to see them.

Every injected or read knowledge item must be linkable to the context package trace or to a capability call record.

Knowledge retrieval is infrastructure by default. It should become item-visible only when NanoCore creates a context-injection item, a user-visible tool-call item, or a worker output cites the retrieved material.

## External API And Network Gateway

External API calls must use provider profiles. Provider profiles define endpoint families, credential references, allowed operations, and redaction rules.

Network gateway access is deny-by-default. It should support allowlisted hosts, methods, ports, and purpose labels.

Network gateway records should store target summaries and policy decisions, not unrestricted payloads.

## Vault-Mediated Use

The agent capability gateway projection may inject a credential into an upstream call without exposing it to the worker.

If the worker must see credential material, the injection path must be explicit, time-bounded, audited, and linked to a vault grant.

## Routing Pipeline

Each call follows this pipeline:

```text
receive request
  -> authenticate sandbox session
  -> verify lineage and package snapshot
  -> validate capability id against resolved AEP catalog
  -> validate input schema
  -> evaluate permission and policy
  -> resolve vault grants
  -> select upstream provider or service
  -> apply request transformers
  -> execute upstream call
  -> normalize response or error
  -> record usage and audit
  -> return redacted response
```

Failures before policy evaluation are security failures and should be redacted.

## Rate Limit And Budget Baseline

The first useful rate-limit and budget model should be gateway-local but record-shaped enough to become durable.

Minimum dimensions:

- workspace id
- thread id when available
- turn id when available
- agent session id
- package snapshot id
- capability id
- capability family
- provider or upstream route summary when applicable

Minimum unit classes:

- request count
- token count for LLM or text-transforming calls
- byte count for artifact, source, or network movement
- tool call count for MCP and tool routes
- normalized cost estimate when provider pricing is known

Gateway policy may start with hard limits only. A denied call must return `capability_rate_limited` or `capability_budget_exceeded`, and it should still create a denied `CapabilityCall` plus audit evidence when the request reached authenticated policy evaluation. Process-local counters are acceptable for the first implementation, but the call shape must not block durable `UsageRecord` and audit persistence later.

## Error Model

Gateway errors should use stable OpenKit codes:

- `capability_not_in_package`
- `capability_unavailable`
- `capability_policy_denied`
- `capability_requires_approval`
- `capability_input_invalid`
- `capability_vault_grant_missing`
- `capability_rate_limited`
- `capability_budget_exceeded`
- `capability_upstream_failed`
- `capability_unsupported_operation`

The worker receives an actionable error without raw upstream secrets or backend internals.

## Resolved Decisions

- Worker-facing capabilities use one governed capability plane at `capability.local`; LLM clients use the specialized OpenAI-compatible route resolved by the AEP.
- Backend-local `inference.local` remains an LLM endpoint, not a generic capability endpoint, and packages that require complete attribution use the authenticated NanoCore worker-inference route instead.
- Family-specific routes are acceptable for the first worker capability projection. They must still produce canonical `CapabilityCall` semantics.
- `knowledge.*` is the canonical family name. The older `memory.*` implementation projection has been removed without compatibility aliases.
- Capability catalog sources should remain manifest- or file-system-first, while the AEP stores the resolved per-session projection.
- Knowledge search and read calls are not item-visible by default. They become item-visible only through context-injection, tool-call, worker-output citation, or explicit product projection.
- Process-local LLM gateway usage diagnostics are not durable usage records.
- MCP schema evidence should retain schema references, versions, and digests plus redacted call summaries; raw MCP payload retention is opt-in governed evidence, not the default.
- The first rate-limit and budget model should enforce request, token, byte, tool-call, and normalized-cost units at gateway policy boundaries, with denied calls producing stable errors and audit-capable records.

## Deferred / Future Work

- Rebuild the direct `capability.local` projection, thin worker client, and initial Knowledge, artifact, and diagnostic route families without restoring a sidecar or creating a second control path.
- Add worker capability routes for external API, network, and future typed tool calls after those roadmap areas are activated.
- Add generic vault-mediated capability routes for credential classes not covered by the current non-capability Codex auth JSON runtime-file and Git push paths.
- Add capability catalog schema and resolution records that distinguish canonical catalog sources from AEP snapshots.
- Implement the baseline rate-limit and budget model with stable denied or error records.
- Decide whether a generic `POST /calls` endpoint is worth adding after family-specific routes stabilize.
- Implement the MCP route family, catalog, lifecycle, credential injection, policy binding, and schema retention contract owned by `docs/specs/20260704-worker_mcp_tool_supply.md`.

## Testing Strategy

- Catalog resolution tests for worker AEP snapshots.
- MCP gateway tests with a fake MCP server.
- Knowledge search and read policy tests.
- Vault-mediated external API tests that prove secrets are not exposed to workers.
- Lineage mismatch tests that fail closed.
- Usage and audit tests proving every successful and denied call leaves records.
- Error normalization tests for invalid input, oversized input, and upstream failures.

## Risks & Mitigations

- Risk: The gateway becomes a generic remote procedure call surface. Mitigation: all operations must be catalog entries with schemas and policy.
- Risk: MCP supply bypasses policy through native config files. Mitigation: generate runtime-native MCP config from gateway catalog entries only.
- Risk: Workers exfiltrate data through allowed external APIs. Mitigation: use operation-scoped provider profiles and audit target summaries.
- Risk: `inference.local` drifts away from the capability model. Mitigation: persist LLM gateway calls as capability calls even if the wire API remains OpenAI-compatible.

## Links

- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`
- `docs/core/communication.md`
- `docs/core/knowledge.md`
- `docs/core/vault.md`
- `docs/core/metering.md`
- `docs/core/audit.md`
- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
