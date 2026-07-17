# Pi AI Unified LLM Backend

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the decision to make `@earendil-works/pi-ai` the single NanoCore LLM provider backend for every non-Codex-OAuth provider path, the removal target for the hand-written OpenAI-compatible provider client from Gateway dispatch, the native pi-ai OpenAI Responses routing contract, and the provider-agnostic prompt cache scope contract used by separately authorized provider-backed Internal Core Role calls, public Gateway callers, and worker agents.

## Does Not Own

This spec does not own the public Gateway HTTP surface itself, which remains owned by `docs/specs/20260526-llm_gateway_responses_api.md`; the first pi-ai adoption and vendor-boundary rules, which remain owned by `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`; Codex subscription login and account-slot semantics, which remain owned by `docs/specs/20260526-codex_chatgpt_subscription_login.md`; durable usage schema ownership, which remains owned by `docs/specs/20260703-audit_usage_evidence_records.md`; worker capability semantics, which remain owned by `docs/specs/20260703-worker_agent_capability.md`; or authorization for any Internal Core Role to call a provider, which must come from that role's owning specification.

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

NanoCore should converge on one LLM provider backend model: Codex OAuth traffic uses the dedicated Codex client because it is a subscription-backed ChatGPT/Codex account path, and every other LLM provider route uses pi-ai. The public OpenAI-compatible Gateway remains `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/health`; the internal implementation stops maintaining a second generic OpenAI-compatible HTTP adapter beside pi-ai.

This replaces the current split where some providers use NanoCore's hand-written OpenAI-compatible client and others use pi-ai. The split was useful for the first pi-ai adoption slice, but it is the wrong steady state because it duplicates request mapping, streaming conversion, error normalization, usage extraction, cache propagation, and provider capability logic.

The cache design keeps OpenKit's current thread/session-oriented approach, but makes it explicit and provider-agnostic. NanoCore derives a stable hashed cache scope from workspace, thread, agent session, provider, model, account slot, and optional caller-supplied cache metadata, passes it to pi-ai as `sessionId` plus `cacheRetention`, and lets pi-ai map that intent to OpenAI `prompt_cache_key`, Anthropic `cache_control`, OpenRouter `session_id` or sticky routing, or no provider cache hint when unsupported.

## Decision

NanoCore will remove the generic `openai-compatible` backend from provider dispatch and route all non-Codex-OAuth providers through pi-ai.

- `codex-oauth` remains a special backend because it resolves ChatGPT/Codex subscription credentials, account slots, and Codex-specific Responses behavior.
- `pi-ai` becomes the only general hosted, gateway, local, and custom LLM backend.
- OpenAI API providers use pi-ai's OpenAI API families, including native `openai-responses` where the selected model and endpoint support Responses.
- OpenAI-compatible custom endpoints use pi-ai `openai-completions` by default and may opt into pi-ai `openai-responses` only when NanoCore provider config declares Responses support explicitly.
- Provider configuration authors still write OpenKit provider profiles; they do not write pi-ai provider ids, pi-ai API family names, or pi-ai option shapes.
- The public Gateway keeps OpenAI-compatible request and response shapes. pi-ai remains an internal adapter dependency, not public vocabulary.

## Goals

- Delete the steady-state need for NanoCore to maintain a generic OpenAI-compatible HTTP provider client.
- Use pi-ai for OpenAI, OpenAI-compatible custom endpoints, Anthropic, Google, OpenRouter, xAI, and other future provider families.
- Keep Codex OAuth separate and explicit.
- Preserve `/v1/chat/completions` and `/v1/responses` as stable public Gateway entry points.
- Support native OpenAI Responses behavior through pi-ai instead of bridging every Responses request through Chat Completions.
- Keep prompt cache routing consistent across separately authorized provider-backed Internal Core Role calls, worker agents, and public Gateway callers.
- Preserve durable usage evidence for input, output, cache read, cache write, cost estimates, provider, model, workspace, thread, turn, item, capability call, agent, and agent session where available.
- Fail closed when pi-ai cannot represent an unsupported request field without semantic loss.

## Non-goals

- Do not change the public Gateway route names or basic OpenAI-compatible shapes.
- Do not merge Codex OAuth into pi-ai.
- Do not introduce a standalone cache service, local KV-cache, prompt snapshot store, or prewarming scheduler in this slice.
- Do not expose raw thread ids, workspace ids, account slot ids, provider credential ids, prompt text, tool arguments, or raw cache keys in provider-visible values, logs, diagnostics, or usage records.
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

The provider registry should no longer expose `openai-compatible` as a steady-state backend. Any provider that previously used `openai-compatible` becomes `pi-ai` unless it is removed or deliberately marked unsupported.

The retired `OpenAICompatibleChatClient` migration fixture is removed. Shared OpenAI-compatible wire types and normalized provider errors remain independent of transport selection.

## Request Routing Contract

### Chat Completions

`POST /v1/chat/completions` requests route to `PiAiGatewayClient` for every non-Codex-OAuth provider. The adapter maps system, developer, user, assistant, and tool messages into pi-ai `Context`, maps function tools to pi-ai tools, maps supported sampling and max-token fields into pi-ai options, and rejects unsupported fields that pi-ai cannot preserve.

### Responses

`POST /v1/responses` requests should prefer a native pi-ai Responses route when the resolved provider model speaks an OpenAI Responses-compatible API family. OpenAI API providers should use pi-ai `openai-responses` for native Responses behavior.

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

The capability matrix is still OpenKit configuration vocabulary. The pi-ai model registry may inform adapter selection and metadata, but it must not silently enable a provider, model, endpoint family, or credential path that OpenKit config did not enable.

## Prompt Cache Contract

### Design Principle

OpenKit uses stable cache scopes, not global cache keys. One global key would create hot spots, reduce provider-side cache locality under overflow, and risk cross-thread or cross-agent cache affinity where isolation is expected.

The default cache boundary remains thread/session-oriented because OpenKit work is organized around chat threads, task threads, goal threads, and worker sessions. This follows the Codex-like model without exposing raw thread ids upstream.

### Cache Scope Inputs

The prompt cache resolver keeps this priority order:

- explicit top-level `prompt_cache_key`
- `metadata.openkit.promptCacheKey`
- a hashed OpenKit scope
- request-scoped fallback

The hashed OpenKit scope includes the stable non-secret fields available for the call:

```text
providerId
model
codexOAuthAccountSlotId when relevant
workspaceId
threadId
agentSessionId
sessionId
```

The generated key keeps the existing shape:

```text
openkit:responses:<sha256-prefix>
```

The digest must never embed raw workspace, thread, session, account, provider credential, prompt, or user identifiers.

### Required Scope by Caller Type

When an owning role specification separately authorizes a provider-backed Internal Core Role call, that call must pass `workspaceId` and either `threadId`, `agentSessionId`, or `sessionId` on every LLM call. This cache contract constrains an authorized call; it never authorizes one.

Chat Mode should pass:

```ts
{
  workspaceId,
  threadId,
  sessionId: `chat-mode:${workspaceId}:${threadId}`
}
```

Task Mode worker calls should pass:

```ts
{
  workspaceId,
  threadId,
  agentSessionId
}
```

Goal Mode worker calls should pass:

```ts
{
  workspaceId,
  threadId,
  agentSessionId
}
```

Public Gateway callers may pass `prompt_cache_key` or `metadata.openkit.*`. If they do not, NanoCore falls back to a request-scoped key, which guarantees a provider-visible cache field but does not create cross-request cache affinity.

### Provider Mapping

NanoCore passes the resolved key to pi-ai as `sessionId` and passes retention as `cacheRetention`.

pi-ai-backed OpenAI Responses and Chat Completions paths map `sessionId` to OpenAI-compatible cache and request-affinity fields such as `prompt_cache_key` and request/session headers where supported.

pi-ai-backed Anthropic paths map `cacheRetention` into Anthropic `cache_control` breakpoints. OpenKit should structure prompts so stable tools, system prompts, role prompts, and workspace policy appear before dynamic turns and tool results.

pi-ai-backed OpenRouter paths use `sessionId` to support OpenRouter sticky routing where supported, including `session_id` or session headers. This is especially important for long-running worker and goal sessions whose opening messages may change while cache locality should remain stable.

Providers without a cache or routing-affinity mechanism still receive the same OpenKit request context through pi-ai where safe, but their cache fidelity is recorded as `none`.

### Cache Fidelity Evidence

Every LLM capability call should record a cache fidelity class:

```text
native-key
session-routing
explicit-breakpoint
none
```

`native-key` means the upstream provider received a native cache key equivalent, such as OpenAI `prompt_cache_key`.

`session-routing` means the upstream provider or gateway received a session affinity value, such as OpenRouter `session_id`, but the provider cache key is not directly controlled by OpenKit.

`explicit-breakpoint` means the upstream provider received explicit cache breakpoint control, such as Anthropic `cache_control`.

`none` means no supported cache hint was sent.

Usage records must preserve cache read and cache write quantities when pi-ai reports them. Capability usage read models should expose cache read/write metrics without exposing raw cache keys.

### Prompt Layout Rule

Cache hit probability depends on stable prefixes. NanoCore and worker prompts should preserve this order:

```text
1. OpenKit invariant system instructions
2. Agent role prompt
3. Tool schemas and tool instructions
4. Workspace policy and stable knowledge summary
5. Plan, goal, or thread stable context
6. Recent conversation turns
7. Current user or task input
8. Volatile tool results, logs, timestamps, and fresh observations
```

Volatile content must not be placed before stable instructions unless correctness requires it.

### Hot-Spot Control

OpenKit should not add cache sharding before evidence shows a hot spot. If usage evidence shows provider cache overflow, rate-limit pressure, or reduced hit rate for one cache scope, NanoCore may derive a bounded shard suffix from request id or agent session id while keeping the shard count small and deterministic.

## Migration Plan

1. Add tests proving runtime custom providers, OpenAI providers, and OpenAI-compatible static providers resolve to pi-ai except Codex OAuth.
2. Add native pi-ai Responses support for OpenAI models and mark `openai.responses` as `native` through pi-ai.
3. Move OpenAI, DeepSeek, Moonshot, Groq, DashScope, Zhipu, SiliconFlow, Ollama, vLLM, and custom providers to pi-ai routing.
4. Ensure every separately authorized provider-backed Internal Core Role call passes a complete prompt cache scope.
5. Remove production Gateway dispatch branches that call the hand-written OpenAI-compatible provider client.
6. Keep or delete the hand-written client tests according to whether the client remains as a test fixture; it must not remain a production backend.
7. Update `docs/specs/20260526-llm_gateway_responses_api.md` and `docs/specs/20260703-pi_ai_provider_gateway_adoption.md` after implementation so their current implementation projections no longer describe the old steady state.

No backward-compatible internal routing alias is required. This repository is pre-release and internal; update callers directly.

## Testing Strategy

- L1: provider config tests prove every non-Codex provider resolves to pi-ai and Codex OAuth resolves to the Codex client.
- L1: prompt cache resolver tests prove explicit key, metadata key, hashed thread/session/agent scope, and request fallback behavior.
- L1: pi-ai adapter tests prove OpenAI Responses-native mapping, OpenAI Chat Completions mapping, custom OpenAI-compatible provider synthesis, Anthropic cache-control mapping, OpenRouter session mapping where pi-ai exposes it, unsupported field rejection, and no ambient credential fallback.
- L2: contract tests prove public Gateway error envelopes, streaming chunks, tool-call deltas, usage normalization, and no pi-ai vocabulary leakage.
- L3: black-box Gateway tests prove `/v1/chat/completions` and `/v1/responses` work through pi-ai for OpenAI-compatible and non-OpenAI providers.
- L5: NanoCore smoke proves boot with pi-ai only for non-Codex provider dispatch.
- L6: quota-gated real-provider story proves one OpenAI-compatible custom endpoint and one non-custom provider produce successful calls, streaming completion, usage rows, cache evidence fields, and zero secret/cache-key leaks.

## Acceptance Criteria

- No production Gateway request path uses the hand-written OpenAI-compatible client for non-Codex providers.
- OpenAI `/v1/responses` traffic can route through pi-ai as native Responses when configured.
- Chat Completions and Responses public wire shapes remain compatible with existing accepted Gateway tests.
- Custom OpenAI-compatible endpoints route through pi-ai-synthesized providers.
- Separately authorized provider-backed Internal Core Role calls and worker agents provide stable cache scopes.
- Raw thread ids, workspace ids, account slot ids, prompt text, tool arguments, and secret values do not appear in provider-visible cache keys, logs, diagnostics, or usage records.
- Usage evidence records cache read and cache write quantities when provider data is available.
- Gateway diagnostics can show cache fidelity class and cache effectiveness without exposing raw cache keys.

## Alternatives Considered

**Keep the native OpenAI-compatible client permanently.** This keeps current OpenAI wire control, but it leaves two general provider backends and duplicates request mapping, streaming parsing, usage extraction, error normalization, and cache behavior. This is rejected as the steady state.

**Use pi-ai only for non-OpenAI providers.** This was the first adoption slice and remains useful history, but it leaves OpenAI and OpenAI-compatible providers on a separate backend even though pi-ai already has the relevant API families.

**Create an OpenKit cache service.** This is premature. Provider caches are upstream KV-cache mechanisms, not durable OpenKit prompt stores. OpenKit should first pass stable cache scopes and observe cache read/write evidence.

## Deferred Work

- Prompt-version and tool-schema-version inputs may be added to the cache scope if evidence shows accidental collisions across prompt revisions.
- Cache sharding may be added if provider overflow or sticky-routing hot spots are observed.
- Provider-specific cache dashboards may be added after durable usage records contain enough cache read/write evidence.
- Native multimodal Responses support can expand once the pi-ai adapter maps the relevant provider APIs without lossy bridge behavior.
