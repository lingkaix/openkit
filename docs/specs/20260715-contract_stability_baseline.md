---
status: Accepted
implementation: Partial
date: 2026-07-15
---
# Contract Stability Baseline

## Owns

- The current OpenKit stability classification for contract families that matter before a product release.
- The release gates that determine whether a classified family is ready to be treated as a baseline.
- The boundary between durable Core truth, exact-release product projections, experimental surfaces, and private implementation details.
- The current decision that OpenKit does not promise independently versioned third-party API compatibility.

## Does Not Own

- The universal meaning of stability classes or contract evolution, which belongs to `docs/core/contract-evolution.md`.
- Canonical Core concepts, protocol semantics, storage semantics, identity, permission, vault, audit, or metering doctrine.
- Detailed schemas, routes, tables, migrations, or package implementation plans.
- Release scheduling, customer support windows, deprecation policy, or semantic-version marketing promises.
- Business World Model, Meta-Skill, or domain Skill contracts.
- Multi-tenancy, Federation, P2P, or cross-deployment collaboration.

## Core References

- `docs/core/foundation.md`
- `docs/core/core-concepts.md`
- `docs/core/architecture.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`
- `docs/core/contract-evolution.md`

## Intent

- `docs/product-vision.md`

## Summary

OpenKit should freeze durable product truth before release, but it should not freeze every public or user-facing shape.

The durable baseline covers promoted Core meaning, persisted and portable data, workspace ownership, identity and actor attribution, authorization and audit semantics, stable lineage, and the invariants needed to preserve history. NanoCore App API operations, `@openkit/core-client`, the bundled CLI, the unified `openkit` Skill, generated OpenAPI, and Web UI remain exact-release projections that may change together without deprecation windows or compatibility aliases.

Business World Model and Meta-Skill theory must not shape or delay the OpenKit kernel baseline. Domain models belong in separately versioned Skills and catalogs and may consume OpenKit mechanisms without becoming a second owner of Core contracts.

## Goals

- Identify which current contract families require cross-release semantic or data continuity.
- Identify which current product surfaces should remain free to evolve in lockstep.
- Give each family a concrete stabilization mechanism and release gate.
- Prevent implementation details, experimental work, and domain theory from becoming accidental Core obligations.
- Make remaining release-blocking contract gaps explicit without pretending every classified family is already ready.

## Non-Goals

- Do not declare a general public API support window.
- Do not keep old routes, fields, aliases, payloads, config shapes, or internal data readers for compatibility.
- Do not add tenant, organization, or legal-isolation placeholders.
- Do not design independently deployed clients or SDKs.
- Do not define Federation or P2P contracts.
- Do not freeze provider, adapter, backend, package, UI component, or database-engine details.
- Do not embed Business World Model or Meta-Skill-specific types in OpenKit Core.

## Background

The previous root-level freeze report mixed three different concerns: contract lifetime, implementation readiness, and a list of speculative Business World Model and tenancy obligations. It also treated a user-facing API as if it needed deprecation windows and proposed compatibility windows that conflict with the repository's internal-development posture.

The accepted contract-evolution model now separates stability class from stabilization mechanism. This specification applies that model to the current OpenKit product direction.

Two current facts narrow the baseline:

- No requirement exists for one deployment to host multiple legally isolated organizations.
- No independently released third-party client currently depends on NanoCore App API compatibility across OpenKit releases.

These facts remove the need for tenant placeholders, organization schemas, API deprecation windows, and speculative client support policy.

## Decision

OpenKit uses four stability classes from `docs/core/contract-evolution.md`:

- `Durable` for promoted meaning and data that must survive ordinary releases.
- `Release-coupled` for supported first-party surfaces that ship and upgrade together.
- `Experimental` for bounded learning surfaces that are not release authority.
- `Private` for implementation details that no consumer may treat as a contract.

This specification classifies contract families. It does not claim that every durable family has already passed its release gate.

## Precision And Reliability Scope

The two-independent-implementers precision bar applies fully to `Durable` families because incompatible implementations could corrupt persisted or portable truth, authority, identity, audit, or cross-release meaning. Their owning Core and specifications must preserve exact authority, lifecycle, conflict, failure, migration, and observable acceptance rules.

`Release-coupled` surfaces require one clear same-release implementation, typed failure behavior, and tests sufficient for the risk they carry. They do not require byte-exact response replay, per-command crash reconstruction, cross-release compatibility, or an L1-L6 copy of every assertion. `Private` implementation details require only the checks needed to protect a promoted boundary.

Reliability work follows the current small-deployment profile. Security, authorization, credentials, containment, data loss, durable authority, and irreversible external effects remain strict. Availability, cleanup, projection, and reconnect behavior may use a documented `interrupted`, `recovery_required`, inspection, or new-request fallback instead of transparent repair.

Future scale and availability are non-authorizing until a current accepted specification promotes them. A deferred multi-process, multi-target, fairness, hot-failover, or transparent-recovery idea creates no current field, state, record, compatibility, runner, harness, or test obligation.

## Durable Baseline

The following families are `Durable` once their readiness gates pass.

| Family | Durable contract | Stabilization mechanism |
| --- | --- | --- |
| Core semantics | Canonical object meaning, ownership boundaries, lifecycle invariants, authority boundaries, and source-of-truth rules. | One Core owner, normative invariants, linked concrete specs, and Core/projection conformance tests. |
| Promoted protocol families | Known Core records, commands, events, envelopes, lifecycle states, error semantics, ordering, and correlation used for durable history or Core/Agent communication. | Explicit protocol version, strict schemas, generated schemas, fixtures, discovery, and mismatch tests. |
| Stable identity and lineage | Opaque IDs, workspace/thread/turn/item lineage, request IDs, causation, actor attribution, responsible-user context, and content digests where records depend on them. | Shared schemas, uniqueness and lineage constraints, idempotency tests, attribution tests, and migration mapping for changed identities or digests. |
| Persisted product truth | Workspace records, history, knowledge, artifacts, approvals, policy decisions, audit, usage, evidence, vault reference metadata, and other authoritative record families. | Source-of-truth declaration, schema version, strict writes, bounded tolerant reads, one-way migration, migration report, and recovery tests. |
| Storage ownership | Server, user, and workspace ownership boundaries; workspace independence from a current human owner; layout version; and database homing rules. | Layout marker, path and symlink guards, migration preflight, one-way migration, recovery report, backup verification, and ownership tests. |
| Workspace portability | Workspace export, import, backup, restore, and data-root migration semantics, including inventory, integrity, rebinding, and identity handling. | Format version, exact manifest inventory, required features, round-trip fixtures, tamper tests, migration matrix, and recovery behavior. |
| Identity and membership | User identity, workspace owner, membership, invitation, token intersection, actor context, disable/remove/transfer semantics, and credential separation. | Strict schemas, database constraints, per-request access resolution, lifecycle transition tests, and durable actor attribution. |
| Permission and approval | NGAC-aligned policy vocabulary, product-action mapping, decision semantics, enforcement points, approval linkage, and fail-closed behavior. | Policy fixtures, deterministic decision tests, explicit operation mapping, atomic terminal transitions, required features for new authority, and audit linkage. |
| Vault and secret boundaries | Secret references, grants, non-secret metadata, injection authority, redaction, and the rule that raw secret material stays outside ordinary product records. | Strict schemas, backend isolation, fail-closed binding, secret scanning, redaction tests, and audited use records. |
| Audit and accountability | Auditable event categories, actor or subject attribution, resource and decision linkage, outcome, redaction, and required producer coverage. | Versioned schema, actor-safe fields, producer coverage matrix, retention rules, export behavior, and completeness diagnostics. |
| Shared-write correctness | Append ordering, immutable history, expected-revision behavior for mutable shared records, atomic first-writer transitions, conflict-safe workspace apply, and the central command-idempotency default. | Single-writer or atomic append, revision compare-and-swap, transaction tests, typed conflicts, and receipt-backed replay; request-owned effects without a receipt default to `recovery_required` without inference, synthesis, settlement, or repair. |

Durable classification does not freeze one TypeScript type, route, table, or directory forever. It freezes the contract's meaning and requires an explicit transition when the representation changes.

## Release-Coupled Baseline

The following first-party surfaces are `Release-coupled` by default:

- NanoCore public App API routes, payload projections, operation IDs, and generated OpenAPI document
- `@openkit/core-client`
- the transport-neutral operation catalog
- the bundled `openkit` CLI
- the unified end-user `openkit` Skill and its reference files
- the Web UI, read models, actions, and component state
- deployment administration, diagnostics, runtime-config editing, and setup projections
- first-party installation, bootstrap, and smoke workflows

These surfaces must satisfy same-release correctness, source-of-truth, security, and coverage requirements. They do not promise that a client from one OpenKit release works against NanoCore from another release.

The release gate for this class is:

- one owning schema or operation source
- one exact contract identity or digest
- all first-party producers and consumers updated in the same coordinated release
- risk-appropriate L2 contract and L3 process coverage for boundaries that cannot be proved at a lower layer
- a typed incompatibility when identities do not match
- no legacy route, alias, payload, Skill, CLI, or client path left behind

Publishing generated OpenAPI as a review or diagnostic artifact does not by itself promote the App API to a durable independently versioned public API.

## Experimental Baseline

A surface is `Experimental` only when it is visibly labeled and bounded.

Experimental surfaces may include incomplete workflow projections, research-backed prototypes, provisional provider features, or an unpromoted record family. They must not become the only copy of durable product truth, make authorization decisions that no promoted policy owner can reproduce, or write unversioned canonical data.

An experimental surface must be promoted, removed, or kept explicitly outside the release before external dependence is encouraged.

Business World Model and Meta-Skill work is not an OpenKit experimental Core surface. It belongs outside this baseline in independently owned Skill packages and catalogs.

## Private Baseline

The following are `Private` unless a later accepted design promotes them:

- package and source-file layout
- database engine, ORM, prepared statements, internal table columns, and cache layout beyond promoted ownership or persistence semantics
- provider-native, adapter-native, backend-native, and runtime-native payloads
- process IDs, sockets, launch commands, sandbox handles, transport handles, and absolute paths
- internal diagnostics, traces, caches, derived indexes, and temporary staging state
- UI components, client-local drafts, internal hooks, and view-library state
- implementation helpers and pass-through wrappers

Boundary tests must prevent private fields from leaking into protocol, App API, export, audit, evidence, Skill output, CLI output, or Web read models.

## Current Readiness

| Durable family | Current posture | Release consequence |
| --- | --- | --- |
| Core semantics | Strong promoted documentation with owner-independent Workspace storage, centralized request authorization, fixed roles, lifecycle, attribution, and current-effect authority projected in NanoCore. | Retain these promoted boundaries while the remaining independently owned contract families finish. |
| Promoted protocol families | Strict schemas, generated schema coverage, protocol identity, and many conformance tests exist. | Retain strict current-schema gates and classify each newly promoted family explicitly. |
| Persisted data and storage ownership | Canonical Workspace data is top-level and owner-independent, with one verified stopped-process migration, external cold-backup evidence, and no compatibility reader. | Retain the v2 layout, migration report, and fail-closed boot admission. |
| Workspace portability | V2 export/import excludes source access authority, creates the importer as sole target owner/member, preserves non-authorizing history, and full backup preserves same-deployment users and relationships. | Ready for the current multi-user baseline; later portability owners must preserve these authority boundaries. |
| Identity and membership | Better Auth, scoped tokens, fixed owner/editor/viewer projection, centralized authorization, invitation and membership lifecycle, ownership transfer/recovery, and one-way disable are implemented. | Ready for the current multi-user baseline; re-enable, hard deletion, organizations, and another token system remain outside V1. |
| Permission and approval | The NGAC-aligned kernel, exact operation mapping, centralized resolver, child lineage, current-effect reauthorization, and named eligible-principal projections are active. | Ready for the current multi-user baseline without a second permission engine; unrelated operation families retain their own plans. |
| Audit and accountability | Shared lifecycle, human Item, Turn, policy Approval, governed runtime, usage, and decision families preserve their specified actor, responsible-user, request, subject, and revision lineage. | Ready for the bounded current producer set; this does not claim every S59 producer outside that set is complete. |
| Shared-write correctness | Append-only history, central request idempotency, direct revisions and atomic claims for the named Workspace lifecycle and policy Approval transitions, and existing owner-local Artifact Review, Material, and Workspace Sync controls are active. | Ready for the named current shared-write set; no generic concurrency framework or broader CAS promise is created. |
| Release-coupled product surface | App API, generated OpenAPI, all fifteen Core Client operations, eleven bearer-reachable catalog/CLI/Skill operations, and exact contract artifacts align in one release; four session-only operations are explicit known-partials and the rebuilt Web remains deferred. | Ready for the accepted current projection boundary; S10 owns the rebuilt multi-user Web and its browser acceptance. |

`Implementation: Partial` remains correct for this cross-program baseline because S10 and other independently owned contract families are not complete. The current multi-user and contract-stability subset satisfies its named gates; that bounded completion does not promote the whole repository to a frozen or globally complete state.

## Baseline Gate By Contract Kind

### Core Semantic Gate

- The concept has exactly one canonical owner.
- Normative invariants and non-goals are settled.
- Active specs project rather than redefine the concept.
- Every claimed implementation surface has conformance coverage.

### Protocol And Schema Gate

- Known records parse strictly and invalid records fail clearly.
- Version or exact contract identity is explicit.
- Generated schemas and fixtures cannot drift.
- Additive unknowns are tolerated only where their owner permits it.
- Unsupported authority-bearing semantics fail closed.

### Persisted Data Gate

- Source-of-truth and ownership scope are explicit.
- A layout, schema, or format version exists.
- Breaking changes have a one-way migration and data-continuity evidence.
- Backup, export, import, recovery, and deletion behavior are defined where relevant.
- No compatibility reader is retained after migration unless an accepted contract requires it.

### Authority Gate

- Authentication and authorization remain separate.
- Every request is checked against the resolved resource.
- Missing facts and unsupported semantics deny.
- Actor, decision, credential channel, resource, and outcome are auditable without exposing secrets.
- Terminal decisions and owner changes are atomic.

### Release-Coupled Gate

- The supported release set shares one exact contract identity.
- First-party clients, CLI, Skill, and Web use the same operation/schema owners.
- Mismatch fails clearly before unsupported work.
- Old projections are removed rather than deprecated.
- Tests sit at the lowest layer that proves the changed invariant; a higher-layer test is required only when it proves a distinct integration risk.

## Current Implementation Projection

OpenKit implements strict Zod contracts, protocol and App API schema packages, generated schema and OpenAPI drift checks, request idempotency, record envelopes, required-feature handling, versioned Workspace export, data-root layout markers, owner-independent top-level Workspace storage and migration, fixed owner/editor/viewer policy projection, centralized operation-metadata authorization, handler-owned child-lineage enforcement, scoped bearer tokens, the complete V1 Workspace sharing and user-disable lifecycle, named durable permission decisions and actor attribution, current-effect reauthorization, eligible-principal projections, Vault and portability authority boundaries, Workspace Synchronization Review, and conflict-checked apply.

The implemented same-release projection exposes all fifteen operations through App API and Core Client and the eleven bearer-reachable operations through the catalog, bundled CLI, and unified Skill. Own-invitation list, accept, decline, and exact own-receipt leave remain explicit session-only CLI/Skill known-partials; the current baseline intentionally adds no Better Auth bearer support, persisted CLI session, or second user-token system. The rebuilt multi-user Web remains with S10. Other remaining baseline gaps belong to their named specifications rather than authorizing compatibility machinery or broader current scope. Artifact Review, Material, and Workspace Sync retain their existing owner-local contracts.

No current implementation evidence establishes a support promise for independently versioned third-party App API clients.

## Alternatives Considered

### Freeze Every Public App API Shape

Rejected because all current consumers are first-party and versioned with OpenKit. A compatibility window would slow iteration without protecting a present consumer.

### Keep Frozen, Stable, And Experimental Tiers

Rejected because the earlier tiers mixed lifetime with enforcement mechanism and implied deprecation windows. The four classes in the Core evolution model separate durable truth from exact-release projections and private implementation.

### Add Tenant And Organization Placeholders

Rejected because no present deployment requires legal tenant isolation. Placeholder authority fields create migration and policy obligations without a current owner or use.

### Freeze Business World Model Integration

Rejected because Business World Model and Meta-Skill contracts belong to external Skill packages. Coupling them to the kernel would let domain theory redefine the general product shape.

### Promise N-2 Compatibility

Rejected because there is no independent client or support policy that needs it. Exact-release identity is the current requirement.

## Consequences

- OpenKit can change its App API, CLI, Skill, and Web surface aggressively as one release.
- Persisted data, workspace ownership, authorization, audit, and portable history receive stronger gates than presentation surfaces.
- A release may contain breaking changes without compatibility adapters, but durable data changes still require explicit migration.
- Business World Model and Meta-Skill work can evolve independently without blocking or reshaping the kernel.
- Readiness is evaluated per family rather than through one misleading global freeze flag.

## Rollout And Migration

This specification replaces the previous root-level freeze report without preserving its tier names, BWM coupling, tenancy placeholders, deprecation windows, or status table.

No code or data migration occurs merely because this classification is accepted. Concrete implementation work belongs to the linked change plan and owning specifications.

## Testing Strategy

- L0 documentation checks verify that active specs declare `Status` and `Implementation`, classify new supported surfaces, and do not reintroduce removed compatibility language.
- L1 package tests verify strict schemas, version identities, required features, redaction, and private-boundary exclusions where those risks exist.
- L2 contract tests verify durable fixtures and exact-release projection alignment that crosses package boundaries.
- L3 NanoCore tests verify representative process-only risks such as restart, migration, fail-closed authority, and one same-release public path; they do not repeat every L1-L2 assertion.
- L5 artifact tests verify generated schemas, OpenAPI, CLI/Skill artifacts, exports, backups, and release identity.
- L6 stories verify only representative end-to-end product intent that lower layers cannot establish. Existing runners are reused; this baseline authorizes no dedicated acceptance platform.

## Risks And Mitigations

- Risk: `Durable` is misread as immutable. Mitigation: require explicit versioned transitions and migrations, not permanent representations.
- Risk: `Release-coupled` becomes an excuse for weak same-release contracts. Mitigation: require one source, exact identity, typed mismatch, and L2/L3 coverage.
- Risk: a generated or public-looking artifact creates an accidental compatibility promise. Mitigation: classification must be explicit; observability alone does not promote a surface.
- Risk: readiness tables drift. Mitigation: update this baseline only at material release-gate changes and keep implementation detail in owning specs and change records.
- Risk: domain Skill needs leak into Core. Mitigation: require every promoted Core field to have a domain-neutral owner and present kernel use.

## Open Questions

None. A future independently released API consumer or legal-isolation deployment requirement would require a new accepted design rather than changing this baseline implicitly.

## Deferred Work

- A separately accepted third-party API support policy if a real independently versioned consumer appears.
- A release support window if product operations later require parallel supported releases.
- Stability baselines for independently versioned domain Skill packages.

## Links

- [Contract Evolution Model](../core/contract-evolution.md)
- [Core Concepts](../core/core-concepts.md)
- [Storage Model](../core/storage.md)
- [Identity Model](../core/identity.md)
- [Permissions Model](../core/permissions.md)
- [Audit Model](../core/audit.md)
- [Core Protocol](../core/protocol.md)
- [Core Client Boundary](./20260528-core_client_boundary.md)
- [Schema Evolution And Record Envelope](./20260703-schema_evolution_record_envelope.md)
- [Storage Layout And Record Ownership](./20260703-storage_layout_record_ownership.md)
- [Workspace Backup, Export, Import, And Data-Root Migration](./20260704-workspace_backup_export_import.md)
- [App API OpenAPI Projection](./20260704-app_api_openapi_projection.md)
- [Remote Auth Credential Bootstrap](./20260704-remote_auth_credential_bootstrap.md)
- [OpenKit Agent Skill Interface](./20260713-openkit_agent_skill_interface.md)
- [Single-Deployment Multi-User Workspace System](./20260715-multi_user_workspace_system.md)
