---
status: Accepted
implementation: Partial
---
# Pi AI Unified LLM Backend

## Owns

This spec is the sole owner of NanoCore LLM provider transport and routing through `@earendil-works/pi-ai`, including request, response, streaming, provider-error, usage, provider-capability, credential-input, native Responses, Codex turn-state, and cache-scope mapping. It also owns removal of the dedicated Codex Responses client and every other parallel general-purpose provider transport from production dispatch.

## Does Not Own

This spec does not own the public Gateway HTTP contract, which remains with `docs/specs/20260526-llm_gateway_responses_api.md`; subscription account slots, login, refresh persistence, logout, or quota projection, which remain with `docs/specs/20260721-provider_subscription_accounts.md`; pi-ai pinning, public-vocabulary isolation, or catalog reconciliation, which remain with `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`; durable capability and usage records; worker capability semantics; or authorization for a caller to use a provider.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/metering.md`
- `docs/core/vault.md`
- `docs/core/work-model.md`

Related specs:


## Related Docs

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`

## Summary

NanoCore uses one LLM provider backend: every hosted, subscription-backed, gateway, local, and custom provider route dispatches through stock pi-ai. Codex and xAI subscription profiles first resolve an explicit OpenKit account slot and then select the slot-scoped pi-ai `Models` instance defined by the subscription-account spec; they do not select a separate backend. The `codex-oauth` backend discriminator, dedicated Codex Responses client, app-server refresh path, and hand-written generic OpenAI-compatible transport are absent from the clean target.

Pi-ai native Responses is required where its selected model API supports Responses. In particular, Codex subscription inference uses pi-ai's native Codex Responses adapter rather than the current OpenKit Codex client or a Chat Completions bridge. OpenKit accepts stock pi-ai's internal `originator` value and provider request defaults instead of maintaining a fork to preserve private wire details.

OpenKit keeps its cache optimization above the adapter. NanoCore derives one non-secret cache scope from trusted request context, configured provider, model, and optional subscription slot, hashes it before provider-facing use, passes it to pi-ai as supported session and retention input, and records only provider-reported cache-read and cache-write usage as effectiveness evidence.

## Decision

- `PiAiGatewayClient` is the only production LLM transport owner.
- The internal `codex-oauth` backend kind is removed rather than retained as an alias; a subscription-backed profile is still a normal pi-ai provider profile with an explicit account-slot binding.
- OpenAI, Codex, Anthropic, Google, OpenRouter, xAI, custom OpenAI-compatible endpoints, and future accepted providers use the corresponding pi-ai adapter family.
- OpenAI-compatible custom endpoints default to pi-ai `openai-completions` and may use `openai-responses` only when OpenKit configuration declares native Responses support.
- Native pi-ai Responses is mandatory for a provider family whose accepted contract is Responses-native. A lossy Chat Completions bridge is not an acceptable Codex implementation.
- Provider discovery never grants authority. The OpenKit profile, readiness state, model allowlist, caller authorization, and explicit credential path must all allow the call before pi-ai is invoked.
- Pi-ai receives no ambient credential. API-key providers use explicitly resolved Vault material, and subscription providers use the exact slot-scoped `Models` instance selected before dispatch.
- No automatic provider fallback, account fallback, or cross-provider handoff occurs.

## Goals / Non-goals

### Goals

- Maintain one provider mapping, streaming, usage, error, and cancellation implementation.
- Remove NanoCore's dedicated Codex inference transport and its runtime dependency on Codex app-server.
- Add Grok subscription inference without creating a dedicated xAI backend.
- Preserve the public Chat Completions and Responses entry points while using native provider adapters where required.
- Preserve Codex turn-state continuity and the existing provider-cache optimization through stock pi-ai extension points.
- Keep credentials explicit, slot-isolated, and Vault-backed.
- Fail typed when pi-ai cannot represent a requested public Gateway shape without semantic loss.

### Non-goals

- Do not change the public Gateway route names or basic OpenAI-compatible shapes.
- Do not add a plugin framework around pi-ai or maintain a private pi-ai distribution.
- Do not introduce a standalone cache service, local KV-cache, prompt snapshot store, or prewarming scheduler.
- Do not guarantee cache hits, provider retention, pricing, or routing behavior.
- Do not expose raw ownership ids, credential ids, prompt text, tool arguments, raw cache input, pi-ai vocabulary, or upstream response bodies through public logs or errors.
- Do not implement automatic fallback or quota-aware account switching.

## Target Backend Model

The clean target is:

```text
OpenKit provider profile + explicit model + authorized caller
  -> optional subscription account-slot resolution
  -> PiAiGatewayClient
  -> slot-scoped pi-ai Models instance or explicit API-key options
  -> stock pi-ai provider adapter
```

There is no production backend branch before `PiAiGatewayClient`. If a provider is deliberately unsupported, readiness or capability validation fails before credential resolution. Omitted readiness, `ready`, and `degraded` are runnable; `blocked`, `disabled`, and `unknown` fail closed. The requested model must exactly match one model explicitly listed by the selected OpenKit profile.

The internal resolved-provider shape does not need a backend discriminator once migration completes. Provider family, endpoint capability, base URL, configured models, optional explicit credential reference, and optional subscription account binding are sufficient to resolve one pi-ai model and invocation path.

## Request Routing Contract

### Chat Completions

`POST /v1/chat/completions` maps supported system, developer, user, assistant, and tool messages into pi-ai `Context`, maps function tools and supported generation options, and maps output back to the public OpenAI-compatible envelope. When the selected provider is Responses-native, the dispatcher may bridge a Chat Completions request through native Responses only for the bounded text and function-tool shapes named by the public Gateway spec.

### Responses

`POST /v1/responses` uses the selected pi-ai native Responses API whenever the model adapter declares Responses support. `openai-codex` subscription profiles use pi-ai's native Codex Responses adapter. OpenAI or compatible profiles use native `openai-responses` only when their resolved capability says `native`.

A chat-native provider may serve a Responses request through pi-ai Chat Completions only when the request is text-only and conversion preserves instructions, function tools, tool results, sampling, reasoning effort, streaming order, and terminal usage semantics. Built-in Responses tools, remote MCP tools, computer use, file input, image input, or another unrepresentable shape fails with `unsupported_gateway_feature` before the provider effect.

### Custom OpenAI-Compatible Endpoints

When no stock pi-ai catalog provider represents a configured custom endpoint, NanoCore synthesizes one bounded pi-ai provider definition from the OpenKit profile. The default API family is `openai-completions`; `openai-responses` requires an explicit OpenKit capability declaration. NanoCore must not guess capability from URL shape or model name.

### Provider Capability Matrix

Endpoint capability remains OpenKit-owned configuration vocabulary:

```ts
{
  chatCompletions: "native" | "bridged" | "unsupported",
  responses: "native" | "bridged" | "unsupported"
}
```

Pi-ai catalog data may select an internal adapter only after the profile and model are authorized. It must not silently enable a provider, model, endpoint family, base URL, or credential path. The same dispatchability predicate filters `/v1/models`.

### Keyless Local Endpoints

Hosted profiles that require a credential fail before pi-ai when no explicit credential resolves. NanoCore never lets pi-ai read ambient provider credentials.

When a configured local or private endpoint explicitly requires no API key, the adapter may supply the fixed non-secret placeholder `openkit-keyless` only when the stock pi-ai adapter rejects a missing option before contacting that endpoint. The placeholder carries no authority, may be sent only to that configured endpoint, is never persisted, and does not authorize provider-specific headers or a second transport.

## Subscription Provider Mapping

Subscription-backed profiles follow `docs/specs/20260721-provider_subscription_accounts.md`. Dispatch resolves `(subscriptionProviderId, accountSlotId)` before model lookup and uses only that pair's pi-ai `Models` instance. The credential store rejects any provider or slot mismatch. Concurrent requests for different accounts therefore share adapter code but not credential state or refresh locks.

Only a profile selected by the provider-subscription specification's deterministic recognized-family algorithm, with `kind: oauth`, a strict `extensions.openkit.subscriptionAccount` binding, and no `secretRef` or `baseUrl`, enters this slot path. A recognized normalized vendor wins over id, a recognized id is used when vendor is unrecognized, and conflicting recognized families are invalid. Ordinary xAI `direct`, `gateway`, and `custom` profiles stay on their explicit API-key or provider path and never acquire subscription credentials implicitly.

Pi-ai performs login-time and inference-time refresh through the slot-scoped store. The Gateway does not start Codex app-server, read `CODEX_HOME`, inspect `auth.json`, or maintain a second refresh implementation. Authentication failure for one slot fails that request and marks only that slot unavailable; it never falls through to another account.

Stock pi-ai request identity is accepted for provider-private headers such as `originator`. OpenKit must not fork or patch pi-ai to send `originator: openkit`; the currently accepted stock value is `pi`. This field is not public OpenKit vocabulary or an authority boundary.

## Codex Turn-State Continuity

Codex may return opaque `x-codex-turn-state` response metadata that must be supplied on the next request in the same provider conversation. NanoCore stores that opaque value only in the bounded process/session continuity owner already used by the Gateway; it never parses it, logs it, returns it publicly, or treats it as credential or durable work provenance.

Codex Responses Lite message-anchored tools remain client-executed declarations, not provider effect authority. NanoCore accepts only top-level local `custom` and `function` tools, function-only `namespace` children, and the exact top-level `tool_search` declaration; it rejects duplicate callable keys, provider-executed tools, and malformed declarations before credential or provider access, then forwards the accepted prefix through stock pi-ai. Pi-ai owns provider parsing and preserves semantic tool-call blocks; NanoCore only reconstructs and replays the public Responses item id, call id, namespace, function arguments, custom input, and matching tool output. Unknown native request fields fail with `unsupported_gateway_feature` rather than being silently dropped.

The pi-ai call supplies an existing state through the generic request-header option and captures the next state through pi-ai's generic response callback. A new value is accepted only from a successful `2xx` response for the same provider, model, account slot, and authorized cache/session scope. Errors, redirects, and another slot's response cannot replace it.

The initial Codex implementation forces pi-ai's SSE transport because the reviewed WebSocket adapter does not expose handshake response headers through the required callback. WebSocket may be enabled only after the pinned pi-ai version provides equivalent response-metadata capture and focused tests prove turn-state parity. This is a bounded transport selection, not a second Codex client.

## Prompt Cache Contract

### Cache Scope Input

NanoCore's `PromptCacheKeyResolver` remains the unique owner of normalized cache scope. It may use the following non-secret inputs when their authority is proven:

```text
providerId
model
subscriptionProviderId when subscription-backed
accountSlotId when subscription-backed
authorized workspaceId
server-resolved threadId
agentSessionId
sessionId
explicit prompt_cache_key or authorized public hint
```

The resolver hashes normalized scope before any provider-facing use. Raw workspace, thread, subscription-provider, account-slot, session, credential, prompt, or user identifiers must not cross the provider or public diagnostics boundary. The full `(subscriptionProviderId, accountSlotId)` pair participates in the scope so equal slot ids under different providers or accounts cannot share a cache or Codex turn-state lineage accidentally.

For Internal Core Role and worker calls, trusted attribution comes only from server-owned identity, authorization, Workspace, thread, turn, agent, and AgentSession records. Public Gateway metadata is advisory: an explicit Workspace id must be authorized before use, other fields remain caller-asserted labels, and a call without Workspace scope remains dispatchable with process-local diagnostics.

### Pi Mapping

`PiAiGatewayClient` passes the derived value through pi-ai's supported `sessionId` and `cacheRetention` inputs when present. Provider-family adapters may translate those generic inputs differently or ignore them. This contract proves only that OpenKit supplied stable bounded input; it does not promise a particular upstream header, breakpoint, cache key, or retained entry.

Codex turn state and prompt cache scope are related continuity inputs but remain distinct values. The opaque turn state is never hashed into diagnostics, and a cache-scope match is required before a stored turn state can be reused.

### Effectiveness Evidence

Only provider-reported cache-read and cache-write quantities prove cache effectiveness. Their absence means unknown, not miss. Durable usage evidence preserves those quantities when available and never infers a hit from latency, repeated input, session identity, or turn-state reuse.

## Usage, Errors, And Cancellation

Pi-ai usage is normalized into input, output, total, cache-read, cache-write, and cost-estimate records when the provider supplies them. Missing values remain absent; NanoCore does not invent usage.

Every provider failure crossing JSON or post-start SSE uses a stable OpenKit code and fixed generic message. Pi-ai messages, provider-native codes, raw response bodies, auth payloads, and stack traces remain internal even when used to classify authentication, rate limit, context overflow, invalid request, provider unavailable, cancellation, or generic failure.

Cancellation propagates through the pi-ai request signal. If cancellation or transport loss occurs after an external provider effect may have started, the result may be interrupted or unknown under the Core/external-effect boundary; NanoCore does not retry automatically or dispatch to a different provider.

## Current Implementation Projection

Every dispatchable provider now routes through `LLMGatewayProviderDispatcher` and `PiAiGatewayClient`. Subscription-backed profiles resolve their explicit provider-slot pair to the manager-owned stock pi-ai `Models` runtime before invocation; there is no active provider-specific dispatcher branch or account fallback. Custom-provider synthesis, Chat Completions, bounded endpoint bridging, streaming conversion, provider-error normalization, cancellation, and usage mapping remain unified in this path.

Codex subscription inference uses stock pi-ai's native Responses adapter with SSE response-header capture for `x-codex-turn-state`; xAI subscription inference uses the same pi-ai client through its pair-scoped runtime. The exact `0.84.2` pin preserves Codex Responses namespaces and custom tool calls through pi-ai's semantic tool-call events without a second transport. `PromptCacheKeyResolver` remains the single cache-scope owner, the dispatcher hashes the provider/model/provider-slot scope, and the pi-ai boundary maps accepted cache input to `sessionId` and `cacheRetention` while durable effectiveness evidence uses only provider-reported usage. OpenKit accepts stock pi-ai request identity and maintains no private provider patch.

The former dedicated Codex Responses client, app-server account flow, Codex-home credential path, and `codex-oauth` artifacts have been physically removed. This spec remains `Partial` until the owner-governed Codex real-use runs complete the accepted transport evidence.

## Accepted Design

The accepted implementation keeps one cohesive `PiAiGatewayClient` and small mapping modules grouped by real API-family differences. Subscription account selection happens before this client; provider-specific authentication state does not create provider-specific inference clients. Codex turn state uses pi-ai's generic header and response callback with SSE transport. Cache scope remains an OpenKit-owned normalized input passed through generic pi-ai options. No wrapper hierarchy, provider plugin system, dedicated Codex transport, or private pi-ai patch is needed.

## Rollout / Remaining Implementation

Remaining rollout is owned by this specification together with `docs/specs/20260721-provider_subscription_accounts.md`. After the provider-subscription storage and Vault foundation lands without activating the authored extension or public routes, one atomic kernel cutover implements profile classification, provider-neutral schemas and live handlers, Core Client and generated contract projections, pi-ai authentication, native Responses, subscription-slot selection, Codex turn-state continuity through generic hooks, stock pi-ai originator behavior, cache and usage parity, and removal of the active `codex-oauth` branch and dedicated client. Authentication and inference cannot cut over in separate live packages because the resulting intermediate state would require a forbidden bridge, dual client, dual credential path, alias, or stub.

No internal compatibility alias remains for `codex-oauth`, and no app-server fallback remains after cutover.

This removal is limited to the Gateway and provider-subscription account paths. It does not remove or rename `/api/app/vault/bootstrap/codex-auth-json` and does not alter worker-runtime Codex app-server ownership.

## Testing Strategy / Acceptance Criteria

- L1 provider-resolution tests prove every dispatchable provider reaches `PiAiGatewayClient`, no backend discriminator or Codex branch remains, and subscription profiles require an explicit valid slot.
- L1 adapter tests prove native Codex Responses mapping, bounded bridges, custom-provider synthesis, keyless-local behavior, no ambient credentials, generic originator acceptance, SSE turn-state round trips, cross-slot turn-state isolation, cancellation, and stable error normalization.
- L1 cache tests prove the generic subscription slot participates in hashed scope, public metadata cannot override server-owned authority, raw ids never leave the resolver, and effectiveness uses only provider-reported usage.
- L2 contract tests prove public Chat Completions and Responses envelopes, streaming chunks, tool-call deltas, usage normalization, and no pi-ai or provider-private vocabulary leakage.
- L3 black-box tests prove OpenAI-compatible, Codex subscription, and xAI subscription profiles all use the unified client; two overlapping subscription slots cannot cross credentials, cache scope, or turn state.
- L3 opt-in real-provider evidence proves native Codex Responses, streaming where supported, refresh when safely exercisable, accepted cache input, and provider-reported cache usage when available without requiring a cache hit.
- L5 NanoCore smoke proves boot and Gateway service with no Codex app-server process, `CODEX_HOME`, `auth.json`, dedicated Codex client, or ambient credential dependency.

Acceptance requires: all production LLM dispatch uses stock pi-ai; native Codex Responses preserves the accepted public semantics; Codex turn state survives sequential requests without crossing account or scope boundaries; the old `codex-oauth` backend and dedicated client are absent; app-server is not started or queried by the Gateway/account path; OpenKit's cache resolver remains authoritative; and no credential, raw scope, pi-ai vocabulary, or upstream error leaks publicly.

## Alternatives Considered

**Keep the dedicated Codex client.** Rejected because it preserves duplicate request, streaming, usage, error, refresh, and cache behavior for one provider family.

**Add a dedicated xAI subscription client beside Codex.** Rejected because it repeats the same maintenance problem and bypasses pi-ai's provider ownership.

**Use pi-ai only for non-OpenAI providers.** Rejected because it leaves two general transport stacks despite pi-ai supporting the required OpenAI and subscription API families.

**Create an OpenKit cache service.** Rejected because current providers own their caches; OpenKit needs stable scope input and provider-reported evidence, not another durable cache platform.

**Patch pi-ai for an OpenKit originator or Codex-specific transport.** Rejected because neither private wire value justifies a fork, and generic pi-ai hooks cover the required continuity behavior.

## Deferred / Future Work

- WebSocket Codex transport after pi-ai exposes response-header metadata with tested parity.
- Native multimodal Responses expansion after pi-ai can preserve the relevant public shapes without lossy conversion.
- Credential-backed xAI real-use activation remains governed by `docs/specs/20260721-provider_subscription_accounts.md`.
- New provider families only after their adapter, entitlement, credential, and capability boundaries are accepted.

## Links

- `docs/specs/20260526-llm_gateway_responses_api.md`
- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`

- pi-ai upstream: `https://github.com/earendil-works/pi/tree/main/packages/ai`
