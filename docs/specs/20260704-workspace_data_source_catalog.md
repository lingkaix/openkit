# Workspace Data Source Catalog

Status: Accepted
Implementation: Implemented

## Owns

- The workspace-owned catalog of named external and local data sources available to agent work in one workspace.
- The `WorkspaceDataSource` record shape, its lifecycle, and its storage location.
- The rule that endpoint-bearing sources are declared once in the catalog and referenced by name from agent manifests.
- The resolution contract that joins manifest source references with catalog entries, vault grants, and policy.
- Source-level lineage requirements for materialization, audit, and usage records.

## Does Not Own

- Slot kinds, session-static layout, and turn materialization strategy, which belong to `docs/specs/20260704-session_static_workspace_materialization.md`.
- Manifest schema, resolution order, and AEP snapshot content, which belong to `docs/specs/20260703-agent_manifest_aep_resolution.md`.
- Workspace synchronization lifecycle records, which belong to `docs/specs/20260703-workspace_synchronization.md`.
- Vault reference, grant, and injection semantics, which belong to `docs/specs/20260703-vault_secret_injection.md`.
- Physical storage tree ownership, which belongs to `docs/specs/20260703-storage_layout_record_ownership.md`.
- Provider-specific sync implementations, object-store APIs, and Git hosting integration.

## Core References

- `docs/core/storage.md`
- `docs/core/agent-supply.md`
- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`

## Summary

An OpenKit workspace is not a folder. Work data may live in a local directory, a Git repository, an object-store prefix, or a provider file API, and the same source is typically used by several agents across many turns.

Today the only place that can describe such a source is the `workspace` section of each agent manifest, which would force every manifest to embed endpoint details and would spread authorization, audit, and configuration for one data source across N documents.

This spec separates three questions that the manifest currently answers alone: what data exists (the workspace source catalog, owned here), what one agent gets (manifest source references bound to slots), and how bytes move (materialization strategy, owned by the session-static workspace spec).

## Goals / Non-goals

Goals:

- Declare each data source once per workspace, with its access class, sensitivity, credential grant reference, and policy constraints attached at the source.
- Keep agent manifests portable: manifests reference sources by name and never embed endpoints or credential material.
- Give NanoCore one stable structure for managing how different work data is connected, regardless of transport.
- Make source use auditable at the source level through lineage.

Non-goals:

- No server-global or cross-workspace source catalog in the first slice.
- No new transport or sync strategies; strategies remain owned by the materialization spec.
- No secret material in catalog entries; credentials stay behind vault grant references.
- No external writeback semantics; write-back remains owned by slot write-back policy.

## Background

Claude Code and Codex treat a workspace as one folder whose root carries agent instructions. The OpenAI sandbox SDK generalizes workspace inputs into a fresh-session manifest covering files, directories, repositories, and mounts for S3, GCS, R2, Azure Blob, Box, and object manifests. OpenKit goes further: the workspace is a durable configured entity, work files live under declared slots inside worker sessions, and inputs may be remote. That makes a per-workspace source catalog the natural owner of "what data exists here," mirroring how provider instances already own "what credentials exist" one level below.

## Decision

Each workspace owns a source catalog stored at `config/data-sources.jsonc` under the workspace scope tree.

The catalog is workspace-owned configuration: editing it is a reviewable, audited workspace config change, and it follows the record envelope and evolution rules from the schema evolution spec.

Conceptual shape:

```jsonc
{
  "schemaVersion": 1,
  "requiredFeatures": [],
  "sources": [
    {
      "id": "main-repo",
      "kind": "git",
      "displayName": "Main application repository",
      "locator": { "url": "https://github.com/acme/app.git", "defaultRef": "main" },
      "access": "read-write",
      "sensitivity": "internal",
      "vaultGrantRef": "vg_github_ci",
      "allowedSlotKinds": ["worktree"],
      "syncHints": { "strategy": "checkout" },
      "status": "active",
      "requiredFeatures": [],
      "extensions": {}
    },
    {
      "id": "research-data",
      "kind": "r2",
      "displayName": "Research corpus",
      "locator": { "bucket": "acme-research", "prefix": "papers/" },
      "access": "read-only",
      "sensitivity": "internal",
      "vaultGrantRef": "vg_r2_research",
      "allowedSlotKinds": ["data"],
      "status": "active"
    }
  ]
}
```

Field rules:

- `id` is a workspace-unique, stable, human-readable identifier; it is the value manifests reference and the value that flows into lineage.
- `kind` uses the source-kind vocabulary of the session-static workspace spec (`git`, `workspace-file`, `workspace-dir`, `s3`, `r2`, `gcs`, `azure-blob`, `box`, `s3-files`, `http-archive`, `openkit-artifact`, and future kinds behind required features).
- `locator` carries non-secret addressing only: URLs, buckets, prefixes, refs, folder ids. Secret values and tokens are forbidden; credentials attach through `vaultGrantRef`.
- `access` is the maximum access class the source permits (`read-only` or `read-write`); slots and manifests may narrow it but never widen it.
- `allowedSlotKinds` restricts which slot kinds may receive this source.
- `status` is `active` or `disabled`; there is no soft-deleted state — removal is deletion plus audit record.
- Entries follow the envelope evolution rules: unknown optional fields tolerated, unsupported `requiredFeatures` fail closed, `extensions` namespaced and non-authoritative.

## Contract / Expected Behavior

- Endpoint-bearing source kinds (`git` with remote URL, `s3`, `r2`, `gcs`, `azure-blob`, `box`, `s3-files`, `http-archive`) MUST be catalog entries. Agent manifests MUST NOT declare them inline.
- Workspace-relative inputs (`workspace-file`, `workspace-dir`), `generated` content, `openkit-artifact` references, and `openkit-upload` references MAY remain inline in manifests and requests because they carry no endpoint or credential surface; they resolve by OpenKit id and digest, not through this catalog.
- Manifest workspace inputs reference catalog sources by `sourceRef` plus optional narrowing: subpath, ref or commit, object list, or file filter. Narrowing MUST stay inside the source's declared scope and access class.
- Resolution joins `sourceRef` with the catalog entry, the vault grant behind `vaultGrantRef`, and policy. A missing, disabled, grant-lacking, or policy-denied source produces a blocked readiness diagnostic with the matching remediation category; resolution never silently substitutes another source.
- The resolved AEP snapshot records the source id, the resolved narrowing, and the catalog entry digest, so a later catalog edit never silently changes what a launched session was granted.
- `TurnWorkspaceMaterialization`, workspace input snapshots, capability calls, and audit or usage rows that touch a source MUST carry the source id in lineage; source-level questions such as who read the research corpus last week MUST be answerable from lineage without parsing locators.
- Disabling or deleting a source MUST NOT retroactively invalidate completed records; it blocks future resolution only. Active sessions using the source are marked stale for reuse per the session compatibility rules when the source or its grant is revoked.
- Catalog edits are audited workspace config changes; edits that change `access`, `sensitivity`, `vaultGrantRef`, or `kind` are authority-bearing.

## Current Implementation Projection

- The V1 workspace data source catalog slice is implemented for the current repository-backed sourceRef, materialization, audit, capability-ledger, and downstream-review paths.
- `@openkit/config-schema` now owns the first workspace data source catalog contract: `WorkspaceDataSourceCatalogSchema`, `WorkspaceDataSourceSchema`, source kind/access/sensitivity vocabularies, and `parseWorkspaceDataSourceCatalog`. The parser preserves unknown optional fields, rejects duplicate ids, rejects secret-like locator fields and credential-bearing URLs, enforces registered required-feature ids, and fails closed for unsupported required features.
- `@openkit/config-schema` also owns the first pure sourceRef resolver, `resolveWorkspaceDataSourceReference`. It joins a requested source id with a parsed catalog entry, rejects missing or disabled sources, rejects access widening, rejects slot-kind misuse, and returns a launch snapshot containing source id, source kind, non-secret locator, sensitivity, optional vault grant reference, and a stable catalog entry digest.
- The schema and policy catalogs now expose a `data-source` entry for `config/data-sources.jsonc`, so editor hints and config-governance consumers have a package-owned contract to reference.
- NanoCore now loads workspace `config/data-sources.jsonc` files into runtime config snapshots, includes them in runtime config hashing and session-scoped reload diffing, and exposes them through the existing runtime config App API as `workspaces/<workspaceId>/data-sources.jsonc` with kind `data-source`.
- `@openkit/core-client` can list, read, validate, update, and reload the data source catalog through the existing runtime config surface, and the unified `openkit` Skill projects the same surface through its `runtime.file-list`, `runtime.file-read`, `runtime.validate`, `runtime.file-update`, and `runtime.reload` bundled-CLI operations.
- NanoCore AEP resolution can now accept explicit workspace root sourceRef bindings plus a parsed workspace data source catalog and records the resolved source id, source kind, non-secret locator, optional vault grant reference, and catalog entry digest in the worker-visible AEP workspace input source snapshot.
- NanoCore repository upserts now mirror the repository resource into the workspace data source catalog as a `git` source using `locator.repositoryResourceId`; the raw host `localPath` remains only in the private workspace SQLite repository row and is not written to `data-sources.jsonc`.
- NanoCore startup now backfills pre-existing workspace repository resource rows into `config/data-sources.jsonc` using the same `git` source projection as repository upserts, so old rows converge without a second catalog-writing rule.
- NanoCore repository-backed worker turn startup now ensures the selected repository resource has a matching `git` catalog source, captures the parsed catalog and root sourceRef bindings in `TurnStartRuntimeContext`, and passes them through scheduler, orchestrator, WorkerGovernance, and HostAdapter launch paths into the resolved AEP snapshot.
- NanoCore turn orchestration now ingests selected authored manifest `workspace.inputs[].sourceRef` values when their input id matches a materialized workspace root id, and the App API turn-start route passes the parsed workspace catalog from runtime config into the launch context so authored source refs can resolve through the same AEP path.
- NanoCore turn orchestration now resolves matching source refs before creating the turn. Missing catalogs, missing sources, disabled sources, slot-kind denials, and access widening fail closed as `workspace_data_source_blocked` turn-start errors and do not launch a worker.
- NanoCore workspace input snapshots and workspace materialization records now carry `sourceId` when the resolved AEP workspace input came from a catalog source.
- NanoCore runtime config writes now emit workspace-scoped `AuditEvent` rows when a workspace data source catalog edit changes `kind`, `access`, `sensitivity`, or `vaultGrantRef`. The audit row records the source id, changed authority fields, action `data_source_catalog.authority.update`, and a redacted summary without locator or credential material.
- `CapabilityCall` and `UsageRecord` schemas now carry `sourceIds`, and NanoCore's shared capability usage ledger persists those arrays for source-aware producers.
- NanoCore downstream workspace review records now carry source lineage: `WorkspaceChangeSet` supports `sourceId`, and staged review persistence inherits it from the existing materialization record when worker-produced manifests omit it.
- The runtime still stores workspace repository resources as private rows and passes non-catalog inputs through per-launch configuration.
- Existing workspace repository resource rows remain the private storage precursor of repository-backed `git` catalog entries; startup backfill maps each row id to the same source id and keeps raw paths out of the catalog.
- `config/data-sources.jsonc` is listed in the target workspace tree in `docs/specs/20260703-storage_layout_record_ownership.md`.

## Alternatives Considered

- Keep sources inline in each manifest: rejected; duplicates endpoints and credentials-adjacent config across manifests, makes source-level authorization and audit impossible to state once, and breaks manifest portability.
- Server-global source catalog: rejected for the first slice; sources are workspace working context, and a server catalog would blur workspace isolation and complicate export and deletion. A future shared catalog can arrive as a separate scope with explicit sharing semantics.
- Fold the catalog into `workspace.jsonc`: rejected; a separate file keeps a high-churn, reviewable surface out of general workspace config and gives it its own schema version and evolution path.

## Consequences

- One data source is declared, authorized, and audited once, and every manifest that needs it stays a one-line reference.
- NanoCore gains the stable management structure for heterogeneous work-data connections that the product design calls for; transports remain swappable underneath.
- Workspace export and backup naturally include the catalog because it lives in the workspace scope tree.
- Manifests get simpler and lose their last reason to carry endpoint detail.

## Rollout / Migration Plan

1. Add the catalog schema and loader with envelope validation.
2. Migrate workspace repository resource rows into catalog entries during the storage-layout migration.
3. Extend manifest resolution to resolve `sourceRef` against the catalog with the new remediation categories.
4. Extend materialization lineage to carry source ids.
5. Expose catalog read and edit operations through the App API config surface with audit records.

## Testing Strategy / Acceptance Criteria

- L1: schema tests for valid and invalid entries, secret-like locator rejection, unknown optional field tolerance, and required-feature rejection.
- L2: resolver contract tests for sourceRef joining, narrowing limits, access-class non-widening, and blocked diagnostics for missing, disabled, denied, and grant-lacking sources.
- L3: end-to-end tests proving a manifest referencing a catalog source launches with the source materialized into an allowed slot, the AEP records the catalog entry digest, and lineage carries the source id into materialization and audit records.
- Acceptance: no endpoint-bearing source remains inline in any manifest fixture; a catalog edit after launch does not change a running session's granted inputs; source-level audit queries resolve from lineage alone.

## Risks & Mitigations

- Risk: the catalog becomes a dumping ground of stale sources. Mitigation: `status` lifecycle plus Knowledge-Manager-style scheduled health checks can flag unused or grant-broken entries.
- Risk: narrowing rules are bypassed by clever locators. Mitigation: narrowing is validated against the declared scope at resolution time, and materialization records prove what was actually exposed.
- Risk: workspace-relative inline inputs get abused to smuggle endpoints. Mitigation: inline kinds are restricted to the non-endpoint list and validated strictly.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: per-source `syncHints` are suggestions only, and the materializer may choose a safer strategy; user-scope personal sources and user-scope catalogs are deferred until cross-workspace source ownership, tenancy, and revocation semantics are designed.

## Deferred / Future Work

- Cross-workspace and server-shared source catalogs with explicit sharing semantics.
- Source health probing and freshness metadata for object-store sources.
- External writeback policy per source, coordinated with slot `external-writeback` when that arrives.

## Links

- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
