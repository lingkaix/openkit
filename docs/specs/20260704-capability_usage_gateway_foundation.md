# Capability Usage Gateway Foundation

Status: Accepted
Implementation: Implemented

## Owns

- The shared implementation slice that makes LLM gateway calls and worker MCP tool calls emit the same durable `CapabilityCall`, `UsageRecord`, and audit linkage shape.
- The minimum NanoCore services needed by both gateway families: capability call recorder, usage recorder, attribution resolver, gateway request context, and failure-safe write ordering.
- The implementation order for landing pi-ai LLM usage counting and worker MCP usage counting together without creating two parallel ledgers.
- The conformance checks that prove `inference.local` and `capability.local` use the same attribution, redaction, storage, and error-normalization rules.

## Does Not Own

- The public LLM gateway HTTP surface, provider capability matrix, prompt-cache key rules, or Codex routing. Those stay owned by `docs/specs/20260526-llm_gateway_responses_api.md`.
- The pi-ai adapter contract, provider mapping, cost-estimate source, and pi-ai boundary rules. Those stay owned by `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`.
- Worker MCP catalog shape, server lifecycle, tool schema snapshots, policy binding, or MCP error codes. Those stay owned by `docs/specs/20260704-worker_mcp_tool_supply.md`.
- The abstract worker capability model. That stays owned by `docs/specs/20260703-worker_agent_capability.md` and `docs/core/agent-capability.md`.
- Final table DDL, storage migration details, backup/export format, or non-gateway metering.
- Budget enforcement, rate-limit policy, billing, invoices, or cost allocation UI.
- Runtime-internal sub-agent provenance, authenticated worker-inference identity, and worker runtime cache lineage, which are owned by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/metering.md`
- `docs/core/storage.md`
- `docs/core/vault.md`

Related specs:

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`

## Summary

OpenKit has two gateway paths that must become durable usage producers at the same time:

- `inference.local` / `/v1/*` LLM gateway calls, where pi-ai supplies token and cost measurements for non-native provider families.
- `capability.local` worker MCP calls, where NanoCore supplies governed MCP tool access and records tool-call usage.

This spec defines the shared foundation those two slices must use. The implementation should add one small capability-ledger service in NanoCore, not two feature-local logging systems. LLM and MCP adapters each normalize their own upstream result, then call the same recorder with the same attribution context. The recorder writes `CapabilityCall` first, then `UsageRecord` rows, then audit linkage, with redacted diagnostics or restricted evidence referenced by digest only.

The goal is boring: one call path, one attribution resolver, one durable usage writer, and two producers.

## Goals / Non-goals

### Goals

- Land durable usage production for pi-ai-routed LLM calls and worker MCP tool calls in one implementation slice.
- Ensure both producers share the same `CapabilityCall` status model, lineage fields, request id handling, and redaction rules.
- Keep feature-specific adapters thin: pi-ai normalizes LLM token/cost usage; MCP normalizes tool-call/byte usage; neither owns the ledger.
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

The LLM gateway already records process-local usage diagnostics, but those are not durable `UsageRecord` rows. The pi-ai adoption spec makes pi-ai the first durable LLM usage producer for provider families where OpenKit does not keep a native adapter.

The worker MCP tool supply spec makes `mcp.call_tool` the first non-LLM worker capability family that should emit one `CapabilityCall` and one tool-call usage row for every executed call.

Implementing these separately would create duplicate attribution code, duplicate redaction decisions, and incompatible failure semantics. That is the wrong split. Both paths are gateway-mediated capability calls, so the shared ledger should land first.

## Decision

- NanoCore MUST implement a shared capability usage foundation before either pi-ai durable usage or worker MCP durable usage is considered complete.
- The foundation consists of:
  - `GatewayCallContext`: normalized lineage and request metadata.
  - `CapabilityCallRecorder`: starts, finishes, and fails durable capability calls.
  - `UsageRecorder`: writes usage rows linked to a capability call.
  - `GatewayUsageNormalizer` functions owned by each producer family.
- LLM gateway calls and worker MCP calls MUST both create `CapabilityCall` records. LLM calls MAY have an OpenAI-compatible public route, but internally they still represent an `llm` capability call through `inference.local`.
- pi-ai-routed LLM calls MUST record `UsageRecord` rows with `category: "llm"`.
- Worker MCP `mcp.call_tool` calls MUST record `UsageRecord` rows with `category: "tool"`, `unit: "tool_calls"`, and quantity `1`; byte quantities MAY be recorded when reliably measured.
- `mcp.list_servers` and `mcp.list_tools` MUST create capability-call/audit records but MUST NOT create usage rows unless a later accepted spec defines billable listing semantics.
- The recorder MUST be usable by native OpenAI and Codex paths later, but this slice only requires durable LLM usage for pi-ai-routed calls.

## Contract / Expected Behavior

### GatewayCallContext

Every gateway-mediated capability call resolves a `GatewayCallContext` before the upstream call starts.

It MUST carry:

- workspace id
- thread id when available
- turn id when available
- item id when available
- agent id when available
- agent session id when available
- capability family: `llm` or `mcp`
- operation: endpoint or route operation, for example `responses.create`, `chat.completions.create`, or `mcp.call_tool`
- request id
- worker sequence when emitted by a worker-side route
- provider or service reference summary
- redaction class

Rules:

- Missing optional lineage is allowed for server diagnostics and manual gateway calls, but workspace id is required for worker-agent execution and workspace-owned usage.
- The context MUST NOT carry prompt text, tool arguments, tool results, secrets, bearer tokens, or raw prompt cache keys.
- Producer adapters may add feature-local diagnostic ids, but the recorder stores only stable OpenKit ids and redacted summaries.

### CapabilityCall lifecycle

The recorder owns a three-step lifecycle:

1. `startCapabilityCall(context)`: persists a pending call row before contacting the upstream provider or MCP server.
2. `recordUsage(callId, usage[])`: persists zero or more usage rows after the producer has a measured result or partial result.
3. `finishCapabilityCall(callId, outcome)`: marks the call `succeeded`, `failed`, `denied`, `aborted`, or `timed-out` with a stable error code when applicable.

Rules:

- A call rejected by policy before any upstream contact MUST finish as `denied` and MUST NOT emit usage.
- A call that contacts upstream and then fails MUST finish as `failed` or `aborted` and MUST emit partial usage when the producer can measure it.
- The recorder MUST be idempotent on `(requestId, capability family, operation, smallest stable scope)` to avoid duplicate rows on retry.
- Usage recording MUST also be retry-safe for equivalent measurements linked to the same capability call.
- If usage recording fails after upstream success, the call MUST finish with a diagnostic status that surfaces ledger-write failure; the system MUST NOT silently report a fully accounted success.
- Public response bodies MUST NOT depend on usage write timing except where fail-closed policy explicitly requires ledger durability before returning success.

### Usage rows

LLM usage rows:

- category: `llm`
- unit: token class or request count according to `UsageRecordSchema`
- providerRef: OpenKit provider instance id, never a pi-ai provider name
- modelId
- quantity
- cache metrics when available
- cost estimate when pi-ai reports one
- source: pi-ai-reported measurement for pi-ai-routed calls
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
- cache fidelity class
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
  -> inference.local or capability.local route
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

### Phase 1: Shared ledger skeleton

- Add protocol/storage tests for the minimum `CapabilityCall` and `UsageRecord` shapes needed by LLM and MCP.
- Add NanoCore storage tables or repositories for capability calls and usage rows, following existing migration patterns.
- Add `GatewayCallContext` construction helpers for LLM gateway requests and worker capability requests.
- Add redaction checks proving no prompt, tool payload, token, or raw cache key enters ledger rows.

### Phase 2: pi-ai LLM usage producer

- Wire pi-ai-routed calls to start and finish capability calls.
- Normalize pi-ai usage into durable `UsageRecord` rows.
- Keep process-local `gateway-usage` diagnostics as a derived consumer of the same normalized data.
- Verify failed and aborted pi-ai-routed calls record partial usage when pi-ai reports it.

### Phase 3: Worker MCP usage producer

- Wire `mcp.call_tool` to the same recorder.
- Record tool-call usage rows and schema snapshot ids.
- Record no usage for list operations.
- Verify MCP policy denials produce denied capability calls with no usage.

### Phase 4: Cross-producer conformance

- Add one shared conformance test fixture set covering success, denied, failed, timed out, and aborted calls for both `llm` and `mcp`.
- Add a leak check that scans public responses, protocol records, usage rows, audit rows, and diagnostics for pi-ai-native names, MCP-native stack traces, canary secrets, and raw payloads.

## Current Implementation Projection

Current relevant code is split:

- `apps/nanocore/src/llm/provider-dispatcher.ts` dispatches LLM gateway calls.
- `apps/nanocore/src/llm/gateway-usage.ts` records process-local diagnostics only.
- `packages/protocol/src/models/usage.ts` already defines `UsageRecordSchema`.
- `packages/protocol/src/models/capability.ts` already defines `CapabilityCallSchema`.
- `apps/nanocore/src/capability/usage-ledger.ts` now provides the first shared workspace-scoped ledger skeleton: start a durable capability call, record linked usage rows, finish the call with a terminal status, recover `running` calls during boot workspace scans, and emit one linked `AuditEvent` for terminal capability outcomes. The recorder validates rows against the existing protocol schemas, rejects raw payload-shaped field names before storage, skips duplicate equivalent usage measurements when an idempotent capability call is retried, marks the linked call `failed` with `usage_record_failed` when usage recording fails, and marks restart-recovered calls `cancelled` with `capability_call_recovered_after_restart`.
- Workspace-scoped databases now own `capability_calls` and `usage_records` tables through `workspace_0013_capability_usage_ledger`.
- Authenticated worker knowledge capability routes now use the same recorder when NanoCore has a Core database. `knowledge.search` and `knowledge.read` write durable workspace-scoped `CapabilityCall` rows, keep the existing worker response summary shape, and do not write `UsageRecord` rows because list/read knowledge operations are not metered usage producers.
- QuickChatAgent LLM calls now use the same recorder when NanoCore has a Core database. The producer writes one workspace-scoped `CapabilityCall` with family `llm` and one linked `UsageRecord` using provider-reported total tokens when available, falling back to one request-count row when token usage is absent.
- Public `/v1/chat/completions` and `/v1/responses` calls routed through pi-ai now use the same recorder when the request carries `metadata.openkit.workspaceId`. NanoCore starts a workspace-scoped `CapabilityCall` with family `llm`, records linked token usage rows from the normalized gateway usage payload after success, and marks started calls failed when dispatch, stream consumption, or usage recording fails. Public calls without workspace attribution still remain process-local diagnostics only.
- Authenticated worker MCP list routes now use the same recorder for MCP-family capability calls without usage rows. `mcp.call_tool` also requires an allowed workspace-scoped `mcp.call` `PermissionDecision`, validates arguments against the AEP schema subset, records one MCP-family `CapabilityCall`, and emits one linked `UsageRecord` with `category: "tool"`, `unit: "tool_calls"`, and quantity `1` only after policy and argument validation pass.
- Worker MCP server lifecycle is not implemented.

The shared recorder now exists, non-metered worker capability producers use it, the first workspace-attributed internal and public LLM producers write durable usage, and worker MCP tool calls write durable tool-call usage after policy allow. Cross-producer conformance coverage proves LLM and MCP producers use the same recorder lifecycle for `startCapabilityCall`, `recordUsage`, `finishCapabilityCall`, linked `UsageRecord` rows, and terminal audit events. Public pi-ai stream route coverage proves aborted and timed-out attributed streams finish durable `CapabilityCall` rows as `failed`, keep partial usage rows when upstream usage exists, classify the public SSE error without leaking provider secrets, and avoid leaving abandoned `running` ledger state.

## Alternatives Considered

**Let pi-ai usage land first, then copy the pattern for MCP.** Rejected. That is the shortest first diff but creates the second bug immediately: MCP would either duplicate LLM-specific accounting or diverge from it. One tiny shared recorder is less code overall.

**Build a generic gateway middleware framework.** Rejected. Two producers do not justify a framework. Direct calls into a shared recorder are enough.

**Asynchronous usage outbox from day one.** Deferred. Synchronous writes are simpler and correct. Add an outbox only when measured latency or failure isolation requires it.

**Only record usage, skip capability calls.** Rejected. Usage without `CapabilityCall` loses the permission, vault, lineage, and error context that makes the row explainable.

## Consequences

- pi-ai LLM usage and worker MCP usage become comparable because both attach to `CapabilityCall`.
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
- L1: unit tests for `GatewayCallContext`, idempotency keys, usage normalization, finish-state transitions, and redaction.
- L2: contract tests proving pi-ai LLM usage rows and MCP tool usage rows validate against the same schemas and attribution rules.
- L3: NanoCore black-box tests for one pi-ai-routed LLM call and one stub MCP tool call, each producing a capability call, usage rows, and audit linkage.
- L5: smoke test that a packaged NanoCore build can boot, make one governed LLM call through the pi-ai path, and make one stub MCP call without leaking secrets.
- L6: story acceptance that a worker task uses both LLM inference and one MCP tool, then product diagnostics show attributable usage for both under the same workspace.

Acceptance:

- One shared recorder is used by both producers.
- Every pi-ai-routed LLM call that reaches upstream emits durable LLM usage when usage is available.
- Every `mcp.call_tool` emits exactly one tool-call usage row when executed.
- Denied calls emit capability/audit records but no usage rows.
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
- Native OpenAI and Codex durable LLM usage producers.
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
