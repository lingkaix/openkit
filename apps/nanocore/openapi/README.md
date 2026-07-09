# NanoCore OpenAPI Artifacts

This directory stores generated, reviewable OpenAPI projection artifacts for NanoCore.

## Files

- `app-api.openapi.json` is generated from `apps/nanocore/src/openapi.ts` and the shared Zod schema packages.
- `oas-3.1-schema-2022-10-07.json` is the official OpenAPI 3.1 schema used for offline validation.

## Commands

Run from the repository root:

```bash
pnpm --filter @openkit/nanocore run openapi:generate
pnpm --filter @openkit/nanocore run openapi:validate
pnpm --filter @openkit/nanocore run openapi:check
```

The JSON artifact is not the source of truth. Route registrations and shared schema packages remain canonical.
