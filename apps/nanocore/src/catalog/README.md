# Resource Catalog

This directory owns the existing scoped catalog records and immutable installed Skill, MCP and Agent Plugin snapshots. It does not own Worker execution, permissions, Vault secrets or a learning runner.

## Boundaries

- `resource-catalog.ts` validates retained catalog authority, admits complete bounded trees and publishes one revision-protected catalog document. Exact version digests identify installed bytes; producer and source provenance explain their origin without granting current access.
- `validateCatalogTree` normalizes physical ancestor directories and applies the existing bounded tree validator and hash without filesystem effects. Direct Skill admission and Artifact admission use this same boundary.
- `catalog-tree.ts` holds that stateless transport preparation separately from catalog storage, so caller-side local uploads use the same validation without importing database or publication code.
- New Skill admission requires a UTF-8 root `SKILL.md` with valid Agent Skills metadata. The shared ecosystem header parser accepts descriptive names and metadata without requiring a directory-name match. Metadata validation changes no bytes and grants no tool authority. Historical content inspection continues to use retained exact bytes.
- Skill admission records the original package digest, member key and source subpath, or the exact base digest for an independent candidate. Reusing identical content in one entry returns its existing immutable version facts; later imports do not rewrite those facts or the original PluginVersion membership. Retained descriptive annotations remain in storage and do not enter public results.
- Ecosystem acquisition records the sanitized source locator and exact resolved Git commit in the existing version provenance. Uploads and direct downloads do not invent a Git commit. Same-entry identical-byte admission retains its first provenance.
- `catalog-operations.ts` joins the shared Operation Definitions to these native owners. Current read, write and configuration authority, command receipts and Audit retain their existing owners.
- `skill-inspection.ts` reads exact metadata and file bytes and compares verified inventories. Binary differences retain path, size and digest. Reads use retained snapshots without upstream lookup.
- Candidate submission publishes content lineage and the request in one catalog revision. Promotion retains exact actor, Audit reference and decision time. Public default and pin mutations name their expected prior digest. Removal clears the default and blocks later activation while retaining history and pins.
- Decision Audit and external retention evidence enter through `CatalogOperationHooks`. Missing decision evidence fails before mutation. Purge reports exact catalog references and refuses missing external retention authority. `skill-retention.ts` joins existing retained AEP snapshots and unexpired evidence or legal holds; their owners alone decide when those references end. The existing receipt owner must retain partial purge admission for inspection.
- Each version records `retained` or `purged` payload availability separately from immutable provenance. Export carries purged metadata without a payload, and refuses missing retained content. Explicit identical-byte admission can restore a purged payload without changing original version facts.
- `catalog-portability.ts` preserves installed bytes and historical lineage through the existing Workspace portability boundary. Imported historical selection or review evidence grants no target authority.
- `turn.start` may select exact versions of Skills already in the composed setup through optional `skillSelections`. The canonical Turn retains this work input. AEP resolution uses run, composed exact version, pin, then current default, and records `selectionSource: run` without moving a shared pointer.
- Runtime setup and AEP resolve exact versions before materialization. Catalog mutation does not change files in an admitted AgentSession or prove real Worker consumption.
- P20 completion still requires receipt/Audit integration, authorized Artifact-origin submission, complete external retention checks and real Worker delivery. Component tests do not establish those boundaries or the real BWM loop. Server catalog scope is an additive shared-owner integration with L-GA; it does not create a second catalog.

## Verification

Run the affected `resource-catalog`, durable-write, catalog-operation and portability tests with one Vitest worker, then the package checks in the parent guide. Use the machine-wide CPU slot for heavy commands. A real Worker consumption claim also needs exact AEP/materialization and output evidence from the authorized runtime environment.

The [Skill owner](../../../../docs/specs/20260711-skill_catalog_versioning_pinning.md), [Plugin owner](../../../../docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md) and [MCP owner](../../../../docs/specs/20260907-mcp_catalog_management.md) define the contracts.

The ecosystem import conventions follow the pinned MIT source documented in THIRD-PARTY-NOTICES.md. skill-source.ts parses locators and YAML without network, process execution or authority. Native import stages Git or bounded download supply only inside a fresh authorized command, then rechecks current authority and revision before publication. A completed receipt replays retained metadata without upstream access. No upstream CLI or telemetry runs.

Source acquisition components stage a complete bounded package before catalog admission. `skill-local-source.ts` belongs to the explicitly authorized caller filesystem boundary and must never accept a remote caller's Core host path. `skill-git-source.ts` reads an exact resolved commit with ordinary Git plumbing, no checkout, hooks or ambient Git credentials; its temporary repository is removed after staging. `catalog.skill-update-check` uses retained source provenance and reports changed, unchanged or unavailable without importing, activating or moving a pin. Local caller adaptation and physical Worker delivery remain incomplete until their native checks pass.
