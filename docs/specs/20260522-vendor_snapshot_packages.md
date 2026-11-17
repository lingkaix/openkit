---
status: Accepted
implementation: Implemented
kind: boundary
aspect: contract-evolution
---
# Vendor Snapshot Packages

This specification owns the packaging contract for externally sourced runtime and catalog snapshots under the workspace packages.

## Scope

Owns:

- The rule that an external boundary snapshot is packaged, validated, refreshed, and reviewed apart from OpenKit-owned protocol and runtime source.
- What a snapshot package contains when a consumer uses checked-in upstream interface files as runtime or generated-code input.
- The evidence quality a snapshot refresh requires.

Does not own:

- OpenKit protocol schemas — [Protocol](../core/protocol.md). `@openkit/protocol` stays the `UI <-> Core` contract.
- Which upstream release NanoHost supports, and the evidence kept beside that application — [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md).
- Live catalog fetching, dynamic provider marketplaces, and model-routing policy — their mediation and provider owners.
- Package-local refresh commands. Each package keeps its own procedure. This specification does not add a refresh service.
- Package-local build-supply archives — the consuming specification. [Retrieval Kernel](20261014-retrieval_kernel.md) owns its embedded dictionary supply.

Core:

- [Protocol](../core/protocol.md)
- [Mediation](../core/mediation.md)
- [Agent Supply](../core/agent-supply.md)

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

Snapshot refresh evidence MUST identify the exact upstream input and checksum the retained snapshot. The source determines the evidence:

- For a source-tag input, use a complete non-shallow checkout of the immutable tag and record its resolved tag and commit.
- For a registry release, use the exact published package version and record its package identity, release source, and generator identity where applicable. Record an upstream commit only when the source supplies one; state its absence otherwise.
- For a rolling API, record the source URL, capture date, and checksum of the captured bytes. A date identifies the capture, not an immutable upstream release.

A development branch, floating reference, shallow clone, rendered release page, or uncommitted working tree cannot establish values at an immutable source pin.

An upstream artifact set is complete only when every consumed component resolves to the recorded release or capture. A mixed, relabelled, or partially resolved set is invalid.

`packages/codex-app-server-schema/scripts/validate.mjs` owns consumed-surface metadata. This specification does not restate that validator's schema. Each consumed file has its own checksum. Each generated JSON file has its own SHA-256. The validator does not produce an aggregate directory digest.

### Snapshot Refresh Obligation

This subsection applies only to an external snapshot package governed by this specification. A refresh MUST resolve its committed inputs from the exact recorded release or capture and retain source identity and checksums under the package-local contract. Generated or vendored diffs receive separate review from any consuming OpenKit behavior change.

An upstream release creates no obligation to refresh a snapshot. A refresh uses the package-local procedure. This specification does not add a refresh service. An application dependency update is governed by that application's owner even when both changes happen in one repository slice.

NanoCore adapter logic and provider-template logic must remain in NanoCore-owned packages, not in external snapshot packages.

The deleted OpenShell schema snapshot package MUST NOT be recreated, copied into `apps/nanohost`, or used as OpenShell upgrade evidence. NanoHost dependency qualification stays with [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md).

## Accepted Design

Codex schema refreshes use the generator from the exact registry package version recorded in package metadata, not an arbitrary locally installed CLI.

models.dev refreshes create a new dated snapshot directory and update checksum metadata.

Reviewers should treat generated or vendored artifact diffs as source updates from an external boundary, then separately review any OpenKit code changes needed to adapt to those updates.

## Implementation

- `packages/codex-app-server-schema/` — Codex app-server schema snapshot, metadata, and validator
- `packages/models-dev-catalog/` — models.dev snapshots, checksums, and provider-template checks

## Implementation Gaps

None.

## Decisions

None.
