# Storage Schemas

This directory defines the Drizzle table schemas for NanoCore's Core, User, and Workspace SQLite databases. The schema files describe durable record shape and indexes. Native per-scope SQL journals under `apps/nanocore/drizzle/{core,user,workspace,app}` create fresh databases. Before first release, keep the current schema in each scope's `0000_setup.sql`; later schema-changing releases append one SQL file per affected scope. TypeScript exports mix scopes and must not generate every table into every database.

## Boundaries

- Keep each durable record family with its owning feature and re-export it through `index.ts` only when database setup or a repository consumer requires it.
- Preserve the ownership split documented in the parent [storage guide](../README.md); a schema declaration must not create a second authority for canonical workspace files.
- Add constraints and indexes that enforce present access, lineage, or query requirements. Do not add speculative columns or generic metadata bags.
- Scheduler session leases retain only the three nullable worker-control, inference, and capability SHA-256 projections needed for restart authentication; raw route tokens and sandbox-binding-derived credentials are outside durable schema scope.
- Update the matching `apps/nanocore/drizzle/<scope>/` SQL journal and its setup tests whenever a persisted schema changes. Do not run Drizzle Kit generate against this mixed TypeScript schema tree.

## Verification

Run the focused repository tests for the changed record family, then the storage setup tests and NanoCore package gates described in the [NanoCore source guide](../../README.md).
