---
status: Accepted
implementation: Partial
kind: boundary
aspect: mediation
---
# LLM Gateway Responses API

This document owns public LLM Gateway admission, logical-model routing, execution, retry boundaries, and result projection. Agent-facing IDs and model spellings follow [Operation Definition](20261002-operation_definition.md#names), including its compatibility details and limits. This document owns admission and execution, not a second naming rule.

## Scope

**Owns.** The public OpenAI-compatible Chat Completions and Responses surface, the `gateway.jsonc` logical-model catalog, context-management placement and projection, model discovery, derived capabilities and model family, ordered private route planning, bounded pre-commit retry and failover, optional public cache-scope input, and the public error envelope, redaction, and transport. One route member names one Provider profile. A subscription-backed profile binds one explicit account slot.

**Does not own.**

- Provider transport, mapping, usage, cache hashing, credential input, and provider-error classification belong to [Pi AI Unified LLM Backend](20260708-pi_ai_unified_llm_backend.md).
- Account creation, login, refresh, logout, status, quota, and Vault persistence belong to [Provider Subscription Accounts](20260721-provider_subscription_accounts.md).
- Compaction authority, lifecycle, items, and quality gates belong to [Agent Runtime Context Compaction](20260902-agent_runtime_context_compaction.md).
- Durable capability and usage records, worker capability records, worker-runtime provenance, worker-inference identity, runtime cache-lineage specialization, and policy evaluation stay with their owners.
- `packages/protocol` does not copy this Gateway surface.

**Core.** [Mediation](../core/mediation.md), [Vault](../core/vault.md), [Policy](../core/policy.md), and [Evidence](../core/evidence.md).

## Public HTTP Contract

### Public App Reachability

The Gateway's `/v1/*` routes use NanoCore's application listener and retain their existing caller scope; the public Web origin does not proxy them. Its `/v1` contract does not make those routes part of the public App origin. The public App rejects exact `/v1` and every `/v1/` descendant with HTTP 404 and a bounded JSON `not_found` error for every method. It performs no Gateway forwarding, Provider contact, or redirect to another listener, and never returns the Web application's HTML as a successful API response ([#209 ruling](../decisions/20261015-sandbox_telemetry_and_public_gateway_boundary.md)).

The existing authenticated Gateway and Worker-local inference paths keep their current authorization and routing boundaries. Missing public reachability is an explicit refusal, not permission to add a proxy or change Gateway binding. Acceptance checks GET, HEAD, and POST on `/v1`, models, Chat, and Responses paths, query strings, and unknown descendants; ordinary Web reads and the existing App API remain under their own routes.

### `POST /v1/chat/completions`

The route accepts OpenAI-compatible Chat Completions requests with supported system, developer, user, assistant, and tool messages. The closed admission is `store` false-only, `stream_options` containing only boolean `include_usage`, and the restricted message fields and roles. An unknown semantic field is refused before credentials. An unsupported semantic requirement fails with a stable Gateway error instead of being silently dropped.

Streaming uses OpenAI-compatible SSE chunks and terminates with `[DONE]`. If a provider failure occurs after headers begin, the stream emits the stable OpenKit error termination owned by this contract and never copies the upstream message or response body.

### `POST /v1/responses`

The route accepts OpenAI-compatible Responses requests with `model`, `input`, and optional `stream`. The closed admission is `store` false-only, `include` empty or exactly `reasoning.encrypted_content`, `text.verbosity` of `low`, `medium`, or `high`, `reasoning.context` of `all_turns`, and `reasoning.summary` of `auto`, `concise`, `detailed`, `off`, `on`, or an admitted null. An unknown semantic field is refused before credentials. It returns a Responses projection directly from the selected pi-ai result or event stream under the [backend mapping contract](20260708-pi_ai_unified_llm_backend.md#backend-contract). Same-protocol native content that stock Context, call options or result blocks cannot represent uses the admitted native channel; the public response never depends on conversion through Chat Completions.

Native Responses explicitly admits inline PNG/JPEG data URLs in user `input_image` content and complete `function_call_output.output` arrays containing text and images. The selected model's effective input modalities must include image input. Preserve image bytes, content order, instructions, text, Tool history and attributed reasoning. Preserve optional native image detail (`auto`, `low` or `high`) through the existing native channel. Existing request byte limits and final request admission still apply. Missing image capability, malformed inline encoding and unsupported image shapes fail with `unsupported_gateway_feature` before inference. This mapping adds no decoding, transcoding, state or lifecycle; the backend owner's native-channel lifecycle applies. Chat images, other roles, custom Tool output images, remote image URLs, file ids, other media and cross-protocol image mapping remain unsupported.

Complete historical local-tool pairs may be admitted as non-callable context on a same-protocol native Responses request under the [backend owner's historical-pair contract](20260708-pi_ai_unified_llm_backend.md#compatibility), even when their tool is absent from the current declarations. This changes neither current callable authority nor validation of new Provider calls. Gateway preserves the admitted structured history; it does not synthesize declarations, convert the pairs to prose, or discard them. A runtime-native textual summary request using ordinary Responses inputs is governed by ordinary request admission; its summarization purpose alone is not a forbidden Provider-native compaction control.

The backend owner's [Native Channel lifecycle](20260708-pi_ai_unified_llm_backend.md#backend-contract) governs this request-derived, attempt-local validation, including retry, cancellation, recovery, restart and dependency failure. The exception introduces no durable record or migration. Its rationale is recorded in [Historical Tool Pairs And Release Hold](../decisions/20261008-historical_tool_pairs_and_release_hold.md).

The route consumes the exact `context_management: [{ type: "compaction", compact_threshold }]` control under `docs/specs/20260902-agent_runtime_context_compaction.md`. The authenticated execution policy is authoritative: the Gateway injects an omitted control for OpenKit compaction authority, rejects a supplied mismatch or any control under runtime-native authority before Provider dispatch, and never blindly forwards this OpenKit-owned operation to a Provider. A caller-supplied `compaction_trigger` input item or another Provider-native compaction control is rejected rather than passed through. A completed OpenKit compaction item remains in the Responses output and may be round-tripped as later input under that owner.

`openai-codex` is Responses-native through the unified pi-ai backend. It must use direct stock-IR mapping and Responses projection with no Chat Completions detour or dedicated OpenKit Codex transport.

### `GET /v1/models`

The route returns only configured logical models from `gateway.jsonc` that have at least one currently eligible route member. Each result uses the logical model ID as `id`, exposes only its product-safe name and derived capabilities, and uses the stable product owner `openkit`; it never publishes a Provider profile ID, provider-native model, account slot, route-member ID, model-family classification, or Provider catalog ownership value.

A route member is eligible only when its referenced Provider profile is dispatchable, the provider-native model appears in that profile's explicit model list, its endpoint capability can preserve the requested Gateway surface, any API key the profile requires is configured, and any subscription binding passes the network-free slot, Vault, and credential checks below. Pi-ai and Provider-native catalogs never add an undeclared logical model or route member. Model discovery and inference dispatch call the same logical-model resolver, so a model advertised under the current snapshot is accepted for dispatch unless eligibility changes before the later request, in which case dispatch returns the stable current failure rather than choosing a different logical model.

Server-mode authentication is required because model supply and sibling inference routes are deployment-owned capabilities. When Gateway policy disables inference, model supply is hidden as well.

### Deployment Model Extension Catalog

As authorized by issue #25, `DATA_ROOT/config/model-catalog.jsonc` is the deployment-admin-owned extension to the immutable vendored models.dev inventory. Its strict shape is `{ "schemaVersion": 1, "providers": { "<vendor-or-profile-id>": { "models": { "<exact-native-model-id>": { /* Provider metadata fields */ } } } } }`. The key is exactly the profile's `vendor`, or its `id` when `vendor` is absent; there is no fallback between keys or model aliases. Subscription entries therefore use the subscription vendor and exact prefixed native ID when the profile lists that prefix. Keys must be nonblank. Metadata uses the operational subset below, including `reasoning_options` under the reasoning-effort contract.

The file may register missing models or extend snapshot metadata. Only models explicitly listed by a Provider and selected through existing Gateway routes become available. Extension metadata is a non-authoring input to effective Provider metadata: snapshot → extension → profile, leaf by leaf, preserving explicit false, zero and empty arrays. Profile overlay removal restores extension inheritance; extension removal restores snapshot inheritance. A runtime reload refuses an extension edit that removes the last positive context source of an already configured, still-listed model; this is an invalid authored transition, distinct from admitting a new unknown model with a warning. A remaining snapshot or profile context source and explicit model delisting remain valid. The vendored snapshot and authored Provider files are never modified by composition. Deployment operating context limits belong in the extension catalog under exact Provider/model keys, including models already present upstream. There is no additional subscription-family context clamp after composition; profile leaves retain their explicit precedence, smaller declared limits remain smaller, and absent context is not fabricated. Upstream snapshot limits remain upstream facts rather than deployment policy.

The configuration identity owner defines file creation, revision checks, invalid/stale handling and restart behavior. Missing catalog means an empty extension. Invalid entries reject the complete candidate; there is no partial application, network fetch, retry worker, credential store or per-user catalog. Acceptance requires catalog-only registration of a missing exact model, unchanged vendored bytes, precedence and isolation across vendors, effective Gateway and adapter use, validation failure without replacing active metadata, admin-only generic editing and restart-required activation.

### Provider Model Metadata

A Provider profile MAY declare `modelMetadata`, a map keyed by exact provider-native IDs already present in its `models` list. This is authored Provider configuration, not another catalog or a logical-model field. Every routable model must have a known positive maximum context length: inherit `limit.context` from the pinned or deployment extension catalog when available, or author it here. Other metadata is optional. An exact native ID outside the catalog remains supported; absence of both sourced and authored context produces the existing `provider.unknown_model_context` warning and makes only that model unavailable for routing with `provider_not_dispatchable`. Boot and reload remain usable for the other models; neither invents a limit or aliases the model. The declared operational subset uses models.dev field names and units: optional `family`; boolean `attachment`, `reasoning`, `tool_call`, and `temperature`; `modalities.input` and `modalities.output` arrays over `text`, `image`, `audio`, `video`, and `pdf`; positive integer token `limit.context` and `limit.output`; `reasoning_options` as defined below; and finite nonnegative USD-per-million-token `cost.input`, `cost.output`, `cost.cache_read`, and `cost.cache_write`. Unknown additive metadata fields are ignored with a diagnostic. Invalid known fields and metadata keys outside the profile's model list are rejected. Gateway logical-model configuration still cannot author capabilities or family directly.

One effective-metadata resolver merges the pinned catalog row, the deployment extension catalog, and the Provider's declaration in that precedence order. Present authored leaves win, including `false`, `0`, and empty arrays; omitted leaves inherit and arrays replace rather than concatenate. Missing optional leaves remain unknown. Missing effective `limit.context` leaves the affected route unavailable and preserves the warning through configuration composition; an adapter-private default cannot satisfy this requirement. A request that selects no available member returns the existing route-unavailable error before a Provider call. A nonempty authored family is an operator assertion used to derive the shared-or-null logical family, not an upstream identity attestation. Declared capabilities describe model supply; they cannot change endpoint transport, grant tools or credentials, admit unsupported payload shapes, or rewrite the upstream model ID. A model-feature requirement may use the resulting effective capability set. The public logical-model projection advertises reasoning support and the derived effort levels below, while still excluding Provider identities, family, limits, and pricing.

The declaration is validated, persisted, replaced and removed through the existing Provider configuration and revision-checked reload lifecycle. Removing a leaf restores catalog inheritance. Invalid authored fields reject validation without replacing the active runtime snapshot. The same resolver supplies logical-model selection and adapter model construction; a stock model hit or subscription account selection must not silently bypass declared metadata. Effective values enter only newly composed executions; existing immutable AEP and internal-role run boundaries remain unchanged. Profile metadata uses its existing loader and adds no watcher, retry policy or credential store.

Startup examples are not exempt from required model context. A custom Provider placeholder with no real model or sourced limit remains an inactive example, not a seeded routable profile. Activating it requires the operator's actual native model ID and context declaration; do not invent a context merely to make an example pass startup validation.

The backend owner defines how limits, input modalities, reasoning and prices map into the stock adapter. A declared or catalogued context limit is required sourced metadata, not a measured guarantee; adapter defaults cannot substitute for it. Unsupported modality payloads continue to fail under the existing request contract. The context-compaction owner will consume the same effective limits when its implementation lands. Parameter declarations do not implement compaction, new modality transports, or a billing engine.

For example, an administrator may keep `models: ["example/vision-model"]` and add `modelMetadata: { "example/vision-model": { "tool_call": true, "modalities": { "input": ["text", "image"], "output": ["text"] }, "limit": { "context": 131072, "output": 8192 }, "cost": { "input": 1, "output": 2, "cache_read": 0.1, "cache_write": 1.25 } } }`. These values illustrate the format and are not facts about any real Provider. The same JSONC editor and generated Provider JSON Schema support authoring; this contract adds no specialized metadata form.

Acceptance requires exact-ID admission with inherited or authored context, a warning and member-level routing refusal for missing context while boot and reload remain usable, exact-ID scoping, rejected invalid leaves, leaf inheritance and explicit false/zero precedence, effective family and capability selection, and actual adapter parameters on stock, custom and explicit subscription-account model paths, with pair-owned catalog values unmodified after each request. Pricing checks must inspect the existing adapter's computed usage, not merely serialized configuration. Updating one Provider must not modify another Provider's metadata or a shared stock model object.

### Excluded Routes

`POST /v1/completions`, `POST /v1/responses/compact`, and the historical `/internal/v1/chat/completions` facade remain absent. Automatic context management on `POST /v1/responses` is the only accepted compaction route; a standalone compact operation requires a later accepted caller and contract. The provider-subscription App API is separate from `/v1/*` and follows `docs/specs/20260721-provider_subscription_accounts.md`.

## Authentication, Authorization, And Attribution

In server mode every `/v1/*` request authenticates the actor before route parsing, model discovery, provider resolution, credential access, or provider effects. Gateway policy and current Workspace authority are evaluated before dispatch. Local mode requires a loopback peer and an entirely loopback forwarded chain; only requests without an Authorization header may use the implicit local User. A presented credential is validated as itself and never falls back to local authority. A Workspace token must name its authorized Workspace in metadata, and a read-only token cannot authorize an inference effect.

Public `metadata` and `metadata.openkit` are optional. A caller-supplied `metadata.openkit.workspaceId` is only requested scope until active membership and token-binding checks authorize that Workspace. Only authenticated actor context plus current server-owned Workspace, thread, turn, item, agent, and AgentSession records can establish durable authority. Caller-supplied lineage may be retained only as non-authoritative best-effort labels. A caller-supplied `metadata.openkit.requestId` that already has a CapabilityCall, whether running or terminal, is refused with the existing `invalid_request` kind before any Provider call. An attributed logical call starts its CapabilityCall once before the route plan runs and finishes it once at the logical terminal outcome.

An otherwise authorized request without Workspace scope may dispatch. When Core is available, its CapabilityCall and usage use the existing Server-owned families in `core.sqlite`; only the absence of Core leaves process-local diagnostics. A supplied but unauthorized Workspace fails before provider dispatch. Public metadata never selects a credential, account slot, provider endpoint, or unlisted model.

## Logical Model Catalog And Ordered Routing

`DATA_ROOT/config/gateway.jsonc` is the sole authored Gateway configuration file. It is a strict versioned record with Gateway enablement, optional `defaultLogicalModelId`, and a non-empty identified logical-model catalog when enabled. The removed `server.jsonc.gateway`, `gatewayProviderId`, and `gatewayModel` fields are invalid and have no compatibility reader.

`GatewayConfigSchema` and `GatewayLogicalModelSchema` in `packages/config-schema/src/gateway.ts` own the authored Gateway configuration and logical-model entries. IDs are stable and unique within their owning collection. `GatewayConfigSchema` also carries `titleLogicalModelId`, explicit `providerAccessShapes`, and a separate ordered transcription chain. The reader preserves a historical single transcription-member interpretation. Those fields are not extra logical chat models and they are not public Responses authority. V1 requires exactly one context-management entry with that schema's shape; `docs/specs/20260902-agent_runtime_context_compaction.md` owns its threshold validation, immutable execution projection, and separation from physical model limits. The Provider's explicit model list and the authored logical routes admit model IDs. The pinned `@openkit/models-dev-catalog` snapshot is an optional inventory and metadata source, not an allowlist: an administrator may hand-author a third-party model ID, and missing catalog membership or family MUST NOT by itself reject configuration, discovery, default selection, or inference when the required maximum context is supplied. The configured provider-native ID is passed unchanged to its authorized endpoint; no catalog alias, vendor impersonation, or snapshot update is required to use it.

Capability and family values are not free-form Gateway configuration. Available effective Provider model metadata enriches a route's contract; missing optional metadata contributes only capabilities derived from the Provider endpoint-capability matrix without inventing reasoning, multimodal, tool-calling, or temperature support. Absent optional capability metadata is not a prohibition on a request shape the existing adapter can preserve: actual endpoint/request validation and upstream rejection remain authoritative. An explicitly configured internal-role capability requirement must appear in the derived effective capability set: endpoint-derived capabilities may satisfy endpoint requirements, while absent catalog flags cannot satisfy model-feature requirements. Ordinary model admission does not add such a requirement.

Members may cross vendors and model families. The logical model derives one coherent contract over its members: minimum known context, minimum known output, intersection of input modalities and capabilities, and reasoning support only when every member declares it. Missing optional values remain unknown rather than fabricated; complete Worker model parameters are projected under the AEP owner. `modelFamilyId` is the shared non-null family when every member agrees, otherwise `null`, including unknown family metadata. Distinct or unknown families do not reject a multi-route logical model. Unknown family remains pinned as unknown rather than a fabricated identifier. Invalid context-management policy and an unrepresentable endpoint remain errors. The context and output minimum applies to the entire tier, including smaller backups; per-tier fixed overrides and Gateway-side compaction for a smaller backup are outside this routing design. The decision and its reason are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

The `@openkit/models-dev-catalog` snapshot version is pinned by that package and changes only with an explicit repository dependency snapshot update, not through runtime-config reload. Hand-authored model configuration uses ordinary revision-checked configuration writes and reload without modifying that snapshot. Startup and test validation recompute logical-model contracts using available metadata and the same missing-metadata rules. A refreshed catalog that changes a logical model's effective capabilities or `modelFamilyId` changes the composed setup and enters only a later immutable AEP or internal-role run; it never mutates an admitted Turn or silently crosses the previously accepted logical contract. Every routable model must resolve a positive context limit under Provider Model Metadata. Missing output metadata remains unknown; adapter output defaults remain operating values under the backend owner.

The request `model` is always a logical model ID. An explicit admitted request value wins; otherwise the applicable User, Workspace, Agent or internal-role preference resolves before `gateway.jsonc.defaultLogicalModelId` supplies the final Gateway fallback. Absence or ineligibility of the resolved logical model returns a typed error and never falls back to a different logical model.

### Routing Configuration And Planner

`routes` is a non-empty ordered list: `routes[0]` is the primary and the remaining entries are backups in authored order. The optional `routing` object currently defines one core field, required boolean `autoFailover`. Omitting the object means `true`; retained `gateway.jsonc` therefore keeps always-on failover without migration or a new `requiredFeatures` token. Invalid known core values reject the candidate through the existing configuration lifecycle. Unknown safely ignorable additive keys produce configuration warnings and are ignored under Contract Evolution; unsupported required or authority-bearing semantics fail closed. Ignored keys activate no routing strategy. The default and removal decisions are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

With `autoFailover: false`, only the primary is selected. An unavailable or failed primary returns its classified error; configured backups remain dormant until an administrator deliberately reorders routes or enables failover. With `autoFailover: true`, selection starts at the first available member and skips unavailable members without a Provider attempt. A candidate that cannot satisfy a pinned capability is ineligible for that request rather than attempted. Selection never substitutes another logical model or weakens an admitted contract.

One request-local planner turns the resolved logical model, the request, and current eligibility into an ordered candidate list with selection reasons. The Gateway executor runs that list under the retry, commit, and failure rules below. A later accepted dynamic or helper-model strategy adds fields to `routing` and replaces the planner without replacing the route list or Provider executor. No strategy enum, registry, plugin interface, or durable routing state exists now.

`gateway.jsonc` remains the unique durable routing authority. Routing is created, changed, or removed through its existing revision-checked write and reload lifecycle; stale writes and invalid candidates retain the last-known-good snapshot. Restart resolves the current validated configuration. Plans end with their request, are never recovered or retried as state, and require no durable creation, update, termination, or recovery lifecycle. Dependency failure is classified at selection or attempt time rather than repaired by the planner. Each Provider call restarts from the first available member, so a recovered primary is used again; there is no cooldown, health score, or sticky member.

### Unavailable Members

A route whose Provider profile is absent, is not dispatchable, requires an API key that is not configured, is bound to an absent or logged-out account, or no longer lists the configured native model is an unavailable member, not a configuration error. Reload succeeds with a warning diagnostic naming that route. The logical ID remains valid for Agent, internal-role, and Workspace references. With no available member it is hidden from `/v1/models`, and requests fail with `gateway_logical_model_unavailable`. Removing a Provider does not rewrite its routes or promote a backup. Restoring supply can make the same authored member available again through the supply owner's ordinary activation lifecycle.

Availability is a current resolver projection, not a durable record, health observation, or separate lifecycle. It is recomputed for discovery and each Provider call; stale discovery does not authorize dispatch. Restart recomputes it from validated current supply. Missing supply is unavailable, while malformed configuration, invalid context policy, caller authority failure, and integrity failures retain their failed-closed owning contracts. A missing API key is missing supply ([decision](../decisions/20261002-missing_api_key_member_unavailable.md)): whether a key is configured is judged from the credential reference's configuration and non-secret Vault reference metadata, without resolving Vault material, recording Vault use, or a network request. A configured key that the Provider rejects, that a locked Vault cannot release, or that disappears after selection keeps its attempt classification. Known authored context and output limits still constrain the compaction threshold even for unavailable members; an absent profile or delisted model supplies no fabricated metadata. A restored member must pass contract and threshold validation before it can be selected. No availability repair or retry worker is introduced.

A new internal-role model turn or worker inference request may begin with a different eligible member. The logical model ID, coherent contract, and derived `modelFamilyId` remain pinned for the owning internal-role run or worker Turn. A changed candidate must satisfy that pinned contract. One subscription-backed Provider profile binds at most one account slot; account rotation uses distinct ordered route members referencing distinct Provider profiles.

### Failure Kinds And Advancement

The pi-ai boundary produces one failure value under [the backend owner](20260708-pi_ai_unified_llm_backend.md#errors-and-failover). Its `kind` has exactly the following values. This table is the sole enumeration and decides same-member retry and pre-commit failover eligibility.

| Kind | Meaning | Same-member retry | Failover when enabled |
| --- | --- | --- | --- |
| `auth_rejected` | Missing or rejected route credential | No | Yes |
| `quota_exhausted` | Provider quota or subscription allowance exhausted | Only after a confirmed enabled-account Codex weekly reset below | Yes |
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

A failure value is attempt-local, not durable authority or account status. The backend creates it once from the observed failure; Gateway consumes it for retry, advancement, public projection, and private lineage. It ends with the attempt; durable retention uses only the `openkit.gateway/routeLineage` document on the one CapabilityCall of the logical invocation, owned by [Audit, Usage, And Evidence Records](20260703-audit_usage_evidence_records.md#gateway-route-lineage). Missing classification evidence yields `unknown`, never an invented transient status. A stale credential result cannot change account observations under the subscription owner. Restart does not recover or replay a failure value; a new request classifies new evidence. No independent failure-value update, termination, or recovery operation applies.

### Commit Boundary And Retry

A streaming attempt commits when its first output event carrying text, reasoning, or a tool call is released to the caller. Leading lifecycle events such as start, `response.created`, and role chunks remain private under a fixed byte cap and the absolute request deadline. The public Response, including the worker-inference heartbeat, starts only at commit. A buffer reaching that cap or the deadline commits or fails privately; it never flushes a held failure as success. A first error event is an attempt failure rather than a successful stream. After commit, no retry or failover occurs; a later failure ends that stream with the existing stable terminal error.

A non-streaming attempt commits when its validated successful result is released to the caller. Before release, a thrown failure or terminal error result remains an attempt failure. No-output alone proves neither absence of upstream billing nor replay safety. If a Provider effect may already have started with an uncertain result, neither retry nor failover may repeat that effect.

Before commit, the transient kinds admitted by the table may receive up to three same-member retries with exponential backoff, independently of `autoFailover`. This means one initial attempt plus at most three retries. One absolute request deadline covers all attempts and waits. A retry requires that no Provider effect may already have started and that the next delay fits the remaining deadline. A private buffer or absence of output alone does not supply that proof. The current defaults are a private buffer of `32768` bytes, a pre-commit deadline of `120000` ms, backoff of `1000`, `2000`, and `4000` ms, and a `retry-after` ceiling of `10000` ms. The deadline covers only pre-commit work. These constants stay small relative to the request deadline, so retry waiting never consumes the time a backup needs. An exposed `retry-after` replaces the computed delay only when it is within that ceiling and fits the remaining deadline; a longer `retry-after` is not waited out, and the Gateway advances when failover is eligible or terminates. Other kinds are never retried unchanged. Cancellation aborts the active attempt or wait. Pi-ai retries stay unset under the backend owner. The fixed retry count and its reason are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

Commit is a one-way request-local boundary, not a durable record. It is created with each attempt, can advance only from private to committed, and ends with that attempt's terminal outcome. Buffer bounds, dependency failure, and cancellation settle privately before commit or terminate the committed response. Deadline expiry settles only the pre-commit phase and never terminates a committed response. It cannot be reset, recovered, or reopened after failure or restart. Restart cannot replay a committed or uncertain attempt; later work is a new owning request.

### Codex Subscription Controls

The [subscription account owner](20260721-provider_subscription_accounts.md#codex-credits-and-banked-resets) supplies the account settings, fresh quota observation and banked-reset operation. With Codex credits disabled, a successful observation no older than `60000` ms (current default) that shows a window at `100%` produces a settled pre-dispatch `quota_exhausted` failure. Normal ordered failover applies. A failed, missing or stale observation does not refuse inference, and credits use defaults to disabled when the account setting is absent.

Only after an actual settled quota failure and no successful eligible failover target may the Gateway ask an enabled account owner to consume one reset for an exhausted weekly window. A five-hour window never qualifies. The account owner serializes spending and guards one attempt per weekly window through its existing reset Audit. Only a confirmed reset permits one retry of that affected member, under the original deadline, cancellation and pre-commit bounds. Unknown reset results, committed or unsettled inference, and failed reset consumption never permit a retry. This exception adds no new routing strategy or general quota retry policy.

### Terminal Error And Private Lineage

With failover disabled, return the primary's classified error. With failover enabled and all members exhausted, return `gateway_logical_model_unavailable` with sanitized `error.cause` in the OpenAI-compatible error object equal to the terminating attempt's kind. A request-terminal kind stops immediately with its typed error rather than continuing to exhaust members. If selection finds no available member, return the same typed logical-model-unavailable error with `error.cause` absent, without inventing an attempt cause.

One `openkit.gateway/routeLineage` document on the logical invocation's CapabilityCall holds the ordered entries: one per member unavailable at selection and one per attempt, including each same-member retry. Every attempt entry retains logical ID, route-member ID, Provider profile and native model, selection reason, attempt order, retry index, stable failure kind, usage when known, whether output began, and terminal result. The Workspace lineage stores no account slot because a Workspace record is not a safe home for a server-level account identity. A member unavailable at selection also records its kind and reason, including Provider or subscription checks that fail before any Provider call; it is not counted as an attempted Provider call and creates no second CapabilityCall or UsageRecord. Public errors and model discovery redact those identities. The existing Workspace `audit.read` reader may explain primary failure and backup service through the evidence owner's redacted projection, without exposing credentials or raw upstream errors. A public call without Workspace lineage uses its existing Server-owned CapabilityCall for route lineage when Core is available. Without the Core database it keeps [the retention owner's declared blind gap](20260921-work_data_retention_format.md#collection-responsibility) and only request-local selection; no new durable home is introduced. Terminal `cause` is an OpenKit failure kind, never provider-native text or identity. The decision and its reason are recorded in [the route-lineage home decision](../decisions/20261002-gateway_route_lineage_home.md).

### Sealed Reasoning Handoff

When Gateway returns a reasoning item, a new process-local item-to-member association records that item ID and the producing member’s key. The association ceiling is `4096` entries, a current default. The [compaction owner](20260902-agent_runtime_context_compaction.md#missing-invalid-stale-and-restarted-state) owns its payload-free entries, least-recently-used eviction, lifetime, and restart behavior. Forward opaque reasoning payloads, including `encrypted_content` and thinking signatures, unchanged only to the attributed member. Never relabel incoming reasoning as produced by the member about to be called.

For another member or an unattributed item, apply the readable-text handoff: drop signature and ciphertext, preserve non-empty readable reasoning as ordinary assistant text, omit empty or redacted thinking, and omit the paired `fc_` function-call ID. History from before restart, eviction, or an external producer is unattributed. The response gains no field, digest, or member identity. A later Provider rejection remains its classified terminal failure. The decision and restart-loss consequence are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md).

### Reasoning Effort Metadata And Dispatch

Effective model metadata admits models.dev `reasoning_options` entries of shape `{ "type": "toggle" }` or `{ "type": "effort", "values": [...] }` under the existing snapshot → extension → profile precedence. Arrays replace rather than concatenate, and explicit empty arrays remain empty. A toggle contributes `none`; an effort entry contributes only its values in the [canonical reasoning-effort enum](20261021-protocol_identifiers_and_enums.md#canonical-enums), ignoring values outside that enum. The enum's order is the fitting order. No local Provider vocabulary or additional effort enum is introduced.

A reasoning logical model advertises `reasoningEffortLevels`, the intersection of levels derived from its currently available members. Unavailable members contribute no candidate levels. A logical model without reasoning advertises no control; `reasoning: true` without options also advertises an empty level list and uses the Provider default rather than inventing a level. These levels are a resolver projection over effective metadata and current availability, not durable model authority, a routing strategy, or a new catalog. They grant no endpoint, credential, or Tool capability. The intersection decision and its reason are recorded in [the reasoning-effort decision record](../decisions/20261001-reasoning_effort_rulings.md).

The existing metadata owners create, update, remove, and activate options through revision-checked configuration and the pinned snapshot lifecycle. Discovery recomputes advertised levels from the active validated snapshot; rejected or stale edits retain the last-known-good snapshot, and missing options stay unknown rather than inferred. Supply changes can change the current intersection; stale discovery never authorizes a different logical model or mutates an admitted Turn or package. Restart rebuilds this projection from current supply. There is no independent level record, updater, retry, or recovery operation.

Gateway validates a request's effort against the canonical enum before Provider effects, refusing unknown core values through the existing request-error contract. It passes that effort through to the selected member when supported. For a request bound to an admitted Turn, an explicit per-request effort, including a Worker's `reasoning.effort`, takes precedence over that Turn's recorded effort as projected through its immutable AEP and runtime binding, then the Provider default only if both are absent from the request and its recorded Turn. An absent Turn value does not imply an absent native request value: a runtime may carry its conversation's retained selection under [the effort-retention decision](../decisions/20261001-reasoning_effort_retention.md). The recorded effort may originate from the User's submission or the composed Agent default; Gateway does not recompute the current Agent default for that bound request. If the serving member lacks a requested level, use its nearest higher supported level in the canonical order; if it supports no level above the request, use its nearest lower supported level, which is its highest. The decision and its reason are recorded in [the native declaration and upward-fitting decision](../decisions/20261001-reasoning_effort_native_declaration_and_upward_fitting.md). This fitting changes neither authored routing nor the admitted Turn's effort and never selects a different logical model. A non-reasoning model drops the control. A reasoning member without declared options uses its Provider default without inventing an effective enum value. A stock serializer that cannot express a handed disabled control sends no explicit disabled control. The lineage makes no claim about the remote outcome. That external difference is accepted.

The existing private route lineage records requested and effective effort for each attempt, including unchanged and fitted choices. Requested effort records what the native request actually carried, including a retained runtime selection on a Turn with no recorded effort; it is not inferred from that Turn's absence or current Agent defaults. When the control is dropped or the Provider default is used, the effective value remains absent with that reason, not a fabricated level. Provider rejection retains the existing classified failure and commit rules; fitting adds no second retry policy. No effort-specific durable record, compatibility reader, or dual write exists.

Acceptance requires snapshot/extension/profile precedence including empty arrays, toggle contribution, ignored out-of-enum catalog values, intersection over available members, no advertised control without reasoning or options, unknown-request-value refusal, bound-inference precedence of explicit per-request effort, recorded Turn effort, then Provider default only when both are absent, without recomputing current Agent defaults or guessing native request effort from Turn absence, nearest-higher fitting with nearest-lower (highest-supported) fallback when no higher level exists, requested/effective private lineage, recomputation after activation and restart, stale discovery without Turn mutation, and unchanged retained configuration with omitted effort.

### Tier Templates

The closed shipped tier-template ID set is `free`, `flash`, `smart`, and `pro`. These are stable logical IDs remappable by administrators to concrete Provider models, not model or family names and not an allowlist for administrator-authored logical IDs. Repository Agent and internal-role templates prefer these tier IDs, and Gateway templates route them over template Providers. Templates are copy-on-init; existing Data Roots and their authored mappings are unaffected.

Current schema evolution retains the shared `schemaVersion`, `requiredFeatures`, and namespaced descriptive `extensions` mechanisms. The accepted `routing` object adds no required-feature token. Weighted routes, randomized selection, active health state, generalized algorithms, and helper-model behavior remain deferred.

## Provider Profiles And Account Binding

Gateway Provider resolution uses logical route members from `DATA_ROOT/config/gateway.jsonc` and Provider profiles from `DATA_ROOT/config/providers/*.provider.jsonc`. The selected member, profile readiness, endpoint capability, and exact Provider-native `models` list are dispatch authority; model or Provider discovery inside pi-ai is never authority.

`AuthoredProviderProfileSchema` in `packages/config-schema/src/provider.ts` owns the authored V1 profile and its retained `gateway`-to-`llm-gateway` normalization. `ProviderProfileSchema` owns the logical profile without retained-file framing. Endpoint and credential or account binding depend on `kind`. Schema acceptance is not dispatchability. Readiness omitted, `ready`, or `degraded` may run. `blocked`, `disabled`, and `unknown` refuse before credentials. Inline secret-like fields are forbidden. Each model needs effective sourced positive context to become routable under the metadata rule above; missing context warns and leaves that model unavailable.

A profile carries explicit native model supply plus the endpoint and credential or account binding admitted for its kind:

- `direct` and `llm-gateway` may omit `baseUrl` when a known stock adapter supplies the endpoint. Dispatch still requires an explicitly resolved API key. A configured `secretRef` is resolved explicitly. An absent configured requirement makes the route unavailable.
- `local` without `extensions.openkit.localBackend` may omit `baseUrl` when a known adapter supplies one. A synthetic custom adapter needs an endpoint. Keyless use is permitted when `secretRef` is absent. A supplied `secretRef` makes the credential required.
- `local` with `extensions.openkit.localBackend` may omit authored `baseUrl` when the live local supply provides the model endpoint. The bound local supply rejects `secretRef`. The backend set is defined by `LocalBackendIdSchema` in `packages/config-schema/src/provider.ts`.
- `custom` may omit `baseUrl` in the schema. A catalog miss needs an authored endpoint and sourced context. Keyless use is permitted without `secretRef`. The default synthetic API is Chat unless the profile states native Responses. An xAI miss keeps the Chat mapping.
- Recognized `oauth` families `openai-codex` and `xai` forbid `baseUrl` and `secretRef` and require the strict `accountSlotId` extension. Dispatch selects that exact family and slot. It does not guess a default account. Several profiles may select one slot. One profile cannot select several. Conflicting recognized identities reject the profile.
- Other `oauth` families do not receive an automatic subscription binding. The subscription extension is rejected. The general runtime credential predicate follows whether `secretRef` is present. The schema does not manufacture an adapter, a login, or an entitlement.

A subscription-backed profile with an unknown slot, a provider-family mismatch, an unavailable Vault, or a non-resolvable credential fails closed before pi-ai. Non-oauth xAI profiles stay ordinary profiles. Gateway routes and profiles do not accept pasted subscription tokens. Profiles contain no access tokens, refresh tokens, cookies, provider account ids, `auth.json`, authorization headers, or pi-ai credential payloads. The Gateway has no Codex app-server, `CODEX_HOME`, `auth.json`, or dedicated Codex client. No compatibility alias, dual model meaning, direct worker Provider route, default-Provider dispatch branch, or intermediate account selector remains.

The previous `extensions.openkit.codexOAuth.accountSlotId` field is removed in the same release as the generic field. No compatibility alias, default-slot inference, or automatic config rewrite is retained.

Pi-ai vendor-side fallback stays unset. This design adds no Provider-profile field that authors upstream model substitution.

## Decision Request Category

The Gateway MUST admit a third request category, `decision`, for Core gate participants. It carries a structured action and one closed question. Route capabilities MUST expose `decisions: native | bridged | unsupported`. The first native adapter uses OpenAI `POST /v1/decisions`, model `gpt-6-luna`, one `input_json` message and a `choice` question `verdict`: `allow`, `block` or `escalate`. It preserves returned probabilities, confidence or refusal.

Any route with structured output MAY bridge the same question through a strict JSON schema. Missing support, refusal, malformed output, timeout and dependency failure MUST remain explicit and escalate under the calling gate. This is auxiliary model usage, counted as `decision`; the Turn's primary model does not select it. The admitted surface is the private E9 path. Each exact effect and definition text is at most `8192` UTF-8 bytes, and the whole action is at most `128` KiB. Closed reason, failure, and metric shapes distinguish native allow probability from bridge confidence. A preselected mode never changes on failure. The current native classifier is restricted to OpenAI `gpt-6-luna` and no subscription; that restriction is not a guarantee for every bridge. [Runtime Security](20261109-runtime_security.md) E9 owns the operation schema, exact input, restrict-only mapping, cache, budget, and qualification evaluation.

## Provider Endpoint Capabilities

`ProviderGatewayCapabilities` in `apps/nanocore/src/providers/profile-capabilities.ts` defines the per-surface capability matrix (`chatCompletions`, `responses`, and `decisions`).

The matrix remains the routing source of truth for each public format. `native` declares that the selected member's exact upstream API supports the same protocol and can carry that format's admitted native features. `bridged` declares that the public format is served by the bounded stock-IR mappings and public projections below on another upstream API; it no longer declares conversion through another public format. `unsupported` makes the member ineligible for that public surface. Neither `native` nor `bridged` promises every feature in a protocol, and stock catalog discovery or hook availability cannot widen admission. Diagnostic booleans such as `supportsStreaming`, `supportsToolCalls`, and `supportsReasoning` are display hints only.

Every admitted Worker route serves both Chat Completions and Responses requests: natively when the selected upstream API supports the public format, otherwise through the existing stock-IR mapping and public projection. `openai_codex` and the reviewed stock xAI Grok models are Responses-native and Chat Completions-bridged; xAI uses stock pi-ai `openai-responses` with the existing account binding. An explicitly configured uncatalogued xAI model uses the existing Chat synthesis and can serve either public format through the bounded mapping. Neither a catalog miss nor the public API type alone can reject an otherwise representable request. Subscription authentication does not change endpoint capability. Actual unsupported semantic features still fail before Provider access. The [API-type freedom decision](../decisions/20261017-worker_api_type_freedom.md) records the engineer ruling.

Member eligibility requires the declared public format, selected upstream API and actual admitted feature mapping to agree. A selected destination unable to carry a semantic requirement fails with `unsupported_gateway_feature` before Provider access, rather than dropping the feature or traversing another public format. This checks OpenKit's own mapping and native admission; it does not add detection or compensation for accepted external serializer or Provider behavior under [the existing external-behavior decision](../decisions/20261002-external_provider_behavior_accepted.md). Provider transport and mapping stay outside Hono routes. The [convergence decision](../decisions/20261006-gateway_converges_on_pi_ai_ir.md) records the new meaning of the existing capability values.

## Bridge Compatibility

The existing `bridged` capability label describes bounded public-to-stock-IR mapping and direct public output projection, not a public-format conversion chain. The [backend owner](20260708-pi_ai_unified_llm_backend.md#backend-contract) defines stock adaptation, reasoning projections and the request-local native channel. The bounded mapping supports:

- text-only chat messages and Responses input items
- `system` and `developer` instructions
- simple function tools and tool results, including standard top-level or message-anchored `additional_tools` function declarations grouped under one namespace level; the canonical default `functions` namespace is equivalent to an unqualified function name
- `temperature`
- `max_tokens`, `max_completion_tokens`, and `max_output_tokens`
- reasoning-effort mapping under the unchanged fitting and retention contract
- readable assistant `reasoning_content` input and readable non-redacted thinking output under the backend reasoning contract
- simple `tool_choice`
- text-only message streaming and simple function-call identity, index, name and argument-delta projection, with correlated function results in continuation history and truthful terminal and usage semantics
- optional cache-scope input

The bounded mapping rejects the following shapes; a same-protocol native feature requires its separately accepted admission under the backend owner and exact selected-member capability:

- Responses built-in tools
- remote MCP tools
- computer-use tools
- file input and image content outside the explicit native PNG/JPEG mapping above, including all cross-protocol images
- structured content that cannot be reduced to text without semantic loss
- non-function tool schemas, nested namespaces and deferred function declarations on a cross-protocol mapping

The [backend contract](20260708-pi_ai_unified_llm_backend.md#backend-contract) owns mapping mechanics, historical pairs, and native namespace admission. On a cross-protocol mapping, a non-default namespace uses a deterministic stock function identity of ASCII letters, digits, and underscores, at most `64` characters, with an exact request-local reverse mapping. When a namespace is lowered, its description is prepended to each member description. A non-default member description also retains its original qualified name. Mapping collisions, conflicting default-namespace aliases, and undeclared or unmatched history fail before Provider access. The mapping is an ephemeral Gateway projection. It grants no Tool execution authority.

## Cache Scope

`prompt_cache_key` is an optional OpenAI-compatible public request field, not a provider-specific field. The route resolves cache-scope input with this priority:

1. explicit top-level `prompt_cache_key`
2. authorized `metadata.openkit.promptCacheKey`
3. an available server-owned scope derived from logical model ID, selected private route member, Provider profile and native model, the `(subscriptionProviderId, accountSlotId)` pair when subscription-backed, authorized Workspace, server-resolved thread, AgentSession, or session
4. a request-scoped generated fallback

The [backend Prompt Cache Contract](20260708-pi_ai_unified_llm_backend.md#backend-contract) hashes the resolved scope before provider-facing use. Raw identifiers are not exposed. The route authorizes the caller before it derives that scope.

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

## Implementation

- `apps/nanocore/src/llm/`
- `apps/nanocore/src/`
- `packages/config-schema/src/`
- `apps/web/src/pwa/`

## Implementation Gaps

- Public Responses compaction - The route validates context-management metadata and does not inject the control, execute the compactor, or round-trip an OpenKit compaction item. Internal-role compaction is a different path. - #812
- Public Codex Gateway real-use evidence - An opt-in run has not proved one authenticated public Codex request, accepted streaming, a stable public envelope, and redaction. - #814

## Decisions

- [Sandbox Telemetry And Public Gateway Boundary](../decisions/20261015-sandbox_telemetry_and_public_gateway_boundary.md)
- [Gateway Tier Routing Rulings](../decisions/20261001-gateway_tier_routing_rulings.md)
- [Missing API Key Member Unavailable](../decisions/20261002-missing_api_key_member_unavailable.md)
- [Reasoning Effort Rulings](../decisions/20261001-reasoning_effort_rulings.md)
- [Reasoning Effort Retention](../decisions/20261001-reasoning_effort_retention.md)
- [Reasoning Effort Native Declaration And Upward Fitting](../decisions/20261001-reasoning_effort_native_declaration_and_upward_fitting.md)
- [Worker API Type Freedom](../decisions/20261017-worker_api_type_freedom.md)
- [External Provider Behavior Accepted](../decisions/20261002-external_provider_behavior_accepted.md)
- [Gateway Converges On Pi AI IR](../decisions/20261006-gateway_converges_on_pi_ai_ir.md)
- [Historical Tool Pairs And Release Hold](../decisions/20261008-historical_tool_pairs_and_release_hold.md)
