# Resource Catalog

This directory owns the existing scoped catalog records and immutable installed Skill, MCP and Agent Plugin snapshots. It does not own Worker execution, permissions, Vault secrets or a learning runner.

## Boundaries

- `resource-catalog.ts` validates retained catalog authority, admits complete bounded trees and publishes one revision-protected catalog document. Exact version digests identify installed bytes; producer and source provenance explain their origin without granting current access.
- Skill versions retain their original PluginVersion membership and candidate base. Reusing identical content in one entry returns its existing immutable version facts; later imports do not rewrite those facts. Plugin membership remains with the exact PluginVersion record.
- `catalog-operations.ts` joins the shared Operation Definitions to these native owners. Current read, write and configuration authority, command receipts and Audit retain their existing owners.
- `catalog-portability.ts` preserves installed bytes and historical lineage through the existing Workspace portability boundary. Imported historical selection or review evidence grants no target authority.
- Runtime setup and AEP resolve exact versions before materialization. Catalog mutation does not change files in an admitted AgentSession or prove real Worker consumption.
- P20 still needs the complete version inspection, comparison, candidate decision, selection, removal and retention lifecycle. Component tests do not establish that feature or the real BWM loop. Server catalog scope is an additive shared-owner integration with L-GA; it does not create a second catalog.

## Verification

Run the affected `resource-catalog`, durable-write, catalog-operation and portability tests with one Vitest worker, then the package checks in the parent guide. Use the machine-wide CPU slot for heavy commands. A real Worker consumption claim also needs exact AEP/materialization and output evidence from the authorized runtime environment.

The [Skill owner](../../../../docs/specs/20260711-skill_catalog_versioning_pinning.md), [Plugin owner](../../../../docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md) and [MCP owner](../../../../docs/specs/20260907-mcp_catalog_management.md) define the contracts.
