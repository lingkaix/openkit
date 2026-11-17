---
status: Accepted
implementation: Partial
kind: boundary
aspect: mediation
---
# Pi AI Unified LLM Backend

This document owns NanoCore provider transport and mapping through one stock pi-ai client. It also owns the stock-release, isolation, and catalog rules for that client.

## Scope

**Owns.** One production transport and mapping owner, `PiAiGatewayClient`, serves hosted, subscription, gateway, local, and custom routes. The mapping stays one cohesive client plus small API-specific functions. There is no parallel transport, client hierarchy, or plugin subsystem.

**Does not own.**

- Public HTTP, routing, and caller authorization belong to [LLM Gateway Responses API](20260526-llm_gateway_responses_api.md).
- Account slots, login, refresh persistence, logout, and quota belong to [Provider Subscription Accounts](20260721-provider_subscription_accounts.md).
- Durable usage belongs to [Audit, Usage, And Evidence Records](20260703-audit_usage_evidence_records.md).
- This document does not select accounts, run a cache platform, or keep a general cache registry.
- Worker capability semantics and a caller's right to use a provider stay with their owners.

**Core.** [Mediation](../core/mediation.md), [Evidence](../core/evidence.md), [Vault](../core/vault.md), and [Work Model](../core/work-model.md).

## Parties

Gateway owns HTTP, route and model selection, and caller authorization. The subscription-account owner owns slots, login, refresh persistence, logout, quota, and Vault persistence. Evidence owns durable usage, and configuration owns authored intent. This backend and its stock pi-ai adoption add no account selector, failover, authorization, billing authority, or cache platform.

Provider Adoption Rules in this document own the exact stock release, isolation, and catalog review.

OpenKit owns validation, admission, attribution, and effort fitting. Stock pi-ai owns upstream serialization, reasoning, signatures, replay, and transport. Provider exceptions stay inside the Gateway.

The name `vault.bootstrap-codex-auth` stays a human harness Login. [Vault And Secret Injection](20260703-vault_secret_injection.md#harness-subscription-logins) owns that acquisition. It is not Gateway or account credential authority.

Upstream support or discovery does not prove subscription authorization, entitlement, or an unlimited plan. The account owner decides authorized activation.

## Backend Contract

Production dispatch has no `codex-oauth` discriminator, no dedicated Codex Responses client, no app-server refresh, and no handwritten general OpenAI transport. There is no alias and no second live path.

Cache optimization stays above the adapter. The adapter does not promise a provider cache hit and does not create cache authority; there is no custom cache engine and no raw or global cache identity.

An E9 decision call uses the documented classifier extension inside this same client. It does not open a parallel transport.

Accepted OpenAI, Codex, Anthropic, Google, OpenRouter, xAI, and custom routes use stock family adapters. xAI does not select a second backend.

A custom catalog miss uses the configured stock provider. The default API is Chat-compatible. Native Responses is used only when the profile states that capability. The client does not guess from a URL or a model name.

Each public Chat Completions or Responses request maps once into stock Context and options. Each result maps once back into that public format, including streaming and final output. There is no Chat-to-Responses or Responses-to-Chat detour.

Profile, readiness, the exact authored model, authentication, and shape admission finish before any credential or provider access. There is no hidden backend branch. Omitted, `ready`, and `degraded` readiness may run. `blocked`, `disabled`, and `unknown` refuse before credentials.

A hosted adapter requires an explicit resolved credential. `env={}` blocks ambient pi lookup. An explicitly authored environment reference may resolve through the injected resolver. That path is not ambient scanning. A subscription account uses its explicit pair, and that credential stays in Vault. Ordinary provider API keys are not universally Vault-only.

When an admitted feature cannot be preserved, the client returns a bounded explicit refusal before the Provider. It does not drop the feature or imply native support.

Resolution inputs are the profile, the model, and the authorized actor. The client then resolves an optional family-and-slot pair and one stock invocation. Family, capability, endpoint, models, and the explicit binding are enough. There is no backend discriminator.

Direct mappings preserve messages, roles, Tool definitions, sampling, reasoning, stream order, and usage.

`native`, `bridged`, and `unsupported` are OpenKit endpoint capabilities. Admission uses the exact selected API plus that capability, not the provider-family name. Native Codex is required where the route is native. The matrix is read only after profile authorization. It never enables a family, an endpoint, or a credential.

Every new Chat call requires this request's declared complete callable identity and valid arguments, in the final result and in the stream. Historical context never expands the callable set.

The client collects incomplete fragments and does not publish an executable success before the identity is complete. A malformed, undeclared, conflicting, or unknown call ends with zero Tool execution. There is no repair, retry, or fallback. A completion-only identity uses the same validation.

Chat `reasoning_content` maps to stock thinking and to non-redacted readable output and deltas. Terminal text is reconciled without duplication. Opaque or redacted thinking is omitted.

Responses thinking and signature reuse require process-local exact producer-member attribution. API, model, or account similarity is not enough. A signature is not an arbitrary extension carrier.

Only an OpenKit Worker or internal inference call may default an omitted `reasoning.summary` to `auto`, and only on a reasoning model and API whose stock adapter supports `reasoningSummary`. An explicit summary and an ordinary public request stay unchanged.

One attempt-local OpenKit native envelope carries only missing admitted features of the same protocol. It does not extend stock IR, add a variant, fork the package, or become a durable carrier.

The client applies documented `onPayload` after stock assembly. It uses read-only `onProviderStreamEvent` only for missing output. Stock blocks take precedence. Item order, usage, and the terminal outcome stay intact and are not duplicated.

The native seam preserves stock authentication, cache handling, and transport. It cannot add execution or authorization for hosted tools, remote MCP, computer use, or a new modality. The admitted image subset is inline PNG and JPEG in user content and in image-bearing function results, with optional detail `auto`, `low`, or `high`, on a native path whose effective input includes images. That subset adds no URL fetch and no transcode.

The catalog is an optional inventory, not an ID allowlist. Exact authored native IDs are admitted. Context must be sourced. The synthetic maximum output on a custom or unknown accepted subscription model is the current default `32000`. It is not a physical limit. A synthetic cost of `0` is not proof of free pricing.

The synthetic custom path keeps the ordinary credential, capability, and error owners. A catalog miss and a synthetic model grant no authority.

Effective reasoning, input modalities, `contextWindow`, and `maxTokens` apply to stock, custom, and subscription paths through a request-local clone. The shared catalog model is never mutated.

`cache_read` and `cache_write` from models.dev become stock `cacheRead` and `cacheWrite` only at this boundary. The client reuses the stock calculator and the existing Usage producer. There is no second pricing engine and no second ledger.

Authored leaves override effective catalog rates. Only the selected real stock or pair model may supply a missing financial rate. A custom miss has none. An optional price cannot block a valid inference.

A USD estimate is published only when all four rates are known and finite and the stock calculator returns a finite amount. Otherwise the amount is omitted and usage is kept. An explicit `0` means free. Defaults cannot invent a partial or free estimate. An estimate is not an invoice.

An authored per-rate leaf overrides every cloned stock tier, independent of request length. An inherited catalog flat rate and a default empty object are not authored leaves. Thresholds, omitted leaves, and stock cache-write semantics stay.

Model discovery and dispatch share the admitted profile and capability predicate. The adapter catalog is not runtime enablement.

Hosted keys are explicit. The non-secret placeholder `openkit-keyless` is used only for an explicitly keyless local or private adapter that needs `apiKey`. It is never stored as a credential, an identity, or authority.

The client resolves the exact provider family and slot before it builds that pair's model view, and it rejects a mismatch. Concurrent accounts keep independent credentials and locks. There is no global active-account switch.

Only a recognized normalized family on `kind: oauth`, plus a strict `accountSlotId` extension, selects a subscription. That profile forbids `secretRef` and `baseUrl`. An ordinary xAI direct, gateway, or custom profile stays ordinary.

Codex turn state is an opaque caller-held header. It is forwarded and returned only for the same provider, model, slot, and cache context, and only on a successful `2xx` response. The client does not parse, log, or persist it. An error, a redirect, or another slot must not replace it.

Native admission accepts top-level local `function` and `custom` tools, one namespace level with local children, and the exact top-level client `tool_search` with a nonempty description and object parameters. Provider-executed, nested, and unknown tools are rejected before credentials.

`defer_loading` is only `true` or omitted on a local function or custom tool. `false`, `null`, a malformed value, or a duplicate canonical callable key is rejected.

An optional additional-tools id must use the `at_` prefix and a canonical lowercase UUIDv5 or UUIDv7 with the RFC variant. A missing id is allowed. `null`, a bad prefix, a bad version, or a bad case is rejected. The client preserves only the request prefix. The id has no Core, credential, timestamp, or durable meaning.

Stock representation comes first. Native data carries only missing semantics. Callable kind and namespace stay distinct even when bare names match. A bare-name lookup cannot replace the admitted identity.

A native message phase is only `commentary` or `final_answer`. Nullable native reasoning `content` and `encrypted_content` stay only with exact producer attribution. Otherwise the readable handoff applies.

Client-search call/result lineage and validated discovered local definitions survive continuation. Discovered definitions activate immediately after their matching result, consuming deferred markers. Repeated declarations retain the same callable kind and definition; conflicts fail. Discovered and active declarations stay request-local and confer no Tool execution authority. Stock-parser acceptance covers native search-call reconstruction, next-request discovered-tool activation, a subsequent discovered namespaced function/custom call, and distinct function/custom history sharing a bare name.

An absent namespace, an empty namespace, and the `functions` namespace are equivalent. A streamed namespace may arrive only with the completed item. The client validates the completed identity and does not refuse early.

A public client `tool_search_call` keeps `execution=client`, object arguments, and its IDs. Function and custom kind, name, namespace, input, and history output are preserved through the stock or native projection. That projection adds no second authority.

New output must match the current declarations or a valid client-search discovery. An unknown, malformed, or new historical-only call is terminal, in the stream and in the final result, with zero Tool execution. History is not repaired into a success.

The xAI native API lowers an accepted custom or namespaced tool to a function tool under [Bridge Compatibility](20260526-llm_gateway_responses_api.md#bridge-compatibility). Custom input is a required string `input`. The inverse mapping keeps kind, namespace, call, and history. Client-search continuation and activation use the stock parser. An unknown native shape is unsupported.

Codex uses forced SSE because the stock WebSocket path has no response-header hook. There is no second HTTP client and no WebSocket client.

One `PromptCacheKeyResolver` admits the configured provider and model, an optional family and slot, and an authorized Workspace, thread, AgentSession, session, and hint. A trusted Worker identity also includes `runtimeFamily` and `nativeCacheLineageId`. A missing lineage uses per-request random isolation and sets `degraded` true. The resolver normalizes and hashes those inputs with the canonical form in [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#ids) before the Provider. Pairs stay partitioned. Raw scopes are not sent. Native lineage is not stored as authority. The product-safe lineage reference is a separate domain from the provider key.

Worker and internal attribution comes only from Server-owned records. Public metadata is advisory. A supplied Workspace is authorized before use. An authorized call without Workspace scope uses the existing Server-owned call and usage accounting when Core exists. Otherwise it uses process-local diagnostics.

Where stock supports them, the hash maps to `sessionId` and `cacheRetention`. The Provider may ignore either field. The client invents no header and promises no hit.

Opaque turn-state continuity is not the hashed cache scope. Reuse requires a matching scope. A diagnostic must not treat the hashed value as the turn state.

Cache effectiveness uses only Provider-reported read and write quantities. A missing quantity means unknown. Latency and matching prompts do not prove a miss or a hit.

Input, output, total, cache, and cost are mapped only when they are present. Missing evidence stays absent. The client does not invent Provider usage.

Two overlapping subscription slots use this one backend. Their credentials do not cross. Deterministic isolation exists. This sentence does not claim a fresh external run.

Invalid history, declaration, and search pairs fail before the Provider. Stock-generated historical-only or unknown new output fails in the stream and in the final result with zero execution. A completed-only namespace identity is allowed. A valid declared call does not cross namespaces.

The same stock result preserves readable thinking, text, admitted tool identities, usage, and terminal meaning in each requested public format, with and without tools, streamed and not streamed. Ciphertext does not leak. Indexed output is not duplicated. Retained record meaning stays unchanged.

## Provider Adoption Rules

Stock native provider behavior includes the originator `pi`. OpenKit does not fork pi-ai and does not spoof an OpenKit originator.

One exact stock `@earendil-works/pi-ai` dependency supplies adapter and authentication integration. The boundary is private and replaceable. There is no second public provider framework.

One reviewed exact semver is current at a time. The current pin is `0.99.2`, with its lockfile integrity; the reconciliation validator and repository root check enforce that pin and catalog alignment, while Worker adapter pins belong to their separate adapter owners. Floating `latest`, `^`, `~`, overrides, patches, and alternate sources are forbidden. Historical pins `0.80.3`, `0.80.10`, and `0.84.2` are not current requirements.

The selected release supports programmatic provider login, device-code cancellation, refresh, logout, discovery, and an injected custom `CredentialStore`. OpenKit does not reimplement OAuth and does not delegate state to default files.

Pi-ai type names, events, provider API names, options, login callbacks, credentials, and error vocabulary do not cross Protocol, App API, Gateway, configuration, UI, CLI, or MCP. Authored vocabulary stays provider-neutral. The public contract stays replaceable.

Every upgrade carries a deliberate review and focused authentication, native-stream, usage, cache, turn-state, and redaction checks. A package bump alone is not that review.

models.dev is an optional shared metadata inventory. It is a read-only metadata inventory. It is not a provider or model allowlist, and it does not enable adapter discovery. Overlapping exact provider, model, and price rows are compared at update time.

OpenKit does not fork, vendor, patch, or monkey-patch pi-ai. Stock IR gains no extra fields and no new variants. One cohesive client and small API mappings remain. There is no inheritance tree, plugin subsystem, or replacement transport.

There is no default auth file or path, no shell or CLI credential command, no process-global active account, no ambient discovery, and no copy, symlink, or swap of auth state. Multi-account selection MUST NOT mutate a global pi-ai credential store, change process environment, synthesize provider ids, or rely on asynchronous request-local globals. A secret-resolving registry is not authority. An explicitly authored resolver, stated in the credential rule above, is a separate path.

Missing admitted native fields use only documented `onPayload` and read-only `onProviderStreamEvent` on the attempt-local OpenKit envelope. There is no upstream or private patch and no new authority.

If the stock public seam cannot represent an exact accepted feature, the result is a bounded refusal, a deferral, an upstream request, or a new decision. The stock IR is not widened or modified in silence.

A release must support native Codex Responses, session, and metadata, the xAI login and inference seam, refresh, a custom store, and cancellation. Catalog or API discovery alone is not enough.

An explicit credential store and provider configuration exist before login or inference. The default stock credential owner is not activated.

Focused checks protect native headers, hooks, stream and terminal usage, errors, cancellation, login, logout, refresh, the custom store, cache, hash, turn state, and redaction on the exact release. Deterministic suites exist. This sentence does not claim a fresh run.

A private adapter identifier may appear only in a private test or a redacted diagnostic. It never appears in user-authored configuration or in public transport or error vocabulary.

An upgrade record names the exact selected version and its integrity.

An upgrade record reviews the release notes and breaking API or behavior changes. Code cannot prove that a human review occurred. This is an ongoing release obligation, not a runtime schema and not a permanent checklist store.

The review covers authentication `Models` and discovery, `CredentialStore`, refresh, logout, and cancellation.

The review covers native Responses, stream metadata hooks, headers, usage, cancellation, and error mappings.

The review covers xAI subscription and Grok login and inference separately from entitlement and from a credential-backed acceptance claim.

The review covers Codex login, refresh, native transport, session continuity, and private wire behavior.

The review covers models.dev overlap and catalog reconciliation for the selected release.

The review confirms that no public pi-ai vocabulary and no ambient credential path returned.

The current pin is not frozen to a stale historical floor. The exact release lives in the package and in the completed change, not in a contradictory narrative.

Vendored catalog data is read-only at runtime. Boot does not refresh it. Dynamic catalog behavior is disabled or bounded by the explicit profile owner. It is never an ambient enablement path.

The runtime is an isolated adapter with an injected store. OpenKit never creates the default file credential owner and then copies, links, or swaps its material.

The store supports provider-scoped read, write, remove, and serialized modify. The view is limited to the exact family and slot. OpenKit Vault remains the subscription persistence owner.

Login uses programmatic seams, safe callbacks, and redacted stable failures. There is no scripted pi CLI. An unsupported login flow stays unavailable. It does not invent a browser callback.

A new adapter-inventory entry does not become a configured or enabled provider without an explicit authored profile and model.

Common provider and model IDs must match exactly. ID mismatch tolerance is `0`. Each available input, output, and cache token price class is compared.

The current reconciliation default is a `5%` relative price tolerance per class. A wider gap blocks the upgrade unless an acknowledgement names the exact release, provider, model, class, and both prices. A missing, stale, duplicate, or unobserved acknowledgement is rejected.

Inside that tolerance, product cost stays models.dev-based. The stock adapter calculator uses the selected request metadata.

L0 checks the exact pin, integrity, the absence of a patch, catalog drift, and the public-vocabulary boundary.

L1 checks injected-store pair isolation, refresh, cancellation, secret-safe callbacks, and zero ambient credential fallback.

Native Responses, xAI, stream metadata hooks, and private wire behavior are checked through stock seams, not through a second homemade transport.

L2 checks that no pi-ai vocabulary leaks across Gateway, the account App API, Core Client, Web, CLI, or MCP. Shared shapes stay provider-neutral.

## Errors And Failover

The Gateway alone selects the ordered member, retries, failover, and handoff. This backend receives one selected attempt. Stock retry options and vendor fallback stay unset. The account manager cannot fail over.

Public errors and diagnostics contain no credentials, raw scope or slot identifiers, prompts, Tool arguments, or upstream or raw pi error objects. Projections use stable OpenKit errors.

Absent capability, incompatible protocols, an unknown required native field, or a conflicting native and semantic representation yield `unsupported_gateway_feature` before the Provider.

Stock refresh uses the store owned by the account specification. There is no app-server, home-auth, or second refresh path. A failure belongs to the selected member. An account observation is neither a login nor route authority.

The same classifier receives thrown and terminal pi events before generic wrapping. The kind comes from the Gateway closed set, using exposed HTTP status, code, and retry guidance, the stock overflow predicate, and bounded quota patterns. The client does not invent an HTTP status. An unknown case stays terminal.

An ordinary max-output stop or a usable refusal is a normal completion. A reject or error terminal is classified apart from that completion. Lexical transient wording alone is not proof of a safe replay.

A failure is local to the selected attempt. It is not routing, account, or durable state. It carries the original affirmative settled evidence downstream. There is no second retry engine. A generic wrapper must not discard that evidence.

Public JSON and SSE errors use stable generic OpenKit messages and codes and the closed Gateway kind. Adapter and private errors do not leak.

Cancellation reaches the active stock request. An uncertain effect that may have started forbids automatic retry and failover, even when no output is visible.

Bounded probes cover thrown and event forms of quota, rate, overflow, unsupported, and cancellation. They fabricate no structure and no status. The first lifecycle event alone does not start retries. Ordinary length and readable reasoning remain normal completions.

A failure-value handoff crosses the real downstream classifier and executor boundary. A generic `Error` wrapper is not that proof. Existing suites exercise those paths. This sentence does not claim a fresh run.

## Compatibility

Public HTTP routes, models, request controls, SSE lifecycle, usage, and error vocabulary stay as the Gateway defines them. Backend convergence does not redefine Gateway or Worker authority.

Cross-format, cross-member, and unattributed history yield readable assistant text only. Ciphertext, signatures, and the paired `fc_` id are dropped. Empty or redacted thinking is omitted. Restart cannot forge attribution.

Each retry or member rebuilds the attempt-local envelope. There is no replay after commit or after an uncertain effect. Restart retains no envelope. Stale opaque attribution uses the readable handoff.

Durable retained records stay OpenKit schemas. They are not stock IR and not the native envelope. This contract adds no historical-pair lifecycle and does not reinterpret a retained format.

An undeclared complete historical local function or custom pair is admitted only on native same-protocol traffic, including when the current declaration set is absent, empty, or unrelated. History does not create callability. Admission does not depend on a compaction hint.

That historical exception excludes search, provider-executed, and unsupported tools. Each nonempty `call_id` has exactly one matching later result. Kind, name, namespace, and native syntax match. A supplied status is `completed`. A duplicate, orphan, reversed, or malformed history fails before the Provider.

History grants no current declaration, no deferred activation, and no new-output authority. If a declaration is present, the kind must match. An absent declaration does not invent an argument schema beyond native syntax.

After the exact dependency, catalog, and boundary gates pass, the account, provider, authentication, inference, and public Gateway cutover lands in one release that removes the legacy path; no temporary public dual route, dual implementation, or legacy client remains as a live fallback.

NanoCore bootstrap and dispatch do not depend on an account or Gateway app-server, on home auth, or on an ambient credential.

A retained request body is replayed through the real dispatcher and client for native historical pairs. The captured stock payload keeps IDs, order, kind, namespace, and arguments. Current callables may be zero. Summaries are not rewritten.

Stock IR belongs only to in-flight calls. Retained OpenKit schemas own persistence. A stock thinking signature is not an extension bag.

Replacing the adapter must not change a public API or configuration contract so that it matches pi implementation vocabulary.

The old account and Responses source is physically removed. No live compatibility backend branch remains.

## Implementation

- `apps/nanocore/src/llm/`
- `apps/nanocore/src/providers/`
- `packages/config-schema/src/`
- `packages/models-dev-catalog/`
- `apps/nanocore/`

## Implementation Gaps

- Codex real-use acceptance - An owner-governed opt-in run has not proved the exact release, injected store, native Responses and streaming, safely exercisable refresh, absence of ambient fallback, cache inputs, and reported cache usage when supplied; no cache hit is required. Dependency import, deterministic tests, and upgrade review do not replace this proof. - #814
- xAI credential-backed real-use - Deterministic support does not establish entitlement or a completed acceptance run. Activation stays with the account owner. - #347

## Decisions

- [Gateway Converges On Pi AI IR](../decisions/20261006-gateway_converges_on_pi_ai_ir.md)
- [Historical Tool Pairs And Release Hold](../decisions/20261008-historical_tool_pairs_and_release_hold.md)
- [Worker Failure, Final, And Chat Call Rulings](../decisions/20261015-worker_failure_final_and_chat_call_rulings.md)
- [Gateway Tier Routing Rulings](../decisions/20261001-gateway_tier_routing_rulings.md)
