---
type: change-plan
status: implemented
---
# Versioned Light App Definitions

## Intent Revision 1 — Coordinator Assignment, 2026-10-17

Deliver the engineer-approved rc.10 reusable Light App definition catalog through the existing Skill/MCP Resource Catalog, with immutable parent, actor and time history, explicit import/export/default/pin selection, and separate live app activation. Preserve one SQLite data file per app, two version markers, automatic consistent pre-migration snapshots and snapshot restoration without down migrations.

## Accepted Scope And Owners

[Generative Apps](../../core/generative-apps.md) owns the distinction between reusable definition templates and live app data. [Kernel Data Operations](../../specs/20260908-generative_kernel_data_operations.md) owns bounded declarative schema evolution, catalog activation and snapshot rollback. [Storage Layout](../../specs/20260703-storage_layout_record_ownership.md) and [Workspace Portability](../../specs/20260704-workspace_backup_export_import.md) retain physical and portable ownership. The engineer-approved coordinator assignment of 2026-10-17 permits new collections, new optional fields, stable-identity rename and field removal only. No scripts, no-code feature, new catalog mechanism, BWM work or physical Worker delivery is included.

## Implementation Boundary

Extend the existing ResourceCatalogDocument publication and reference rules with inline immutable definition versions. A catalog pin/default selects a template; explicit instantiation or activation uses the same native Kernel admission as direct authoring. Collection and field identities are assigned once by that admission and shared across reusable versions. The app database retains actual schema_digest as its active definition marker, kernel_format_version and optional catalog-source provenance. Template revisions do not mutate live data automatically.

Publish a complete SQLite-consistent snapshot before definition DDL or supported kernel-format upgrade. Definition DDL, active definition and existing receipt use the current app transaction. Kernel-format DDL and marker use the existing native journal; command outcome follows, with truthful inspection on interruption. Snapshot restore atomically places a validated consistent copy, discards later data by explicit request and advances app revision. An older restored format stays unavailable until explicit supported upgrade. No down migration, repair runner, generic fence or extra ledger is added.

## Verification And Checkpoint

Implementation is integrated on lane/go from three isolated Builder branches for catalog reuse, native migrations and the existing Web Catalog projection. Primary owns owner text, API/CLI/Web integration and final acceptance. Lowest-sufficient regressions cover catalog history/selection/portability, supported schema changes, refusal without writes, snapshot failure, actual restore/restart and journal upgrade. Observed component checks pass: catalog joins44, native migration owner33 across6files, hot backup19, public lifecycle1, Worker MCP3, Web unit7 and isolated browser1. Complete App API367, Core Client99 and root CLI/disposition99 pass preflight. Exact-head package/owner suites, generated projections and full Web e2e remain the landing gate; final evidence belongs to the external lane checkpoint and independent review. No exact-gate success is claimed by these component results.

## Next Action

The helper branches are normally merged; public operations, generated projections and the Workspace Catalog controls are integrated. Finish the exact local gate and independent review, then express-land only on green main. B01 intake is complete outside the repository; BWM remains held and physical Worker Skill delivery waits for P17.

## Reachable Review Corrections

Hot data-root backup must preserve sealed recovery snapshot bytes. SQLite online backup rewrites their headers and invalidates exact snapshot digests, so recovery copies are excluded from the live-database backup loop and stay in the ordinary exact file copy. The regression restores a hot backup and then restores its app snapshot to recover a removed value.

A reusable entry can have history without a selected default. A later new revision must name an explicit retained parent in that case; Web passes the inspected chosen version as parent only when its entry ID matches the authored import target. This keeps stable identities independent of default activation, while exact admitted reimport retains original version facts.
