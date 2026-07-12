# NanoCore Source

This directory contains NanoCore's composition root and feature owners. `app.ts` mounts middleware and concrete feature registrars; complete product behavior belongs in the nearest cohesive route, runtime, storage, provider, policy, or workspace owner.

## Boundaries

- Keep authentication and middleware order in `app.ts`; do not move product handlers back into the composition root.
- Keep one complete route lifecycle in one feature module when practical, and pass only concrete dependencies that the module cannot import from its real owner.
- Keep protocol and App API schemas in their owning packages; NanoCore validates and executes those contracts rather than defining parallel DTOs.
- Keep runtime execution under `runtime/`, persistence and recovery under `storage/`, provider configuration under `providers/`, authentication under `auth/`, and secret material mechanics under `vault/`.
- Do not add controller, service, repository, façade, dependency-container, or compatibility layers unless they remove demonstrated complexity across multiple real consumers.

## Entry Points

- `app.ts` composes middleware, authentication, shared process state, and feature registrars.
- `index.ts` owns process boot and shutdown.
- `openapi.ts` owns the explicit App API operation catalog and generated projection.
- `*-routes.ts` files own cohesive public feature paths.
- `lib/store.ts` exposes the app-local product store while `storage/` owns durable record placement.

## Supporting Directories

- `capability/` owns capability-call and usage-ledger operations.
- `context/` owns LLM context projection and its projection policy.
- `diagnostics/` owns product-safe setup and runtime diagnostic projections.
- `knowledge/` owns OKF parsing and validation helpers; knowledge workflows remain with their cohesive root owners.
- `policy/` adapts product approval gates and permission decisions while canonical authorization semantics remain in `@openkit/policy-kernel`.
- `docker/` contains source-adjacent contract tests for application and worker container assets.
- `test-support/` contains shared test fixtures only.
- `lib/` contains the existing app-local stores and simulator; do not expand it with new general helpers, and place new behavior with its concrete owner.

## Change Workflow

Read [the NanoCore package guide](../README.md), the repository `AGENTS.md`, and the nearest directory README before editing. Characterize behavior before moving a route or ownership boundary, keep registration order stable, and separate semantic repairs from mechanical extraction.

## Verification

```bash
pnpm --filter @openkit/nanocore run typecheck
pnpm --filter @openkit/nanocore run lint
pnpm --filter @openkit/nanocore run test
pnpm --filter @openkit/nanocore run build
```

Run `openapi:generate` and `openapi:validate` whenever a documented App API operation or schema projection changes.
