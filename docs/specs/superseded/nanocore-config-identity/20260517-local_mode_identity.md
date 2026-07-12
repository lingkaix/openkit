# Local Mode Identity

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/20260628-nanocore_config_identity_contract.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The NanoCore Config And Identity Contract absorbed local actor identity, request attribution, authentication mode, and storage scoping into one current model. The standalone local-mode slice lost authority because local and server identity semantics must be reviewed as one contract.

## Retention Reason

This document preserves the original local-identity facade, actor assumptions, and storage-attribution decisions so later reviews can reconstruct the transition without reviving a separate local-mode identity owner.

## Summary

NanoCore v0.0.2 introduces a small auth facade so local mode can keep every existing API unauthenticated while still attaching a durable actor identity to requests and storage.

## Goals / Non-goals

- Treat all local-mode requests as `user_local`.
- Persist `user_local` into `core.sqlite` idempotently on boot.
- Install a pass-through auth middleware for local mode.
- Default local-mode HTTP binding to `127.0.0.1`.
- Do not enforce Better Auth sessions in this story.

## Design

`apps/nanocore/src/auth/identity.ts` defines `Actor` and `actorFromRequest(req, mode)`. Local mode always returns `{ userId: 'user_local', kind: 'local' }`.

`ensureLocalUser(coreDb)` upserts the implicit local user into the Drizzle-managed `users` table. It preserves a single row for repeated local boots and updates `last_seen_at`.

`apps/nanocore/src/auth/middleware.ts` installs the actor on Hono context and continues the request. In local mode this is intentionally a pass-through, so v0.0.1 APIs still work without auth headers.

`apps/nanocore/src/config/bind-host.ts` resolves the HTTP bind host. `OPENKIT_BIND_HOST` is the explicit override; local mode defaults to `127.0.0.1`.

## Testing Strategy

- `identity.test.ts` verifies local actor resolution and idempotent `user_local` upsert.
- `middleware.test.ts` verifies a local-mode request succeeds without auth headers and exposes the actor.
- `bind-host.test.ts` verifies the local loopback default and `OPENKIT_BIND_HOST` override.
- Existing server tests continue to exercise the unauthenticated v0.0.1 API surface.
