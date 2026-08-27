---
status: Accepted
implementation: Partial
updated: 2026-08-04
---
# Vendor Snapshot Packages

## Owns

This spec owns the repository packaging contract for externally sourced runtime and catalog snapshots under `packages/`.

It owns the rule that external boundary snapshots must be packaged, validated, refreshed, and reviewed separately from OpenKit-owned protocol and runtime source.

It owns what a snapshot must contain when a consuming specification depends on the upstream project's protocol-level behaviour, and the evidence quality a snapshot refresh requires.

It also owns the standing obligation that changing a pinned upstream release re-runs whatever feasibility or realization gate its consuming specification defines. That obligation is deliberately broader than this packaging contract: it follows the pin, not the directory. A pinned external boundary recorded in an application's own pin manifest rather than in a `packages/` snapshot carries the same obligation, and its owning specification states where the manifest lives.

## Does Not Own

This spec does not own OpenKit protocol schemas, NanoCore provider-template behavior, live catalog fetching, dynamic provider marketplaces, model-routing policy, package-local refresh procedures, external upstream release cadence, NanoHost lifecycle, or stock transport feasibility.

It does not decide which upstream release a consumer should pin, and it does not define the content of any consumer's feasibility or realization gate. It owns only the rule that such a gate must be re-run when the pin changes.

## Core References

- `docs/core/protocol.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`

## Summary

OpenKit keeps externally sourced runtime and catalog artifacts in dedicated workspace packages under `packages/`.

`@openkit/codex-app-server-schema` owns the generated Codex app-server JSON Schema snapshot as an external worker runtime boundary.

`@openkit/models-dev-catalog` owns vendored `models.dev` API snapshots and provider-template traceability checks as an external model-catalog boundary.

`@openkit/openshell-schema-snapshot` owns the vendored exact-version OpenShell provider profile, sandbox policy, CLI surface, reserved namespace, and checksum snapshot as an external sandbox-mechanism boundary. The current boundary is the unmodified stock `0.0.80` release, not a compatibility range.

The core rule is that these artifacts are read-only boundary snapshots at runtime, not OpenKit canonical protocol definitions and not live network dependencies.

## Goals / Non-goals

The goal is to make external artifacts easy to find, validate, review, and refresh without mixing them into OpenKit's own protocol source of truth.

The goal is also to keep NanoCore boot deterministic by avoiding live network fetches for external schema or model catalog data.

This spec does not introduce a runtime catalog fetcher, a dynamic provider marketplace, or a new OpenKit protocol family.

## Background

Codex app-server schemas were originally consumed by NanoCore's host adapter, but they describe an external JSON-RPC surface rather than OpenKit's own protocol.

The `models.dev` API snapshot informs provider-template traceability, but it is an upstream catalog snapshot rather than NanoCore runtime source.

Both artifacts are external snapshots with independent update cadence, source metadata, and review requirements.

## Decision

Codex app-server JSON Schema files live in `packages/codex-app-server-schema/generated-schema/`.

The Codex schema package includes `metadata.json`, a `generate:schema` script, a validation script, and package-local maintenance guidance.

models.dev API snapshots live in `packages/models-dev-catalog/snapshots/YYYY-MM-DD/`.

The models.dev package includes package-local validation that checks snapshot metadata, checksum, parseability, and NanoCore provider-template mappings.

OpenShell schema snapshots live in `packages/openshell-schema-snapshot/snapshots/YYYY-MM-DD/`.

The OpenShell package includes package-local conformance helpers and validation tests for snapshot metadata, checksums, provider profile reserved namespaces, sandbox policy enum values, the exact NanoCore-consumed CLI command surface, and the exact required CLI and Gateway version.

`@openkit/protocol` remains limited to OpenKit's own `UI <-> Core` contract.

NanoCore may consume these packages as external boundary snapshots, but NanoCore must not own their refresh procedures.

## Contract / Expected Behavior

Each external snapshot package must include an `AGENTS.md`, a `README.md`, a `package.json`, snapshot metadata, and a `test` script that validates the committed artifacts.

Snapshot packages must keep package-local maintenance guidance close to the artifacts they govern.

Runtime boot must not refresh or live-fetch these external snapshots.

Generated and vendored snapshot diffs must be reviewed as external boundary updates before any dependent OpenKit runtime or provider-template changes are accepted.

OpenKit-owned protocol schemas must remain in `@openkit/protocol`, not in external snapshot packages.

### Consumed Interface Definitions

When a consuming specification depends on an upstream project's protocol-level behaviour rather than only its command-line or configuration surface, the snapshot MUST vendor the consumed machine-readable interface definitions themselves — protobuf files, JSON Schema, IDL, or the equivalent — and its checksums MUST cover those files individually. A hand-authored surface document is a useful summary and is never a substitute: a summary cannot be diffed against the next upstream release at the level the consumer depends on.

A snapshot MUST also record, in its metadata, every value the consumer depends on that exists only in upstream implementation rather than in the interface definition. Timeouts, chunk sizes, buffer sizes, pending-claim deadlines, and flow-control window behaviour are such values. Recording them is what makes them reviewable when the pin moves; a consumer MUST NOT assume a value the snapshot has not recorded at the pin.

### Snapshot Evidence Quality

Snapshot refresh evidence MUST come from a complete non-shallow checkout of the exact immutable upstream tag, and the snapshot metadata MUST record the resolved tag and commit. A development branch, a floating reference, a shallow clone, a rendered release page, or an uncommitted working tree is not snapshot evidence, and a value read from one of those sources MUST NOT be recorded as observed at the pin.

An upstream artifact set is complete for a pin only when every consumed component resolves to that same tag. A mixed, relabelled, or partially resolved set is invalid.

### Standing Re-Pin Obligation

This subsection applies to every pinned external boundary, wherever its pin is recorded.

Changing the pinned upstream release of a consumed external boundary is not a version bump. Before the new pin becomes selectable, the change MUST refresh the snapshot from the new immutable tag under the rules above, give every consumed-surface difference an explicit compatible, adapted, or blocking disposition, and re-run every feasibility or realization gate the consuming specification defines over that boundary.

An upstream release published after the pin creates no obligation to adopt it and no permission to adopt it without that gate. This obligation is standing rather than one-time, and it applies whether the pin change is initiated by a consumer or by ordinary snapshot maintenance.

NanoCore adapter logic and provider-template logic must remain in NanoCore-owned packages, not in external snapshot packages.

## Accepted Design

Codex schema refreshes use the pinned local Codex CLI command recorded in package metadata.

models.dev refreshes create a new dated snapshot directory and update checksum metadata.

Reviewers should treat generated or vendored artifact diffs as source updates from an external boundary, then separately review any OpenKit code changes needed to adapt to those updates.

## Current Implementation Projection

`packages/codex-app-server-schema/` contains Codex app-server generated schemas, package metadata, a validation script, package-local maintenance guidance, and package-local agent rules.

`packages/models-dev-catalog/` contains dated `models.dev` snapshots, snapshot metadata, checksum validation, provider-template traceability validation, package-local maintenance guidance, and package-local agent rules.

`packages/openshell-schema-snapshot/` contains dated OpenShell schema snapshots, snapshot metadata, checksum validation, provider profile and sandbox policy conformance helpers, package-local maintenance guidance, and package-local agent rules.

The OpenShell snapshot is scheduled for removal rather than repair. It was created because NanoCore drove OpenShell through its command-line surface and needed a frozen record of a presentation surface it was parsing, which is exactly the case a hand-vendored surface document serves. The accepted execution-runtime design replaces that with a compiled exact-tag client, so the boundary becomes code that must compile and link, and its pin moves into the consuming application's own pin manifest under `docs/specs/20260802-nanohost_runtime_and_transport.md`. Its remaining non-protocol contents — the OpenKit-to-OpenShell sandbox policy and provider-profile mappings — are OpenKit semantic contracts that were never vendor material and return to their existing enforcement-mapping and provider owners. Removal happens with the retired path, not before, because the current TypeScript consumers are part of that path.

Until then, the active OpenShell snapshot does not satisfy the consumed-interface-definition rule above. It vendors hand-authored CLI, policy, and provider-profile surface documents and its checksums cover only those three documents; it vendors no protobuf file, and it records none of the upstream implementation values a protocol-level consumer depends on. That gap is why this specification's implementation status is `Partial`, and closing it is the refresh work owned by the consuming NanoHost program rather than a defect in the packaging contract.

The retained historical OpenShell snapshot pins the official unmodified `0.0.80` release and the exact CLI surface consumed by the deleted NanoCore adapter and fixed Cell helper. It contains no sandbox-delete, provider-delete, host-doctor, custom-binary, insecure-Gateway, or version-range contract. Current resource teardown belongs to `docs/specs/20260802-nanohost_runtime_and_transport.md`; the NanoHost app-local `0.0.99` pin and retained A1 gate now prove the stock RelayStream plus nested standard HTTP/2 path.

`@openkit/codex-app-server-schema` and `@openkit/models-dev-catalog` remain ordinary snapshot packages under this contract; neither is affected by the OpenShell removal.

These packages expose package-local `test`, `lint`, and `format` scripts through their `package.json` files; packages with TypeScript helper exports also expose `typecheck` and `build`.

NanoCore consumes these packages as external boundary inputs while keeping provider-template behavior and adapter behavior outside the snapshot packages.

## Alternatives Considered

Keeping Codex schemas inside NanoCore was simple while NanoCore was the only consumer, but it made external boundary maintenance look like adapter implementation.

Keeping models.dev under repository-level `vendor/` worked for the first release, but it did not provide package-local commands or ownership.

Moving both artifacts into `@openkit/protocol` was rejected because Codex app-server and models.dev are not OpenKit `UI <-> Core` protocol definitions.

Creating one generic third-party package was rejected because Codex schema and models.dev have different consumers, update cadence, and validation rules.

## Consequences

The root workspace has dedicated private packages for external boundary snapshots.

Artifact refreshes have package-local commands and review checklists.

Large generated files may require package-level formatting exceptions, while package validation still parses and checks the important metadata.

External snapshot updates become explicit maintenance work rather than incidental NanoCore implementation churn.

## Completed Migration

Codex generated schemas were moved out of NanoCore-owned source and into `packages/codex-app-server-schema/`.

`models.dev` snapshots were moved out of the repository-level vendor area and into `packages/models-dev-catalog/`.

OpenShell schema surfaces were added under `packages/openshell-schema-snapshot/` for NanoCore OpenShell artifact conformance.

Active docs, package scripts, ignore rules, and validation tests now point at the package paths.

Future snapshot refreshes should follow the package-local refresh procedures rather than repeating the migration.

## Testing Strategy

`@openkit/codex-app-server-schema` validates required generated schema files and metadata.

`@openkit/models-dev-catalog` validates metadata, checksum, snapshot parseability, and provider-template traceability.

`@openkit/openshell-schema-snapshot` validates metadata, checksums, provider profile namespace rules, sandbox policy enum values, the retained non-delete CLI command surface, and exact stock OpenShell `0.0.80` identity.

A snapshot whose consuming specification depends on protocol-level behaviour additionally validates that the consumed interface definitions are present, individually checksummed, and resolved from the recorded tag and commit, and that every upstream implementation value the consumer depends on is recorded in metadata.

A pin change validates that the re-pin obligation ran: refreshed snapshot from the new immutable tag, an explicit disposition for every consumed-surface difference, and a recorded result for every feasibility or realization gate the consuming specification defines.

NanoCore tests continue to validate runtime behavior against provider templates and Codex adapter code.

## Risks & Mitigations

Generated artifact drift can be missed if maintainers update files without running package-local tests.

Mitigation: keep package `test` scripts small, deterministic, and part of normal verification.

Provider-template drift can occur when models.dev changes provider IDs or model IDs.

Mitigation: validate provider mappings against NanoCore templates and require diff review before committing snapshot refreshes.

## Resolved Decisions

No unresolved decisions remain.

## Deferred / Future Work

- Decide whether release automation should run external snapshot package tests as a distinct verification stage.
- Decide whether Codex schema metadata should record aggregate file checksums after the next schema refresh.

## Links

- `packages/codex-app-server-schema/README.md`
- `packages/models-dev-catalog/README.md`
- `packages/openshell-schema-snapshot/README.md`
- `packages/protocol/README.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
