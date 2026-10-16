# Resource Catalog

This directory owns the existing scoped catalog records and immutable installed Skill, MCP and Agent Plugin snapshots. It does not own Worker execution, permissions, Vault secrets or a learning runner.

## Boundaries

- `resource-catalog.ts` validates retained catalog authority, admits complete bounded trees and publishes one revision-protected catalog document. Exact version digests identify installed bytes; producer and source provenance explain their origin without granting current access.
- `validateCatalogTree` normalizes physical ancestor directories and applies the existing bounded tree validator and hash without filesystem effects. Direct Skill admission and Artifact admission use this same boundary.
- New Skill admission requires a UTF-8 root `SKILL.md` with valid Agent Skills metadata. The shared ecosystem header parser accepts descriptive names and metadata without requiring a directory-name match. Metadata validation changes no bytes and grants no tool authority. Historical content inspection continues to use retained exact bytes.
- Skill admission records the original package digest, member key and source subpath, or the exact base digest for an independent candidate. Reusing identical content in one entry returns its existing immutable version facts; later imports do not rewrite those facts or the original PluginVersion membership. Retained descriptive annotations remain in storage and do not enter public results.
- `catalog-operations.ts` joins the shared Operation Definitions to these native owners. Current read, write and configuration authority, command receipts and Audit retain their existing owners.
- `skill-inspection.ts` reads exact metadata and file bytes and compares verified inventories. Binary differences retain path, size and digest. Reads use retained snapshots without upstream lookup.
- Candidate submission publishes content lineage and the request in one catalog revision. Promotion retains exact actor, Audit reference and decision time. Public default and pin mutations name their expected prior digest. Removal clears the default and blocks later activation while retaining history and pins.
- Decision Audit and external retention evidence enter through `CatalogOperationHooks`. Missing decision evidence fails before mutation. Purge reports exact catalog references and refuses missing external retention authority. The existing receipt owner must retain partial purge admission for inspection.
- Each version records `retained` or `purged` payload availability separately from immutable provenance. Export carries purged metadata without a payload, and refuses missing retained content. Explicit identical-byte admission can restore a purged payload without changing original version facts.
- `catalog-portability.ts` preserves installed bytes and historical lineage through the existing Workspace portability boundary. Imported historical selection or review evidence grants no target authority.
- Runtime setup and AEP resolve exact versions before materialization. Catalog mutation does not change files in an admitted AgentSession or prove real Worker consumption.
- P20 completion still requires receipt/Audit integration, authorized Artifact-origin submission, complete external retention checks and real Worker delivery. Component tests do not establish those boundaries or the real BWM loop. Server catalog scope is an additive shared-owner integration with L-GA; it does not create a second catalog.

## Verification

Run the affected `resource-catalog`, durable-write, catalog-operation and portability tests with one Vitest worker, then the package checks in the parent guide. Use the machine-wide CPU slot for heavy commands. A real Worker consumption claim also needs exact AEP/materialization and output evidence from the authorized runtime environment.

The [Skill owner](../../../../docs/specs/20260711-skill_catalog_versioning_pinning.md), [Plugin owner](../../../../docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md) and [MCP owner](../../../../docs/specs/20260907-mcp_catalog_management.md) define the contracts.

The ecosystem import conventions follow the pinned MIT source documented in THIRD-PARTY-NOTICES.md. skill-source.ts parses locators and YAML without network, process execution or authority; acquisition and discovery still require the existing authenticated import boundary. No upstream CLI or telemetry runs.
