# Storage Schemas

This directory defines the Drizzle table schemas for NanoCore's Core, User, and Workspace SQLite databases. The schema files describe durable record shape and indexes. Native per-scope SQL journals under `apps/nanocore/drizzle/{core,user,workspace,app}` create fresh databases. Before first release, keep the current schema in each scope's `0000_setup.sql`; later schema-changing releases append one SQL file per affected scope. TypeScript exports mix scopes and must not generate every table into every database.

## Boundaries

- Keep each durable record family with its owning feature and re-export it through `index.ts` only when database setup or a repository consumer requires it.
- Preserve the ownership split documented in the parent [storage guide](../README.md); a schema declaration must not create a second authority for canonical workspace files.
- Add constraints and indexes that enforce present access, lineage, or query requirements. Do not add speculative columns or generic metadata bags.
- Workspace snapshot cursors keep the accepted tree/manifest pair separate from the captured pair and contextual Core Git commit. Immutable collection rows retain exact lineage, candidate bytes, successful credential-check evidence, and the actual review association; operational volume identities do not become portable attachment authority. Runtime bindings retain exact Vault reference/version/name evidence, never runtime credential values.
- Scheduler session leases retain only the three nullable worker-control, inference, and capability SHA-256 projections needed for restart authentication; raw route tokens and sandbox-binding-derived credentials are outside durable schema scope.
- Update the matching `apps/nanocore/drizzle/<scope>/` SQL journal and its setup tests whenever a persisted schema changes. Do not run Drizzle Kit generate against this mixed TypeScript schema tree.

## Verification

Run the focused repository tests for the changed record family, then the storage setup tests and NanoCore package gates described in the [NanoCore source guide](../../README.md).

## Native Environment Projections

`worker-image-settlements.ts` adds nullable confirmed default bytes to the existing immutable image outcome. `nanohost-harness-runtime.ts` stores a binding's immutable non-secret package projection and a separate native-start acknowledgement bit. Neither field introduces another environment registry or an image-effect replay path. The pre-first-release baseline SQL remains aligned with these schema projections.

`goals.ts` owns Workspace SQL shapes for current Goal intent/history and wake revisions, work-intent cards, immutable Plan versions and ordinary Task citations. `task_turn_terminal_facts` is the minimal Task-owned terminal publication fact, committed with the Goal wake revision and recovered at boot. The one-way cutover in `../goal-cutover.ts` drops the seven retired Goal tables and Goal-owned checkpoints; Core migration clears and drops the Sandbox pin without removing shared records.
