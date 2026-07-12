# Config Schema

`@openkit/config-schema` is the shared source of truth for OpenKit authored config schemas, policy metadata, JSON Schema catalog entries, workspace root materialization helpers, and session workspace layout planning schemas.

NanoCore consumes this package so runtime loading, draft validation, reload planning, and UI schema hints follow one contract instead of copying rules into routes or UI components.

`server.ts` owns the strict `server.jsonc` shape, including the optional absolute `vault.encryptedFile.keyFilePath`; NanoCore owns key-file permissions, ownership, bounded loading, authentication, and boot behavior.

Workspace config currently covers `workspace.roots` and `workspace.assistant.repositoryInspection`. The Assistant repository inspection policy defaults to enabled and lets a workspace disable Chat Mode repository reads or exclude exact repository-relative path prefixes without changing worker roots.

## Commands

- `pnpm --filter @openkit/config-schema test`
- `pnpm --filter @openkit/config-schema typecheck`
- `pnpm --filter @openkit/config-schema build`
