---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-09-30
---
# Worker MCP Tool Supply

## Owns

- The `mcp.*` capability route family on worker-local `capability.local`, projected through `/capabilities/mcp/*`: `mcp.list_servers`, `mcp.list_tools`, `mcp.call_tool`.
- The effective Workspace MCP server catalog projection: named server entries, transports, credential references, tool rules, and current digest validation for Gateway execution.
- NanoCore ownership of MCP server lifecycle: spawn, connect, supervise, health, teardown.
- Gateway-side credential injection binding for MCP server calls.
- Tool schema retention: `McpToolSchemaSnapshot` records for replay and audit interpretability.
- Policy binding for `tool.use` actions and approval-required tools, including the gateway's capture, re-evaluation, and execution of an approved call.
- The Turn-boundary tool snapshot a worker sees, and the built-in `openkit-work` server's supply and dispatch seam.
- MCP error normalization into stable capability error codes.
- Usage and audit emission for MCP capability calls.

## Does Not Own

- Immutable MCP configuration history, current-version selection, catalog mutations, and binding ownership, which belong to `docs/specs/20260907-mcp_catalog_management.md`; public packaging and grouped installation belong to `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`.

- The worker capability plane itself: routing, envelopes, lineage, and `CapabilityCall` semantics. `docs/specs/20260703-worker_agent_capability.md` owns those; this spec owns its selected `mcp.*` route family.
- The end-user `openkit` Skill and bundled CLI. `docs/specs/20260713-openkit_agent_skill_interface.md` owns that surface. The direction matters: that spec is an external coordinator driving NanoCore through public operations, while this spec is NanoCore supplying MCP tools to worker agents. They share no transport contract, code path, record, or policy ownership.
- Vault record semantics and injection plan shapes (`docs/specs/20260703-vault_secret_injection.md`).
- Third-party non-MCP API proxying and unified network egress, which remain deferred on the roadmap.
- MCP server sandboxing/isolation, which is deferred.
- MCP servers and tools configured inside the worker's Sandbox, which are the worker's own under [Full Permission Inside The Sandbox](../decisions/20260930-full_permission_inside_the_sandbox.md) and are not governed here unless they themselves call an integrated external system.
- The pending request record, its lifecycle, and its delivery, owned by [Pending Requests](20260930-pending_requests.md).
- The canonical `AgentCapability` and `CapabilityCall` terms (`docs/core/agent-capability.md`).
- RelayStream, nested HTTP/2, Sandbox Integration, route credentials, or NanoHost lifecycle, which belong to `docs/specs/20260802-nanohost_runtime_and_transport.md`.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

## Summary

Worker agents need MCP tools, and the product vision routes all worker access to integrated external systems through Core-governed gateways. This spec defines the accepted MCP plane for that traffic: a worker reaches catalog and built-in MCP servers only through NanoCore, whose gateway serves them at worker-local loopback endpoints that the runtime loads as MCP servers; the runtime presents the session capability loopback credential, and Sandbox Integration carries the request through `/capabilities/mcp/*` under the capability route token of the Turn bound when it arrives, as [Worker Agent Capability](20260703-worker_agent_capability.md) defines; NanoCore owns the servers, credentials, policy checks, audit trail, and tool schema history. MCP servers the worker configures inside its own Sandbox are outside this plane.

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
- Do not expose MCP server internals, endpoints, or native errors to workers or ordinary product summaries. Deployment-admin raw configuration inspection remains a restricted management operation under the MCP catalog owner.
- Do not stream partial tool results in v1; calls are request/response with bounded payloads.
- Do not use `memory` vocabulary anywhere; these routes sit beside the future `knowledge.*` routes after the rename.

## Background

`docs/specs/20260703-worker_agent_capability.md` establishes `capability.local` as the worker-local capability API. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns its `/capabilities/*` carriage and keeps its credential and semantics distinct from `/inference/*` and `/worker-control/*`. This spec owns the selected-MCP contract; third-party auth proxying and network egress remain independently deferred. The Current Implementation Projection separates implemented MCP behavior from pending acceptance and release closure.

The workspace data source catalog (`docs/specs/20260704-workspace_data_source_catalog.md`) already set the pattern this spec mirrors: declare a named resource once at workspace scope, reference it by name everywhere, never inline endpoints in manifests.

## Decision

- All worker access to catalog and built-in MCP servers flows through worker-local `capability.local`, projected by Sandbox Integration through `/capabilities/mcp/*` to the NanoCore capability gateway. A direct worker connection to a catalog server, or to any server that holds Gateway credentials, is prohibited in every deployment shape. An MCP server or tool configured inside the worker's Sandbox is the worker's own and is not this prohibition's subject.
- External systems are integrated through the vendor's own MCP server, proxied by the gateway, which holds authentication and account and repository binding ([decision](../decisions/20260929-external_systems_through_vendor_mcp.md)).
- The gateway uses the official MCP SDK v2 packages and supports the current MCP standard, including the 2026-07-28 stateless era, on both its worker-facing and upstream faces ([decision](../decisions/20260929-gateway_adopts_current_mcp_standard.md)).
- The tool surface a worker sees is fixed at Turn admission and changes only at a Turn boundary ([decision](../decisions/20260929-tool_surface_changes_at_turn_boundaries.md)).
- An `approval-required` call returns a pending result at once, and after a grant the gateway executes the captured call ([decision](../decisions/20260930-pending_tool_calls.md)).
- MCP servers are declared in a workspace-scoped catalog (with read-only projection of server-scoped shared entries) and referenced by name from agent manifests.
- NanoCore owns catalog MCP server lifecycle: it spawns stdio servers and connects to HTTP servers; workers never hold handles to those servers.
- Credentials resolve from vault references at the gateway with `gateway-only` visibility.
- Every `mcp.call_tool` request produces one `CapabilityCall`; exactly one `UsageRecord` is produced unless upstream is proved not contacted. Tool schemas are snapshotted per server version.
- `tool.use` is the policy-kernel action for `mcp.call_tool`; the default posture is deny-unless-enabled at the catalog level plus policy allow at call level.

## Contract / Expected Behavior

### MCP server catalog

An `McpServerCatalogEntry` is the resolved Workspace-scoped projection of one exact current `McpConfigVersion` and its authorized Workspace binding. Source versions and bindings have one canonical catalog owner; this effective entry is not a separately editable copy. Its deterministic `catalogDigest` binds the effective configuration, binding, and selected package-root digest, while configuration digest, tool-schema snapshot digest, and server-reported software version remain distinct. It MUST carry:

- entry name: a workspace-unique, lowercase kebab-case identifier; the only handle manifests may use
- transport: `stdio` | `http`
- for `stdio`: launch command and separate arguments, ordinary non-secret environment, optional verified package-root and package-relative working directory, and Vault injection declarations without secret values
- for `http`: endpoint URL, ordinary non-secret fixed headers, and auth binding (Vault reference plus injection shape: header or query)
- credential vault references (zero or more)
- tool rules: allowlist and/or denylist of tool names, and per-tool `approval-required` marks
- enablement flag and scope: `workspace` or a read-only projection of a `server` shared entry
- schema version pin policy: `pinned` (calls fail on schema drift until re-pinned) or `tracking` (drift produces a diagnostic and a new snapshot)

Rules:

- Endpoints, launch commands, and credentials MUST NOT appear inline in agent manifests; manifests reference entries by name only, following the data source catalog pattern.
- Server-scoped shared entries are deployment configuration projected into workspaces read-only; a workspace MAY disable but not edit them.
- Catalog entries carry no secret material; credential slots are Vault references per `docs/core/vault.md`. Vault injection wins over colliding ordinary package headers or environment, and reserved Integration variables cannot be overridden.
- Imported stdio always uses its exact PluginVersion-owned verified source root, with default working directory, reserved subprocess variables, and restricted placeholder expansion defined by the MCP catalog owner. Mutable package data uses the current MCP binding key. Neither is worker supply or a caller-selected host directory.
- Every call rechecks current effective selection, binding, authorization, and digest. A changed or removed entry rejects stale AEP supply before upstream contact; an exact historic setup constraint does not create a parallel server version or restore old grants.

### Routes On `capability.local`

Three operations occupy the current narrow capability plane, using the envelope, lineage, authentication, and verification rules owned by the worker capability spec:

- `mcp.list_servers`: returns the servers enabled for this AgentSession — entry names, transport kind, health state, and tool-name summaries only. No endpoints, no launch configs, no credential hints.
- `mcp.list_tools`: returns the tool schemas for one named server, served from the snapshot fixed for the current Turn (see Tool schema retention), not live from the server, so listing is deterministic within a Turn.
- `mcp.call_tool`: invokes one tool on one named server with JSON arguments; returns the tool result or a typed error.

The native worker projection uses the one fixed loopback Integration listener. `mcp.list_servers` is exact authenticated `POST /capabilities/mcp/_list-servers` with body `{}` and returns `{ "servers": [{ "id", "transport", "health", "toolNames" }] }`; the underscore-prefixed reserved segment cannot collide with a valid catalog id. Each selected server is exposed as authenticated MCP Streamable HTTP at exact `POST /capabilities/mcp/{serverId}` for `tools/list` and `tools/call`, served statelessly with one JSON response per request, and negotiated by the SDK for both the session and stateless protocol eras. Sandbox Integration forwards both forms unchanged over the existing capability family, and NanoCore maps them to its private `/api/worker-capabilities/*` handlers; no endpoint, command, arguments, environment, Vault reference, credential hint, or raw schema enters the list response.

Rules:

- A session sees only servers that its resolved AEP enables; `mcp.list_servers` MUST NOT reveal disabled or out-of-scope entries.
- One complete upstream native MCP protocol response is bounded to 1 MiB on both stdio and HTTP transports before semantic parsing; this is an internal envelope allowance, not the worker-native carriage in-flight bound. The parsed tools list or tool result is bounded to 512 KiB by capability-plane policy. An oversized semantic result fails typed with `mcp-result-too-large` and a hint to route bulk output through artifacts or the data plane; the gateway MUST NOT truncate silently.
- Calls carry the full capability lineage (workspace, thread, turn, AgentSession, package snapshot); the gateway stamps the catalog entry id and schema snapshot id onto the call record.
- Timeouts are enforced at the gateway (default 60s per call, catalog-entry configurable); a timed-out call fails typed and MUST NOT leave the worker waiting on a hung server.

### Server lifecycle

The explicitly selected built-in `openkit-repository` target uses the same native MCP projection and authenticated package admission. Its reserved identity, repository-only tool and in-process dispatch are owned by [Worker Agent Capability](20260703-worker_agent_capability.md#built-in-repository-target); [Git Write Workflow](20260704-git_write_workflow.md#worker-initiated-repository-push) owns its effect authority and its human and automatic approval modes. The comparison of this target with a proxied vendor server is deferred.

The built-in `openkit-work` server is supplied to every worker AgentSession without manifest selection, like `openkit-generative`. It carries `work_request_input`, `work_list_peers`, and `work_read_peer`, whose identity and semantics [Worker Agent Capability](20260703-worker_agent_capability.md) owns. It uses the same projection, has a reserved id that no catalog entry can take, is dispatched in process, and starts no subprocess. The target starts no MCP subprocess, contacts no configured external MCP server, accepts no replacement catalog entry and grants no App API bearer access. Built-in invocation evidence does not replace the repository owner's exact target Approval, permission decision or terminal push record.

- NanoCore owns the lifecycle. States: `inactive`, `starting`, `ready`, `degraded`, `failed`. Transitions are recorded as operational diagnostics; health checks run while any live session has the entry enabled.
- `stdio` servers are spawned and supervised by NanoCore on demand (first call or session start, an implementation choice) and reaped when idle past a bound. Spawned server processes run in NanoCore's host context in this slice; sandboxing them is deferred, and server trust is therefore deployment configuration. Import is inactive and has no spawn or discovery effect. Activation of a new or changed stdio command or package executable requires deployment-admin authority, separately from ordinary Workspace catalog management.
- `http` servers are connected from NanoCore with pooled clients. The actual fetch boundary rejects every redirect before following it, including same-origin redirects; no fixed header, Vault authentication, or request body reaches a redirect target. Endpoint changes require an explicit authorized configuration revision, without inferred credential forwarding or alternate transport.
- A `failed` or unreachable server yields typed `mcp-server-unavailable` errors on calls, never hangs; repeated failures mark the entry `degraded` in `mcp.list_servers` output so workers can adapt.
- One catalog entry may be reused across successive and co-resident AgentSessions. This specification does not authorize a harness of agents that control each other or fleet behavior; the read-only peer tools create no control edge. Per-AgentSession server instances remain a deferred lifecycle option for stateful or isolation-sensitive servers.

### Credential injection

- Credential resolution happens at the gateway when NanoCore spawns or calls the server: vault references resolve through the vault backend, values land in the server's process environment (`stdio`) or request auth material (`http`), with visibility class `gateway-only` per the vault injection contract.
- Workers MUST NOT be able to obtain MCP credentials through any route: not in `mcp.list_servers`, not in error payloads, not in tool results echoing server environment. The gateway MUST apply redaction filters to tool results for known credential shapes as defense in depth.
- Vault grant revocation takes effect on the next capability call: the gateway re-checks grant validity per call (cheap check against the grant record), and revocation also triggers teardown of spawned `stdio` servers holding the revoked material in their environment.
- Every credential resolution emits `VaultUse` success or typed-failure evidence per the Vault contract; that evidence is not injection authority or proof that the MCP sink completed.

### Tool schema retention

- At Turn admission NanoCore fixes, for each selected server, the `McpToolSchemaSnapshot` the worker sees during that Turn; the snapshot is captured on first use of a server and on drift detected at a Turn boundary under `tracking` policy. A snapshot holds the catalog entry id, server-reported identity/version when available, the full tool list with JSON schemas, a content digest, and captured-at time. Upstream `tools/list` pagination is followed to the end within a bounded page count, and the complete list stays under the 512 KiB semantic bound.
- A runtime that refreshes its tool list at Turn start sees a changed snapshot at the next Turn. For a runtime whose adapter declares that it cannot refresh, a changed snapshot is a setup change that the continuity owner applies by replacing the binding at that boundary, and the successor resumes the native conversation.
- Every `CapabilityCall` for `mcp.call_tool` records the schema snapshot id it was validated against, so calls remain interpretable for replay and audit after servers change.
- Schema drift handling follows the entry's pin policy: `pinned` entries fail calls typed with `mcp-schema-drift` until an operator re-pins; `tracking` entries record a diagnostic and capture a new snapshot, which the worker sees from the next Turn. Within a Turn, calls are validated against the Turn's snapshot, and a call whose tool left the upstream or no longer matches it fails typed rather than silently changing the surface.
- Tool arguments are validated against the snapshot schema at the gateway before the server is called; validation failures are typed `mcp-invalid-arguments` and never reach the server.

### Policy binding

- `tool.use` is the policy-kernel action for `mcp.call_tool`. Policy associations MAY scope by catalog entry name and tool name; the decision context includes the standard capability lineage.
- Default posture: deny-unless-enabled at the catalog level (an entry not enabled for the workspace/agent yields no access at all) plus policy allow at call level (an enabled entry still requires an `allow` decision for `tool.use`).
- Tools marked `approval-required` raise a pending approval under [Pending Requests](20260930-pending_requests.md). After current authorization and argument validation against the Turn's snapshot, the gateway captures the immutable binding: server id, catalog revision, schema snapshot, tool, the full canonical arguments, and the originating authorization context. It makes no upstream contact, records the raising `CapabilityCall` as `denied` with no contact, and returns at once a tool result with `isError: true` whose structured and text content carry `status: "pending-approval"`, the request id, and a next step telling the agent that the outcome arrives on a later Turn and that it must not call again to claim it. The Turn continues. A repeated call with the same qualified binding while the request is pending returns the same request.
- After a grant, the gateway re-evaluates current Workspace membership and Agent authority, the Thread's current supply for that server and tool, current credentials and Vault grants, current `tool.use` policy, and the current schema against the captured binding, inside the approval response command. On success it claims the request once and executes the captured call with the ordinary timeout, bounds, and credential rules. The execution `CapabilityCall` id is derived from the request id; its fresh `allow` PermissionDecision links the grant and the call. Its disposition is `approved-executed`, `execution-error`, or `outcome-unknown`, or `denied-not-executed` when re-evaluation fails. A claimed call that did not finish before a restart is `outcome-unknown` and is never executed again. The agent never re-issues the call, and no approval expires by time.
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

The gateway has an MCP subsystem beside the inference dispatcher: the existing workspace-scoped catalog, a bounded stdio and HTTP client supervisor, a schema snapshot store, and the three operation handlers that compose validation → policy → dispatch, or capture and a pending result when approval is required → normalization → usage/audit emission. The approval response command later runs re-evaluation → claim → dispatch → disposition for a captured call. Its MCP implementation uses the official SDK v2 packages `@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and `@modelcontextprotocol/core` as an internal worker-capability dependency, with protocol negotiation inside the SDK and no v1 path, and does not depend on the removal-only user-facing MCP package or inherit an end-user transport contract. A deterministic stub MCP server supplies focused L1–L3 checks.

## Internal Caller Reuse Boundary

`20260909-internal_agent_resource_integration.md` owns the internal Assistant consumer of this MCP substrate: owned internal-capability adapter binding, internal user/Thread/Turn lineage, per-run private stdio/HTTP session partitions, bounded cleanup, product-visible Tool Items and the non-Worker approval exit, which follows the same pending approval and captured-call execution. This specification's AEP, AgentSession, Sandbox capability token/listener, and Worker pool clauses apply only to Worker callers. Internal calls share the SDK/supervisor, schemas, current Policy/Vault and normalized evidence facilities, never Worker credentials or an invented Worker identity. The Worker shared-session compromise does not authorize sharing its connections with private Assistant runs. The internal branch remains Not Started and changes no claim about the delivered Worker branch.

## Current Implementation Projection

Before the agent communication redesign, the executable plane implemented exactly the three selected-MCP routes. NanoCore exposes authenticated `/capabilities/mcp/*` handlers, validates selected catalog and schema lineage, applies policy, runs the bounded upstream stdio call, and records capability, usage, and audit outcomes. Sandbox Integration carries the separate capability token over its existing nested session and fixed native listener, while the Codex adapter projects only selected server ids through fixed loopback URLs and the other adapters project none. No worker-visible upstream credential exists. That implementation uses MCP SDK `1.30.0`, rejects `tools/list` pagination, lists the live server on every call, and implements approval through the Turn-pausing human gate and a one-hour claim by a later Task; the redesign replaces those four.

NanoCore loads the Workspace catalog from `catalog/catalog.json` through the runtime-config surface, selects it by the actual dequeued Turn's Workspace at scheduler dispatch, and projects only selected server ids, catalog digests, tool rules, approval marks, and schema policy into AEP supply. The built-in `openkit-generative` supply is appended unconditionally, so the plane is enabled for every worker package. Focused route, policy, schema, usage, transport, and adapter checks cover the implementation. The built NanoCore L5 smoke starts a disposable public Task, real stdio MCP child, native NanoHost carriage, and official SDK client and proves durable call, schema, policy, usage, audit, Item, backend, lease, process-reaping, listener-close, and temporary-root cleanup outcomes. Release closure separately consumes the admitted real-Codex Web L6 story and its retained multi-run evidence.

Immutable MCP configuration history, current-version/binding resolution, ordinary package environment/working-directory/header fields, package-root materialization, and redirect rejection at the actual HTTP fetch boundary are accepted targets not implemented by the current mutable catalog path. Their management and schema cutover is owned by `docs/specs/20260907-mcp_catalog_management.md`; existing Gateway execution remains implemented and is not demoted to Draft.

## Alternatives Considered

- Direct worker connections to catalog or external MCP servers with credentials injected into the sandbox. Rejected: it bypasses policy and audit, puts credentials within sandbox reach (exactly what the vault boundary exists to prevent), and makes every backend responsible for MCP transport. A server the worker configures inside its own Sandbox holds no Gateway credential and is not this alternative.
- Holding the native tool call open while a person decides. Rejected: it ties a Turn to human latency and cannot bind an exact effect.
- Embedding MCP protocol or server lifecycle in the worker runtime. Rejected: the worker client stays a thin local caller while NanoCore owns MCP transport, policy, credentials, lifecycle, and records.
- Per-turn ephemeral server spawn as the default lifecycle. Rejected as default: spawn cost per turn is wasteful for stateless servers; retained as a deferred per-session lifecycle option for stateful or isolation-sensitive servers.
- Waiting for every unified-proxy family. Rejected: MCP may be implemented from this accepted contract once the capability-plane foundation is rebuilt; third-party auth proxying and network egress remain independently deferred.

## Consequences

- Workers receive selected tool supply only through the implemented governed Gateway path; broader capability families remain absent.
- NanoCore takes on MCP server supervision (process management, health, reaping) — a real operational surface.
- MCP server processes run trusted in this slice; deployments must treat catalog write access accordingly until server sandboxing lands.
- Tool schema snapshots add storage but make audit and replay honest against moving servers.

## Rollout / Migration Plan

No compatibility path exists. The implementation followed the order: fail-closed capability projection and thin client; catalog, manifest reference, and AEP selection; stdio lifecycle plus listing against schema snapshots; governed tool calls with usage and audit; HTTP transport and gateway-only Vault credentials. The redesign then cuts the gateway to SDK v2 in one change with no v1 path, fixes the tool snapshot per Turn, replaces the human-gate closeout with pending approvals and captured-call execution, and adds `openkit-work`. This version starts from a new data root and reads no earlier-version gate or Approval, as [the engineer decided](../decisions/20260930-earlier_version_data_not_carried.md); that decision does not relax data continuity for later releases. The roadmap remains pending until final package, deterministic story, and independent release gates pass.

## Testing Strategy / Acceptance Criteria

Mapped to `docs/specs/20260529-test_strategy.md`, using a deterministic stub MCP server harness:

- L0: schema-drift checks for catalog entry, schema snapshot, and route payload shapes; lint that no `memory` vocabulary and no MCP-native error strings appear in public schemas.
- Catalog extension checks prove inactive import performs no contact, ordinary Workspace authority cannot activate changed host-executed stdio, non-secret package fields preserve Vault precedence, changed effective versions reject stale AEPs, and HTTP redirects contact neither same-origin nor cross-origin targets and leak no canary credentials.
- L1: unit tests for argument validation against snapshots, pin-policy drift behavior, error normalization mapping, redaction filters, idle reaping and teardown-on-revocation triggers.
- L2: contract tests on the capability plane: full lineage on every call record; schema snapshot id stamped; usage rows validate against `UsageRecordSchema` with `category: "tool"` and `unit: "tool_calls"`; denial paths yield only typed codes; canary credential values planted in server environment never appear in any worker-visible payload.
- L3: NanoCore black-box tests: end-to-end call through a spawned stub server; server crash mid-call fails typed without hanging the turn; grant revocation tears down the spawned server and the next call fails typed; an approval-required call makes no upstream contact, records the denied raising `CapabilityCall`, returns `isError: true` with the pending fields, and leaves the Turn running; a grant after that Turn ended executes the captured call exactly once with the captured arguments, and a repeated identical call while pending returns the same request while changed arguments raise a new one; grant after policy, credential, or supply change records `denied-not-executed` with no contact; a crash between claim and finish yields `outcome-unknown` and no second execution; `tools/list` pages from a multi-page upstream are all followed; a tracking drift inside a Turn is seen only at the next Turn; both a stateless-era and a session-era client work against the worker-facing server; oversized result fails typed; `pinned` entry fails on drifted stub schema until re-pinned.
- L5: smoke: packaged build spawns the stub server and completes one governed tool call.
- L6: story acceptance: public `task.start` drives a real checkpoint, lease, AEP, session-continuity backend, worker-control lineage, and catalog-declared MCP tool; the marked call returns a pending result with no upstream contact while the Turn continues, the AgentSession stays bound, the grant executes the captured call through the gateway, and a later Turn on the same Thread delivers the outcome; audit shows the full call chain with no credential or raw payload leakage.

Acceptance: no path exposes credentials or endpoints to workers; every call is attributable and schema-interpretable; failures are always typed and bounded in time.

## Risks & Mitigations

- Risk: trusted MCP server processes become a privilege-escalation vector. Mitigation: import is inactive, Workspace catalog writes do not grant host execution, and new or changed stdio activation requires deployment-admin authority; server sandboxing remains explicit deferred work.
- Risk: schema snapshots bloat storage for churning servers. Mitigation: snapshots are content-addressed by digest; identical schemas dedupe; `tracking` entries cap retained snapshots.
- Risk: shared server state leaks across sessions. Mitigation: the contract states no per-session isolation guarantee; stateful entries are documented, and the per-session lifecycle option is reserved.
- Risk: this plane drifts into a general API proxy by accretion. Mitigation: routes are MCP-protocol-only by contract; third-party auth proxying stays roadmap-gated.

## Resolved Decisions

Previously open questions are resolved by accepted defaults: `stdio` MCP servers spawn on first call rather than session start; upstream `tools/list` pagination is followed within a bounded page count, and the worker-facing list remains bounded by the 512 KiB semantic limit, so very large tool sets must still be split, filtered, or rejected with typed diagnostics.

## Deferred / Future Work

- MCP server process sandboxing and resource limits.
- Per-session server instances for stateful or isolation-sensitive servers.
- Streaming tool results.
- Remote MCP marketplace/registry integration and server trust metadata.
- Rate limits per server/tool once the capability catalog and budget model exist.

## Links

- `docs/specs/20260907-mcp_catalog_management.md`
- `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`

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
