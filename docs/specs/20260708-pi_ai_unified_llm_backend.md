# Pi AI Unified LLM Backend

Status: Accepted
Implementation: Partial

## Owns

This spec is the sole owner of non-Codex LLM backend selection and provider routing, including request, response, streaming, provider-error, usage, credential, provider-capability, and cache-scope mapping through `@earendil-works/pi-ai`. It also owns removal of the hand-written OpenAI-compatible provider client from dispatch, the accepted native pi-ai Responses target, and the provider-agnostic cache-scope input contract for separately authorized Internal Core Role calls, public Gateway callers, and worker agents.

## Does Not Own

This spec does not own the public Gateway HTTP contract, which remains with `docs/specs/20260526-llm_gateway_responses_api.md`; pi-ai adoption, exact pinning, public-vocabulary isolation, or models.dev reconciliation, which remain with `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`; Codex subscription login and account-slot semantics; durable capability and usage record schemas or lifecycle; worker capability semantics; or authorization for an Internal Core Role to call a provider, which must come from that role's owning specification.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/metering.md`
- `docs/core/vault.md`
- `docs/core/work-model.md`

Related specs:

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`

## Summary

NanoCore uses one LLM provider backend model: Codex OAuth traffic uses the dedicated Codex client because it is a subscription-backed ChatGPT/Codex account path, and every other LLM provider route uses pi-ai. The public OpenAI-compatible Gateway remains `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/health`; NanoCore does not maintain a second generic OpenAI-compatible HTTP transport beside pi-ai.

Native pi-ai Responses routing remains an accepted part of this contract but is not implemented: the current pi-ai Responses methods bridge through Chat Completions. WP-5A deliberately excludes native Responses fidelity work, so this bounded gap keeps the implementation alignment `Partial` without changing the accepted backend boundary.

The cache contract is provider-agnostic: NanoCore supplies a bounded cache scope to the adapter and observes provider-reported cache-read and cache-write quantities when available. Cache scope is input, not proof that a specific wire field was sent or that a provider produced a cache hit.

## Decision

NanoCore routes all non-Codex-OAuth providers through pi-ai and does not expose a generic `openai-compatible` backend in provider dispatch.

- `codex-oauth` remains a special backend because it resolves ChatGPT/Codex subscription credentials, account slots, and Codex-specific Responses behavior.
- `pi-ai` becomes the only general hosted, gateway, local, and custom LLM backend.
- OpenAI API providers use pi-ai's OpenAI API families; native `openai-responses` remains required where the selected model and endpoint support Responses, but is the bounded unimplemented part of this accepted contract.
- OpenAI-compatible custom endpoints use pi-ai `openai-completions` by default and may opt into pi-ai `openai-responses` only when NanoCore provider config declares Responses support explicitly.
- Provider configuration authors still write OpenKit provider profiles under the vocabulary boundary owned by S41, and the public Gateway keeps the OpenAI-compatible request and response shapes owned by S40.

## Goals

- Delete the steady-state need for NanoCore to maintain a generic OpenAI-compatible HTTP provider client.
- Use pi-ai for OpenAI, OpenAI-compatible custom endpoints, Anthropic, Google, OpenRouter, xAI, and other future provider families.
- Keep Codex OAuth separate and explicit.
- Preserve `/v1/chat/completions` and `/v1/responses` as stable public Gateway entry points.
- Support native OpenAI Responses behavior through pi-ai instead of bridging every Responses request through Chat Completions.
- Keep cache-scope input consistent across separately authorized provider-backed Internal Core Role calls, worker agents, and public Gateway callers without promising wire fidelity or a hit.
- Preserve durable usage evidence for input, output, cache read, cache write, cost estimates, provider, model, and server-owned attribution where available.
- Fail closed when pi-ai cannot represent an unsupported request field without semantic loss.

## Non-goals

- Do not change the public Gateway route names or basic OpenAI-compatible shapes.
- Do not merge Codex OAuth into pi-ai.
- Do not introduce a standalone cache service, local KV-cache, prompt snapshot store, or prewarming scheduler in this slice.
- Do not expose raw ownership ids, provider credential ids, prompt text, tool arguments, or raw cache input in provider-visible values or public logs and diagnostics. Durable records may retain caller-asserted public labels only as explicitly non-authoritative metadata; server-owned attribution is the only authority under S43.
- Do not guarantee cache hits. Providers own actual cache storage, expiry, pricing, routing, and overflow behavior.
- Do not implement automatic provider fallback or cross-provider handoff.

## Target Backend Model

The final backend split is:

```text
Codex OAuth provider profiles
  -> Codex Responses client

All other provider profiles
  -> PiAiGatewayClient
  -> pi-ai provider registry or NanoCore-synthesized pi-ai custom provider
```

The provider registry does not expose `openai-compatible` as a backend. A non-Codex provider uses `pi-ai` unless it is deliberately unsupported. Backend selection never supersedes provider-profile authority: readiness omitted, `ready`, and `degraded` are runnable, `blocked`, `disabled`, and `unknown` fail before credential resolution, and only models explicitly listed by the selected profile may reach pi-ai.

The retired `OpenAICompatibleChatClient` migration fixture is removed. Shared OpenAI-compatible wire types and normalized provider errors remain independent of transport selection.

## Current Implementation Projection

Every non-Codex-OAuth provider profile resolves to the pi-ai backend, and production Gateway dispatch no longer uses the hand-written OpenAI-compatible transport. Chat Completions, custom-provider synthesis, streaming conversion, provider-error normalization, and provider-reported usage mapping are implemented through `PiAiGatewayClient`.

Native pi-ai Responses is not implemented. `PiAiGatewayClient.createResponses` and `createResponsesStream` currently convert Responses input to Chat Completions, call the pi-ai Chat path, and convert the result back. This bridge remains valid only for the bounded shapes accepted by S40; unsupported shapes fail explicitly. WP-5A does not implement native Responses, content-index or thinking projection, expanded stop-reason handling, or cancellation partial-usage work, so this bounded native-Responses fidelity gap keeps the spec at `Implementation: Partial`.

## Request Routing Contract

### Chat Completions

`POST /v1/chat/completions` requests route to `PiAiGatewayClient` for every non-Codex-OAuth provider. The adapter maps system, developer, user, assistant, and tool messages into pi-ai `Context`, maps function tools to pi-ai tools, maps supported sampling and max-token fields into pi-ai options, and rejects unsupported fields that pi-ai cannot preserve.

### Responses

`POST /v1/responses` requests must use a native pi-ai Responses route when the resolved provider model and configured endpoint capability speak an OpenAI Responses-compatible API family. This remains the accepted but unimplemented criterion that keeps this spec partial.

If a provider is chat-native only, Responses may be bridged through pi-ai Chat Completions only when the request is text-only and the bridge preserves the requested semantics. Built-in Responses tools, file inputs, computer use, remote MCP tools, image inputs, or other shapes that cannot be represented through the bridge must fail with `unsupported_gateway_feature`.

### Custom OpenAI-Compatible Endpoints

Runtime custom provider profiles synthesize a pi-ai provider when no pi-ai catalog entry exists. The default synthesized API family is `openai-completions`.

A custom endpoint may use `openai-responses` only if the provider profile explicitly declares Responses-native support. NanoCore must not guess Responses support from URL shape or model name.

### Provider Capability Matrix

Provider endpoint capability remains explicit:

```ts
{
  chatCompletions: "native" | "bridged" | "unsupported",
  responses: "native" | "bridged" | "unsupported"
}
```

The capability matrix is still OpenKit configuration vocabulary. The pi-ai model registry may inform adapter selection and metadata only after NanoCore proves the profile dispatchable and the request model explicitly configured; it must not silently enable a provider, model, endpoint family, or credential path that OpenKit config did not enable. The same predicate filters `/v1/models` together with the Gateway provider allowlist, so discovery never advertises blocked, disabled, unknown, disallowed, or adapter-discovered supply.

Every provider failure crossing the public JSON or SSE boundary uses a stable OpenKit code and fixed generic message. Upstream error text, provider-native codes and types, response bodies, pi-ai vocabulary, and stack traces remain internal even when the error classifier uses them to select authentication, rate-limit, context-overflow, invalid-request, provider-unavailable, or generic failure classes.

### Keyless local endpoints

Hosted provider profiles that require a credential fail before pi-ai when NanoCore cannot resolve their explicit configured secret. NanoCore never lets pi-ai read ambient provider credentials.

When a configured local or private provider explicitly requires no API key, `PiAiGatewayClient` supplies the fixed non-secret value `openkit-keyless` only because the stock pi-ai OpenAI Completions adapter rejects a missing API-key option before contacting a keyless endpoint. This value carries no authorization or credential authority, is never persisted or exposed through public logs or evidence, and may be sent only to the profile's configured endpoint. The endpoint must accept or ignore it; rejection remains an ordinary provider failure. This bounded dependency compromise does not authorize ambient credential fallback, provider-specific headers, or a second transport.

## Prompt Cache Contract

### Cache scope input

OpenKit provides one normalized cache scope to `PiAiGatewayClient`. The scope is adapter input only; it does not prove that pi-ai or an upstream provider emitted a particular wire field, retained a cache entry, or produced a cache hit.

The scope may use the following non-secret values when their owner can prove them:

```text
providerId
model
codexOAuthAccountSlotId when relevant
workspaceId
threadId
agentSessionId
sessionId
```

For a separately authorized Internal Core Role or worker call, trusted attribution must come from server-owned request identity, the authenticated actor and authorized Workspace, a server-resolved thread, and AEP-owned turn, agent, and agent-session records when available. Public request metadata must never supply or override those owners, although caller-asserted values may be retained separately as best-effort labels. This cache contract constrains an already-authorized call and never authorizes one.

Public Gateway callers may optionally provide `prompt_cache_key` or `metadata.openkit.*` as cache-scope or diagnostic hints. A caller-supplied Workspace id is only requested scope until the authenticated actor is authorized for that Workspace. Other caller-supplied lineage may be retained as caller-asserted best-effort labels but never becomes trusted provenance or authority. Calls with no Workspace scope still dispatch and produce process-local diagnostics only; a supplied unauthorized Workspace fails closed before provider dispatch.

Server-owned scope takes precedence for trusted attribution. When no stable cache hint or server-owned scope is available, NanoCore uses request-scoped cache input. Any provider-facing derivative must not expose raw workspace, thread, session, account, provider credential, prompt, or user identifiers.

### Provider mapping

`PiAiGatewayClient` passes normalized cache scope and retention input to pi-ai as `sessionId` and `cacheRetention` when present. This proves adapter input only; it does not require or claim an exact upstream cache key, header, breakpoint, sticky route, or other provider wire representation. A provider path that does not support cache input may ignore it without changing request ownership or success semantics.

### Cache effectiveness evidence

Only provider-reported cache-read and cache-write quantities establish cache effectiveness. Their absence means effectiveness is unknown, not that a cache miss occurred. Usage records and read models preserve those quantities when available without exposing raw cache input.

No cache-fidelity class, wire-fidelity record, inferred hit, or successful cache hit is required by this contract.

## Rollout / Remaining Implementation

Non-Codex backend consolidation and removal of the hand-written transport are complete. The remaining accepted work is native pi-ai Responses routing and its focused mapping tests. WP-5A explicitly excludes that work; until a later owning slice implements it, bridgeable Responses requests use Chat Completions conversion and non-bridgeable requests fail explicitly. No backward-compatible internal routing alias is required.

## Testing Strategy

- L1: provider config tests prove every non-Codex provider resolves to pi-ai and Codex OAuth resolves to the Codex client.
- L1: cache-scope tests prove server-owned attribution cannot be overridden by public metadata, optional public hints and request fallback remain dispatchable, raw ownership ids are not exposed, and cache effectiveness is read only from provider-reported cache-read and cache-write usage.
- L1: pi-ai adapter tests prove Chat Completions mapping, custom OpenAI-compatible provider synthesis, the fixed non-authorizing keyless-local placeholder, unsupported field rejection, and no ambient credential fallback. Native Responses mapping tests are required before this spec may become `Implemented`.
- L2: contract tests prove public Gateway error envelopes, streaming chunks, tool-call deltas, usage normalization, and no pi-ai vocabulary leakage.
- L3: black-box Gateway tests prove `/v1/chat/completions` and `/v1/responses` work through pi-ai for OpenAI-compatible and non-OpenAI providers.
- L5: NanoCore smoke proves boot with pi-ai only for non-Codex provider dispatch.
- L6: the quota-gated real-provider story uses one configured non-custom provider and proves a successful non-streaming call, streaming completion, accepted cache-scope input, provider-reported cache-read or cache-write usage when available, and zero secret or cache-input leaks. It does not require a custom provider or a cache hit.

## Acceptance Criteria

- No production Gateway request path uses the hand-written OpenAI-compatible client for non-Codex providers.
- OpenAI `/v1/responses` traffic can route through pi-ai as native Responses when configured.
- Chat Completions and Responses public wire shapes remain compatible with existing accepted Gateway tests.
- Custom OpenAI-compatible endpoints route through pi-ai-synthesized providers.
- Keyless local or private endpoints receive only the fixed non-secret `openkit-keyless` compatibility value; hosted profiles still require an explicitly resolved credential and pi-ai receives no ambient provider secret.
- Separately authorized provider-backed Internal Core Role and worker calls derive trusted persistent request, Workspace, thread, turn, agent, and agent-session ownership only from server-owned and AEP-owned records; public metadata may persist only as caller-asserted best-effort labels.
- Public metadata remains optional hints; a public call with no Workspace scope still dispatches and remains process-local-only, while a supplied unauthorized Workspace fails closed.
- Provider-visible cache derivatives and public logs or diagnostics expose no raw ownership ids, prompt text, tool arguments, or secrets; any caller-asserted public labels in durable usage remain explicitly non-authoritative, while only server-owned attribution carries authority under S43.
- Usage evidence records cache read and cache write quantities when provider data is available.
- Gateway diagnostics may show provider-reported cache effectiveness without exposing raw cache input; no wire-fidelity class, inferred hit, or successful cache hit is required.

## Alternatives Considered

**Keep the native OpenAI-compatible client permanently.** This keeps current OpenAI wire control, but it leaves two general provider backends and duplicates request mapping, streaming parsing, usage extraction, error normalization, and cache behavior. This is rejected as the steady state.

**Use pi-ai only for non-OpenAI providers.** This was the first adoption slice and remains useful history, but it leaves OpenAI and OpenAI-compatible providers on a separate backend even though pi-ai already has the relevant API families.

**Create an OpenKit cache service.** This is premature. Provider caches are upstream KV-cache mechanisms, not durable OpenKit prompt stores. OpenKit should first pass stable cache scopes and observe cache read/write evidence.

## Deferred Work

- Native multimodal Responses support can expand once the pi-ai adapter maps the relevant provider APIs without lossy bridge behavior.
