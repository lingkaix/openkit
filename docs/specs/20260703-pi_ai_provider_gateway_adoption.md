# Pi AI Provider Gateway Adoption

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the decision to adopt `@earendil-works/pi-ai` as the internal provider adapter layer inside the NanoCore LLM Gateway, the boundary rules that keep pi-ai out of OpenKit protocol and public API vocabulary, the mapping contract between gateway requests and pi-ai unified calls, the reconciliation rule between NanoCore provider configuration, the pi-ai model registry, and the `@openkit/models-dev-catalog` snapshot, the normalization of pi-ai per-call token and cost data into the `UsageRecord` family, gateway error normalization for pi-ai-routed calls, and the vendor pinning rules for the pi-ai dependency.

## Does Not Own

This spec does not own the gateway HTTP surface itself (`docs/specs/20260526-llm_gateway_responses_api.md` owns `/v1/chat/completions`, `/v1/responses`, capability routing, and Codex subscription routing), the `UsageRecord`, `AuditEvent`, or `CapabilityCall` record definitions (`docs/specs/20260703-audit_usage_evidence_records.md`), agent capability semantics (`docs/core/agent-capability.md`), the vendor snapshot packaging contract (`docs/specs/20260522-vendor_snapshot_packages.md`), vault secret storage, permission policy, or any MCP, network-egress, or third-party auth proxying.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

Related specs:

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`

## Summary

NanoCore adopts `@earendil-works/pi-ai` as the provider adapter layer behind the LLM Gateway dispatcher. pi-ai gives OpenKit one unified call surface across many LLM providers (OpenAI, Anthropic, Google, Mistral, Groq, Bedrock, OpenRouter, arbitrary OpenAI-compatible endpoints, and more) plus per-call token and cost accounting, so OpenKit stops writing and maintaining one hand-rolled adapter per provider.

pi-ai is an internal dependency of the gateway. The public OpenAI-compatible gateway surface (`POST /v1/chat/completions`, `POST /v1/responses`, `/v1/models`, `/health`) and the Codex subscription routing defined in `20260526-llm_gateway_responses_api.md` are unchanged. pi-ai types, event names, provider identifiers, and error shapes never appear in OpenKit protocol schemas, public APIs, or product vocabulary.

pi-ai per-call usage data becomes the first durable producer input for the `UsageRecord` family from the audit/usage spec, with provider, model, token classes, cache metrics, and cost estimates linked to capability calls and turns where available.

## Goals / Non-goals

### Goals

- Reach many more LLM providers through one adapter layer instead of per-provider hand-written adapters.
- Capture per-call token usage (input, output, cache read, cache write) and cost estimates for every pi-ai-routed gateway call.
- Normalize that usage into durable `UsageRecord` rows linked to workspace, thread, turn, capability call, and agent session where available.
- Keep the public gateway surface, Codex subscription routing, and gateway error envelope behavior stable.
- Keep NanoCore provider configuration as the single source of truth for which providers exist, which are enabled, and how they are authenticated.
- Treat pi-ai and its vendored model-catalog data as a pinned, reviewed external boundary.

### Non-goals

- Do not expose pi-ai as OpenKit protocol, public API, or configuration vocabulary.
- Do not change the `/v1/chat/completions` or `/v1/responses` request or response shapes.
- Do not change Codex subscription routing, account slots, or Codex token resolution from `20260526-llm_gateway_responses_api.md`.
- Do not use pi-ai's image generation, OAuth login flows, CLI login, `auth.json` storage, or agent loop in this slice.
- Do not implement automatic cross-provider fallback or mid-call handoff.
- Do not adopt pi-ai for MCP server proxying, third-party resource auth proxying, or unified network egress; those are out of scope and recorded under Deferred / Future Work.
- Do not treat pi-ai cost figures as billing truth; they are estimates.

## Background

The current gateway dispatcher (`apps/nanocore/src/llm/provider-dispatcher.ts`) reaches providers through two hand-written adapters: an OpenAI-compatible HTTP client and a ChatGPT Codex backend client. Every additional provider family (Anthropic-native, Google, Bedrock, Mistral, and so on) would require another hand-written adapter, another streaming parser, another usage extractor, and another error normalizer.

`@earendil-works/pi-ai` is a TypeScript library that provides a unified LLM API across many providers with automatic model discovery, provider configuration, per-call token and cost tracking, serializable conversation contexts, and cross-provider context replay. It only includes tool-calling-capable models, which matches OpenKit's agentic workload. Its unified streaming event model covers text, thinking/reasoning, and tool-call deltas, and its `AssistantMessage` carries a normalized `stopReason` and a `usage` object with token counts and a cost breakdown.

Separately, `docs/specs/20260703-audit_usage_evidence_records.md` defines `UsageRecordSchema` in `packages/protocol/src/models/usage.ts` but notes that no durable usage producer exists yet; the current `apps/nanocore/src/llm/gateway-usage.ts` summaries are process-local diagnostics only. pi-ai's per-call usage data is a natural first durable producer input.

## Decision

NanoCore adopts `@earendil-works/pi-ai` as the provider adapter layer inside the LLM Gateway dispatcher.

- pi-ai is an internal implementation dependency of the gateway dispatcher. It is never OpenKit protocol, public API, or product vocabulary.
- Routing scope: the NanoCore-native OpenAI adapter remains the path for `openai`-vendor providers, and the NanoCore-native Codex Responses client remains the Codex path. pi-ai routes the provider families where OpenKit has no native adapter (Anthropic, Google, Mistral, Groq, Bedrock, OpenRouter, and other OpenAI-compatible endpoints). Consolidating `openai`-vendor traffic onto pi-ai is a separate future decision, recorded under Deferred / Future Work.
- The gateway's public OpenAI-compatible surface and the Codex subscription routing path from `20260526-llm_gateway_responses_api.md` stay unchanged.
- NanoCore provider configuration (`DATA_ROOT/config/server.jsonc` and `DATA_ROOT/config/providers/*.provider.jsonc`) remains the source of truth for provider existence, enablement, credentials, default models, and capability routing. The pi-ai model registry is consulted for model metadata and adapter selection, never for authorization or enablement.
- For model catalog identity and provider-template traceability, the `@openkit/models-dev-catalog` vendor snapshot remains canonical. pi-ai's vendored model catalog is a second external boundary snapshot; it is authoritative only for the per-call cost estimate values pi-ai computes, and it must be reconciled against the models-dev catalog on every pi-ai upgrade.
- pi-ai per-call token and cost data is normalized into durable `UsageRecord` rows per the audit/usage spec.
- pi-ai is pinned to an exact npm version; upgrades are deliberate, reviewed external-boundary changes.

## Contract / Expected Behavior

### Boundary rule

- pi-ai MUST remain an internal dependency of the NanoCore LLM Gateway dispatcher.
- pi-ai type names, event names, provider identifiers, API identifiers (such as `anthropic-messages` or `openai-completions`), option names, and error strings MUST NOT appear in `packages/protocol` schemas, public app API responses, gateway response bodies, gateway error envelopes, product UI, or authored provider configuration vocabulary.
- Gateway public error envelopes MUST use OpenKit's stable gateway error codes; pi-ai-native error messages MAY be preserved only in redacted diagnostics and restricted evidence.
- Provider configuration authors MUST NOT need to know pi-ai exists. The mapping from an OpenKit provider config entry to a pi-ai provider, API family, or custom `Model` object is a dispatcher-internal concern.
- Replacing pi-ai later MUST be possible without changing any OpenKit protocol schema, public endpoint, or authored configuration file.

### Request mapping

- The dispatcher MUST translate incoming OpenAI-compatible Chat Completions and Responses requests into pi-ai unified calls: request messages map to a pi-ai `Context` (system/developer instructions to `systemPrompt`, user/assistant/tool messages to unified messages, function tools to pi-ai `Tool` definitions), and the resolved provider and model map to a pi-ai model reference or a dispatcher-constructed custom `Model` for OpenAI-compatible endpoints not in the pi-ai registry.
- Sampling and limit fields (`temperature`, `max_tokens`, `max_completion_tokens`, `max_output_tokens`, reasoning effort) MUST map to the corresponding pi-ai options; fields with no pi-ai equivalent follow the existing bridge rule and fail with the gateway's `unsupported_gateway_feature` error rather than being silently dropped, except where `20260526-llm_gateway_responses_api.md` already defines passthrough or silent-ignore behavior.
- Prompt cache fidelity is per route class. The `20260526` requirement that every upstream native call carries `prompt_cache_key` continues to apply to natively adapted OpenAI paths, which are unchanged by this spec. For pi-ai-routed providers, the dispatcher MUST map the resolved prompt cache key into pi-ai's session and caching options (`sessionId`, `cacheRetention`, and compat affinity headers) where the provider path supports them, and MUST record a cache fidelity class on each capability call: `native-key` (wire-level cache key preserved), `session-options` (affinity through pi-ai options), or `none` (the provider path has no cache affinity mechanism). The `20260526` cache-key requirement is explicitly narrowed by this contract to native paths; pi-ai-routed paths satisfy it through the recorded fidelity class instead of a wire-level guarantee. Cache read/write metrics reported by pi-ai MUST flow back into gateway cache diagnostics and usage records so cache effectiveness is observed rather than assumed.
- The dispatcher MUST pass credentials explicitly per call through vault- or config-mediated resolution. It MUST NOT rely on pi-ai's process-environment API key auto-detection as the credential path: absence of an explicit credential for a pi-ai-routed call is a typed configuration error and the dispatcher MUST fail the call closed rather than let pi-ai fall back to ambient process environment. A contract test MUST seed canary provider environment variables (for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and assert both that a call without explicit credentials fails closed and that canary values never appear in outbound requests. If a pi-ai provider path is found to read ambient environment keys despite explicit credentials, that provider family MUST NOT be routed through pi-ai until the leak is closed upstream or guarded locally. Secret values MUST NOT be written into pi-ai contexts, model objects that are logged, or any persisted record.

### Response and streaming mapping

- pi-ai streaming events MUST be converted to the public wire format of the requested endpoint: `text_start`/`text_delta`/`text_end` to OpenAI-compatible content deltas or Responses output-text events; `toolcall_start`/`toolcall_delta`/`toolcall_end` to tool-call delta chunks (using pi-ai's raw JSON argument `delta` fragments, not the partially parsed argument objects) or Responses function-call items; `done` to the terminal chunk with a mapped finish reason.
- The dispatcher MUST use pi-ai's `contentIndex` to demultiplex interleaved text, thinking, and tool-call blocks; it MUST NOT assume a block's start/delta/end sequence is contiguous.
- Stop reasons MUST map deterministically: `stop` to `stop` (Chat Completions) or a completed Responses status; `length` to `length`/incomplete-with-max-output-tokens; `toolUse` to `tool_calls`/completed-with-function-calls; `error` and `aborted` to the gateway's existing streaming terminal error normalization. The mapping table MUST be covered by contract tests.
- Thinking/reasoning content (`thinking_start`/`thinking_delta`/`thinking_end`) MUST map to OpenAI-compatible reasoning output where the requested endpoint defines a shape for it (Responses reasoning summary items). The gateway MUST NOT invent new public fields to carry thinking content on Chat Completions responses; where no OpenAI-compatible shape exists, thinking content is omitted from the public payload while its token consumption still lands in usage records.
- Non-streaming requests MUST use the same mapping applied to the final `AssistantMessage`.
- Because `openai`-vendor providers stay on the native adapter, the pi-ai mapping is required to guarantee Chat-Completions-level fidelity plus the bridged Responses behavior defined in `20260526` for non-native providers. Full Responses-native fidelity remains a native-adapter concern.

### Provider configuration ownership and catalog reconciliation

- NanoCore provider config MUST remain the source of truth for provider existence, enablement, credential references, default models, endpoint capability routing (`native`/`bridged`/`unsupported`), and Codex account-slot bindings. The pi-ai registry MUST NOT enable a provider or model that NanoCore config has not configured, and a model's presence in the pi-ai registry MUST NOT make it reachable through the gateway.
- The pi-ai model registry SHOULD be consulted for adapter selection (which API family a model speaks) and model metadata (context window, reasoning support, vision support, compat flags, cost table) for models NanoCore config routes to it.
- Precedence is: NanoCore provider config decides routing, enablement, and authorization; `@openkit/models-dev-catalog` remains the canonical external model-catalog boundary for catalog identity and provider-template traceability; the pi-ai vendored catalog is authoritative only for the per-call cost estimates pi-ai computes.
- pi-ai's vendored model catalog MUST be reconciled against the current `@openkit/models-dev-catalog` snapshot by a repository validation check: for models present in both, provider IDs, model IDs, and pricing MUST be compared, and divergence beyond the tolerance MUST fail review of a pi-ai upgrade until explicitly acknowledged. The default tolerance is 5% relative price difference per token class; provider ID and model ID mismatches have zero tolerance. The tolerance is a configurable parameter of the reconciliation check. When the two catalogs disagree within tolerance, product-facing catalog displays follow models-dev-catalog; recorded cost estimates keep the pi-ai figure with its measurement source labeled.

### Usage capture

- Every pi-ai-routed gateway call MUST produce durable `UsageRecord` rows per `docs/specs/20260703-audit_usage_evidence_records.md`, with `category: "llm"`, `providerRef` set to the OpenKit provider instance ID (never the pi-ai provider name), `modelId`, token-class quantities (input, output, cache read, cache write as distinct units or cache metrics), `costEstimate` from pi-ai's cost breakdown when available, a `source` value identifying pi-ai-reported measurement, `recordedAt`, and `requestId`.
- Usage rows MUST carry `workspaceId` and MUST link `capabilityCallId`, `turnId`, `threadId`, `itemId`, `agentId`, and `agentSessionId` whenever the gateway request context provides them, following the attribution order in `docs/core/agent-capability.md`.
- Cost values are estimates derived from pi-ai's vendored price table; they MUST be recorded as estimates and MUST NOT be presented as billing truth.
- Failed and aborted calls that consumed upstream resources MUST still record their partial usage (pi-ai reports partial token counts on `error`/`aborted` messages). Calls rejected before any upstream request emit audit and permission records only, not usage records.
- The existing process-local `gateway-usage` summaries remain diagnostics; they MAY be fed from the same normalized data but are not the durable ledger.
- Usage records MUST NOT contain prompt text, tool arguments, secret values, raw prompt cache keys, or pi-ai-native payloads.

### Error normalization and fallback

- Upstream provider failures surfaced by pi-ai (error events, `stopReason: "error"`) MUST be normalized into the gateway's existing OpenAI-compatible error envelopes with stable gateway error codes, distinguishing provider authentication failures, provider rate limits, provider unavailability, context overflow, and request validation failures where pi-ai exposes enough signal.
- Failures inside pi-ai itself (registry loading, adapter bugs, unexpected exceptions) MUST map to a stable internal gateway error code, fail the request closed, and never leak pi-ai stack traces or internal vocabulary into public error bodies.
- Client aborts MUST map to the existing cancelled-request behavior, and mid-stream terminal errors MUST use the gateway's existing streaming terminal error normalization.
- The gateway MUST NOT silently retry a failed call against a different provider or model. pi-ai's cross-provider handoff capability MAY only be exercised by an explicit caller- or policy-directed decision, never as implicit fallback.
- Every normalized failure SHOULD produce a capability-call record with a stable error code, and redacted provider error detail belongs in diagnostics or restricted evidence, not public envelopes.

### Vendor pinning

- `@earendil-works/pi-ai` MUST be declared with an exact pinned version (no `^` or `~` range) in the consuming package's `package.json`.
- Upgrades MUST be deliberate, reviewed changes: the review MUST cover pi-ai's changelog, changes to its vendored model catalog, and the catalog reconciliation check against `@openkit/models-dev-catalog`, following the external-boundary review posture of `docs/specs/20260522-vendor_snapshot_packages.md`.
- The model-catalog data pi-ai ships is treated as an external boundary snapshot: read-only at runtime, never live-refreshed at boot, and never a source for OpenKit protocol definitions.
- Contract tests for event mapping, stop reasons, and usage normalization MUST run against the pinned version so upgrades surface behavioral drift before merge.

## Accepted Design

The dispatcher grows a pi-ai adapter path alongside the existing native OpenAI-compatible and Codex adapters:

1. Route resolution stays as-is: gateway policy, provider registry, capability matrix, and prompt cache key resolution run before any adapter is chosen.
2. For providers routed to pi-ai, the dispatcher builds a pi-ai model reference — from the pi-ai registry when the provider/model pair exists there, or a custom `Model` object (baseUrl, API family, compat flags) synthesized from NanoCore provider config for arbitrary OpenAI-compatible endpoints.
3. The request converter builds a pi-ai `Context` from the incoming Chat Completions or Responses body; the response converter turns pi-ai events back into the requested public wire format.
4. `PiAiGatewayClient` reports each final or terminal-error `AssistantMessage.usage` once through an internal observer before public OpenAI normalization. The dispatcher sends that same raw observation to the existing process-local diagnostics tracker and, when workspace attribution exists, the shared capability usage ledger.
5. pi-ai's `onPayload` hook MAY feed redacted diagnostics for payload debugging; raw payloads remain restricted evidence.
6. pi-ai's faux provider (`registerFauxProvider`) MAY be used for deterministic dispatcher and usage-normalization tests without network access.

Which existing routes move onto pi-ai first is an implementation-ordering choice; the expected first slice is non-OpenAI providers (Anthropic, Google, and OpenAI-compatible endpoints) where OpenKit currently has no native adapter, keeping the existing OpenAI and Codex paths untouched.

## Current Implementation Projection

The first implementation slice is in place. NanoCore declares `@earendil-works/pi-ai` as an exact-pinned dependency at `0.80.3`, keeps the transitive `@google/genai` and `protobufjs` build scripts explicitly disallowed in `pnpm-workspace.yaml`, and has a focused boundary test proving the pinned dependency is importable from NanoCore.

Pi-ai terminal usage now stays raw only until it reaches the existing gateway usage boundary. `PiAiGatewayClient` invokes one optional observer for success, provider-error, and aborted terminal outcomes before returning or throwing; `LLMGatewayProviderDispatcher` records that observation once in process-local diagnostics and forwards it to the existing App usage context. `apps/nanocore/src/llm/gateway-usage.ts` recognizes pi-ai `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost.total` fields while preserving the previous public diagnostics semantics. The former standalone `pi-ai-usage.ts` normalizer and its duplicate schema construction are deleted.

The dispatcher adapter path is now the steady-state non-Codex provider path. The resolved backend value is limited to `pi-ai` and `codex-oauth`; `LLMGatewayProviderDispatcher` routes every non-Codex-OAuth Chat Completions and Responses request through `PiAiGatewayClient`, while Codex OAuth stays on the dedicated Codex subscription Responses client. The adapter converts text Chat Completions contexts plus function tools into pi-ai contexts, maps pi-ai assistant messages, tool calls, text stream deltas, and tool-call stream deltas back to the public Chat Completions response and SSE chunk shapes, maps stop reasons for `stop`, `length`, and `toolUse`, records process-local gateway usage diagnostics from normalized Chat usage payloads, and fails closed before pi-ai can read ambient provider credentials.

Runtime provider profiles are the only configured-provider source of truth. The profile-to-dispatch projection keeps only the configured instance id, adapter id, backend, explicit credential requirement, and Gateway capabilities required by runtime clients. Catalog model behavior is rebound to the configured instance before dispatch so the instance endpoint and explicit credential boundary remain authoritative. Non-Codex profiles route through pi-ai, with OpenAI native Responses available through pi-ai `openai-responses` and chat-native providers bridged through pi-ai Chat Completions; custom or local OpenAI-compatible profiles synthesize internal pi-ai providers when no pi-ai catalog entry exists, using conservative capability defaults until the runtime profile schema owns an explicit capability. The default pi-ai model collection registers the OpenAI, Anthropic, Google, OpenRouter, DeepSeek, Groq, Moonshot, xAI, and zAI provider modules needed by configured model templates. `/v1/models` lists the model ids declared by the current runtime provider profiles, while provider readiness comes from runtime profile diagnostics and credential resolution rather than a separate LLM config-store health checker.

The durable public gateway usage slice is also in place for workspace-attributed pi-ai Chat Completions and Responses calls, including successful calls, failed non-streaming calls when pi-ai reports terminal usage before failure, and failed Chat Completions streams when pi-ai reports terminal usage before the stream failure: `apps/nanocore/src/app.ts` starts a shared `CapabilityCall` before dispatch, writes positive linked `UsageRecord` rows for input, output, cache-read, and cache-write tokens plus one `unit: "usd"` cost-estimate row when pi-ai reports a positive estimate, and marks failed started calls terminal through the shared recorder. Estimated USD is provider-catalog telemetry, never billing truth. Public OpenAI-compatible responses, SSE, errors, diagnostics, and durable rows never expose raw pi-ai objects, cache keys, prompts, tool arguments, or credentials. Workspace-scoped capability usage evidence is exposed through `GET /api/app/workspaces/:workspaceId/capability-usage`, `client.app.getCapabilityUsage`, and the unified Skill/CLI `usage.read` operation, giving release validation a public read model instead of requiring private SQLite inspection. Gateway provider errors normalize available provider signal into stable public codes for authentication failure, rate limiting, provider unavailability, context overflow, and request validation while still redacting provider text. The first catalog reconciliation gate is in place: `packages/models-dev-catalog/scripts/validate.mjs` verifies the metadata-declared pi-ai version and compares shared Anthropic model prices plus Google/OpenRouter template models against the models.dev snapshot at the accepted 5% tolerance, and root `check:repo` runs that validator. Local L5 NanoCore e2e smoke passes with pi-ai installed. The L6 story artifact for opt-in real-provider gateway validation exists at `tests/stories/pi-ai-gateway-real-provider.story.md`, and the skip-aware runner `tests/story-runner/pi-ai-real-provider-runner.mjs` validates NanoCore diagnostics readiness, non-streaming output, streaming `[DONE]`, usage evidence, and credential-shaped leak scanning against an explicitly configured deployment with schema-valid UUID request ids; unconfigured gateway defaults stop at diagnostics preflight and write redacted failure evidence before any provider call, while failed non-streaming gateway calls include the public error code and message in the runner failure summary and write redacted failure evidence plus a leak-scan file without dumping raw response bodies or secrets. A 2026-07-08 a1 validation run configured the gateway default to the custom OpenAI-compatible provider `openai-compatible-custom` with model `gpt-5.4-mini`, confirmed `/api/app/diagnostics` reported `configured: true`, and passed the opt-in quota-gated real-provider L6 runner. The evidence directory `/home/ubuntu/openkit-nanocore-runtime/evidence/pi-ai-real-provider-20260708-custom` records `status: "passed"`, non-streaming status `200`, streaming completion with `[DONE]`, one successful `CapabilityCall`, five linked `UsageRecord` rows, and zero leak-scan matches.

Relevant current code:

- `apps/nanocore/src/llm/provider-dispatcher.ts`: dispatcher with Codex OAuth as the explicit special path and Pi AI as the backend for every other provider.
- `apps/nanocore/src/llm/pi-ai-client.ts`: internal pi-ai adapter for Chat Completions, Responses, and custom OpenAI-compatible provider synthesis.
- `apps/nanocore/src/providers/llm-config.ts`: minimal runtime-profile projection for provider dispatch.
- `apps/nanocore/src/llm/openai-compatible-client.ts`: shared OpenAI-compatible wire types and normalized provider errors; the retired generic transport is removed.
- `apps/nanocore/src/llm/codex-responses-client.ts`: production transport for the Codex OAuth path.
- `apps/nanocore/src/llm/gateway-usage.ts`: the shared provider-usage parser and process-local diagnostics tracker, not a durable ledger.
- `tests/story-runner/pi-ai-real-provider-runner.mjs`: opt-in L6 runner for real-provider public gateway validation and redacted evidence capture.
- `apps/nanocore/src/llm/prompt-cache-key.ts`: prompt cache key resolver whose output must be mapped into pi-ai session/caching options.
- `packages/protocol/src/models/usage.ts`: `UsageRecordSchema`, including token and estimated-USD units used by durable producers.
- `packages/models-dev-catalog/`: canonical external model-catalog snapshot and first pi-ai reconciliation gate.

## Alternatives Considered

**Per-provider hand-written adapters (status quo).** Full control over wire behavior, streaming, and error semantics, with no third-party dependency in the hot path. But every provider family costs a new adapter, streaming parser, usage extractor, and error normalizer, and OpenKit gets no cost tables or model metadata for free. The maintenance cost scales linearly with providers, which is exactly what this adoption avoids. Kept for OpenAI-native and Codex paths where OpenKit already has hardened adapters.

**Vercel AI SDK.** Large ecosystem and many provider packages, but it is oriented toward application-level UI/agent integration rather than a server-side gateway adapter layer, spreads provider support across many separately versioned packages (more churn to pin and review), and does not ship the built-in per-call cost accounting and single vendored model catalog that motivated this adoption. Heavier abstraction to hide behind a strict boundary.

**LiteLLM-style proxy (separate gateway process).** Broad provider coverage and battle-tested, but it is a separate service (Python runtime, its own config file, its own credential store), adding a deployment unit, a network hop, and a second source of truth for provider configuration — directly against the NanoCore-config-owns-providers rule and deterministic local boot. A library inside the dispatcher keeps routing, policy, metering, and audit in one process.

**Hosted aggregation gateways (OpenRouter-class services).** Minimal code, but all traffic and credentials flow through a third party, which conflicts with OpenKit's egress, vault, and audit posture as a default path. Note pi-ai itself can still reach OpenRouter as one provider among many when a deployment explicitly configures it.

## Consequences

- Adding a provider that pi-ai supports becomes configuration plus routing tests, not a new adapter.
- OpenKit gains per-call token and cost data uniformly across providers, unblocking the first durable `UsageRecord` producer.
- The gateway takes a third-party dependency in the inference hot path; its bugs become gateway incidents, mitigated by exact pinning, contract tests, and the boundary rule that keeps replacement possible.
- Two external model catalogs now exist in the repository dependency graph (models-dev-catalog and pi-ai's vendored catalog), requiring an explicit reconciliation check.
- Responses-surface fidelity for pi-ai-routed providers is bounded by pi-ai's unified message model; features outside it keep failing explicitly as unsupported gateway features.

## Rollout / Migration Plan

1. Land the pinned dependency, the dispatcher adapter path behind provider routing, and the mapping plus usage-normalization contract tests, with no provider routed to pi-ai by default. The pinned dependency, usage-normalization contract test, non-streaming Chat Completions adapter path, dispatcher branch, and credential-isolation canary test are complete.
2. Route the first non-OpenAI provider family through pi-ai and validate streaming, tool calls, stop reasons, error normalization, and usage rows end to end. The Anthropic Chat Completions slice, including text streaming, function tools, tool-call stream deltas, the text-only bridged Responses slice, runtime profile routing for Google/OpenRouter/xAI, custom OpenAI-compatible provider synthesis, durable usage rows for workspace-attributed public calls, a public capability usage read model, and a passing quota-gated real-provider L6 run are complete.
3. Enable durable `UsageRecord` emission for pi-ai-routed calls and expand the repository reconciliation check as each additional provider family becomes pi-ai-routed. The first Anthropic reconciliation slice is in root `check:repo`.
4. Expand provider routing deliberately, per provider family, with routing tests per addition.

No backward-compatibility layer is kept for any internal adapter shape this replaces; replaced internal code is removed in the same change.

## Testing Strategy / Acceptance Criteria

Levels follow `docs/specs/20260529-test_strategy.md`.

- L0: dependency pinning check (exact version, no range) and the pi-ai/models-dev-catalog reconciliation validation run in repository verification.
- L1: unit tests for request conversion (messages, tools, sampling fields, prompt-cache mapping), event demultiplexing by `contentIndex`, stop-reason mapping, thinking-content handling, and error-code normalization, using pi-ai's faux provider or fixtures — no network. pi-ai's faux provider is the default harness for dispatcher-internal L1/L2 tests; the existing gateway mock servers remain the harness for wire-level L3 black-box tests.
- L2: contract tests are the acceptance backbone for usage normalization: given recorded pi-ai `AssistantMessage.usage` shapes (success, `length`, `toolUse`, `error`, `aborted`, cache hits), the normalizer MUST emit `UsageRecord` rows that validate against `UsageRecordSchema` with correct provider instance ID, model ID, token classes, cache metrics, cost estimate, measurement source, and full available attribution (workspace, thread, turn, item, capability call, agent session). Conformance tests also cover the public wire shapes of converted streaming output and error envelopes, asserting no pi-ai vocabulary leaks.
- L3: black-box gateway tests against a stub provider endpoint through the pi-ai path: streaming and non-streaming Chat Completions and Responses, tool-call round trips, mid-stream provider failure, client abort with partial-usage recording, and unknown-model rejection.
- L4: no dedicated browser coverage; existing diagnostics pages MUST keep rendering with pi-ai-routed usage present.
- L5: smoke checks that a NanoCore build with pi-ai installed boots without network fetches and reports gateway health.
- L6: existing story acceptance flows MUST pass unchanged when their provider is routed through pi-ai; real-provider runs stay skip-aware and quota-gated per the 20260526 verification rules.
- Manual L6: `pnpm -w test:stories:real-provider` MUST remain skipped by default and MUST require `OPENKIT_L6_REAL_PROVIDER=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_L6_GATEWAY_BASE_URL`, `OPENKIT_L6_GATEWAY_PROVIDER_ID`, `OPENKIT_L6_GATEWAY_MODEL`, `OPENKIT_L6_GATEWAY_WORKSPACE_ID`, and `OPENKIT_L6_EVIDENCE_DIR` before it calls an existing NanoCore deployment.

Acceptance criteria:

- All public gateway surface tests from `20260526-llm_gateway_responses_api.md` pass unchanged with pi-ai routing enabled.
- Every pi-ai-routed call (including failed and aborted calls with upstream consumption) yields schema-valid, attributed usage rows.
- No pi-ai identifier appears in any public response body, error envelope, protocol schema, or authored config example.
- A pi-ai version bump with catalog changes fails verification until the reconciliation check is acknowledged.

## Risks & Mitigations

- Risk: pi-ai's unified model cannot express some OpenAI-compatible request features, silently degrading requests. Mitigation: explicit `unsupported_gateway_feature` failures and per-field mapping tests; no silent drops beyond already-specified passthrough rules.
- Risk: pi-ai upgrade changes event ordering, stop reasons, or usage shapes. Mitigation: exact pinning plus L1/L2 contract tests that run against the pinned version and fail on drift.
- Risk: cost estimates from pi-ai's price table drift from reality and get treated as billing truth. Mitigation: estimates are labeled with measurement source, reconciled against models-dev-catalog, and excluded from billing claims.
- Risk: pi-ai's env-var key auto-detection creates an unaudited credential path. Mitigation: explicit per-call credential injection is the contract, plus a test asserting provider keys are not resolved from process env on the gateway path.
- Risk: pi-ai vocabulary leaks into product surfaces through error messages or diagnostics. Mitigation: leak-check assertions in L2 conformance tests and redaction of pi-ai-native detail into restricted evidence.

## Resolved Decisions

Previously blocking questions are resolved in the contract above: the native OpenAI adapter and native Codex client keep their paths and pi-ai routes only provider families without a native adapter; the `20260526` prompt-cache-key requirement is narrowed to native paths with a recorded per-call cache fidelity class on pi-ai-routed paths; and credential isolation is guaranteed by the explicit-credential fail-closed rule plus canary environment tests. Thinking content stays Responses-only with no invented Chat Completions fields, the faux provider complements (not replaces) gateway mock servers, and the catalog reconciliation tolerance defaults to 5%.

## Deferred / Future Work

The following are explicitly out of scope for this spec and belong to the product roadmap (`docs/roadmap.md`):

- MCP server proxying through the gateway or through any pi-ai-adjacent layer.
- Third-party resource auth proxying (OAuth brokering for non-LLM services).
- Unified network egress control for worker agents.
- pi-ai OAuth-based provider logins (Anthropic subscription, GitHub Copilot, Gemini CLI) as OpenKit provider paths.
- Image generation through pi-ai's image API surface.
- Explicit policy-directed cross-provider handoff using pi-ai context replay.
- Budget and rate-limit enforcement built on the new durable usage rows (owned by agent capability when promoted).
- Consolidating `openai`-vendor traffic onto pi-ai, replacing the native OpenAI adapter, if maintenance cost justifies it after the pi-ai path is proven.
- Migrating the Codex path from the NanoCore-native Codex Responses client to pi-ai's `openai-codex-responses` API, once the account-slot and token-resolution contract can be preserved.

OpenKit should consider internalizing or replacing pi-ai only when one of these external-boundary triggers occurs: upstream abandonment, upstream direction divergence from OpenKit's server-side gateway needs, a license change that conflicts with OpenKit distribution, or repeated security-response failure on a material vulnerability. Normal adapter bugs, missing provider families, or one-off catalog drift are not enough to fork the boundary; they should be handled through pinning, local guards, or provider-family deferral first.

The native OpenAI adapter and pi-ai OpenAI path should be re-evaluated only with measured maintenance evidence. The decision criterion is whether the ongoing cost of maintaining the native OpenAI adapter exceeds the measured fidelity and risk cost of routing OpenAI traffic through pi-ai while preserving prompt-cache behavior, streaming chunks, Responses semantics, error envelopes, usage rows, and account isolation. Until that evidence exists, the native OpenAI adapter remains the production path and pi-ai remains the non-native provider-family path.

Remaining implementation before this spec can be marked `Implemented`: execute the opt-in real-provider validation story against the selected non-OpenAI provider, confirm schema-valid attributed usage rows from the real provider path, and reduce any confirmed defects into L1-L5 regression coverage or update this spec if the provider boundary changes.

Release closeout on a1 is intentionally operational, not another product feature: install one approved non-OpenAI provider credential for the current gateway default (`google` with `gemini-2.5-pro`) through the deployment's approved secret path, restart `openkit-nanocore.service`, confirm `/api/app/diagnostics` reports `defaultProviders.gateway.configured: true`, then run `OPENKIT_L6_REAL_PROVIDER=1 OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1 OPENKIT_L6_GATEWAY_BASE_URL=http://127.0.0.1:54001 OPENKIT_L6_GATEWAY_PROVIDER_ID=google OPENKIT_L6_GATEWAY_MODEL=gemini-2.5-pro OPENKIT_L6_GATEWAY_WORKSPACE_ID=ws_demo OPENKIT_L6_EVIDENCE_DIR=/tmp/openkit-pi-ai-real-provider-evidence pnpm -w test:stories:real-provider` from `/home/ubuntu/loop0-openkit`.

## Links

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `packages/models-dev-catalog/README.md`
- pi-ai upstream: `https://github.com/earendil-works/pi/tree/main/packages/ai`
