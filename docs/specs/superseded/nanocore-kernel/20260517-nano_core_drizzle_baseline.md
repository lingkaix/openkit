---
status: Superseded
implementation: N/A
status-changed: 2026-07-03
current-guidance: "`docs/specs/20260703-storage_layout_record_ownership.md`, `docs/specs/20260628-nanocore_config_identity_contract.md`"
decision-evidence: "`docs/specs/20260703-storage_layout_record_ownership.md`, `docs/specs/20260628-nanocore_config_identity_contract.md`"
---
# NanoCore Drizzle Baseline

## Lifecycle Reason

Storage Layout/Record Ownership and NanoCore Config/Identity absorbed SQLite homing, schema management, migrations, and identity-scoped databases into current authorities. The Drizzle baseline lost authority because one initial schema slice cannot own the evolved record families.

## Retention Reason

This document preserves the original Drizzle schema baseline, migration workflow, and package setup decisions so database history remains auditable without treating the first migration set as current storage design.

## Summary

NanoCore v0.0.2 now has a committed SQLite storage baseline managed through Drizzle schema definitions and committed migration SQL.

## Goals / Non-goals

- Use `better-sqlite3` as the local SQLite driver.
- Use Drizzle table definitions as the TypeScript schema source.
- Create `data/core.sqlite` under the resolved data root.
- Commit the first migration under `apps/nanocore/drizzle/`.
- Keep schema mutation SQL out of runtime source files.
- Keep request authentication and Better Auth tables out of this story.

## Design

`apps/nanocore/src/storage/schema/` defines the baseline tables:

- `schema_migrations (id, applied_at)`
- `server_settings (key, value, updated_at)`
- `users (id, kind, display_name, created_at, last_seen_at)`

`apps/nanocore/drizzle.config.ts` points Drizzle Kit at `src/storage/schema` and writes migrations to `apps/nanocore/drizzle`.

`apps/nanocore/src/storage/db.ts` exports `openCoreDb(dataRoot)` for tests and explicit callers, plus `getCoreDb(env)` for the process singleton. Both place the database at `<dataRoot>/core.sqlite` after bootstrapping the filesystem layout.

`apps/nanocore/src/storage/migrate.ts` applies committed migration files that have not yet been recorded in `schema_migrations`. Startup calls `applyMigrations(getCoreDb())` before serving HTTP traffic.

## Migration Rules

Schema mutation SQL belongs only in committed migration files under `apps/nanocore/drizzle/`.

Runtime code may read migration files and execute them, but it must not embed `CREATE TABLE`, `ALTER TABLE`, or `DROP TABLE` statements directly.

Migration failures throw `BootConfigError` with code `migration_failed`; missing committed migration files throw `BootConfigError` with code `migration_missing`.

## Testing Strategy

- `migrate.test.ts` applies the baseline migration twice against one temporary data root and asserts only one `schema_migrations` row exists.
- The same test asserts `users` and `server_settings` are created.
- A grep-style test scans `apps/nanocore/src` and rejects ad-hoc table mutation SQL outside the committed Drizzle migration directory.
