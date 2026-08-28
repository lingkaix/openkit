---
type: change-plan
status: verified
started: 2026-08-29
completed: 2026-08-29
branch: main
---
# Release Management Contract And Automation

## Intent

Define the first OpenKit release strategy and land the cookbook, GitHub Actions workflow, scripts, and checks needed for an authorized agent to prepare, publish, and verify one release without inventing release policy during the run.

## Owners

- `docs/specs/20260708-container_image_packaging.md` owns release-image taxonomy and GHCR publication.
- `docs/specs/20260713-openkit_agent_skill_interface.md` owns the end-user Skill artifact.
- `docs/specs/20260802-nanohost_runtime_and_transport.md` owns NanoHost readiness, records its A1 noninterference gate as passed, and has not admitted a distribution artifact.
- `docs/specs/20260529-test_strategy.md` owns automatic and manual verification layers.
- The new release-management specification will own product-wide release identity, asset composition, publication authorization, retry, failure, and post-publication verification.

## Acceptance

- One accepted owner defines lowercase semantic-version tags, release channels, exact current assets and exclusions, authorization, idempotency, partial-publication handling, retry, and post-publication predicates.
- The tag is the sole product release identity; private workspace package versions do not need mass updates.
- The workflow publishes every cataloged release image only after L0-L3 and L5 pass, smokes the candidate digest for every declared platform before assigning release tags, and reuses rather than overwrites an existing same-tag release image.
- The complete `skills/openkit/` distribution is attached to the GitHub Release in a deterministic archive with a checked SHA-256.
- Prereleases do not update image `latest` and are marked as GitHub prereleases; stable releases update `latest` only after their release candidates pass.
- The workflow performs authenticated exact-tag verification for every release image and anonymous exact-digest verification for the public `worker-common` base.
- Current NanoHost distribution debt remains explicit: release candidates may publish the bounded implemented surface, but the first stable product release remains blocked until its owner admits a NanoHost distribution artifact.
- Focused release checks, repository validation, and the full release gate pass, followed by independent Claude Code verification and audit.

## Exclusions And Effect Boundary

Repository documents, release scripts, deterministic checks, image metadata, and GitHub workflow definitions are in scope.
Creating or pushing a tag, publishing a GitHub Release or package, changing repository or package visibility, configuring GitHub environments or rulesets, deploying NanoHost, using release credentials, and deleting existing artifacts are external effects outside this change.
Signed images, mandatory SBOM or vulnerability gates, GitHub artifact attestations, npm publication, the internal dogfood image, desktop packaging, and a NanoHost binary release are excluded until their accepted activation conditions exist.

## Intent Epochs

### Intent Epoch 1 — 2026-08-29 / engineer request

Prepare OpenKit for release by defining a reusable release cookbook, the assets that ship, and the CI/CD and GitHub workflow infrastructure required for an agent to complete a release.
Use independent Herdr-managed Claude Code agents as the design consultant and as the final verifier and auditor.

## Current Checkpoint

- The accepted release owner, cookbook, preflight, deterministic Skill packager, digest-first image workflow, exact post-publication verification, tests, and local guides are implemented and independently accepted.
- The independent Claude Code Opus 5 consultant's findings were incorporated: the Git tag is the sole product identity, the complete Skill is published, image candidates are smoked by exact digest before promotion, release runs are serialized, retries reuse proved immutable artifacts, and GitHub prerelease semantics are explicit.
- The repository is currently private. This change records that fact but does not authorize changing repository visibility; only `worker-common` has an accepted anonymous-public contract.
- NanoHost remains excluded from the release bundle, its retained A1 noninterference gate is already passed, and a stable release remains blocked only until its owner admits a distribution artifact.
- Independent Claude Code verification and audit both returned PASS after corrections for registry failure handling, source-revision uniqueness, stable `latest` failure semantics, explicit anonymous-pull metadata, release-note verification, structural workflow tests, and fail-closed CLI defaults.
- Unrelated concurrent work at `docs/product-vision.md`, `docs/roadmap.md`, `docs/changes/202608290111110001-staging_server_deployment/`, and `docs/changes/202608290124580001-roadmap_rewrite/` is preserved and excluded from this change and its commit.
- The complete staged release gate passed, the generated Skill CLI remained byte-identical, and the bounded diff is ready for commit.

## Closeout Summary

- Added `docs/specs/20260829-release_management.md` as the accepted owner for release identity, channels, exact asset composition, publication authorization, idempotency, partial publication, retry, supersession, and post-publication acceptance.
- Rewrote `docs/cookbooks/release.md` as an executable operator and agent procedure for preparation, exact-tag authorization, publication monitoring, first-publication `worker-common` visibility handling, retry, and closure.
- Reworked `.github/workflows/ci.yml` so a lowercase release tag runs the release gate, packages the complete Skill, builds digest-only multi-platform image candidates, smokes every declared platform by exact digest, promotes tags without rebuilding, creates an immutable GitHub prerelease or stable release, and verifies every published asset.
- Added a standard-library deterministic Skill packager and hardened release preflight without coupling the product tag to unpublished workspace package versions.
- Pinned the app image base by digest, declared the repository Apache-2.0 license, kept release-image metadata and local guides aligned, and regenerated the committed Skill CLI projection.
- Raised the existing test-governance command buffer from Node's default to 64 MiB after a full repository run proved that valid TAP output exceeded the default buffer; one regression emits repository-scale output and proves the scanner retains it without `ENOBUFS`.

## Verification Evidence Before Independent Acceptance

- `pnpm release:preflight -- --tag v0.1.0-rc.1`: passed for `app`, `worker-common`, `worker-codex`, `worker-opencode`, and `worker-pi`.
- `pnpm release:package -- --tag v0.1.0-rc.1`: produced the expected complete Skill archive and checksum; `sha256sum -c SHA256SUMS` passed from the asset directory and the archive tree contains the license, Skill instructions, agent metadata, references, and executable CLI.
- Root release and test-governance regressions: 41 passed, 0 failed.
- NanoCore Docker and release workflow contract regressions: 26 passed, 0 failed.
- Full repository lint, typecheck, coverage, build, NanoCore E2E, NanoCore built-artifact smoke, and Web built-artifact smoke: passed under the pinned Node 24.18.0 and pnpm 10.33.3 toolchain.
- Full workspace unit execution: all 13 workspace suites passed; the surrounding generated-artifact check correctly remained nonzero until the newly generated tracked `skills/openkit/scripts/openkit` is staged.
- Web build size is informational for the accepted professional-workspace SPA and possible desktop packaging model; the observed 987.59 kB minified chunk warning is not a release blocker.
- No tag, push, package publication, GitHub Release, visibility change, credential use, deployment, or other external publication effect occurred.

## Final Verification Evidence

- Independent Herdr-managed Claude Code verifier and auditor sessions each inspected the actual diff and execution evidence and returned `VERDICT: PASS` with no blockers after the accepted corrections.
- `pnpm -w verify:release` passed as one command against the staged generated Skill CLI under Node 24.18.0 and pnpm 10.33.3.
- Repository validation covered 204 documents and 919 formatted files; all 13 lint tasks and all 10 applicable typecheck tasks passed.
- The unit gate passed all 13 workspace suites and 526 root tests with no failure, cancellation, skip, or todo in the root suite.
- Coverage passed with NanoCore at 2477 passed and one declared skip, Web at 587 passed, and every other coverage-bearing package green.
- Build passed all 11 applicable tasks; NanoCore e2e passed 15 files and 20 tests; NanoCore and Web built-artifact smoke checks passed.
- Focused release checks passed 26 tests, NanoCore image-contract checks passed 26 tests, stable and uppercase release tags failed preflight as required, and `v0.1.0-rc.1` passed for all five controlled release images.
- The observed Web chunk warning was 987.59 kB minified and 274.75 kB gzip and remains informational under the accepted professional-workspace SPA decision.
- Generated `dist/release/` assets were removed after verification, `docs/INDEX.md` was left to its concurrent owner, and unrelated Product Vision, Roadmap, and staging-deployment changes remain outside this change.
- No release tag, push, publication, package visibility mutation, deployment, or credential-bearing external effect occurred.
