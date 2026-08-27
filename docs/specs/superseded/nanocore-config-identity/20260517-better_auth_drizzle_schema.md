---
status: Superseded
implementation: N/A
status-changed: 2026-06-28
current-guidance: "`docs/specs/20260628-nanocore_config_identity_contract.md`"
decision-evidence: "`docs/specs/20260628-nanocore_config_identity_contract.md`"
---
# Better Auth Drizzle Schema

## Lifecycle Reason

The NanoCore Config And Identity Contract consolidated Better Auth persistence, server identity, mode behavior, and storage ownership under one authority. This schema slice no longer guides implementation independently because its table choices must remain subordinate to the consolidated identity contract.

## Retention Reason

This document preserves the initial Better Auth and Drizzle schema rationale, field mapping, and migration considerations so maintainers can audit the persistence baseline without treating its implementation slice as current design authority.

## Summary

NanoCore v0.0.2 adds Better Auth as the server-mode auth foundation without enforcing sessions yet.

## Goals / Non-goals

- Configure Better Auth with the official Drizzle adapter and SQLite provider.
- Generate the Better Auth Drizzle schema with the Better Auth CLI.
- Commit the generated schema under `apps/nanocore/src/storage/schema/better-auth/`.
- Apply the Better Auth tables through the existing `core.sqlite` migration workflow.
- Keep local-mode pass-through behavior unchanged.
- Do not enforce server-mode auth in this story.

## Design

`apps/nanocore/src/auth/better-auth.ts` exports `createBetterAuth(coreDb)`. The function binds Better Auth to the existing Core Drizzle client through `drizzleAdapter(coreDb.db, { provider: 'sqlite', schema })` and enables email/password capability for the initial schema.

The Better Auth schema was generated with the Better Auth CLI into `apps/nanocore/src/storage/schema/better-auth/index.ts`. The generated tables are exported through `apps/nanocore/src/storage/schema/index.ts` so the Core Drizzle client sees one flat schema object.

`apps/nanocore/drizzle/0001_better_auth.sql` creates the Better Auth tables:

- `user`
- `session`
- `account`
- `verification`

`applyMigrations(coreDb)` now applies `0000_init` and `0001_better_auth` idempotently.

## Testing Strategy

- `better-auth.test.ts` constructs Better Auth against a migrated temporary data root and asserts the four auth tables exist.
- `migrate.test.ts` applies migrations twice and asserts exactly one row exists for each migration id.
- Existing local-mode auth tests verify no auth headers are required for the v0.0.1 API surface.
