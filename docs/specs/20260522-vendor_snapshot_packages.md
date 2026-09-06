---
status: Accepted
implementation: Partial
updated: 2026-09-05
---
# Vendor Snapshot Packages

## Owns

This spec owns the repository packaging contract for externally sourced runtime and catalog snapshots under `packages/`.

It owns the rule that external boundary snapshots must be packaged, validated, refreshed, and reviewed separately from OpenKit-owned protocol and runtime source.

It owns what a snapshot package must contain when its consumer deliberately uses checked-in upstream interface files as runtime or generated-code input, and the evidence quality a snapshot refresh requires.

## Does Not Own

This spec does not own OpenKit protocol schemas, NanoCore provider-template behavior, live catalog fetching, dynamic provider marketplaces, model-routing policy, package-local refresh procedures, external upstream release cadence, NanoHost lifecycle, app-local Cargo dependencies, app-local release metadata, or stock transport qualification.

It does not decide which upstream release an application supports, what evidence that application keeps beside its code, or which integration checks qualify a dependency update. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns those decisions for NanoHost and OpenShell.

## Core References

- `docs/core/protocol.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`

## Summary

OpenKit keeps externally sourced runtime and catalog artifacts in dedicated workspace packages under `packages/`.

`@openkit/codex-app-server-schema` owns the generated Codex app-server JSON Schema snapshot as an external worker runtime boundary.

`@openkit/models-dev-catalog` owns vendored `models.dev` API snapshots and provider-template traceability checks as an external model-catalog boundary.

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

`@openkit/protocol` remains limited to OpenKit's own `UI <-> Core` contract.

NanoCore may consume these packages as external boundary snapshots, but NanoCore must not own their refresh procedures.

## Contract / Expected Behavior

Each external snapshot package must include an `AGENTS.md`, a `README.md`, a `package.json`, snapshot metadata, and a `test` script that validates the committed artifacts.

Snapshot packages must keep package-local maintenance guidance close to the artifacts they govern.

Runtime boot must not refresh or live-fetch these external snapshots.

Generated and vendored snapshot diffs must be reviewed as external boundary updates before any dependent OpenKit runtime or provider-template changes are accepted.

OpenKit-owned protocol schemas must remain in `@openkit/protocol`, not in external snapshot packages.

### Consumed Interface Definitions

When a package consumer deliberately compiles, generates from, or loads checked-in upstream machine-readable interface definitions, the snapshot MUST vendor those consumed protobuf files, JSON Schemas, IDLs, or equivalent inputs, and its checksums MUST cover each consumed file. A hand-authored summary is never a substitute for an input the application actually consumes.

This requirement does not make every external library dependency a snapshot package. A package manager lockfile, compiler, official runtime artifact, and consuming application's focused tests remain their ordinary owners. Source evidence retained only to prove one application-specific property belongs beside that application under its consuming specification.

### Snapshot Evidence Quality

Snapshot refresh evidence MUST come from a complete non-shallow checkout of the exact immutable upstream tag, and the snapshot metadata MUST record the resolved tag and commit. A development branch, a floating reference, a shallow clone, a rendered release page, or an uncommitted working tree is not snapshot evidence, and a value read from one of those sources MUST NOT be recorded as observed at the pin.

An upstream artifact set is complete for a pin only when every consumed component resolves to that same tag. A mixed, relabelled, or partially resolved set is invalid.

### Snapshot Refresh Obligation

This subsection applies only to an external snapshot package governed by this specification. A refresh MUST resolve its committed inputs from the exact immutable upstream version and record their source identity and checksums under the package-local contract. Generated or vendored diffs receive separate review from any consuming OpenKit behavior change.

An upstream release creates no obligation to refresh a snapshot. An application dependency update is governed by that application's owner even when both changes happen in one repository slice.

NanoCore adapter logic and provider-template logic must remain in NanoCore-owned packages, not in external snapshot packages.

## Accepted Design

Codex schema refreshes use the pinned local Codex CLI command recorded in package metadata.

models.dev refreshes create a new dated snapshot directory and update checksum metadata.

Reviewers should treat generated or vendored artifact diffs as source updates from an external boundary, then separately review any OpenKit code changes needed to adapt to those updates.

## Current Implementation Projection

`packages/codex-app-server-schema/` contains Codex app-server generated schemas, package metadata, a validation script, package-local maintenance guidance, and package-local agent rules.

`packages/models-dev-catalog/` contains dated `models.dev` snapshots, snapshot metadata, checksum validation, provider-template traceability validation, package-local maintenance guidance, and package-local agent rules.

The legacy `packages/openshell-schema-snapshot/` package has been deleted after its remaining policy consumer moved to the existing policy owner. It was created for the deleted NanoCore CLI adapter and Cell path; NanoHost now compiles the official SDK and uses app-local release metadata and integration tests under `docs/specs/20260802-nanohost_runtime_and_transport.md`. Its former hand-authored CLI, policy, and provider-profile summaries are not a required snapshot of the current NanoHost boundary and MUST NOT be recreated, copied into `apps/nanohost`, or used as OpenShell upgrade evidence.

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

The historical OpenShell schema package was removed after its last policy projection moved into the existing NanoCore policy owner; NanoHost dependency qualification remains app-local under its owning specification.

Active docs, package scripts, ignore rules, and validation tests now point at the package paths.

Future snapshot refreshes should follow the package-local refresh procedures rather than repeating the migration.

## Testing Strategy

`@openkit/codex-app-server-schema` validates required generated schema files and metadata.

`@openkit/models-dev-catalog` validates metadata, checksum, snapshot parseability, and provider-template traceability.

A snapshot that supplies machine-readable inputs validates that every consumed definition is present, individually checksummed, and resolved from the recorded immutable upstream version.

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
- `packages/protocol/README.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
