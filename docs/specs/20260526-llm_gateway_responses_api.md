---
status: Accepted
implementation: Partial
---
# LLM Gateway Responses API

## Owns

This spec owns the NanoCore LLM Gateway HTTP surface for OpenAI-compatible Chat Completions and Responses requests, the `gateway.jsonc` logical-model catalog, model discovery, derived logical-model capabilities and model family, ordered private route selection, bounded pre-output fallback, optional public cache-scope input, and public Gateway error behavior. It also owns the routing rule that one route member references one Provider profile and that a subscription-backed Provider profile binds one explicit provider-subscription account slot.

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

NanoCore exposes the fixed agent-facing Gateway surface at `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/responses`, plus `/health`. Route handling authenticates and authorizes the caller, resolves one logical model, selects one eligible private route member, derives a bounded cache scope, and delegates the Provider effect to the unified pi-ai dispatcher. The caller sees only the logical model ID and declared contract; Provider profile, provider-native model, account slot, and fallback lineage remain private except in authorized redacted audit and usage evidence.

Codex and xAI subscription providers are not special Gateway backends. Their profiles use the same public routes and explicitly bind a server-owned account slot through provider-neutral OpenKit configuration. The unified backend resolves that slot before invoking pi-ai. The Gateway has no Codex app-server, `CODEX_HOME`, `auth.json`, or dedicated Codex client dependency in the clean target.

## Goals / Non-goals

### Goals

- Preserve one OpenAI-compatible Gateway surface for API-key, subscription-backed, gateway, local, and custom providers.
- Keep provider and model authority in authored OpenKit profiles rather than adapter discovery.
- Present stable logical model IDs whose concrete Provider profile, provider-native model, and account may vary without changing the caller-visible contract.
- Support deterministic ordered route members and bounded pre-output failover for the concrete quota and availability cases accepted below.
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
- Do not implement weighted or randomized balancing, active health scoring, generic strategy plugins, fallback after response output begins, or a guarantee that any fallback succeeds.

## Public HTTP Contract

### `POST /v1/chat/completions`

The route accepts OpenAI-compatible Chat Completions requests with supported system, developer, user, assistant, and tool messages. Unknown fields may pass through only when the selected endpoint mapping can preserve them; an unsupported semantic requirement fails with a stable Gateway error instead of being silently dropped.

Streaming uses OpenAI-compatible SSE chunks and terminates with `[DONE]`. If a provider failure occurs after headers begin, the stream emits the stable OpenKit error termination owned by this contract and never copies the upstream message or response body.

### `POST /v1/responses`

The route accepts OpenAI-compatible Responses requests with `model`, `input`, optional `stream`, and supported passthrough fields. It returns native Responses payloads when the selected provider capability is `native`, or a converted Responses payload only when the provider is chat-native and the request is bridgeable under this spec.

`openai-codex` is Responses-native through the unified pi-ai backend. It must not use the current Chat Completions bridge or a dedicated OpenKit Codex transport after migration.

### `GET /v1/models`

The route returns only configured logical models from `gateway.jsonc` that have at least one currently eligible route member. Each result uses the logical model ID as `id`, exposes only its product-safe name and derived capabilities, and uses the stable product owner `openkit`; it never publishes a Provider profile ID, provider-native model, account slot, route-member ID, model-family classification, or Provider catalog ownership value.

A route member is eligible only when its referenced Provider profile is dispatchable, the provider-native model appears in that profile's explicit model list, its endpoint capability can preserve the requested Gateway surface, and any subscription binding passes the network-free slot, Vault, and credential checks below. Pi-ai and Provider-native catalogs never add an undeclared logical model or route member. Model discovery and inference dispatch call the same logical-model resolver, so a model advertised under the current snapshot is accepted for dispatch unless eligibility changes before the later request, in which case dispatch returns the stable current failure rather than choosing a different logical model.

Server-mode authentication is required because model supply and sibling inference routes are deployment-owned capabilities. When Gateway policy disables inference, model supply is hidden as well.

### Excluded Routes

`POST /v1/completions` and the historical `/internal/v1/chat/completions` facade remain absent. The provider-subscription App API is separate from `/v1/*` and follows `docs/specs/20260721-provider_subscription_accounts.md`.

## Authentication, Authorization, And Attribution

In server mode every `/v1/*` request authenticates the actor before route parsing, model discovery, provider resolution, credential access, or provider effects. Gateway policy and current Workspace authority are evaluated before dispatch.

Public `metadata` and `metadata.openkit` are optional. A caller-supplied `metadata.openkit.workspaceId` is only requested scope until active membership and token-binding checks authorize that Workspace. Only authenticated actor context plus current server-owned Workspace, thread, turn, item, agent, and AgentSession records can establish durable authority. Caller-supplied lineage may be retained only as non-authoritative best-effort labels.

A request without Workspace scope may still dispatch and produce process-local diagnostics. A supplied but unauthorized Workspace fails before provider dispatch. Public metadata never selects a credential, account slot, provider endpoint, or unlisted model.

## Logical Model Catalog And Ordered Routing

`DATA_ROOT/config/gateway.jsonc` is the sole authored Gateway configuration file. It is a strict versioned record with Gateway enablement, optional `defaultLogicalModelId`, and a non-empty identified logical-model catalog when enabled. The removed `server.jsonc.gateway`, `gatewayProviderId`, and `gatewayModel` fields are invalid and have no compatibility reader.

Each logical model contains:

```ts
interface LogicalModelConfig {
  id: string;
  displayName: string;
  routes: Array<{
    id: string;
    providerProfileId: string;
    providerModel: string;
  }>;
}
```

IDs are stable and unique within their owning collection. Capability and family values are not free-form Gateway configuration. When the snapshot loads, NanoCore joins each route member to the pinned `@openkit/models-dev-catalog` snapshot and the Provider endpoint-capability matrix, derives one closed capability set and `modelFamilyId` per member, requires every member of a logical model to have the same derived `modelFamilyId`, and publishes the intersection of their capabilities as the logical model's effective capability set. A missing catalog match, mismatched family, or unrepresentable endpoint rejects the snapshot rather than accepting an authored assertion or silently weakening a later call.

The `@openkit/models-dev-catalog` snapshot version is pinned by that package and changes only with an explicit repository dependency snapshot update, not through runtime-config reload. Startup and test validation recompute every derived logical-model contract against that pinned version. A refreshed catalog that changes a logical model's effective capabilities or `modelFamilyId` changes the composed setup and enters only a later immutable AEP or internal-role run; it never mutates an admitted Turn or silently crosses the previously accepted logical contract.

The request `model` is always a logical model ID. An explicit admitted request value wins; otherwise the applicable User, Workspace, Agent or internal-role preference resolves before `gateway.jsonc.defaultLogicalModelId` supplies the final Gateway fallback. Absence or ineligibility of the resolved logical model returns a typed error and never falls back to a different logical model.

For each Provider call, Gateway considers route members in authored order. It begins with the first eligible member and may advance only when no response bytes or stream events were delivered and the attempt ended as one of: Provider unavailable, Provider authentication unavailable, subscription quota exhausted, rate limited, or Provider start failed. Invalid input, unsupported request shape, policy denial, caller cancellation, context overflow, output validation failure, or any post-output failure does not advance. The same member is attempted at most once per Provider call.

A new internal-role model turn or worker inference request may begin with a different eligible member. The logical model ID, derived effective capabilities, and derived `modelFamilyId` remain pinned for the owning internal-role run or worker Turn, so concrete route replacement is not a caller-visible model substitution. One subscription-backed Provider profile binds at most one account slot; account rotation therefore uses distinct ordered route members that reference distinct Provider profiles.

Every attempt records one private route lineage entry containing the logical model ID, route-member ID, Provider profile and native model, account slot where safe, selection reason, attempt order, stable failure class, usage when known, whether any output began, and terminal result. Public errors and model discovery redact those identities. If every eligible member is exhausted, Gateway returns the stable logical-model failure corresponding to the terminal classification and does not claim transparent success.

Current schema evolution uses the shared `schemaVersion`, `requiredFeatures`, and namespaced descriptive `extensions` mechanisms. Weighted routes, randomized selection, active health state, generalized strategies, and algorithm plugins have no current fields or behavior.

## Provider Profiles And Account Binding

Gateway Provider resolution uses logical route members from `DATA_ROOT/config/gateway.jsonc` and Provider profiles from `DATA_ROOT/config/providers/*.provider.jsonc`. The selected member, profile readiness, endpoint capability, and exact Provider-native `models` list are dispatch authority; model or Provider discovery inside pi-ai is never authority.

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
3. an available server-owned scope derived from logical model ID, selected private route member, Provider profile and native model, the `(subscriptionProviderId, accountSlotId)` pair when subscription-backed, authorized Workspace, server-resolved thread, AgentSession, or session
4. a request-scoped generated fallback

Every resolved scope is normalized and hashed by the S42-owned resolver before provider-facing use. Raw Workspace, thread, subscription-provider, account-slot, session, prompt, credential, or user identifiers are not exposed. Both `subscriptionProviderId` and `accountSlotId` participate in the hash so equal slot ids under different providers or accounts cannot share provider cache or Codex turn-state continuity accidentally.

The route supplies resolved cache input to the unified backend; it does not decide an upstream header or cache mechanism. Cache effectiveness exists only when the provider reports cache-read or cache-write usage. Absence of those values means unknown, not a miss.

## Error Contract

Gateway policy failures, missing logical defaults, unknown or unavailable logical models, exhausted route members, invalid account bindings, authentication failures, rate limits, quota exhaustion, context overflow, unsupported features, Provider failures, and cancellation use OpenAI-compatible error envelopes with stable OpenKit codes and fixed generic messages.

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

NanoCore implements `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/health` with server authentication, Gateway policy, `gateway.jsonc` logical-model loading, private Provider route resolution, ordered pre-output fallback, durable route attribution, prompt-cache resolution, stable errors, streaming, usage projection, and no retired internal facade. Public discovery and requests expose logical model IDs rather than Provider profiles or Provider-native model authority.

Provider resolution now accepts only the provider-neutral `extensions.openkit.subscriptionAccount` binding for recognized subscription profiles, validates the exact slot and local credential before dispatch, and sends both Codex and xAI subscription requests through the unified pi-ai dispatcher. Codex Responses is native through stock pi-ai, xAI uses its reviewed model capability, subscription-provider and account-slot identity participate in the hashed cache scope, and stable pre-dispatch and post-start errors expose no provider-private data.

Logical discovery and dispatch share one resolver, private Provider identities remain hidden, and ordered fallback is attributed per attempt. This specification remains `Partial` only for acceptance evidence or Provider capability cases still named by its owning test strategy, not for the retired concrete-model dispatch shape.

## Accepted Design

The Hono route layer remains thin: authenticate, authorize, validate, resolve one logical model, ask the Gateway resolver for one ordered private member at a time, derive cache scope, start durable attribution when applicable, call one unified Provider dispatcher, and normalize the public response. Subscription account selection is a Provider-resolution input, not a backend branch. All Provider-native behavior remains behind the S42 pi-ai adapter boundary.

## Rollout / Migration Plan

The clean cutover owned by this specification together with `docs/specs/20260721-provider_subscription_accounts.md` and `docs/specs/20260708-pi_ai_unified_llm_backend.md` is implemented: `gateway.jsonc` owns logical IDs and ordered routes, Server Gateway Provider/model defaults and public Provider ownership are deleted, and worker plus internal-role inference use the same resolver. No compatibility alias, dual model meaning, direct worker Provider route, default-Provider dispatch branch, or intermediate account selector remains.

The removed Gateway and account dependencies do not remove or rename `/api/app/vault/bootstrap/codex-auth-json` and do not alter worker-runtime Codex app-server ownership; those boundaries remain with their existing specifications.

## Testing Strategy / Acceptance Criteria

- L1 route and resolution tests prove authentication order, logical-model validation, catalog-derived capability intersection and family equality, ordered member eligibility, provider-neutral slot binding, no default-slot guess, bounded pre-output failover, no post-output retry, exact subscription pre-dispatch errors, stable cache priority, and absence of a Provider-specific backend branch.
- L1 bridge tests prove the accepted mappings and fail every unrepresentable shape before provider effects.
- L2 contract tests prove public Chat Completions, Responses, logical models, SSE, error, usage, route-attempt attribution, and redaction behavior across API-key and subscription-backed profiles, including non-`2xx` JSON rather than SSE for every pre-start terminal failure.
- L3 black-box tests prove two logical models can dispatch through different Provider profiles on the same `/v1/*` routes, one logical model can advance across two subscription-account profiles on an admitted pre-output failure, discovery advertises only dispatchable logical IDs, and overlapping account slots remain isolated.
- L3 opt-in real-provider evidence proves one authenticated public Codex Gateway request per run, accepted streaming behavior, stable public envelopes, and redaction.
- L5 smoke proves NanoCore serves the Gateway without Codex app-server, `CODEX_HOME`, `auth.json`, or ambient credentials.

Acceptance requires the fixed route surface, exact logical-model authority, catalog-derived capability and model-family preservation, stable public envelopes, explicit generic account binding, bounded ordered pre-output failover, native Codex Responses through pi-ai, xAI subscription inference through pi-ai, hashed route-aware cache scope, Provider-reported cache evidence, no concrete Provider or account leakage, and no Provider-specific backend branch.

## Risks & Mitigations

- A generic account field could hide provider mismatch; provider-family derivation and slot-pair validation fail closed.
- Ordered fallback could double billing or output; it advances only before any response output, records each attempt and usage, and never attempts one member twice.
- Native and bridged endpoint behavior could diverge; explicit capability values and focused contract tests preserve observable semantics.
- Cache hints could be mistaken for authority; authorization precedes scope derivation and the resolver hashes only accepted inputs.
- Provider failures could leak subscription details; fixed schemas and redaction tests keep public errors generic.
- Removing the old config field breaks current internal profiles; same-release fixture updates and explicit re-login follow the repository's clean-target rule.

## Links

- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
