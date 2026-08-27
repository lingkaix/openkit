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
- The clean current contract wins over legacy compatibility during internal development.
- Durable does not mean immutable. A durable contract may change through an explicit design, version transition, data migration when needed, and matching verification.
- Release-coupled surfaces may break between coordinated OpenKit releases without deprecation windows, aliases, or compatibility adapters.
- Experimental and private shapes must not become authority-bearing or persistent dependencies by accident.
- Product projections must preserve promoted Core meaning without becoming the owner of that meaning.
- Unknown semantics that affect authority, safety, retention, billing, or product meaning must fail closed.

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
- Promoted persisted record families, portable formats, authority boundaries, and cross-release protocol families are `Durable` only when an owning document or accepted baseline explicitly identifies them and defines their evolution mechanism.
- App APIs, generated API projections, first-party clients, bundled CLIs, unified Skills, Web projections, and other presentation or operation surfaces are `Release-coupled` by default.
- A surface explicitly labeled experimental is `Experimental` until promotion.
- Package layout, database engine details, provider-native payloads, adapter-native events, backend handles, local paths, process commands, caches, and diagnostics internals are `Private` unless deliberately promoted.
- A surface without an intentional owner and classification must not be treated as a contract merely because a consumer can currently observe it.

## Stabilization Mechanisms

| Contract kind | Required stabilization mechanism |
| --- | --- |
| Core semantics and lifecycle invariants | One canonical Core owner, normative invariants, explicit promotion, and conformance coverage at every claimed projection. |
| Durable protocol or schema family | Explicit version identity, strict schemas for known records, generated schema drift checks where applicable, valid and invalid fixtures, and capability or required-feature discovery for additive semantic extensions. |
| Persisted data and storage ownership | Schema or layout version, source-of-truth declaration, one-way migration for breaking changes, migration report, recovery behavior, and data-continuity verification. |
| Export, import, backup, and portable manifests | Format version, exact inventory and integrity validation, required-feature handling, import fixtures, round-trip tests, and explicit identity or authority rebinding rules. |
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
- authority-bearing unknowns fail closed
- all existing first-party projections agree with the promoted meaning or are explicitly outside the claim

Promotion from `Experimental` or `Private` is a contract change. Existing accidental consumers do not force promotion and do not create a compatibility obligation.

## Demotion And Removal

- A `Durable` surface may be removed or reinterpreted only through an accepted design and a versioned transition that preserves or explicitly migrates affected durable truth.
- A `Release-coupled` surface may be replaced in the next coordinated release without a deprecation period, but old producers, consumers, aliases, routes, schemas, and tests must be removed together.
- An `Experimental` surface may be removed directly after its bounded evidence and any accepted conclusions are retained.
- A `Private` surface may be changed or deleted inside its owner without a contract process.
- A surface must not be relabeled to a weaker class merely to avoid the migration or verification obligations created by existing durable data.

## Boundaries And Non-Goals

This document owns stability classes, stabilization mechanisms, promotion and demotion rules, strictness expectations, conformance dimensions, and the lifecycle of breaking changes.

This document does not classify the current release's individual contract families. A baseline specification owns that inventory because implementation readiness and current scope change more frequently than Core doctrine.

This document does not define the canonical meaning of `Workspace`, `Thread`, `Turn`, `Item`, protocol envelopes, storage records, permission decisions, capability calls, usage records, audit events, knowledge records, or deployment shapes.

This document does not require migration shims for old internal data. A one-time migration preserves durable truth without keeping an obsolete runtime reader.

This document does not create a compatibility promise for independently versioned third-party clients. Such a promise requires a separately accepted support policy and an explicit promotion of the relevant API surface.

## Invariants

- Every supported surface MUST follow its declared stability class and stabilization mechanism.
- Compatibility shims MUST NOT remain after an accepted design removes an old shape unless that design explicitly defines a temporary migration path.
- Product projections, App APIs, adapters, storage layers, runtime bridges, Skills, CLIs, and UI read models MUST NOT redefine Core concepts they only project.
- Implementation-private payloads, native runtime logs, provider-native events, backend diagnostics, launch commands, absolute local paths, and environment variables MUST NOT become supported contracts by accident.
- Newly introduced external dependencies MUST use official unmodified releases. Missing stock capability MUST be handled through a bounded local guard, upstream change, or design reconsideration rather than a dependency fork, patch, or monkey-patch; previously authorized vendor snapshots retain their existing governed status.
- Any change to a promoted aspect MUST update the owning document, matching schemas or fixtures, affected migrations, and the implementation tests that enforce the behavior.
- Safely ignorable unknown optional fields MAY be ignored by readers and SHOULD be preserved when a writer rewrites the same canonical record. Unsupported required or authority-bearing semantics MUST fail closed rather than be ignored or inferred.
- Release-coupled consumers MUST fail with a typed incompatibility instead of guessing across an unknown contract identity.

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

Strict schemas are the source of truth for known protocol and release-coupled payloads. Forward-compatible live stream readers may preserve unknown optional event or payload families, but fixtures for known records, commands, and events must continue to use strict schemas.

Conformance coverage should include, where relevant:

- IDs, timestamps, and request correlation
- event envelope shape and stream ordering
- item lifecycle and item-delta compatibility
- valid and invalid schema examples
- exact contract or protocol identity
- additive optional field handling
- unsupported required-feature handling
- authority-bearing fail-closed behavior
- export boundaries for private schemas
- migration and data-continuity evidence for durable persisted changes

Every fixture file that targets a versioned family MUST identify the version or contract identity it targets.

## Change Rules

| Change | Rule |
| --- | --- |
| Add optional descriptive field | Requires schema, fixture or test, and documentation updates. Durable readers may ignore it only when it cannot affect authority or product meaning. |
| Add required field | Breaking; requires the transition mechanism of the surface's stability class and a version or exact release identity change. |
| Add authority-bearing field | Requires an accepted design, a registered required feature or equivalent contract gate, strict validation, and fail-closed behavior. |
| Remove or rename field | Breaking; update all current consumers and remove aliases in the same release. Persisted durable data requires a one-way migration. |
| Add event or command family | Requires schema, discovery where relevant, fixture or test, documentation, and an explicit stability classification. |
| Add closed enum value | Requires consumer handling, documentation, tests, and storage or index updates when relevant. |
| Add extension namespace | Allowed when optional and safely ignorable, or when a required feature makes it fail closed. |
| Change release-coupled operation shape | Update all first-party producers and consumers together, advance exact contract identity, and remove the old shape. |
| Remove persisted durable shape | Requires a one-way migration or an explicit data-retirement decision with a migration report; a permanent legacy reader is not required. |
| Change private implementation detail | Remains inside its owner and must continue to satisfy boundary tests. |

Because OpenKit is in internal development, breaking changes do not require deprecation windows or compatibility adapters unless a separately accepted contract explicitly creates that obligation.

## Extension Namespaces

Provider-native, adapter-native, and experimental fields must live under explicit extension namespaces when they cross an intentional boundary.

Unknown optional extension namespaces may be preserved only when they are safely ignorable.

Unknown required extension namespaces must block readiness with an explainable error.

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

Durable storage and manifest readers may ignore unknown optional non-authority-bearing fields when their owning contract permits it. Writers SHOULD preserve those fields when rewriting the same canonical record whenever preservation is safe and practical; an owning record contract MAY require stronger preservation for referenced content.

Storage tolerance never relaxes protocol, App API, CLI, Skill, or UI projection strictness. A projection MUST emit a strictly valid payload for its exact claimed contract identity and MUST drop safely ignorable storage extensions rather than forwarding unknown fields.

Unsupported authority-bearing semantics, required features, canonical record families, or major format versions MUST fail closed or enter the quarantine behavior defined by their owner.

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
