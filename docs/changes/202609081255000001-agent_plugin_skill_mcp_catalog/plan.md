---
type: change-plan
status: in-progress
date: 2026-09-08
branch: feat/agent-plugin-skill-mcp-catalog
---
# Agent Plugin, Skill, And MCP Catalog Implementation

This record preserves intent and execution evidence. Design authority remains with the accepted owners, not this record.

## Intent Epoch 1

Source: the engineer's September 8 request after MCP Gateway merged to main. English translation of the consequential direction: create a new branch and pull request that lands the uncommitted Agent Plugin, MCP catalog, and Skill Catalog designs as a complete user-facing capability, including the Web surface. Independent Claude Code Consultant (opus, xhigh) and Codex Reviewer, Verifier, and Auditor (gpt-6-astra, high) are required. The engineer authorizes a GitHub pull request through `gh`.

Acceptance is the accepted contracts in `docs/specs/20260711-skill_catalog_versioning_pinning.md`, `docs/specs/20260907-mcp_catalog_management.md`, and `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`, plus aligned Storage, AEP, Gateway, NanoHost, Skill/CLI, Web, and portability owners. Native Codex plugin loading is advertised only with direct proof; otherwise the thin adapter path is the honest product claim.

## Owners

- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/specs/20260907-mcp_catalog_management.md`
- `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`
- `docs/core/agent-supply.md`, `docs/core/storage.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260628-web_product_surface_projection.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`

## Working Checkpoint

Current facts: Consultant verdict is Continue. Workspace MCP authority is `workspaces/<id>/catalog/catalog.json`. Skill supply is catalog-resolved and imported through the existing `worker-supply` identity. Codex uses a thin Skill-directory plus loopback-MCP adapter; native plugins are not advertised. Web publishes one Catalog workflow.

Method: one catalog document per scope; Skill, MCP, and Plugin modules own their records inside it; Gateway keeps the effective-entry executor; Codex uses the thin Skill-directory plus loopback-MCP adapter unless native plugin isolation is proved on 0.153.4; Web publishes one Catalog workflow, not an API console.

Independent Reviewer verdict: Request changes. Independent Verifier verdict: Not verified (oracle gaps). Independent Auditor verdict: Do not ship. Producer closed Safety Kernel blockers for upload containment, stdio current-selection authority, HTTP redirect rejection, MCP tool-policy preservation, catalog-authority loss, portable inventory agreement, grouped plugin publication, plugin package-root lineage, and raw-secret admission.

Next Action: focused re-verification of the closed blockers, then pull request with residual-risk disclosure for L6 real-worker proof, ambient Codex skills, audit-ledger/request receipts, exact installation-to-setup expansion, and incomplete management operations.
