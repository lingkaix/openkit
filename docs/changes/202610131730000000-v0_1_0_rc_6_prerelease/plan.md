---
type: change-plan
status: planned
date: "2026-10-14"
started: "2026-10-14"
branch: rc6-prep
---
# v0.1.0-rc.6 Pre-Release

This record preserves the source intent and the preparation evidence for prerelease `v0.1.0-rc.6`.

It adds no design authority.

[Foundation](../../core/foundation.md), [Architecture](../../core/architecture.md), [Release Management](../../specs/20260829-release_management.md), [Persistent Deployment Acceptance](../../specs/20260909-persistent_deployment_acceptance.md), [Test Strategy](../../specs/20260529-test_strategy.md), and [App Update Delivery](../../specs/20260910-app_update_delivery.md) govern the work.

The [Release Cookbook](../../cookbooks/release.md) supplies the procedure.

The closed rc.5 record is [v0.1.0-rc.5 Pre-Release](../202610130800000000-v0_1_0_rc_5_prerelease/plan.md).

The closed rc.4 record is [v0.1.0-rc.4 Pre-Release](../202610130200000000-v0_1_0_rc_4_prerelease/plan.md).

## Intent

This is the first Intent Revision for this plan.

The preparation dispatch dates the coordinator mission 2026-10-10.

The rc.4 record stores the mission translation and does not state that date.

The rc.4 record replaces one private coordinator-handoff path with the phrase `[a private coordinator handoff]`.

Faithful English translation: "We have already completed more than forty rounds of testing and improvement. We have just finished the forty-fifth round of deployment. The report is here, [a private coordinator handoff]. You take over the remaining tasks and continue forward by our method until we publish a release candidate that users can use. For unresolved problems deferred until after this release, you may file them as issues, and include the fix or improvement suggestion from you, or from our discussion. You still act only as the coordinator of this task. You may use herdr to run agents as workers in different roles. The agents you may use are Codex with gpt-6.1-sol high, Cursor Agent with Grok 4.7 high, and Pi with gpt-5.5 or gpt-6-astra. I am going to rest. If anything needs me to handle, confirm, or authorize, record it and give it to me together when I return."

The mission goal is a release candidate that users can use.

`v0.1.0-rc.5` is published and does not meet that goal on a fresh installation.

A fresh NanoHost epoch in rc.5 cannot prepare a Worker environment from a registry.

[#242](https://github.com/lingkaix/openkit/issues/242) records that failure.

The rc.5 record states that the published rc.5 body does not disclose [#242](https://github.com/lingkaix/openkit/issues/242).

`48f44553` fixes that failure on `main`.

The rc.5 record states that `48f44553` is not in the published rc.5 release.

`git log --reverse v0.1.0-rc.5..ec62e05226c0b606f012abdb7427428d38f08480` shows `48f44553` after the rc.5 tag `2f07da54f647342868e416a658b55b6dd6c40957`.

## Preparation Checkpoint — Rewritable

This checkpoint is rewritable and is not authority.

| Field | Current fact or pending observation |
| --- | --- |
| Intended tag | `v0.1.0-rc.6`, a non-draft prerelease that never becomes GitHub Latest and never creates or changes a GHCR `latest` tag |
| Controlled asset set | The rc.5 set, with the tag replaced by `v0.1.0-rc.6`, as detailed below |
| Publication authorization | Pending. The engineer has not authorized publication of exactly `v0.1.0-rc.6` and the controlled asset set |
| Tested commit T and publishing commit P | Not fixed. P will be the commit that carries this record and `release-notes/v0.1.0-rc.6.md` |
| Classified comparison of T and P | Not fixed, because T and P are not fixed. [Release Management](../../specs/20260829-release_management.md#candidate-ci-and-tag-reuse) requires candidate CI on exact P |
| Candidate CI proof | Pending. This preparation has not run candidate CI for `v0.1.0-rc.6` |
| Visibility | `gh repo view lingkaix/openkit --json visibility` returned `PUBLIC` during this preparation. This preparation did not re-read image-package visibility. The rc.5 record states that verification on 2026-10-13 observed the repository and the three image packages as public. This record changes no visibility |
| Published identity | Not published |
| Known-defect disposition | User-facing issues belong in the notes input and are tracked in [#177](https://github.com/lingkaix/openkit/issues/177). The R001 gate [#120](https://github.com/lingkaix/openkit/issues/120) stays open. [#242](https://github.com/lingkaix/openkit/issues/242) is the change in this candidate, not a known-issue line. [#243](https://github.com/lingkaix/openkit/issues/243) stays out of the user notes |
| Frozen checklist identity | Not applicable. [Catalog Stories](../../specs/20260829-release_management.md#catalog-stories) governs post-tag story selection |
| Manual-gate disposition | Pending. No catalog story and no Worker qualification has run for `v0.1.0-rc.6` |
| Known limitations | Recorded in the notes input. R001 remains open under [#120](https://github.com/lingkaix/openkit/issues/120), so supported Worker execution and stable promotion are not claimed |
| Scratch rehearsal | Not required. The publication-path comparison below is empty, and this preparation does not change those paths |

### Controlled Asset Set

The rc.5 record is the base.

It describes a non-draft prerelease with exactly four assets: `openkit-ops-skill-v0.1.0-rc.5.tar.gz`, `openkit-nanohost-v0.1.0-rc.5-linux-amd64.tar.gz`, `openkit-nanohost-v0.1.0-rc.5-linux-arm64.tar.gz`, and `SHA256SUMS`.

The published rc.5 body names `openkit-app`, `openkit-worker-common`, and `openkit-worker-runtimes`.

For `v0.1.0-rc.6` the same three images and the same four attachment roles use the tag `v0.1.0-rc.6`.

The prerelease does not become Latest and does not create or change a GHCR `latest` tag.

The notes input does not contain image digests.

`scripts/release-notes.mjs` writes the image section when the tag run builds the release notes.

The published `v0.1.0-rc.5` body contains the text of `release-notes/v0.1.0-rc.5.md` unchanged, and the body adds the image digests before that input.

This preparation does not write rc.6 image digests.

## Work Packages Since rc.5

The commits before this preparation are `git log --reverse v0.1.0-rc.5..ec62e05226c0b606f012abdb7427428d38f08480`.

- `48f44553` creates the registry acquisition staging parent on a fresh epoch. It refers to [#242](https://github.com/lingkaix/openkit/issues/242).
- `d07af797` closes the rc.5 record.
- `0e08dbb9` records issue 243 in the rc.5 closeout.
- `ec62e052` projects the rc.5 qualification cases and the story 2 alias. That commit is the accepted rc.5 closeout and the base of this preparation.
- This preparation adds `release-notes/v0.1.0-rc.6.md` and this record.

## Pending Engineer Decisions

This plan needs the following decisions from the engineer.

This record does not invent a ruling.

- Publication of exactly `v0.1.0-rc.6` and the controlled asset set is pending.
- T and P are not fixed. Candidate CI on exact P is pending.
- The post-tag App update may use catalog story 2 or the operator path from the rc.5 data-retention ruling. This record does not choose one.

## Publication Authorization

The mission text does not name `v0.1.0-rc.6` or this asset set.

The engineer has not given exact-tag authorization for `v0.1.0-rc.6`.

This record does not claim that authorization.

No stable release is authorized.

This preparation does not push a tag, dispatch a workflow, or publish an asset.

## Publication-Path Proof

[Release Management](../../specs/20260829-release_management.md#publication-path-proof) requires a scratch rehearsal before the real tag when a publication job changes.

An unchanged proved publication job does not need a routine rehearsal.

The rc.5 record states that tag run [38396894772](https://github.com/lingkaix/openkit/actions/runs/38396894772) concluded `success` for `v0.1.0-rc.5`.

`git diff --stat v0.1.0-rc.5 ec62e05226c0b606f012abdb7427428d38f08480 -- .github scripts containers` printed no output and exited 0.

That comparison includes `.github/workflows/ci.yml`.

This preparation does not change `.github`, `scripts`, or `containers`.

A scratch rehearsal is not required for this candidate.

## Manual-Gate Disposition And Known Issues

The notes input is `release-notes/v0.1.0-rc.6.md`.

[#177](https://github.com/lingkaix/openkit/issues/177) tracks the known issues.

The notes keep the R001 statement for [#120](https://github.com/lingkaix/openkit/issues/120).

The R001 runtime gate stays open, so a stable promotion is not possible.

This record does not claim that a catalog story or Worker qualification passed.

The changes section states the [#242](https://github.com/lingkaix/openkit/issues/242) fix in user terms.

The notes do not list [#242](https://github.com/lingkaix/openkit/issues/242) as a known issue.

[#242](https://github.com/lingkaix/openkit/issues/242) stays open until the post-tag proof below.

The rc.5 changes section said that an update from `v0.1.0-rc.4` or earlier still needs the operator to know the running release.

[#232](https://github.com/lingkaix/openkit/issues/232) is still open.

The rc.6 notes keep that limit under known issues, because it is not a change since rc.5.

The notes add [#240](https://github.com/lingkaix/openkit/issues/240) and [#241](https://github.com/lingkaix/openkit/issues/241).

Both were open, and both match the existing user-facing App-update notes.

[#243](https://github.com/lingkaix/openkit/issues/243) is open.

It records a release-test instrument gap.

No owning document says to put [#243](https://github.com/lingkaix/openkit/issues/243) in the user notes.

The notes omit it.

During this preparation, `gh issue view` returned `OPEN` for every issue number in `release-notes/v0.1.0-rc.5.md`, and for 240, 241, 242, and 243.

No linked known-issue line was removed for a closed issue.

## Post-Tag Plan

These actions wait for publication.

None of them has run.

The persistent test deployment updates its App from published `v0.1.0-rc.5` to published `v0.1.0-rc.6`.

[Catalog Stories](../../specs/20260829-release_management.md#catalog-stories) say to run story 2 when the test server already runs an earlier published release with its data.

The rc.5 record states the engineer's data-retention selection.

Story 1 starts from an empty machine and conflicts with keeping the server data.

The selected operator path keeps the existing Data Root, and that path does not count as a story 1 run.

This plan does not choose story 2 or that operator path for the rc.6 App update.

The deployment then replaces NanoHost with `v0.1.0-rc.6` on a fresh epoch.

It prepares and activates the four Worker environments from the registry.

The rc.5 record says that deployment's four registry preparations failed on the fresh rc.5 epoch, and that later preparations used the recorded diagnostic workaround.

The rc.6 preparation does not use that workaround.

That result is the deciding post-tag proof of [#242](https://github.com/lingkaix/openkit/issues/242) in the deployment.

The deployment then runs Worker qualification A to D.

[Worker Qualification](../../specs/20260829-release_management.md#worker-qualification) owns that matrix.

No compact-record row exists yet for a catalog story or a qualification case.

## Verification Evidence

These checks ran on the tree that contains this preparation.

`node scripts/validate-spec-lifecycle.mjs` printed `Validated spec lifecycle metadata.` and exited 0.

`node scripts/validate-doc-model.mjs` printed `Validated documentation model (473 documents).` and exited 0.

`node scripts/generate-doc-index.mjs --check` printed `Documentation index is current.` and exited 0.

The index was not regenerated.

`node scripts/validate-story-schema.mjs` printed `Validated story schema (10 stories).` and exited 0.

`node scripts/release-notes.mjs --check --repo-root . --tag v0.1.0-rc.6` printed `Release notes input passed for v0.1.0-rc.6.` and exited 0.

`git diff --check` printed no output and exited 0.

This writer did not publish a release, run a catalog story, or run Worker qualification.

This writer does not accept this documentation diff.
