# Codex ChatGPT Subscription Login

Status: Accepted
Implementation: Implemented

## Owns

This spec owns server-owned Codex ChatGPT subscription account slots, sanitized account App API routes, account-scoped login and logout behavior, and the binding between Codex account slots and Gateway provider instances.

## Does Not Own

This spec does not own LLM Gateway request routing, Chat Completions or Responses semantics, vault backend storage, user-owned BYOK behavior, general OAuth provider support, or `packages/protocol` schemas.

## Core References

- `docs/core/identity.md`
- `docs/core/vault.md`
- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `docs/core/audit.md`

## Summary

This spec adds server-owned OpenAI Codex/ChatGPT subscription account management to NanoCore and the Web UI. The implementation supports one NanoCore server managing multiple isolated account slots and binding Gateway provider instances to those slots by non-secret references.

The inference surface is covered by [LLM Gateway Responses API](./20260526-llm_gateway_responses_api.md), which adds native Responses routing for `openai_codex` while preserving this login API as the user-facing account control surface.

## Current Implementation Projection

NanoCore exposes server-owned Codex account-slot management through account-scoped App API routes under `/api/app/oauth/openai-codex/accounts`.

Unscoped Codex OAuth status, start, cancel, and logout routes are removed.
Current status, start, cancel, and logout actions must use `/api/app/oauth/openai-codex/accounts/:accountSlotId/*`.

The account list may expose a default marker for product diagnostics and setup guidance, but callers must still pass the account slot explicitly for login, logout, status, cancellation, token resolution, and provider binding.

Account deletion refuses pending login slots and slots still bound to active provider instances.

Gateway inference, Chat Completions and Responses routing, prompt-cache behavior, Gateway errors, and usage observation are owned by `docs/specs/20260526-llm_gateway_responses_api.md`.

The implementation is covered across NanoCore route tests, account-slot storage tests, App API schema tests, `@openkit/core-client` account-route tests, Web diagnostics account-management tests, OpenAPI projection tests, and a NanoCore source guard that prevents account-unscoped OAuth action routes from returning.

## Goals

- Start Codex-managed ChatGPT login for a selected server-owned account slot from the OpenKit Web UI.
- Support browser login and device-code login per account slot.
- Show pending login state, cancellation, logged-in account label, plan type, unavailable state, and logout.
- Keep token material inside Codex app-server managed auth storage.
- Preserve `openai_codex` as an OAuth provider identity rather than an API-key provider.
- Store Codex-managed account state under the existing `DATA_ROOT` ownership layout instead of introducing a new top-level OAuth tree.
- Bind Gateway provider instances to Codex account slots through `extensions.openkit.codexOAuth.accountSlotId`.

## Non-Goals

- Do not expose access tokens, refresh tokens, or ChatGPT account ids through NanoCore App APIs.
- Do not change `packages/protocol` for this app-level UI slice.
- Do not add a custom OAuth callback server while Codex app-server already owns login completion.
- Do not store Codex account state, Codex homes, `auth.json`, or token material under `DATA_ROOT/config`.
- Do not implement per-user subscription account behavior in this first app-level slice; reserve the user-owned path for future BYOK and personal subscription work.

## App API

All OAuth actions are account-scoped. Clients must pass the target `accountSlotId`.

`GET /api/app/oauth/openai-codex/accounts/:accountSlotId/status` returns a sanitized status payload:

```json
{
  "providerId": "openai_codex",
  "accountSlotId": "team_a",
  "isDefault": false,
  "boundProviderIds": ["codex-team-a"],
  "status": "logged_in",
  "accountLabel": "user@example.com",
  "planType": "plus"
}
```

`POST /api/app/oauth/openai-codex/accounts/:accountSlotId/start` accepts:

```json
{ "mode": "browser" }
```

or:

```json
{ "mode": "device_code" }
```

Browser login returns `status`, `mode`, `loginId`, and `authUrl`. Device-code login returns `status`, `mode`, `loginId`, `verificationUrl`, and `userCode`.

`POST /api/app/oauth/openai-codex/accounts/:accountSlotId/cancel` accepts an optional `loginId` and cancels the active Codex login.

`POST /api/app/oauth/openai-codex/accounts/:accountSlotId/logout` clears the selected Codex-managed ChatGPT account.

Account-management APIs are first-class:

- `GET /api/app/oauth/openai-codex/accounts`
- `POST /api/app/oauth/openai-codex/accounts`
- `PATCH /api/app/oauth/openai-codex/accounts/:accountSlotId`
- `DELETE /api/app/oauth/openai-codex/accounts/:accountSlotId`
- `GET /api/app/oauth/openai-codex/accounts/:accountSlotId/status`
- `POST /api/app/oauth/openai-codex/accounts/:accountSlotId/start`
- `POST /api/app/oauth/openai-codex/accounts/:accountSlotId/cancel`
- `POST /api/app/oauth/openai-codex/accounts/:accountSlotId/logout`

`accountSlotId` must match `^[a-z0-9][a-z0-9_-]{0,63}$`. Delete refuses pending slots and slots bound to active provider instances.

## Runtime Behavior

NanoCore bridges those app routes to Codex app-server JSON-RPC:

- `account/read`
- `account/login/start`
- `account/login/cancel`
- `account/logout`

The bridge also listens for:

- `account/login/completed`
- `account/updated`

Each account slot starts Codex app-server with `CODEX_HOME=<slot>/codex-home`, so Codex-managed auth storage is isolated per slot. The implementation keeps the bridged account protocol types narrow.

## Data-root Placement

The login slice follows the canonical server config and data-root layout from [Server Config and Data Layout](./20260628-nanocore_config_identity_contract.md) and [Layered User and Workspace Configuration](./20260628-nanocore_config_identity_contract.md).

`DATA_ROOT/config` remains server-owned authored runtime config only:

```text
DATA_ROOT/config/server.jsonc
DATA_ROOT/config/providers/*.provider.jsonc
DATA_ROOT/config/agents/*.agent.jsonc
```

Configured Codex subscription provider instances belong in `DATA_ROOT/config/providers/*.provider.jsonc`. Those files may contain stable routing and display metadata such as provider id, vendor, kind, default model, and a non-secret account slot reference. They must not contain Codex bearer tokens, refresh tokens, ChatGPT account ids, `auth.json` contents, or raw authorization headers.

Server-owned Codex subscription account state belongs under `DATA_ROOT/server/files` because it is operational state for global provider and Gateway routing, not authored server config:

```text
DATA_ROOT/server/files/oauth/openai-codex/accounts/<account-slot-id>/
  account.json
  codex-home/
    auth.json
```

`account.json` stores only `schemaVersion`, `accountSlotId`, `displayName`, `status`, `accountLabel`, `planType`, `lastUpdatedAt`, `lastError`, and `lastLoginMode`. It does not store bearer tokens, refresh tokens, ChatGPT account ids, raw authorization headers, or full auth storage paths. `codex-home/` is the isolated `CODEX_HOME` passed to the Codex app-server process for that account slot. If Codex stores credentials in `auth.json` for the current platform, that file stays inside the isolated `codex-home/`. If Codex stores credentials in an OS credential store such as macOS Keychain, the isolated `codex-home` still determines the account-specific credential key and remains the durable slot identity.

Provider instances bind to a slot with a non-secret extension:

```jsonc
{
  "id": "codex-team-a",
  "displayName": "Codex Team A",
  "kind": "oauth",
  "vendor": "openai_codex",
  "models": ["openai-codex/gpt-5.6-sol"],
  "defaultModel": "openai-codex/gpt-5.6-sol",
  "extensions": {
    "openkit": {
      "codexOAuth": {
        "accountSlotId": "team_a"
      }
    }
  }
}
```

Future user-owned ChatGPT subscription or BYOK account slots must not be placed under `DATA_ROOT/server/files`. They should live under the user-owned tree reserved by the layered config design:

```text
DATA_ROOT/users/<user-id>/data/oauth/openai-codex/accounts/<account-slot-id>/
  account.json
  codex-home/
    auth.json
```

Future user config may reference those slots through non-secret references only. Workspace config must not contain raw Codex credentials.

## UI Behavior

The Settings Diagnostics panel shows a `Codex ChatGPT accounts` section with:

- account-slot list with slot id, display name, default marker, and bound provider ids
- add, rename, and delete controls for server-owned slots
- browser login and device-code login action per account
- browser auth link when pending
- device verification link and code when pending
- cancellation action when pending
- account label, plan type, and sign-out action when logged in
- unavailable or error text when Codex app-server cannot complete the account request

## Security

The public payload must only contain sanitized account and flow metadata. It must never contain access tokens, refresh tokens, authorization headers, or raw secret-shaped values.

## Verification

- `mise exec -- pnpm --filter @openkit/nanocore exec vitest run src/codex-oauth.test.ts`
- `mise exec -- pnpm --filter @openkit/core-client exec vitest run src/client.test.ts`
- `mise exec -- pnpm --filter @openkit/web exec vitest run src/components/DiagnosticsPanel.test.tsx src/App.test.tsx`
