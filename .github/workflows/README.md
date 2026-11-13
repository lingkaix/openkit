# GitHub Workflows

This directory contains repository-level CI workflows. Test-image jobs use Docker `--init` to reap orphaned child processes, matching the local `scripts/test-env.sh` container path. The L0-L2 job prepares checkout, dependency, cache, and toolchain write ownership as root, then runs verification as the image's unprivileged `node` user so permission-refusal fixtures exercise ordinary filesystem authority.

The current workflow policy is:

- Pull requests run the lightweight repository check and the isolated NanoHost installer host gate. `pr-check` builds and loads a job-local test image with `push: false`, verifies its baked input identity before installing dependencies, and runs the check inside it. Its token has only `contents: read`. The registry-publishing `test-image` job never runs on pull requests.
- Every push to `main` runs the complete nonpublishing release gate; other branch pushes do not run CI. L0-L2 derives twelve execution jobs through `scripts/ci-l0-l2.mjs`: four disjoint NanoCore file partitions capped at two workers each, whole-package Web coverage, two disjoint Worker Shim file partitions, one shared group for the smaller coverage owners, one shared static/build job, two native/catalog groups, and the root/Python shard. All four static commands and native/catalog owners remain required. The NanoHost package owns sequential Rust harness execution through its existing test command; CI preserves that command and all inherited harness settings. Explicit in-case product concurrency, fixture startup bounds and product deadlines remain unchanged. Web retains its own complete job; the other complete coverage owners share one job with distinct reports. Split owners require successful whole-owner coverage merges under the original thresholds. Every selected coverage file must execute exactly once, with unchanged thresholds and skip enforcement. The root shard also collects recursive script tests exactly once. P29 native inspection requires Linux, the pinned NanoHost Rust compiler and the same-checkout producer; locked Cargo inputs are fetched before its offline fixture compilation. The aggregate requires the complete successful shard inventory. Main and tags may reuse successful exact-SHA candidate shards, retaining the original execution links, reports and coverage blobs from the cited run and attempt. Build caches are restored without a synchronous upload; tests always execute unless exact-commit evidence is admitted. Shard execution reports and coverage blobs are retained after failure for diagnosis; failed job conclusions and missing successful shard observations still refuse reuse and aggregation.
- Lowercase prerelease tags matching `v*.*.*-*` run the release gate through L0-L3 and L5, then publish the controlled release bundle.
- The L0-L2 root shard runs `python3 -I -B scripts/docker/app-update-helper.test.py` on main and release-tag pushes and the `l0-l2`, `release-gate`, and `full` workflow-dispatch gates, unless that exact-commit successful shard is reused. Pull requests do not run that suite.
- L4 Web e2e runs on every main push and the `web-e2e`, `release-gate` and `full` manual selections. Main runs share one pending concurrency group, so the newest pending head replaces older queued heads without cancelling the running main run. Release admission still requires a completed successful full gate, including L4, on exactly P. Agent-first L6 story acceptance has no GitHub Actions job.
- Release tags run `scripts/release-preflight.mjs` before publication to validate lowercase tag shape, current prerelease admission, main-branch ancestry, portable Skill and NanoHost inputs, the promoted host manifest, the supported OpenShell release and Cargo SDK consistency, the image manifest, every release image base digest, and the pinned offline workflow lint.
- The tag workflow reads `release-notes/<tag>.md` through `scripts/release-notes.mjs` and fails before image promotion when that file is missing or malformed.
- Portable publishing uses `scripts/package-release-assets.mjs` to archive the complete `skills/openkit-ops/` tree, `LICENSE`, and the reviewed `scripts/docker/app-update-helper.py`, combine each native amd64 and arm64 NanoHost binary with its target-selected exact Gateway and the common license bytes, and write one `SHA256SUMS` over all three archives.
- Native `ubuntu-24.04` and `ubuntu-24.04-arm` jobs build and execute `nanohost --version`; one separate non-container job matrix installs Bubblewrap and runs the fixed-path installer gate on both `ubuntu-24.04` and `ubuntu-26.04`, entirely inside temporary namespace bindings. Other previously floating runners stay on `ubuntu-24.04` while the 26.04 slowdown is investigated in #533.
- Tag-only `qualify-nanohost` matrix legs run directly on fresh hosted amd64 and arm64 VMs, consume the exact target archive and checksum from packaging, install only missing declared prerequisites, and record image and installed package versions. They require `requirements-met`, an `installable` no-write disposition, unchanged live and reserved paths, and byte-and-mode-matching contained staging. Both image publication and GitHub Release creation wait for the full matrix; pull requests and workflow-dispatch gates retain their existing scope.
- Candidate construction reads `containers/images.json` and a committed unused prerelease notes input, builds each platform on its native runner, pushes only by digest, and smokes the exact registry digest. Worker candidate jobs replace their diagnostic builds. Index assembly assigns only a `candidate-` reference and retains attempt-bound source and smoke evidence. The tag verifies that record and promotes the unchanged index; it cannot rebuild or promote another P. All existing qualification, publication and download checks remain required.
- App tag publication fetches and validates the proved prebuilt index. Native `ubuntu-24.04` and `ubuntu-24.04-arm` jobs guard runner and Docker architecture outside the image and smoke each exact platform manifest. Each job first proves that a missing address-space setter fails the unchanged smoke, with no inherited address-space ceiling. Promotion requires both successful jobs and their exact-P, tag, run-attempt, index and manifest evidence. A failed-jobs-only rerun cannot reuse another attempt's artifacts: rerun the entire workflow. A complete immutable App retry is smoked again without rebuilding or moving tags.
- Candidate construction selects only catalog entries with `release: true`.
- Same-tag reruns reuse a complete version, version-without-`v`, and source-revision identity, while partial or conflicting identities fail closed; each new release tag uses a commit that has not already been released.
- Release tag workflows are serialized, third-party Actions are commit-pinned, and OCI creation time comes from the release commit.
- The terminal job verifies GitHub Release state and all required attachments, including the security SBOMs and provenance, every image tag and digest, stable or prerelease `latest` behavior, the bundled Skill under the supported Node runtime and its helper bytes against the reviewed release checkout, both downloaded NanoHost archives through the shared staging verifier, and the public worker base through a logged-out exact-digest inspection.

The existing `github-release` and `verify-release` jobs generate, upload and independently compare the fifth release-manifest attachment. The exact release source must carry reviewed compatibility facts in `release-notes/<tag>.manifest.json`; the preflight refuses missing or unassessed facts rather than inventing a compatibility verdict. The manifest lists archive checksums and is itself covered by `SHA256SUMS`.

`release-promotion.yml` handles only stable tag pushes and serializes with the prerelease workflow. It verifies one published same-version prerelease on the exact stable source commit and its current successful publication/native-smoke attempt, copies its exact indexes and required attachments, and verifies the result again without construction. A complete same-tag rerun rewrites nothing. Production is dormant by default: the engineer must configure the `stable-release` environment and set `OPENKIT_STABLE_PROMOTION` to the exact `<stable-tag>@<source-commit>` after all stable prerequisites and changed-path rehearsal pass. No standing prerelease grant satisfies this gate. The bounded synthetic `notrucked/openkit` rehearsal remains admitted only for `v0.0.N`. The ordinary preflight default remains prerelease-only; explicit promotion classification uses the source prerelease's reviewed inputs.

The detailed testing strategy is documented in `docs/specs/20260529-test_strategy.md`.

The release contract and operator sequence are documented in `docs/specs/20260829-release_management.md` and `docs/cookbooks/release.md`.

The detailed L6 story acceptance design is documented in `docs/specs/20260529-l6_story_acceptance.md`.

## Security Checks

[Development Security](../../docs/specs/20261109-development_security.md#where-each-check-runs) owns check placement. The local gate scans staged secrets and checks changed lock files and workflows. Pull requests and main pushes scan the pushed range for secrets, changed lock files for new K/C/H matches, and changed workflows with `zizmor`. A daily job scans the latest release images; release admission scans candidates, checks K/C dispositions, and generates and verifies SBOMs and attestations.

Every `pull_request` job MUST hold no write permission and publish nothing, for same-repository and fork requests alike. A changed test image is built and tested in its job, or carried as an artifact for `docker load`; pull-request jobs never publish it to a registry. `check:repo` runs offline `zizmor` and the parsed supply-chain configuration check, which keeps the pnpm controls, action pins and PR permissions/publication rules. Checkout steps disable credential persistence, and host/release mise setup disables its tool cache. The linter's narrow image-reference annotations name the upstream verified digest; cache annotations apply only to paths that PR jobs cannot write. Scanner, secret and release-integrity jobs remain separate implementation units. Only tag-only release jobs may receive `id-token: write` and `attestations: write`.

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

The lightweight repository job and static L0-L2 shard fetch complete Git history for the settled-operation semantic snapshot check. Other shards keep shallow checkout. Snapshot history prevents settled digest replacement and retired operation ID reuse; no operation is classified automatically.
