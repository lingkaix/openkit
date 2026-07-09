# Server Auth Middleware

Status: Superseded

Superseded by: [NanoCore Config And Identity Contract](../../20260628-nanocore_config_identity_contract.md)

Reference status: retained for detailed historical auth, identity, config, and data-layout context after consolidation.

## Summary

NanoCore server mode now protects product APIs with Better Auth session validation while keeping a small public surface for health, metadata, and Better Auth endpoints.

## Goals / Non-goals

- Enforce sessions on protected `/api/*` product routes in server mode.
- Return a typed `core.auth.unauthenticated` error for missing or invalid sessions.
- Keep `GET /api/health`, `GET /api/meta`, and `/api/auth/*` public.
- Keep server-mode public metadata reduced so provider and agent details are not exposed before authentication.
- Keep product code behind the auth facade instead of importing Better Auth directly.
- Do not implement sign-up/sign-in flow tests or per-user workspace scoping in this story.

## Design

`createAuthMiddleware(mode, auth)` handles both modes. Local mode continues to attach the implicit local actor and pass through requests.

In server mode, public routes pass through before session validation. Protected routes call `auth.api.getSession({ headers })`. Missing sessions return:

```json
{
  "code": "core.auth.unauthenticated",
  "message": "Authentication required."
}
```

Valid sessions are converted through `actorFromSession(session)` into `{ userId, kind: 'session' }`.

`createApp({ mode: 'server' })` mounts Better Auth under `/api/auth/*` and returns reduced metadata from `/api/meta`.

## Testing Strategy

- `middleware.server-mode.test.ts` covers unauthenticated protected route rejection, valid-session pass-through, public metadata/health/auth routes, session actor mapping, and Better Auth import isolation.
- Existing local middleware tests continue to verify local-mode pass-through behavior.
