# Vendor Snapshot Packages

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the repository packaging contract for externally sourced runtime and catalog snapshots under `packages/`.

It owns the rule that external boundary snapshots must be packaged, validated, refreshed, and reviewed separately from OpenKit-owned protocol and runtime source.

## Does Not Own

This spec does not own OpenKit protocol schemas, NanoCore provider-template behavior, live catalog fetching, dynamic provider marketplaces, model-routing policy, package-local refresh procedures, or external upstream release cadence.

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

NanoCore adapter logic and provider-template logic must remain in NanoCore-owned packages, not in external snapshot packages.

## Accepted Design

Codex schema refreshes use the pinned local Codex CLI command recorded in package metadata.

models.dev refreshes create a new dated snapshot directory and update checksum metadata.

Reviewers should treat generated or vendored artifact diffs as source updates from an external boundary, then separately review any OpenKit code changes needed to adapt to those updates.

## Current Implementation Projection

`packages/codex-app-server-schema/` contains Codex app-server generated schemas, package metadata, a validation script, package-local maintenance guidance, and package-local agent rules.

`packages/models-dev-catalog/` contains dated `models.dev` snapshots, snapshot metadata, checksum validation, provider-template traceability validation, package-local maintenance guidance, and package-local agent rules.

`packages/openshell-schema-snapshot/` contains dated OpenShell schema snapshots, snapshot metadata, checksum validation, provider profile and sandbox policy conformance helpers, package-local maintenance guidance, and package-local agent rules.

The active OpenShell snapshot pins the official unmodified `0.0.80` release and the exact CLI surface consumed by NanoCore and the fixed Cell helper. It contains no sandbox-delete, provider-delete, host-doctor, custom-binary, insecure-Gateway, or version-range contract. Resource teardown belongs to the whole-Cell recycle contract in `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`, not to the vendor snapshot.

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
