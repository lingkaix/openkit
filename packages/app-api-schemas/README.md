# @openkit/app-api-schemas

`@openkit/app-api-schemas` owns runtime-neutral Zod schemas for NanoCore App API payloads.

These schemas are shared by `apps/nanocore` and `@openkit/core-client` while the App API remains an implementation projection over the stable Core protocol.

Do not add stable Core protocol records here. Core records, commands, events, errors, and conformance fixtures belong in `@openkit/protocol`.

## Commands

- `pnpm --filter @openkit/app-api-schemas test`
- `pnpm --filter @openkit/app-api-schemas typecheck`
- `pnpm --filter @openkit/app-api-schemas build`
- `pnpm --filter @openkit/app-api-schemas lint`
