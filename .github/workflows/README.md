# GitHub Workflows

This directory contains repository-level CI workflows.

The current workflow policy is intentionally resource-light:

- Pull requests run only the lightweight repository check.
- Ordinary branch pushes do not run CI.
- Version tags matching `v*.*.*` or `V*.*.*` run the release gate through L0-L3 and L5, then publish release container images to GHCR.
- L4 Web e2e and L6 story acceptance are manual workflow-dispatch gates.
- Release tags run `scripts/release-preflight.mjs` before image publishing to validate tag shape, package versions, main-branch ancestry, the image manifest, and release worker base image digests.
- Container publishing reads `containers/images.json` and pushes only entries where `release` is `true`.
- Published images receive OCI labels, GHCR tags, digest summaries, and GitHub Release notes.

The detailed testing strategy is documented in `docs/specs/20260529-test_strategy.md`.

The detailed L6 story acceptance design is documented in `docs/specs/20260529-l6_story_acceptance.md`.

## Manual Gates

The `CI` workflow exposes these manual `gate` choices:

- `pr-check`: lightweight repository check.
- `l0-l2`: static, unit, and contract verification.
- `nano-core-e2e`: L3 NanoCore black-box e2e.
- `web-e2e`: L4 Web browser e2e.
- `smoke`: L5 built-artifact smoke tests.
- `deterministic-stories`: deterministic L6 story acceptance only.
- `release-gate`: tag-release gate equivalent.
- `full`: explicit full manual validation, including L4 and deterministic L6.

Agentic L6 is not wired into GitHub Actions yet.

Future agentic workflow jobs must stay manual unless the L6 spec and release policy explicitly promote a constrained story subset.

## Validation

Run `pnpm -w check:repo` after workflow changes.

Run `git diff --check` before finishing.

If `actionlint` is available locally, run it against workflow files.
