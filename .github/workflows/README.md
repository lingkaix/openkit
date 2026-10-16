# GitHub Workflows

This directory contains repository-level CI workflows. Test-image jobs use Docker `--init` to reap orphaned child processes, matching the local `scripts/test-env.sh` container path. The L0-L2 job prepares checkout, dependency, cache, and toolchain write ownership as root, then runs verification as the image's unprivileged `node` user so permission-refusal fixtures exercise ordinary filesystem authority.

The current workflow policy is:

- Pull requests run the lightweight repository check and the isolated NanoHost installer host gate.
- Every push to `main` runs the complete nonpublishing release gate; other branch pushes do not run CI. L0-L2 derives whole-package coverage owners and two disjoint file partitions each for NanoCore and Worker Shim through `scripts/ci-l0-l2.mjs`, plus three parallel static/build groups, two native/catalog groups, and the root/Python shard. All four static commands and native/catalog owners remain required. The NanoHost shard serializes Rust harness cases to bound concurrent Node TLS fixture startup; explicit in-case product concurrency, fixture startup bounds and product deadlines remain unchanged. Web retains its own complete job; seven other complete coverage owners share one job with distinct reports. Split owners require successful whole-owner coverage merges under the original thresholds. Every selected coverage file must execute exactly once, with unchanged thresholds and skip enforcement. The root shard also collects recursive script tests exactly once. P29 native inspection requires Linux, the pinned NanoHost Rust compiler and the same-checkout producer; locked Cargo inputs are fetched before its offline fixture compilation. The aggregate requires the complete successful shard inventory. Main and tags may reuse successful exact-SHA candidate shards, retaining the original execution links, reports and coverage blobs from the cited run and attempt. Build caches are restored without a synchronous upload; tests always execute unless exact-commit evidence is admitted.
- Lowercase prerelease tags matching `v*.*.*-*` run the release gate through L0-L3 and L5, then publish the controlled release bundle.
- The L0-L2 root shard runs `python3 -I -B scripts/docker/app-update-helper.test.py` on main and release-tag pushes and the `l0-l2`, `release-gate`, and `full` workflow-dispatch gates, unless that exact-commit successful shard is reused. Pull requests do not run that suite.
- L4 Web e2e runs on every main push and the `web-e2e`, `release-gate` and `full` manual selections. Main runs share one pending concurrency group, so the newest pending head replaces older queued heads without cancelling the running main run. Release admission still requires a completed successful full gate, including L4, on exactly P. Agent-first L6 story acceptance has no GitHub Actions job.
- Release tags run `scripts/release-preflight.mjs` before publication to validate lowercase tag shape, current prerelease admission, main-branch ancestry, portable Skill and NanoHost inputs, the promoted host manifest, the supported OpenShell release and Cargo SDK consistency, the image manifest, and every release image base digest.
- The tag workflow reads `release-notes/<tag>.md` through `scripts/release-notes.mjs` and fails before image promotion when that file is missing or malformed.
- Portable publishing uses `scripts/package-release-assets.mjs` to archive the complete `skills/openkit-ops/` tree, `LICENSE`, and the reviewed `scripts/docker/app-update-helper.py`, combine each native amd64 and arm64 NanoHost binary with its target-selected exact Gateway and the common license bytes, and write one `SHA256SUMS` over all three archives.
- Native `ubuntu-24.04` and `ubuntu-24.04-arm` jobs build and execute `nanohost --version`; one separate non-container job installs Bubblewrap and runs the fixed-path installer gate entirely inside temporary namespace bindings.
- Tag-only `qualify-nanohost` matrix legs run directly on fresh hosted amd64 and arm64 VMs, consume the exact target archive and checksum from packaging, install only missing declared prerequisites, and record image and installed package versions. They require `requirements-met`, an `installable` no-write disposition, unchanged live and reserved paths, and byte-and-mode-matching contained staging. Both image publication and GitHub Release creation wait for the full matrix; pull requests and workflow-dispatch gates retain their existing scope.
- Candidate construction reads `containers/images.json` and a committed unused prerelease notes input, builds each platform on its native runner, pushes only by digest, and smokes the exact registry digest. Worker candidate jobs replace their diagnostic builds. Index assembly assigns only a `candidate-` reference and retains attempt-bound source and smoke evidence. The tag verifies that record and promotes the unchanged index; it cannot rebuild or promote another P. All existing qualification, publication and download checks remain required.
- App tag publication fetches and validates the proved prebuilt index. Native `ubuntu-24.04` and `ubuntu-24.04-arm` jobs guard runner and Docker architecture outside the image and smoke each exact platform manifest. Each job first proves that a missing address-space setter fails the unchanged smoke, with no inherited address-space ceiling. Promotion requires both successful jobs and their exact-P, tag, run-attempt, index and manifest evidence. A failed-jobs-only rerun cannot reuse another attempt's artifacts: rerun the entire workflow. A complete immutable App retry is smoked again without rebuilding or moving tags.
- Candidate construction selects only catalog entries with `release: true`.
- Same-tag reruns reuse a complete version, version-without-`v`, and source-revision identity, while partial or conflicting identities fail closed; each new release tag uses a commit that has not already been released.
- Release tag workflows are serialized, third-party Actions are commit-pinned, and OCI creation time comes from the release commit.
- The terminal job verifies GitHub Release state and all five attachments, every image tag and digest, stable or prerelease `latest` behavior, the bundled Skill under the supported Node runtime and its helper bytes against the reviewed release checkout, both downloaded NanoHost archives through the shared staging verifier, and the public worker base through a logged-out exact-digest inspection.

The existing `github-release` and `verify-release` jobs generate, upload and independently compare the fifth release-manifest attachment. The exact release source must carry reviewed compatibility facts in `release-notes/<tag>.manifest.json`; the preflight refuses missing or unassessed facts rather than inventing a compatibility verdict. The manifest lists archive checksums and is itself covered by `SHA256SUMS`.

`release-promotion.yml` handles only stable tag pushes and serializes with the prerelease workflow. Its first step refuses any repository other than `notrucked/openkit`; the script also requires a synthetic `v0.0.N` stable version. Under the bounded P15 exception it verifies one same-source published prerelease and its current successful publication/native-smoke attempt, copies its exact indexes and five attachments, and verifies the result again without construction. A complete same-tag rerun rewrites nothing. Production stable publication and its prerelease-only preflight default remain unchanged and reserved.

The detailed testing strategy is documented in `docs/specs/20260529-test_strategy.md`.

The release contract and operator sequence are documented in `docs/specs/20260829-release_management.md` and `docs/cookbooks/release.md`.

The detailed L6 story acceptance design is documented in `docs/specs/20260529-l6_story_acceptance.md`.

## Manual Gates

The `CI` workflow exposes these manual `gate` choices:

- `pr-check`: lightweight repository check.
- `l0-l2`: static, unit, and contract verification.
- `nano-core-e2e`: L3 NanoCore black-box e2e.
- `web-e2e`: L4 Web browser e2e.
- `smoke`: L5 built-artifact smoke tests plus the disposable app-image stopped-server recovery probe on a separate runner using the root Node pin.
- `release-gate`: tag-release gate equivalent.
- `full`: explicit full manual validation, including L4.

Main pushes and the manual `release-gate` and `full` gates also build and smoke every worker image from the catalog on both declared Linux platforms. Without a selected release, this is diagnostic smoke without registry publication; a selected prerelease uses the digest-only candidate path instead. Each platform uses its native standard hosted runner, with image- and architecture-specific BuildKit caching; Worker smoke uses no QEMU. Main pushes also run the disposable stopped-server recovery probe.

Agent-first L6 is not wired into GitHub Actions.

Future agentic workflow jobs must stay manual unless the L6 spec and release policy explicitly promote a constrained story subset.

## Validation

Run `node --test tests/release-workflow.test.mjs tests/release-preflight.test.mjs tests/release-image-state.test.mjs tests/package-release-assets.test.mjs` and `pnpm -w check:repo` after release-workflow changes.

Run `git diff --check` before finishing.

If `actionlint` is available locally, run it against workflow files.

The final prerelease registry-admission job has read-only package access. It retains exact-source index and immutable-identity observations for local admission through repository artifacts. An explicit registry-only dispatch refreshes those observations without rebuilding the successful candidate. See the [release cookbook](../../docs/cookbooks/release.md#cadence-commands) for its bounded window and required evidence.

`release-scratch-smoke.yml` is a separate scratch-only dispatch workflow for the published amd64 App retained-read fixture. It verifies control C separately from subject P, isolates job-token preparation from the token-free fixture, and uploads one selected result after attempt-owned cleanup. See the [release cookbook](../../docs/cookbooks/release.md#hosted-scratch-fixture) for dispatch, local API verification and the explicit evidence limits. It runs no real prerelease or deployment gate.
