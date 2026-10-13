---
type: change-plan
status: verified
date: "2026-10-13"
completed: "2026-10-13"
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
| Publication authorization | The engineer selected publication of exactly `v0.1.0-rc.5` and the controlled asset set, after candidate CI passes on the publishing commit. Candidate CI on P passed before the tag. The conditions are under Publication Authorization |
| Tested commit T and publishing commit P | T equals P. P is `2f07da54f647342868e416a658b55b6dd6c40957`, the commit the tag names |
| Classified comparison of T and P | The comparison is empty because T equals P. [Release Management](../../specs/20260829-release_management.md#candidate-ci-and-tag-reuse) requires candidate CI on exact P |
| Candidate CI proof | The first run failed, as recorded below. [Run 38388878850](https://github.com/lingkaix/openkit/actions/runs/38388878850) is a `workflow_dispatch` on exact P. It was created at 2026-10-13T11:14:46Z and completed `success` at 2026-10-13T12:20:28Z, attempt 1. Its Release preflight job was skipped. The coordinator log records that the local release preflight at P passed before the tag |
| Visibility | The independent verification on 2026-10-13 observed the repository and the three image packages as public. This record changes no visibility |
| Published identity | Non-draft prerelease `v0.1.0-rc.5` on P, published at 2026-10-13T13:05:47Z. The asset names, sizes, and digests are under Tag Workflow Run |
| Known-defect disposition | User-facing issues belong in the notes input and are tracked in [#177](https://github.com/lingkaix/openkit/issues/177). The R001 gate [#120](https://github.com/lingkaix/openkit/issues/120) stays open. Issues found after publication are under Manual-Gate Disposition And Known Issues. The published body does not disclose [#242](https://github.com/lingkaix/openkit/issues/242) |
| Frozen checklist identity | Not applicable. [Catalog Stories](../../specs/20260829-release_management.md#catalog-stories) governs post-tag story selection |
| Manual-gate disposition | Recorded under Manual-Gate Disposition And Known Issues. Story 2 was inconclusive. Worker qualification is not complete and not clean. Story 1 was not run |
| Known limitations | Recorded in the notes input and under Manual-Gate Disposition And Known Issues. R001 remains open under [#120](https://github.com/lingkaix/openkit/issues/120), so supported Worker execution and stable promotion are not claimed |
| Scratch rehearsal | Accepted. The rehearsal is in `notrucked/openkit` and made no write to `lingkaix/openkit` |

Run [38377702583](https://github.com/lingkaix/openkit/actions/runs/38377702583) was a `workflow_dispatch`. Its head was `a98b8cb61e078613b2051f06b9132c411021e20b`. It was created at 2026-10-13T09:37:56Z and updated at 2026-10-13T09:55:26Z. Its conclusion is `failure`. Jobs `L0-L2 static, unit, contract`, `L5 smoke`, and `L5 app-image stopped-server recovery` concluded `failure`.

The single cause is `apps/web/src/screens/settings/AiInterfaceScreen.tsx(343,15): error TS2322`. `GatewayConfiguration` typed its `diagnostics` prop as the server `AppDiagnosticsResponse` after `471531a3` made the Core Client result's `build` optional.

`7ffbd7a2` types that prop from the Core Client result. That run is not proof for P. Candidate CI on the final P is run 38388878850, recorded above.

### Controlled Asset Set

The published rc.4 release is the base. It is a non-draft prerelease with exactly four assets: `openkit-ops-skill-v0.1.0-rc.4.tar.gz`, `openkit-nanohost-v0.1.0-rc.4-linux-amd64.tar.gz`, `openkit-nanohost-v0.1.0-rc.4-linux-arm64.tar.gz`, and `SHA256SUMS`. The notes name `openkit-app`, `openkit-worker-common`, and `openkit-worker-runtimes`. For `v0.1.0-rc.5` the same three images and the same four attachment roles use the tag `v0.1.0-rc.5`. The prerelease does not become Latest and does not create or change a GHCR `latest` tag.

## Work Packages Since rc.4

The packages through P are `git log --reverse v0.1.0-rc.4..2f07da54f647342868e416a658b55b6dd6c40957`. `48f44553` follows P on `main` and is not part of the published tag.

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
- This correction fills the rc.4 story 2 evidence cells and dates the started rc.5 scratch rehearsal. At that correction, qualifying rehearsal proof was still pending.
- This update records the failed candidate run on `a98b8cb6`, the Web fix `7ffbd7a2`, and the accepted scratch rehearsal.
- This closeout records the tag run, the published identity, the independent verification, story 2, the later deployment updates, Worker qualification, and the issues found after publication.

Three independent reviews, each by the reviewer role using Codex `gpt-6.1-sol`, cover the release-identity fix. The review of `499fbd6e` is accept with corrections and names three P2 findings. The review of `9d86c244` and `471531a3` is accept with corrections and names two P2 findings and one P3 finding. The review of `5d44fa72` is accept.

### Commit After P

- `48f44553` creates the registry acquisition staging parent on a fresh NanoHost epoch. It refers to [#242](https://github.com/lingkaix/openkit/issues/242). It is on `main`. It is not in the published rc.5 release, and it is not in any published release.

## Engineer Rulings Applied In RC5

These are engineer selections on 2026-10-13. They are selections, not quotations.

The engineer selected the fix design as presented. The App image carries a release identity file set by the release build. Authenticated App Diagnostics reports that identity. The operations Skill receives the corrections named above.

For the story 2 hop from rc.3 to rc.5, the actor prompt adds one operator fact. The deployment currently runs `v0.1.0-rc.3`, because rc.3 cannot report its release. The new read is proven on a later update from rc.5.

The engineer selected publication of exactly `v0.1.0-rc.5` as a non-draft prerelease that never becomes Latest and never creates or changes a GHCR `latest` tag. The asset set is the rc.4 set with the tag replaced. Publication waits until candidate CI passes on the publishing commit.

The engineer's archive cleanup commit `34b86854` goes to `main` with the coordinator's work. That work is done on `main` as `34b86854` and `a908f57f`, after the rc.4 tag `33ef34436fbedb2e8249f2826ddc5c6cad5f91d2`.

At about 07:45Z the engineer selected an rc.5 rehearsal in `notrucked/openkit` with the rc.4 scope. The scope is one scratch prerelease tag such as `v0.0.0-scratch.2`, one scratch prerelease, one new version in each of the three scratch packages, a check that the App image carries the identity file, and the rerun rules. The rehearsal makes no write to `lingkaix/openkit`.

On 2026-10-13 at about 13:40Z the engineer selected one option. It is a selection, not a quotation. The question stated that story 1's starting world, an empty machine with no OpenKit data, conflicts with keeping the data. Faithful English of the selected option: "(Recommended) An operations worker follows the rc.5 Skill's manual path to replace the persistent test deployment's App with the published rc.5 image, keeps using the existing Data Root so the existing Workspaces, Threads and configuration remain usable, and keeps the stopped rc.3 container for rollback. This does not count as a story 1 run."

## Publication Authorization

The mission sentences under Intent authorize an rc.5 and an upgrade trial. They do not by themselves name the asset set. The publication selection above names exactly `v0.1.0-rc.5` and the controlled asset set, after candidate CI passes on the publishing commit. The prerelease never becomes Latest. No GHCR `latest` tag is created or changed. No stable release is authorized. No tag or asset in `lingkaix/openkit` is moved, deleted, overwritten, or replaced.

The scratch rehearsal is a separate selection. It writes only in `notrucked/openkit`. It does not write to `lingkaix/openkit`.

## Publication-Path Proof

`499fbd6e` changes the `publish-container-images` job. A new App-only step, "Pass App release identity build arguments", passes the tag and the commit as build arguments. [Release Management](../../specs/20260829-release_management.md) requires a scratch rehearsal before the real tag when a publication job changes. Scratch commit `a522edccc8f97b47d69efef3ee65af1eff54608d` is a merge of `9d86c244` into scratch `main` `58f7b225` plus the scratch notes. Its publication job bytes equal those of `5d44fa72` and of `7ffbd7a2`: `git diff` of `.github/workflows/ci.yml` and `containers/app/Dockerfile` across `9d86c244`, `5d44fa72`, and `7ffbd7a2` printed nothing. This record does not change those files, so those bytes are the ones P carries for that job.

Rehearsal run [38366163953](https://github.com/notrucked/openkit/actions/runs/38366163953) for `v0.0.0-scratch.2` in `notrucked/openkit` is attempt 1 `success`, updated at 2026-10-13T09:48:32Z. The App leg passed both build arguments, executed the identity step on `linux/amd64` and `linux/arm64`, and smoked both platform candidates before promotion. The scratch release is a non-draft prerelease published at 2026-10-13T09:46:44Z with four assets: `openkit-nanohost-v0.0.0-scratch.2-linux-amd64.tar.gz` (35,111,334 bytes, `sha256:9e81287d8c1c6149066af5491f821d46299367f383e989e1204784cc4cf942b2`), `openkit-nanohost-v0.0.0-scratch.2-linux-arm64.tar.gz` (33,079,912 bytes, `sha256:9c2a393b8baee7eda07bc0be295680132055a402a7359d817ef46493ba4b141a`), `openkit-ops-skill-v0.0.0-scratch.2.tar.gz` (202,635 bytes, `sha256:6da1c8bcab44230705d154bb3a322cb5062e6b921b26678de157083396b72c83`), and `SHA256SUMS` (346 bytes, `sha256:d708117a749500fdc24c0a29328d730dc4df12d6eb23f058b187882bc40f6e8a`).

Attempt 2, a same-tag rerun of all jobs, concluded `success` and was updated at 2026-10-13T10:57:06Z. It reused the images and left the scratch release unchanged. Each of `openkit-app`, `openkit-worker-common`, and `openkit-worker-runtimes` gained one tagged version and two untagged platform versions from attempt 1, and none from attempt 2.

The after-baseline of `lingkaix/openkit`, read at 2026-10-13T10:59:51Z through 2026-10-13T11:00:25Z, equals the before-baseline, including the rc.2, rc.3, and rc.4 draft state and full asset metadata, the tag list, the image digests, and the absent `latest`. The coordinator accepted that result at 2026-10-13T11:05Z.

The private scratch App image could not be pulled without a login, so the file bytes were not read from it. The post-publication verification read the file from the public rc.5 App image. Story 2 found no `build` projection, because no update had started. The later App update read `diagnostics.app` `build`, and that read reported this prerelease. Candidate CI on P is [run 38388878850](https://github.com/lingkaix/openkit/actions/runs/38388878850), and it completed `success`.

## Manual-Gate Disposition And Known Issues

The notes input `release-notes/v0.1.0-rc.5.md` carries the user-facing known issues. Those issues are tracked in [#177](https://github.com/lingkaix/openkit/issues/177). The input adds [#233](https://github.com/lingkaix/openkit/issues/233) through [#239](https://github.com/lingkaix/openkit/issues/239). The published release body matches the notes generated for this tag. The R001 runtime gate [#120](https://github.com/lingkaix/openkit/issues/120) stays open, so a stable promotion is not possible. This record does not claim that a catalog story or Worker qualification passed.

These issues were found after publication. [#240](https://github.com/lingkaix/openkit/issues/240) asks doctor to report Skill compatibility and App-update availability. [#241](https://github.com/lingkaix/openkit/issues/241) asks for one release manifest for an App update. [#242](https://github.com/lingkaix/openkit/issues/242) records that registry Worker image preparation fails on a fresh epoch because the acquisition staging parent is never created. The published rc.5 release body does not disclose [#242](https://github.com/lingkaix/openkit/issues/242). [#243](https://github.com/lingkaix/openkit/issues/243) records that Worker qualification cannot classify a Pi marker refusal, because no Pi native-context evidence is retained.

Three findings have no new issue. The App-update receipt carries no Web identity field. Round `rc5-q1` used the observed served homepage digest `sha256:27b87fa4158506176160d366ac727e0205cc3a5a004d7126e71584293307a8ca`. The Worker environment read reports one applied attachment in `unknown` state after the NanoHost replacement tore down an idle resident Worker. Preparation requires the caller's private administration conversation. The operator brief had named a different conversation.

## Post-Tag Plan

Catalog story 2 (`persistent-deployment-prerelease-update`) ran from `v0.1.0-rc.3` to `v0.1.0-rc.5` on the persistent test deployment. The stage-manager report covers Phases A to C. The actor was Pi, `gpt-6-astra`. The actor stopped before `app-update.prepare` and made no deployment change. The actor run lasted from 2026-10-13T13:35:28.447Z to 2026-10-13T13:37:37.257Z. Two independent judges, Grok 4.7 and Codex `gpt-6.1-sol`, each returned `inconclusive`. The verdicts agree on that code and differ on predicate 10 only. The required helper receipt was never witnessed. The actor did not prepare or start an update, because no public read lets an administrator confirm, without reading other people's content, that no work is running. That limit is known [#233](https://github.com/lingkaix/openkit/issues/233). The deployment stayed on rc.3 until the later App update. Story 1 was not run.

## Deployment Updates After Story 2

These updates are not catalog stories, and they are not Results rows.

An operations worker updated the App on the persistent test deployment from published rc.3 to published rc.5. The worker followed the helper path and kept the existing Data Root. `app-update.prepare` recorded `preparedAt` 2026-10-13T14:02:31.000Z. One `app-update.start` was sent at 2026-10-13T14:06:25Z. The receipt reached `succeeded` at 2026-10-13T14:06:57.000Z. `previousAppRestored` is false. All nine receipt predicates are true: `acceptingProductWork`, `helperReachable`, `imageMatch`, `nanohostReady`, `newBoot`, `noBlockingReadiness`, `retainedAuthRead`, `sourceMatch`, and `webAssets`. The receipt names the published rc.5 App index digest. `diagnostics.app` `build` reported tag `v0.1.0-rc.5` and source commit P. The stopped rc.3 container remains for rollback. This is the selected option above. It is not a story 1 run.

The same deployment then replaced NanoHost with published rc.5 and prepared and activated the Worker environment. The operator report covers Parts 1 to 4. The coordinator log records that work from 2026-10-13T14:32Z through 2026-10-13T15:30Z. The replacement tore down an idle resident Worker. Four registry preparations then failed on the fresh NanoHost epoch. The deciding probe confirmed the cause, which is [#242](https://github.com/lingkaix/openkit/issues/242). The later preparations and activations ran with that recorded diagnostic workaround in place. `48f44553` fixes that cause on `main`. That fix is not in any published release.

## Results

The [compact release record](../../specs/20260829-release_management.md#compact-release-record) names these row headings. Story 2 is the only catalog story this prerelease ran. Worker qualification ran as round `rc5-q1`. The current kit writes one aggregate row for the sixteen cases. No other catalog story was scheduled.

| Subject | Published identity | Deployment digests and time window | Verdict | Classification | Private evidence alias and digest |
| --- | --- | --- | --- | --- | --- |
| Catalog story 2, `persistent-deployment-prerelease-update` | `v0.1.0-rc.5` on `2f07da54f647342868e416a658b55b6dd6c40957` | The running App image before and after the run was `sha256:f1c42ed6cc9430fd4173350c0aced34aa2bfabd6d6e8f6a96a0f842ae6e63586`, the published `v0.1.0-rc.3` App image index digest. No update was started. NanoHost's connection generation stayed 10, and ready stayed true. The run did not record a NanoHost binary digest. That gap is NanoHost being outside the story's effect, because no update was started. The actor run lasted from 2026-10-13T13:35:28.447Z to 2026-10-13T13:37:37.257Z. The after `diagnostics.app` read ended at 2026-10-13T13:46:44Z. The report gives no single end clock for the later container reads | `inconclusive` | The required helper receipt was never witnessed. The actor did not prepare or start an update. No public read lets an administrator confirm, without reading other people's content, that no work is running. The cause is [#233](https://github.com/lingkaix/openkit/issues/233) | The stage-manager report names the package by its manifest. The evidence package manifest SHA-256 is `2f806a69ebfbf350ccd7d7218d9ccb65700d519e5d799b90d68217fa13fe9842`. Judge A verdict SHA-256 is `f1bc9e56e9fb8b9d9b95342205d2ff3c8009179fd1922812d841017b4d0bd2fd`. Judge B verdict SHA-256 is `34141106545197e29fbf4dc54500250710a9b99220053b8e1a1215fac74ba41c` |
| Worker qualification A to D, round `rc5-q1` | `v0.1.0-rc.5` on `2f07da54f647342868e416a658b55b6dd6c40957` | App `sha256:204b94e30986f843f726397af37c584bd9d26be7149c30f7a68b74f1b1d56810`. Web `sha256:27b87fa4158506176160d366ac727e0205cc3a5a004d7126e71584293307a8ca`, the observed served homepage. NanoHost `sha256:8d603098c42b23db4728e8068ea313eaa51a5d893c279db1bc2be76208ac87b4`. Worker `sha256:b359811af26265dbbaf49a1c083a416789137aeecdebc492037595e99ead801d`, the published `linux/arm64` platform digest. The round lasted from 2026-10-13T15:50:34.432Z to 2026-10-13T16:08:32.148Z | `pi.A` is `I`. The other fifteen cases are `P`. `complete` is false and `clean` is false. Counts are executed 16, successful 15, incomplete 1, new 0, known 0, external 0, and environment 0 | The checker adjudicated `pi.A` as inconclusive. The round does not retain the native context or the inference boundary that an accepted-external classification would need. No new defect, known defect, accepted external behaviour, or environment failure was established. The operator's mechanical row proposed `N` for `pi.A` and left the summary unclassified. This row uses the checker's final codes. The coordinator allowed regeneration of `summary.json`, `manifest.json`, `row.md`, and `adjudications.json`. The checker's report says the engineer allowed them, and that sentence is wrong | Alias `retained-rc5-q1`. The manifest SHA-256 from the checker's summarize is `d2b0543a415f084c5c7b8c5a2c7e5ee6c7965dae05971e6de9c0dbd34df32542` |

## Tag Workflow Run

[Tag run 38396894772](https://github.com/lingkaix/openkit/actions/runs/38396894772) is event `push` on head `2f07da54f647342868e416a658b55b6dd6c40957`. `gh run view` returned conclusion `success`. It was created at 2026-10-13T12:23:08Z and updated at 2026-10-13T13:08:04Z. These jobs were skipped: `PR lightweight repo check`, `L4 Web e2e`, `L5 app-image stopped-server recovery`, and `Smoke ${{ matrix.id }} (${{ matrix.platform }})`. Every other job in that run concluded `success`.

The [GitHub Release](https://github.com/lingkaix/openkit/releases/tag/v0.1.0-rc.5) is tag `v0.1.0-rc.5`, `isDraft` false, and `isPrerelease` true. It was published at 2026-10-13T13:05:47Z. It has these assets.

| Asset | Bytes | SHA-256 |
| --- | --- | --- |
| `openkit-nanohost-v0.1.0-rc.5-linux-amd64.tar.gz` | 35,111,363 | `1f595e00e2f6830e0bc97a186aa539023a047fb4cefbcfa575757ebe9b671fd4` |
| `openkit-nanohost-v0.1.0-rc.5-linux-arm64.tar.gz` | 33,079,969 | `dc89dbd01d3452f220938c678941c29b6acd64dc06300b808f5b97d2c4978c07` |
| `openkit-ops-skill-v0.1.0-rc.5.tar.gz` | 202,870 | `ef43e36b8944e14c55cfaafc579c4c794653c94d3fe7ee3e1217e9855c1d02a9` |
| `SHA256SUMS` | 331 | `373ccc35d6e2e94de445faec1dbb52a7f67ba4613b02732cbd9ad3ed2f71d8ed` |

The release body records these image index digests and platform digests.

| Image | Index digest | `linux/amd64` | `linux/arm64` |
| --- | --- | --- | --- |
| `ghcr.io/lingkaix/openkit-app` | `sha256:204b94e30986f843f726397af37c584bd9d26be7149c30f7a68b74f1b1d56810` | `sha256:00d83319840b0122ade61a8a6ba15c71bb545b9c817f28dd6fa1c16eec9fd9ef` | `sha256:94e202d7b5c31d69d6ad2990ea05993c00472f73c43eebea51cccf5601635f10` |
| `ghcr.io/lingkaix/openkit-worker-common` | `sha256:b4c3c2061ecff84a6e9e2abba05447d42cd44af91c4482bdbe415cca79a637e5` | `sha256:33707ca88f5340559551e76aaf8aa15c9d380379253c57f66547964bdec45c93` | `sha256:67a7ecea0f9b7bf02c16b8cf504207c81e264dd8f8279b695fe03cfe94478a4b` |
| `ghcr.io/lingkaix/openkit-worker-runtimes` | `sha256:be4158a4335fe8ba3af725f2f1bb28961a54c70a145ef45645cf29b857acd010` | `sha256:b32b0d22945fddb5a477109d09b95841b7d224ece3eeecda6f52ba62c165409d` | `sha256:b359811af26265dbbaf49a1c083a416789137aeecdebc492037595e99ead801d` |

## Independent Post-Publication Verification

The role is reviewer, under [the reviewer contract](../../roles/reviewer.md). The coordinator's dispatch identifies the model family as Codex `gpt-6.1-sol`. The reviewer did not produce the release.

The report records no actionable publication defect. Its verdict is `VERDICT: verified`. Check 1, tag and commit, passed. Check 2, the tag workflow, passed. Check 3, the GitHub Release and body, passed. Check 4, the attachments, passed. Check 5, the images, platforms, anonymous access, and `latest`, passed. Check 6, earlier releases untouched, passed. That check compared each earlier release's draft state and full asset metadata with the rehearsal baseline, which is the rc.4 lesson. Check 7, the registry HTTP fallback, was not needed. Check 8, visibility, passed. Check 9, the App release-identity file, passed. Two instrument setup failures were resolved and were not counted as evidence. This verdict covers publication. It does not claim a catalog-story pass, Worker qualification, or a stable release.

## Verification Evidence

The tag run, the GitHub Release read, the independent verification report, the stage-manager report, the two judge verdicts, the App-update report, the component report, and the qualification checker supply the evidence above. This writer did not rerun publication, the catalog story, the deployment updates, or Worker qualification. On the tree that contains this closeout, these checks passed: `node scripts/validate-spec-lifecycle.mjs` printed `Validated spec lifecycle metadata.` and exited 0; `node scripts/validate-doc-model.mjs` printed `Validated documentation model (472 documents).` and exited 0; `node scripts/generate-doc-index.mjs --check` printed `Documentation index is current.` and exited 0; `node scripts/validate-story-schema.mjs` printed `Validated story schema (10 stories).` and exited 0. Biome ignores this Markdown path, so it does not apply.

## Closeout

`v0.1.0-rc.5` is published from `2f07da54f647342868e416a658b55b6dd6c40957` and independently verified for the assigned publication checks. Story 2 did not pass. Worker qualification is not complete and not clean. Story 1 was not run. The App on the persistent test deployment now runs the published rc.5 image on the existing Data Root. `48f44553` is on `main` and is not in any published release. The lifecycle is `verified`. This records the independent publication verdict and the post-tag evidence. It does not accept this writer's documentation diff. It does not close the R001 runtime gate or a stable release. Remaining engineer-queue items are outside this record.

Raw complexity for `v0.1.0-rc.4` through P: `git diff --shortstat v0.1.0-rc.4 2f07da54f647342868e416a658b55b6dd6c40957` reported 57 files changed, 948 insertions, and 1,202 deletions. Five specification documents changed, and no Core document changed. Two decision records changed. No new product durable registry is claimed from that name inventory. These figures exclude this closeout.
