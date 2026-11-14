# Storage Schemas

This directory projects the current durable record shapes for NanoCore's Core, User and Workspace databases. Core and Workspace each have one complete `apps/nanocore/drizzle/{core,workspace}/0000_baseline.sql`; edit these baselines directly before v0.1.0, without another journal entry or format bump. User and App retain their independent journals. The [single-baseline decision](../../../../../docs/decisions/20261114-pre_release_sql_baselines.md) and [storage guide](../README.md) own this boundary. Do not run Drizzle Kit generate against this mixed-scope TypeScript tree.

## Boundaries

- Keep each record family with its feature and export it through `index.ts` only for a real consumer. A schema declaration grants neither serving authority nor a second writer.
- Add only constraints and indexes required by current access, lineage or queries. Match the physical scope; never generate every table into every database.
- Fresh Workspace setup publishes the complete schema, original prepared Notebook head and initial Audits, and ledger in the original Drizzle transaction. Raw DDL is not Knowledge authority. There is no predecessor import, post-journal Goal/host cutover or file fallback.
- `execution-journal.ts` projects Core and Workspace execution roots/steps. Closed producer definitions and native physical-owner checks remain separate from stored history; a retained row grants no execution allowance.
- `goals.ts` owns current intent/card/Plan/Task constraints and terminal wake facts. Shared Thread and Task owners retain their current publication and replay predicates.
- Snapshot cursors distinguish accepted and captured tree/manifest pairs and contextual Core Git commits. Collection rows retain exact lineage, candidate bytes, credential-check evidence and review association. Capture lifecycle rows do not prove physical close or exclusion.
- Backend image lineage, storage-target observations and scheduler storage-choice JSON admit only supported retained descriptive additions. Effect-admitting commands remain exact. Attempt rows retain only non-secret route-token SHA-256 projections.
- Vault grants require explicit `target` or `imported-history` issuance, with no default or inferred provenance. Runtime/Vault exposure and account-quota records retain their distinct owners.

## Command Log And Recurring History

`idempotency_requests` is the existing scope-owned command log. Only Core external-event commands use NULL expiry. Their full stored scope contains `coreId`, `scheduleId`, `eventKey` and `sourceTurnId`; the canonical key covers all fields, and the response points to the original scheduler entry. Core partial indexes preserve one event per schedule/event key and queue lookup. There is no `external_trigger_admissions` table or parallel write.

Native queue and event-command insertion share the original Core transaction. Readers validate the command identity and retained schedule/queue lineage; source Turn publication remains file-owned. Portable recurring history remains an inert nested projection, not restored scheduler authority. Native ordinary expiry pruning excludes permanent events and never removes App receipt metadata; expired App reuse requires recovery.

## Verification

Run the covering record-family tests, current fresh-setup tests and the gates in the [NanoCore source guide](../../README.md). Preserve native transaction rollback, read-only admission, exact retained bytes and truthful physical/FULL acknowledgement. A passing schema test is not runtime or all-writer qualification.
