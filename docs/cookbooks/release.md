# Release Cookbook

Use this cookbook to prepare, authorize, publish, verify, and record one OpenKit product release.

The owning contract is [`docs/specs/20260829-release_management.md`](../specs/20260829-release_management.md).

## Current Release Posture

The first formal release path starts at `v0.1.0-rc.1`.

The tag workflow currently rejects stable tags because the exact-product R001 NanoHost runtime gate remains open; the controlled `linux/arm64` distribution itself is implemented.

Do not change the release preflight CLI's prerelease-only default until an accepted owner closes that stable-release blocker.

The repository is currently private, and only `worker-common` is required to be anonymously public in GHCR.

Do not change repository or package visibility as an implied part of preparation or publication.

## Release Bundle

One lowercase semantic-version tag identifies the complete product bundle:

- every `release: true` image in `containers/images.json`,
- `openkit-skill-<tag>.tar.gz`, containing `LICENSE` and the complete `skills/openkit/` tree,
- `openkit-nanohost-<tag>-linux-arm64.tar.gz`, containing the verified NanoHost binary, pin-bound Gateway, service unit, installer, manifests, checksums, and licenses,
- `SHA256SUMS` for both portable archives,
- one GitHub Release with image digests and gate evidence.

Private workspace packages are not npm release assets, and their `package.json` versions do not follow the product tag.

`test-env`, the internal dogfood image, and GitHub-generated source archives are not controlled product release assets.

## Prepare The Release

1. Start from an up-to-date `main` and create a preparation branch.

```bash
export OPENKIT_RELEASE_TAG=v0.1.0-rc.1
git switch main
git pull --ff-only
git switch -c "release/${OPENKIT_RELEASE_TAG}"
```

2. Create `docs/changes/<timestamp>-<version>_release/plan.md` and record the intended tag, source commit, current repository visibility, expected image set, manual-gate decision, known limitations, and publication authorization when received.

3. Update user-facing notes and any accepted owner affected by the release contents.

Do not mass-update package versions.

4. Run release preflight.

```bash
pnpm release:preflight -- --tag "${OPENKIT_RELEASE_TAG}"
```

Preflight validates lowercase tag syntax, portable Skill and NanoHost inputs, the promoted host manifest, the accepted OpenShell pin, the release image catalog, smoke paths, the unique public worker base, and digest-pinned bases for every release image.

5. Build the portable assets from the commit that would be released and inspect them.

```bash
pnpm release:package -- --tag "${OPENKIT_RELEASE_TAG}"
(cd dist/release && sha256sum -c SHA256SUMS)
tar -tzf "dist/release/openkit-skill-${OPENKIT_RELEASE_TAG}.tar.gz"
```

The Skill packager uses `git archive`, and NanoHost packaging reads its checkout-owned files from the selected Git revision, so uncommitted files are intentionally excluded. The tag workflow obtains the NanoHost binary from its native arm64 build job and downloads the Gateway and source-license bytes from the pin-derived coordinates before invoking the same packager and verifier.

6. Run the automatic release gate locally.

```bash
pnpm verify:release
```

7. When Docker is available, build and smoke each release image on the local host architecture.

```bash
for image in $(node -e "const m=require('./containers/images.json'); console.log(m.images.filter((i)=>i.release).map((i)=>i.id).join(' '))"); do
  scripts/docker/build-image.sh "${image}"
  scripts/docker/smoke-image.sh "${image}"
done
```

The tag workflow remains authoritative for both declared platforms because it smokes the exact pushed digest for `linux/amd64` and `linux/arm64` before promotion.

8. Run L4 Web e2e or an admitted L6 story only when the release decision requires that additional confidence.

```bash
pnpm test:e2e:web
```

Real-provider, real-subscription, and real-worker gates remain explicit opt-ins and must not be added to automatic tag CI merely for a release.

9. Commit the preparation, obtain normal review, merge it to `main`, and confirm the release commit is clean and contained in `origin/main`.

Each new release tag must point to a commit that has not already been released because the immutable source-revision image tag is part of one release identity; a same-tag rerun continues to use the original commit.

```bash
git switch main
git pull --ff-only
git status --short
git merge-base --is-ancestor HEAD origin/main
pnpm release:preflight -- --tag "${OPENKIT_RELEASE_TAG}"
```

## Publication Authorization

A green gate does not authorize publication.

Before creating the tag, obtain explicit engineer authorization for the exact value of `OPENKIT_RELEASE_TAG` and the release bundle listed above, then record that authorization in the release change record.

Creating or pushing any other tag requires new authorization.

## Publish

After exact-tag authorization:

```bash
git tag "${OPENKIT_RELEASE_TAG}"
git push origin "${OPENKIT_RELEASE_TAG}"
```

The tag push is the only publication trigger.

The workflow then:

- proves that the tagged commit belongs to `main`,
- reruns L0-L3 and L5,
- runs the isolated fixed-path NanoHost installer gate without service lifecycle,
- builds the portable Skill and native arm64 NanoHost assets,
- derives the image matrix from `containers/images.json`,
- pushes digest-only multi-platform image candidates,
- smokes each exact candidate digest on every declared platform,
- promotes the passed digest to immutable version and source-revision tags,
- preserves `latest` for prereleases,
- creates the GitHub prerelease with the two portable archives and their shared checksum attachment,
- downloads and independently verifies the final assets and image digests,
- logs out of GHCR and verifies the exact `worker-common` digest anonymously.

Watch the run until the terminal verification job completes:

```bash
gh run list --workflow CI --branch "${OPENKIT_RELEASE_TAG}" --limit 1
gh run watch <run-id> --exit-status
```

## First worker-common Publication

GitHub creates a new container package as private.

The first `worker-common` publish therefore stops at the anonymous exact-digest gate until a repository administrator changes that package to public.

This one-time visibility change is an explicit external effect; record its authorization and observed result, then rerun the failed workflow without moving the tag.

The rerun proves and reuses the existing version and source-revision digest instead of rebuilding or overwriting it.

## Verify And Close

The workflow's `Verify published release` job is the deciding automatic publication check.

After it passes, inspect the public record and copy the tag, source commit, workflow run, image digests, repository and package visibility, portable checksum, manual-gate disposition, and NanoHost limitation into the release change record.

```bash
gh release view "${OPENKIT_RELEASE_TAG}" --json tagName,isDraft,isPrerelease,assets,url
gh run view <run-id>
```

Close the release change record only when the workflow is green, the GitHub Release is published with exactly the two archives plus `SHA256SUMS`, the downloaded NanoHost archive passes the shared contained staging verifier, and `worker-common` is anonymously inspectable by digest.

## Failure And Retry

Never move, force-push, delete, or overwrite a published release tag or promoted image tag.

Before promotion, a build or smoke failure may be retried under the same tag because no release image tag exists.

After partial matrix publication, rerun the same tag only when the workflow proves that every existing version, version-without-`v`, and source-revision tag is complete and resolves to one recorded digest; matching images are reused and missing image identities are built.

A partial or conflicting tag set fails closed and requires operator inspection.

An existing published GitHub Release is immutable to the workflow; a rerun verifies it but does not edit notes or replace assets.

A current stable tag may be rerun only while its `latest` image tags still resolve to its recorded digests; a superseded stable tag or a stable publication that did not complete `latest` fails closed and requires a new stable tag on a new commit rather than moving `latest` backward.

A behaviorally incorrect or ambiguous promoted artifact requires a new prerelease or patch tag on a new commit and new exact-tag authorization.

Record every partial publication, failed boundary, observed digest, corrective decision, and superseding tag in the release change record.

## Web Bundle Size

Web bundle-size warnings are informational because the Web UI is a professional-workspace SPA and may later be embedded in a desktop application.

Do not split chunks or change the Vite warning threshold without a measured performance objective owned by an accepted Web change.
