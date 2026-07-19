# LLM Gateway Responses API

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the NanoCore LLM Gateway HTTP surface for OpenAI-compatible Chat Completions and Responses requests, the public endpoint capability vocabulary, optional public cache-scope input, public Gateway error behavior, and Codex subscription-backed Responses routing.

## Does Not Own

This spec does not own non-Codex provider backend selection, routing, or request, response, streaming, usage, cache, and error mapping, which belong to `docs/specs/20260708-pi_ai_unified_llm_backend.md`; the broader Agent Capability model; durable capability and usage records; worker-side capability gateway records; worker-runtime sub-agent provenance; authenticated worker-inference identity binding; runtime cache lineage specialization; provider-account login UX; vault storage; policy evaluation; or `packages/protocol` schemas.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`

## Summary

NanoCore exposes the agent-facing LLM Gateway at the fixed `/v1` boundary through `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/responses`. The gateway keeps route handling thin and delegates provider-specific native calls, bridge conversion, and unsupported-feature decisions to a capability-aware provider dispatcher.

## Current Implementation Projection

NanoCore implements `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/health` as the current OpenAI-compatible Gateway surface.

Public `metadata` and `metadata.openkit` are optional. In server mode, every `/v1/*` route authenticates the actor before route parsing or provider dispatch. A caller-supplied `metadata.openkit.workspaceId` is only a requested scope until active membership and token-binding checks authorize that Workspace; only the authenticated actor plus the authorized Workspace establish trusted persistent ownership. Other caller-supplied lineage may be retained as caller-asserted best-effort labels, but it is not trusted provenance or authority. Requests with no Workspace scope still dispatch and contribute only process-local diagnostics; a supplied unauthorized Workspace fails closed. Local mode keeps the implicit local actor, and the Gateway enabled policy applies to model discovery as well as inference routes.

Gateway admission uses provider-profile readiness and model allowlisting plus the configured provider capability matrix. Non-Codex backend routing and mapping follow `docs/specs/20260708-pi_ai_unified_llm_backend.md`. Every dispatched call may contribute process-local diagnostics, while only calls with an authenticated actor and authorized Workspace may produce durable capability usage through `docs/specs/20260704-capability_usage_gateway_foundation.md`.

Gateway usage observation is diagnostic input and, only for authorized Workspace-scoped calls, durable usage producer input. It is not the full billing model; broader metering policy still belongs to Agent Capability, Metering, and Audit specs.

Codex OAuth provider profiles must declare an explicit `extensions.openkit.codexOAuth.accountSlotId`.
Missing account-slot bindings fail closed and do not silently resolve to a `default` slot.

The historical `/internal/v1/chat/completions` facade is superseded by this Gateway direction and by the worker-facing capability projection in `docs/specs/20260703-worker_agent_capability.md`.
It must not become a new extension point for model listing, Responses, tools, metering, audit, or worker-capability behavior.
If this legacy route is touched, prefer removal or folding into the Gateway over preserving a parallel internal facade.

## Goals

- Keep the existing `/v1/chat/completions` endpoint stable for OpenAI SDK-compatible agents.
- Add `/v1/responses` as a first-class endpoint instead of forcing Responses clients through a chat-only route.
- Model provider support separately for Chat Completions and Responses with `native`, `bridged`, or `unsupported` capability values.
- Support `openai_codex` as a ChatGPT subscription-backed Responses-native provider.
- Accept optional public cache-scope input; the dedicated Codex path sends the resolved `prompt_cache_key`, while non-Codex mapping follows S42 and does not promise a provider wire field or cache hit.
- Preserve provider-reported cache-read and cache-write usage so Gateway diagnostics can report cache effectiveness without inferring it from cache-scope input.
- Keep token material out of app APIs, diagnostics, logs, and UI state.
- Keep Codex subscription account storage aligned with the existing `DATA_ROOT` server, user, and workspace ownership boundaries.
- Preserve `/v1/models` and `/health`.
- Fail closed before model discovery, body parsing, provider credential resolution, or dispatch when server-mode actor authentication fails or a supplied Workspace scope is unauthorized; absence of public metadata or Workspace scope is not an error.

## Non-Goals

- Do not add a Bifrost-style `/openai/*` alias in this slice.
- Do not move Gateway capability metadata into `packages/protocol`; this is a provider capability-plane concern, not the UI-to-Core workflow protocol.
- Do not attempt lossless bridging for Responses built-in tools, remote MCP, computer use, file input, image input, or other advanced input modalities.
- Do not expose ChatGPT access tokens or account IDs through public app APIs.
- Do not store Codex homes, `auth.json`, or other credential-bearing account state under `DATA_ROOT/config`.
- Do not expose or implement `POST /v1/completions`.
- Do not extend the historical `/internal/v1/chat/completions` facade; that spec is superseded and retained only under `docs/specs/superseded/20260517-openai_compat_facade.md`.

## External API

`POST /v1/chat/completions` accepts OpenAI-compatible Chat Completions requests. It supports `system`, `developer`, `user`, `assistant`, and `tool` roles and passes unknown OpenAI-compatible fields through to the provider dispatcher.

`POST /v1/responses` accepts OpenAI-compatible Responses requests with `model`, `input`, optional `stream`, and passthrough fields. It returns native Responses payloads when the provider supports Responses directly, or a converted Responses payload when the provider is chat-native and the request is bridgeable.

`prompt_cache_key` is an optional OpenAI-compatible public request field, not a Codex-only field. Gateway routes accept it as cache-scope input and preserve generic passthrough fields. The dedicated Codex path sends the resolved `prompt_cache_key`; non-Codex mapping is owned by S42 and does not promise a provider wire field or cache hit. Cache effectiveness exists only when the provider reports cache-read or cache-write usage.

Both endpoints use OpenAI-compatible error envelopes for Gateway policy failures, missing defaults, disallowed providers, provider failures, and unsupported bridge features.

`POST /v1/completions` is intentionally outside the Gateway surface. NanoCore supports the modern Chat Completions and Responses entry points used by agent clients.

`GET /v1/models` returns only models explicitly listed by Gateway-allowlisted, dispatchable provider profiles while the Gateway is enabled. A profile is dispatchable when readiness is omitted or is `ready` or `degraded`; `blocked`, `disabled`, and `unknown` profiles are excluded. The pi-ai registry and adapter catalogs never add models to this response. Server-mode authentication is required even though the response is OpenAI-compatible, because model supply and the sibling inference routes are deployment-owned capabilities.

## Provider Capabilities

Provider metadata includes:

```ts
{
  chatCompletions: "native" | "bridged" | "unsupported",
  responses: "native" | "bridged" | "unsupported"
}
```

`openai_codex` is Responses native and Chat Completions bridged. `docs/specs/20260708-pi_ai_unified_llm_backend.md` solely owns non-Codex backend selection and the mapping from configured endpoint capabilities to pi-ai routes.

Diagnostic booleans such as `supportsStreaming`, `supportsToolCalls`, and `supportsReasoning` remain secondary display hints while the explicit endpoint capability matrix becomes the routing source of truth.

## Routing Boundary

The route layer parses JSON, enforces Gateway policy, resolves the configured default provider, and returns normalized public errors. The dedicated Codex Responses adapter remains the subscription-backed exception. `docs/specs/20260708-pi_ai_unified_llm_backend.md` is the sole owner of every non-Codex backend selection and request, response, streaming, usage, cache, and provider-error mapping. Conversion stays outside Hono routes, and a bridge that cannot preserve the public contract fails with `unsupported_gateway_feature`.

Gateway provider resolution uses the runtime provider registry loaded from `DATA_ROOT/config/server.jsonc` and `DATA_ROOT/config/providers/*.provider.jsonc`. The selected profile's readiness and explicit `models` list are dispatch authority: omitted readiness plus `ready` and `degraded` are runnable, while `blocked`, `disabled`, and `unknown` fail closed before credential resolution; every request model must exactly match one configured `models` entry before any adapter call. Neither pi-ai discovery nor provider-native catalogs authorize an undeclared model. `openai_codex` provider instances are selected by `vendor: "openai_codex"` or the built-in `openai_codex` provider id. They must bind to a server-owned Codex OAuth account slot through `extensions.openkit.codexOAuth.accountSlotId`; when the extension is omitted, Gateway routing fails closed instead of guessing a `default` slot.

Public JSON and post-start SSE provider failures expose only stable OpenKit codes and generic messages. Authentication, rate-limit, context-overflow, invalid-request, provider-unavailable, and unclassified provider failures use their existing Gateway code classes with fixed OpenKit messages; upstream message text, provider codes and types, response bodies, adapter vocabulary, and stack traces are never copied into public payloads. Streaming failures still terminate with `stopReason: "error"` and `[DONE]`.

Cache-scope input uses this priority order:

- explicit top-level `prompt_cache_key`
- `metadata.openkit.promptCacheKey`
- an available server-owned OpenKit scope built from non-secret stable fields such as provider id, model, account slot id, authorized workspace id, thread id, agent session id, or session id
- a request-scoped generated fallback key

Any generated cache-scope value must not expose raw workspace, thread, account slot, or session identifiers. Public metadata remains optional advisory input and cannot establish persistent ownership or trusted lineage, though caller-supplied lineage may be retained as best-effort labels. The request-scoped fallback guarantees cache-scope input. The dedicated Codex path sends the resolved `prompt_cache_key`; non-Codex provider mapping is owned by S42. Cache effectiveness is determined only from provider-reported cache-read and cache-write usage.

## Bridge Compatibility

The v1 bridge supports:

- text-only chat messages and Responses input items
- `system` and `developer` instructions
- simple function tools
- `temperature`
- `max_tokens`, `max_completion_tokens`, and `max_output_tokens`
- `prompt_cache_key` as optional cache-scope input
- reasoning effort mapping
- simple `tool_choice`
- text-only streaming delta conversion

The v1 bridge rejects:

- Responses built-in tools
- remote MCP tools
- computer-use tools
- file and image input
- structured content that cannot be reduced to text
- non-function tool schemas

## OpenAI Codex Provider

`openai_codex` is a Responses-only provider family. One deployment may configure multiple provider instances that all use the `openai_codex` provider spec but point at different server-owned account slots. Provider routing must use provider instance ids, not the vendor name alone, so multiple ChatGPT subscription accounts do not create ambiguity.

Each provider instance must reference one non-secret account slot. The authored provider config belongs under `DATA_ROOT/config/providers/*.provider.jsonc` and should contain routing fields such as provider id, vendor, kind, display name, default model, and account slot reference. It must not contain bearer tokens, refresh tokens, ChatGPT account ids, `auth.json` contents, or authorization headers.

Server-owned Codex subscription account slots belong under `DATA_ROOT/server/files`:

```text
DATA_ROOT/server/files/oauth/openai-codex/accounts/<account-slot-id>/
  account.json
  codex-home/
    auth.json
```

`account.json` is sanitized account metadata for diagnostics and provider binding. `codex-home/` is the isolated `CODEX_HOME` used when NanoCore starts Codex app-server for that account slot. The Codex-managed credential material remains inside Codex-managed auth storage for that isolated home. On platforms where Codex writes `auth.json`, it lives under the slot's `codex-home/`; on macOS, Codex may use Keychain first, but the isolated Codex home still scopes the Keychain account name.

Future user-owned Codex subscription accounts should use the user-owned data tree instead of `server/files`:

```text
DATA_ROOT/users/<user-id>/data/oauth/openai-codex/accounts/<account-slot-id>/
  account.json
  codex-home/
    auth.json
```

Those future user-owned accounts must be selected through an explicit user or vault reference policy before the Gateway may use them. Workspace config may reference allowed providers or secret references, but it must not contain raw Codex credentials.

At inference time, the Codex provider client calls:

```text
https://chatgpt.com/backend-api/codex/responses
```

The request includes:

- `Authorization: Bearer <token>`
- `chatgpt-account-id`
- `OpenAI-Beta: responses=experimental`
- `originator: openkit`

NanoCore does not ask the user to paste a token. The internal token resolver first asks the account-slot-specific Codex app-server to refresh account state with `account/read { "refreshToken": true }`, then reads Codex-managed local auth storage for that slot. On macOS it tries Keychain service `Codex Auth`; file fallback reads `auth.json` under the isolated Codex home for the account slot.

When the user request omits `store`, `openai_codex` sets `store: false` by default. Ordinary OpenAI API providers do not override user request fields.

`openai_codex` does not define a private prompt-cache policy. It uses the Gateway resolver and sends the resolved `prompt_cache_key` to the dedicated ChatGPT Codex backend. This implemented wire mapping does not guarantee a cache hit; only provider-reported cache-read and cache-write usage establishes cache effectiveness.

## Diagnostics

Deployment-admin `GET /api/app/diagnostics` reports:

- Gateway endpoints: `/health`, `/v1/models`, `/v1/chat/completions`, `/v1/responses`
- provider capability chips such as `chat native`, `responses native`, and `responses bridged`
- process-local Gateway usage summaries with request count, input tokens, output tokens, total tokens, provider-reported cache-read and cache-write quantities when supplied, and latest observation time
- sanitized `openai_codex` account state only

Diagnostics never include bearer tokens, refresh tokens, account IDs, authorization headers, or raw `prompt_cache_key` values.

## Implementation Evidence

NanoCore implements the accepted Gateway surface through `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/health`, with no `/v1/completions` or historical `/internal/v1/chat/completions` route. Server-mode `/v1/*` requests authenticate before route work, disabled Gateway policy hides model supply as well as blocking inference, and a requested Workspace is authorized before durable ownership is established. Public OpenKit metadata remains optional and advisory; caller lineage may persist as best-effort labels, while requests with no Workspace scope still dispatch and remain process-local-only and a supplied unauthorized Workspace fails closed. The S42-owned dispatcher routes every non-Codex-OAuth provider through pi-ai, while Codex OAuth stays on the dedicated subscription Responses client and sends the resolved `prompt_cache_key`. Non-Codex cache input does not prove provider wire fidelity or a hit, and cache effectiveness for every path comes only from provider-reported cache-read and cache-write usage. Route, auth, dispatcher, provider-registry, prompt-cache, pi-ai client, Codex Responses client, diagnostics, and capability usage tests cover the implemented behavior. `apps/nanocore/src/llm-gateway.test.ts` guards the public route surface and asserts that the superseded internal facade remains absent.

## Verification

- `mise exec -- pnpm --filter @openkit/nanocore test`
- `mise exec -- pnpm --filter @openkit/nanocore typecheck`
- `mise exec -- pnpm --filter @openkit/nanocore lint`
- `mise exec -- pnpm --filter @openkit/nanocore build`
- `mise exec -- pnpm --filter @openkit/core-client test typecheck build`
- `mise exec -- pnpm --filter @openkit/web test typecheck lint build`

Real Codex or real subscription verification must stay skip-aware and explicitly gated so default release gates do not consume user subscription quota.

Worker-specific trusted identity and cache-lineage behavior is owned by `docs/specs/20260711-worker_runtime_subagent_provenance.md`. Public metadata remains optional hints and never becomes worker or persistent ownership authority under this spec.
