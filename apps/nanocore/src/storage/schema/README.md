# Storage Schemas

This directory defines the Drizzle table schemas for NanoCore's Core, User, and Workspace SQLite databases. The schema files describe durable record shape and indexes. Native per-scope SQL journals under `apps/nanocore/drizzle/{core,user,workspace,app}` create fresh databases. Before first release, keep the current schema in each scope's `0000_setup.sql`; later schema-changing releases append one SQL file per affected scope. TypeScript exports mix scopes and must not generate every table into every database.

## Boundaries

- Keep each durable record family with its owning feature and re-export it through `index.ts` only when database setup or a repository consumer requires it.
- Preserve the ownership split documented in the parent [storage guide](../README.md); a schema declaration must not create a second authority for canonical workspace files.
- Add constraints and indexes that enforce present access, lineage, or query requirements. Do not add speculative columns or generic metadata bags.
- Workspace snapshot cursors keep the accepted tree/manifest pair separate from the captured pair and contextual Core Git commit. Immutable collection rows retain exact lineage, candidate bytes, successful credential-check evidence, and the actual review association; operational volume identities do not become portable attachment authority. Runtime bindings retain exact Vault reference/version/name evidence, never runtime credential values.
- The pre-release Core baseline has no generic scheduler target-health table or index; configured NanoHost readiness remains in its own RuntimeTarget schema.
- Retained backend image lineage, Worker storage target observations, and scheduler storage selection JSON allow inert descriptive additions. Their readers validate the closed core and required-feature gate without rewriting stored bytes; effect-admitting storage commands remain exact.
- NanoHost-private execution attempt columns retain only the three nullable worker-control, inference, and capability SHA-256 projections needed for restart authentication; raw route tokens and sandbox-binding-derived credentials are outside durable schema scope.
- Update the matching `apps/nanocore/drizzle/<scope>/` SQL journal and its setup tests whenever a persisted schema changes. Do not run Drizzle Kit generate against this mixed TypeScript schema tree.

## Verification

Run the focused repository tests for the changed record family, then the storage setup tests and NanoCore package gates described in the [NanoCore source guide](../../README.md).

## Native Environment Projections

`worker-image-settlements.ts` adds nullable confirmed default bytes to the existing immutable image outcome. `nanohost-harness-runtime.ts` stores a binding's immutable non-secret package projection and a separate native-start acknowledgement bit. Neither field introduces another environment registry or an image-effect replay path. The pre-first-release baseline SQL remains aligned with these schema projections.

`goals.ts` owns Workspace SQL shapes for current Goal intent/history and wake revisions, work-intent cards, immutable Plan versions and ordinary Task citations. `task_turn_terminal_facts` is the minimal Task-owned terminal publication fact, committed with the Goal wake revision and recovered at boot. The one-way cutover in `../goal-cutover.ts` drops the seven retired Goal tables and Goal-owned checkpoints; Core migration clears and drops the Sandbox pin without removing shared records.

Workspace migrations drop retired host repository and Git push tables after replaying unchanged historical setup DDL. No schema module or live repository store remains; archive codecs validate historical metadata without restoring authority.

Core `0004_equal_workspace_members.sql` carries retained membership and invitation identities, lifecycle facts, links and revisions forward without editor/viewer columns. The earlier journals stay unchanged. The replacement owner guards require active membership without a higher access tier. `storage/migrate.test.ts` applies the committed journal twice and verifies the current Core columns. `equal-workspace-members.test.ts` verifies the required actual initiator and admitted member deletion with private recovery ownership.

Vault grants require the closed `issuance` discriminator with no default. The Core baseline and Drizzle projection enforce `target` or `imported-history`; the importer cannot choose target issuance. This identifier cutover uses the accepted pre-stable clean-scope procedure and supplies no legacy provenance inference or data conversion.

Core `0007_server_capability_usage.sql` creates the same capability-call, usage and evidence-bundle record families for Server work. Its null Workspace constraints prevent a Server row from acquiring a Workspace anchor. The physical Core database is the unique Server owner; no redundant owner column or second ledger is added. Workspace journals retain their current non-null Workspace constraints.

`external-trigger-admissions.ts` projects the immutable four-field scheduled-pull join. Core `0006_external_trigger_admissions` enforces the schedule/event key and schedule/queue foreign keys. Queue insertion and join acceptance share the existing Core transaction; source Turn publication remains file-owned. The join carries no execution state or retry lifecycle. Run `storage/external-trigger-admissions.test.ts`, `storage/recurring-portable-history.test.ts` and the native migration suite for this boundary.
