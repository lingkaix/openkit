# Worker MCP Tool Supply

Status: Accepted
Implementation: Implemented

## Owns

- The `mcp.*` capability route family on `capability.local`: `mcp.list_servers`, `mcp.list_tools`, `mcp.call_tool`.
- The workspace MCP server catalog record: named server entries, transports, credential references, and tool allow rules.
- NanoCore ownership of MCP server lifecycle: spawn, connect, supervise, health, teardown.
- Gateway-side credential injection binding for MCP server calls.
- Tool schema retention: `McpToolSchemaSnapshot` records for replay and audit interpretability.
- Policy binding for `mcp.call` actions and approval-required tools.
- MCP error normalization into stable capability error codes.
- Usage and audit emission for MCP capability calls.

## Does Not Own

- The worker capability plane itself: routing, envelopes, lineage, and `CapabilityCall` semantics. `docs/specs/20260703-worker_agent_capability.md` owns those; this spec fills its deferred `mcp.*` routes.
- The `@openkit/mcp` product control channel. `docs/specs/20260617-openkit_ai_interface.md` owns that surface. The direction matters: that spec is an external coordinator driving NanoCore through MCP; this spec is NanoCore supplying MCP tools TO worker agents. The two share the MCP protocol and nothing else — no code path, record, or policy of one may be reused as the other's contract.
- Vault record semantics and injection plan shapes (`docs/specs/20260703-vault_secret_injection.md`).
- Third-party non-MCP API proxying and unified network egress, which remain deferred on the roadmap.
- MCP server sandboxing/isolation, which is deferred.
- The canonical `AgentCapability` and `CapabilityCall` terms (`docs/core/agent-capability.md`).

## Core References

- `docs/core/agent-capability.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

## Summary

Worker agents need MCP tools, and the product vision routes all worker access to external systems through Core-governed gateways. This spec activates the MCP plane of that unified-proxy direction for worker traffic: workers never connect to MCP servers directly; they call `mcp.*` routes on `capability.local`, and NanoCore owns the servers, the credentials, the policy checks, the audit trail, and the tool schema history.

MCP servers are declared once in a workspace-scoped catalog and referenced by name from agent manifests, mirroring the workspace data source catalog pattern: endpoints and launch configs never appear inline in manifests. Every tool call is one `CapabilityCall` with a `UsageRecord`; tool schemas are snapshotted per server version so calls stay interpretable after servers change; credentials are injected at the gateway with `gateway-only` visibility and never reach worker sandboxes.

## Goals / Non-goals

### Goals

- Give workers governed MCP tool access with the same audit, policy, and credential guarantees as every other capability route.
- Keep MCP server topology out of agent manifests via a named catalog.
- Make every MCP tool call attributable, replayable, and interpretable after the fact.
- Fail typed and fast on server failures instead of hanging worker turns.
- Keep MCP credentials invisible to workers under all failure modes.

### Non-goals

- Do not build a general third-party API proxy or network egress plane; those stay roadmap-deferred.
- Do not sandbox MCP server processes in this slice; server trust is deployment configuration.
- Do not expose MCP server internals, endpoints, or native errors to product surfaces or workers.
- Do not stream partial tool results in v1; calls are request/response with bounded payloads.
- Do not use `memory` vocabulary anywhere; these routes sit beside the future `knowledge.*` routes after the rename.

## Background

`docs/specs/20260703-worker_agent_capability.md` establishes `capability.local` as the single worker-visible capability endpoint and lists the `mcp.*` route family as deferred. The product vision (§6.5) defines a unified proxy whose MCP plane gives agents authenticated, access-controlled, rate-limitable, audited MCP access. The roadmap deferred the full unified proxy; this spec deliberately activates only its MCP plane for worker traffic, because "agents as teammates" with no tool supply beyond inference is too thin for V1, while third-party auth proxying and network egress can still wait.

The workspace data source catalog (`docs/specs/20260704-workspace_data_source_catalog.md`) already set the pattern this spec mirrors: declare a named resource once at workspace scope, reference it by name everywhere, never inline endpoints in manifests.

## Decision

- All worker MCP access flows through the NanoCore agent capability gateway on `capability.local`. Direct worker-to-MCP-server connections are prohibited in every deployment shape.
- MCP servers are declared in a workspace-scoped catalog (with read-only projection of server-scoped shared entries) and referenced by name from agent manifests.
- NanoCore owns MCP server lifecycle: it spawns stdio servers and connects to HTTP servers; workers never hold server handles.
- Credentials resolve from vault references at the gateway with `gateway-only` visibility.
- Every `mcp.call_tool` is one `CapabilityCall` producing one `UsageRecord`; tool schemas are snapshotted per server version.
- `mcp.call` is a policy-kernel action; the default posture is deny-unless-enabled at the catalog level plus policy allow at call level.

## Contract / Expected Behavior

### MCP server catalog

An `McpServerCatalogEntry` is a workspace-owned record declaring one MCP server. It MUST carry:

- entry name: a workspace-unique, lowercase kebab-case identifier; the only handle manifests may use
- transport: `stdio` | `http`
- for `stdio`: launch command, arguments, environment template (with vault reference placeholders, never secret values)
- for `http`: endpoint URL and auth binding (vault reference plus injection shape: header or query)
- credential vault references (zero or more)
- tool rules: allowlist and/or denylist of tool names, and per-tool `approval-required` marks
- enablement flag and scope: `workspace` or a read-only projection of a `server` shared entry
- schema version pin policy: `pinned` (calls fail on schema drift until re-pinned) or `tracking` (drift produces a diagnostic and a new snapshot)

Rules:

- Endpoints, launch commands, and credentials MUST NOT appear inline in agent manifests; manifests reference entries by name only, following the data source catalog pattern.
- Server-scoped shared entries are deployment configuration projected into workspaces read-only; a workspace MAY disable but not edit them.
- Catalog entries carry no secret material; credential slots are vault references per `docs/core/vault.md`.

### Routes on capability.local

Three routes join the capability plane, using its existing envelope, lineage, authentication, and verification rules (owned by the worker capability spec):

- `mcp.list_servers`: returns the servers enabled for this agent session — entry names, transport kind, health state, and tool-name summaries only. No endpoints, no launch configs, no credential hints.
- `mcp.list_tools`: returns the tool schemas for one named server, served from the current `McpToolSchemaSnapshot` (see below), not live from the server, so listing is deterministic per snapshot.
- `mcp.call_tool`: invokes one tool on one named server with JSON arguments; returns the tool result or a typed error.

Rules:

- A session sees only servers that its resolved AEP enables; `mcp.list_servers` MUST NOT reveal disabled or out-of-scope entries.
- `mcp.call_tool` responses are size-bounded (bound set by capability-plane policy). Oversized results fail typed with `mcp-result-too-large` and a hint to route bulk output through artifacts or the data plane; the gateway MUST NOT truncate silently.
- Calls carry the full capability lineage (workspace, thread, turn, agent session, package snapshot); the gateway stamps the catalog entry id and schema snapshot id onto the call record.
- Timeouts are enforced at the gateway (default 60s per call, catalog-entry configurable); a timed-out call fails typed and MUST NOT leave the worker waiting on a hung server.

### Server lifecycle

- NanoCore owns the lifecycle. States: `inactive`, `starting`, `ready`, `degraded`, `failed`. Transitions are recorded as operational diagnostics; health checks run while any live session has the entry enabled.
- `stdio` servers are spawned and supervised by NanoCore on demand (first call or session start, an implementation choice) and reaped when idle past a bound. Spawned server processes run in NanoCore's host context in this slice; sandboxing them is deferred, and server trust is therefore deployment configuration — the catalog is writable only through governed workspace configuration surfaces.
- `http` servers are connected from NanoCore with pooled clients.
- A `failed` or unreachable server yields typed `mcp-server-unavailable` errors on calls, never hangs; repeated failures mark the entry `degraded` in `mcp.list_servers` output so workers can adapt.
- One catalog entry MAY serve many concurrent sessions; per-session isolation of server-side state is NOT guaranteed by this contract, and entries whose tools are stateful should be documented as such by their operators. (Per-session server instances are a deferred lifecycle option.)

### Credential injection

- Credential resolution happens at the gateway when NanoCore spawns or calls the server: vault references resolve through the vault backend, values land in the server's process environment (`stdio`) or request auth material (`http`), with visibility class `gateway-only` per the vault injection contract.
- Workers MUST NOT be able to obtain MCP credentials through any route: not in `mcp.list_servers`, not in error payloads, not in tool results echoing server environment. The gateway MUST apply redaction filters to tool results for known credential shapes as defense in depth.
- Vault grant revocation takes effect on the next capability call: the gateway re-checks grant validity per call (cheap check against the grant record), and revocation also triggers teardown of spawned `stdio` servers holding the revoked material in their environment.
- Every credential resolution emits `VaultUse` per the vault specs.

### Tool schema retention

- On first use of a server (and on detected drift under `tracking` policy), NanoCore captures a `McpToolSchemaSnapshot`: catalog entry id, server-reported identity/version when available, the full tool list with JSON schemas, a content digest, and captured-at time.
- Every `CapabilityCall` for `mcp.call_tool` records the schema snapshot id it was validated against, so calls remain interpretable for replay and audit after servers change.
- Schema drift handling follows the entry's pin policy: `pinned` entries fail calls typed with `mcp-schema-drift` until an operator re-pins; `tracking` entries record a diagnostic, capture a new snapshot, and continue.
- Tool arguments are validated against the snapshot schema at the gateway before the server is called; validation failures are typed `mcp-invalid-arguments` and never reach the server.

### Policy binding

- `mcp.call` is a policy-kernel action. Policy associations MAY scope by catalog entry name and tool name; the decision context includes the standard capability lineage.
- Default posture: deny-unless-enabled at the catalog level (an entry not enabled for the workspace/agent yields no access at all) plus policy allow at call level (an enabled entry still requires an `allow` decision for `mcp.call`).
- Tools marked `approval-required` route through the existing human-attention gate mechanism (`docs/specs/20260531-human_attention_intervention_model.md`): the call blocks at the gateway, an approval row is raised, and the decision is recorded as a `PermissionDecision` linked to the capability call. Approval MAY be granted per-call or per-session-per-tool per policy.
- Denials are typed (`mcp-denied`) and audited; the gateway MUST NOT reveal whether the denial came from catalog, policy, or approval in the worker-visible error beyond the typed code.

### Error normalization

- MCP protocol errors, transport failures, timeouts, and server crashes map to a small closed set of capability error codes: `mcp-server-unavailable`, `mcp-tool-not-found`, `mcp-invalid-arguments`, `mcp-call-failed`, `mcp-result-too-large`, `mcp-schema-drift`, `mcp-denied`, `mcp-timeout`.
- MCP-native error payloads, server stderr, and stack traces are preserved only in redacted diagnostics and restricted evidence; they MUST NOT appear in worker-visible errors or product surfaces.

### Usage and audit

- Every `mcp.call_tool` produces one `CapabilityCall` record and one `UsageRecord` (`category: "tool"`, `unit: "tool_calls"`, quantity `1`; payload byte counts as auxiliary quantities when measured) per `docs/specs/20260703-audit_usage_evidence_records.md` and `docs/specs/20260704-capability_usage_gateway_foundation.md`, fully attributed through the standard order in `docs/core/agent-capability.md`.
- `mcp.list_servers` and `mcp.list_tools` are capability calls for audit purposes but do not emit usage rows.
- Server lifecycle transitions, schema snapshot captures, and credential-bearing spawns emit audit events.
- Usage rows and audit rows MUST NOT contain tool arguments or results; those belong to redacted diagnostics and restricted evidence per the audit spec's visibility split.

## Accepted Design

The gateway grows an MCP subsystem beside the inference dispatcher: a catalog store (workspace-scope records), a server supervisor (spawn/connect, health, idle reaping, teardown-on-revocation), a schema snapshot store, and the three route handlers that compose validation → policy → (approval) → dispatch → normalization → usage/audit emission. The MCP client implementation uses the same protocol library as `@openkit/mcp` where practical, but as an internal dependency only — no shared public contract. A deterministic stub MCP server ships in the test harness for L1–L3.

## Current Implementation Projection

The implementation is complete for this accepted V1 slice. NanoCore resolves catalog-owned MCP server supply into Agent Environment Packages, and authenticated worker sessions can call `POST /api/worker-capabilities/mcp/list-servers`, `POST /api/worker-capabilities/mcp/list-tools`, and `POST /api/worker-capabilities/mcp/call-tool`. These routes are bound to the registered package snapshot. List routes expose only server id, transport, health, tool names, schema snapshot id, and AEP-supplied product-safe JSON Schemas, and they record durable `capability_calls` with `family: "mcp"` and no usage rows. The current `call-tool` route accepts a workspace-scoped immutable `PermissionDecision` id or a granted approval request id whose resulting row is `action: "mcp.call"`, `result: "allow"`, and whose redacted resource summary matches the requested workspace, server id, and tool name. Denied or missing decisions fail typed with `mcp-denied` before usage rows are written. Tools marked in the AEP as `approvalRequiredTools` create a policy-originated Action Center approval on first call when no authorization handle is supplied, return a pending approval response, and execute only after the generic approval response path records an approval-linked `mcp.call` allow decision. Allowed calls enforce the AEP tool allowlist, validate arguments against the tool JSON Schema snapshot with Ajv before dispatch, dispatch stdio MCP calls through a NanoCore-owned newline-delimited JSON-RPC gateway (`initialize`, pinned `tools/list` schema check, then `tools/call`), dispatch HTTP MCP calls through request/response JSON-RPC over `POST`, inject V1 GitHub credentials only for MCP snapshots that declare `provider_github_read` by passing host `GITHUB_TOKEN`/`GH_TOKEN` into stdio child processes and an HTTP `Authorization` header into HTTP calls, fail typed with `mcp-schema-drift` when the live tool schema differs from the AEP snapshot, redact credential-shaped structured result fields before returning them to workers, reject oversized structured results with `mcp-result-too-large` instead of truncating, normalize JSON-RPC tool failures to `mcp-call-failed`, normalize missing executables, early server exits, stdin write failures, failed HTTP requests, non-2xx HTTP responses, and stdio exits during `tools/call` to `mcp-server-unavailable`, record durable `capability_calls` with `operation: "mcp.call_tool"`, mark gateway and validation failures as failed capability calls with stable redacted `error_code` values and no usage rows, and emit one `UsageRecord` with `category: "tool"` and `unit: "tool_calls"` only after successful dispatch. Route-level coverage now includes an end-to-end call through a spawned stdio stub server using the default gateway and a spawned stdio crash path that fails typed without hanging or writing usage. The built-artifact NanoCore smoke script now imports the compiled default MCP gateway, spawns a deterministic stdio stub, and completes one schema-pinned tool call. The L6 catalog includes `tests/stories/worker-mcp-governed-tool-use.story.md` as the agentic acceptance story for governed MCP tool calls, approval-required tools, audit evidence, usage rows, and credential redaction.

`@openkit/worker-shim` exposes `listMcpServers()`, `listMcpTools()`, and `callMcpTool()` over the sandbox-local capability client. `callMcpTool()` sends either a policy decision id or an approval request id when the caller has one. NanoCore now stores workspace-scoped `mcp_tool_schema_snapshots` rows for AEP-served tool schemas and for live schemas observed by the default stdio/http gateway during pinned `tools/list` checks. These snapshot rows store only product-safe catalog entry ids, source refs, server versions, content digests, tool names, and input schemas; launch commands, URLs, vault refs, credentials, tool arguments, and tool results are not stored. The default gateway now reuses initialized stdio MCP server processes across calls, serializes calls per process, drops failed or exited processes from its cache, and projects stdio server health back into `mcp.list_servers`; an unavailable stdio call turns the server health from `ready` to `degraded` for that gateway instance until a later successful call restores `ready`. When a referenced vault grant exists in Core DB and is revoked or expired, the durable `mcp.call_tool` path closes the matching gateway server resources and fails typed with `mcp-denied` before another server call can reuse stale credential material. Durable `mcp.call_tool` now resolves gateway-only GitHub MCP credentials from active vault grants when the process vault backend is unlocked, writes a non-secret gateway-only `InjectionPlan`, `InjectionReceipt`, and `VaultUse`, passes the material only to the private gateway env/header channel, and still falls back to the V1 host-env bridge when no vault-backed grant is available.

## Alternatives Considered

- Direct worker-to-MCP-server connections with credentials injected into the sandbox. Rejected: it bypasses policy and audit, puts credentials within sandbox reach (exactly what the vault boundary exists to prevent), and makes every backend responsible for MCP transport.
- Embedding an MCP client in the worker sidecar. Rejected: the sidecar stays subordinate and control-focused per the worker runtime communication model; a sidecar MCP client would become a second capability plane.
- Per-turn ephemeral server spawn as the default lifecycle. Rejected as default: spawn cost per turn is wasteful for stateless servers; retained as a deferred per-session lifecycle option for stateful or isolation-sensitive servers.
- Waiting for the full unified proxy design. Rejected: the capability plane already provides the governance substrate; MCP supply composes with it today, while third-party auth proxying and network egress genuinely need the deferred capability catalog and budget model.

## Consequences

- Workers gain real tool supply with uniform governance; the unified proxy's MCP plane exists for worker traffic without waiting for the full proxy design.
- NanoCore takes on MCP server supervision (process management, health, reaping) — a real operational surface.
- MCP server processes run trusted in this slice; deployments must treat catalog write access accordingly until server sandboxing lands.
- Tool schema snapshots add storage but make audit and replay honest against moving servers.

## Rollout / Migration Plan

New machinery, no compatibility path. Order: (1) catalog entry schema, manifest reference field, and AEP resolution of enabled entries; (2) `stdio` lifecycle plus `mcp.list_servers`/`mcp.list_tools` against schema snapshots; (3) `mcp.call_tool` with policy, validation, normalization, usage, and audit; (4) `http` transport and credential injection via the vault backend; (5) approval-required tools through the human-attention gate. The roadmap's unified proxy entry is updated to record the MCP plane as active for worker traffic while third-party and egress planes stay deferred.

## Testing Strategy / Acceptance Criteria

Mapped to `docs/specs/20260529-test_strategy.md`, using a deterministic stub MCP server harness:

- L0: schema-drift checks for catalog entry, schema snapshot, and route payload shapes; lint that no `memory` vocabulary and no MCP-native error strings appear in public schemas.
- L1: unit tests for argument validation against snapshots, pin-policy drift behavior, error normalization mapping, redaction filters, idle reaping and teardown-on-revocation triggers.
- L2: contract tests on the capability plane: full lineage on every call record; schema snapshot id stamped; usage rows validate against `UsageRecordSchema` with `category: "tool"` and `unit: "tool_calls"`; denial paths yield only typed codes; canary credential values planted in server environment never appear in any worker-visible payload.
- L3: NanoCore black-box tests: end-to-end call through a spawned stub server; server crash mid-call fails typed without hanging the turn; grant revocation tears down the spawned server and the next call fails typed; approval-required tool blocks, approves, and executes with linked decision records; oversized result fails typed; `pinned` entry fails on drifted stub schema until re-pinned.
- L5: smoke: packaged build spawns the stub server and completes one governed tool call.
- L6: story acceptance: a worker task uses a catalog-declared MCP tool, the human sees the approval gate for a marked tool, and audit shows the full call chain with no credential or raw payload leakage.

Acceptance: no path exposes credentials or endpoints to workers; every call is attributable and schema-interpretable; failures are always typed and bounded in time.

## Risks & Mitigations

- Risk: trusted MCP server processes become a privilege-escalation vector. Mitigation: catalog writes are governed workspace configuration; server sandboxing is explicit deferred work with the trust posture documented until then.
- Risk: schema snapshots bloat storage for churning servers. Mitigation: snapshots are content-addressed by digest; identical schemas dedupe; `tracking` entries cap retained snapshots.
- Risk: shared server state leaks across sessions. Mitigation: the contract states no per-session isolation guarantee; stateful entries are documented, and the per-session lifecycle option is reserved.
- Risk: this plane drifts into a general API proxy by accretion. Mitigation: routes are MCP-protocol-only by contract; third-party auth proxying stays roadmap-gated.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: `stdio` MCP servers spawn on first call rather than session start; `mcp.list_tools` does not support pagination in V1 and relies on the control payload bound, so very large tool sets must be split, filtered, or rejected with typed diagnostics until catalog pagination is designed.

## Deferred / Future Work

- MCP server process sandboxing and resource limits.
- Per-session server instances for stateful or isolation-sensitive servers.
- Streaming tool results.
- Remote MCP marketplace/registry integration and server trust metadata.
- Rate limits per server/tool once the capability catalog and budget model exist.

## Links

- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260617-openkit_ai_interface.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/core/agent-capability.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/roadmap.md`
