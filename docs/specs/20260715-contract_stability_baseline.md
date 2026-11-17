---
status: Accepted
implementation: Partial
kind: process
aspect: contract-evolution
---
# Contract Stability Baseline

This specification owns the stability classification of current contract families and the gates that decide when a family is a baseline.

## Scope

Owns:

- The current stability classification for contract families that matter before a product release.
- The release gates that decide whether a classified family is ready to be treated as a baseline.
- The boundary between durable Core truth, exact-release product projections, experimental surfaces, and private implementation details.
- The decision that OpenKit does not promise independently versioned third-party API compatibility.

Does not own:

- The universal meaning of stability classes and contract evolution — [Contract Evolution](../core/contract-evolution.md).
- Canonical Core concepts, protocol, storage, identity, policy, vault, evidence, and metering — their Core owners.
- Detailed schemas, routes, tables, and migrations — the owning specifications and the [Retained Format Register](20261017-retained_format_register.md).
- Release scheduling, support windows, and semantic-version marketing — [Release Management](20260829-release_management.md) and any later accepted design.
- Business World Model, Meta-Skill, domain Skill contracts, multi-tenancy, Federation, and P2P. They sit outside this baseline.

Core:

- [Doctrine](../core/doctrine.md)
- [Core Concepts](../core/core-concepts.md)
- [Architecture](../core/architecture.md)
- [Protocol](../core/protocol.md)
- [Communication](../core/communication.md)
- [Storage](../core/storage.md)
- [Identity](../core/identity.md)
- [Policy](../core/policy.md)
- [Vault](../core/vault.md)
- [Evidence](../core/evidence.md)
- [Contract Evolution](../core/contract-evolution.md)

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
| Persisted product truth | Workspace records, history, knowledge, artifacts, approvals, policy decisions, audit, usage, evidence, vault reference metadata, and other authoritative record families. | Source-of-truth declaration, schema version, strict writes, bounded tolerant reads, and recovery tests. Breaking changes follow the continuity boundary below: one-way migration and a report, or an explicit pre-stable reset. |
| Storage ownership | Server, user, and workspace ownership boundaries; workspace independence from a current human owner; layout version; and database homing rules. | Layout marker, path and symlink guards, recovery report, backup verification, and ownership tests. A carry-forward migration requires preflight and one-way conversion; an explicit pre-stable reset follows the continuity boundary below. |
| Workspace export | Export of admitted work data for use outside OpenKit, such as analysis, evaluation, and audit, including inventory, integrity, identity handling, and the authority boundary of what leaves OpenKit. Lossless re-import into an OpenKit Workspace is not an export requirement. Ordinary portable import is removed. The predecessor Goal tables stay out of the portable export inventory and the backup inventory. Current Goal records remain portable work data under export. Operational restore preserves the captured Workspace and does not grant approval authority. The portability decision is recorded in [a decision record](../decisions/20261003-current_goal_records_are_portable.md). The earlier freeze is recorded in [a decision](../decisions/20260928-goal_freeze_and_export_backup_boundary.md). | Format version, exact manifest inventory, required features, tamper tests, and export-boundary fixtures. |
| Backup, restore, and data-root migration | Workspace and whole-server backup and restore, and data-root migration, as a mechanism separate from export. [Workspace Backup, Export, Import, And Data-Root Migration](20260704-workspace_backup_export_import.md) owns the offline mechanism, including consistency, integrity, identity, and recovery of retained data. While-running Workspace recovery and whole-server hot-backup consistency stay with that owner. The portability boundary is recorded in [a decision](../decisions/20260928-goal_freeze_and_export_backup_boundary.md). | Round-trip restore fixtures, backup verification, and recovery behavior, as that owner defines them. |
| Identity and membership | User identity, workspace owner, membership, invitation, token intersection, actor context, disable/remove/transfer semantics, and credential separation. | Strict schemas, database constraints, per-request access resolution, lifecycle transition tests, and durable actor attribution. |
| Permission and approval | NGAC-aligned policy vocabulary, product-action mapping, decision semantics, enforcement points, approval linkage, and fail-closed behavior. | Policy fixtures, deterministic decision tests, explicit operation mapping, atomic terminal transitions, required features for new authority, and audit linkage. |
| Vault and secret boundaries | Secret references, grants, non-secret metadata, injection authority, redaction, and the rule that raw secret material stays outside ordinary product records. | Strict schemas, backend isolation, fail-closed binding, secret scanning, redaction tests, and audited use records. |
| Audit and accountability | Auditable event categories, actor or subject attribution, resource and decision linkage, outcome, redaction, and required producer coverage. | Versioned schema, actor-safe fields, producer coverage matrix, retention rules, export behavior, and completeness diagnostics. |
| Shared-write correctness | Append ordering, immutable history, expected-revision behavior for mutable shared records, atomic first-writer transitions, conflict-safe workspace apply, and the central command-idempotency default. | Single-writer or atomic append, revision compare-and-swap, transaction tests, typed conflicts, and receipt-backed replay; request-owned effects without a receipt default to `recovery_required` without inference, synthesis, settlement, or repair. |

Equal active-member eligibility is the membership boundary. Access-level fields and role ceilings are not part of it. Promoted Core boundaries remain while an independently owned contract family finishes its own gate. Classify each newly promoted protocol family explicitly. Canonical Workspace data is top-level. The layout marker and the Workspace export marker stay in the [Retained Format Register](20261017-retained_format_register.md#canonical-files-and-retained-evidence). Boot admission fails closed when required layout authority is missing. A migration keeps its report. Export excludes source access authority and preserves non-authorizing history. OpenKit-to-OpenKit preservation uses backup, restore, and MOVE. Export is not backup. A later export owner preserves these boundaries. A full backup preserves same-deployment users and relationships. Re-enable, hard deletion, and organizations remain outside this baseline. This baseline adds no second permission engine. An unrelated operation family keeps its own plan. Required audit coverage is the specified producer set. A producer outside that set is not claimed complete. This baseline creates no generic concurrency framework and no broader compare-and-swap promise.

Durable classification does not freeze one TypeScript type, route, table, or directory forever. It freezes the contract's meaning and requires an explicit transition when the representation changes. The data-continuity obligation starts with the first stable release, `v0.1.0`, regardless of a family's readiness gate. Before then, teams work toward stable owned shapes and safe post-release retention and reading; an explicit deployment reset may replace migration. [Contract Evolution](../core/contract-evolution.md#retained-data-continuity) owns that boundary. A readiness gate governs contract precision and grants no reset authority. The pre-`v0.1.0` scope follows the engineer's interpretation of NONNEG-001 and COMPAT-001 in [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md).

## Release-Coupled Baseline

The following first-party surfaces are `Release-coupled` by default:

- NanoCore public App API routes, payload projections, operation IDs, and generated OpenAPI document
- `@openkit/core-client`
- the transport-neutral operation catalog
- the bundled `openkit` CLI
- remote MCP guide and the operations Skill with its administrator CLI
- the Web UI, read models, actions, and component state
- deployment administration, diagnostics, runtime-config editing, and setup projections
- first-party installation, bootstrap, and smoke workflows

These surfaces must satisfy same-release correctness, source-of-truth, security, and coverage requirements. They do not promise that a client from one OpenKit release works against NanoCore from another release.

That cross-release silence covers transport, packaging, and user-interface details throughout, and it covers operation semantic contracts until the launch boundary. [Contract Evolution](../core/contract-evolution.md#operation-semantic-promise) defines that boundary as publication of the first stable `v0.1.0`. At the launch boundary, settled operation semantic contracts become `Durable`, with Operation Semantic Promise as their evolution rule; their transport, packaging and user-interface projections remain at their existing stability classes. A settled operation's semantic contract is not reshaped in place. Every shipped operation carries the stability marker that Contract Evolution defines. That marker is distinct from the four family classes. [Operation Definition](20261002-operation_definition.md) owns the operation definitions. Family classification does not finalize the publication inventory. This baseline does not promise compatibility with two earlier releases. It promises no third-party support window and no parallel supported releases. An independently versioned client or a legal-isolation requirement needs a new accepted design. This baseline adds no Better Auth bearer support, no persisted CLI session, and no second user-token system. Ordinary user bearers cannot invoke the user-scoped own-invitation, leave, and deleted-recovery operations. Invocation depends on the declared credential and current authority.

The release gate for this class is:

- one owning schema or operation source
- one exact contract identity or digest
- all first-party producers and consumers updated in the same coordinated release
- risk-appropriate L2 contract and L3 process coverage for boundaries that cannot be proved at a lower layer
- a typed incompatibility when identities do not match
- no legacy route, alias, payload, Skill, CLI, or client path left behind

That removal gate applies to operation semantic contracts only before the launch boundary. After the boundary, deprecation keeps the same operation invocable and is not a compatibility alias or a second route, and retirement removes it in a later release, as [Operation Definition](20261002-operation_definition.md) specifies. The exception does not keep a legacy route, alias, or client path for a transport or presentation change. The current release procedure is unchanged. Retained data continuity is unchanged.

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

Boundary tests must prevent private fields from leaking into protocol, App API, export, audit, evidence, Skill output, CLI output, or Web read models. This baseline adds no tenant, organization, or legal-isolation placeholder.

## Baseline Gate By Contract Kind

### Core Semantic Gate

- The concept has exactly one canonical owner.
- Normative invariants and non-goals are settled.
- Active specs project rather than redefine the concept.
- Every claimed implementation surface has conformance coverage.
- Every promoted Core field has a domain-neutral owner and a present kernel use.

### Protocol And Schema Gate

- Known records parse strictly and invalid records fail clearly.
- Version or exact contract identity is explicit.
- Generated schemas and fixtures cannot drift.
- Additive unknowns are tolerated only where their owner permits it.
- Unsupported authority-bearing semantics fail closed.

### Persisted Data Gate

- Source-of-truth and ownership scope are explicit.
- A layout, schema, or format version exists.
- From `v0.1.0`, breaking changes have a one-way migration and data-continuity evidence. Before then, a selected explicit reset has release and procedure disclosure and protected-account evidence under [Release Management](20260829-release_management.md#pre-stable-deployment-reset-and-protected-accounts).
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
- Tests sit at the lowest layer that proves the changed invariant; a higher-layer test is required only when it proves a distinct integration risk. This baseline authorizes no dedicated acceptance platform.

## Implementation

- `packages/app-api-schemas/` — operation contracts and their stability markers
- `apps/nanocore/src/storage/` — layout, backup, export, and MOVE
- `packages/config-schema/` — workspace export marker

## Implementation Gaps

- Multi-user Web browser acceptance - the remaining Web work sits outside the current projection - #160
- While-running Workspace restore and MOVE - offline backup, restore, and MOVE exist; while-running recovery does not - #418

## Decisions

- [Current Goal records are portable](../decisions/20261003-current_goal_records_are_portable.md)
- [Goal freeze and export backup boundary](../decisions/20260928-goal_freeze_and_export_backup_boundary.md)
- [Pre-stable data continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [Operation definition rulings](../decisions/20261002-operation_definition_rulings.md)
