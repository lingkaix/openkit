# NanoCore OpenAPI Artifacts

This directory stores generated, reviewable OpenAPI projection artifacts for NanoCore.

## Files

- `app-api.openapi.json` is generated from the canonical App API operation catalog in `apps/nanocore/src/openapi.ts` and the shared Zod schema packages.
- `oas-3.1-schema-2022-10-07.json` is the official OpenAPI 3.1 schema used for offline validation.

## Commands

Run from the repository root:

```bash
pnpm --filter @openkit/nanocore run openapi:generate
pnpm --filter @openkit/nanocore run openapi:validate
pnpm --filter @openkit/nanocore run openapi:check
```

The JSON artifact is not the source of truth. Runtime handlers register by operation id and derive their method and path from the same catalog that generates the artifact. Focused tests compare the default app's explicit GET, POST, PUT, PATCH, and DELETE entries with documented operations in both directions, require a closed classification for every inspected non-App route, and enforce selected shared-schema, security, error, and reference invariants. Middleware, Hono `ALL` entries, and conditionally mounted browser-auth routes remain covered by their owning tests.

The generated document identifies the App API and Core protocol versions separately, includes a projection-content digest, and is instantiated once at module load for reuse by each NanoCore process. The shared schema packages and operation catalog remain canonical.
