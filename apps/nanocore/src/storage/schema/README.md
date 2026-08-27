# Storage Schemas

This directory defines the Drizzle table schemas for NanoCore's Core, user, and workspace SQLite databases. The schema files describe durable record shape and indexes; migrations in the parent storage directory remain the authority for evolving deployed databases.

## Boundaries

- Keep each durable record family with its owning feature and re-export it through `index.ts` only when database setup or a repository consumer requires it.
- Preserve the ownership split documented in the parent [storage guide](../README.md); a schema declaration must not create a second authority for canonical workspace files.
- Add constraints and indexes that enforce present access, lineage, or query requirements. Do not add speculative columns or generic metadata bags.
- Scheduler session leases retain only the two nullable worker-control and inference SHA-256 projections needed for restart authentication; raw route tokens and sandbox-binding-derived credentials are outside durable schema scope.
- Update the matching migration and migration tests whenever a persisted schema changes.

## Verification

Run the focused repository tests for the changed record family, then the storage migration tests and NanoCore package gates described in the [NanoCore source guide](../../README.md).
