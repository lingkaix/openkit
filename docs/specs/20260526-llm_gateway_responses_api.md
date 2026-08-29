---
status: Accepted
implementation: Partial
---
# LLM Gateway Responses API

## Owns

This spec owns the NanoCore LLM Gateway HTTP surface for OpenAI-compatible Chat Completions and Responses requests, model discovery, public endpoint-capability vocabulary, provider-profile selection, optional public cache-scope input, and public Gateway error behavior. It also owns the public routing rule that a subscription-backed provider profile binds one explicit provider-subscription account slot.

## Does Not Own

This spec does not own provider transport, request, response, streaming, usage, cache, credential-input, or provider-error mapping, which belongs to `docs/specs/20260708-pi_ai_unified_llm_backend.md`; subscription account creation, login, refresh, logout, status, quota, or Vault persistence, which belongs to `docs/specs/20260721-provider_subscription_accounts.md`; durable capability and usage records; worker-side capability records; worker-runtime provenance; authenticated worker-inference identity binding; runtime cache-lineage specialization; policy evaluation; or `packages/protocol` schemas.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`

Related specs:


## Related Docs

- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`

## Summary

NanoCore exposes the fixed agent-facing Gateway surface at `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/responses`, plus `/health`. Route handling authenticates and authorizes the caller, resolves one configured provider profile and model, derives a bounded cache scope, and delegates the provider effect to the unified pi-ai dispatcher.

Codex and xAI subscription providers are not special Gateway backends. Their profiles use the same public routes and explicitly bind a server-owned account slot through provider-neutral OpenKit configuration. The unified backend resolves that slot before invoking pi-ai. The Gateway has no Codex app-server, `CODEX_HOME`, `auth.json`, or dedicated Codex client dependency in the clean target.

## Goals / Non-goals

### Goals

- Preserve one OpenAI-compatible Gateway surface for API-key, subscription-backed, gateway, local, and custom providers.
- Keep provider and model authority in authored OpenKit profiles rather than adapter discovery.
- Support native endpoint families and bounded bridges without hiding semantic loss.
- Require explicit account-slot binding for every subscription-backed provider profile.
- Preserve cache-scope input and provider-reported cache evidence without exposing raw ownership identifiers.
- Return stable redacted public errors before and after streaming begins.

### Non-goals

- Do not expose pi-ai, Codex app-server, or provider-private adapter vocabulary through public requests, responses, config, or diagnostics.
- Do not copy Gateway request or response schemas into `packages/protocol`; this is an external provider-capability surface, not the UI-to-Core workflow protocol.
- Do not attempt lossless bridging for Responses built-in tools, remote MCP, computer use, file input, image input, or another unrepresentable modality.
- Do not expose subscription credentials, raw provider account ids, Vault references, authorization headers, or raw account quota responses.
- Do not accept pasted subscription tokens through Gateway routes or provider profiles.
- Do not expose or implement `POST /v1/completions`.
- Do not reintroduce the superseded `/internal/v1/chat/completions` facade.
- Do not perform provider or account fallback.

## Public HTTP Contract

### `POST /v1/chat/completions`

The route accepts OpenAI-compatible Chat Completions requests with supported system, developer, user, assistant, and tool messages. Unknown fields may pass through only when the selected endpoint mapping can preserve them; an unsupported semantic requirement fails with a stable Gateway error instead of being silently dropped.

Streaming uses OpenAI-compatible SSE chunks and terminates with `[DONE]`. If a provider failure occurs after headers begin, the stream emits the stable OpenKit error termination owned by this contract and never copies the upstream message or response body.

### `POST /v1/responses`

The route accepts OpenAI-compatible Responses requests with `model`, `input`, optional `stream`, and supported passthrough fields. It returns native Responses payloads when the selected provider capability is `native`, or a converted Responses payload only when the provider is chat-native and the request is bridgeable under this spec.

`openai-codex` is Responses-native through the unified pi-ai backend. It must not use the current Chat Completions bridge or a dedicated OpenKit Codex transport after migration.

### `GET /v1/models`

The route returns only models explicitly listed by Gateway-allowlisted provider profiles while the Gateway is enabled. For every non-subscription profile, eligibility remains exactly the pre-cutover Gateway allowlist and readiness behavior: readiness omitted, `ready`, or `degraded` permits its authored models, while `blocked`, `disabled`, and `unknown` excludes them. This cutover adds no classification, slot-metadata, local Vault, secret-resolution, credential-resolvability, or other local-usability filter to a direct, API-key, gateway, local, custom, or other non-subscription profile. A subscription-backed profile is the only profile kind subject to the additional checks: it contributes models only when its classification is valid, its exact `(subscriptionProviderId, accountSlotId)` metadata record exists, the Vault is locally available, and that slot's credential is locally resolvable. These subscription-only checks are network-free and do not promise provider entitlement. Pi-ai and provider-native catalogs never add undeclared models to the response.

Server-mode authentication is required because model supply and sibling inference routes are deployment-owned capabilities. When Gateway policy disables inference, model supply is hidden as well.

### Excluded Routes

`POST /v1/completions` and the historical `/internal/v1/chat/completions` facade remain absent. The provider-subscription App API is separate from `/v1/*` and follows `docs/specs/20260721-provider_subscription_accounts.md`.

## Authentication, Authorization, And Attribution

In server mode every `/v1/*` request authenticates the actor before route parsing, model discovery, provider resolution, credential access, or provider effects. Gateway policy and current Workspace authority are evaluated before dispatch.

Public `metadata` and `metadata.openkit` are optional. A caller-supplied `metadata.openkit.workspaceId` is only requested scope until active membership and token-binding checks authorize that Workspace. Only authenticated actor context plus current server-owned Workspace, thread, turn, item, agent, and AgentSession records can establish durable authority. Caller-supplied lineage may be retained only as non-authoritative best-effort labels.

A request without Workspace scope may still dispatch and produce process-local diagnostics. A supplied but unauthorized Workspace fails before provider dispatch. Public metadata never selects a credential, account slot, provider endpoint, or unlisted model.

## Provider Profiles And Account Binding

Gateway provider resolution uses the runtime registry loaded from `DATA_ROOT/config/server.jsonc` and `DATA_ROOT/config/providers/*.provider.jsonc`. The selected profile's readiness and exact `models` list are dispatch authority; model or provider discovery inside pi-ai is never authority.

Provider profiles use OpenKit vocabulary only. A subscription-backed profile declares:

```json
{
  "id": "codex-work",
  "vendor": "openai-codex",
  "kind": "oauth",
  "extensions": {
    "openkit": {
      "subscriptionAccount": {
        "accountSlotId": "work"
      }
    }
  }
}
```

Provider-family resolution normalizes `vendor` and `id` independently by trimming, lowercasing, and replacing hyphens with underscores. The recognized family keys are exactly `openai_codex` and `xai`. A recognized normalized `vendor` is authoritative; otherwise a recognized normalized `id` selects the family. If both values are recognized and select different families, the profile is invalid. `openai_codex` maps to subscription provider `openai-codex`, and `xai` maps to `xai`; the account extension never selects or overrides the family.

A profile is subscription-backed only when its resolved family is recognized, `kind` is `oauth`, `extensions.openkit.subscriptionAccount` is the strict object `{ accountSlotId }`, and both `secretRef` and `baseUrl` are absent. A recognized-family OAuth profile without that extension is invalid, and the extension is forbidden on every non-OAuth or unrecognized-family profile. In particular, xAI `direct`, `gateway`, and `custom` profiles remain ordinary API-key or provider configurations and must not enter provider-subscription account selection merely because their vendor or id normalizes to `xai`.

A subscription-backed profile with an unknown slot, a provider-family mismatch, an unavailable Vault, or a non-resolvable credential fails closed before pi-ai. NanoCore does not guess a `default` account or any other default slot. Several profile instances may bind the same slot, while each profile binds at most one slot.

Authored profiles may contain routing fields such as provider instance id, vendor, kind, display name, base URL where permitted, models, default model, endpoint capabilities, and the non-secret account-slot reference. They must not contain access tokens, refresh tokens, cookies, provider account ids, `auth.json`, authorization headers, or pi-ai credential payloads.

The previous `extensions.openkit.codexOAuth.accountSlotId` field is removed in the same release as the generic field. No compatibility alias, default-slot inference, or automatic config rewrite is retained.

## Provider Endpoint Capabilities

Provider metadata includes:

```ts
{
  chatCompletions: "native" | "bridged" | "unsupported",
  responses: "native" | "bridged" | "unsupported"
}
```

The matrix is the routing source of truth. Diagnostic booleans such as `supportsStreaming`, `supportsToolCalls`, and `supportsReasoning` are display hints only.

`openai_codex` is Responses-native and Chat Completions-bridged. An xAI Grok profile uses the endpoint capability declared by its reviewed pi-ai model adapter; a chat-native xAI model may bridge Responses only for the bounded shapes below. Subscription authentication does not change a model's endpoint capability.

Provider transport and conversion stay outside Hono routes. A bridge that cannot preserve the public contract fails with `unsupported_gateway_feature` before the provider effect.

## Bridge Compatibility

The bounded bridge supports:

- text-only chat messages and Responses input items
- `system` and `developer` instructions
- simple function tools and tool results
- `temperature`
- `max_tokens`, `max_completion_tokens`, and `max_output_tokens`
- reasoning-effort mapping
- simple `tool_choice`
- text-only streaming delta conversion
- optional cache-scope input

The bridge rejects:

- Responses built-in tools
- remote MCP tools
- computer-use tools
- file and image input
- structured content that cannot be reduced to text without semantic loss
- non-function tool schemas

## Cache Scope

`prompt_cache_key` is an optional OpenAI-compatible public request field, not a provider-specific field. The route resolves cache-scope input with this priority:

1. explicit top-level `prompt_cache_key`
2. authorized `metadata.openkit.promptCacheKey`
3. an available server-owned scope derived from configured provider id, model, the `(subscriptionProviderId, accountSlotId)` pair when subscription-backed, authorized Workspace, server-resolved thread, AgentSession, or session
4. a request-scoped generated fallback

Every resolved scope is normalized and hashed by the S42-owned resolver before provider-facing use. Raw Workspace, thread, subscription-provider, account-slot, session, prompt, credential, or user identifiers are not exposed. Both `subscriptionProviderId` and `accountSlotId` participate in the hash so equal slot ids under different providers or accounts cannot share provider cache or Codex turn-state continuity accidentally.

The route supplies resolved cache input to the unified backend; it does not decide an upstream header or cache mechanism. Cache effectiveness exists only when the provider reports cache-read or cache-write usage. Absence of those values means unknown, not a miss.

## Error Contract

Gateway policy failures, missing defaults, disallowed or unavailable providers, invalid account bindings, authentication failures, rate limits, context overflow, unsupported features, provider failures, and cancellation use OpenAI-compatible error envelopes with stable OpenKit codes and fixed generic messages.

Upstream message text, provider-native codes and types, response bodies, pi-ai vocabulary, credential data, account identifiers, and stack traces never cross public JSON or SSE. Provider classification may inspect internal details only to select the stable public class.

Subscription-backed resolution uses these exact product-owned mappings before any pi-ai call or provider network work:

| Pre-dispatch condition | HTTP | Error type | Code | Fixed message |
| --- | ---: | --- | --- | --- |
| Unknown or missing account slot, provider-family mismatch, invalid subscription binding, or locked or unavailable Vault | 503 | `provider_error` | `gateway_provider_unavailable` | `Provider is unavailable.` |
| Missing, revoked, or otherwise unresolvable subscription credential | 401 | `provider_error` | `gateway_provider_authentication_failed` | `Provider authentication failed.` |

These conditions are resolved before a streaming response is accepted, so `stream: true` receives the same non-`2xx` JSON envelope and never a terminal SSE event. A provider failure after streaming has started retains the existing stable terminal SSE normalization and fixed public vocabulary.

## Diagnostics

Deployment-admin diagnostics may report:

- the Gateway endpoint inventory
- configured provider instances and endpoint capability chips
- dispatch readiness and stable redacted failure classes
- process-local request count and provider-reported input, output, total, cache-read, and cache-write quantities

Provider-registry diagnostics preserve the public provider-profile `kind`, endpoint capability, and readiness routing projections. They omit `dispatchFamily` and every private adapter or backend-implementation discriminator, so unified backend identity remains a private implementation detail.

The legacy `oauth.openaiCodexAccounts` diagnostics field is removed rather than renamed or generalized. Diagnostics do not project provider-subscription account state; the dedicated provider-subscription routes exclusively own provider inventory, account lifecycle, status, and quota reads. Diagnostics never include credentials, raw account ids, Vault references, authorization headers, raw cache input, Codex turn state, raw quota responses, or pi-ai details.

## Current Implementation Projection

NanoCore currently implements `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/health` with server authentication, Gateway policy, explicit profile/model authority, optional public metadata, durable attribution, prompt-cache resolution, stable errors, streaming, usage projection, and no retired internal facade.

Provider resolution now accepts only the provider-neutral `extensions.openkit.subscriptionAccount` binding for recognized subscription profiles, validates the exact slot and local credential before dispatch, and sends both Codex and xAI subscription requests through the unified pi-ai dispatcher. Codex Responses is native through stock pi-ai, xAI uses its reviewed model capability, subscription-provider and account-slot identity participate in the hashed cache scope, and stable pre-dispatch and post-start errors expose no provider-private data.

The prior Codex-specific config, route, diagnostics, dispatch vocabulary, and residual dedicated source files have been physically removed. This spec remains `Partial` until the owner-governed Codex real-use runs complete the accepted Gateway evidence; quota and Web account presentation remain outside this spec.

## Accepted Design

The Hono route layer remains thin: authenticate, authorize, validate, select a profile and model, derive cache scope, start durable attribution when applicable, call one unified provider dispatcher, and normalize the public response. Subscription account selection is a provider-resolution input, not a backend branch. All provider-native behavior remains behind the S42 pi-ai adapter boundary.

## Rollout / Migration Plan

Remaining rollout is owned by this specification together with `docs/specs/20260721-provider_subscription_accounts.md` and `docs/specs/20260708-pi_ai_unified_llm_backend.md`. After the storage and Vault foundation exists without activating the new authored extension or routes, one atomic same-release kernel cutover replaces profile classification, App API schemas and handlers, the operation catalog, generated OpenAPI, Core Client, Codex and xAI authentication, and all subscription inference routing together. The cutover deletes Codex-specific routes, config, diagnostics, client vocabulary, and active Gateway/account dependencies without compatibility aliases, stubs, dual readers, dual clients, dual credential paths, or an intermediate account-to-inference bridge. Quota behavior follows the typed bounded results and strict provider-specific readers in the provider-subscription specification without changing the public route.

The removed Gateway and account dependencies do not remove or rename `/api/app/vault/bootstrap/codex-auth-json` and do not alter worker-runtime Codex app-server ownership; those boundaries remain with their existing specifications.

## Testing Strategy / Acceptance Criteria

- L1 route and provider-resolution tests prove authentication order, explicit model authority, provider-neutral slot binding, no default-slot guess, subscription-only network-free slot, Vault, and credential model eligibility, exact preservation of pre-cutover eligibility for every non-subscription profile, exact subscription pre-dispatch errors, stable cache priority, and absence of a Codex backend branch.
- L1 bridge tests prove the accepted mappings and fail every unrepresentable shape before provider effects.
- L2 contract tests prove public Chat Completions, Responses, models, SSE, error, usage, and redaction behavior across API-key and subscription-backed profiles, including non-`2xx` JSON rather than SSE for every pre-start subscription failure.
- L3 black-box tests prove OpenAI-compatible, Codex subscription, and xAI subscription profiles share the same `/v1/*` routes and unified dispatcher; overlapping account slots remain isolated.
- L3 opt-in real-provider evidence proves one authenticated public Codex Gateway request per run, accepted streaming behavior, stable public envelopes, and redaction.
- L5 smoke proves NanoCore serves the Gateway without Codex app-server, `CODEX_HOME`, `auth.json`, or ambient credentials.

Acceptance requires the fixed route surface, exact configured model authority, stable public envelopes, explicit generic account binding, native Codex Responses through pi-ai, xAI subscription inference through pi-ai, hashed account-aware cache scope, provider-reported cache evidence, no credential or upstream-detail leakage, and no Codex-specific backend or app-server dependency.

## Risks & Mitigations

- A generic account field could hide provider mismatch; provider-family derivation and slot-pair validation fail closed.
- Native and bridged endpoint behavior could diverge; explicit capability values and focused contract tests preserve observable semantics.
- Cache hints could be mistaken for authority; authorization precedes scope derivation and the resolver hashes only accepted inputs.
- Provider failures could leak subscription details; fixed schemas and redaction tests keep public errors generic.
- Removing the old config field breaks current internal profiles; same-release fixture updates and explicit re-login follow the repository's clean-target rule.

## Links

- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
