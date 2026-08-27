# Release Cookbook

Use this cookbook when cutting a new OpenKit version from `main`.

OpenKit releases are tag-driven. A pushed semantic version tag such as `v0.0.1` on `main` is the release event, and GitHub Actions owns the release gate, release image publishing, digest summary, and GitHub Release notes.

## References

- [Test strategy](../specs/20260529-test_strategy.md)
- [L6 story acceptance](../specs/20260529-l6_story_acceptance.md)
- [Container image packaging](../specs/20260708-container_image_packaging.md)
- [GitHub workflow policy](../../.github/workflows/README.md)

## Release Model

- Use lowercase tags in the form `v<major>.<minor>.<patch>`, such as `v0.0.1`.
- Use pre-release tags in the form `v<major>.<minor>.<patch>-<pre>`, such as `v0.0.2-rc.1`.
- Update package versions before tagging; the tag workflow must not mutate `package.json`.
- Cut releases only from `main`.
- Do not move a release tag after it has been pushed.
- Publish only container images marked with `"release": true` in `containers/images.json`.
- Keep L4 Web e2e and L6 story acceptance manual unless the test strategy explicitly promotes them into the automatic release gate.

## Before Tagging

1. Pick the target version.

```bash
export OPENKIT_RELEASE_VERSION=0.0.1
export OPENKIT_RELEASE_TAG=v${OPENKIT_RELEASE_VERSION}
```

2. Create a release preparation branch from an up-to-date `main`.

```bash
git switch main
git pull --ff-only
git switch -c release/${OPENKIT_RELEASE_TAG}
```

3. Update every release workspace `package.json` version to the target version.

The release workspace is the root package, `apps/*`, `packages/*`, and `mcp`.

4. Update the release change record.

Use `docs/changes/<timestamp>-${OPENKIT_RELEASE_VERSION//./_}_release_plan/plan.md` for the version checklist, important decisions, known limitations, manual gate results, image digests, and final verification summary. The file is the required member of a `change-plan` bundle; add `state.json` and `findings.md` beside it only when the release program produces those optional evidence members.

5. Check the image manifest.

```bash
node scripts/release-preflight.mjs \
  --tag "${OPENKIT_RELEASE_TAG}" \
  --repo-root . \
  --require-release-worker-digests
```

This catches package version mismatches, invalid version tags, missing release images, missing smoke scripts, and release worker images that still use tag-only base images.

6. Build and smoke release images locally when Docker is available.

```bash
scripts/docker/build-image.sh app
scripts/docker/smoke-image.sh app
scripts/docker/build-image.sh worker-codex
scripts/docker/smoke-image.sh worker-codex
```

7. Run the automatic release gate locally.

```bash
pnpm -w verify:release
```

8. Run optional manual confidence gates only when the release owner wants the extra signal.

```bash
pnpm -w test:e2e:web
```

Run an admitted L6 story separately under the L6 story-acceptance specification when that agentic product-intent evidence is required.

9. Merge the release preparation branch into `main`.

Do not tag a branch that has not landed on `main`.

## Tag And Push

1. Update local `main` after the release preparation branch merges.

```bash
git switch main
git pull --ff-only
```

2. Run the preflight against the commit that will be tagged.

```bash
node scripts/release-preflight.mjs \
  --tag "${OPENKIT_RELEASE_TAG}" \
  --repo-root . \
  --require-release-worker-digests
```

3. Create and push the version tag.

```bash
git tag "${OPENKIT_RELEASE_TAG}"
git push origin "${OPENKIT_RELEASE_TAG}"
```

## GitHub Actions Gate

The tag workflow runs these default release jobs:

- release preflight,
- L0-L2 static, unit, and contract verification,
- L3 NanoCore e2e,
- L5 smoke,
- container image manifest matrix generation,
- release image build and smoke,
- GHCR publish,
- GitHub Release notes creation or update.

The workflow publishes stable tags as `vX.Y.Z`, `X.Y.Z`, `sha-<shortsha>`, and `latest`.

The workflow publishes pre-release tags as `vX.Y.Z-pre`, `X.Y.Z-pre`, and `sha-<shortsha>`.

Pre-release tags must not update `latest`.

## After The Workflow Passes

1. Open the successful Actions run and inspect the image digest summary.

2. Check that GHCR contains the expected release image tags.

```bash
docker pull ghcr.io/<owner>/openkit-app:${OPENKIT_RELEASE_TAG}
docker pull ghcr.io/<owner>/openkit-worker-codex:${OPENKIT_RELEASE_TAG}
```

3. Check the GitHub Release notes.

The notes must include the tag, source commit, workflow run, image tags, and pushed digests.

4. Copy the final image digest references and known limitations into the release change record.

5. Mark the release change record as verified when the release gate, image publish, GHCR check, and release notes check are complete.

## If The Workflow Fails

- Do not move the pushed tag.
- Do not force-push the tag.
- Fix the problem on a new commit.
- For an unreleased candidate, create a new pre-release tag such as `v0.0.1-rc.2`.
- For a failed stable release attempt, decide whether the next tag is a patch tag or an RC tag before publishing again.
- Record the failed run and the new tag decision in the release change record.

## Manual Gates

L4 Web e2e and L6 story acceptance are manual release confidence checks. Run Web e2e when the release owner wants browser-flow evidence beyond the default gate, and execute admitted L6 stories under the L6 story-acceptance specification when agentic product-intent evidence is required.

The app-owned `test:e2e:real-provider`, `test:e2e:real-subscription`, and `test:e2e:real-task-mode` gates remain explicit opt-ins.

Do not wire real-provider, real-Codex, subscription-auth, or quota-consuming tests into automatic tag release CI.

## Current First-Release Blockers

- Every release workspace `package.json` still needs the final release version before the first stable tag.
- Release worker images must use digest-pinned base images before `--require-release-worker-digests` can pass.
- The first release change record must capture final image digests and any packaging limitations.
