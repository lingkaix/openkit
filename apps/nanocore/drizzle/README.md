# Native Drizzle SQL

This directory owns NanoCore's native Drizzle Kit journals. Each of `core`, `user`, `workspace`, and `app` has its own SQL files and `meta/_journal.json`. Startup reads those journals with `drizzle-orm/migrator` `readMigrationFiles` and applies them through the SQLite dialect migrator on a `drizzle-orm/better-sqlite3` session. The TypeScript table exports under `src/storage/schema` mix scopes and must not generate every table into every database.

The v0.2.0 fresh-root cutover folds Core, User, Workspace, and App into one `0000_baseline.sql` per scope at Drizzle index 0. The Workspace baseline includes the corrected current AgentSession predicate. App opens require the explicit Light App kernel format 1. See [Control Kernel And Service Storage](../../../docs/decisions/20261120-control_kernel_and_service_storage.md#baseline-and-cutover).

After the cutover, schema-changing releases append one SQL file per affected scope. Boot and restore verify the installed Core baseline hash and native journal identity before admitting the root. Each database also verifies its supported journal identities before ordinary use.

## Create SQL for one scope

Use the per-scope Kit configs with `--custom`. `drizzle.config.ts` re-exports the Core config. From `apps/nanocore`:

```bash
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.config.ts --name <tag>
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.user.config.ts --name <tag>
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.workspace.config.ts --name <tag>
pnpm --filter @openkit/nanocore exec drizzle-kit generate --custom --config drizzle.app.config.ts --name <tag>
```

Replace the generated placeholder with the exact custom SQL for that scope. Custom SQL is required for owner-guard triggers and other statements Kit would not emit from the mixed TypeScript exports. Do not invent a generic SQL generator, and do not run generate against `src/storage/schema`.
