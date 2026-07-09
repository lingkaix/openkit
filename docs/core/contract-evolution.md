# Contract Evolution Model

Status: Accepted

This document owns how OpenKit core contracts evolve and how implementations are judged against the promoted core model.

This document does not own core-document authoring rules, canonical object definitions, protocol record semantics, transport behavior, storage layout, App API endpoints, or implementation migration plans.

## Purpose

OpenKit needs stable semantics even while packages, implementations, adapters, and deployment shapes change.

This model defines the rules for changing current contracts without losing clarity, hiding legacy behavior, or allowing product projections to redefine the core model.

## Principles

- The clean current contract wins over legacy compatibility during internal development.
- Breaking changes should be explicit, spec-backed, schema-backed, and test-backed.
- Removed fields, aliases, route shapes, persisted snapshots, and config shapes should fail clearly instead of being silently repaired or accepted.
- Conformance means preserving the promoted OpenKit model, not reproducing one package layout, UI shape, runtime backend, or deployment topology.
- Forward-compatible live parsing is allowed only at bounded edges where unknown future data can remain inspectable without redefining known current records.
- Future storage and manifest formats should be additive by default after their accepted baseline, while unsupported authority-bearing semantics must fail closed.

## Canonical Terms

`Current contract` means the accepted set of core records, schemas, lifecycle states, commands, events, projection boundaries, and validation behavior that active implementations must follow.

`Contract evolution` means changing a current contract through an accepted design, matching schema updates, implementation updates, fixtures or tests, and documentation updates.

`Breaking change` means a change that removes, renames, tightens, or reinterprets a field, enum value, command, event, route shape, stored shape, capability flag, or validation rule that existing current-contract consumers could depend on.

`Compatibility shim` means code or schema behavior that accepts an obsolete shape only to preserve old clients, old data, old aliases, or old routes after the current contract has moved on.

`Conformance` means an implementation, projection, adapter, or package preserves the relevant OpenKit core contracts and boundaries.

`Conformance fixture` means a machine-readable example used to prove that schemas, parsers, generated JSON Schema, and implementation behavior agree with the current contract.

`Required feature` means a declared feature, capability, minimum Core version, or schema requirement that a reader must understand before it can safely process a record, manifest, or storage family.

## Boundaries And Non-Goals

This document owns contract-evolution rules, conformance levels, strictness expectations, and the lifecycle of breaking changes.

This document does not define the canonical meaning of `Workspace`, `Thread`, `Turn`, `Item`, protocol envelopes, item delta kinds, storage records, permission decisions, capability calls, usage records, audit events, knowledge records, or deployment shapes.

This document does not define the writing standard for core aspect files. Core documentation structure, canonical-definition routing, requirement keyword usage, and aspect ownership rules belong to `docs/core/README.md` and `docs/core/AGENTS.md`.

This document does not require migration shims for old internal data. A spec may define a one-time migration or diagnostic report, but that is an implementation plan rather than a standing compatibility guarantee.

## Current Contract Surface

The current contract includes the stable portions of:

- shared core object boundaries and naming rules
- protocol records, commands, command `requestId` behavior, event envelopes, event names, lifecycle semantics, stream cursor semantics, item types, item delta kinds, lifecycle enums, and error code namespaces
- generated protocol JSON Schema and conformance fixtures
- App API projections that expose current OpenKit behavior
- runtime config, provider setup, agent setup, OAuth account-slot, vault, permission, sandbox, agent capability, usage, audit, storage, and identity boundaries when those shapes are promoted into current docs or accepted specs

Current strict parsing rejects:

- turns without explicit `configVersion`
- command-execution items without explicit `output`
- SSE envelopes without explicit `protocolVersion`
- API error payloads without explicit `protocolVersion`
- item deltas without explicit `itemType`
- removed protocol alias exports
- removed app API diagnostics fields
- removed config fields such as top-level `dataRoot` and inline provider secrets
- removed OAuth routes that do not include `accountSlotId`

Forward-compatible stream parsing is allowed only for additive future event families or future item types. Known event and item-delta payloads must still satisfy strict current schemas.

Forward-compatible storage and manifest parsing MAY ignore unknown optional fields only when those fields do not affect authority, safety, retention, billing, or product meaning.

Storage tolerance never relaxes protocol strictness. When tolerant storage records project into protocol or App API payloads, the projection layer MUST emit strictly valid current-contract payloads and MUST drop unknown optional storage fields rather than forwarding them.

## Invariants

Current-contract durable records, commands, events, API payloads, generated schemas, and conformance fixtures MUST be validated against their strict current schemas.

Compatibility shims MUST NOT remain after an accepted spec removes an old shape unless the accepted spec explicitly defines a temporary migration path.

Product projections, app APIs, adapters, storage layers, runtime bridges, and UI read models MUST NOT redefine core concepts they only project.

Implementation-private payloads, native runtime logs, provider-native events, backend diagnostics, launch commands, absolute local paths, and environment variables MUST NOT become stable core records by accident.

Any contract change that affects a promoted aspect MUST update the owning core document, matching schemas or fixtures, and the implementation tests that enforce the behavior.

Optional unknown fields MAY be ignored only when ignoring them cannot change authority, safety, retention, billing, or product meaning.

## Conformance Levels

`Core model conformance` means an implementation preserves the core object boundaries, naming rules, ownership hierarchy, and contract-evolution rules.

`Protocol conformance` means an implementation preserves protocol versioning, IDs, request IDs, event envelopes, error shapes, ordering rules, item lifecycle, and schema compatibility.

`Product projection conformance` means an App API, UI, adapter, storage layer, or external bridge projects the core model without redefining it.

`Boundary conformance` means an implementation does not expose app-only runtime config, Settings/Admin schema, diagnostics, provider config, OAuth state, internal-agent diagnostics, dashboard read models, absolute local paths, worker-private paths, launch commands, or environment variables as stable core protocol records.

## Initial Conformance

Early implementations may defer implementation of vault, identity, full permission policy, agent capability gateway projection, usage persistence, audit persistence, remote agents, and hardened sandboxing.

Deferring an implementation does not permit redefining the concept, using conflicting names, or emitting protocol shapes that block later implementation.

## Schema And Fixture Conformance

Machine-readable protocol schemas should live in the active protocol schema package.

Strict schemas are the source of truth for conformance fixtures. Forward-compatible live stream parsers may accept unknown event or payload shapes, but conformance fixtures for core records, commands, and known events must continue to use strict schemas.

Conformance fixtures should cover at least:

- IDs and timestamp shapes
- command request ID behavior
- event envelope shape
- required nullable event envelope request correlation
- stream sequence ordering
- item lifecycle events
- item delta kinds
- valid and invalid item type to delta kind combinations
- request delta correlation through `requestRefId`
- part delta correlation through `partId`
- API error shape and error code namespace
- additive optional field handling
- export guard behavior for app-only schemas such as runtime config

Some coverage areas may be exercised by schema unit tests rather than JSON fixture round-trips when a fixture would not add useful signal.

Minimal agent conformance requires support for `text-delta` and authoritative `item.completed` payload reconciliation.

Other item delta kinds are optional unless the agent advertises or emits item types that require them.

Each conformance fixture file MUST declare the `protocolVersion` it targets.

Fixtures for replay or stream behavior SHOULD include the stream kind and cursor scope.

## Change Rules

| Change | Rule |
| --- | --- |
| Add optional field | Requires schema, fixture or test, and docs updates. |
| Add optional forward-compatible storage or manifest field | Allowed after the accepted baseline when the field is descriptive or ignorable; requires tests for unknown-field tolerance when the owning spec promises tolerance. |
| Add required field | Breaking; requires an accepted spec and version bump when it affects protocol. |
| Add authority-bearing field | Requires a required feature, minimum Core version, required capability, or equivalent fail-closed gate. |
| Remove field | Breaking; remove consumers, tests, generated schemas, and current docs in the same change. |
| Rename field | Breaking; do not keep aliases unless an accepted spec explicitly introduces a temporary migration path. |
| Add event family | Requires capability discovery, schema, fixture or test, and docs updates. |
| Add command family | Requires capability discovery, schema, fixture or test, and docs updates. |
| Add closed enum value | Requires client handling, docs, tests, and storage or index updates when relevant. |
| Add extension namespace | Allowed when optional and ignorable, or when an accepted spec makes it required with readiness behavior. |
| Remove route alias | Breaking; remove clients and tests in the same change. |
| Remove persisted shape | Breaking; add a clear loader error, one-time migration, or diagnostic report as the accepted spec requires. |

Adding, removing, or tightening a required field is breaking and requires an accepted spec plus a protocol or App API schema update.

Because the project is internal, breaking changes do not require compatibility adapters unless the accepted spec explicitly asks for a migration.

## Extension Namespaces

Provider-native, adapter-native, and experimental fields must live under explicit extension namespaces.

Unknown optional extension namespaces may be preserved.

Unknown required extension namespaces must block readiness with an explainable error.

## Protocol Version And Discovery

Core must expose protocol version and capability discovery before clients enable advanced features.

The protocol field name is `protocolVersion`.

Capability discovery should advertise:

- supported `protocolVersion`
- supported feature flags
- supported event families
- supported item types
- supported item-delta kinds
- supported command families when command discovery is promoted
- permission and sandbox summary support when those areas are promoted

Exact endpoint shape belongs to app/API documentation.

## Storage, Config, And App API

Old persisted JSON snapshots, old config files, and old app API payloads are not auto-migrated during internal development unless an accepted spec explicitly adds a migration.

Loaders should fail with a clear error when they encounter removed worker-shaped workspace fields, top-level config `dataRoot`, provider inline secrets, or Codex OAuth providers without explicit account-slot binding.

After the accepted storage and manifest baseline, unknown optional non-authority-bearing fields may be ignored, and unsupported required features fail closed across storage records, manifests, AEP snapshots, evidence bundles, vault injection plans, mount declarations, provider attachment modes, and capability families.

## Relationships To Other Core Aspects

`core-concepts.md` owns shared object boundaries and naming rules.

`protocol.md` owns protocol records, commands, events, envelopes, lifecycle states, error shapes, item delta kinds, and protocol version semantics.

`communication.md` owns command, event, streaming, and transport projections.

`storage.md`, `identity.md`, `vault.md`, `permissions.md`, `sandbox.md`, `agent-capability.md`, `audit.md`, and `metering.md` own their aspect-specific contract surfaces.

`docs/app-api.md` owns App API endpoint and read-model details.

This document owns the cross-aspect rule for how those contracts change and how implementations are judged for conformance.

## Conformance Scope

Protocol and App API fixtures are the default conformance boundary for the current core model.

Additional fixture packages or conformance levels are introduced only when a promoted core aspect cannot be validated through protocol, App API, storage, or existing package tests.

Supported command-family discovery belongs to the communication model and must be advertised through stable discovery records once promoted.

## Related Docs

- `docs/core/README.md`
- `docs/core/core-concepts.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/app-api.md`
