# Native Drizzle SQL

This directory owns NanoCore's native Drizzle Kit journals. Each of `core`, `user`, `workspace`, and `app` has its own SQL files and `meta/_journal.json`. Startup applies those journals through `drizzle-orm/better-sqlite3` `migrate`. The TypeScript table exports under `src/storage/schema` mix scopes and must not generate every table into every database.

Before the first release, an explicitly authorized reset-bound schema correction may edit an existing SQL file while preserving its journal entry and tag. Do not squash or rename journals as part of such a correction. After release, each schema-changing release adds one SQL file per affected scope.

Runtime admission inspects all retained native ledger timestamps against the exact packaged scope journal before migration or ordinary use. Unknown or future identities receive a typed scope-specific refusal. Supported sparse histories remain valid; this check does not impose a universal prefix or compare informational SQL hashes. Restore uses the same read-only admission before root replacement.

## Create SQL for one scope

Use the per-scope Kit configs with `--custom`. `drizzle.config.ts` re-exports the Core config. From `apps/nanocore`:

```bash
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.config.ts --name <tag>
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.user.config.ts --name <tag>
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.workspace.config.ts --name <tag>
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.app.config.ts --name <tag>
```

Replace the generated placeholder with the exact custom SQL for that scope. Custom SQL is required for owner-guard triggers and other statements Kit would not emit from the mixed TypeScript exports. Do not invent a generic SQL generator, and do not run generate against `src/storage/schema`.
