---
status: Accepted
implementation: Partial
---
# Capability Usage Gateway Foundation

## Owns

- The shared ledger foundation used by every current NanoCore `CapabilityCall` producer and required by the future worker MCP producer.
- The minimum NanoCore services shared across producers: capability call recorder, usage recorder, attribution context, idempotent start, and failure-safe write ordering.
- The implementation order for adding worker MCP usage counting without creating a parallel ledger.
- The conformance checks that the future `capability.local` producer must pass against the implemented LLM producers.

## Does Not Own

- The public LLM gateway HTTP surface, provider capability matrix, prompt-cache key rules, or Codex routing. Those stay owned by `docs/specs/20260526-llm_gateway_responses_api.md`.
- The pi-ai adapter contract and provider mapping. Those stay owned by `docs/specs/20260708-pi_ai_unified_llm_backend.md`; dependency pinning, catalog reconciliation, and the pi-ai vocabulary boundary stay owned by `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`.
- Worker MCP catalog shape, server lifecycle, tool schema snapshots, policy binding, or MCP error codes. Those stay owned by `docs/specs/20260704-worker_mcp_tool_supply.md`.
- The abstract worker capability model. That stays owned by `docs/specs/20260703-worker_agent_capability.md` and `docs/core/agent-capability.md`.
- Final table DDL, storage migration details, backup/export format, or non-gateway metering.
- Budget enforcement, rate-limit policy, billing, invoices, or cost allocation UI.
- Runtime-internal sub-agent provenance, authenticated worker-inference identity, and worker runtime cache lineage, which are owned by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.
- Producer-specific authorization, external-effect, retry, recovery, and outcome semantics. Each producer's owning specification supplies those rules; this spec owns only the shared ledger behavior.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/metering.md`
- `docs/core/storage.md`
- `docs/core/vault.md`

Related specs:


## Related Docs

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`

## Summary

NanoCore has one small capability-ledger service reused by current LLM, Knowledge, network, runtime, storage, and Workspace producers rather than feature-local ledgers. Each producer owns its effect and authorization semantics; the shared recorder owns the durable call tuple, retry comparison, usage linkage, terminal status, and redaction boundary. Future `capability.local` worker MCP calls must reuse the same recorder.

The goal is boring: one durable capability-call and usage writer, with no feature-specific replay ledger or recovery workflow hidden inside it.

## Goals / Non-goals

### Goals

- Keep all current producers on one `CapabilityCall` status, lineage, request-id, and redaction implementation, and require worker MCP to reuse it when implemented.
- Keep feature-specific adapters thin: pi-ai normalizes LLM token/cost usage; the future MCP adapter normalizes tool-call/byte usage; neither owns the ledger.
- Make failed and aborted upstream calls record partial usage when upstream resources were consumed.
- Give diagnostics and future budget/rate-limit work one queryable source of truth.

### Non-goals

- Do not build a generic plugin framework for gateway usage.
- Do not implement the full future capability catalog or budget model.
- Do not route MCP through pi-ai or through the LLM gateway.
- Do not add a Bifrost-style automatic agent loop inside the LLM gateway.
- Do not create PR/merge-request, external API proxy, or network egress behavior.
- Do not store raw prompts, MCP arguments, MCP results, provider payloads, secrets, or raw prompt cache keys in usage rows.

## Background

The LLM gateway retains process-local usage diagnostics and records durable `UsageRecord` rows for Workspace-attributed producers. All non-Codex providers now use pi-ai under S42; Codex and non-Codex public Gateway calls share this ledger whenever durable Workspace attribution is present.

The worker MCP tool supply spec makes `mcp.call_tool` the first non-LLM worker capability family that should emit one `CapabilityCall` and one tool-call usage row for every executed call.

Implementing worker MCP separately would create duplicate attribution code, duplicate redaction decisions, and incompatible failure semantics. The worker producer must reuse the shared ledger that already serves LLM paths.

## Decision

- NanoCore MUST implement a shared capability usage foundation before either pi-ai durable usage or worker MCP durable usage is considered complete.
- The foundation consists of:
  - `GatewayCallContext`: normalized lineage and request metadata.
  - `CapabilityCallRecorder`: starts, finishes, and fails durable capability calls.
  - `UsageRecorder`: writes usage rows linked to a capability call.
  - `GatewayUsageNormalizer` functions owned by each producer family.
- LLM gateway calls and future worker MCP calls MUST both create `CapabilityCall` records. LLM calls MAY use an OpenAI-compatible public route, backend-local `inference.local`, or the authenticated worker-inference route, but internally they still represent one `llm` capability family.
- pi-ai-routed LLM calls MUST record `UsageRecord` rows with `category: "llm"`.
- Worker MCP `mcp.call_tool` calls MUST record `UsageRecord` rows with `category: "tool"`, `unit: "tool_calls"`, and quantity `1`; byte quantities MAY be recorded when reliably measured.
- `mcp.list_servers` and `mcp.list_tools` MUST create capability-call/audit records but MUST NOT create usage rows unless a later accepted spec defines billable listing semantics.
- The recorder MUST remain adapter-neutral; current Workspace-attributed Codex and pi-ai Gateway calls and every other current producer reuse it.

## Contract / Expected Behavior

### GatewayCallContext

Every gateway-mediated capability call resolves a `GatewayCallContext` before the upstream call starts.

It MUST carry:

- authority actor: the authenticated request `ActorRef`, the owning AEP `scope.triggerActor`, or `null` only for an unattributed server diagnostic
- workspace id
- thread id when available
- turn id when available
- item id when available
- agent id when available
- AgentSession id when available
- Agent Environment Package snapshot id when available
- product-safe runtime origin reference when available
- product-safe runtime cache-lineage reference when available
- canonical workspace data source ids touched by the call
- capability id
- capability family from the current shared ledger vocabulary (`llm`, `mcp`, `knowledge`, `network`, `runtime`, `storage`, or `workspace`)
- operation: endpoint or route operation, for example `responses.create`, `chat.completions.create`, or `mcp.call_tool`
- request id
- provider reference when available
- service reference when available
- redaction class

Rules:

- Missing optional lineage is allowed for server diagnostics and manual gateway calls, but workspace id and a non-null authority actor are required for worker-agent execution and workspace-owned usage.
- Before a Workspace-attributed producer starts a CapabilityCall or contacts an upstream, it must apply the current-authority predicate from `docs/specs/20260715-multi_user_workspace_system.md` to that actor and the concrete `llm.gateway.use`, `tool.use`, or `network.egress` operation. A null, stale, or denied actor records no Workspace effect; an unattributed server diagnostic cannot be promoted into Workspace usage or authority.
- The context actor is transient enforcement input. Durable CapabilityCall and RuntimeEvidence records retain their existing AEP, Turn, AgentSession, request, and audit links instead of copying another `ActorRef`; the linked UsageRecord stores only the exact derived responsible-user id required by the audit and usage specification.
- The context MUST NOT carry prompt text, tool arguments, tool results, secrets, bearer tokens, or raw prompt cache keys.
- Producer adapters may add feature-local diagnostic ids, but the recorder stores only stable OpenKit ids and redacted summaries.

### CapabilityCall lifecycle

The recorder owns a three-step lifecycle:

1. `startCapabilityCall(context)`: persists a pending call row before contacting the upstream provider or MCP server.
2. `recordUsage(callId, usage[])`: persists zero or more usage rows after the producer has a measured result or partial result.
3. `finishCapabilityCall(callId, outcome)`: records one terminal status from the closed vocabulary owned by `docs/core/agent-capability.md`, with a stable error code when applicable.

Rules:

- A call rejected by policy before any upstream contact MUST finish as `denied` and MUST NOT emit usage.
- A call that contacts upstream and then fails MUST finish as `failed` or `aborted` and MUST emit partial usage when the producer can measure it.
- A call whose execution is known to have stopped without a complete result finishes as `interrupted`; this does not prove whether the external effect happened. A call left by a crash whose external result cannot be proved finishes as `unknown`. An `unknown` call is never automatically replayed: only external inspection or reconciliation may establish its result, and any later invocation is a fresh authorized request.
- The recorder MUST use the existing `(workspaceId, requestId, family, operation)` tuple as the complete idempotency key for capability-call start. Those four fields match by lookup and are not repeated in the replay-attribution comparison.
- When that lookup finds an existing row, exact-match replay is allowed only when the incoming `capabilityId`, `threadId`, `turnId`, `itemId`, `agentId`, `agentSessionId`, `packageSnapshotId`, `runtimeOriginRef`, `runtimeCacheLineageRef`, `sourceIds`, `providerRef`, `serviceRef`, and `redactionClass` equal the persisted immutable effect attribution. `sourceIds` are compared only after canonical sorting and deduplication.
- Replay comparison MUST NOT include `callId`, `summary`, status, error code, timestamps, or the transient `authorityActor`.
- Any immutable-attribution contradiction on an existing key MUST fail closed before upstream contact, create no new record, change no durable state, and use the existing public failure vocabulary rather than adding a record type, lifecycle state, or public error code.
- Usage recording MUST also be retry-safe for equivalent measurements linked to the same capability call.
- If usage recording fails after upstream success, the call MUST finish with a diagnostic status that surfaces ledger-write failure; the system MUST NOT silently report a fully accounted success.
- Public response bodies MUST NOT depend on usage write timing except where fail-closed policy explicitly requires ledger durability before returning success.

### Usage rows

LLM usage rows:

- category: `llm`
- unit: `tokens` for input, output, cache-read, and cache-write quantities; `usd` for a positive provider-reported cost estimate; request count only when a producer has no token measurement
- providerRef: OpenKit provider instance id, never a pi-ai provider name
- modelId
- quantity
- cache metrics when available
- cost estimate when pi-ai reports one, treated as telemetry rather than billing truth
- source: OpenKit vocabulary that distinguishes input, output, cache-read, cache-write, total fallback, and cost estimate without storing a provider-native payload
- requestId and capabilityCallId

MCP usage rows:

- category: `tool`
- unit: `tool_calls` with quantity `1`
- providerRef or service reference: MCP catalog entry id or redacted server summary
- modelId omitted
- byte quantities optional when bounded and measurable
- source: NanoCore MCP gateway measurement
- requestId and capabilityCallId

Rules:

- Usage rows MUST validate against `UsageRecordSchema`.
- Usage rows MUST NOT contain raw prompts, MCP arguments, MCP results, provider-native payloads, secrets, raw URLs with embedded credentials, or raw cache keys.
- Cost estimates are measurement data, not billing truth.

### Producer boundaries

The LLM producer owns:

- pi-ai request/response conversion
- pi-ai usage extraction
- provider/model error normalization
- LLM-specific diagnostics

The MCP producer owns:

- MCP tool argument validation
- MCP server dispatch
- MCP result size measurement
- MCP schema snapshot id stamping
- MCP-specific error normalization

The shared foundation owns:

- lineage resolution
- durable `CapabilityCall` writes
- durable `UsageRecord` writes
- audit linkage
- idempotency
- redaction boundary for ledger records

### Failure semantics

- The recorder MUST fail closed for malformed authority-bearing fields such as workspace id, capability family, operation, providerRef, policy decision id, vault grant id, or capability call id.
- The recorder MAY record degraded diagnostics for missing optional lineage.
- Producer errors MUST be normalized before finish; the recorder stores stable OpenKit error codes, not pi-ai or MCP-native error names.
- If the upstream call times out, the producer records partial measured usage if available, then finishes the call as `timed-out`.
- If the client aborts, the producer records partial measured usage if upstream work occurred, then finishes as `aborted`.

### Storage and boot behavior

- Workspace-attributed capability calls and usage rows home in `workspace.sqlite` per the audit/usage and storage layout specs.
- Server-scope provider health checks and bootstrap probes home in `core.sqlite` and are not in this first implementation slice unless needed by the LLM gateway.
- Boot recovery MUST tolerate calls that are `running` at crash time: startup marks them terminal with a recovery error code and never leaves them active forever.
- Derived diagnostics MAY aggregate usage rows, but aggregates are rebuildable and never the source of truth.

## Accepted Architecture

```text
worker or gateway client
  -> AEP-resolved inference route (current) or capability.local route (future)
  -> resolve GatewayCallContext
  -> start CapabilityCall
  -> feature adapter
       -> pi-ai provider call
       -> or MCP tool call
  -> normalize usage and error
  -> write UsageRecord rows
  -> finish CapabilityCall
  -> emit audit linkage
  -> return public response or typed worker error
```

NanoCore should keep this as a small service used directly by the existing route handlers and dispatchers. Do not add a new event bus, generic middleware registry, or asynchronous accounting queue in the first slice. If synchronous writes are too slow after measurement, a later spec can introduce a bounded durable outbox.

## Implementation Plan

### Phase 1: Shared ledger skeleton (partial: ledger active, worker context pending)

- Add protocol/storage tests for the minimum `CapabilityCall` and `UsageRecord` shapes needed by LLM and MCP.
- Add NanoCore storage tables or repositories for capability calls and usage rows, following existing migration patterns.
- Add `GatewayCallContext` construction helpers for LLM gateway requests and worker capability requests.
- Add redaction checks proving no prompt, tool payload, token, or raw cache key enters ledger rows.

### Phase 2: pi-ai LLM usage producer (implemented)

- Wire pi-ai-routed calls to start and finish capability calls.
- Normalize pi-ai usage into durable `UsageRecord` rows.
- Keep process-local `gateway-usage` diagnostics as a derived consumer of the same normalized data.
- Verify failed and aborted pi-ai-routed calls record partial usage when pi-ai reports it.

### Phase 3: Worker MCP usage producer (pending)

- Wire `mcp.call_tool` to the same recorder.
- Record tool-call usage rows and schema snapshot ids.
- Record no usage for list operations.
- Verify MCP policy denials produce denied capability calls with no usage.

### Phase 4: Cross-producer conformance (pending)

- Add one shared conformance test fixture set covering success, denied, failed, timed out, and aborted calls for both `llm` and `mcp`.
- Add a leak check that scans public responses, protocol records, usage rows, audit rows, and diagnostics for pi-ai-native names, MCP-native stack traces, canary secrets, and raw payloads.

## Current Implementation Projection

Current relevant code is split:

- `apps/nanocore/src/llm/provider-dispatcher.ts` dispatches LLM gateway calls.
- `apps/nanocore/src/llm/gateway-usage.ts` records process-local diagnostics only.
- `packages/protocol/src/models/usage.ts` already defines `UsageRecordSchema`.
- `packages/protocol/src/models/capability.ts` already defines `CapabilityCallSchema`.
- `apps/nanocore/src/capability/usage-ledger.ts` now provides the first shared workspace-scoped ledger skeleton: start a durable capability call, record linked usage rows, finish the call with a terminal status, recover `running` calls during boot workspace scans, and emit one linked `AuditEvent` for terminal capability outcomes. The recorder validates rows against the existing protocol schemas, rejects raw payload-shaped field names before storage, skips duplicate equivalent usage measurements when an idempotent capability call is retried, and marks the linked call `failed` with `usage_record_failed` when usage recording fails. Its restart recovery currently marks calls `cancelled` with `capability_call_recovered_after_restart`; `packages/protocol/src/models/capability.ts` currently exposes only `queued`, `running`, `succeeded`, `failed`, and `cancelled`. That schema and recovery behavior diverge from the Core terminal vocabulary, especially the required `unknown` result, and are not accepted recovery semantics.
- Workspace-scoped databases now own `capability_calls` and `usage_records` tables through `workspace_0013_capability_usage_ledger`.
- QuickChatAgent LLM calls now use the same recorder when NanoCore has a Core database. The producer writes one workspace-scoped `CapabilityCall` with family `llm` and one linked `UsageRecord` using provider-reported total tokens when available, falling back to one request-count row when token usage is absent.
- Public `/v1/chat/completions` and `/v1/responses` calls routed through pi-ai now use the same recorder when the request carries `metadata.openkit.workspaceId`. NanoCore starts a workspace-scoped `CapabilityCall` with family `llm`, observes raw pi-ai terminal usage exactly once before public normalization, records positive input, output, cache-read, and cache-write token rows plus one positive estimated-USD row when available, and marks started calls failed when dispatch, stream consumption, or usage recording fails. The same observation feeds process-local diagnostics while retaining provider-reported cache-read and cache-write semantics. Public calls without workspace attribution remain process-local diagnostics only, and public responses never expose raw usage, cost objects, or prompt-cache keys.
- Worker Knowledge and MCP capability producers are not implemented because the AEP capability plane is disabled, NanoCore exposes no `/api/worker-capabilities/*` routes, and the shim has no capability client.

The shared recorder and workspace-attributed internal and public LLM producers are implemented. Cross-producer MCP conformance remains a future acceptance gate, not current evidence. Pi dispatcher coverage proves successful, provider-error, and aborted terminal usage is observed once, public Pi streams omit raw cache-write, cost, and cache-key data, and Codex non-streaming and streaming usage retain the existing public-payload accounting path. Public pi-ai stream route coverage proves aborted and timed-out attributed streams finish durable `CapabilityCall` rows as `failed`, keep partial usage rows when upstream usage exists, classify the public SSE error without leaking provider secrets, and avoid leaving abandoned `running` ledger state.

## Alternatives Considered

**Let pi-ai usage land first, then copy the pattern for MCP.** Rejected. That is the shortest first diff but creates the second bug immediately: MCP would either duplicate LLM-specific accounting or diverge from it. One tiny shared recorder is less code overall.

**Build a generic gateway middleware framework.** Rejected. Two producers do not justify a framework. Direct calls into a shared recorder are enough.

**Asynchronous usage outbox from day one.** Deferred. Synchronous writes are simpler and correct. Add an outbox only when measured latency or failure isolation requires it.

**Only record usage, skip capability calls.** Rejected. Usage without `CapabilityCall` loses the permission, vault, lineage, and error context that makes the row explainable.

## Consequences

- pi-ai LLM usage and future worker MCP usage will be comparable because both attach to `CapabilityCall`.
- Future budget and rate-limit work gets one ledger instead of two feature logs.
- The first implementation must touch shared NanoCore storage before either producer is fully useful.
- Synchronous recording is intentionally simple; high-throughput optimization is deferred until measured.

## Rollout / Migration Plan

New internal records, no backward-compatibility path.

1. Add shared storage and recorder behind tests, with no route using it.
2. Enable it for pi-ai-routed LLM calls.
3. Enable it for worker MCP calls.
4. Derive existing diagnostics from the durable rows where practical.
5. Remove any feature-local durable accounting that duplicates the shared recorder.

No existing process-local diagnostic summaries are migrated; they are runtime observations, not the durable ledger.

## Testing Strategy / Acceptance Criteria

Testing follows `docs/specs/20260529-test_strategy.md`.

- L0: schema drift and leak checks for capability and usage records.
- L1: unit tests for `GatewayCallContext`, usage normalization, finish-state transitions, and redaction, plus one table-driven check of the exact `(workspaceId, requestId, family, operation)` key covering exact replay, one included immutable-attribution contradiction, canonical sorted/deduplicated `sourceIds`, and an unchanged capability-call row count on contradiction.
- L2: contract tests proving pi-ai LLM usage rows and MCP tool usage rows validate against the same schemas and attribution rules.
- L3: NanoCore black-box tests for one pi-ai-routed LLM call and one stub MCP tool call, each producing a capability call, usage rows, and audit linkage.
- L5: smoke test that a packaged NanoCore build can boot, make one governed LLM call through the pi-ai path, and make one stub MCP call without leaking secrets.
- L6: story acceptance that a worker task uses both LLM inference and one MCP tool, then product diagnostics show attributable usage for both under the same workspace.

Acceptance:

- One shared recorder is used by both producers.
- Every pi-ai-routed LLM call that reaches upstream emits durable LLM usage when usage is available.
- Every `mcp.call_tool` emits exactly one tool-call usage row when executed.
- Denied calls emit capability/audit records but no usage rows.
- An existing idempotency-key row replays only on exact immutable effect attribution; reordered or duplicated `sourceIds` are equivalent after canonicalization, and any included-field contradiction reaches no upstream, creates no record, changes no durable state, and leaves the capability-call row count unchanged.
- No ledger row stores raw prompt text, MCP arguments, MCP results, bearer tokens, secret values, raw prompt cache keys, pi-ai-native payloads, or MCP-native stack traces.

## Risks & Mitigations

- Risk: synchronous ledger writes add gateway latency. Mitigation: keep the recorder small and measured; add a durable outbox only after latency data proves it is needed.
- Risk: feature adapters smuggle provider-native payloads into records. Mitigation: producer-specific normalizers return only typed usage summaries; leak checks cover canary payloads.
- Risk: LLM and MCP statuses drift. Mitigation: shared finish-state enum and cross-producer conformance fixtures.
- Risk: budget work later needs fields not present now. Mitigation: keep lineage and units complete; do not implement budget policy in this slice.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: worker execution fails closed when required usage writes cannot commit, while manual server diagnostics may return success with a typed usage-write diagnostic; `mcp.list_tools` does not emit usage rows in V1, and metering for expensive list operations stays deferred until a broader catalog, budget, and rate-limit model exists.

## Deferred / Future Work

- Durable outbox for asynchronous accounting.
- Budget and rate-limit enforcement over the new ledger.
- Broader durable LLM usage for unattributed server-scope calls when an accepted ownership policy exists.
- Non-gateway metering for runtime, storage, sandbox lifetime, and network volume.
- UI cost allocation and billing exports.

## Links

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/metering.md`
