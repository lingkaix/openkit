# LLM Gateway Responses API

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the NanoCore LLM Gateway HTTP surface for OpenAI-compatible Chat Completions and Responses requests, provider endpoint capability routing, prompt-cache key propagation, gateway error behavior, and Codex subscription-backed Responses routing.

## Does Not Own

This spec does not own the broader Agent Capability model, worker-side capability gateway records, worker-runtime sub-agent provenance, authenticated worker-inference identity binding, runtime cache lineage specialization, provider-account login UX, vault storage, usage metering ledgers, policy evaluation, or `packages/protocol` schemas.

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

In server mode, every `/v1/*` route uses the same authenticated actor middleware as product APIs before route parsing or provider dispatch. A request that names `metadata.openkit.workspaceId` must pass active membership and token binding checks for that workspace. Local mode keeps the implicit local actor. The Gateway enabled policy applies to model discovery as well as inference routes.

Gateway provider dispatch uses the provider registry capability matrix, prompt-cache key resolution, OpenAI-compatible error envelopes, streaming terminal error normalization, durable capability usage records, and process-local usage observation for diagnostics.

Gateway usage observation is both diagnostic input and the first durable usage producer for public LLM Gateway calls.
It is not the full billing model; broader metering policy still belongs to Agent Capability, Metering, and Audit specs.

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
- Ensure every upstream native Chat Completions or Responses text-generation request carries an OpenAI-compatible `prompt_cache_key`.
- Preserve prompt-cache usage data so Gateway diagnostics can show cached input token effectiveness.
- Keep token material out of app APIs, diagnostics, logs, and UI state.
- Keep Codex subscription account storage aligned with the existing `DATA_ROOT` server, user, and workspace ownership boundaries.
- Preserve `/v1/models` and `/health`.
- Fail closed before model discovery, body parsing, provider credential resolution, or dispatch when server-mode actor authentication or workspace scope is invalid.

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

`prompt_cache_key` is an OpenAI-compatible public request field, not a Codex-only field. Gateway routes preserve caller-supplied `prompt_cache_key` and `prompt_cache_retention` values. Before the dispatcher sends any native Chat Completions or Responses wire request upstream, it ensures the body contains `prompt_cache_key`.

Both endpoints use OpenAI-compatible error envelopes for Gateway policy failures, missing defaults, disallowed providers, provider failures, and unsupported bridge features.

`POST /v1/completions` is intentionally outside the Gateway surface. NanoCore supports the modern Chat Completions and Responses entry points used by agent clients.

`GET /v1/models` returns configured provider models only while the Gateway is enabled. Server-mode authentication is required even though the response is OpenAI-compatible, because model supply and the sibling inference routes are deployment-owned capabilities.

## Provider Capabilities

Provider metadata includes:

```ts
{
  chatCompletions: "native" | "bridged" | "unsupported",
  responses: "native" | "bridged" | "unsupported"
}
```

Default capability assignment:

- `openai`: Chat Completions native, Responses native.
- `openai_codex`: Responses native, Chat Completions bridged.
- OpenAI-compatible gateway, custom, hosted, and local providers: Chat Completions native, Responses bridged unless the provider profile explicitly declares native Responses support.

Diagnostic booleans such as `supportsStreaming`, `supportsToolCalls`, and `supportsReasoning` remain secondary display hints while the explicit endpoint capability matrix becomes the routing source of truth.

## Dispatcher Behavior

The route layer parses JSON, enforces Gateway policy, resolves the configured default provider, and returns normalized errors. The dispatcher owns:

- native Chat Completions calls through the Pi AI backend for every non-Codex-OAuth provider
- native Responses calls through the Pi AI backend for every non-Codex-OAuth provider that declares native Responses support
- native Codex Responses calls through the ChatGPT Codex backend adapter
- Chat Completions to Responses conversion for Responses-native providers
- Responses to Chat Completions conversion through Pi AI for chat-native non-Codex providers
- prompt cache key resolution before native Chat Completions and Responses wire calls
- provider usage observation for prompt and cached-token diagnostics
- explicit `unsupported_gateway_feature` failures when a bridge cannot preserve semantics

This keeps conversion logic out of Hono routes and avoids a route-level shape collapse where every request is forced into one HTTP format.

Gateway provider resolution uses the runtime provider registry loaded from `DATA_ROOT/config/server.jsonc` and `DATA_ROOT/config/providers/*.provider.jsonc`. `openai_codex` provider instances are selected by `vendor: "openai_codex"` or the built-in `openai_codex` provider id. They must bind to a server-owned Codex OAuth account slot through `extensions.openkit.codexOAuth.accountSlotId`; when the extension is omitted, Gateway routing fails closed instead of guessing a `default` slot.

The prompt cache key resolver uses this priority order:

- explicit top-level `prompt_cache_key`
- `metadata.openkit.promptCacheKey`
- a hashed OpenKit scope built from non-secret stable fields such as provider id, model, account slot id, workspace id, thread id, agent session id, or session id
- a request-scoped generated fallback key

The generated stable key has the shape `openkit:responses:<sha256-prefix>` and never embeds raw workspace, thread, account slot, or session identifiers. The request-scoped fallback only guarantees the field is present; callers that want cross-request cache hits should provide a stable `prompt_cache_key` or stable OpenKit metadata.

## Bridge Compatibility

The v1 bridge supports:

- text-only chat messages and Responses input items
- `system` and `developer` instructions
- simple function tools
- `temperature`
- `max_tokens`, `max_completion_tokens`, and `max_output_tokens`
- `prompt_cache_key` and `prompt_cache_retention`
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

`openai_codex` does not define a private prompt-cache policy. It uses the same Gateway prompt cache key resolver as ordinary native Chat Completions and Responses providers, then sends the resulting `prompt_cache_key` to the ChatGPT Codex backend.

## Diagnostics

Deployment-admin `GET /api/app/diagnostics` reports:

- Gateway endpoints: `/health`, `/v1/models`, `/v1/chat/completions`, `/v1/responses`
- provider capability chips such as `chat native`, `responses native`, and `responses bridged`
- process-local Gateway usage summaries with request count, input tokens, output tokens, total tokens, cached input tokens, cache hit rate, and latest observation time
- sanitized `openai_codex` account state only

Diagnostics never include bearer tokens, refresh tokens, account IDs, authorization headers, or raw `prompt_cache_key` values.

## Implementation Evidence

NanoCore implements the accepted Gateway surface through `/v1/chat/completions`, `/v1/responses`, `/v1/models`, and `/health`, with no `/v1/completions` or historical `/internal/v1/chat/completions` route. Server-mode `/v1/*` requests authenticate before route work, nested OpenKit workspace metadata enters the existing workspace-scope policy, request storage fails closed without an actor, and disabled Gateway policy hides model supply as well as blocking inference. The provider dispatcher routes every non-Codex-OAuth provider through the Pi AI backend, keeps Codex OAuth on the dedicated Codex subscription Responses client, owns native and bridged Chat Completions and Responses routing, propagates prompt-cache keys, rejects unsupported features, and records durable public Gateway usage. Route, auth, dispatcher, provider-registry, prompt-cache, Pi AI client, Codex Responses client, diagnostics, and capability usage tests cover the accepted behavior. `apps/nanocore/src/llm-gateway.test.ts` guards the public route surface and asserts that the superseded internal facade remains absent.

## Verification

- `mise exec -- pnpm --filter @openkit/nanocore test`
- `mise exec -- pnpm --filter @openkit/nanocore typecheck`
- `mise exec -- pnpm --filter @openkit/nanocore lint`
- `mise exec -- pnpm --filter @openkit/nanocore build`
- `mise exec -- pnpm --filter @openkit/core-client test typecheck build`
- `mise exec -- pnpm --filter @openkit/web test typecheck lint build`

Real Codex or real subscription verification must stay skip-aware and explicitly gated so default release gates do not consume user subscription quota.
The current opt-in real Codex Goal Mode preflight uses `pnpm -w test:stories:real-codex` with `OPENKIT_L6_REAL_CODEX=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_L6_GOAL_REPO_ROOT`, and `OPENKIT_L6_EVIDENCE_DIR`.

Worker-specific trusted identity and cache-lineage behavior is owned by `docs/specs/20260711-worker_runtime_subagent_provenance.md` and does not change the generic public Gateway contract in this spec.
