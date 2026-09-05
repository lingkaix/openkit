---
status: Accepted
implementation: Partial
---
# Worker MCP Tool Supply

## Owns

- The `mcp.*` capability route family on worker-local `capability.local`, projected through `/capabilities/mcp/*`: `mcp.list_servers`, `mcp.list_tools`, `mcp.call_tool`.
- The workspace MCP server catalog record: named server entries, transports, credential references, and tool allow rules.
- NanoCore ownership of MCP server lifecycle: spawn, connect, supervise, health, teardown.
- Gateway-side credential injection binding for MCP server calls.
- Tool schema retention: `McpToolSchemaSnapshot` records for replay and audit interpretability.
- Policy binding for `tool.use` actions and approval-required tools.
- MCP error normalization into stable capability error codes.
- Usage and audit emission for MCP capability calls.

## Does Not Own

- The worker capability plane itself: routing, envelopes, lineage, and `CapabilityCall` semantics. `docs/specs/20260703-worker_agent_capability.md` owns those; this spec owns its selected `mcp.*` route family.
- The end-user `openkit` Skill and bundled CLI. `docs/specs/20260713-openkit_agent_skill_interface.md` owns that surface. The direction matters: that spec is an external coordinator driving NanoCore through public operations, while this spec is NanoCore supplying MCP tools to worker agents. They share no transport contract, code path, record, or policy ownership.
- Vault record semantics and injection plan shapes (`docs/specs/20260703-vault_secret_injection.md`).
- Third-party non-MCP API proxying and unified network egress, which remain deferred on the roadmap.
- MCP server sandboxing/isolation, which is deferred.
- The canonical `AgentCapability` and `CapabilityCall` terms (`docs/core/agent-capability.md`).
- RelayStream, nested HTTP/2, Sandbox Integration, route credentials, or NanoHost lifecycle, which belong to `docs/specs/20260802-nanohost_runtime_and_transport.md`.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

## Summary

Worker agents need MCP tools, and the product vision routes all worker access to external systems through Core-governed gateways. This spec defines the accepted MCP plane for worker traffic: workers never connect to MCP servers directly; they call `mcp.*` operations on worker-local `capability.local`, Sandbox Integration carries them through `/capabilities/mcp/*` with the distinct capability token, and NanoCore owns the servers, credentials, policy checks, audit trail, and tool schema history.

In the accepted target, MCP servers are declared once in a workspace-scoped catalog and referenced by name from agent manifests, mirroring the workspace data source catalog pattern: endpoints and launch configs never appear inline in manifests. Every `mcp.call_tool` request produces one `CapabilityCall`; exactly one `UsageRecord` is produced unless upstream is proved not contacted; tool schemas are snapshotted per server version so calls stay interpretable after servers change; credentials are injected at the gateway with `gateway-only` visibility and never reach worker sandboxes.

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

`docs/specs/20260703-worker_agent_capability.md` establishes `capability.local` as the worker-local capability API. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns its `/capabilities/*` carriage and keeps its credential and semantics distinct from `/inference/*` and `/worker-control/*`. This spec owns the selected-MCP contract; third-party auth proxying and network egress remain independently deferred. The Current Implementation Projection separates implemented MCP behavior from pending acceptance and release closure.

The workspace data source catalog (`docs/specs/20260704-workspace_data_source_catalog.md`) already set the pattern this spec mirrors: declare a named resource once at workspace scope, reference it by name everywhere, never inline endpoints in manifests.

## Decision

- All worker MCP access flows through worker-local `capability.local`, projected by Sandbox Integration through `/capabilities/mcp/*` to the NanoCore capability gateway. Direct worker-to-MCP-server connections are prohibited in every deployment shape.
- MCP servers are declared in a workspace-scoped catalog (with read-only projection of server-scoped shared entries) and referenced by name from agent manifests.
- NanoCore owns MCP server lifecycle: it spawns stdio servers and connects to HTTP servers; workers never hold server handles.
- Credentials resolve from vault references at the gateway with `gateway-only` visibility.
- Every `mcp.call_tool` request produces one `CapabilityCall`; exactly one `UsageRecord` is produced unless upstream is proved not contacted. Tool schemas are snapshotted per server version.
- `tool.use` is the policy-kernel action for `mcp.call_tool`; the default posture is deny-unless-enabled at the catalog level plus policy allow at call level.

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

### Routes On `capability.local`

Three operations occupy the current narrow capability plane, using the envelope, lineage, authentication, and verification rules owned by the worker capability spec:

- `mcp.list_servers`: returns the servers enabled for this AgentSession — entry names, transport kind, health state, and tool-name summaries only. No endpoints, no launch configs, no credential hints.
- `mcp.list_tools`: returns the tool schemas for one named server, served from the current `McpToolSchemaSnapshot` (see below), not live from the server, so listing is deterministic per snapshot.
- `mcp.call_tool`: invokes one tool on one named server with JSON arguments; returns the tool result or a typed error.

The native worker projection uses the one fixed loopback Integration listener. `mcp.list_servers` is exact authenticated `POST /capabilities/mcp/_list-servers` with body `{}` and returns `{ "servers": [{ "id", "transport", "health", "toolNames" }] }`; the underscore-prefixed reserved segment cannot collide with a valid catalog id. Each selected server is exposed as authenticated MCP Streamable HTTP at exact `POST /capabilities/mcp/{serverId}` for `tools/list` and `tools/call`. Sandbox Integration forwards both forms unchanged over the existing capability family, and NanoCore maps them to its private `/api/worker-capabilities/*` handlers; no endpoint, command, arguments, environment, Vault reference, credential hint, or raw schema enters the list response.

Rules:

- A session sees only servers that its resolved AEP enables; `mcp.list_servers` MUST NOT reveal disabled or out-of-scope entries.
- One complete upstream native MCP protocol response is bounded to 1 MiB on both stdio and HTTP transports before semantic parsing; this is an internal envelope allowance, not the worker-native carriage in-flight bound. The parsed tools list or tool result is bounded to 512 KiB by capability-plane policy. An oversized semantic result fails typed with `mcp-result-too-large` and a hint to route bulk output through artifacts or the data plane; the gateway MUST NOT truncate silently.
- Calls carry the full capability lineage (workspace, thread, turn, AgentSession, package snapshot); the gateway stamps the catalog entry id and schema snapshot id onto the call record.
- Timeouts are enforced at the gateway (default 60s per call, catalog-entry configurable); a timed-out call fails typed and MUST NOT leave the worker waiting on a hung server.

### Server lifecycle

- NanoCore owns the lifecycle. States: `inactive`, `starting`, `ready`, `degraded`, `failed`. Transitions are recorded as operational diagnostics; health checks run while any live session has the entry enabled.
- `stdio` servers are spawned and supervised by NanoCore on demand (first call or session start, an implementation choice) and reaped when idle past a bound. Spawned server processes run in NanoCore's host context in this slice; sandboxing them is deferred, and server trust is therefore deployment configuration — the catalog is writable only through governed workspace configuration surfaces.
- `http` servers are connected from NanoCore with pooled clients.
- A `failed` or unreachable server yields typed `mcp-server-unavailable` errors on calls, never hangs; repeated failures mark the entry `degraded` in `mcp.list_servers` output so workers can adapt.
- The current release permits one active worker slot. One catalog entry may be reused across successive AgentSessions, but this specification does not authorize concurrent worker AgentSessions, a multi-agent harness, or fleet behavior. Per-AgentSession server instances remain a deferred lifecycle option for stateful or isolation-sensitive servers.

### Credential injection

- Credential resolution happens at the gateway when NanoCore spawns or calls the server: vault references resolve through the vault backend, values land in the server's process environment (`stdio`) or request auth material (`http`), with visibility class `gateway-only` per the vault injection contract.
- Workers MUST NOT be able to obtain MCP credentials through any route: not in `mcp.list_servers`, not in error payloads, not in tool results echoing server environment. The gateway MUST apply redaction filters to tool results for known credential shapes as defense in depth.
- Vault grant revocation takes effect on the next capability call: the gateway re-checks grant validity per call (cheap check against the grant record), and revocation also triggers teardown of spawned `stdio` servers holding the revoked material in their environment.
- Every credential resolution emits `VaultUse` success or typed-failure evidence per the Vault contract; that evidence is not injection authority or proof that the MCP sink completed.

### Tool schema retention

- On first use of a server (and on detected drift under `tracking` policy), NanoCore captures a `McpToolSchemaSnapshot`: catalog entry id, server-reported identity/version when available, the full tool list with JSON schemas, a content digest, and captured-at time.
- Every `CapabilityCall` for `mcp.call_tool` records the schema snapshot id it was validated against, so calls remain interpretable for replay and audit after servers change.
- Schema drift handling follows the entry's pin policy: `pinned` entries fail calls typed with `mcp-schema-drift` until an operator re-pins; `tracking` entries record a diagnostic, capture a new snapshot, and continue.
- Tool arguments are validated against the snapshot schema at the gateway before the server is called; validation failures are typed `mcp-invalid-arguments` and never reach the server.

### Policy binding

- `tool.use` is the policy-kernel action for `mcp.call_tool`. Policy associations MAY scope by catalog entry name and tool name; the decision context includes the standard capability lineage.
- Default posture: deny-unless-enabled at the catalog level (an entry not enabled for the workspace/agent yields no access at all) plus policy allow at call level (an enabled entry still requires an `allow` decision for `tool.use`).
- Tools marked `approval-required` use the existing human-attention gate mechanism (`docs/specs/20260531-human_attention_intervention_model.md`) without resuming an AgentSession. The first call creates the exact Approval Gate, which immediately changes the Product Turn to `awaiting_human` and blocks every later same-Turn capability admission before upstream contact, then terminalizes its `CapabilityCall` as `denied` and asks the delivered Codex `session-continuity` Harness path to durably enqueue the existing private `turn.interrupt` with `purpose="human-gate"`; the MCP handler waits only for that enqueue and returns the typed denial without waiting for child absence. An already accepted terminal worker outcome that wins stop admission creates no Harness operation. Once stop admission wins, the one existing Harness operation settles asynchronously without redelivery, and terminal cleanup waits for that settlement before session inspection. Only the resulting exact Gate-owned `blocked/ask_user` outcome plus backend cleanup and Workspace handoff makes the Worker Gate acknowledged and actionable and moves its checkpoint to `waiting_for_user`; the Turn was already `awaiting_human` from Gate creation. If enqueue is not proved because terminal wins, validation rejects, or the process exits between Gate/call persistence and enqueue, the Gate, request Item, denied call, actual worker outcome, and unchanged non-waiting checkpoint remain truthful; the existing final-status, scheduler, backend cleanup, reconnect, and fencing owners retain the attempt and capacity until they can prove cleanup, while checkpoint/readiness and the Gate project inspect-only `recovery_required`. Restart applies the same tuple classification. No approval response, bounded-turn command, synthetic Gate, cross-store transaction, automatic repair, stop reconstruction, blind retry, or settlement row is authorized for that partial state, and an already upstream-contacting concurrent call retains its own truthful terminal outcome. The Approval expires exactly one hour after Gate creation for one exact proposed effect: Workspace, Thread, responsible user, Agent, server, tool, canonical argument digest, catalog-entry revision, schema snapshot, and expiry. A later call in a new Turn and successor AgentSession rechecks current `tool.use` authority and MAY claim that unique granted, unexpired, unconsumed Approval without carrying its id through the Worker protocol. The CapabilityCall id is derived from the Approval id before upstream contact and supplies the durable one-shot claim. Its fresh `allow` PermissionDecision does not reuse the Approval id; its context links the prior granted terminal PermissionDecision and current CapabilityCall. A changed tuple, concurrent loser, retry after claim, or second call requires a new Approval.
- Denials are typed (`mcp-denied`) and audited; the gateway MUST NOT reveal whether the denial came from catalog, policy, or approval in the worker-visible error beyond the typed code.

### Error normalization

- MCP protocol errors, transport failures, timeouts, and server crashes map to a small closed set of capability error codes: `mcp-server-unavailable`, `mcp-tool-not-found`, `mcp-invalid-arguments`, `mcp-call-failed`, `mcp-result-too-large`, `mcp-schema-drift`, `mcp-denied`, `mcp-timeout`.
- MCP-native error payloads, server stderr, and stack traces are preserved only in redacted diagnostics and restricted evidence; they MUST NOT appear in worker-visible errors or product surfaces.

### Usage and audit

- Every `mcp.call_tool` request produces one `CapabilityCall` record; exactly one `UsageRecord` is produced unless upstream is proved not contacted (`category: "tool"`, `unit: "tool_calls"`, quantity `1`; payload byte counts as auxiliary quantities when measured) per `docs/specs/20260703-audit_usage_evidence_records.md` and `docs/specs/20260704-capability_usage_gateway_foundation.md`, fully attributed through the standard order in `docs/core/agent-capability.md`.
- `mcp.list_servers` and `mcp.list_tools` are capability calls for audit purposes but do not emit usage rows.
- Server lifecycle transitions, schema snapshot captures, and credential-bearing spawns emit audit events.
- Usage rows and audit rows MUST NOT contain tool arguments or results; those belong to redacted diagnostics and restricted evidence per the audit spec's visibility split.

## Accepted Design

The gateway has an MCP subsystem beside the inference dispatcher: the existing workspace-scoped catalog, a bounded stdio and HTTP client supervisor, a schema snapshot store, and the three operation handlers that compose validation → policy → optional approval → dispatch → normalization → usage/audit emission. Its MCP implementation uses the existing official SDK as an internal worker-capability dependency and does not depend on the removal-only user-facing MCP package or inherit an end-user transport contract. A deterministic stub MCP server supplies focused L1–L3 checks.

## Current Implementation Projection

The executable plane implements exactly the three selected-MCP routes. NanoCore exposes authenticated `/capabilities/mcp/*` handlers, validates selected catalog and schema lineage, applies policy and approval, runs the bounded upstream stdio call, and records capability, usage, and audit outcomes. Sandbox Integration carries the separate capability token over its existing nested session and fixed native listener, while the Codex adapter projects only selected server ids through fixed loopback URLs. No direct worker-to-server connection or worker-visible upstream credential exists.

NanoCore loads the strict Workspace-owned `mcp-servers.jsonc` catalog through the deployment-admin runtime-config surface, selects it by the actual dequeued Turn's Workspace at scheduler dispatch, and projects only selected server ids, catalog digests, tool rules, approval marks, and schema policy into AEP supply. Selected supply enables only the three named routes; no selected supply keeps the plane disabled. Focused route, policy, schema, usage, transport, and adapter checks cover the implementation. The built NanoCore L5 smoke starts a disposable public Task, real stdio MCP child, native NanoHost carriage, and official SDK client and proves durable call, schema, policy, usage, audit, Item, backend, lease, process-reaping, listener-close, and temporary-root cleanup outcomes. Release closure separately consumes the admitted real-Codex Web L6 story and its retained multi-run evidence.

## Alternatives Considered

- Direct worker-to-MCP-server connections with credentials injected into the sandbox. Rejected: it bypasses policy and audit, puts credentials within sandbox reach (exactly what the vault boundary exists to prevent), and makes every backend responsible for MCP transport.
- Embedding MCP protocol or server lifecycle in the worker runtime. Rejected: the worker client stays a thin local caller while NanoCore owns MCP transport, policy, credentials, lifecycle, and records.
- Per-turn ephemeral server spawn as the default lifecycle. Rejected as default: spawn cost per turn is wasteful for stateless servers; retained as a deferred per-session lifecycle option for stateful or isolation-sensitive servers.
- Waiting for every unified-proxy family. Rejected: MCP may be implemented from this accepted contract once the capability-plane foundation is rebuilt; third-party auth proxying and network egress remain independently deferred.

## Consequences

- Workers receive selected tool supply only through the implemented governed Gateway path; broader capability families remain absent.
- NanoCore takes on MCP server supervision (process management, health, reaping) — a real operational surface.
- MCP server processes run trusted in this slice; deployments must treat catalog write access accordingly until server sandboxing lands.
- Tool schema snapshots add storage but make audit and replay honest against moving servers.

## Rollout / Migration Plan

No compatibility path exists. The implementation follows the accepted order: fail-closed capability projection and thin client; catalog, manifest reference, and AEP selection; stdio lifecycle plus listing against schema snapshots; governed tool calls with usage and audit; HTTP transport and gateway-only Vault credentials; then approval-required Human Gate closeout. The roadmap remains pending until final package, deterministic story, and independent release gates pass.

## Testing Strategy / Acceptance Criteria

Mapped to `docs/specs/20260529-test_strategy.md`, using a deterministic stub MCP server harness:

- L0: schema-drift checks for catalog entry, schema snapshot, and route payload shapes; lint that no `memory` vocabulary and no MCP-native error strings appear in public schemas.
- L1: unit tests for argument validation against snapshots, pin-policy drift behavior, error normalization mapping, redaction filters, idle reaping and teardown-on-revocation triggers.
- L2: contract tests on the capability plane: full lineage on every call record; schema snapshot id stamped; usage rows validate against `UsageRecordSchema` with `category: "tool"` and `unit: "tool_calls"`; denial paths yield only typed codes; canary credential values planted in server environment never appear in any worker-visible payload.
- L3: NanoCore black-box tests: end-to-end call through a spawned stub server; server crash mid-call fails typed without hanging the turn; grant revocation tears down the spawned server and the next call fails typed; an approval-required first call creates the exact Gate and denied `CapabilityCall`, makes no upstream contact, durably enqueues one non-redelivered `purpose="human-gate"` stop, rejects another same-Turn capability admission, settles the Worker as Gate-owned `blocked/ask_user` only after cleanup and handoff, and lets a different successor AgentSession in a new Turn claim one exact granted effect without an approval id; neither a second call nor changed arguments reuse it; oversized result fails typed; `pinned` entry fails on drifted stub schema until re-pinned.
- L5: smoke: packaged build spawns the stub server and completes one governed tool call.
- L6: story acceptance: public `task.start` drives a real checkpoint, lease, AEP, session-continuity backend, worker-control lineage, and catalog-declared MCP tool; the marked call stops at its exact Approval Gate with no upstream contact, reaches `awaiting-human`, closes the source Turn and AgentSession without reuse after the decision, and only a separately authorized new Task Turn and successor AgentSession can execute the granted effect; audit shows the full call chain with no credential or raw payload leakage.

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
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/core/agent-capability.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/roadmap.md`
