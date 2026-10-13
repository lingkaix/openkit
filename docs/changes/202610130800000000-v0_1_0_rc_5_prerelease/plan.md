---
type: change-plan
status: in-progress
date: "2026-10-13"
branch: main
---
# v0.1.0-rc.5 Pre-Release

This record preserves the source intent and the evidence for prerelease `v0.1.0-rc.5`. It adds no design authority. [Foundation](../../core/foundation.md), [Architecture](../../core/architecture.md), [Release Management](../../specs/20260829-release_management.md), [Persistent Deployment Acceptance](../../specs/20260909-persistent_deployment_acceptance.md), [Test Strategy](../../specs/20260529-test_strategy.md), and [App Update Delivery](../../specs/20260910-app_update_delivery.md) govern the work. The [Release Cookbook](../../cookbooks/release.md) supplies the procedure. The closed rc.4 record is [v0.1.0-rc.4 Pre-Release](../202610130200000000-v0_1_0_rc_4_prerelease/plan.md).

## Intent

On 2026-10-13 at 06:54Z the engineer gave this mission. Faithful English translation: "Fix this bug, quickly release an RC5, and try the upgrade."

On 2026-10-13 at 06:57Z the engineer added this condition. Faithful English translation: "If the bug prevents a direct upgrade with story two, then run story one to redeploy. Remember that this time we need to keep the data on the server."

"This bug" is [#232](https://github.com/lingkaix/openkit/issues/232).

## Preparation Checkpoint — Rewritable

This checkpoint is rewritable and is not authority.

| Field | Current fact or pending observation |
| --- | --- |
| Intended tag | `v0.1.0-rc.5`, a non-draft prerelease that never becomes GitHub Latest and never creates or changes a GHCR `latest` tag |
| Controlled asset set | The rc.4 set, with the tag replaced by `v0.1.0-rc.5`, as detailed below |
| Publication authorization | The engineer selected publication of exactly `v0.1.0-rc.5` and the controlled asset set, after candidate CI passes on the publishing commit. The conditions are under Publication Authorization |
| Tested commit T and publishing commit P | Pending. The publishing commit P will be the commit on `main` that last changes this record before the tag. Candidate CI on that commit remains pending |
| Classified comparison of T and P | Pending, because T and P are not yet the tagged commit |
| Candidate CI proof | The first run failed, as recorded below. Candidate CI on the final P is pending |
| Visibility | This record adds no new visibility observation. [Release Management](../../specs/20260829-release_management.md) records that the repository was public on 2026-10-12 |
| Published identity | Pending. This record does not create the tag or the GitHub Release |
| Known-defect disposition | User-facing issues belong in `release-notes/v0.1.0-rc.5.md` and are tracked in [#177](https://github.com/lingkaix/openkit/issues/177). The R001 gate [#120](https://github.com/lingkaix/openkit/issues/120) stays open |
| Frozen checklist identity | Not applicable. [Catalog Stories](../../specs/20260829-release_management.md#catalog-stories) governs post-tag story selection |
| Manual-gate disposition | Recorded under Manual-Gate Disposition And Known Issues. Story 2, the story 1 fallback, and Worker qualification remain pending after publication |
| Known limitations | Recorded in the notes input. R001 remains open under [#120](https://github.com/lingkaix/openkit/issues/120), so supported Worker execution and stable promotion are not claimed |
| Scratch rehearsal | Accepted. The rehearsal is in `notrucked/openkit` and made no write to `lingkaix/openkit` |

Run [38377702583](https://github.com/lingkaix/openkit/actions/runs/38377702583) was a `workflow_dispatch`. Its head was `a98b8cb61e078613b2051f06b9132c411021e20b`. It was created at 2026-10-13T09:37:56Z and updated at 2026-10-13T09:55:26Z. Its conclusion is `failure`. Jobs `L0-L2 static, unit, contract`, `L5 smoke`, and `L5 app-image stopped-server recovery` concluded `failure`.

The single cause is `apps/web/src/screens/settings/AiInterfaceScreen.tsx(343,15): error TS2322`. `GatewayConfiguration` typed its `diagnostics` prop as the server `AppDiagnosticsResponse` after `471531a3` made the Core Client result's `build` optional.

`7ffbd7a2` types that prop from the Core Client result. That run is not proof for P. Candidate CI on the final P is pending.

### Controlled Asset Set

The published rc.4 release is the base. It is a non-draft prerelease with exactly four assets: `openkit-ops-skill-v0.1.0-rc.4.tar.gz`, `openkit-nanohost-v0.1.0-rc.4-linux-amd64.tar.gz`, `openkit-nanohost-v0.1.0-rc.4-linux-arm64.tar.gz`, and `SHA256SUMS`. The notes name `openkit-app`, `openkit-worker-common`, and `openkit-worker-runtimes`. For `v0.1.0-rc.5` the same three images and the same four attachment roles use the tag `v0.1.0-rc.5`. The prerelease does not become Latest and does not create or change a GHCR `latest` tag.

## Work Packages Since rc.4

Commits after the rc.4 tag `33ef34436fbedb2e8249f2826ddc5c6cad5f91d2` are the packages below. Through `a98b8cb6` they are on `main`. `7ffbd7a2` is not yet on `main`. The publishing commit P will be the commit on `main` that last changes this record before the tag.

### Product Changes

- `499fbd6e` reports the running release tag and source commit in authenticated App Diagnostics. The App image carries that identity as a file set by the release build. It refers to [#232](https://github.com/lingkaix/openkit/issues/232).
- `471531a3` keeps the build projection's producer typed and structurally closed, and its reader tolerant, with regressions.
- `7ffbd7a2` types the Web `GatewayConfiguration` `diagnostics` prop from the Core Client result, after `471531a3` made that result's `build` optional.

### Release Process And Documentation

- `34b86854` removes audited historical change records. The coordinator records this as the engineer's archive cleanup, done with the coordinator's work on `main`.
- `a908f57f` retires the exact-source update procedure. [Retire The Exact-Source Update Procedure](../../decisions/20261013-retire_exact_source_update.md) records the ruling. A persistent deployment updates only to a published release.
- `9d86c244` gives administrators a public path to the expected current image and corrects the operations Skill description of App-update preparation. [App Image Release Identity](../../decisions/20261013-app_image_release_identity.md) records the decision. [#233](https://github.com/lingkaix/openkit/issues/233) stays open for a running-work read and a product preflight.
- `5d44fa72` qualifies the expected-image advice so it keeps the general matching rule, and the admission observation states its limit.
- This update aligns `release-notes/v0.1.0-rc.5.md` and this record with that accepted fix.
- This correction fills the rc.4 story 2 evidence cells and dates the started rc.5 scratch rehearsal. Qualifying rehearsal proof remains pending.
- This update records the failed candidate run on `a98b8cb6`, the Web fix `7ffbd7a2`, and the accepted scratch rehearsal.

Three independent reviews, each by the reviewer role using Codex `gpt-6.1-sol`, cover the fix. The review of `499fbd6e` is accept with corrections and names three P2 findings. The review of `9d86c244` and `471531a3` is accept with corrections and names two P2 findings and one P3 finding. The review of `5d44fa72` is accept.

## Engineer Rulings Applied In RC5

These are engineer selections on 2026-10-13. They are selections, not quotations.

The engineer selected the fix design as presented. The App image carries a release identity file set by the release build. Authenticated App Diagnostics reports that identity. The operations Skill receives the corrections named above.

For the story 2 hop from rc.3 to rc.5, the actor prompt adds one operator fact. The deployment currently runs `v0.1.0-rc.3`, because rc.3 cannot report its release. The new read is proven on a later update from rc.5.

The engineer selected publication of exactly `v0.1.0-rc.5` as a non-draft prerelease that never becomes Latest and never creates or changes a GHCR `latest` tag. The asset set is the rc.4 set with the tag replaced. Publication waits until candidate CI passes on the publishing commit.

The engineer's archive cleanup commit `34b86854` goes to `main` with the coordinator's work. That work is done on `main` as `34b86854` and `a908f57f`, after the rc.4 tag `33ef34436fbedb2e8249f2826ddc5c6cad5f91d2`.

At about 07:45Z the engineer selected an rc.5 rehearsal in `notrucked/openkit` with the rc.4 scope. The scope is one scratch prerelease tag such as `v0.0.0-scratch.2`, one scratch prerelease, one new version in each of the three scratch packages, a check that the App image carries the identity file, and the rerun rules. The rehearsal makes no write to `lingkaix/openkit`.

## Publication Authorization

The mission sentences under Intent authorize an rc.5 and an upgrade trial. They do not by themselves name the asset set. The publication selection above names exactly `v0.1.0-rc.5` and the controlled asset set, after candidate CI passes on the publishing commit. The prerelease never becomes Latest. No GHCR `latest` tag is created or changed. No stable release is authorized. No tag or asset in `lingkaix/openkit` is moved, deleted, overwritten, or replaced.

The scratch rehearsal is a separate selection. It writes only in `notrucked/openkit`. It does not write to `lingkaix/openkit`.

## Publication-Path Proof

`499fbd6e` changes the `publish-container-images` job. A new App-only step, "Pass App release identity build arguments", passes the tag and the commit as build arguments. [Release Management](../../specs/20260829-release_management.md) requires a scratch rehearsal before the real tag when a publication job changes. Scratch commit `a522edccc8f97b47d69efef3ee65af1eff54608d` is a merge of `9d86c244` into scratch `main` `58f7b225` plus the scratch notes. Its publication job bytes equal those of `5d44fa72` and of `7ffbd7a2`: `git diff` of `.github/workflows/ci.yml` and `containers/app/Dockerfile` across `9d86c244`, `5d44fa72`, and `7ffbd7a2` printed nothing. This record does not change those files, so those bytes are the ones P carries for that job.

Rehearsal run [38366163953](https://github.com/notrucked/openkit/actions/runs/38366163953) for `v0.0.0-scratch.2` in `notrucked/openkit` is attempt 1 `success`, updated at 2026-10-13T09:48:32Z. The App leg passed both build arguments, executed the identity step on `linux/amd64` and `linux/arm64`, and smoked both platform candidates before promotion. The scratch release is a non-draft prerelease published at 2026-10-13T09:46:44Z with four assets: `openkit-nanohost-v0.0.0-scratch.2-linux-amd64.tar.gz` (35,111,334 bytes, `sha256:9e81287d8c1c6149066af5491f821d46299367f383e989e1204784cc4cf942b2`), `openkit-nanohost-v0.0.0-scratch.2-linux-arm64.tar.gz` (33,079,912 bytes, `sha256:9c2a393b8baee7eda07bc0be295680132055a402a7359d817ef46493ba4b141a`), `openkit-ops-skill-v0.0.0-scratch.2.tar.gz` (202,635 bytes, `sha256:6da1c8bcab44230705d154bb3a322cb5062e6b921b26678de157083396b72c83`), and `SHA256SUMS` (346 bytes, `sha256:d708117a749500fdc24c0a29328d730dc4df12d6eb23f058b187882bc40f6e8a`).

Attempt 2, a same-tag rerun of all jobs, concluded `success` and was updated at 2026-10-13T10:57:06Z. It reused the images and left the scratch release unchanged. Each of `openkit-app`, `openkit-worker-common`, and `openkit-worker-runtimes` gained one tagged version and two untagged platform versions from attempt 1, and none from attempt 2.

The after-baseline of `lingkaix/openkit`, read at 2026-10-13T10:59:51Z through 2026-10-13T11:00:25Z, equals the before-baseline, including the rc.2, rc.3, and rc.4 draft state and full asset metadata, the tag list, the image digests, and the absent `latest`. The coordinator accepted that result at 2026-10-13T11:05Z.

The private scratch App image could not be pulled without a login, so the file bytes were not read from it. The post-publication verification reads the file from the public rc.5 App image, and story 2 reads the `diagnostics.app` `build` projection. Candidate CI on the final P remains pending.

## Manual-Gate Disposition And Known Issues

The notes input `release-notes/v0.1.0-rc.5.md` carries the user-facing known issues. Those issues are tracked in [#177](https://github.com/lingkaix/openkit/issues/177). The input adds [#233](https://github.com/lingkaix/openkit/issues/233) through [#239](https://github.com/lingkaix/openkit/issues/239). The generated release body is pending publication. The R001 runtime gate [#120](https://github.com/lingkaix/openkit/issues/120) stays open, so a stable promotion is not possible. L6 catalog stories and Worker qualification are post-tag work and are not claimed by this record.

## Post-Tag Plan

After publication, an independent post-publication verification runs. Its baseline records each earlier release's draft state and full asset metadata. Catalog story 2 then runs from rc.3 to rc.5 on the persistent test deployment, with the added operator fact that the deployment currently runs `v0.1.0-rc.3`. If the bug still prevents story 2, story 1 redeploys rc.5 on that deployment while keeping its existing data: the Data Root, the protected configuration, and the retained Workspace data. Worker qualification then runs on rc.5.

## Results

The [compact release record](../../specs/20260829-release_management.md#compact-release-record) names these row headings. No row is filled yet.

| Subject | Published identity | Deployment digests and time window | Verdict | Classification | Private evidence alias and digest |
| --- | --- | --- | --- | --- | --- |

Rows: pending

## Tag Workflow Run

Pending

## Independent Post-Publication Verification

Pending. The baseline must record each earlier release's draft state and full asset metadata.

## Closeout

Pending
