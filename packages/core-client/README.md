# @openkit/core-client

`@openkit/core-client` is the composed typed HTTP and SSE client used by the SPA and protocol integration tests.

The package owns transport, request-id insertion, response validation, capability helpers, and turn-event iteration.

It does not own NanoCore App API schemas.

Core protocol payloads come from `@openkit/protocol`.

NanoCore App API payloads come from `@openkit/app-api-schemas`.

## Client Shape

- `client.core`: Core protocol routes and turn SSE.
- `client.app`: dashboards, diagnostics, setup diagnostics, storage layout reports, bootstrap-token consumption, OpenKit access-token administration, config-bound NanoHost transport Token enrollment, issuance, opposite-slot rotation, abort, revocation, and decommission, vault admin status/unlock/lock/Codex auth JSON bootstrap, data-root backup handles, authorized workspace discovery, workspace membership and invitation lifecycle, bounded access recovery, canonical user disable, workspace export/import, Artifact import/introduction and version-owned Review decisions, Workspace Material reads and mutations, workspace vault reference discovery and re-binding, capability usage evidence, server and workspace audit events, search, quick chat, authoritatively interrupted worker recovery states and request-identified retry release, scheduler admission readback/retry/cancel, durable Workspace Sync Review decisions, redacted Agent Environment Package snapshot readback, Knowledge Manager answer/context material/context package trace and materialization/proposal drafts/repair suggestions/health checks, Knowledge Store observation, claim, and conflict ledgers with conflict resolution, derived indexes, retrieval traces, automations, and feedback.
- `client.runtimeConfig`: runtime config editor and reload routes.
- `client.providerSubscriptions`: fixed provider inventory plus provider-scoped account, device-code login, logout, and quota routes.
- `client.auth.email`: Better Auth email sign-up, sign-in, and sign-out routes.
- `client.capabilities`: `refresh`, `snapshot`, `supports`, and `require` helpers over `/api/meta`.
- `client.agents`: Agent Catalog list, detail, and health refresh routes.
- `client.actionCenter`: unified Human Attention Action Center read-model route.
- `client.repositories`: workspace repository resource, diagnostics, and Git push record routes.

`parseWorkspaceSharingError(error)` narrows a generic `ApiCallError` only when it validates as the closed Workspace sharing error family.

Deprecated flat aliases are not exported.

## Commands

- `pnpm --filter @openkit/core-client test`
- `pnpm --filter @openkit/core-client typecheck`
- `pnpm --filter @openkit/core-client lint`
- `pnpm --filter @openkit/core-client build`
