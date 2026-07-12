# External Snapshot Refresh

Type: change-plan
Status: verified

## Intent

Refresh every canonical externally sourced snapshot package to the latest stable upstream boundary verified on 2026-07-11, preserve deterministic offline runtime behavior, and reconcile OpenKit-owned consumers only where reviewed upstream diffs prove that an adaptation is required.

## Scope

- Regenerate the Codex app-server JSON Schema snapshot from the latest stable Codex CLI release.
- Fetch a new dated `models.dev` API snapshot, update its checksum and provenance metadata, and re-run provider-template and pinned `pi-ai` reconciliation.
- Rebuild the OpenShell provider-profile, sandbox-policy, and CLI boundary snapshot from the latest stable OpenShell release.
- Update package-local current-snapshot selectors, metadata, tests, READMEs, and directly dependent NanoCore documentation or behavior when the upstream diff requires it.
- Record stable upstream release tags, commits, source URLs, fetch timestamps, and response identifiers where the upstream makes them available.
- Keep the three external boundaries in separate reviewable commits, followed by separate consumer-adaptation commits only when necessary.

## Non-Goals

- Do not update ordinary package dependencies, container tool pins, protocol-generated files, or runtime-created OpenKit snapshots merely because they also use the word `snapshot` or `version`.
- Do not introduce live network fetching during NanoCore boot, tests, or normal product operation.
- Do not redesign provider templates, the Codex host adapter, or the OpenShell backend unless a reviewed upstream incompatibility requires a focused behavior change.
- Do not add a generic snapshot framework, refresh service, scheduled updater, or compatibility shim.
- Do not treat a repository branch head as the provenance of live API bytes unless the upstream provides a verifiable mapping.
- Do not update `apps/web` or OpenKit-owned protocol schemas unless a concrete external-boundary adaptation changes their existing contracts.

## Related Context

- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Product Vision](../product-vision.md)
- [Vendor Snapshot Packages](../specs/20260522-vendor_snapshot_packages.md)
- [Test Strategy](../specs/20260529-test_strategy.md)
- [OpenShell Mechanism Internalization](../specs/20260703-openshell_mechanism_internalization.md)
- [Pi AI Provider Gateway Adoption](../specs/20260703-pi_ai_provider_gateway_adoption.md)
- [Unified Pi AI LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md)

## Canonical Snapshot Inventory

The accepted vendor-snapshot spec and `packages/README.md` define exactly three external snapshot package families.

| Boundary | Committed snapshot instances | Current selector | Current upstream pin | Verified refresh target |
| --- | --- | --- | --- | --- |
| Codex app-server JSON Schema | `packages/codex-app-server-schema/generated-schema/` plus `metadata.json` | The package replaces the unversioned generated directory in place | `codex-cli 0.134.0`, refreshed 2026-05-29 | Stable release `rust-v0.144.1`, published 2026-07-09, commit `44918ea10c0f99151c6710411b4322c2f5c96bea` |
| `models.dev` catalog | `snapshots/2026-05-18/` and `snapshots/2026-05-29/` | `scripts/validate.mjs` selects `2026-05-29` | Live API captured 2026-05-29, SHA-256 `eae88010b2a0c33a1c011cfef29f90c2017c5e382851f8be18447b7018a2981f` | New 2026-07-11 capture from `https://models.dev/api.json`; observed raw SHA-256 `d00f7569cfe9619e64ed2de4be1a98c77428c07d0bc88c35fb9c9ae199bb668d` and ETag `d00f7569cfe9619e64ed2de4be1a98c7` |
| OpenShell provider, policy, and CLI surface | `packages/openshell-schema-snapshot/snapshots/2026-07-05/` | `src/index.ts` and `src/index.test.ts` select `2026-07-05` | OpenShell `0.0.63`, tag commit `ec197a43ef349e36c3fff04e9aaea9599fb83b31` | Stable release `v0.0.80`, published 2026-07-09, commit `709aa0fe3e9e4d2b5fea336b5d6e393b45481898` |

`docs/okf-spec-v0.1-snapshot.md`, OpenKit protocol-generated schemas, database/session/AEP snapshots, test fixtures, dependency locks, and container binary pins are not externally sourced snapshot packages and are excluded from this refresh.

## Current Evidence Baseline

- Snapshot implementation started from plan commit `06860dc2c42b2a3fab0a140415ca18c8c0a70e4e` on branch `chore/update-external-snapshots-20260711`.
- The main worktree contains unrelated uncommitted NanoCore work; this change must remain isolated in `/Users/m5pro/Documents/AI/openkit-update-external-snapshots`.
- The installed Codex CLI is `0.144.1`, matching the latest stable upstream release verified through the GitHub Releases API.
- The installed OpenShell CLI is `0.0.63`, so the OpenShell refresh must use a separately pinned `0.0.80` binary or source checkout rather than the ambient executable.
- OpenShell `v0.0.63...v0.0.80` spans 87 commits and changes the CLI, policy, provider, gateway, and documentation surfaces consumed by this package; its update requires source-level review rather than a metadata-only version bump.
- The live `models.dev` endpoint returned 3,139,568 bytes on 2026-07-11 with SHA-256 `d00f7569cfe9619e64ed2de4be1a98c77428c07d0bc88c35fb9c9ae199bb668d`. The upstream repository default branch was `dev` at commit `5e9e9ac0bbce465a3aa4c90aac20fdacddc0e6e9`, but that commit must be recorded only as an observed repository head unless deployment provenance can be proved.
- The Codex snapshot package is not directly imported by current NanoCore source, while the OpenShell package is a runtime dependency and the models.dev package validates NanoCore provider templates. Verification depth therefore differs by boundary.
- The Codex package validator passes with the ambient Node.js runtime. The models.dev and OpenShell package tests could not establish a clean baseline in the fresh worktree because dependencies are not installed; direct `pnpm` also reported Node.js 22 while the repository requires Node.js 24. Implementation must establish the managed toolchain and install state before accepting any artifact diff.

## Upstream Evidence

- Codex: [release `rust-v0.144.1`](https://github.com/openai/codex/releases/tag/rust-v0.144.1), [release commit](https://github.com/openai/codex/commit/44918ea10c0f99151c6710411b4322c2f5c96bea), and [schema source tree](https://github.com/openai/codex/tree/44918ea10c0f99151c6710411b4322c2f5c96bea/codex-rs/app-server-protocol/schema/json).
- models.dev: [source repository at the observed revision](https://github.com/anomalyco/models.dev/tree/5e9e9ac0bbce465a3aa4c90aac20fdacddc0e6e9) and the rolling [public API](https://models.dev/api.json).
- OpenShell: [release `v0.0.80`](https://github.com/NVIDIA/OpenShell/releases/tag/v0.0.80) and [release commit](https://github.com/NVIDIA/OpenShell/commit/709aa0fe3e9e4d2b5fea336b5d6e393b45481898).

## Required Invariants

- Every refreshed artifact is derived from a named stable upstream release or a timestamped live endpoint response and carries reviewable provenance.
- Runtime boot remains offline and deterministic.
- Generated or vendored artifacts are reviewed separately from OpenKit-owned consumer changes.
- Existing external snapshot history is not rewritten; dated packages add a new current directory, while the Codex package continues its accepted in-place generated-directory model.
- NanoCore behavior changes only after a failing test demonstrates an incompatibility introduced by the refreshed boundary.
- No backward-compatibility reader, alias, fallback, or dual current-snapshot selector is added for old internal snapshot paths.
- Checksums describe the exact committed bytes after formatting, not the transient download.
- The worktree never stages or commits files from the main worktree or temporary research evidence under `temp/research/`.

## Execution Plan

### Phase 0: Reproducible Baseline and Provenance

- Trust the worktree `.mise.toml` for this worktree, install the locked workspace dependencies, and run the three current package test suites with the repository-managed Node.js 24 toolchain.
- Save the exact upstream release/API evidence needed for review: Codex tag and commit, OpenShell tag and commit, and models.dev fetch timestamp, response ETag, byte checksum, and source URL.
- Confirm the generated or curated source paths consumed by each package before editing tracked artifacts.
- Record any baseline failure in this change record before changing snapshots.

Exit criteria: all current package tests either pass under the managed toolchain or have a clearly recorded pre-existing failure, and every refresh input is reproducibly identified.

### Phase 1: Codex App-Server Schema

- Run Codex CLI `0.144.1` from the verified stable release and generate JSON Schema into a clean temporary output directory.
- Compare the complete generated JSON file set with `packages/codex-app-server-schema/generated-schema/`, remove stale generated files, and preserve the package-owned `generated-schema/README.md` that the upstream generator does not emit.
- Update `metadata.json` to `codex-cli 0.144.1`, refresh date 2026-07-11, stable release tag, source commit, and upstream repository URL.
- Run the package validator and inspect request, response, notification, error, configuration, tool, and thread/turn diffs against current NanoCore adapter behavior.
- Add a failing NanoCore adapter regression test first and implement the smallest adapter change only if the schema diff exposes a consumed incompatibility.

Exit criteria: the generated tree exactly matches Codex CLI `0.144.1`, package validation passes, and consumed adapter behavior is either proven unchanged or adapted test-first.

### Phase 2: models.dev Catalog

- Fetch `https://models.dev/api.json` once, preserve the raw response only as temporary evidence, parse it, format it deterministically, and commit it under `packages/models-dev-catalog/snapshots/2026-07-11/api.json`.
- Create matching metadata with the formatted-file SHA-256, exact fetch timestamp, response ETag, source URL, source project, provider mappings, and the repository's current `@earendil-works/pi-ai` version `0.80.3`.
- Point `scripts/validate.mjs` and the NanoCore provider-template README at the new current snapshot without adding fallback lookup logic.
- Run provider-id, starter-model, and price reconciliation; when upstream changes break a current mapping, add the failing validator or NanoCore test first, then update only the affected template or explicitly scoped reconciliation entry.
- Keep the 2026-05-18 and 2026-05-29 directories as dated audit history; do not make runtime code select among them.

Exit criteria: checksum, parseability, provider mappings, starter models, and pinned pi-ai price reconciliation pass against the 2026-07-11 snapshot.

### Phase 3: OpenShell Boundary Surface

- Inspect OpenShell tag `v0.0.80` at commit `709aa0fe3e9e4d2b5fea336b5d6e393b45481898`, using the upstream provider-profile, provider refresh, sandbox policy, CLI, and gateway source as authority.
- Create `packages/openshell-schema-snapshot/snapshots/2026-07-11/` and update the provider-profile, policy, and CLI surface files from the actual `v0.0.80` contract rather than copying the `0.0.63` files and changing their version.
- Set the minimum compatible OpenShell version to `0.0.80`, bump `mappingVersion`, and explicitly distinguish upstream categories, built-in profile IDs, protocols, access modes, and enforcement modes from OpenKit's narrower emitted mapping; do not relabel OpenKit values such as `mcp` and `repository` as upstream enums.
- Update metadata, checksums, source tag/commit/URL, compatibility range, `src/index.ts`, `src/index.test.ts`, and the package README to select the new snapshot directly.
- Add failing conformance or NanoCore tests first for each consumed surface that changed, then make the smallest required adjustment in the snapshot helper or NanoCore OpenShell backend.
- Validate generated provider profiles, rendered policies, CLI invocations, sandbox labels, provider attach/detach/refresh flows, and the supported gateway range against `0.0.80`.

Exit criteria: every curated field is traceable to `v0.0.80`, checksums and package tests pass, and all NanoCore-consumed OpenShell flows conform to the new boundary.

### Phase 4: Documentation, Audit, and Closeout

- Update the accepted vendor-snapshot spec only if implementation changes the package contract; do not edit it merely to repeat version metadata already owned by packages.
- Update package READMEs and direct consumer documentation where current dated paths or refresh commands changed.
- Audit the final diff for stale selectors, stale dates, stale generated files, duplicate ownership, unnecessary helpers, and accidental changes outside the three snapshot packages and proven consumers.
- Complete this record with per-package commit links, upstream evidence links, verification results, required consumer adaptations, and remaining risks.

Exit criteria: repository search finds no stale current-snapshot selector, the final verification suite passes, and the change record explains each accepted upstream diff and consumer consequence.

## Verification Plan

Run package gates after each isolated boundary update:

- `mise exec -- pnpm --filter @openkit/codex-app-server-schema test`
- `mise exec -- pnpm --filter @openkit/codex-app-server-schema lint`
- `mise exec -- pnpm --filter @openkit/models-dev-catalog test`
- `mise exec -- pnpm --filter @openkit/models-dev-catalog lint`
- `mise exec -- pnpm --filter @openkit/openshell-schema-snapshot test`
- `mise exec -- pnpm --filter @openkit/openshell-schema-snapshot typecheck`
- `mise exec -- pnpm --filter @openkit/openshell-schema-snapshot build`
- `mise exec -- pnpm --filter @openkit/openshell-schema-snapshot lint`

Run dependent NanoCore gates whenever a snapshot with a NanoCore consumer changes:

- Focused Codex adapter, provider-template, OpenShell policy, agent-environment, and worker-governance backend tests selected from the reviewed diff.
- `CI=true mise exec -- pnpm --filter @openkit/nanocore test`
- `CI=true mise exec -- pnpm --filter @openkit/nanocore typecheck`
- `CI=true mise exec -- pnpm --filter @openkit/nanocore build`

Run repository gates before closeout:

- `CI=true mise exec -- pnpm run format:check`
- `CI=true mise exec -- pnpm run check:repo`
- `git diff --check`
- `git status --short`

No credentialed provider call, remote gateway mutation, release publication, or deployment is required for this refresh unless a concrete consumed compatibility question cannot be answered by source, schema, and deterministic tests.

## Commit and Review Discipline

- Commit this plan before artifact implementation as `docs: plan external snapshot refresh`.
- Commit the Codex package refresh, models.dev package refresh, and OpenShell package refresh separately with Conventional Commit messages.
- For any consumer behavior change, land the failing test commit before the implementation commit and keep it separate from the generated or vendored artifact commit.
- Update each package before its consumer, preserving the repository's package-first alignment rule.
- Review generated and vendored diffs as external source changes; review OpenKit code diffs separately for correctness, cohesion, duplication, and unnecessary abstraction.

## Risks and Mitigations

- Risk: a live models.dev response cannot be tied exactly to a Git commit. Mitigation: record the response URL, timestamp, ETag, and exact committed checksum, and label repository head observations without claiming false provenance.
- Risk: Codex generation leaves files removed by upstream or deletes the package-owned generated-schema guide. Mitigation: generate into a clean temporary directory, synchronize the generated JSON file set exactly, and preserve `generated-schema/README.md` explicitly.
- Risk: OpenShell `0.0.80` contains substantial policy, provider, and CLI drift. Mitigation: derive each curated field from tagged source, add failing conformance coverage for consumed changes, and avoid metadata-only refreshes.
- Risk: replacing OpenKit mapping values with upstream enums breaks current generated provider profiles while appearing more accurate. Mitigation: bump the mapping version and represent upstream capability and OpenKit emission as separate named fields with separate conformance assertions.
- Risk: an ambient CLI silently generates a different boundary. Mitigation: verify the exact executable version immediately before generation and record the stable tag and commit in metadata.
- Risk: models.dev pricing churn causes broad template or tolerance changes. Mitigation: keep the current 5% tolerance unless a specific reviewed provider discrepancy proves it wrong, and narrow reconciliation by explicit model ids rather than weakening validation globally.
- Risk: large generated diffs hide unrelated edits. Mitigation: keep one package per commit, use clean generation inputs, and require an empty unrelated diff before each commit.

## Checkpoints

### 2026-07-11: Plan Created

- Created the isolated worktree and branch without touching the dirty main worktree.
- Identified the three canonical external snapshot packages and distinguished them from OpenKit-owned runtime and generated snapshots.
- Verified current stable upstream targets through primary GitHub release data and a live models.dev API fetch.
- Recorded the update order, conditional consumer work, verification gates, commit boundaries, and provenance caveats before implementation.

### 2026-07-11: Snapshots Refreshed

- Refreshed Codex app-server JSON Schema from stable `@openai/codex@0.144.1`, removed six stale `DeviceKey*` files omitted by the clean generator output, added thirteen current schema files, recorded release provenance, and committed the isolated package update as `fb8c940`.
- Captured the rolling models.dev API response at `2026-07-11T06:40:44Z`, committed the deterministically formatted 158-provider snapshot with raw and formatted digests and observed source revision, preserved prior dated snapshots, and committed the package plus provider-template traceability update as `744a61f`.
- Refreshed the OpenShell boundary from stable `v0.0.80`, set the minimum compatible version to `0.0.80`, bumped the mapping to `openshell-v2`, separated tagged upstream provider/policy capabilities from OpenKit's narrower emitted mapping, updated the owning spec, and committed the package update as `e573a4f`.
- Updated the NanoCore sandbox-label expectation in the separate package-first consumer commit `2bba905`; no NanoCore runtime behavior change was required.

### 2026-07-11: Verification Complete

- All three snapshot package test and lint gates passed; the OpenShell package also passed typecheck and build.
- Codex adapter-focused NanoCore verification passed with 6 files and 26 tests.
- OpenShell-focused NanoCore verification passed with 3 files passed, 1 skipped, 59 tests passed, and 7 skipped.
- The snapshot branch's full NanoCore run reported 5 workspace-review failures from the active maintainability TDD baseline; the same 5 failures were reproduced at pre-snapshot commit `06860dc`, proving they were not introduced by this change.
- A detached prospective integration combined target commit `2b584af`, the target worktree's current uncommitted implementation snapshot, and all snapshot commits. NanoCore then passed with 199 test files passed, 1 skipped, 1,268 tests passed, and 7 skipped; NanoCore build also passed.
- Repository format-check and governance checks passed across 728 checked files, and `git diff --check` passed.

## Implementation Summary

All three canonical external snapshot packages now use the latest stable or content-addressed upstream state verified on 2026-07-11. Codex is pinned to `0.144.1`, models.dev uses the dated 2026-07-11 rolling API capture, and OpenShell is pinned to `0.0.80` with an explicit `openshell-v2` mapping boundary. Runtime boot remains deterministic and offline, prior dated snapshots remain audit history, and no generic refresh framework or compatibility shim was added.

## Final Verification

Verified through package tests, package lint, OpenShell typecheck/build, focused NanoCore tests, full prospective-integration NanoCore tests, repository format and governance checks, and exact upstream provenance inspection. No credentialed provider call, remote gateway mutation, release publication, or deployment was required.
