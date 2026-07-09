---
id: story-workspace-portability-release
title: Move a workspace between NanoCore deployments
persona: Product evaluator validating workspace portability before release
entrypoint: mcp
default_tool: mcp_stdio
timeout_seconds: 900
requires_real_provider: false
requires_real_codex: false
---

# Move A Workspace Between NanoCore Deployments

## Purpose

Verify that a product evaluator can export a workspace from one NanoCore deployment, import it into another deployment through the OpenKit MCP facade, rebind local-only resources, and inspect enough evidence to trust that portable workspace history moved without leaking secrets or host-local paths.

## Preconditions

- NanoCore and `@openkit/mcp` build outputs exist.
- Two disposable NanoCore data roots can run one after the other or in parallel on dynamic localhost ports.
- The MCP stdio server can connect to each NanoCore instance under test.
- A disposable local Git repository path is available for repository re-binding after import.
- A fake local secret marker may be used for vault re-binding, but real credentials, private account data, and production repository paths are prohibited.
- Lower-level L1-L5 coverage exists for export manifest digest verification, required-feature fail-closed behavior, workspace id reminting, repository metadata redaction, vault reference unbound imports, and Web re-binding controls.
- This story does not require real provider quota, real Codex credentials, GitHub credentials, or external network access.

## Setup

- Start a source NanoCore deployment with a fresh temporary data root.
- Start an MCP stdio server against the source NanoCore deployment.
- Use the default development workspace as the source workspace.
- Seed source workspace state only through public product surfaces or declared setup APIs: one accepted knowledge entry, one linked disposable repository resource, and one vault reference with fake local secret material when the vault backend is available.
- Export the source workspace through `openkit.export_workspace`.
- Copy or otherwise make the server-managed export tree available to the target NanoCore data root without modifying export contents.
- Start a target NanoCore deployment with a different fresh temporary data root.
- Start an MCP stdio server against the target NanoCore deployment.

## User-visible Steps

1. Read source OpenKit status through MCP.
2. Export the source workspace through `openkit.export_workspace`.
3. Read the export response and confirm that it exposes the manifest, checked files, file count, and byte count without exposing the server export directory path.
4. Read target OpenKit status through MCP.
5. Dry-run the import on the target deployment through `openkit.dry_run_workspace_import`.
6. Confirm that the dry-run reports digest verification, checked files, and the expected workspace id availability or collision result without mutating target workspace state.
7. Import the workspace on the target deployment through `openkit.import_workspace`.
8. Read the imported workspace and verify `importedFrom` lineage, source deployment id, source workspace id, export timestamp, and manifest digest.
9. Read imported workspace knowledge and confirm that the seeded accepted knowledge entry is visible in the target deployment.
10. Inspect imported repository resources and confirm that repository metadata is present but host-local source paths are absent and diagnostics require target re-binding.
11. Rebind the imported workspace to the disposable local Git repository path through the product repository-binding surface exposed to the evaluator.
12. Inspect imported vault references when the setup seeded one and confirm that each imported reference is `unbound` until re-bound.
13. Rebind the imported vault reference with fake local secret material through `openkit.rebind_workspace_vault_reference` or the corresponding product surface.
14. Re-read repository diagnostics and vault reference state after re-binding.
15. Collect redacted audit, usage, repository, vault, and import evidence snapshots available through product or declared evidence surfaces.

## Expected Outcomes

- The source export succeeds and returns only portable metadata, not filesystem paths.
- The target dry-run verifies the export tree and does not create or mutate a workspace.
- The target import succeeds and records truthful `importedFrom` lineage.
- The imported workspace preserves portable source-of-truth history such as workspace metadata, threads when present, accepted knowledge, audit history, repository metadata, vault reference metadata, and vault-use evidence when seeded.
- Imported repository resources require target-local re-binding before repository-dependent work can run.
- Imported vault references are unbound until local secret material is supplied in the target deployment.
- Repository and vault re-binding succeed without echoing host-local source paths or secret material into user-visible results.
- No MCP result, App API response, audit summary, evidence snapshot, or diagnostics payload contains raw token, API key, cookie, authorization header, fake secret marker, source data-root path, target data-root path, or source repository path.

## Deterministic Assertions

- `openkit.export_workspace`, `openkit.dry_run_workspace_import`, `openkit.import_workspace`, and `openkit.rebind_workspace_vault_reference` are present in the MCP tool list.
- The export response contains `manifest`, `checkedFiles`, `fileCount`, and `totalBytes`.
- The dry-run response has `mode: dry-run` and does not add an imported workspace to the target workspace list.
- The import response has `mode: imported` and returns an imported workspace id.
- The imported workspace has `importedFrom.sourceWorkspaceId` equal to the source workspace id.
- The imported workspace has `importedFrom.manifestDigest` matching the expected `sha256:<hex>` shape.
- The seeded accepted knowledge title is present after import.
- Imported repository resources do not expose a `localPath` value from the source deployment.
- Imported vault references do not expose backend locators or secret material.
- The final evidence scan contains no fake secret marker or absolute temporary data-root path.

## Evidence To Collect

- Story metadata and final assertion summary.
- Source and target NanoCore health responses.
- MCP tool list excerpt for portability tools.
- Export response, dry-run response, import response, and imported workspace read model.
- Imported knowledge, repository diagnostics, vault reference summaries, and re-binding responses.
- Redacted audit or evidence snapshots showing the import and re-binding actions when available.
- Failure notes that identify whether a failure belongs to product behavior, missing environment capability, blocked localhost binding, missing build output, or story setup.

## Cleanup

- Stop source and target NanoCore processes and MCP processes.
- Remove temporary data roots, copied export trees, disposable repository fixtures, and fake vault material.
- Confirm no real credentials or private paths were written to committed evidence.

## Failure Triage Notes

Any confirmed deterministic defect from this story must be reduced into the lowest-layer regression test that can catch it in L1, L2, L3, L4, or L5. Digest mismatch, unsupported required-feature, or partial-workspace failures should reduce to L2 or L3 coverage. Repository or vault redaction failures should reduce to route, client, Web, or MCP contract coverage. Environment failures such as missing build output, blocked localhost binding, unavailable vault backend, or missing disposable repository setup should be classified separately from product failures.
