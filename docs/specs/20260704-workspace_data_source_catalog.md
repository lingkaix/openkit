---
status: Accepted
implementation: Partial
updated: 2026-08-22
---
# Workspace Data Source Catalog

## Owns

- The workspace-owned catalog of named external and local data sources available to agent work in one workspace.
- The `WorkspaceDataSource` record shape, its lifecycle, and its storage location.
- The rule that endpoint-bearing sources are declared once in the catalog and referenced by name from agent manifests.
- The resolution contract that joins manifest source references with catalog entries, vault grants, and policy.
- Source-level lineage requirements for materialization, audit, and usage records.
- The requirement that Git sources used by a remote Agent Runtime are network-addressable and that large static sources use an accepted external object-store source contract instead of NanoCore-hosted bytes.

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

## Related Docs

- `docs/specs/20260703-schema_evolution_record_envelope.md`

## Summary

An OpenKit workspace is not a folder. Work data may live in a network-addressable Git repository, an object-store prefix, a provider file API, or bounded OpenKit-owned records and Artifacts, and the same source is typically used by several agents across many turns.

Today the only place that can describe such a source is the `workspace` section of each agent manifest, which would force every manifest to embed endpoint details and would spread authorization, audit, and configuration for one data source across N documents.

This spec separates three questions that the manifest currently answers alone: what data exists (the workspace source catalog, owned here), what one agent gets (manifest source references bound to slots), and how bytes move (materialization strategy, owned by the session-static workspace spec).

The Workspace is the logical governance and source boundary, not one filesystem directory or a promise that NanoCore holds a complete local copy. One Workspace may register network-addressable Git repositories, object or provider-file sources, and other supported external sources while bounded canonical NanoCore records, Knowledge, Artifacts, uploads, and generated context remain with their existing owners. Registration makes a source selectable under current authority; it does not copy source bytes, expose the source to every Agent, include it in every Turn, authorize external writeback, or turn NanoCore into the registered source's storage service.

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
- No large-data lazy-access contract or unversioned object-manifest contract; both remain backlog under their future source and materialization owners.
- No host-local unpublished Git repository as an Agent Runtime source and no NanoCore-hosted Git or object-storage service.

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
- A `git` locator used by an Agent Runtime MUST contain a network-addressable repository URL and an explicit ref or immutable commit narrowing. A NanoCore host path, `repositoryResourceId` that resolves only to such a path, unpublished local commit, bundle fallback, or implicit host checkout is not a valid runtime locator.
- Source data that exceeds an accepted bounded NanoCore record, upload, Artifact, evidence, or handoff contract MUST use an external object-store or provider-file source. NanoCore stores only its non-secret locator, policy, and immutable version or digest lineage.
- `access` is the maximum access class the source permits (`read-only` or `read-write`); slots and manifests may narrow it but never widen it.
- `allowedSlotKinds` restricts which slot kinds may receive this source.
- `status` is `active` or `disabled`; there is no soft-deleted state — removal is deletion plus audit record.
- Entries follow the envelope evolution rules: unknown optional fields tolerated, unsupported `requiredFeatures` fail closed, `extensions` namespaced and non-authoritative.

## Contract / Expected Behavior

- Endpoint-bearing source kinds (`git` with remote URL, `s3`, `r2`, `gcs`, `azure-blob`, `box`, `s3-files`, `http-archive`) MUST be catalog entries. Agent manifests MUST NOT declare them inline.
- Git clone, fetch, checkout, branch, commit, push, and hosting operations execute inside the Sandbox through its Git or hosting client under the resolved network and Vault policy. NanoHost may allow or deny the required network flow but MUST NOT interpret Git, repository, branch, commit, push, or pull-request semantics.
- Workspace-relative inputs (`workspace-file`, `workspace-dir`), `generated` content, `openkit-artifact` references, and `openkit-upload` references MAY remain inline in manifests and requests because they carry no endpoint or credential surface; they resolve by OpenKit id and digest, not through this catalog.
- Manifest workspace inputs reference catalog sources by `sourceRef` plus optional narrowing: subpath, ref or commit, object list, or file filter. Narrowing MUST stay inside the source's declared scope and access class.
- Resolution joins `sourceRef` with the catalog entry, the vault grant behind `vaultGrantRef`, and policy. A missing, disabled, grant-lacking, or policy-denied source produces a blocked readiness diagnostic with the matching remediation category; resolution never silently substitutes another source.
- The resolved AEP snapshot records the source id, the resolved narrowing, and the catalog entry digest, so a later catalog edit never silently changes what a launched session was granted.
- `TurnWorkspaceMaterialization`, workspace input snapshots, capability calls, and audit or usage rows that touch a source MUST carry the source id in lineage; source-level questions such as who read the research corpus last week MUST be answerable from lineage without parsing locators.
- Disabling or deleting a source MUST NOT retroactively invalidate completed records; it blocks future resolution only. Active sessions using the source are marked stale for reuse per the session compatibility rules when the source or its grant is revoked.
- Catalog edits are audited workspace config changes; edits that change `access`, `sensitivity`, `vaultGrantRef`, or `kind` are authority-bearing.

## Source Selection, Authority, And Lifecycle

Source registration creates one Workspace-owned `WorkspaceDataSource` with stable source id, supported kind, non-secret locator envelope, access ceiling, sensitivity, optional Vault grant reference, allowed slot kinds, status, and catalog-entry digest. Registration owns configuration identity only. The source's repository commit, object version, published Workspace revision, or other supported content observation remains source-specific lineage owned by the relevant source or capability contract.

A Turn selects only the sources its accepted request needs. Each selection binds the source id and catalog-entry digest, requested narrowing, requested access, effective access, sensitivity, Vault grant reference when present, actor, AEP package, Workspace, Thread, Turn, AgentSession, target slot or capability route, and the strongest supported source-specific revision evidence. Requested narrowing must remain inside the registered locator envelope, and effective access is the lesser of the catalog access ceiling, manifest request, slot access, permission, policy, Vault grant, and backend capability. No layer may widen a narrower predecessor.

Creation and update use the existing reviewed and audited Workspace configuration path. A catalog edit creates a new configuration digest for future resolutions and marks incompatible idle AgentSessions stale for reuse; it does not mutate a pinned Turn or retroactively rewrite completed lineage. Disabling or deleting a source blocks future selection immediately through current admission, while completed records retain source identity and permitted minimal lineage without using the removed source as current authority.

Retry after a missing, disabled, denied, grant-lacking, stale, or dependency-failed resolution is a fresh resolution from the current catalog and authority. NanoCore never substitutes another source, broadens narrowing, falls back to an inline endpoint or host-local path, packages a local checkout as an implicit runtime source, reuses a stale Vault grant, or treats a cached materialization as authorization. Restart reloads the catalog and current grants before new admission; an already admitted active Turn remains pinned to its immutable snapshot unless an owning security or revocation rule interrupts it.

Conflict means duplicate source id, incompatible catalog evolution, narrowing outside the locator envelope, access widening, slot-kind mismatch, sensitivity or policy denial, stale catalog digest, or contradictory source revision evidence. Each conflict fails closed before launch or enters the owning synchronization conflict path after launch. Physical source unavailability produces a typed blocked or failed materialization or capability result and no alternate-source selection.

The catalog is the unique durable authority for registered source configuration. A manifest `sourceRef`, resolved AEP entry, materialization record, audit row, usage row, cache, backend mount, and provider request are projections carrying lineage; none can register, widen, revive, or silently replace a source. Observable acceptance requires registration alone to move no bytes, a Turn to expose only explicitly selected and narrowed sources, every effective access to remain at or below the catalog ceiling, Vault material to remain behind its reference, lineage to preserve both catalog configuration identity and supported source revision evidence, catalog change after launch not to alter the pinned Turn, and every missing or conflicting resolution to fail without substitution. No decision class is not applicable.

## Current Implementation Projection

- The V1 workspace data source catalog slice is implemented for schema, sourceRef, audit, capability-ledger, and downstream-review paths, but the current repository-backed runtime projection is not compliant with the accepted remote-source boundary and keeps this specification Partial.
- `@openkit/config-schema` now owns the first workspace data source catalog contract: `WorkspaceDataSourceCatalogSchema`, `WorkspaceDataSourceSchema`, source kind/access/sensitivity vocabularies, and `parseWorkspaceDataSourceCatalog`. The parser preserves unknown optional fields, rejects duplicate ids, rejects secret-like locator fields and credential-bearing URLs, enforces registered required-feature ids, and fails closed for unsupported required features.
- `@openkit/config-schema` also owns the first pure sourceRef resolver, `resolveWorkspaceDataSourceReference`. It joins a requested source id with a parsed catalog entry, rejects missing or disabled sources, rejects access widening, rejects slot-kind misuse, and returns a launch snapshot containing source id, source kind, non-secret locator, sensitivity, optional vault grant reference, and a stable catalog entry digest.
- The schema and policy catalogs now expose a `data-source` entry for `config/data-sources.jsonc`, so editor hints and config-governance consumers have a package-owned contract to reference.
- NanoCore now loads workspace `config/data-sources.jsonc` files into runtime config snapshots, includes them in runtime config hashing and session-scoped reload diffing, and exposes them through the existing runtime config App API as `workspaces/<workspaceId>/data-sources.jsonc` with kind `data-source`.
- `@openkit/core-client` can list, read, validate, update, and reload the data source catalog through the existing runtime config surface, and the unified `openkit` Skill projects the same surface through its `runtime.file-list`, `runtime.file-read`, `runtime.validate`, `runtime.file-update`, and `runtime.reload` bundled-CLI operations.
- NanoCore AEP resolution can now accept explicit workspace root sourceRef bindings plus a parsed workspace data source catalog and records the resolved source id, source kind, non-secret locator, optional vault grant reference, and catalog entry digest in the worker-visible AEP workspace input source snapshot.
- NanoCore repository upserts currently accept a host `localPath` and mirror `locator.repositoryResourceId` into the workspace data source catalog. That implementation predates the accepted remote Agent Runtime boundary and is not a valid runtime Git locator; it must be replaced rather than transported, bundled, backfilled, or retained through compatibility behavior.
- NanoCore startup currently backfills those private local-path rows into catalog projections. That projection may remain observable only until the repository owner is replaced; it does not authorize launch or source-byte ingress for a remote Agent Runtime.
- NanoCore repository-backed worker turn startup now ensures the selected repository resource has a matching `git` catalog source, captures the parsed catalog and root sourceRef bindings in `TurnStartRuntimeContext`, and passes them through scheduler, orchestrator, WorkerGovernance, and HostAdapter launch paths into the resolved AEP snapshot.
- NanoCore turn orchestration now ingests selected authored manifest `workspace.inputs[].sourceRef` values when their input id matches a materialized workspace root id, and the App API turn-start route passes the parsed workspace catalog from runtime config into the launch context so authored source refs can resolve through the same AEP path.
- NanoCore turn orchestration now resolves matching source refs before creating the turn. Missing catalogs, missing sources, disabled sources, slot-kind denials, and access widening fail closed as `workspace_data_source_blocked` turn-start errors and do not launch a worker.
- NanoCore workspace input snapshots and workspace materialization records now carry `sourceId` when the resolved AEP workspace input came from a catalog source.
- NanoCore runtime config writes now emit workspace-scoped `AuditEvent` rows when a workspace data source catalog edit changes `kind`, `access`, `sensitivity`, or `vaultGrantRef`. The audit row records the source id, changed authority fields, action `data_source_catalog.authority.update`, and a redacted summary without locator or credential material.
- `CapabilityCall` and `UsageRecord` schemas now carry `sourceIds`, and NanoCore's shared capability usage ledger persists those arrays for source-aware producers.
- NanoCore downstream workspace review records now carry source lineage: `WorkspaceChangeSet` supports `sourceId`, and staged review persistence inherits it from the existing materialization record when worker-produced manifests omit it.
- The runtime still stores host-local repository rows and the real-worker acceptance runner still supplies one such path. These are implementation gaps, not accepted storage or materialization authority.
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
2. Replace the host-local repository resource contract with a credential-free remote Git locator and delete the local-path runtime projection without a compatibility path.
3. Extend manifest resolution to resolve `sourceRef` against the catalog with the new remediation categories.
4. Extend materialization lineage to carry source ids.
5. Expose catalog read and edit operations through the App API config surface with audit records.

## Testing Strategy / Acceptance Criteria

- L1: schema tests for valid and invalid entries, secret-like locator rejection, unknown optional field tolerance, and required-feature rejection.
- L2: resolver contract tests for sourceRef joining, narrowing limits, access-class non-widening, and blocked diagnostics for missing, disabled, denied, and grant-lacking sources.
- L3: end-to-end tests proving a Sandbox clones one authorized remote Git source, checks out the exact accepted commit before Agent start, records the catalog entry digest, and carries the source id into materialization and audit records while NanoHost observes only policy-governed network traffic.
- Acceptance: no endpoint-bearing source remains inline in any manifest fixture; no remote Turn accepts a NanoCore host path or unpublished local commit; a catalog edit after launch does not change a running session's granted inputs; every source-backed operation is attributable to the source id; disabling or deleting the source blocks future resolution without rewriting completed records; source data beyond bounded NanoCore owners uses an external object or provider-file source.

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
