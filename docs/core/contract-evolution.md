---
status: Accepted
---
# Contract Evolution Model

This document owns how OpenKit classifies contract stability, promotes contract surfaces, evolves breaking contracts, and judges implementations against the promoted core model.

This document does not own core-document authoring rules, canonical object definitions, protocol record semantics, transport behavior, storage layout, App API endpoints, the current release baseline, or implementation migration plans.

## Purpose

OpenKit needs durable product truth without turning every user-facing projection into a long-lived compatibility promise.

This model separates how long a contract must remain meaningful from the mechanism used to stabilize that contract. It lets Core semantics, persisted data, authority boundaries, and portable records mature deliberately while release-coupled APIs, clients, Skills, and user interfaces continue to evolve together.

## Principles

- Stability is an explicit property of a contract surface, not a consequence of being public, typed, documented, or implemented.
- Compatibility obligations rest on retained data. Retained canonical data and authored configuration stay usable while features and implementation change, as Retained Data Continuity below states. First-party surfaces that ship with each release carry no compatibility obligation unless a separately accepted contract creates one, so refactoring deletes obsolete implementation instead of adding compatibility layers, deprecated shims, or dual writes.
- Durable does not mean immutable. A durable contract may change through an explicit design, version transition, data migration when needed, and matching verification.
- Release-coupled surfaces may break between coordinated OpenKit releases without deprecation windows, aliases, or compatibility adapters.
- Experimental and private shapes must not become authority-bearing or persistent dependencies by accident.
- Product projections must preserve promoted Core meaning without becoming the owner of that meaning.
- Unknown semantics that affect authority, safety, retention, billing, or security must fail closed, as must an extension that changes how a core field is read. Closed Core, Open Extension below states that rule.
- Settled mechanisms stay stable, and extension stays open under Closed Core, Open Extension below. Deleting obsolete implementation does not license rewriting a settled mechanism, and it does not conflict with a reader ignoring an unknown additive extension. The reason settled mechanisms stay stable is recorded in [Settled Mechanisms Stay Stable And Extension Stays Open](../decisions/20260924-stable_mechanisms_open_extension.md). The data-continuity rule it qualifies is recorded in [Compatibility Obligations Rest On Data](../decisions/20260928-compatibility_rests_on_data.md). The closed-core ruling is recorded in [Closed Core, Open Extension](../decisions/20260930-closed_core_open_extension.md).

## Closed Core, Open Extension

Every owned data shape separates a closed core from an open extension. The shapes are storage records and file formats, directory layouts, configuration, and interface and protocol messages. The ruling is recorded in [Closed Core, Open Extension](../decisions/20260930-closed_core_open_extension.md).

Each core field's values are a closed set with one owner. An unknown core value fails closed at admission and is never coerced, defaulted, or passed on.

Everything outside the core is open. A reader ignores unknown additive fields, members, files, and entries without an owner first declaring a tolerant location. Ignoring means the reader does not act on the content. Ignored content from a producer outside the reader's trust boundary is not persisted, forwarded, or displayed unless its owner defines that use. Hand-Written Configuration below adds a warning for an unknown key in operator- or user-authored configuration, and that warning does not apply the key.

An extension that changes how a core field is read, or that carries authority or security meaning, is not safely ignorable. Its owner MUST mark it required through the shape's required-feature or equivalent contract gate. A reader that does not understand a required extension MUST fail closed. The rule governs data shapes and their readers. It does not authorize a code extension point before a second variant exists.

## Canonical Terms

`Contract surface` means a named set of semantics, schemas, persisted records, operations, events, manifests, identifiers, or validation behavior that a consumer may depend on.

`Stability class` means the intended lifetime and change discipline of a contract surface.

`Stabilization mechanism` means the concrete method used to preserve and verify a contract, such as an owning document, schema version, conformance fixture, migration, required feature, or exact release identity.

`Current contract` means the accepted contract for the current OpenKit release and every durable contract it consumes.

`Contract evolution` means changing a current contract through the documentation, schema, implementation, migration, and verification required by its stability class and contract kind.

`Breaking change` means a change that removes, renames, tightens, or reinterprets a field, enum value, operation, event, stored shape, capability, authority rule, or validation rule that a supported consumer could depend on.

`Compatibility shim` means code or schema behavior that accepts an obsolete shape only to preserve an old client, old data shape, old alias, or old route after the current contract has moved on.

`Promotion` means intentionally moving a surface into a stronger stability class after its owner, boundaries, verification, and change mechanism are defined.

`Conformance` means an implementation, projection, adapter, or package preserves the OpenKit contracts it claims to support.

`Conformance fixture` means a machine-readable example used to prove that schemas, parsers, generated projections, and implementation behavior agree with a named contract version.

`Required feature` means a declared capability or semantic requirement that a reader must understand before it can safely process a record, manifest, or storage family.

## Two-Axis Stability Model

Every intentional contract surface is classified on two independent axes:

1. A stability class states how long consumers may depend on its meaning.
2. A stabilization mechanism states how that meaning is represented, changed, and verified.

A schema is not automatically durable, and a durable semantic contract does not require one universal schema mechanism. The owning baseline or aspect must state both axes when the classification is not obvious from the defaults in this document.

## Stability Classes

| Class | Consumer promise | Breaking-change rule |
| --- | --- | --- |
| `Durable` | Meaning remains coherent across ordinary OpenKit releases and persisted or portable history remains processable. | Requires an accepted design, explicit version or feature transition where applicable, migration for affected persisted truth, and matching conformance evidence. No compatibility shim is required unless the accepted design explicitly chooses one. |
| `Release-coupled` | Supported components work only as one exact OpenKit release set. Cross-release compatibility is not promised. | May break in the next coordinated release when all first-party producers and consumers change together, old shapes are removed, and version mismatch fails with a typed diagnostic. |
| `Experimental` | The surface is available for bounded learning and may change or disappear without migration or deprecation. | May break or be removed, but must remain visibly marked and must not carry authority or become the only representation of durable product truth. |
| `Private` | The surface is an implementation detail with no consumer contract. | May change freely inside its owner, but boundary checks must prevent it from leaking into durable, release-coupled, persisted, exported, or user-visible contracts. |

`Durable` is the only class that promises cross-release semantic continuity. `Release-coupled` promises same-release correctness, not a support window. `Experimental` is an intentional learning surface. `Private` is the default for implementation details that have not been deliberately exposed.

## Default Classification

- Accepted Core semantics and invariants are `Durable`.
- Retained canonical data and authored configuration are `Durable` representations under Retained Data Continuity below. Portable formats, authority boundaries, and cross-release protocol families are `Durable` only when an owning document or accepted baseline explicitly identifies them and defines their evolution mechanism.
- App APIs, generated API projections, first-party clients, bundled CLIs, unified Skills, Web projections, and other presentation or operation surfaces are `Release-coupled` by default.
- Operation semantic contracts stay `Release-coupled` until the launch boundary in Operation Semantic Promise. At the launch boundary, settled operation semantic contracts become `Durable`, with Operation Semantic Promise as their evolution rule; their transport, packaging and user-interface projections remain at their existing stability classes.
- A surface explicitly labeled experimental is `Experimental` until promotion.
- Package layout, database engine details, provider-native payloads, adapter-native events, backend handles, local paths, process commands, caches, and diagnostics internals are `Private` unless deliberately promoted.
- A surface without an intentional owner and classification must not be treated as a contract merely because a consumer can currently observe it.

## Retained Data Continuity

OpenKit's compatibility obligations rest on retained data. Retained canonical data and authored configuration are `Durable` representations: their processing contract keeps them usable while features, implementation, and projections change. The implementation that owns such data may stay `Private`, and a projection of it, such as an App API response or an execution contract delivered to a Worker, stays `Release-coupled`; neither changes the `Durable` contract of the retained representation. The reason is recorded in [Compatibility Obligations Rest On Data](../decisions/20260928-compatibility_rests_on_data.md).

- Retained canonical data means canonical file-backed records, including persisted protocol records, and retained evidence, even when that evidence is non-authorizing or diagnostic. SQLite source-of-truth records carry this obligation from the first release; until then their schemas follow the pre-release consolidation rule recorded in [Schema Migrations Start At First Release](../decisions/20260918-release_schema_migrations.md), which authorizes no automatic deletion or reset.
- A change keeps retained data usable by extending its format additively or by carrying it forward through a one-way migration under an accepted design. A temporary migration path exists only when that design defines one; no permanent legacy reader or dual write remains. Removing retained data instead requires an explicit data-retirement decision.
- An older reader ignores unknown additive fields, members, files, and entries outside the closed core, as Closed Core, Open Extension states, without an owner first declaring a tolerant location. Generated configuration, execution contracts, and record schemas follow that same rule for unknown additive content. Unknown core values, and unknown required or authority-bearing semantics, fail closed.
- Opaque retained bytes, such as Worker volumes, native agent history, and retained images, survive under `docs/core/storage.md` without an OpenKit format promise. Rebuildable derivatives, caches, disposable diagnostic projections, and operational telemetry that its owner classifies as `Release-coupled` carry no continuity obligation.
- This obligation is prospective: completed cutovers recorded by their owners stand. It does not relax closed-core validation or required-feature checks, does not extend a generated execution contract to older launches, does not authorize boot-time rewriting, automatic migration, or data-root replacement beyond what existing owners define, and does not override retention, deletion, revocation, or hold rules.

## Operation Semantic Promise

Before the launch boundary, an operation's semantic contract is `Release-coupled` and may change with the coordinated release under the release-coupled rules in this document. That boundary is the launch. It is not yet defined, and defining it is what starts the promise below. The ruling is recorded in [Operation Definition Rulings](../decisions/20261002-operation_definition_rulings.md).

After that boundary, a settled operation's semantic contract is frozen. The frozen contract is the operation's input and output meaning, its effects, and its declared authority requirements. At the launch boundary, settled operation semantic contracts become `Durable`, with Operation Semantic Promise as their evolution rule; their transport, packaging and user-interface projections remain at their existing stability classes. This promise is that evolution rule. Transport placement, packaging, and user-interface details are not frozen by this promise and stay with their owners at their existing stability class. A settled operation is not modified in place. A later release may only add an operation, deprecate an operation, or retire an operation, and an operation id is never reused. Deprecation keeps that same operation invocable under its existing semantic contract, may name an optional replacement, and does not redirect the call or add a second shape. Retirement in a later release removes the operation from discovery and execution, and a call fails with a typed error rather than through a compatibility adapter. An implementation repair that restores the accepted semantic contract is not a new meaning. Current policy, resource state, revocation, and effect preconditions may still deny an unchanged operation.

Retained Data Continuity is unchanged. Changing an operation before launch does not discard retained records or captured bindings that cite an operation id. Those records stay usable under their continuity owners. Deprecation and retirement, stated above, remain release decisions. Blocking is a deployment decision and is not a change to the operation definition. An operation the deployment cannot support is an availability condition its owner already reports, and that condition is not policy. An owner's or administrator's choice to keep users from an operation is a permission, deferred to the Policy Kernel implementation and later user-configurable. This document does not define that permission. The architecture keeps room for it by making the canonical operation id usable as a policy resource and by admitting every invocation once through its primary policy operation, and this document does not own those mechanisms.

The release-coupled break rule in Principles still applies to operation semantic contracts before the launch boundary. It still applies to transport, packaging, and user-interface surfaces after that boundary.

## Stabilization Mechanisms

| Contract kind | Required stabilization mechanism |
| --- | --- |
| Core semantics and lifecycle invariants | One canonical Core owner, normative invariants, explicit promotion, and conformance coverage at every claimed projection. |
| Durable protocol or schema family | Explicit version identity, strict schemas as the source of truth for the known core, generated schema drift checks where applicable, valid and invalid fixtures, and capability or required-feature discovery for an extension that changes how a core field is read or carries authority or security meaning. Readers do not reject unknown additive content. |
| Persisted data and storage ownership | Schema or layout version, source-of-truth declaration, one-way migration for breaking changes, migration report, recovery behavior, and data-continuity verification. |
| Export and portable manifests | Format version, exact inventory and integrity validation, required-feature handling, and import fixtures and explicit identity or authority rebinding rules for any import an owner accepts. Lossless re-import into OpenKit is not an export requirement ([decision](../decisions/20260928-goal_freeze_and_export_backup_boundary.md)). |
| Backup and restore | A mechanism separate from export: consistency and integrity validation, restore round-trip tests, identity handling, and recovery behavior for retained data. |
| Identity, permission, vault, audit, retention, or other authority-bearing semantics | Strict validation, deny-by-default behavior, required-feature or minimum-contract gating for new authority, redaction, durable attribution, and fail-closed handling for unsupported semantics. |
| Release-coupled operation and presentation surfaces | One source of truth, exact contract identity or digest, same-release contract coverage, typed incompatibility, and removal of superseded aliases or parallel shapes. |
| Experimental surfaces | Visible experimental marker, bounded owner and purpose, no authority-bearing use, no exclusive ownership of durable truth, and an explicit promotion or removal decision before release. |
| Private implementation surfaces | Cohesive local ownership and boundary tests that prevent accidental projection into supported contracts. |

## Promotion Rules

A surface may be promoted only when all of the following are true:

- its owner and non-owner boundaries are explicit
- its intended consumers and stability class are explicit
- its semantic invariants are settled
- its schema, version, feature, migration, or release-identity mechanism is defined as applicable
- its valid, invalid, mismatch, and failure behavior is verifiable
- for each owned data shape, its closed core and open extension are explicit, and an unknown core value fails closed at admission
- authority-bearing unknowns fail closed
- all existing first-party projections agree with the promoted meaning or are explicitly outside the claim

Promotion from `Experimental` or `Private` is a contract change. Existing accidental consumers do not force promotion and do not create a compatibility obligation.

## Demotion And Removal

- A `Durable` surface may be removed or reinterpreted only through an accepted design and a versioned transition that preserves or explicitly migrates affected durable truth.
- A `Release-coupled` surface may be replaced in the next coordinated release without a deprecation period, but old producers, consumers, aliases, routes, schemas, and tests must be removed together.
- An `Experimental` surface may be removed directly after its bounded evidence and any accepted conclusions are retained.
- A `Private` surface may be changed or deleted inside its owner without a contract process.
- A surface must not be relabeled to a weaker class merely to avoid the migration or verification obligations created by existing durable data.

After the launch boundary, replacement of a settled operation's semantic contract follows Operation Semantic Promise. The release-coupled demotion rule still applies before that boundary, and it still applies to transport, packaging, and user-interface surfaces.

## Boundaries And Non-Goals

This document owns stability classes, stabilization mechanisms, retained data continuity, the closed core and open extension of every owned data shape, promotion and demotion rules, strictness expectations, conformance dimensions, the lifecycle of breaking changes, and the post-launch operation semantic promise.

This document does not classify the current release's individual contract families. A baseline specification owns that inventory because implementation readiness and current scope change more frequently than Core doctrine.

This document does not define the canonical meaning of `Workspace`, `Thread`, `Turn`, `Item`, protocol envelopes, storage records, permission decisions, capability calls, usage records, audit events, knowledge records, or deployment shapes.

This document does not require migration shims for old data. A one-time migration preserves durable truth without keeping an obsolete runtime reader.

This document does not create a compatibility promise for independently versioned third-party clients. Such a promise requires a separately accepted support policy and an explicit promotion of the relevant API surface.

This document does not promote transport placement, packaging, or user-interface details into the operation semantic promise, and that promise does not change Retained Data Continuity. It does not define the blocking permission or an availability report. Blocking remains the deployment decision stated in Operation Semantic Promise. An operation the deployment cannot support is an availability condition its owner already reports, and an owner's or administrator's choice to keep users from an operation is a permission deferred to the Policy Kernel. Neither case changes the operation definition.

## Invariants

- Every supported surface MUST follow its declared stability class and stabilization mechanism.
- Refactoring MUST remove obsolete implementations rather than add compatibility layers, deprecated shims, or dual writes. A breaking change to retained data MUST keep that data usable under Retained Data Continuity; a temporary migration path exists only when the accepted design defines one. Any transition that a separately accepted contract requires MUST follow that contract's lifecycle; it is not an exception for preserving obsolete code.
- Product projections, App APIs, adapters, storage layers, runtime bridges, Skills, CLIs, and UI read models MUST NOT redefine Core concepts they only project.
- Implementation-private payloads, native runtime logs, provider-native events, backend diagnostics, launch commands, absolute local paths, and environment variables MUST NOT become supported contracts by accident.
- Newly introduced external dependencies MUST use official unmodified releases. Missing stock capability MUST be handled through a bounded local guard, upstream change, or design reconsideration rather than a dependency fork, patch, or monkey-patch; previously authorized vendor snapshots retain their existing governed status.
- Any change to a promoted aspect MUST update the owning document, matching schemas or fixtures, affected migrations, and the implementation tests that enforce the behavior.
- A reader MUST ignore unknown additive fields, members, files, and entries outside the closed core and MUST NOT require a tolerant location before doing so. A writer SHOULD preserve those fields when it rewrites the same canonical record. An unknown core value MUST fail closed at admission and MUST NOT be coerced, defaulted, or passed on. An extension that changes how a core field is read, or that carries authority or security meaning, MUST be marked required by its owner, and a reader that does not understand it MUST fail closed rather than ignore or infer it. Ignored content from a producer outside the reader's trust boundary MUST NOT be persisted, forwarded, or displayed unless its owner defines that use.
- Release-coupled consumers MUST fail with a typed incompatibility instead of guessing across an unknown contract identity.
- Before the launch boundary, an operation semantic contract MUST remain `Release-coupled`. At the launch boundary, a settled operation semantic contract MUST become `Durable`, with Operation Semantic Promise as its evolution rule, and its transport, packaging, and user-interface projections MUST remain at their existing stability classes. After that boundary, a settled operation's semantic contract MUST change only by addition, deprecation, or retirement, an operation id MUST NOT be reused, and the freeze MUST cover input and output meaning, effects, and declared authority requirements. Retained Data Continuity MUST still hold for retained records and captured bindings, including when an operation changes before launch.

## Conformance Dimensions

`Core model conformance` means an implementation preserves the Core object boundaries, naming rules, ownership hierarchy, and contract-evolution rules.

`Protocol conformance` means an implementation preserves the claimed protocol version, IDs, request IDs, event envelopes, error shapes, ordering rules, item lifecycle, and schema rules.

`Product projection conformance` means an App API, client, Skill, CLI, UI, adapter, storage layer, or external bridge projects the Core model without redefining it.

`Boundary conformance` means an implementation does not expose private runtime config, provider state, OAuth state, diagnostics, backend paths, worker-private handles, launch commands, or environment variables as promoted Core contracts.

Conformance dimensions describe what is being verified. They are not stability levels and must not be used as substitutes for `Durable`, `Release-coupled`, `Experimental`, or `Private`.

## Partial Conformance

An implementation may claim conformance only for the contract families it actually supports.

Deferring implementation does not permit redefining a promoted concept, using conflicting names, emitting shapes that block later implementation, or claiming a complete surface when required producers or enforcement points are absent.

## Schema And Fixture Conformance

Strict schemas are the source of truth for the known core of protocol and release-coupled payloads. Readers do not reject unknown additive content; they ignore it under Closed Core, Open Extension. Forward-compatible live stream readers may preserve unknown optional event or payload families, and fixtures for known records, commands, and events must continue to use strict schemas for that known core.

Conformance coverage should include, where relevant:

- IDs, timestamps, and request correlation
- event envelope shape and stream ordering
- item lifecycle and item-delta compatibility
- valid and invalid schema examples
- exact contract or protocol identity
- additive optional field handling, including that readers ignore unknown additive content and do not reject it
- unsupported required-feature handling
- unknown core values failing closed without coercion, defaulting, or passing on
- authority-bearing fail-closed behavior
- export boundaries for private schemas
- migration and data-continuity evidence for durable persisted changes

Every fixture file that targets a versioned family MUST identify the version or contract identity it targets.

## Change Rules

| Change | Rule |
| --- | --- |
| Add optional descriptive field | Requires schema, fixture or test, and documentation updates for the owner. Readers that do not understand it ignore it when it stays outside the closed core and is not required. An extension that changes how a core field is read, or carries authority or security meaning, MUST be marked required by its owner. An authority- or security-bearing extension follows the authority-bearing row. |
| Add required field | Breaking; requires the transition mechanism of the surface's stability class and a version or exact release identity change. |
| Add authority-bearing field | Requires an accepted design, a registered required feature or equivalent contract gate, strict validation, and fail-closed behavior. |
| Remove or rename field | Breaking; update all current consumers and remove aliases in the same release. Persisted durable data requires a one-way migration. |
| Add event or command family | Requires schema, discovery where relevant, fixture or test, documentation, and an explicit stability classification. |
| Add closed enum value | Requires consumer handling, documentation, tests, and storage or index updates when relevant. |
| Add extension namespace | Allowed when optional and safely ignorable outside the closed core; readers that do not understand it ignore it. Otherwise its owner MUST mark it required, and a reader that does not understand it MUST fail closed. |
| Change release-coupled operation shape | Update all first-party producers and consumers together, advance exact contract identity, and remove the old shape. |
| Remove persisted durable shape | Requires a one-way migration or an explicit data-retirement decision with a migration report; a permanent legacy reader is not required. |
| Change private implementation detail | Remains inside its owner and must continue to satisfy boundary tests. |

Breaking changes to surfaces that ship with each release do not require deprecation windows or compatibility adapters unless a separately accepted contract explicitly creates that obligation. Retained data follows Retained Data Continuity. A change to a settled operation's semantic contract after the launch boundary follows Operation Semantic Promise instead of an in-place reshape. Before that boundary, the release-coupled operation-shape row applies.

## Extension Namespaces

Provider-native, adapter-native, and experimental fields must live under explicit extension namespaces when they cross an intentional boundary.

A reader ignores an unknown additive extension namespace outside the closed core. A writer preserves that namespace when rewriting the same canonical record only when preservation is safe and practical. Content from a producer outside the reader's trust boundary is not persisted, forwarded, or displayed unless its owner defines that use.

Unknown required extension namespaces MUST block readiness with an explainable error. Their owners mark extensions required under [Closed Core, Open Extension](#closed-core-open-extension).

## Version And Capability Discovery

Every versioned contract family must expose enough identity for consumers to decide whether they can process it safely.

Discovery may include:

- protocol or contract version
- exact release-coupled contract identity or digest
- supported feature flags
- supported event, item, delta, and command families
- required features
- permission, sandbox, or authority summary support

The exact endpoint or transport shape belongs to the owning projection.

## Storage Strictness Versus Live Projection Strictness

Durable storage and manifest readers MUST ignore unknown additive fields, members, files, and entries outside the closed core, without an owner first declaring a tolerant location. Writers SHOULD preserve those fields when rewriting the same canonical record whenever preservation is safe and practical; an owning record contract MAY require stronger preservation for referenced content. Ignored content from a producer outside the reader's trust boundary is not persisted unless its owner defines that use.

Open extension does not relax protocol, App API, CLI, Skill, or UI projection strictness. A projection MUST emit a strictly valid payload for its exact claimed contract identity and MUST drop safely ignorable storage extensions rather than forwarding unknown fields. Ignored content from a producer outside the reader's trust boundary MUST NOT be persisted, forwarded, or displayed unless its owner defines that use. An owner-defined use still MUST satisfy the projection's claimed contract.

Unsupported authority-bearing semantics, required features, unknown core values, canonical record families, or major format versions MUST fail closed or enter the quarantine behavior defined by their owner.

## Hand-Written Configuration

A reader of operator- or user-authored configuration ignores an unknown key as an open extension, and it reports a warning diagnostic that names the key and its location, so that a configuration written for a newer release does not stop an older one and a misspelled key is not silent. The warning reaches the operator through the same channel as other configuration errors. An unknown value of a closed-core field fails closed at admission and is never coerced, defaulted, or passed on. An unknown key inside an authority-bearing section, and a feature the file declares as required, fail closed. Generated and machine-written configuration follows the storage rules above.

## Relationships To Other Core Aspects

`core-concepts.md` owns shared object boundaries and naming rules.

`protocol.md` owns protocol records, commands, events, envelopes, lifecycle states, error shapes, item delta kinds, and protocol version semantics.

`communication.md` owns command, event, streaming, and transport projections.

`storage.md`, `identity.md`, `vault.md`, `permissions.md`, `sandbox.md`, `agent-capability.md`, `audit.md`, and `metering.md` own their aspect-specific semantics and invariants.

This document owns the cross-aspect rule for how those contracts are classified, changed, promoted, and judged for conformance.

## Related Docs

- `docs/core/README.md`
- `docs/core/core-concepts.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
