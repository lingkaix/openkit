# GitHub Workflows

This directory contains repository-level CI workflows.

The current workflow policy is intentionally resource-light:

- Pull requests run the lightweight repository check and the isolated NanoHost installer host gate.
- Ordinary branch pushes do not run CI.
- Lowercase version tags matching `v*.*.*` run the release gate through L0-L3 and L5, then publish the controlled release bundle.
- L4 Web e2e is a manual workflow-dispatch gate. Agent-first L6 story acceptance has no GitHub Actions job.
- Release tags run `scripts/release-preflight.mjs` before publication to validate lowercase tag shape, current prerelease admission, main-branch ancestry, portable Skill and NanoHost inputs, the promoted host manifest, the exact OpenShell pin, the image manifest, and every release image base digest.
- Portable publishing uses `scripts/package-release-assets.mjs` to archive the complete `skills/openkit/` tree and `LICENSE`, combine the native arm64 NanoHost binary with the pin-bound Gateway and license bytes, and write one `SHA256SUMS` over both archives.
- A native `ubuntu-24.04-arm` job builds and executes `nanohost --version`; one separate non-container job installs Bubblewrap and runs the fixed-path installer gate entirely inside temporary namespace bindings.
- Container publishing reads `containers/images.json`, pushes only digest-addressed candidates for entries where `release` is `true`, smokes the exact digest on every declared platform, and only then promotes that digest to release tags.
- Same-tag reruns reuse a complete version, version-without-`v`, and source-revision identity, while partial or conflicting identities fail closed; each new release tag uses a commit that has not already been released.
- Release tag workflows are serialized, third-party Actions are commit-pinned, and OCI creation time comes from the release commit.
- The terminal job verifies GitHub Release state and all three attachments, every image tag and digest, stable or prerelease `latest` behavior, the bundled Skill under the supported Node runtime, the downloaded NanoHost archive through the shared staging verifier, and the public worker base through a logged-out exact-digest inspection.

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

Agent-first L6 is not wired into GitHub Actions.

Future agentic workflow jobs must stay manual unless the L6 spec and release policy explicitly promote a constrained story subset.

## Validation

Run `node --test tests/release-workflow.test.mjs tests/release-preflight.test.mjs tests/release-image-state.test.mjs tests/package-release-assets.test.mjs` and `pnpm -w check:repo` after release-workflow changes.

Run `git diff --check` before finishing.

If `actionlint` is available locally, run it against workflow files.
