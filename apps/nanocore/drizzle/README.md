# Native Drizzle SQL

This directory owns NanoCore's native Drizzle Kit journals. Each of `core`, `user`, `workspace`, and `app` has its own SQL files and `meta/_journal.json`. Startup applies those journals through `drizzle-orm/better-sqlite3` `migrate`. The TypeScript table exports under `src/storage/schema` mix scopes and must not generate every table into every database.

Before the first release, keep the current schema in `0000_setup.sql` for each affected scope. After release, each schema-changing release adds one SQL file per affected scope.

## Create SQL for one scope

Use the per-scope Kit configs with `--custom`. `drizzle.config.ts` re-exports the Core config. From `apps/nanocore`:

```bash
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.config.ts --name <tag>
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.user.config.ts --name <tag>
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.workspace.config.ts --name <tag>
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.app.config.ts --name <tag>
```

Replace the generated placeholder with the exact custom SQL for that scope. Custom SQL is required for owner-guard triggers and other statements Kit would not emit from the mixed TypeScript exports. Do not invent a generic SQL generator, and do not run generate against `src/storage/schema`.
