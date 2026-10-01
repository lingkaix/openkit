---
status: Accepted
implementation: Partial
kind: boundary
---
# LLM Gateway Responses API

## Owns

This spec owns the NanoCore LLM Gateway HTTP surface for OpenAI-compatible Chat Completions and Responses requests, the `gateway.jsonc` logical-model catalog, placement and Gateway projection of each logical model's context-management policy, model discovery, derived logical-model capabilities and model family, ordered private route planning, bounded pre-commit retries and failover, optional public cache-scope input, and the common public Gateway error envelope, redaction, and transport behavior. It also owns the routing rule that one route member references one Provider profile and that a subscription-backed Provider profile binds one explicit provider-subscription account slot.

## Does Not Own

This spec does not own provider transport, request, response, streaming, usage, cache, credential-input, or provider-error mapping, which belongs to `docs/specs/20260708-pi_ai_unified_llm_backend.md`; subscription account creation, login, refresh, logout, status, quota, or Vault persistence, which belongs to `docs/specs/20260721-provider_subscription_accounts.md`; context-compaction authority, lifecycle, item semantics, or quality gates, which belong to `docs/specs/20260902-agent_runtime_context_compaction.md`; durable capability and usage records; worker-side capability records; worker-runtime provenance; authenticated worker-inference identity binding; runtime cache-lineage specialization; policy evaluation; or `packages/protocol` schemas.

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
- `docs/specs/20260902-agent_runtime_context_compaction.md`

## Summary

NanoCore exposes the fixed agent-facing Gateway surface at `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/responses`, plus `/health`. Route handling authenticates and authorizes the caller, resolves one logical model, selects one eligible private route member, derives a bounded cache scope, and delegates the Provider effect to the unified pi-ai dispatcher. The caller sees only the logical model ID and declared contract; Provider profile, provider-native model, account slot, and fallback lineage remain private except in authorized redacted audit and usage evidence.

Codex and xAI subscription providers are not special Gateway backends. Their profiles use the same public routes and explicitly bind a server-owned account slot through provider-neutral OpenKit configuration. The unified backend resolves that slot before invoking pi-ai. The Gateway has no Codex app-server, `CODEX_HOME`, `auth.json`, or dedicated Codex client dependency in the clean target.

## Goals / Non-goals

### Goals

- Preserve one OpenAI-compatible Gateway surface for API-key, subscription-backed, gateway, local, and custom providers.
- Keep provider and model authority in authored OpenKit profiles rather than adapter discovery.
- Present stable logical model IDs whose concrete Provider profile, provider-native model, and account may vary without changing the caller-visible contract.
- Support deterministic ordered route members, bounded pre-commit transient retry, and optional failover for the classified failures accepted below.
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
- Do not implement weighted or randomized balancing, active health scoring, generic strategy plugins, fallback after public commit, or a guarantee that any fallback succeeds.

## Public HTTP Contract

### `POST /v1/chat/completions`

The route accepts OpenAI-compatible Chat Completions requests with supported system, developer, user, assistant, and tool messages. Unknown fields may pass through only when the selected endpoint mapping can preserve them; an unsupported semantic requirement fails with a stable Gateway error instead of being silently dropped.

Streaming uses OpenAI-compatible SSE chunks and terminates with `[DONE]`. If a provider failure occurs after headers begin, the stream emits the stable OpenKit error termination owned by this contract and never copies the upstream message or response body.

### `POST /v1/responses`

The route accepts OpenAI-compatible Responses requests with `model`, `input`, optional `stream`, and supported passthrough fields. It returns native Responses payloads when the selected provider capability is `native`, or a converted Responses payload only when the provider is chat-native and the request is bridgeable under this spec.

The route consumes the exact `context_management: [{ type: "compaction", compact_threshold }]` control under `docs/specs/20260902-agent_runtime_context_compaction.md`. The authenticated execution policy is authoritative: the Gateway injects an omitted control for OpenKit compaction authority, rejects a supplied mismatch or any control under runtime-native authority before Provider dispatch, and never blindly forwards this OpenKit-owned operation to a Provider. A caller-supplied `compaction_trigger` input item or another Provider-native compaction control is rejected rather than passed through. A completed OpenKit compaction item remains in the Responses output and may be round-tripped as later input under that owner.

`openai-codex` is Responses-native through the unified pi-ai backend. It must not use the current Chat Completions bridge or a dedicated OpenKit Codex transport after migration.

### `GET /v1/models`

The route returns only configured logical models from `gateway.jsonc` that have at least one currently eligible route member. Each result uses the logical model ID as `id`, exposes only its product-safe name and derived capabilities, and uses the stable product owner `openkit`; it never publishes a Provider profile ID, provider-native model, account slot, route-member ID, model-family classification, or Provider catalog ownership value.

A route member is eligible only when its referenced Provider profile is dispatchable, the provider-native model appears in that profile's explicit model list, its endpoint capability can preserve the requested Gateway surface, and any subscription binding passes the network-free slot, Vault, and credential checks below. Pi-ai and Provider-native catalogs never add an undeclared logical model or route member. Model discovery and inference dispatch call the same logical-model resolver, so a model advertised under the current snapshot is accepted for dispatch unless eligibility changes before the later request, in which case dispatch returns the stable current failure rather than choosing a different logical model.

Server-mode authentication is required because model supply and sibling inference routes are deployment-owned capabilities. When Gateway policy disables inference, model supply is hidden as well.

### Deployment Model Extension Catalog

As authorized by issue #25, `DATA_ROOT/config/model-catalog.jsonc` is the deployment-admin-owned extension to the immutable vendored models.dev inventory. Its strict shape is `{ "schemaVersion": 1, "providers": { "<vendor-or-profile-id>": { "models": { "<exact-native-model-id>": { /* Provider metadata fields */ } } } } }`. The key is exactly the profile's `vendor`, or its `id` when `vendor` is absent; there is no fallback between keys or model aliases. Subscription entries therefore use the subscription vendor and exact prefixed native ID when the profile lists that prefix. Keys must be nonblank. Metadata uses the operational subset below; reasoning effort notes may be JSONC comments, not runtime fields or new effort enums.

The file may register missing models or extend snapshot metadata. Only models explicitly listed by a Provider and selected through existing Gateway routes become available. Extension metadata is a non-authoring input to effective Provider metadata: snapshot → extension → profile, leaf by leaf, preserving explicit false, zero and empty arrays. Profile overlay removal restores extension inheritance; extension removal restores snapshot inheritance. The vendored snapshot and authored Provider files are never modified by composition. Deployment operating context limits belong in the extension catalog under exact Provider/model keys, including models already present upstream. There is no additional subscription-family context clamp after composition; profile leaves retain their explicit precedence, smaller declared limits remain smaller, and absent context is not fabricated. Upstream snapshot limits remain upstream facts rather than deployment policy.

The configuration identity owner defines file creation, revision checks, invalid/stale handling and restart behavior. Missing catalog means an empty extension. Invalid entries reject the complete candidate; there is no partial application, network fetch, retry worker, credential store or per-user catalog. Acceptance requires catalog-only registration of a missing exact model, unchanged vendored bytes, precedence and isolation across vendors, effective Gateway and adapter use, validation failure without replacing active metadata, admin-only generic editing and restart-required activation.

### Provider Model Metadata

A Provider profile MAY declare `modelMetadata`, a map keyed by exact provider-native IDs already present in its `models` list. This is authored Provider configuration, not another catalog or a logical-model field. Every configured model must have a known positive maximum context length: inherit `limit.context` from the pinned or deployment extension catalog when available, or author it here. Other metadata is optional. An exact native ID outside the catalog remains supported; absence of both sourced and authored context is a configuration error, not a reason to invent a limit or alias the model. The declared operational subset uses models.dev field names and units: optional `family`; boolean `attachment`, `reasoning`, `tool_call`, and `temperature`; `modalities.input` and `modalities.output` arrays over `text`, `image`, `audio`, `video`, and `pdf`; positive integer token `limit.context` and `limit.output`; and finite nonnegative USD-per-million-token `cost.input`, `cost.output`, `cost.cache_read`, and `cost.cache_write`. Unknown fields and metadata keys outside the profile's model list are rejected. Gateway logical-model configuration still cannot author capabilities or family directly.

One effective-metadata resolver merges the pinned catalog row, the deployment extension catalog, and the Provider's declaration in that precedence order. Present authored leaves win, including `false`, `0`, and empty arrays; omitted leaves inherit and arrays replace rather than concatenate. Missing optional leaves remain unknown. Missing effective `limit.context` rejects composed Provider configuration and keeps the last-known-good runtime snapshot; an adapter-private default cannot satisfy this requirement. A nonempty authored family is an operator assertion used to derive the shared-or-null logical family, not an upstream identity attestation. Declared capabilities describe model supply; they cannot change endpoint transport, grant tools or credentials, admit unsupported payload shapes, or rewrite the upstream model ID. A model-feature requirement may use the resulting effective capability set. The default public model projection remains unchanged and does not expose Provider identities, family, limits, or pricing.

The declaration is validated, persisted, replaced and removed through the existing Provider configuration and revision-checked reload lifecycle. Removing a leaf restores catalog inheritance. Invalid authored fields reject validation without replacing the active runtime snapshot. The same resolver supplies logical-model selection and adapter model construction; a stock model hit or subscription account selection must not silently bypass declared metadata. Effective values enter only newly composed executions; existing immutable AEP and internal-role run boundaries remain unchanged. Profile metadata uses its existing loader and adds no watcher, retry policy or credential store.

Startup examples are not exempt from required model context. A custom Provider placeholder with no real model or sourced limit remains a non-loadable example, not a seeded active profile. Activating it requires the operator's actual native model ID and context declaration; do not invent a context merely to make an example pass startup validation.

The backend owner defines how limits, input modalities, reasoning and prices map into the stock adapter. A declared or catalogued context limit is required sourced metadata, not a measured guarantee; adapter defaults cannot substitute for it. Unsupported modality payloads continue to fail under the existing request contract. The context-compaction owner will consume the same effective limits when its implementation lands. Parameter declarations do not implement compaction, new modality transports, or a billing engine.

For example, an administrator may keep `models: ["example/vision-model"]` and add `modelMetadata: { "example/vision-model": { "tool_call": true, "modalities": { "input": ["text", "image"], "output": ["text"] }, "limit": { "context": 131072, "output": 8192 }, "cost": { "input": 1, "output": 2, "cache_read": 0.1, "cache_write": 1.25 } } }`. These values illustrate the format and are not facts about any real Provider. The same JSONC editor and generated Provider JSON Schema support authoring; this contract adds no specialized metadata form.

Acceptance requires exact-ID admission with inherited or authored context, rejection of missing context without replacing active configuration, exact-ID scoping, rejected invalid leaves, leaf inheritance and explicit false/zero precedence, effective family and capability selection, and actual adapter parameters on stock, custom and explicit subscription-account model paths, with pair-owned catalog values unmodified after each request. Pricing checks must inspect the existing adapter's computed usage, not merely serialized configuration. Updating one Provider must not modify another Provider's metadata or a shared stock model object.

### Excluded Routes

`POST /v1/completions`, `POST /v1/responses/compact`, and the historical `/internal/v1/chat/completions` facade remain absent. Automatic context management on `POST /v1/responses` is the only accepted compaction route; a standalone compact operation requires a later accepted caller and contract. The provider-subscription App API is separate from `/v1/*` and follows `docs/specs/20260721-provider_subscription_accounts.md`.

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
  routing?: { autoFailover: boolean };
  contextManagement: Array<{
    type: "compaction";
    compactThreshold: number;
  }>;
  routes: Array<{
    id: string;
    providerProfileId: string;
    providerModel: string;
  }>;
}
```

IDs are stable and unique within their owning collection. V1 requires exactly one context-management entry with the shape above; `docs/specs/20260902-agent_runtime_context_compaction.md` owns its threshold validation, immutable execution projection, and separation from physical model limits. The Provider's explicit model list and the authored logical routes admit model IDs. The pinned `@openkit/models-dev-catalog` snapshot is an optional inventory and metadata source, not an allowlist: an administrator may hand-author a third-party model ID, and missing catalog membership or family MUST NOT by itself reject configuration, discovery, default selection, or inference when the required maximum context is supplied. The configured provider-native ID is passed unchanged to its authorized endpoint; no catalog alias, vendor impersonation, or snapshot update is required to use it.

Capability and family values are not free-form Gateway configuration. Available effective Provider model metadata enriches a route's contract; missing optional metadata contributes only capabilities derived from the Provider endpoint-capability matrix without inventing reasoning, multimodal, tool-calling, or temperature support. Absent optional capability metadata is not a prohibition on a request shape the existing adapter can preserve: actual endpoint/request validation and upstream rejection remain authoritative. An explicitly configured internal-role capability requirement must appear in the derived effective capability set: endpoint-derived capabilities may satisfy endpoint requirements, while absent catalog flags cannot satisfy model-feature requirements. Ordinary model admission does not add such a requirement.

Members may cross vendors and model families. The logical model derives one coherent contract over its members: minimum known context, minimum known output, intersection of input modalities and capabilities, and reasoning support only when every member declares it. Missing optional values remain unknown rather than fabricated; complete Worker model parameters are projected under the AEP owner. `modelFamilyId` is the shared non-null family when every member agrees, otherwise `null`, including unknown family metadata. Distinct or unknown families do not reject a multi-route logical model. Unknown family remains pinned as unknown rather than a fabricated identifier. Invalid context-management policy and an unrepresentable endpoint remain errors. The context and output minimum applies to the entire tier, including smaller backups; per-tier fixed overrides and Gateway-side compaction for a smaller backup are outside this routing design. The decision and its reason are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

The `@openkit/models-dev-catalog` snapshot version is pinned by that package and changes only with an explicit repository dependency snapshot update, not through runtime-config reload. Hand-authored model configuration uses ordinary revision-checked configuration writes and reload without modifying that snapshot. Startup and test validation recompute logical-model contracts using available metadata and the same missing-metadata rules. A refreshed catalog that changes a logical model's effective capabilities or `modelFamilyId` changes the composed setup and enters only a later immutable AEP or internal-role run; it never mutates an admitted Turn or silently crosses the previously accepted logical contract. Every configured model must resolve a positive context limit under Provider Model Metadata. Missing output metadata remains unknown; adapter output defaults remain operating values under the backend owner.

The request `model` is always a logical model ID. An explicit admitted request value wins; otherwise the applicable User, Workspace, Agent or internal-role preference resolves before `gateway.jsonc.defaultLogicalModelId` supplies the final Gateway fallback. Absence or ineligibility of the resolved logical model returns a typed error and never falls back to a different logical model.

### Routing Configuration And Planner

`routes` is a non-empty ordered list: `routes[0]` is the primary and the remaining entries are backups in authored order. The optional `routing` object currently defines one core field, required boolean `autoFailover`. Omitting the object means `true`; retained `gateway.jsonc` therefore keeps always-on failover without migration or a new `requiredFeatures` token. Invalid known core values reject the candidate through the existing configuration lifecycle. Unknown safely ignorable additive keys produce configuration warnings and are ignored under Contract Evolution; unsupported required or authority-bearing semantics fail closed. Ignored keys activate no routing strategy. The default and removal decisions are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

With `autoFailover: false`, only the primary is selected. An unavailable or failed primary returns its classified error; configured backups remain dormant until an administrator deliberately reorders routes or enables failover. With `autoFailover: true`, selection starts at the first available member and skips unavailable members without a Provider attempt. A candidate that cannot satisfy a pinned capability is ineligible for that request rather than attempted. Selection never substitutes another logical model or weakens an admitted contract.

One request-local planner turns the resolved logical model, the request, and current eligibility into an ordered candidate list with selection reasons. The Gateway executor runs that list under the retry, commit, and failure rules below. A later accepted dynamic or helper-model strategy adds fields to `routing` and replaces the planner without replacing the route list or Provider executor. No strategy enum, registry, plugin interface, or durable routing state exists now.

`gateway.jsonc` remains the unique durable routing authority. Routing is created, changed, or removed through its existing revision-checked write and reload lifecycle; stale writes and invalid candidates retain the last-known-good snapshot. Restart resolves the current validated configuration. Plans end with their request, are never recovered or retried as state, and require no durable creation, update, termination, or recovery lifecycle. Dependency failure is classified at selection or attempt time rather than repaired by the planner. Each Provider call restarts from the first available member, so a recovered primary is used again; there is no cooldown, health score, or sticky member.

### Unavailable Members

A route whose Provider profile is absent, not dispatchable, bound to an absent or logged-out account, or no longer lists the configured native model is an unavailable member, not a configuration error. Reload succeeds with a warning diagnostic naming that route. The logical ID remains valid for Agent, internal-role, and Workspace references. With no available member it is hidden from `/v1/models`, and requests fail with `gateway_logical_model_unavailable`. Removing a Provider does not rewrite its routes or promote a backup. Restoring supply can make the same authored member available again through the supply owner's ordinary activation lifecycle.

Availability is a current resolver projection, not a durable record, health observation, or separate lifecycle. It is recomputed for discovery and each Provider call; stale discovery does not authorize dispatch. Restart recomputes it from validated current supply. Missing supply is unavailable, while malformed configuration, invalid context policy, caller authority failure, and integrity failures retain their failed-closed owning contracts. Known authored context and output limits still constrain the compaction threshold even for unavailable members; an absent profile or delisted model supplies no fabricated metadata. A restored member must pass contract and threshold validation before it can be selected. No availability repair or retry worker is introduced.

A new internal-role model turn or worker inference request may begin with a different eligible member. The logical model ID, coherent contract, and derived `modelFamilyId` remain pinned for the owning internal-role run or worker Turn. A changed candidate must satisfy that pinned contract. One subscription-backed Provider profile binds at most one account slot; account rotation uses distinct ordered route members referencing distinct Provider profiles.

### Failure Kinds And Advancement

The pi-ai boundary produces one failure value under [the backend owner](20260708-pi_ai_unified_llm_backend.md#usage-errors-and-cancellation). Its `kind` has exactly the following values. This table is the sole enumeration and decides same-member retry and pre-commit failover eligibility.

| Kind | Meaning | Same-member retry | Failover when enabled |
| --- | --- | --- | --- |
| `auth_rejected` | Missing or rejected route credential | No | Yes |
| `quota_exhausted` | Provider quota or subscription allowance exhausted | No | Yes |
| `rate_limited` | Transient Provider throttling | Bounded | Yes, after retry handling |
| `provider_unavailable` | Provider 5xx, overload, network, timeout, or start failure | Bounded | Yes, after retry handling |
| `context_overflow` | Input exceeds the model context | No | No |
| `unsupported` | Unsupported endpoint or request capability | No | No |
| `output_limit` | Rejected output-limit requirement | No | No |
| `refused` | Provider refusal or safety rejection in error form | No | No |
| `invalid_request` | Invalid request | No | No |
| `cancelled` | Caller cancellation | No | No |
| `unknown` | Failure without sufficient classification evidence | No | No |

Policy denial, output validation failure, strict authority or persistence failure, and every post-commit failure are terminal. A confirmed context overflow preserves its typed public error so the runtime can compact; the Gateway does not silently change request semantics. A normal length/incomplete finish or readable refusal output is preserved as a protocol result, not converted into a retryable failure. The terminal-kind decision is recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

A failure value is attempt-local, not durable authority or account status. The backend creates it once from the observed failure; Gateway consumes it for retry, advancement, public projection, and private lineage. It ends with the attempt; durable retention uses only the existing evidence owner. Missing classification evidence yields `unknown`, never an invented transient status. A stale credential result cannot change account observations under the subscription owner. Restart does not recover or replay a failure value; a new request classifies new evidence. No independent failure-value update, termination, or recovery operation applies.

### Commit Boundary And Retry

A streaming attempt commits when its first output event carrying text, reasoning, or a tool call is released to the caller. Leading lifecycle events such as start, `response.created`, and role chunks remain private under a fixed byte cap and the existing request deadline. The public Response, including the worker-inference heartbeat, starts only at commit. A buffer reaching that cap or the deadline commits or fails privately; it never flushes a held failure as success. A first error event is an attempt failure rather than a successful stream. After commit, no retry or failover occurs; a later failure ends that stream with the existing stable terminal error.

A non-streaming attempt commits when its validated successful result is released to the caller. Before release, a thrown failure or terminal error result remains an attempt failure. No-output alone proves neither absence of upstream billing nor replay safety. If a Provider effect may already have started with an uncertain result, neither retry nor failover may repeat that effect.

Before commit, the transient kinds admitted by the table may receive up to three same-member retries with exponential backoff, independently of `autoFailover`. This means one initial attempt plus at most three retries. One absolute request deadline covers all attempts and waits. A retry requires that no Provider effect may already have started and that the next delay fits the remaining deadline. A private buffer or absence of output alone does not supply that proof. The backoff delays and the `retry-after` ceiling are fixed Gateway constants, each small relative to the request deadline, so that retry waiting never consumes the time a backup needs. An exposed `retry-after` replaces the computed delay only when it is within that ceiling and fits the remaining deadline; a longer `retry-after` is not waited out, and the Gateway advances when failover is eligible or terminates. Other kinds are never retried unchanged. Cancellation aborts the active attempt or wait. Pi-ai retries stay unset under the backend owner. The fixed retry count and its reason are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

Commit is a one-way request-local boundary, not a durable record. It is created with each attempt, can advance only from private to committed, and ends with that attempt's terminal outcome. Buffer bounds, deadline expiry, dependency failure, and cancellation settle privately before commit or terminate the committed response. It cannot be reset, recovered, or reopened after failure or restart. Restart cannot replay a committed or uncertain attempt; later work is a new owning request.

### Terminal Error And Private Lineage

With failover disabled, return the primary's classified error. With failover enabled and all members exhausted, return `gateway_logical_model_unavailable` with sanitized `cause` equal to the terminating attempt's kind. A request-terminal kind stops immediately with its typed error rather than continuing to exhaust members. If selection finds no available member, return the same typed logical-model-unavailable error without inventing an attempt cause.

Every attempt records one private route lineage entry containing logical ID, route-member ID, Provider profile and native model, account slot where safe, selection reason, attempt order, retry index, stable failure kind, usage when known, whether output began, and terminal result. A member unavailable at selection also records its kind and reason, including Provider or subscription checks that fail before any Provider call; it is not counted as an attempted Provider call. Public errors and model discovery redact those identities. Authorized management evidence may explain primary failure and backup service without exposing credentials or raw upstream errors. Terminal `cause` is an OpenKit failure kind, never provider-native text or identity.

### Sealed Reasoning Handoff

When Gateway returns a reasoning item, a new process-local item-to-member association records that item ID and the producing member’s key. The [compaction owner](20260902-agent_runtime_context_compaction.md#missing-invalid-stale-and-restarted-state) owns its payload-free entries, fixed entry ceiling, least-recently-used eviction, lifetime, and restart behavior. Forward opaque reasoning payloads, including `encrypted_content` and thinking signatures, unchanged only to the attributed member. Never relabel incoming reasoning as produced by the member about to be called.

For another member or an unattributed item, apply the readable-text handoff: drop signature and ciphertext, preserve non-empty readable reasoning as ordinary assistant text, omit empty or redacted thinking, and omit the paired `fc_` function-call ID. History from before restart, eviction, or an external producer is unattributed. The response gains no field, digest, or member identity. A later Provider rejection remains its classified terminal failure. The decision and restart-loss consequence are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

### Tier Templates

The closed shipped tier-template ID set is `free`, `flash`, `smart`, and `pro`. These are stable logical IDs remappable by administrators to concrete Provider models, not model or family names and not an allowlist for administrator-authored logical IDs. Repository Agent and internal-role templates prefer these tier IDs, and Gateway templates route them over template Providers. Templates are copy-on-init; existing Data Roots and their authored mappings are unaffected.

Current schema evolution retains the shared `schemaVersion`, `requiredFeatures`, and namespaced descriptive `extensions` mechanisms. The accepted `routing` object adds no required-feature token. Weighted routes, randomized selection, active health state, generalized algorithms, and helper-model behavior remain deferred.

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

Pi-ai vendor-side fallback stays unset. This design adds no Provider-profile field that authors upstream model substitution.

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
- simple function tools and tool results, including standard top-level or message-anchored `additional_tools` function declarations grouped under one namespace level; the canonical default `functions` namespace is equivalent to an unqualified function name
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
- non-function tool schemas, nested namespaces and deferred function declarations on the chat-native bridge

The pi-ai Responses path preserves admitted function-call identity and arguments, text tool outputs, developer/system instructions and terminal streamed or non-streamed output across a complete tool round trip. Standard declarations use the existing pi-ai context and Responses event projection without introducing an `additional_tools` item into the caller or provider payload. A namespace description, when present, is prepended to each member description so its instructions survive lowering. For a non-default namespace, the bridge uses a deterministic provider-private function name containing only ASCII letters, digits and underscores, at most 64 characters, and an exact request-local reverse mapping. The member description retains its original qualified name so the model can distinguish otherwise identical tools. It lowers declarations and replayed function calls together and restores the original namespace and name on streamed and non-streamed output, including the terminal response. Same-named functions in different namespaces remain distinct. Collision checks span plain functions and every lowered namespace member. Non-function namespace children remain unsupported. Mapping collisions, conflicting default-namespace aliases and undeclared or unmatched history fail before provider access; undeclared Provider output fails instead of inventing a callable identity. Incomplete streamed identities are withheld until they can be restored. The mapping is an ephemeral Gateway projection with no persistent registry and grants no tool execution authority. Native Codex namespace/custom-tool support retains its separate admission boundary.

## Cache Scope

`prompt_cache_key` is an optional OpenAI-compatible public request field, not a provider-specific field. The route resolves cache-scope input with this priority:

1. explicit top-level `prompt_cache_key`
2. authorized `metadata.openkit.promptCacheKey`
3. an available server-owned scope derived from logical model ID, selected private route member, Provider profile and native model, the `(subscriptionProviderId, accountSlotId)` pair when subscription-backed, authorized Workspace, server-resolved thread, AgentSession, or session
4. a request-scoped generated fallback

Every resolved scope is normalized and hashed by the S42-owned resolver before provider-facing use. Raw Workspace, thread, subscription-provider, account-slot, session, prompt, credential, or user identifiers are not exposed. Both `subscriptionProviderId` and `accountSlotId` participate in the hash so equal slot ids under different providers or accounts cannot share provider cache or Codex turn-state continuity accidentally.

The route supplies resolved cache input to the unified backend; it does not decide an upstream header or cache mechanism. Cache effectiveness exists only when the provider reports cache-read or cache-write usage. Absence of those values means unknown, not a miss.

## Error Contract

This section owns the shared public envelope, redaction, fallback interaction, and pre-start versus post-start transport rules. A narrower accepted capability specification may author a domain-specific condition, HTTP status, type, stable code, and fixed message under that envelope; `docs/specs/20260902-agent_runtime_context_compaction.md` does so for context management.

Gateway policy failures, missing logical defaults, unknown or unavailable logical models, exhausted route members, invalid account bindings, authentication failures, rate limits, quota exhaustion, context overflow, unsupported features, Provider failures, and cancellation use OpenAI-compatible error envelopes with stable OpenKit codes and fixed generic messages.

Upstream message text, provider-native codes and types, response bodies, pi-ai vocabulary, credential data, account identifiers, and stack traces never cross public JSON or SSE. Provider classification may inspect internal details only to select the stable public class.

Subscription-backed resolution uses these exact product-owned mappings before any pi-ai call or provider network work:

| Pre-dispatch condition | HTTP | Error type | Code | Fixed message |
| --- | ---: | --- | --- | --- |
| Unknown or missing account slot, provider-family mismatch, invalid subscription binding, or locked or unavailable Vault | 503 | `provider_error` | `gateway_provider_unavailable` | `Provider is unavailable.` |
| Missing, revoked, or otherwise unresolvable subscription credential | 401 | `provider_error` | `gateway_provider_authentication_failed` | `Provider authentication failed.` |

These conditions are classified and recorded before commit; enabled failover may advance under the routing contract. If the request terminates before commit, `stream: true` receives the corresponding non-`2xx` JSON envelope rather than a terminal SSE event. A provider failure after streaming has started retains the existing stable terminal SSE normalization and fixed public vocabulary.

## Diagnostics

Deployment-admin diagnostics may report:

- the Gateway endpoint inventory
- configured provider instances and endpoint capability chips
- dispatch readiness and stable redacted failure classes
- process-local request count and provider-reported input, output, total, cache-read, and cache-write quantities

Provider-registry diagnostics preserve the public provider-profile `kind`, endpoint capability, and readiness routing projections. They omit `dispatchFamily` and every private adapter or backend-implementation discriminator, so unified backend identity remains a private implementation detail.

The legacy `oauth.openaiCodexAccounts` diagnostics field is removed rather than renamed or generalized. Diagnostics do not project provider-subscription account state; the dedicated provider-subscription routes exclusively own provider inventory, account lifecycle, status, quota reads, and account observations. Authorized private route lineage remains Gateway evidence rather than account-state authority. Diagnostics never include credentials, raw account ids, Vault references, authorization headers, raw cache input, Codex turn state, raw quota responses, or pi-ai details.

## Current Implementation Projection

NanoCore implements `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/health` with server authentication, Gateway policy, `gateway.jsonc` logical-model loading, private Provider route resolution, ordered pre-output fallback, durable route attribution, prompt-cache resolution, stable errors, streaming, usage projection, and no retired internal facade. Public discovery and requests expose logical model IDs rather than Provider profiles or Provider-native model authority.

The current logical-model schema does not yet contain `contextManagement`, and the Responses route does not yet inject the control, execute the OpenKit compactor, or parse an OpenKit compaction item. Those are explicit implementation gaps under `docs/specs/20260902-agent_runtime_context_compaction.md`; the existing `/v1/responses` route is not evidence that automatic context management is implemented.

Provider resolution now accepts only the provider-neutral `extensions.openkit.subscriptionAccount` binding for recognized subscription profiles, validates the exact slot and local credential before dispatch, and sends both Codex and xAI subscription requests through the unified pi-ai dispatcher. Codex Responses is native through stock pi-ai, xAI uses its reviewed model capability, subscription-provider and account-slot identity participate in the hashed cache scope, and stable pre-dispatch and post-start errors expose no provider-private data.

Logical discovery and dispatch share one resolver, private Provider identities remain hidden, and ordered fallback is attributed per attempt. The routing switch, cross-family coherent contract, unavailable-member projection, planner, classified retry and commit behavior, sealed-reasoning attribution, and tier templates are accepted target amendments awaiting implementation. Existing ordered fallback is not evidence of these amended predicates.

## Accepted Design

The Hono route layer remains thin: authenticate, authorize, validate, resolve one logical model, ask the planner for an ordered candidate list and execute its eligible private members, derive cache scope, start durable attribution when applicable, call one unified Provider dispatcher, and normalize the public response. Subscription account selection is a Provider-resolution input, not a backend branch. All Provider-native behavior remains behind the S42 pi-ai adapter boundary.

## Rollout / Migration Plan

The clean cutover owned by this specification together with `docs/specs/20260721-provider_subscription_accounts.md` and `docs/specs/20260708-pi_ai_unified_llm_backend.md` is implemented: `gateway.jsonc` owns logical IDs and ordered routes, Server Gateway Provider/model defaults and public Provider ownership are deleted, and worker plus internal-role inference use the same resolver. No compatibility alias, dual model meaning, direct worker Provider route, default-Provider dispatch branch, or intermediate account selector remains.

The removed Gateway and account dependencies do not remove or rename `/api/app/vault/bootstrap/codex-auth-json` and do not alter worker-runtime Codex app-server ownership; those boundaries remain with their existing specifications.

## Testing Strategy / Acceptance Criteria

- L1 route and resolution tests prove authentication order, logical-model and context-management validation, catalog-enriched capability intersection, admission of exact hand-authored IDs with missing model or family metadata, cross-family and unknown-family multi-route admission with shared-or-null family projection, ordered member eligibility, provider-neutral slot binding, no default-slot guess, bounded pre-commit failover, no post-commit retry, exact subscription pre-dispatch errors, stable cache priority, and absence of a Provider-specific backend branch. A regression must observe an uncatalogued configured default in public discovery and an inference dispatch retaining its exact upstream model ID.
- L1 bridge tests prove the accepted mappings and fail every unrepresentable shape before provider effects.
- L2 contract tests prove public Chat Completions, Responses, logical models, SSE, error, usage, route-attempt attribution, and redaction behavior across API-key and subscription-backed profiles, including non-`2xx` JSON rather than SSE for every pre-start terminal failure.
- L3 black-box tests prove two logical models can dispatch through different Provider profiles on the same `/v1/*` routes, one logical model can advance across two subscription-account profiles on an admitted pre-commit failure when failover is enabled, discovery advertises only dispatchable logical IDs, and overlapping account slots remain isolated.
- L3 opt-in real-provider evidence proves one authenticated public Codex Gateway request per run, accepted streaming behavior, stable public envelopes, and redaction.
- L5 smoke proves NanoCore serves the Gateway without Codex app-server, `CODEX_HOME`, `auth.json`, or ambient credentials.

Acceptance requires the fixed route surface, exact logical-model authority with optional catalog enrichment, validated context-management placement and Responses projection under its separate owner, honest capability and known-or-null model-family preservation, stable public envelopes, explicit generic account binding, bounded ordered pre-commit failover under its routing setting, native Codex Responses through pi-ai, xAI subscription inference through pi-ai, hashed route-aware cache scope, Provider-reported cache evidence, no concrete Provider or account leakage, and no Provider-specific backend branch.

Additional routing acceptance requires:

- Omitted routing preserves retained configuration behavior; explicit false selects only the primary, and a failed or unavailable primary never promotes or attempts a backup.
- Mixed-family members with unequal known limits and modalities project the coherent contract, preserve explicit false and unknown metadata, and launch through the AEP without requiring deep equality. A member missing a pinned capability is never attempted.
- Removed, logged-out, disabled, absent, or delisted supply produces named warning diagnostics on successful reload, preserves logical and route IDs, and hides only models with no available member. Restored supply re-enters the authored order after validation.
- Thrown errors and first terminal error events drive the same advancement rule; bounded same-member retries stop at three, deadline or cancellation, respect long retry guidance without early retry, and run with failover disabled too.
- Lifecycle events and worker-inference heartbeat stay private until commit; first reasoning and tool output commit as text does. Non-stream terminal errors remain private failures. Buffer exhaustion never publishes a failure as success, and committed or uncertain effects are never replayed.
- Every closed failure kind has representative normalization and advancement cases. Request-terminal kinds remain typed, exhaustion cause is the terminating attempt's kind, and selection-only failures appear in private lineage without fabricated Provider attempts.
- Same-member reasoning round trips preserve the opaque payload; cross-member, evicted, external, and post-restart items use readable-text handoff and omit paired function-call IDs. The payload-free association stays within its fixed entry ceiling under sustained traffic, and eviction produces readable-text handoff rather than an error. No returned field exposes member identity.
- Each new Provider call starts again at the first available member without cooldown. Vendor-side fallback stays unset. Shipped templates use the Tier Templates owner and leave initialized Data Roots unchanged.

## Risks & Mitigations

- A generic account field could hide provider mismatch; provider-family derivation and slot-pair validation fail closed.
- Ordered failover and transient retry could duplicate effects or output; the commit boundary and replay-safety rule constrain both, and private lineage records each attempt, retry, selection-time unavailability, and known usage.
- Native and bridged endpoint behavior could diverge; explicit capability values and focused contract tests preserve observable semantics.
- Cache hints could be mistaken for authority; authorization precedes scope derivation and the resolver hashes only accepted inputs.
- Provider failures could leak subscription details; fixed schemas and redaction tests keep public errors generic.
- Removing the old config field breaks current internal profiles; same-release fixture updates and explicit re-login follow the repository's clean-target rule.

## Links

- `docs/specs/20260708-pi_ai_unified_llm_backend.md`
- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260703-pi_ai_provider_gateway_adoption.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260902-agent_runtime_context_compaction.md`
