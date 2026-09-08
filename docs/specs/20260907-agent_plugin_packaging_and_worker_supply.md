---
status: Accepted
implementation: Partial
updated: 2026-09-08
---
# Agent Plugin Packaging And Worker Supply

## Owns

- Agent Plugins as OpenKit's public package and declaration format for standard Skills and MCP components.
- Plugin package identity, immutable membership and provenance, grouped import/install/update/remove, and composition with the independent component catalogs.
- Resource-supply requirements for existing AEP delivery, Sandbox Integration, and runtime adapters, including native package loading or thin component projection.

## Does Not Own

- Skill version/candidate/promotion semantics or MCP configuration/Gateway semantics, which remain with their component owners.
- A full Agent Plugins client conformance project, marketplace, dependency resolver, plugin executable lifecycle, background updater, or new worker runtime.
- Vendor-specific hooks, rules, agents, commands, variables, or extension behavior.
- Authored Agent setup, AEP, session lifecycle, transport, permissions, Vault, or source-repository hosting.

## Core References

- `docs/core/foundation.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-capability.md`
- `docs/core/storage.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

## Summary

A user installs one public Agent Plugin package to add multiple Skills and MCP resources to the catalog, inspect their source and versions, and manage the installation as a group. The resources remain independently addressable: a Skill may gain an improved version without altering its source package, and an MCP integration may evolve independently.

The public standard defines packaging and declarations only. OpenKit defines catalog ownership, trust, selection, versioning, delivery, and management. NanoCore resolves exact permitted resources, and Sandbox Integration supplies them to the worker through existing adapters. Native package support is reused when it can consume that governed projection; otherwise the adapter installs the standard components directly.

## Goals / Non-goals

Cover standalone resource creation plus community package import, grouped management, exact source/version lineage, worker delivery, native discovery, and observable use. Limit portable components to Skills and MCP. Do not implement client-specific extensions merely because a runtime can load them, and do not build or maintain third-party integrations that can be supplied by their existing publishers.

## Background

The selected MCP Gateway is implemented. Worker Skill supply and package installation are missing. Treating every resource as a package-owned version would obstruct independent Skill improvement; treating three catalogs as separate writable copies would make management inconsistent. This design supplies a thin package composition layer over the two component owners.

## Decision

- Use published Agent Plugins 1.0.0 package declarations, with locally recognized versioned schemas, root `plugin.json`, standard `skills/`, and standard `mcp.json` locations.
- Keep optional publisher labels and always compute an exact local package digest. A PluginVersion binds exact component versions, never `current` or an inferred publisher range.
- User installation targets one Workspace. Server-owned supply can be projected read-only; no user-global or cross-Workspace install is implicit.
- Keep original package bytes distinct from the worker's generated supply bundle. The worker receives selected Skill files and Gateway-only MCP declarations, not the community package's raw executable configuration.

## Contract / Expected Behavior

### Package identity, members, and composition

A `PluginEntry` has scoped stable identity and descriptive metadata. A `PluginVersion` records the original package tree digest, digest format, publisher label if present, immutable source provenance, and a map from each package component key to its exact SkillVersion or McpConfigVersion. Imported content and the original membership map never change. The package uses the Skill specification's `openkit-tree-v1` algorithm over its entire bounded original tree; package metadata and non-activated extension files therefore affect package identity, even though they are not independently activated.

Names from a public package are display/discovery inputs, not authorization or global identities. The importer retains original names and a stable mapping to scoped catalog ids. An id collision with a different source fails with an explicit remapping requirement, never overwrite or lossy name normalization. Same-source update uses its retained mapping; identical re-import is idempotent. Publisher labels are not ordering rules and can repeat across distinct digests.

A Workspace installation records one exact PluginVersion and its selected member references. Each initially selected member matches its exact source-package reference; the explicit selected subset may omit other valid members. Independent Skill or MCP changes create component versions under those owners; they do not rewrite the source PluginVersion. An explicit installation member override may select such a version while retaining the original membership and the override's lineage. Product reads show both the source version and effective selection. A locally recomposed package is a new PluginVersion, not a forged upstream release.

Authored Agent setup may reference a Workspace installation or individual Skill/MCP resources. Before normal setup resolution, a package reference expands to its explicitly selected members under the existing Workspace-binding composition owner. The expansion supplies resource references only, never missing runtime, binary, sandbox, network, credential, or policy declarations. Identical repeated exact members deduplicate; differing exact references to the same scoped resource fail `conflict` unless the authored input explicitly identifies the intended member override. Array order never decides authority.

### Import and package admission

Accept a bounded uploaded package or a package acquired from an exact authorized network-addressable source revision. Use existing upload, source-access, and credential owners; never interpret a remote caller's path as a NanoCore host path. A branch/tag may be an acquisition request, but admission freezes the resolved commit and local bytes before publication. Fetching source, publishing a catalog installation, and launching a worker remain distinct effects.

The package limit is 64 MiB of extracted regular-file bytes, 4,096 filesystem entries including directories, and 32 directory levels; compressed input is capped at 64 MiB before extraction. Apply the Skill owner's path/type/race checks and each Skill's narrower limits. Do not execute install scripts, hooks, bundled programs, dependency installation, or MCP discovery during parsing/import. Record source, license information when supplied, integrity, discovered components, and unsupported requirements. A valid package is not proof of publisher trust or runtime availability.

The package root declaration must be valid for a locally supported public format. Unknown format versions fail package admission. Missing optional component locations are valid. An invalid Skill, individual MCP declaration, or unsupported component is reported at its narrow boundary. Other valid components remain inspectable/importable; an explicitly requested invalid member fails the requested install before publication. The install response distinguishes complete admission from a partial admitted component set and never claims omitted components were installed. Nonstandard extensions remain retained source data only and are never activated or forwarded to a native loader.

The immutable membership map covers every valid discovered component; invalid or unsupported entries remain source diagnostics outside that map. The package import publishes those valid component versions inertly, while an installation separately selects its enabled member subset. Re-importing the same package with a different selection changes only installation state, not the source membership map.

A Skill imports exactly its self-contained directory under its owner. A package-level file outside that directory is not guessed into Skill dependencies. Every plugin-imported stdio MCP uses the original package root; the PluginVersion owns that single source snapshot, and the MCP version references and privately materializes it under its Gateway execution owner. Independent MCP adoption retains that source-tree reference after plugin uninstall. Package metadata cannot authorize a credential binding, tool allow rule, host command, network destination, or runtime feature.

### Grouped management and publication

Plugin list/read, inspect/import, compose/export, select/update, member override, uninstall, and explicit purge are projections through the existing transport-neutral operation catalog, App API, Core Client, OpenAPI, and unified `openkit` Skill/CLI. Redacted metadata, member versions, and readiness reads require current Workspace visibility; they expose no raw source tree. Installation, selection, or membership mutations require `workspace.configure`. Exact source-file reads, raw inspection, and original-package export are restricted configuration operations requiring deployment-admin authority because the original tree may include MCP configuration and arbitrary non-activated files. Skill-only content reads use the independent Skill owner's sensitivity and permission checks. Server installation requires deployment-admin authority. Component candidate submission and MCP activation retain their separate checks.

One owner-scope catalog document publishes the Skill, MCP, and Plugin metadata graph and selection references together. The three catalog modules own their respective records within that document; they are not independently writable duplicate stores. Verify and publish immutable payloads first, then compare-and-set the expected catalog revision with the complete selected member map. This local publication boundary prevents a half-visible grouped install; it is not an atomic transaction with remote acquisition, Vault, Gateway processes, or a worker.

Use existing request-id replay/conflict, audit, and `recovery_required` behavior. A required receipt or audit failure cannot be relabeled success; partial actual effects remain inspectable. Restart trusts the canonical catalog and verified referenced payloads, not directory discovery. There is no durable installer job, polling state machine, auto-repair, or background update service. Orphan staging files confer no catalog visibility and can be discarded through existing temporary-file cleanup.

Import makes components available for selection and leaves MCP unbound/inactive until explicit authorized configuration. It does not change every Agent automatically. Install/configure responses distinguish catalog availability from missing credentials, runtime prerequisites, unsupported capabilities, and selected Agent bindings.

Update imports a new exact PluginVersion, computes added/removed/changed members, and moves the installation only through an explicit expected-revision request. An unchanged explicit local override is retained; if the upstream member changed or disappeared while locally overridden, update fails `conflict` until the request explicitly chooses a new exact member map. No update silently discards a local Skill improvement or mutates a Workspace pin. A setup referencing the updated installation resolves that installation's explicit member versions ahead of the pin under the Skill owner's accepted precedence; the selection explanation must show this source. An independent setup that relies on the pin keeps using the pinned version. A selected MCP member remains a constraint on its component owner's current configuration; the grouped update must explicitly include any authorized current-version change or report the unresolved conflict. Group rollback selects an exact earlier package/member map, subject to current component availability and permissions; it restores neither Vault nor external effects.

Uninstall removes that installation from future authored selection and removes its automatic member contributions in the same catalog revision. An independent reference or explicit adoption preserves a component under its own owner. Content remains while needed by live selections, proposed candidates, installed or explicitly retained package versions, unexpired AEP/evidence retention, or holds. Removed-package metadata retains digest-only history after byte retention ends. Physical purge is separate, reports retained references, and does not delete shared credentials or another installation's data. Unsupported cleanup remains unavailable/recovery-required rather than a claim of physical erasure.

Original-package export returns its exact retained tree and provenance only under the restricted source-tree authority above; ordinary metadata visibility never grants this export. Compose/export of a local package fixes explicit component versions, emits the public package declarations, and computes a new package digest; it never substitutes a generated worker loopback bundle for a reusable source package. Skill directories keep their native names and bytes. Duplicate native Skill names or incompatible MCP package-root layouts fail with a collision/prerequisite result until the caller supplies a newly authored valid package; the exporter does not rewrite scripts or solve dependencies. Skill-only composition requires current configuration and component-read authority; composition containing MCP additionally requires deployment-admin configuration authority and excludes all Workspace bindings, Vault references/values, live tokens, and mutable process data. Local composition does not impersonate an upstream publisher or publish to an external registry.

### Worker delivery and native adaptation

NanoCore resolves exact effective member versions under current authority before creating AEP supply. The AEP carries scoped component identities, source package/member lineage, exact payload inventories/digests, and non-secret materialization references. It carries neither raw upstream MCP configuration nor a live credential. The derived read-only supply tree uses `openkit-tree-v1` over all its files and directories, including generated plugin metadata and loopback MCP configuration. The adapter/projection identity is recorded separately. The deterministic adapter first computes this expected inventory and digest from the exact AEP/source inputs; materialization then rereads installed bytes and recomputes the digest before launch. Accepted evidence binds expected and observed digests to the AEP, component versions, and adapter identity under the existing materialization owner. Neither this derived digest nor its receipt is a new catalog or authorization authority, and it must not be reported as the publisher package digest.

Use the existing AgentSession-private package and declared-file import path. Admit the immutable AEP first, import and verify its declared resource inventory under the import-only `worker-supply` identity, then complete the existing Context Package and launch prerequisites. `docs/specs/20260801-nanohost_workspace_data_boundary.md` owns this exact inventory-bound path and the existing single-file carriage; `docs/specs/20260616-agent_environment_package.md` owns the immutable supply inputs. No fourth Gateway, side channel, global host installation, or transport-specific catalog API is introduced.

Sandbox Integration and the Worker Shim verify source/resource digests before exposing files, materialize into an isolated read-only session supply root, and invoke the selected adapter. The adapter either loads a generated native plugin containing exactly the selected standard components or projects those components into its native Skill discovery and MCP configuration surfaces. It does not resolve `latest`, fetch packages, decide membership, or widen privileges.

Only adapter/image/launch-mode combinations with direct proof may advertise support. Product-wide claims that a runtime supports plugins are insufficient. A native loader that also activates client-specific behavior or cannot isolate ambient user configuration cannot be used for this package; use the thin component path or report unsupported required supply. This external-runtime interoperability path is not backward compatibility with OpenKit's retired internal shapes.

Skill files retain their versioned content and relative root layout, including supporting scripts and assets. Experimental Skill metadata cannot create tool or sandbox authorization. MCP configuration contains only selected ids, the adapter's fixed Integration loopback route, and the existing capability-token reference. Original endpoints, commands, package environment, and Vault material stay at NanoCore. Package extensions and alternate discovery/configuration files must never be copied into runtime discovery locations.

Required resources that are missing, unsupported, changed, or unverified block readiness or launch before the worker starts. Optional omission must be explicitly declared by authored setup and visibly reported; the adapter cannot invent optionality. Runtime failure does not roll back catalog installation. Catalog success does not prove delivery, and verified file delivery does not by itself prove native discovery or behavioral use.

### Observation, sessions, and recovery

Management distinguishes source imported, catalog available, Agent-selected, files verified/delivered, runtime-discovered, and task-observed use using existing catalog and session evidence. These are projections over their owners, not a new plugin lifecycle ledger. Unknown discovery remains unproved rather than guessed from directory existence. Product-safe status includes exact version and a bounded failure reason.

Resource changes use later AEP resolution and the existing session compatibility boundary. An active session's files are never replaced in place. MCP disable/revocation still uses current per-call Gateway checks. After uncertain delivery or native launch, the existing session owner inspects or closes the attempt and a new authorized request resolves current truth; there is no blind replay or automatic repair across NanoCore and a runtime. Retained source and derived digests allow inspection without resurrecting revoked access.

### Workspace portability

`docs/specs/20260704-workspace_backup_export_import.md` owns portable Workspace export/import and complete data-root backup. Portable export carries independently readable Skill content and redacted package/MCP lineage, excludes original Plugin roots, executable MCP configuration, and mutable process data, and restores no active source selection or binding. Original-plugin export remains the separately restricted operation above. Retained source digests are provenance, not permission to fetch or activate missing content.

## Proposed Design

Implement thin package parsing/composition over the Skill and MCP owners, one scope-local catalog publication boundary, and the existing resource delivery/adapters. Share bounded-tree validation with the Skill owner. Keep source acquisition separate from admission, and native materialization separate from catalog truth. Do not add a registry service, generic plugin executor, or three catalog lifecycle engines.

## Current Implementation Projection

Workspace Agent Plugin versions and installations live in `workspaces/<id>/catalog/catalog.json` with immutable package snapshots under `catalog/plugin-snapshots/`. Import parses `plugin.json`, records independent Skill and MCP members, and optionally installs selected members. Worker Skill trees are imported through the existing `worker-supply` identity; the Codex adapter uses a thin Skill-directory plus loopback-MCP projection and does not advertise native plugins. Combined real-worker Skill/MCP proof is not yet retained.

Implementation seams are the existing NanoCore setup/catalog resolver, AEP supply schemas, NanoHost/Sandbox Integration declared-file carriage, Worker Shim materialization, and runtime adapters. The existing layout, setup, AEP, Gateway, and data-boundary specifications own the aligned contracts; implementation must project them into their existing schemas and modules, not a second package registry.

## Alternatives Considered

Raw community-package installation into a native worker would expose upstream MCP configuration and potentially vendor behavior, so only governed derived supply is loaded. Plugin-owned Skill content would obstruct independent improvement. Flattening every package into unrelated resources would lose grouped upgrade/removal and provenance. A full public-standard client or marketplace is broader than the requested packaging use.

## Consequences

Existing community packages can supply integrations within the supported format and runtime prerequisites. Admission, authorization, actual compatibility, and use remain distinct. A package can be valid but partially unavailable; the system must explain that state rather than promise universal support.

## Rollout / Migration Plan

Implement this design together with the Skill and MCP management contracts under the aligned Storage, authored setup, AEP, Gateway, and NanoHost owners. Bounded installed snapshots are ordinary catalog-owned product resources linked to original versions; large Workspace repositories, editable development sources, and their Git history remain external. Preserve existing authority, session, credential, transport, and failure boundaries.

Implementation proceeds through one complete vertical slice: persistent component/catalog versions and management; standard package import/composition; governed MCP binding; exact AEP supply; real Skill materialization/native adaptation; and the combined worker story below. Every advertised resource/adapter combination must reach that observable boundary. Standalone Skill/MCP management is part of the same outcome, not a later optional add-on. Accepted design does not claim source-code implementation or release completion.

## Testing Strategy / Acceptance Criteria

1. A package with multiple Skills and MCP declarations imports with exact independent member identities and grouped provenance. Standalone creation and local Skill evolution work without altering the source package. Re-import and naming conflicts are deterministic.
2. Unsafe/oversized packages never escape staging; invalid and unsupported components have explicit narrow outcomes; extensions and install scripts never execute. Import performs no MCP contact or credential grant.
3. An authorized update/override/rollback preserves Workspace pin records and local changes or returns a conflict. A setup referencing the changed installation resolves its exact member map ahead of those pins, while an independent pin-based setup remains pinned. Uninstall removes only its contributions; referenced versions, credentials, and another installation's state remain intact.
4. Interrupted publication and delivery show their actual separate outcomes. Missing/tampered/unsupported required supply blocks native launch; no stale config, ambient Skill directory, or raw-package fallback is accepted.
5. On the real dispatch-ready worker image, install a package with at least two Skills and one existing fixture MCP, select its members, discover a Skill, read its supporting resource, and use it to perform a governed MCP call whose result appears in the task artifact. Retained catalog, AEP, delivery, capability, and outcome evidence must agree on exact membership, schema, and versions; canary upstream credentials and configuration must be absent from worker inputs/output.
6. A worker emits an existing exact candidate Artifact; an authorized coordinator submits its second Skill version through the normal agent-facing operation without a worker management token. Inspect its exact difference, perform separately authorized exact runs for both versions, promote with current authority, and roll back. A later worker demonstrably uses the restored content while the source package remains unchanged. This proves version plumbing and reviewability, not that an evaluator chose the better Skill.
7. If native plugin loading is advertised, prove its isolation and exact-member behavior on the pinned runtime and flags. Otherwise prove the thin adapter path on the same actual worker. Additional unavailable runtimes remain honestly unavailable rather than passing through metadata-only tests.

## Risks & Mitigations

Package validity does not imply trust, dependencies, authorization, or improved behavior. Component owners enforce those distinct boundaries, and native adaptation must preserve them. Bounded immutable snapshots support exact rollback while keeping source development outside NanoCore.

## Deferred / Future Work

Vendor extensions, marketplace discovery, automatic updates, dependency solving, signing infrastructure, user-global installs, cross-deployment publishing, experiment automation, and support for additional runtime/transport combinations require separately accepted need. Portable package compose/export is included; operating a publishing service is not.

## Related Specifications And Sources

- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/specs/20260907-mcp_catalog_management.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260801-nanohost_workspace_data_boundary.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- [Agent Plugins specification](https://agent-plugins.org/specification).
- [Agent Skills format](https://agentskills.io/specification).
