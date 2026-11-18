---
status: Accepted
implementation: Partial
kind: boundary
aspect: agent-supply
---
# Workspace Data Source Catalog

This specification owns the Workspace source catalog: registration, source references, and the non-widening join into an admitted Turn.

## Scope

Owns catalog identity, locator envelopes, status, and the rule that a reference cannot widen the registered source.

Does not own Sandbox mounts. Session materialization owns the admitted view.

Does not own Vault material. [Vault Secret Injection](20260703-vault_secret_injection.md) owns it.

Does not own Git execution. The worker runtime owns the admitted worktree.

Does not own shared Server catalogs.

Does not own external publication. A read-write worktree is not publication authority.

Core: [Storage](../core/storage.md), [Agent Supply](../core/agent-supply.md).

## Decision

Each workspace owns a source catalog stored at `config/data-sources.jsonc` under the workspace scope tree.

The catalog is workspace-owned configuration: editing it is a reviewable, audited workspace config change, and it follows the record envelope and evolution rules from the schema evolution spec.

`WorkspaceDataSourceCatalogSchema` in `packages/config-schema/src/source-catalog.ts` is the admitted catalog.

Field rules:

- `id` is a workspace-unique, stable, human-readable identifier; it is the value manifests reference and the value that flows into lineage.
- `kind` uses the source-kind vocabulary of the session-static workspace spec (`git`, `workspace-file`, `workspace-dir`, `s3`, `r2`, `gcs`, `azure-blob`, `box`, `s3-files`, `http-archive`, `openkit-artifact`, and future kinds behind required features).
- `locator` carries non-secret addressing only: URLs, buckets, prefixes, refs, immutable commits, and folder ids. Secret values and tokens are forbidden. Source kinds that admit catalog-bound credentials use `vaultGrantRef`; first-release Git clone and fetch use the separately configured user-injected read-only runtime-env token and no catalog source grant.
- A `git` locator used by an Agent Runtime MUST contain exactly `url` and `commit`. The URL must use credential-free HTTPS without a query or fragment, and the commit must be a full immutable Git object id. A branch name alone is not the materialization identity. A NanoCore host path, `repositoryResourceId` that resolves only to such a path, unpublished local commit, bundle fallback, or implicit host checkout is not a valid runtime locator.
- Source data that exceeds an accepted bounded NanoCore record, upload, Artifact, evidence, or handoff contract MUST use an external object-store or provider-file source. NanoCore stores only its non-secret locator, policy, and immutable version or digest lineage.
- `access` is the maximum access class the source permits (`read-only` or `read-write`); slots and manifests may narrow it but never widen it.
- `allowedSlotKinds` restricts which slot kinds may receive this source.
- `status` is `active` or `disabled`; there is no soft-deleted state — removal is deletion plus audit record.
- Entries follow the envelope evolution rules: unknown optional fields tolerated, unsupported `requiredFeatures` fail closed, `extensions` namespaced and non-authoritative.
- `syncHints` are suggestions only. The materializer may choose a safer strategy. Access, Policy, Vault, and source-version restrictions stay in force.

## Contract / Expected Behavior

- Endpoint-bearing source kinds (`git` with remote URL, `s3`, `r2`, `gcs`, `azure-blob`, `box`, `s3-files`, `http-archive`) MUST be catalog entries. Agent manifests MUST NOT declare them inline.
- Workers use installed Git freely for local work inside the admitted Sandbox. Platform-managed external hosting calls use an explicitly selected vendor MCP server through NanoCore's Gateway, with gateway-held credentials and the MCP owner's authentication, current authorization, configured per-tool approval, and audit. Native Git push is optional user-space configuration requiring a user-injected credential and admitted git-receive-pack egress; OpenKit supplies no additional native-push mechanism. NanoHost enforces admitted Sandbox network policy and does not interpret repository, branch, commit, push, or pull-request semantics. Clone and fetch continue under source-read and network authority. Vendor writes are not performed with an in-Sandbox hosting credential. A private repository clone or fetch requires an explicitly scoped read-only credential. In the first release the user injects that read-only token into the worker environment through the existing runtime-env injection, which is user-space configuration. The platform adds no source-credential mechanism in the first release. The decision and its reason are recorded in [a decision record](../decisions/20261002-hosting_through_gateway_mcp.md).
- Workspace-relative inputs (`workspace-file`, `workspace-dir`), `generated` content, `openkit-artifact` references, and `openkit-upload` references MAY remain inline in manifests and requests because they carry no endpoint or credential surface; they resolve by OpenKit id and digest, not through this catalog.
- Manifest workspace inputs reference catalog sources by `sourceRef` plus optional narrowing: subpath, ref or commit, object list, or file filter. Narrowing MUST stay inside the source's declared scope and access class.
- Resolution joins `sourceRef` with the catalog entry, policy, and an applicable catalog Vault grant when that source kind admits one. A missing, disabled, policy-denied, or required-grant-lacking source produces a blocked readiness diagnostic with the matching remediation category; resolution never silently substitutes another source. First-release private Git clone and fetch require the user's read-only runtime-env credential under the existing worker credential admission, not a catalog source grant.
- The resolved AEP snapshot records the source id, the resolved narrowing, and the catalog entry digest, so a later catalog edit never silently changes what that admitted Turn was granted. The AgentSession keeps the physical slots.
- `TurnWorkspaceMaterialization`, workspace input snapshots, capability calls, and audit or usage rows that touch a source MUST carry the source id in lineage; source-level questions such as who read the research corpus last week MUST be answerable from lineage without parsing locators.
- Disabling or deleting a source MUST NOT retroactively invalidate completed records; it blocks future resolution only. Active sessions using the source are marked stale for reuse per the session compatibility rules when the source or its grant is revoked.
- Catalog edits are audited workspace config changes; edits that change `access`, `sensitivity`, `vaultGrantRef`, or `kind` are authority-bearing. Authority updates use `data_source_catalog.authority.update`, identify the source and changed authority fields, and retain a redacted summary without locator or credential material. [Audit, Usage, And Evidence Records](20260703-audit_usage_evidence_records.md) owns that record.

## Source Selection, Authority, And Lifecycle

The catalog adds no NanoCore-hosted Git or object-storage service. Source registration creates one Workspace-owned `WorkspaceDataSource` with stable source id, supported kind, non-secret locator envelope, access ceiling, sensitivity, optional Vault grant reference, allowed slot kinds, status, and catalog-entry digest. The catalog entry digest sorts object keys locally, keeps array order, and covers the exact admitted entry, including preserved optional metadata. It is not the source content digest and it is not the shared RFC 8785 form. Registration owns configuration identity only. The source's repository commit, object version, published Workspace revision, or other supported content observation remains source-specific lineage owned by the relevant source or capability contract.

A Turn selects only the sources its accepted request needs. Each selection binds the source id and catalog-entry digest, requested narrowing, requested access, effective access, sensitivity, Vault grant reference when present, actor, AEP package, Workspace, Thread, Turn, AgentSession, target slot or capability route, and the strongest supported source-specific revision evidence. Requested narrowing must remain inside the registered locator envelope, and effective access is the lesser of the catalog access ceiling, manifest request, slot access, permission, policy, any applicable Vault grant, and backend capability. No layer may widen a narrower predecessor.

Creation and update use the existing reviewed and audited Workspace configuration path. A catalog edit creates a new configuration digest for future resolutions and marks incompatible idle AgentSessions stale for reuse; it does not mutate a pinned Turn or retroactively rewrite completed lineage. Disabling or deleting a source blocks future selection immediately through current admission, while completed records retain source identity and permitted minimal lineage without using the removed source as current authority.

Retry after a missing, disabled, denied, grant-lacking, stale, or dependency-failed resolution is a fresh resolution from the current catalog and authority. NanoCore never substitutes another source, broadens narrowing, falls back to an inline endpoint or host-local path, packages a local checkout as an implicit runtime source, reuses a stale Vault grant, or treats a cached materialization as authorization. Restart reloads the catalog and current grants before new admission; an already admitted active Turn remains pinned to its immutable snapshot unless an owning security or revocation rule interrupts it.

Conflict means duplicate source id, incompatible catalog evolution, narrowing outside the locator envelope, access widening, slot-kind mismatch, sensitivity or policy denial, stale catalog digest, or contradictory source revision evidence. Each conflict fails closed before launch or enters the owning synchronization conflict path after launch. Physical source unavailability produces a typed blocked or failed materialization or capability result and no alternate-source selection.

Portable export writes the parsed catalog records. Whole-tree backup is a separate owner. The first execution slice admits at most one authored remote input, and only a credential-free Git source with a read-write worktree. Other catalog kinds are registration vocabulary. The catalog is the unique durable authority for registered source configuration. A manifest `sourceRef`, resolved AEP entry, materialization record, audit row, usage row, cache, backend mount, and provider request are projections carrying lineage; none can register, widen, revive, or silently replace a source. Observable acceptance requires registration alone to move no bytes, a Turn to expose only explicitly selected and narrowed sources, every effective access to remain at or below the catalog ceiling, Vault material to remain behind its reference, lineage to preserve both catalog configuration identity and supported source revision evidence, catalog change after launch not to alter the pinned Turn, and every missing or conflicting resolution to fail without substitution. No decision class is not applicable.

### Source References For Bounded Views

An admitted file reference names its existing logical owner, immutable version/revision, verified original digest, size, media type, and availability. A descriptor or sidecar has a separate representation identity and digest. A raw object URL alone is not an immutable version. Selected product files follow [Turn snapshot materialization](20260704-session_static_workspace_materialization.md#read-only-turn-source-snapshot), without registering a second source or treating a catalog row as acquisition authority.

Future cloud/object adapters must resolve a supported immutable version and verify bytes at their source-owner boundary before snapshot readiness. Missing, changed, stale, denied, or dependency-failed resolution returns the existing typed unavailable/blocked result. It cannot substitute a live object under an old reference. Registration alone still moves no bytes and grants no model input, mount, download, or external writeback.


## Acceptance

A remote Turn does not accept a host path or an unpublished local commit. A catalog edit after admission does not change that Turn's granted inputs. Disabling or deleting a source blocks future resolution and does not rewrite completed records. L3 end-to-end proof uses a Sandbox to clone one authorized remote Git source and check out the exact accepted commit before Agent start; it retains the catalog-entry digest and source id in materialization and Audit records, while NanoHost observes only policy-governed network traffic. This states required proof. It does not claim that this proof has run.

## Implementation

- `packages/config-schema/src/`
- `apps/nanocore/src/config/`
- `apps/nanocore/src/runtime/`

## Implementation Gaps

- Source resolution implements supported narrowing and conditional Policy/Vault/grant intersections, and returns a source remediation category - unsupported constraints and unproved current authority are refused before dispatch; richer narrowing, conditional source authority, and remediation categories remain unavailable - #782
- Shared Server and cross-Workspace catalogs - the loader reads the Workspace catalog only - #261

## Decisions

- [Hosting through Gateway MCP](../decisions/20261002-hosting_through_gateway_mcp.md)
