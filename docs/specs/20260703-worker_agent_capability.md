---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-09-30
---
# Worker Agent Capability

## Summary

This spec defines the target design for worker-facing agent capabilities beyond the current LLM gateway.

The clean target keeps logical `capability.local` and `inference.local` bindings as distinct worker-local APIs. The latter has the adapter-owned fixed URL `http://127.0.0.1:17892/inference/v1`; the AEP carries no native URL. Sandbox Integration projects them onto `/capabilities/*` and `/inference/*` over the sandbox's one standard HTTP/2 session inside one stock RelayStream; worker control remains `/worker-control/*`. Each family retains a distinct token or reference, scope, payload and concurrency bounds, flow control, retry and failure semantics, usage, and audit. Worker agents should not directly discover, install, authenticate, or route privileged services. NanoCore retains capability semantics while the NanoHost owns only the outer transport projection.

## Owns

- The worker-facing agent capability plane and its gateway projection.
- Runtime capability families, catalog entries, request lineage, and capability-call summaries.
- The relationship between the `capability.local` projection, worker-local `inference.local`, their distinct route credentials, and durable capability, usage, and audit records.
- Gateway-mediated MCP, knowledge, external API, network, vault-mediated credential use, LLM, artifact, and diagnostic capability boundaries.
- Capability error normalization, rate-limit hooks, budget hooks, metering hooks, and audit hooks for worker-facing capability calls.
- The identity, schemas, and semantics of the built-in `openkit-work` tools `work_request_input`, `work_list_peers`, and `work_read_peer`.

## Does Not Own

- Agent supply declarations or agent manifest authoring.
- Worker control liveness, commands, event append, or final status.
- Knowledge semantics, notebook governance, or context package assembly.
- Vault storage or raw secret material.
- Global audit projection outside gateway-mediated capability calls.
- Non-gateway runtime, sandbox, storage, or workspace-sync metering.
- Runtime-internal sub-agent provenance, trusted worker-inference session binding, and runtime cache lineage.
- End-user remote MCP interface behavior.
- The pending request lifecycle and delivery, owned by [Pending Requests](20260930-pending_requests.md).
- Tools and MCP servers configured inside the worker's Sandbox, which are the worker's own and are not capability calls.
- Runtime Epoch lifecycle, RelayStream carriage, Sandbox Integration, and outer route transport, which belong to `docs/specs/20260802-nanohost_runtime_and_transport.md`.

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

- Do not absorb or replace the end-user remote MCP interface.
- Do not expose NanoCore internals or database access to workers.
- Do not let workers install or replace NanoCore-hosted or catalog capability implementations. External traffic follows [Sandbox](../core/sandbox.md) and [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md): Gateway-required integrations remain mediated, while admitted public non-LLM grants and separately authorized non-LLM REST grants retain their respective network and credential contracts. Neither direct route creates NanoCore-managed MCP supply or an upward control route. Worker-owned tools and MCP configuration inside the Sandbox are not this prohibition.
- Do not define provider-specific API payload schemas except for gateway envelopes.
- Do not make `inference.local` a generic capability endpoint.
- Do not add a direct sandbox-to-NanoCore route, a second control path, or more than the current one active worker slot.

## Background

`docs/core/agent-capability.md` defines the conceptual boundary. `docs/specs/20260802-nanohost_runtime_and_transport.md` fixes the transport projection: Sandbox Integration exposes worker-local `capability.local` and `inference.local` while carrying `/capabilities/*` and `/inference/*` alongside, but semantically separate from, `/worker-control/*`.

This contract defines the non-LLM worker agent capability boundary; the current selected-MCP slice and deferred families are distinguished below.

## Current Implementation Projection

The current worker capability plane implements only the three selected-MCP operations `mcp.list_servers`, `mcp.list_tools`, and `mcp.call_tool`. The built-in `openkit-generative` and `openkit-work` supply is appended to every package, so every package emits those exact enabled routes. Sandbox Integration carries the separately authenticated capability family, the Codex adapter projects selected servers at `http://127.0.0.1:17892/capabilities/mcp/:serverId`, and NanoCore owns the MCP gateway, policy, schema, usage, and audit path. The Pi and OpenCode adapters project none. NanoCore dispatches `work_request_input`, `work_list_peers`, and `work_read_peer` in process through the existing authenticated MCP route and capability ledger. Peer handles are stateless, scoped to the calling Turn and current binding, and are not persisted. Peer reads reuse the product Turn and Item schemas with bounded paging and current Workspace and Thread audience checks. Static Skill supply and unselected MCP catalog entries grant no callable route.

The protocol and storage foundations remain: `packages/worker-protocol` defines `WorkerCapabilityCallSummary` as a transcript/import summary schema, `packages/protocol` defines product-level `CapabilityCall`, `UsageRecord`, and `AuditEvent`, and the shared usage ledger supports LLM and MCP producers. A worker-reported summary is evidence for import and does not prove that NanoCore offered or executed a capability call; only the NanoCore-owned gateway records do.

The generic public LLM gateway and the worker-inference path are independent of this narrowly enabled MCP capability plane. Runtime provenance remains governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`; its historical production proof does not by itself prove the MCP capability path.

The selected-MCP implementation remains pending real-Codex L6 acceptance and release closure under `docs/specs/20260704-worker_mcp_tool_supply.md`. The built-in repository target below uses that existing MCP family; it does not create an App API tunnel or a general external-network capability.

Network egress, external API routing, generic future credential classes, the full Capability Catalog, baseline rate-limit and budget enforcement, transformer-pipeline routing, Knowledge and artifact routes, and broader diagnostics remain future implementation work under this accepted contract.

Server capability flags exposed through NanoCore metadata and consumed by `packages/core-client/src/capabilities.ts` are feature discovery flags. They are not worker agent capability declarations.

## Decision

All privileged worker agent capability access goes through one NanoCore-owned gateway projection.

The worker-visible local APIs and their outer target route families are:

```text
capability.local (logical binding)
  -> /capabilities/*                            # capability token
http://127.0.0.1:17892/inference/v1
  -> /inference/*                               # inference token
/worker-control/*                               # distinct worker-control token
```

The logical `capability.local` binding carries selected OpenKit capability calls, while the logical `inference.local` binding carries OpenAI-compatible inference calls through the fixed loopback URL above. Shared HTTP/2 carriage does not merge their authority or behavior: each family authenticates its own token or reference and preserves its own payload, concurrency, flow-control, retry, failure, usage, and audit contract.

The first route projection may use family-specific routes such as `/knowledge/search` and `/knowledge/read` because they are easier for runtime-native clients and policy schemas to type. A generic `POST /calls` route is optional future work, not the first canonical requirement.

A resident runtime outlives the per-Turn inference and capability route tokens, so it never receives them ([decision](../decisions/20260930-resident_request_attribution.md)). At `session.open` NanoCore mints one session loopback credential per route family, inference and capability, and delivers them to the Harness, which gives them to the runtime host as bearers for the fixed loopback endpoints. Sandbox Integration authenticates a loopback credential, maps it to its AgentSession and family, and forwards the request under the route token of the Turn bound to that AgentSession when the request arrives; the request is attributed to, and authorized as, that Turn. With no Turn bound, every request is refused. At a Turn's terminal barrier Integration drains that AgentSession's in-flight requests for at most 10 seconds, cuts the rest and refuses their results, and only then clears the Turn's route tokens. `session.close` destroys both loopback credentials. NanoCore persists only the SHA-256 digests of the two loopback credentials with the binding and keeps no raw value after the `session.open` dispatch. A transport loss or a NanoCore restart may adopt the exact surviving binding under the proof contract in [AgentSession Continuity](20260704-agent_session_continuity.md); Integration keeps the credentials, so the resident runtime is untouched. A binding that cannot be proved exactly is closed or fenced, and a successor resumes the native conversation. The collection check compares those digests as [Workspace Synchronization](20260703-workspace_synchronization.md) defines. This specification owns the loopback credentials' mint, attribution, drain, destruction, and the persistence of their digests; other owners link here rather than restate them. Upstream route tokens still rotate every Turn. The scheme does not fence generations: work from an earlier Turn that sends a request after a later Turn binds acts with the later Turn's authority, which the engineer accepted.

## Capability Families

The accepted target capability families are:

- `mcp`: call an MCP tool exposed through NanoCore.
- `knowledge.search`: search governed knowledge and source indexes.
- `knowledge.read`: read selected knowledge pages, source summaries, or derived representations.
- `external-api`: call a configured external API through a provider profile. Deferred beyond V1.
- `network`: access an allowed network target through a proxy policy. Deferred beyond V1.
- `vault.use`: use a vault-mediated credential without exposing the secret value where possible. Logical provider declarations and Codex auth JSON runtime-file are separate implementation mechanisms; non-transient OpenShell provider materialization is currently fail-closed, and none of these paths makes this future gateway route active.
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

The future thin worker client supplies through the separately authenticated capability route:

- capability call id or idempotency key
- worker sequence when emitted by the shim
- operation
- input payload
- content digests for large payload references
- request timestamp

NanoCore derives authoritative workspace, thread, turn, AgentSession, package-snapshot, capability-id, and family context from the authenticated package session, selected route, and resolved catalog. Worker-supplied lineage is never authority.

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
- status: `succeeded`, `denied`, `failed`, or `unknown`, with upstream-contact knowledge for `unknown`
- normalized error code when failed
- for the execution of an approved call, the pending request id it executes; the full arguments stay in that request's captured binding, not in this record
- usage record ids
- audit event ids
- start and finish timestamps
- digest of large request or response references when retained

Raw provider payloads should not be stored by default.

## MCP Gateway

NanoCore is the mediator for catalog and built-in MCP servers. It exposes `mcp.list_servers`, `mcp.list_tools`, and `mcp.call_tool` through the separately authenticated fixed Integration capability route, for the servers the immutable AEP selects plus the always-supplied built-ins; the built-ins include `openkit-work`. Knowledge operations and every other capability family remain non-callable. Tools and MCP servers the worker configures inside its own Sandbox are not capability calls.

MCP catalog entries may represent:

- a NanoCore-spawned local MCP server
- a remote MCP server NanoCore connects to
- a built-in OpenKit capability exposed through an MCP-compatible adapter

Through the gateway, workers do not receive MCP server command lines, tokens, or remote URLs of catalog or external servers. They receive a capability id and a gateway route. A server the worker configures inside its own Sandbox is its own configuration, not something the gateway hands out.

MCP tool calls must produce `CapabilityCall`, `UsageRecord` where measurable, and `AuditEvent` records.

### Built-In Tool Derivation

Until a resource family is cut over, the descriptor, direct command dispatch, and claimed-scope agreement in the following two targets remain that family's contract.

When that resource family is cut over, the accepted target applies. Built-in worker MCP Tools are derived from the definitions and execute through invocation. [Operation Definition](20261002-operation_definition.md) owns that mechanism. This specification does not restate it. Worker supply assembly keeps capability admission and its immutable selections. Those selections include the reserved target identity and the refusal of a Workspace command, remote URL, or Plugin to replace it. Actor, execution lineage, entry scope, the private Turn, and command identities an owner derives come from the invocation context. Model-facing schemas omit those bound fields. A conflicting argument is rejected before any effect. This specification keeps the identity and semantics of the `openkit-work` tools, and it keeps the generative effect boundary its owning document already states. The family's hand-maintained descriptor is deleted in that cutover. It is not a second contract.

### Built-In Generative Target

The initial Kernel/native-UI profile selects one built-in `openkit-generative` MCP descriptor through the existing immutable AEP supply boundary. This identity is reserved for the Core-owned adapter and cannot be replaced by a Workspace command, arbitrary remote URL, or Plugin with the same display name. It offers only implemented selected operation-specific tools from [Kernel](20260908-generative_kernel_data_operations.md) and [Generative UI](20260908-generative_ui_interaction.md), using their shared strict request/result schemas. Operation IDs normalize dots and hyphens to underscores for MCP tool names; the descriptor checks uniqueness. Until this resource family is cut over, that descriptor and that normalization remain the contract under Built-In Tool Derivation.

Until this resource family is cut over, the authenticated package session resolves actor, Workspace, Thread, Turn, AgentSession and selected tools, claimed scope must agree and cannot override this context, and the gateway invokes the owning Core command directly. Before and after cutover, the built-in projection preserves request ID, exact operation authorization, Audit and CapabilityCall lineage, limits, and result admission, and never recursively calls its own MCP HTTP endpoint. When the family is cut over, those bound inputs and the execution seam follow Built-In Tool Derivation. No data-root mount, SQLite handle, shell command, capability family, per-app MCP process, or revival of the deleted user-facing stdio MCP package is introduced. Native UI resources are resolved by the authenticated Core/Web resource path; this slice does not add a Worker `resources/read` family. Missing implementation/selection is unavailable and is not advertised as callable. The accepted user-facing agent channel is remote MCP over the same operations under [Remote MCP Interface](20261002-remote_mcp_interface.md). The first-release user-facing Skill package is retired; the retained administrator CLI is generated at `skills/openkit-ops/scripts/openkit` and ships inside `openkit-ops` under [Agent Operator Skill](20260910-agent_operator_skill.md). Remote MCP and this administrator CLI are separate projections of the shared operations, distinct from selected Worker MCP supply. Arbitrary internal-agent MCP loading remains deferred.

### Built-In Work Target

The reserved built-in `openkit-work` target is supplied to every worker AgentSession without manifest selection. No catalog entry or Plugin can take its id or replace it with a command or URL. Until this resource family is cut over, it is dispatched in process against the authenticated package session, whose actor, Workspace, Thread, Turn, and AgentSession claimed scope cannot override. When the family is cut over, the tools execute through invocation under Built-In Tool Derivation, and this unconditional supply stays. Its tools:
- **`work_request_input`** asks the responsible user one or more questions, using the existing `UserInputQuestionSchema`. It raises a pending user-input request under [Pending Requests](20260930-pending_requests.md) and returns at once with `isError: false`, because recording the question is its function; the structured and text content carry `status: "pending-input"`, the request id, and a next step saying that the answer arrives on a later Turn. It is not an approval and authorizes nothing. A question with `isSecret: true` is refused as `secret_input_not_supported` before any write.
- **`work_list_peers`** lists the other AgentSessions currently in the worker's own Sandbox, as opaque peer handles with their Agent and runtime, and, where the calling Turn's responsible user may read the peer's Thread, its title and whether a Turn is active. Handles are not AgentSession ids and are valid only within the calling Turn.
- **`work_read_peer`** reads one peer's bounded, product-safe projection: its recent Turns with their status and trigger, and its recent product Items (messages, plans, tool-call summaries, and status), paged and redacted as an ordinary product read. It returns only what the calling Turn's responsible user may currently read of that Thread; a peer whose Thread that user cannot read is listed only by handle, Agent, and runtime, and reading it fails `peer_not_found`. It never returns native runtime state, AgentSession identity, restricted raw evidence, or credentials, and it creates no control edge: it does not wake, steer, answer, or cancel the peer.

Same-Sandbox relatedness is an interim boundary, replaced when relatedness must cross Sandboxes or depend on permissions. Asking a peer a question is deferred. Each call records one `CapabilityCall`. Errors are `secret_input_not_supported`, `request_limit_reached`, `turn_not_active`, `capability_denied`, `idempotency_key_conflict`, and `peer_not_found` when the handle does not name a current co-resident. Acceptance requires that discovery shows exactly the three tools, that a peer read has no effect on the peer, and that `work_request_input` neither stops the Turn nor closes the AgentSession.

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

Under the accepted target, Knowledge capability calls are retrieval and read operations, not direct notebook access. Current Workflow Coordinator paths can record selected Knowledge references in delegation metadata, but they do not automatically bind those references or material into the AEP or worker turn. The current narrowly enabled MCP capability plane does not expose Knowledge operations.

`knowledge.search` returns ranked, redacted candidates with source references and reasons.

`knowledge.read` returns selected pages, snippets, or derived representations only when policy allows the worker to see them.

Every injected or read knowledge item must be linkable to the context package trace or to a capability call record.

Knowledge retrieval is infrastructure by default. It should become item-visible only when NanoCore creates a context-injection item, a user-visible tool-call item, or a worker output cites the retrieved material.

## External API And Network Gateway

Gateway-mediated external API calls must use provider profiles. Independently admitted public endpoints follow [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md), as recorded in [Public Endpoints By Admitted Grant](../decisions/20260930-public_endpoints_by_admitted_grant.md), and do not become Gateway capability calls. Provider profiles define endpoint families, credential references, allowed operations, and redaction rules.

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
  -> when approval is required: capture the call, record the pending request, return a pending result
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
- AgentSession id
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
- `capability_input_invalid`
- `capability_vault_grant_missing`
- `capability_rate_limited`
- `capability_budget_exceeded`
- `capability_upstream_failed`
- `capability_unsupported_operation`

The worker receives an actionable error without raw upstream secrets or backend internals. A call that requires approval is not an error code: it returns a pending result under [Pending Requests](20260930-pending_requests.md), with `isError: true` because the tool has not executed. A call that cannot be approved stays `capability_policy_denied`.

## Resolved Decisions

- Worker-facing capabilities use one governed worker-local capability API at `capability.local`, projected by Sandbox Integration onto `/capabilities/*` with a capability token distinct from inference and worker control.
- Worker-local `inference.local` remains an LLM endpoint, not a generic capability endpoint, and Sandbox Integration projects it onto `/inference/*` with its own inference token and complete AEP and lease binding.
- Family-specific routes are acceptable for the first worker capability projection. They must still produce canonical `CapabilityCall` semantics.
- `knowledge.*` is the canonical family name. The older `memory.*` implementation projection has been removed without compatibility aliases.
- Capability catalog sources should remain manifest- or file-system-first, while the AEP stores the resolved per-session projection.
- Knowledge search and read calls are not item-visible by default. They become item-visible only through context-injection, tool-call, worker-output citation, or explicit product projection.
- Process-local LLM gateway usage diagnostics are not durable usage records.
- MCP schema evidence should retain schema references, versions, and digests plus redacted call summaries; raw MCP payload retention is opt-in governed evidence, not the default.
- The first rate-limit and budget model should enforce request, token, byte, tool-call, and normalized-cost units at gateway policy boundaries, with denied calls producing stable errors and audit-capable records.

## Deferred / Future Work

- Extend the existing Sandbox Integration `capability.local` projection with thin worker clients for the initial Knowledge, artifact, and diagnostic route families without restoring a sidecar or creating a second control path.
- Add worker capability routes for external API, network, and future typed tool calls after those roadmap areas are activated.
- Add generic vault-mediated capability routes for credential classes not covered by the current non-capability Codex auth JSON runtime-file path.
- Add capability catalog schema and resolution records that distinguish canonical catalog sources from AEP snapshots.
- Implement the baseline rate-limit and budget model with stable denied or error records.
- Decide whether a generic `POST /calls` endpoint is worth adding after family-specific routes stabilize.

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
- Risk: MCP supply bypasses policy through native config files. Mitigation: generate the runtime-native MCP config of the NanoCore-managed external and built-in projection from gateway catalog entries only. Worker-owned MCP configuration inside the Sandbox is the worker's own and is not replaced by that projection.
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
- `docs/specs/20261002-operation_definition.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
