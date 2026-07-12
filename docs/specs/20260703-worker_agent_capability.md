# Worker Agent Capability

Status: Accepted
Implementation: Partial

## Summary

This spec defines the target design for worker-facing agent capabilities beyond the current LLM gateway.

The clean target is one governed worker agent capability plane at `https://capability.local/v1`, plus the OpenAI-compatible `https://inference.local/v1` endpoint for LLM clients. Worker agents should not directly discover, install, authenticate, or route privileged services. NanoCore owns the catalog, policy check, routing, credential injection, metering, audit, error normalization, and gateway projection.

## Owns

- The worker-facing agent capability plane and its gateway projection.
- Runtime capability families, catalog entries, request lineage, and capability-call summaries.
- The relationship between `capability.local`, `inference.local`, AEP-resolved route declarations, and durable capability, usage, and audit records.
- Gateway-mediated MCP, knowledge, external API, network, vault-mediated credential use, LLM, artifact, and diagnostic capability boundaries.
- Capability error normalization, rate-limit hooks, budget hooks, metering hooks, and audit hooks for worker-facing capability calls.

## Does Not Own

- Agent supply declarations or agent manifest authoring.
- Worker control liveness, commands, event append, terminal result delivery, or final status.
- Knowledge semantics, notebook governance, or context package assembly.
- Vault storage or raw secret material.
- Global audit projection outside gateway-mediated capability calls.
- Non-gateway runtime, sandbox, storage, or workspace-sync metering.
- Runtime-internal sub-agent provenance, trusted worker-inference session binding, and runtime cache lineage.
- User-facing `@openkit/mcp` product channel behavior.

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

- Do not replace the user-facing `@openkit/mcp` channel.
- Do not expose NanoCore internals or database access to workers.
- Do not let workers install arbitrary MCP servers or tools at runtime.
- Do not define provider-specific API payload schemas except for gateway envelopes.
- Do not make `inference.local` a generic capability endpoint.

## Background

`docs/core/agent-capability.md` defines the conceptual boundary. `docs/specs/20260629-worker_runtime_communication_model.md` reserves `capability.local` and `inference.local` as worker-visible endpoint projections.

The missing design is the first complete non-LLM worker agent capability contract.

## Current Implementation Projection

The current V1 worker capability plane is implemented for authenticated `capability.local` routes and shared durable recording, while the trusted worker-specific `inference.local` identity projection remains incomplete:

- `packages/config-schema` and `apps/nanocore/src/runtime/agent-environment.ts` resolve `openkit-worker-capability-v1` into AEP snapshots with `https://capability.local/v1` and `https://inference.local/v1`.
- The resolved AEP currently declares sidecar capability routes for `knowledge.search`, `knowledge.read`, `knowledge.proposal`, `artifact.read`, and `diagnostic.read`, all backed by the sandbox session token.
- `packages/worker-shim/src/capability-client.ts` provides a worker-side client for `/knowledge/search`, `/knowledge/read`, `/knowledge/proposals`, `/artifacts/read`, `/mcp/list-servers`, `/mcp/list-tools`, `/mcp/call-tool`, and `/diagnostics/read` through `capability.local`.
- `apps/nanocore/src/app.ts` exposes `/api/worker-capabilities/knowledge/search`, `/api/worker-capabilities/knowledge/read`, `/api/worker-capabilities/knowledge/proposals`, `/api/worker-capabilities/artifacts/read`, `/api/worker-capabilities/mcp/list-servers`, `/api/worker-capabilities/mcp/list-tools`, `/api/worker-capabilities/mcp/call-tool`, and `/api/worker-capabilities/diagnostics/read`. These routes authenticate with the worker-control bearer token and lineage, read workspace knowledge entries, draft review-required knowledge proposals, read workspace artifacts, route selected MCP calls through the NanoCore gateway, return product-safe session diagnostics, and return product-safe `WorkerCapabilityCallSummary` values.
- Worker capability route requests now share a 64 KiB bounded JSON parser. Oversized requests fail before schema handling with HTTP 413 and `capability_input_invalid`, while schema-invalid capability requests fail with the same stable capability error code. This prevents unbounded route-local JSON parsing while keeping larger terminal worker-control payloads on their separate bounded path.
- `packages/worker-protocol` defines `WorkerCapabilityCallSummary` and current worker capability summary families: `knowledge.search`, `knowledge.read`, `knowledge.proposal`, `worker_mcp.call`, `artifact.read`, and `diagnostic.read`.
- `packages/protocol` defines product-level `CapabilityCall`, `UsageRecord`, and `AuditEvent` schemas. `CapabilityCall` and `UsageRecord` include source id arrays for workspace data source lineage when a capability touches catalog-backed data.
- `apps/nanocore/src/capability/usage-ledger.ts` persists durable `CapabilityCall`, `UsageRecord`, and terminal `AuditEvent` rows through one shared ledger, including source id arrays for source-aware producers. Worker knowledge search/read/proposal routes, worker artifact reads, worker diagnostic reads, worker MCP list/call routes, QuickChat LLM calls, and workspace-attributed public pi-ai gateway calls use the ledger where applicable. Successful worker knowledge, artifact, and diagnostic capability calls write one linked `UsageRecord` with `category: "tool"`, `unit: "capability_calls"`, and quantity `1`; successful `mcp.call_tool` calls write one linked `UsageRecord` with `category: "tool"`, `unit: "tool_calls"`, and quantity `1`. Authenticated MCP calls denied during policy evaluation, missing worker knowledge reads, and missing worker artifact reads now write failed `CapabilityCall` rows with stable error codes and no usage row.
- `apps/nanocore/src/llm/provider-dispatcher.ts` routes OpenAI-compatible Chat Completions and Responses calls for the LLM gateway projection. `apps/nanocore/src/llm/gateway-routes.ts` enforces the runtime config's enabled flag and provider allowlist directly, without a second process-local policy owner.
- `GatewayUsageTracker` in `apps/nanocore/src/llm/gateway-usage.ts` records process-local LLM gateway usage summaries for diagnostics.
- Public LLM Gateway routes currently accept durable attribution from caller-supplied `metadata.openkit`; they do not yet authenticate an AEP-bound worker inference session, preserve runtime-internal origin, or separate runtime cache lineage from shared outer OpenKit lineage.

Network egress, external API routing, generic future credential classes, the full Capability Catalog, baseline rate-limit and budget enforcement, and transformer-pipeline routing are deferred beyond V1. The implemented V1 scope is the governed worker capability plane for knowledge, artifacts, diagnostics, and MCP tool supply plus generic OpenAI-compatible inference dispatch. Alignment remains partial until `docs/specs/20260711-worker_runtime_subagent_provenance.md` adds the authenticated worker inference binding and runtime origin/cache correlation required by the specialized inference projection.

Server capability flags exposed through NanoCore metadata and consumed by `packages/core-client/src/capabilities.ts` are feature discovery flags. They are not worker agent capability declarations.

## Decision

All privileged worker agent capability access goes through one NanoCore-owned gateway projection.

The worker-visible endpoints are:

```text
https://capability.local/v1
https://inference.local/v1
```

`capability.local` carries OpenKit capability calls. `inference.local` carries OpenAI-compatible LLM requests for runtime ergonomics. Both are gateway projections and must produce capability, usage, and audit records with the same lineage model.

The first route projection may use family-specific routes such as `/knowledge/search` and `/knowledge/read` because they are easier for runtime-native clients and policy schemas to type. A generic `POST /calls` route is optional future work, not the first canonical requirement.

## Capability Families

Initial capability families:

- `mcp`: call an MCP tool exposed through NanoCore.
- `knowledge.search`: search governed knowledge and source indexes.
- `knowledge.read`: read selected knowledge pages, source summaries, or derived representations.
- `knowledge.propose`: propose source-traceable knowledge changes discovered during worker execution.
- `external-api`: call a configured external API through a provider profile. Deferred beyond V1.
- `network`: access an allowed network target through a proxy policy. Deferred beyond V1.
- `vault.use`: use a vault-mediated credential without exposing the secret value where possible. V1 implements concrete provider, GitHub MCP, Codex auth JSON runtime-file, and Git push credential paths; generic future credential classes are deferred.
- `llm`: call an LLM through `inference.local` or a future typed gateway path.
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

Every capability request must include:

- capability call id or idempotency key
- workspace id
- thread id when applicable
- turn id when applicable
- agent session id
- package snapshot id
- worker sequence when emitted by sidecar
- capability id
- family
- operation
- input payload
- content digests for large payload references
- request timestamp

The sidecar may add lineage automatically when the runtime-native client cannot.

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

Worker-side MCP access uses NanoCore as the mediator.

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

Knowledge capability calls are retrieval and read operations, not direct notebook access.

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

- Worker-facing capabilities use one governed capability plane at `capability.local`; LLM clients may use the specialized OpenAI-compatible `inference.local` projection.
- `inference.local` remains an LLM endpoint, not a generic capability endpoint.
- Family-specific routes are acceptable for the first worker capability projection. They must still produce canonical `CapabilityCall` semantics.
- `knowledge.*` is the canonical family name. The older `memory.*` implementation projection has been removed without compatibility aliases.
- Capability catalog sources should remain manifest- or file-system-first, while the AEP stores the resolved per-session projection.
- Knowledge search and read calls are not item-visible by default. They become item-visible only through context-injection, tool-call, worker-output citation, or explicit product projection.
- Process-local LLM gateway usage diagnostics are not durable usage records.
- MCP schema evidence should retain schema references, versions, and digests plus redacted call summaries; raw MCP payload retention is opt-in governed evidence, not the default.
- The first rate-limit and budget model should enforce request, token, byte, tool-call, and normalized-cost units at gateway policy boundaries, with denied calls producing stable errors and audit-capable records.

## Deferred / Future Work

- Add worker capability routes for external API, network, and future typed tool calls after those roadmap areas are activated.
- Add generic vault-mediated capability routes for future credential classes not covered by the current provider, GitHub MCP, Codex auth JSON runtime-file, and Git push paths.
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
