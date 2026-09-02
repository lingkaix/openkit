---
status: Accepted
implementation: Partial
date: 2026-08-29
updated: 2026-09-01
---
# Release Management

## Owns

- The product-wide release identity and release-channel policy.
- The exact composition of an OpenKit release across independently owned artifacts.
- The authorization boundary between local preparation and external publication.
- The release lifecycle from preparation through publication, retry, verification, failure, and supersession.
- The cross-asset consistency and post-publication predicates that make one release complete.

## Does Not Own

- Container image contents, image taxonomy, OCI labels, or GHCR naming, which are owned by `docs/specs/20260708-container_image_packaging.md`.
- The end-user Skill package contents or host contract, which are owned by `docs/specs/20260713-openkit_agent_skill_interface.md`.
- NanoHost runtime or distribution readiness, which is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- Test-layer semantics, which are owned by `docs/specs/20260529-test_strategy.md`.
- Repository visibility, GHCR package visibility mutations, GitHub repository rules, or who receives publication credentials.
- npm publication, desktop packaging, a public Skill registry, deployment automation, or update delivery.

## Core References

- `docs/core/foundation.md`
- `docs/core/architecture.md`

## Related Docs

- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260708-container_image_packaging.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`

## Summary

OpenKit releases are explicit, tag-triggered product bundles rather than package-manager releases.

One lowercase semantic-version Git tag identifies the source commit, container images, end-user Skill archive, supported NanoHost distribution, checksum, GitHub Release, and verification record.

An authorized agent prepares and verifies the release locally, receives explicit authorization for the named external publication, pushes the immutable tag, observes the workflow, resolves any first-publication visibility gate without changing artifact identity, and closes only after post-publication verification succeeds.

## Goals / Non-goals

### Goals

- Give an agent one authoritative answer for what a release is and when it is complete.
- Keep every released byte traceable to one tag and source commit.
- Make a same-tag workflow rerun reuse completed artifacts rather than overwrite them.
- Publish the complete end-user Skill beside the release images.
- Publish the NanoHost owner's supported distribution beside the Skill and release images.
- Keep release failure and partial publication visible and recoverable without moving or deleting tags.

### Non-goals

- Do not publish private workspace packages to npm.
- Do not publish `test-env` or the internal dogfood image as product artifacts.
- Do not add signing, mandatory SBOM generation, vulnerability blocking, or GitHub artifact attestations before their existing deferred decisions are activated.
- Do not publish a NanoHost target, installer behavior, or artifact content that its owner has not admitted.
- Do not add a release service, promotion database, custom registry, or compatibility channel.

## Decision

### Release Identity And Channels

The Git tag is the sole OpenKit product release identity.

Tags MUST be lowercase and match `v<major>.<minor>.<patch>` for a stable release or `v<major>.<minor>.<patch>-<pre>` for a prerelease.

Private root, app, and workspace package versions are build metadata only; they are not release identity, are not published, and MUST NOT be mass-updated or validated against the product tag.

The first formal release path is `v0.1.0-rc.1` and later release candidates followed by `v0.1.0` only after the stable-release blocker below is closed.

Each new release tag MUST point to a commit that has not been used by an earlier release tag because its source-revision image tag is an immutable member of that release identity; a same-tag rerun MUST retain the original commit.

A prerelease publishes exact-version and source-revision image tags and creates a GitHub prerelease, but MUST NOT create or change either the GHCR `latest` tag or GitHub's Latest release pointer.

A stable release publishes the same immutable identities and updates `latest` only after the candidate digest has passed its release smoke checks.

### Release Assets

The current release bundle contains exactly these controlled assets:

| Asset | Distribution | Identity |
| --- | --- | --- |
| Catalog entries with `release: true` | GHCR | Exact version tag, version without `v`, source-revision tag, digest, and stable-only `latest` |
| End-user `openkit` Skill | GitHub Release attachment | `openkit-skill-<tag>.tar.gz` containing the complete `skills/openkit/` tree and repository license |
| NanoHost Distribution | GitHub Release attachment | `openkit-nanohost-<tag>-linux-arm64.tar.gz` satisfying the exact target, tree, pin, installer, license, and reproducibility contract owned by the NanoHost specification |
| Portable-asset checksum | GitHub Release attachment | `SHA256SUMS` over the attached Skill and NanoHost archives |
| Release record | GitHub Release | Tag, source commit, workflow run, image tags and digests, automatic gate result, manual-gate disposition, and portable-asset checksum |

GitHub-generated source archives are convenience snapshots and are not controlled release artifacts or checksum authorities.

All root, app, and workspace package manifests remain private and produce no npm assets.

`test-env` remains an internal CI artifact, and the Codex-plus-Pi dogfood image remains an internal non-release artifact.

The NanoHost owner admits exactly one distribution target, `linux/arm64`. Release composition MUST use that owner's exact archive without redefining its contents, destinations, prerequisites, installer semantics, or readiness; no `linux/amd64` NanoHost attachment exists until that owner admits it.

R001 remains open pending fresh exact-product no-host-reboot A1 evidence. Until that runtime gate closes, a release MUST remain a prerelease and its notes MUST state that the NanoHost archive is installable but supported Worker Agent execution is not yet release-ready.

The first stable release requires both an accepted NanoHost distribution artifact and closure of the current R001 runtime gate, or a later accepted product-scope decision to remove Worker Agent execution from that stable release.

### Visibility And Access

`worker-common` MUST satisfy its existing anonymous-public GHCR contract.

Other images and the GitHub Release retain the visibility configured for their owning package or repository; this specification does not silently make them public.

Before publication, the release change record MUST state the observed repository and package visibility and whether the release is private, controlled, or public.

Changing repository or package visibility is a separate explicitly authorized external effect.

### Publication Authorization

Local preparation, a green gate, a release branch, or an existing tag name does not authorize publication.

An agent may create and push a release tag only after an engineer explicitly authorizes publication of that exact tag and resulting asset set.

The authorized tag push is the single workflow trigger for publication; no ordinary branch push, pull request, or local command publishes product assets.

The workflow uses only the job-scoped GitHub permissions required to read source, publish packages, and create the GitHub Release.

### Candidate, Promotion, And Idempotency

Each release image build first pushes only a digest-addressed candidate with no release tag.

The workflow MUST smoke that exact candidate digest on every platform declared by the image catalog before assigning any release tag to it.

Promotion assigns all required release tags to the already-smoked digest without rebuilding it.

Published OCI metadata MUST be derived from the source commit and release inputs; it MUST NOT contain a workflow-run clock value that changes the image digest on retry.

Release runs are serialized across tags so two stable releases cannot race on `latest`.

For one image and release tag, absence of the exact-version, version-without-`v`, and source-revision tags admits candidate build and promotion.

Presence of all three immutable tags at the same digest admits idempotent reuse and MUST NOT rebuild, retag, or mutate the image.

Presence of only one tag, different digests, or an existing tag whose release identity cannot be proved is a conflict that fails closed.

The GitHub Release is created only after every image promotion and portable asset completes.

An existing published GitHub Release is terminal for that tag; a rerun verifies it and MUST NOT edit its notes or replace its assets.

### Failure, Retry, And Supersession

A build or smoke failure before promotion may leave untagged registry content, but it MUST leave no new release tag for that failed image.

A matrix or network failure after some images are promoted is a partial publication: no GitHub Release is created, already promoted tags remain immutable, and the release change record records the observed digests and failed boundary.

Retry of a partial publication uses the same tag only when every existing immutable tag set proves the expected same digest; it reuses those images and builds only entirely absent image identities.

A stable same-tag rerun is admitted only while every `latest` tag still resolves to that stable release's recorded digest; a superseded stable tag or a stable publication that did not complete `latest` fails closed and requires a new stable tag on a new commit rather than moving `latest` backward.

An ambiguous, conflicting, or behaviorally defective promoted artifact is never deleted, overwritten, or repaired under the same version.

The correction is a new prerelease or patch tag, and any incorrect stable `latest` pointer is repaired only by that explicitly authorized successful stable release.

A failed or incomplete GitHub Release creation is not repaired by editing an already published release; the workflow fails for operator inspection and follows GitHub's draft recovery boundary without deleting a published release.

Restarting an authorized workflow changes no authority: the tag and current registry state are re-read before any build or promotion.

### Post-publication Verification

After publication, the workflow MUST verify that every exact-version image tag resolves to the digest recorded for that image.

For every active stable release run, including an admitted same-tag rerun, every `latest` image tag MUST resolve to that same digest.

For a newly promoted prerelease, the workflow MUST prove that it did not change a pre-existing `latest` digest and did not create one when none existed.

The workflow MUST log out of GHCR and inspect the exact `worker-common` digest without credentials.

The workflow MUST download every controlled GitHub Release attachment and verify `SHA256SUMS`. It MUST inspect the Skill archive and run the bundled CLI's local operation discovery under the supported Node runtime without a NanoCore connection. It MUST run the same executable NanoHost release-asset verifier used before publication against the downloaded NanoHost archive, including exact tree, generated-manifest consistency, inner checksums, AArch64 ELF identity, and a newly created contained `DESTDIR` installation; an amd64 verification host reports staging only and makes no live NanoHost readiness claim.

The GitHub Release prerelease state MUST agree with the tag, and its notes MUST name the source commit, workflow run, image digests, automatic gates, manual-gate disposition, visibility posture, NanoHost target and current R001 runtime status, and portable-asset checksum.

## Current Implementation Projection

The existing `.github/workflows/ci.yml` already runs tag preflight, L0-L3, L5, a catalog-derived image matrix, GHCR publication, anonymous `worker-common` inspection, and GitHub Release creation.

The current implementation removes package-version coupling, makes tag parsing lowercase-only, pins every release image base, packages the complete Skill, separates digest candidates from tag promotion, serializes releases, preserves same-tag image identity, applies GitHub prerelease semantics, and performs post-publication verification.

The native arm64 NanoHost build job, NanoHost archive packaging, combined portable checksum, shared NanoHost verifier, isolated fixed-path installer job, and NanoHost attachment and post-publication checks defined by this amendment are implemented and pass their focused local regressions. R002 remains open until the exact final candidate completes its A1 real-artifact gate, R004 remains open until a separately authorized tag is published and verified, and stable preflight remains blocked while R001 is open.

The repository is currently private, no product release exists, and no visibility mutation or release publication occurs as part of this implementation change.

## Testing Strategy / Acceptance Criteria

- The release tag parser accepts lowercase stable and prerelease identities and rejects uppercase identities, while the current release preflight CLI rejects stable tags by default and rejects a release image without a digest-pinned base.
- Release preflight requires the complete Skill entrypoint inputs and does not inspect private workspace package versions.
- The app Dockerfile and image catalog declare the same digest-pinned Node base.
- Every third-party GitHub Action reference in the workflow is pinned to an immutable commit.
- The workflow pushes a digest candidate, smokes every declared platform before promotion, and reuses matching version and source-revision tags without mutation.
- A prerelease GitHub Release is marked prerelease and not Latest; a stable release is marked stable.
- The deterministic Skill packager produces an archive with the expected envelope, complete Skill directory, executable bundle, repository license, and matching SHA-256.
- The tag-only native `ubuntu-24.04-arm` job reads the NanoHost Rust version from its existing app pin, performs a locked release build, runs the binary's side-effect-free `--version`, and hands only that AArch64 binary to portable packaging without A1, a self-hosted runner, or a cross-build framework.
- The NanoHost packager consumes the specification-owned target and one accepted pin projection, verifies the Gateway and commit-bound OpenShell license bytes, rejects non-AArch64 inputs, and produces the exact archive twice with identical bytes.
- One shared NanoHost release-asset verifier accepts the intact pre-publication and downloaded post-publication archive and rejects checksum corruption, wrong tree or architecture, generated-manifest inconsistency, and staging escape before writes.
- Before R002 closes, the exact final candidate commit is built natively on A1, reports its version, packages the real pin-bound inputs, reports successful package and host prerequisites plus the expected nonzero `destination-conflict` for the earlier installed NanoHost bytes, proves all live destinations unchanged, and installs only beneath a newly created contained `DESTDIR`; any artifact-affecting change makes that result stale and requires a rerun, while no service lifecycle or current-deployment effect occurs.
- The repository release gate passes without requiring Docker for ordinary checks; image publication behavior remains decided only by the tag workflow.
- A completed real release satisfies every post-publication predicate above before its release change record becomes verified.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| First `worker-common` publication creates a private package. | The anonymous exact-digest gate fails, an administrator changes visibility once, and the same-tag rerun reuses the already-smoked digest. |
| A matrix failure leaves a partial release. | Version tags are immutable, GitHub Release creation waits for the full matrix, and retry reuses proved pairs while building only missing images. |
| Two releases race on `latest`. | One workflow-level release concurrency group serializes tag releases. |
| A private repository is mistaken for a public product release. | The release record states observed visibility, and visibility changes require separate authorization. |
| An installable NanoHost archive is mistaken for runtime readiness. | Prerelease notes disclose the open R001 runtime gate, stable preflight remains blocked, and staging verification makes no live readiness claim. |

## Open Questions

- None.

## Deferred / Future Work

- Publish another NanoHost platform only after its owner admits a real consumer, target, artifact, and acceptance evidence; source-level platform support does not create a release asset.
- Add build provenance attestations, image signing, SBOM generation, or vulnerability gates only after an accepted verification and consumer policy activates the deferred image-packaging work.
- Publish the internal dogfood image only after its existing design activation condition is met; it remains excluded from product release tags.
- Add a protected GitHub release environment or tag rules only after repository publication or observed unauthorized-tag risk demonstrates the need.
- Publish npm packages only after an external independently versioned package consumer exists.

## Links

- `docs/cookbooks/release.md`
- `.github/workflows/ci.yml`
- `scripts/release-preflight.mjs`
- `scripts/release-image-state.mjs`
- `containers/images.json`
