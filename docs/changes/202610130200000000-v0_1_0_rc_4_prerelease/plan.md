---
type: change-plan
status: verified
date: "2026-10-13"
completed: "2026-10-13"
branch: main
---
# v0.1.0-rc.4 Pre-Release

This record preserves the source intent and the evidence for prerelease `v0.1.0-rc.4`. It adds no design authority. [Foundation](../../core/foundation.md), [Architecture](../../core/architecture.md), [Release Management](../../specs/20260829-release_management.md), [Persistent Deployment Acceptance](../../specs/20260909-persistent_deployment_acceptance.md), [Test Strategy](../../specs/20260529-test_strategy.md), and their linked owners govern the work. [L6 Story Reorganization](../../decisions/20261012-l6_story_reorganization.md) and [Catalog Story Cadence](../../decisions/20261012-catalog_story_cadence.md) record the accepted rulings this prerelease applies. The [Release Cookbook](../../cookbooks/release.md) supplies the procedure.

## Intent

The engineer gave this mission, quoted verbatim:

> 「我们已经完成了四十多轮的测试与改进。刚刚已经完成了第四十五轮的部署。Report在这里，[a private coordinator handoff], 你接手剩下的任务，按照我们的方法继续向前推进，直到我们发布一个对于用户可用的RC版本。对于那些推迟到这个 release 版本之后的未解决的问题，你可以把它们提交为 issues, 记得带上你或者你与我讨论之后的修复或改进建议。你依旧只作为本次任务的 coordinator，你可以通过herdr 来使用各种 agents，扮演不同角色的 workers。可使用的agents有codex + gpt-6.1-sol high, cursor agent + grok 4.7 high, pi + gpt-5.5 / gpt-6-astra. 我去休息了。如果你有任何需要我处理或需要我确认或授权的问题，记录下来，等我回来的时候，你再一并交给我处理。」

Faithful English translation: "We have already completed more than forty rounds of testing and improvement. We have just finished the forty-fifth round of deployment. The report is here, [a private coordinator handoff]. You take over the remaining tasks and continue forward by our method until we publish a release candidate that users can use. For unresolved problems deferred until after this release, you may file them as issues, and include the fix or improvement suggestion from you, or from our discussion. You still act only as the coordinator of this task. You may use herdr to run agents as workers in different roles. The agents you may use are Codex with gpt-6.1-sol high, Cursor Agent with Grok 4.7 high, and Pi with gpt-5.5 or gpt-6-astra. I am going to rest. If anything needs me to handle, confirm, or authorize, record it and give it to me together when I return."

That quote replaces one private coordinator-handoff path with the phrase `[a private coordinator handoff]`.

## Preparation Checkpoint — Rewritable

This checkpoint is rewritable and is not authority.

| Field | Current fact or pending observation |
| --- | --- |
| Intended tag | `v0.1.0-rc.4`, a prerelease that never becomes GitHub Latest and never creates or changes a GHCR `latest` tag |
| Controlled asset set | The rc.3 set, with the tag replaced by `v0.1.0-rc.4`, as detailed below |
| Publication authorization | The engineer granted publication on 2026-10-13 for exactly `v0.1.0-rc.4` and the controlled asset set. The conditions are under Publication Authorization |
| Tested commit T and publishing commit P | T equals P. P is `33ef34436fbedb2e8249f2826ddc5c6cad5f91d2`, the commit the tag names. That commit carries this record and `release-notes/v0.1.0-rc.4.md`. P moved past `177553e8` because candidate CI on `177553e8` failed, and the test fix, the item 33 clarification, and the publication update landed before the tag |
| Classified comparison of T and P | The planned comparison is empty because T equals P. The former product-input comparison for pre-tag round reuse no longer applies under [L6 Story Reorganization](../../decisions/20261012-l6_story_reorganization.md). [Release Management](../../specs/20260829-release_management.md#candidate-ci-and-tag-reuse) requires candidate CI on exact P |
| Candidate CI proof | The first run failed, as recorded below. [Run 38347889829](https://github.com/lingkaix/openkit/actions/runs/38347889829) is a `workflow_dispatch` on exact P. It was created at 2026-10-13T04:44:16Z and completed `success` at 2026-10-13T05:49:09Z, attempt 1 |
| Visibility | This record adds no new visibility observation. [Release Management](../../specs/20260829-release_management.md) records that the repository was public on 2026-10-12. Preparation does not change visibility |
| Published identity | Non-draft prerelease `v0.1.0-rc.4` on P, published at 2026-10-13T06:24:09Z. The asset names, sizes, and digests are under Tag Workflow Run |
| Known-defect disposition | User-facing issues belong in the notes input and are tracked in [#177](https://github.com/lingkaix/openkit/issues/177). The R001 gate [#120](https://github.com/lingkaix/openkit/issues/120) stays open. Other follow-ups are named below |
| Frozen checklist identity | Not applicable to rc.4's former pre-tag scenario set. [L6 Story Reorganization](../../decisions/20261012-l6_story_reorganization.md) removed those rounds. The current [Catalog Stories](../../specs/20260829-release_management.md#catalog-stories) owner governs post-tag story selection |
| Manual-gate disposition | Recorded under Manual-Gate Disposition And Known Issues and Post-Tag Plan. Story 2 on rc.4 was inconclusive. Worker qualification was not run. Both continue on rc.5 |
| Known limitations | Recorded under Manual-Gate Disposition And Known Issues and in the notes input. R001 remains open under [#120](https://github.com/lingkaix/openkit/issues/120), so supported Worker execution and stable promotion are not claimed |

Run [38338436668](https://github.com/lingkaix/openkit/actions/runs/38338436668) was a `workflow_dispatch` with gate `release-gate`. Its head was `177553e83d01709b9aff879d70bc89e4f213efef`. It was created at 2026-10-13T02:45:46Z. Job `L0-L2 static, unit, contract` concluded `failure`.

Two tests in `apps/nanocore/src/lib/store-capture-coverage.test.ts` failed. One test is `blocks governed collection when admission coverage file sync fails`. The other is the same case for directory sync.

`00ffef53` writes a new Turn under the staging directory and publishes it by one rename. The Turn manifest's file synchronization moved into staging. The directory synchronization moved to the canonical `turns/` parent after the rename. The test still armed the old locations, and its injected fault never fired. The product still synchronized both.

The fix is test-only. `2dc0f087` arms the staged manifest file and the exact directory each case requires. An independent reviewer accepted it after two rounds. Three product mutations each failed its case: remove the manifest fsync, remove the post-rename parent sync, and sync the child directory instead of the parent. That run is not proof for P.

Candidate CI on the final P: [run 38347889829](https://github.com/lingkaix/openkit/actions/runs/38347889829) completed `success` on attempt 1. Its head is P. This closeout does not restate every job. The tag run below reused the L0-L2 and L3 jobs from that exact commit.

### Controlled Asset Set

The rc.3 record and the published rc.3 release agree. `gh release view v0.1.0-rc.3 --repo lingkaix/openkit` shows a non-draft prerelease with exactly four assets: `openkit-ops-skill-v0.1.0-rc.3.tar.gz`, `openkit-nanohost-v0.1.0-rc.3-linux-amd64.tar.gz`, `openkit-nanohost-v0.1.0-rc.3-linux-arm64.tar.gz`, and `SHA256SUMS`. The notes name `openkit-app`, `openkit-worker-common`, and `openkit-worker-runtimes`. Each image has the exact-version tag, the version-without-`v` tag, and the source-revision tag. The notes do not list `latest`. The Skill archive contains the operations Skill, the generated administrator executable, and the repository license.

`containers/images.json` is unchanged from `v0.1.0-rc.3` to `main`. `test-env` stays out of the controlled set. `scripts/README.md` drops the product-input classifier entry and names `release-notes.mjs`. That guide change does not change the attachment set. The workflow differs in four jobs, named under Publication-Path Proof. For `v0.1.0-rc.4` the same three images and the same four attachment roles use the tag `v0.1.0-rc.4`. The prerelease does not become Latest.

## Work Packages Since rc.3

The packages through `7af42388` are `git log --reverse v0.1.0-rc.3..7af42388`. Commits after `7af42388` are listed after those packages. An independent Codex reviewer reviewed each package in that range before it landed. A bullet with no issue number comes from a commit that names none.

### Product Changes

- `23e1ef83` rebuilds a Workspace index set only when that set is missing or invalid, and a completed rebuild stays informational. It closes [#217](https://github.com/lingkaix/openkit/issues/217).
- `b0412b50` writes the resource catalog and the thread-visibility cutover through the durable atomic writer.
- `00ffef53` publishes a new Thread, Turn, Artifact, or AgentSession directory by one staged rename. This is the item 24 fix.
- `64536763` names the first failing NanoHost member and the exit that member showed. It closes [#181](https://github.com/lingkaix/openkit/issues/181).
- `85349f1e` lets NanoHost import a multi-platform image index by selecting the host-platform manifest. It refers to [#206](https://github.com/lingkaix/openkit/issues/206).
- `cef2ee8e` refuses an App container that lacks bounded `json-file` logs before any update receipt, and names the missing setting. It refers to [#215](https://github.com/lingkaix/openkit/issues/215).
- `c7d07e5d` publishes GitHub Release notes from a reviewed input file and records each platform manifest digest. It refers to [#216](https://github.com/lingkaix/openkit/issues/216) and [#206](https://github.com/lingkaix/openkit/issues/206).

### Release Process And Documentation

- `d7a7197b` checks the rendered Web browser during round preparation and takes the round sequence at the final summary.
- `d59de33b` records the counted rc.3 rounds, the tag run, the accepted verification, and the rc.3 closeout.
- `151828ca` limits two readiness sentences to what boot actually records.
- `32d3b950` adopts short sentence rules for repository documents. Existing text follows [#218](https://github.com/lingkaix/openkit/issues/218).
- `4d0bc908` makes L6 ten outcome stories on the published prerelease, and deterministic CI is the pre-tag gate.
- `58c13f4f` reads the dogfood helper's public host from `OPENKIT_PUBLIC_HOST`.
- `baca982c` accepts the product integrity check specification. Implementation follows this prerelease.
- `d44d41ec` limits the release-round runner to Worker qualification and removes the dogfood deploy helper. It refers to [#210](https://github.com/lingkaix/openkit/issues/210).
- `3360b802` writes the ten catalog stories as outcome stories and drops cleanup from story 9. It refers to [#226](https://github.com/lingkaix/openkit/issues/226).
- `7af42388` requires every catalog story to pass at least once per release cycle and chooses story 1 or story 2 from the test server's state.

### Commits After `7af42388`

- `177553e8` adds this record and the notes input `release-notes/v0.1.0-rc.4.md`.
- `2dc0f087` is the test-only capture-coverage fix recorded above.
- `40f9d400` records the item 33 ruling in Release Management, the release cookbook, the L6 catalog entry for story 2, story 2, and [Story 2 From Any Earlier Release](../../decisions/20261013-story_2_from_any_earlier_release.md).
- This update records the publication grant, the first candidate CI result, and the scratch rehearsal result so far.
- This closeout records the tag run, the published identity, the completed rehearsal, the independent verification, story 2, and the item 29 and item 31 rulings.

## Engineer Rulings Applied In RC4

Items 21 to 33 were read. A ruling that changed this prerelease is quoted. A ruling that cannot be quoted without a private detail is summarized.

Items 21 to 24 share one sentence. The engineer wrote, verbatim: 「第二十一项和第二十二项我同意。第二十四项在RC4修复。我同意你的修复方案。第二十三项，方向上我同意你的设计。不过，你所说的结论的report在哪里呢？」 Faithful English translation: "I agree with items twenty-one and twenty-two. Fix item twenty-four in RC4. I agree with your fix proposal. On item twenty-three, I agree with the direction of your design. Where is the report of the conclusions you described?" The answer to that question names private paths, so this record does not copy it.

Item 21 authorizes the scratch rehearsal. No decision record records that grant alone. [Release Management](../../specs/20260829-release_management.md) owns the rehearsal obligation. The queue records that the engineer later named the public organization `notrucked`. That naming is the coordinator's record, not a second verbatim quote.

Item 22 accepts the reduced integrity draft. [Product Integrity Check](../../decisions/20261012-product_integrity_check.md) records it. The operation is `integrity.workspace.check`, administrator-only through the existing audit read, with `usage-attribution` and `terminal-turn-consistency`. `baca982c` lands the specification. The catalog stories name these invariants. Implementation is [#229](https://github.com/lingkaix/openkit/issues/229), after this prerelease.

Item 23 agrees the telemetry direction and changes no RC4 product code. The deferred work is [#219](https://github.com/lingkaix/openkit/issues/219), [#220](https://github.com/lingkaix/openkit/issues/220), and [#221](https://github.com/lingkaix/openkit/issues/221).

Item 24 puts the directory-publication fix in RC4. `00ffef53` lands the staged rename. [Storage Layout And Record Ownership](../../specs/20260703-storage_layout_record_ownership.md) states when a record directory is canonical. Items 23, 24, 26, and 27 have no decision record.

Item 25 confirms that a stable promotion builds nothing and that the stable tag points at the promoted prerelease's commit. The engineer wrote, verbatim: 「第二十五项我确认，第二十六项换成 openkit.example. 把已经完成工作的agents处理一下，继续推进任务。」 Faithful English translation: "I confirm item twenty-five. For item twenty-six, replace it with openkit.example. Handle the agents whose work is finished, and continue the task." [Release Management](../../specs/20260829-release_management.md) now states that rule. [L6 Story Reorganization](../../decisions/20261012-l6_story_reorganization.md) records the reorganization. Stable publication stays unauthorized.

Item 26 removes the deployment-domain literal from the helper, its guide, and the App-update test fixture. The engineer's words are the item 25 quote. `58c13f4f` makes the helper require `OPENKIT_PUBLIC_HOST` and uses `openkit.example` as the guide's example. `cef2ee8e` uses `openkit.example` in the fixture. `d44d41ec` later removes the helper and its guide. Historical change records stay.

Item 27 removes "cleanup" from story 9 and files an issue for an operator cleanup view. The engineer wrote, verbatim: 「关于第二十七项，同意你的建议，并帮我提交一个issue。关于 dogfood，我们就按照你的建议清理掉。」 Faithful English translation: "On item twenty-seven, I agree with your recommendation, and please file an issue for me. On the dogfood helper, we clean it up as you recommended." `3360b802` renames story 9 to review diagnostics and health and refers to [#226](https://github.com/lingkaix/openkit/issues/226). `d44d41ec` removes the dogfood deploy helper. Specifications still use "dogfooding" for the practice.

Item 28 sets the catalog-story cadence. The engineer proposed, verbatim: 「我认为关于 release cookbook 应该写上一条，就是在一个开发与 released 区间内，L6 story 至少运行一次。另外，根据测试与验证所使用的服务器的状态，story 1 和 story 2(也就是全新安装和更新到预发布的最新版本，两者之间) 二选一运行一次就可以了」 Faithful English translation: "I think the release cookbook should state one rule: within one development-to-release interval, the L6 stories run at least once. Also, depending on the state of the server used for testing and verification, it is enough to run either story 1 or story 2 once, that is, a fresh install or an update to the latest prerelease." The engineer then wrote, verbatim: 「一，采用理解二。二，我同意这一条。三, 我主要是从测试与版本发布需求的 general sense 出发的，没有特别的理由。如果你认为有 不合理，或还可以进一步完善的地方，请提出来。」 Faithful English translation: "One, adopt interpretation two. Two, I agree with this point. Three, I started mainly from a general sense of testing and release needs, and I have no special reason. If you think something is unreasonable, or can be improved, raise it." The engineer then confirmed the five refinements, verbatim: 「我确认这五点。」 Faithful English translation: "I confirm these five points." [Catalog Story Cadence](../../decisions/20261012-catalog_story_cadence.md) records the ruling. `7af42388` lands it in the release owner and the cookbook.

The engineer wrote on 2026-10-13T03:56Z. Faithful English translation: "[The scratch worker-common package page] is not published; I have no way to change its settings. You can first publish a placeholder package, and then I will change the setting. I authorize item thirty-two. Items thirty-one and twenty-nine: clean them up after you complete the publication. On item thirty-three: our update rule is not limited to the previous version. That is, if the server is on an older version, the test updates it from that older version to the latest version awaiting release. You may need to clarify this in the relevant documents."

Item 29. On 2026-10-13 the engineer ruled, in that message, to clean item 29 up after publication. The coordinator reads that ruling as retiring the exact-source procedure. The procedure is retired. [Retire The Exact-Source Update Procedure](../../decisions/20261013-retire_exact_source_update.md) records the ruling. `a908f57f` lands that retirement. A persistent deployment updates only to a published release.

Item 30 is the scratch worker-common package. The coordinator observed that the package already existed with three versions and was private. The coordinator pushed no placeholder. The engineer changed the package to public. The observation at 2026-10-13T04:04:18Z was `public`. The engineer reported item 30 done at 2026-10-13T04:04Z.

Item 31. On 2026-10-13 the engineer ruled to keep the scratch repository and its packages for later use. Faithful English translation: "About item thirty-one, I have decided to keep that repository in this organization; you also do not need to clean it up; we will use it again later." The scratch owner is `notrucked/openkit`. This closeout deletes nothing there.

Item 32 is the publication grant in that same message. Publication Authorization records the grant.

Item 33 is the ordinary story 2 start in that same message. Story 2 runs from any earlier published release to the latest published prerelease. [Story 2 From Any Earlier Release](../../decisions/20261013-story_2_from_any_earlier_release.md) records the ruling, and `40f9d400` lands it. Stable-promotion starting releases stay unchanged.

Items 34 and 35 stay open questions and do not affect rc.4: whether a stable-promotion story 2 may also start from any earlier release, and whether a verbatim engineer quotation is an exception to the English-only rule (LANG-001).

## Publication Authorization

The engineer's mission authorizes the release-candidate outcome. It does not name the exact rc.4 tag or asset set. The relevant mission sentence is, verbatim: 「你接手剩下的任务，按照我们的方法继续向前推进，直到我们发布一个对于用户可用的RC版本。」 Faithful English translation: "You take over the remaining tasks and continue forward by our method until we publish a release candidate that users can use."

On 2026-10-12 the engineer also wrote, in a ruling on the persistent test deployment's Worker image, verbatim: 「第十二项, 等下一个版本，我们马上做一次全面的清点与简单的修复之后，会发布 RC4。RC4 的时候，我们要完全使用openkit系统当中的更新工具进行全面更新。」 Faithful English translation: "Item twelve: wait for the next version. Right after we do a full inventory and simple fixes, we will publish RC4. At RC4, we will do a full update entirely with the update tools in the OpenKit system." That ruling states the intent to publish RC4. It does not authorize an exact tag and asset set.

The proposed publication boundary is exactly `v0.1.0-rc.4` and the controlled asset set, once the release owner's conditions hold. On 2026-10-13 the engineer authorized item 32. Item 32 asked for publication of exactly `v0.1.0-rc.4` on publishing commit P as a non-draft GitHub prerelease. P is the commit that carries this record and the notes input on `main`, and candidate CI must pass on exactly that commit. The prerelease never becomes Latest and creates no GHCR `latest` tag. The asset set is the rc.3 set: the images `openkit-app`, `openkit-worker-common`, and `openkit-worker-runtimes`, each with the exact-version tag, the version-without-`v` tag, and the source-revision tag, plus the attachments `openkit-ops-skill-v0.1.0-rc.4.tar.gz`, `openkit-nanohost-v0.1.0-rc.4-linux-amd64.tar.gz`, `openkit-nanohost-v0.1.0-rc.4-linux-arm64.tar.gz`, and `SHA256SUMS`. Candidate CI on P must pass, and the scratch rehearsal must prove the changed publication jobs. The grant's definition of P applies to the final P. The tag never becomes Latest. No stable release is authorized. No tag or asset in `lingkaix/openkit` is moved, deleted, overwritten, or replaced.

The scratch rehearsal was separately authorized by the engineer in item 21, including deletion of the scratch repository and its packages after the evidence is retained. The public organization is `notrucked`. [Release Management](../../specs/20260829-release_management.md) owns that rehearsal obligation. The rc.3 publication grant does not cover this effect.

## Publication-Path Proof

The last real tag run is rc.3 [run 38093270321](https://github.com/lingkaix/openkit/actions/runs/38093270321). `git diff v0.1.0-rc.3 main -- .github/workflows/ci.yml` shows twenty jobs on both sides and no added or removed job.

These publication jobs changed. `publish-container-images` (Publish image) keeps fourteen step names, and its record step now stores each platform manifest digest. `github-release` (Publish GitHub Release) gains a Checkout step, so its steps go from four to five, and it generates notes from the reviewed input. `verify-release` (Verify published release) keeps seven step names, and it compares the published body through `release-notes.mjs`. No publication job is unchanged, so run `38093270321` is not publication-path proof for image publication, GitHub Release creation, or published-release verification.

`release-preflight` also changed. It gains the step "Check release notes input", so its steps go from three to four. It is not an image, GitHub Release, or published-release verification job.

These jobs are unchanged, and run `38093270321` executed them successfully. That run is their prior real-tag proof.

- `test-image`, Test execution image.
- `container-image-matrix`, Container image release matrix.
- `nanohost-installer`, NanoHost installer fixed-path gate.
- `l0-l2`, L0-L2 static, unit, contract.
- `nano-core-e2e`, L3 NanoCore e2e.
- `workspace-portability-source`, Workspace portability source.
- `workspace-portability-target`, Workspace portability target.
- `smoke`, L5 smoke.
- `build-nanohost-amd64`, Build NanoHost natively on amd64.
- `build-nanohost-arm64`, Build NanoHost natively on arm64.
- `package-release-assets`, Package portable release assets.
- `qualify-nanohost`, Qualify NanoHost.

These jobs are unchanged, and that tag run skipped them. The rc.3 record gives the skip predicates. The run is not execution proof for them.

- `pr-check`, PR lightweight repo check.
- `web-e2e`, L4 Web e2e.
- `app-image-admin-recovery`, L5 app-image stopped-server recovery.
- `smoke-worker-images`, the separate image-smoke matrix.

The changed publication jobs are rehearsed in `notrucked/openkit` from scratch commit `58f7b22597e3284509cd7f8d6441f4879807dcee`. That commit changes only a scratch notes file. Its `.github/workflows/ci.yml` blob equals `main` at `7af42388`.

The first tag push created no workflow run. A later tag push created [run 38214862577](https://github.com/notrucked/openkit/actions/runs/38214862577). At 2026-10-13 02:41:20 UTC, `gh run view` reported attempt 2 as `in_progress`, with no overall conclusion. Its job list reported success for Test execution image, Container image release matrix, NanoHost installer fixed-path gate, Release preflight, L0-L2 static, unit, contract, L3 NanoCore e2e, L5 smoke, both Workspace portability jobs, both native NanoHost builds, Package portable release assets, both NanoHost qualification jobs, and Publish app image. It reported skips for PR lightweight repo check, L4 Web e2e, L5 app-image stopped-server recovery, and the separate image-smoke matrix. Publish worker-common image failed at "Verify public worker base anonymous pull", because the scratch package `notrucked/openkit-worker-common` was created with private visibility. Publish worker-runtimes image was running. The returned job list did not yet include Publish GitHub Release or Verify published release. This observation is interim.

Attempt 1 completed with conclusion `failure`. Its L0-L2 job `114697901596` failed on the Web S7 concurrent-rename case, which timed out at 10207.43 ms against a 10000 ms limit. That timing failure is tracked by [#212](https://github.com/lingkaix/openkit/issues/212). Attempt 1 skipped image publication, GitHub Release creation, and published-release verification. At the interim observation on 2026-10-13T02:41:20Z, attempt 2 had passed L0-L2, but the observations did not yet prove successful execution of all three changed publication jobs.

Attempt 2 of scratch run 38214862577 failed only at "Verify public worker base anonymous pull" because the new organization package was private, as predicted. The engineer made `notrucked/openkit-worker-common` public, observed at 2026-10-13T04:04:18Z. That change is the one-time visibility change described in [First worker-common Publication](../../cookbooks/release.md#first-worker-common-publication). Attempt 3, the failed-job rerun of scratch run [38214862577](https://github.com/notrucked/openkit/actions/runs/38214862577) started at 2026-10-13T04:06:22Z and completed `success` at 04:09:08Z. `Publish worker-common image`, `Publish GitHub Release`, and `Verify published release` all concluded `success`. The scratch release `v0.0.0-scratch.1` is a non-draft prerelease published at 2026-10-13T04:07:24Z. `releases/latest` of the scratch repository answered 404.

Rehearsal result. The failed-job rerun is attempt 3 of scratch run [38214862577](https://github.com/notrucked/openkit/actions/runs/38214862577). It started at 2026-10-13T04:06:22Z and completed `success` at 04:09:08Z. `Publish worker-common image`, `Publish GitHub Release`, and `Verify published release` concluded `success`. The scratch release `v0.0.0-scratch.1` stayed a non-draft prerelease published at 2026-10-13T04:07:24Z. The same-tag rerun of all jobs is attempt 4. It started at 2026-10-13T04:10:07Z on the same tag and the same commit `58f7b22597e3284509cd7f8d6441f4879807dcee`, and it completed `success`. It reused the images. It did not edit the release body or assets. No scratch package version was created after 2026-10-13T02:30:00Z, and no version carries `latest`. `openkit-app`, `openkit-worker-common`, and `openkit-worker-runtimes` each still have three versions. The tagged versions are app `sha256:98e5aed0e9b51c78e457c58f0fe78edb3a1209e2fceb978a89d5b523b31778ed`, worker-common `sha256:091e54fecc6bfa8525d15f62e6a56521e5179ccef2aebe4420a163d199036556`, and worker-runtimes `sha256:43c696dca51846283fbd0268eebff99c5580a40243a00e87d2dbab7514c07881`. Each tagged version carries `sha-58f7b22597e3`, `0.0.0-scratch.1`, and `v0.0.0-scratch.1`. The after-baseline of `lingkaix/openkit`, read at 2026-10-13T05:19:01Z through 05:19:51Z, equals the before-baseline for the rc.2 and rc.3 release fields it recorded, the tag list, and the rc.2 and rc.3 image digests. `latest` stayed absent. The coordinator accepted that result at 2026-10-13T05:21Z.

## Manual-Gate Disposition And Known Issues

The notes input `release-notes/v0.1.0-rc.4.md` carries the user-facing known issues. Those issues are tracked in [#177](https://github.com/lingkaix/openkit/issues/177). The generator writes the manual-gate sentence: L4 Web end-to-end was not required by the automatic tag gate, L6 catalog stories run on this published prerelease after the tag, and this publication does not claim that they passed. The generator writes the R001 sentence: the `linux/amd64` and `linux/arm64` NanoHost archives are installable, but supported Worker Agent execution is not yet release-ready. The R001 runtime gate [#120](https://github.com/lingkaix/openkit/issues/120) stays open, so a stable promotion is not possible.

These open follow-ups stay out of the notes input: [#212](https://github.com/lingkaix/openkit/issues/212) Web S7 CI timeout, [#218](https://github.com/lingkaix/openkit/issues/218) documentation rewrite, [#221](https://github.com/lingkaix/openkit/issues/221) deferred in-sandbox Worker telemetry, [#225](https://github.com/lingkaix/openkit/issues/225) unimplemented stable promotion, and [#229](https://github.com/lingkaix/openkit/issues/229) integrity-check implementation. The notes input includes [#219](https://github.com/lingkaix/openkit/issues/219) NanoCore tracing, [#220](https://github.com/lingkaix/openkit/issues/220) NanoHost tracing, [#222](https://github.com/lingkaix/openkit/issues/222) Knowledge search, [#223](https://github.com/lingkaix/openkit/issues/223) power-loss durability, [#224](https://github.com/lingkaix/openkit/issues/224) unchanged `thread.json` rewrites, [#226](https://github.com/lingkaix/openkit/issues/226) operator cleanup visibility, [#227](https://github.com/lingkaix/openkit/issues/227) image-import staging, and [#230](https://github.com/lingkaix/openkit/issues/230) the App update helper's missing update path.

A later follow-up, [#230](https://github.com/lingkaix/openkit/issues/230), records that an App update does not replace the host-installed update helper, so the rc.4 helper fix does not automatically reach an existing deployment. The issue records this as non-blocking for rc.4.

## Post-Tag Plan

Catalog story 2 (`persistent-deployment-prerelease-update`) ran on the persistent test deployment. That deployment was running `v0.1.0-rc.3`. The actor was Pi, `gpt-6-astra`, as the coordinator's dispatch identifies. The actor stopped before `app-update.prepare` and made no deployment change. Two independent judges, Grok 4.7 and Codex `gpt-6.1-sol`, each returned `inconclusive` because the required update receipt was never witnessed. The cause is [#232](https://github.com/lingkaix/openkit/issues/232). Friction and suggestions went to [#233](https://github.com/lingkaix/openkit/issues/233) through [#239](https://github.com/lingkaix/openkit/issues/239) and the existing [#158](https://github.com/lingkaix/openkit/issues/158), [#230](https://github.com/lingkaix/openkit/issues/230), and [#197](https://github.com/lingkaix/openkit/issues/197). Worker qualification was not run on rc.4. The deployment stays on rc.3. The engineer directed rc.5 instead. The release cycle's catalog stories and Worker qualification continue on rc.5. Item 29 is retired in `a908f57f`. Item 31 keeps the scratch repository and its packages.

## Results

The [compact release record](../../specs/20260829-release_management.md#compact-release-record) names these row headings. Story 2 is the only catalog story this prerelease ran. Worker qualification did not run. No other catalog story was scheduled.

| Subject | Published identity | Deployment digests and time window | Verdict | Classification | Private evidence alias and digest |
| --- | --- | --- | --- | --- | --- |
| Catalog story 2, `persistent-deployment-prerelease-update` | `v0.1.0-rc.4` on `33ef34436fbedb2e8249f2826ddc5c6cad5f91d2` | The running App image observed before the run was `sha256:f1c42ed6cc9430fd4173350c0aced34aa2bfabd6d6e8f6a96a0f842ae6e63586`, the published `v0.1.0-rc.3` App image index digest. The retained after-reads do not include a second App image inspect; no update was started. NanoHost's runtime identity and connection generation were unchanged before and after. The run did not record a NanoHost binary digest; that gap is disposed as NanoHost being outside the story's effect, because no update was started. The actor run lasted from 2026-10-13T06:46:30Z to 2026-10-13T06:49:05Z, and the after-reads ended at 2026-10-13T06:56:35Z. The report gives no baseline-read clock time | `inconclusive` | The required update receipt was never witnessed. The cause is [#232](https://github.com/lingkaix/openkit/issues/232) | Alias `retained-rc4-story2`. The evidence package manifest SHA-256 is `08c11622f4314af9a3779470f1150509adab0cc61e4794142dcffb4b63c5e1ba`. Judge A verdict SHA-256 is `32b6cfb7501c469b7cf70eb53543f2d0875b890991ec13f5a2762e39efcd32f3`. Judge B verdict SHA-256 is `8d53b7cd4513d7f279318594cf3a96cf8d1e8a70e7cfc0535ac4942ad2074d13` |
| Worker qualification A to D | `v0.1.0-rc.4` on `33ef34436fbedb2e8249f2826ddc5c6cad5f91d2` | Not run. The deployment stays on rc.3 | Not run | The engineer directed rc.5 instead. Qualification continues on rc.5 | Not applicable |

## Tag Workflow Run

[Tag run 38353473628](https://github.com/lingkaix/openkit/actions/runs/38353473628) is event `push` on head `33ef34436fbedb2e8249f2826ddc5c6cad5f91d2`. `gh run view` returned conclusion `success`. It was created at 2026-10-13T05:50:30Z and updated at 2026-10-13T06:25:53Z. These jobs were skipped: `PR lightweight repo check`, `L4 Web e2e`, `L5 app-image stopped-server recovery`, and `Smoke ${{ matrix.id }} (${{ matrix.platform }})`. Every other job in that run concluded `success`.

The [GitHub Release](https://github.com/lingkaix/openkit/releases/tag/v0.1.0-rc.4) is tag `v0.1.0-rc.4`, `isDraft` false, and `isPrerelease` true. It was published at 2026-10-13T06:24:09Z. It has these assets.

| Asset | Bytes | SHA-256 |
| --- | --- | --- |
| `openkit-nanohost-v0.1.0-rc.4-linux-amd64.tar.gz` | 35,111,425 | `6f7b507240a76fe116e5489843f68637b2ac21f6b41c32bae0554a8ec35f5be8` |
| `openkit-nanohost-v0.1.0-rc.4-linux-arm64.tar.gz` | 33,080,102 | `d1c6dcf66916a89893f9fef68c62e0213da8a00ad1241bd0be49264cd30205a7` |
| `openkit-ops-skill-v0.1.0-rc.4.tar.gz` | 202,203 | `dd0ce2c359ddfe6b6a48a49588e44a23caa040e9ad903120f2944a8c48340817` |
| `SHA256SUMS` | 331 | `07d46ce550985c28aa3b69b28975679bb82daa575689ec262a92fdc879f5b85c` |

The release body records these image index digests and platform digests.

| Image | Index digest | `linux/amd64` | `linux/arm64` |
| --- | --- | --- | --- |
| `ghcr.io/lingkaix/openkit-app` | `sha256:e322434a5d04baa17daee9d586c89590a288a932c0760da6783bd78fc5f11552` | `sha256:2a8741d1490e304c3296bca4b7b5952d39d2114b27a1d6e10ab80d4ef40e9abc` | `sha256:43dd9fae69421e7f1a7c5895796463491056229b0504460654641bfa3a154104` |
| `ghcr.io/lingkaix/openkit-worker-common` | `sha256:838f9bc023eea222b0190a405b569d64263fe0160916f51d9fd5b00d3a872e1d` | `sha256:f684763f295d1ca8dc30762149c74ac52bf65a31836c510d4a8d5917059c8eeb` | `sha256:0b94eb8c52fed75f8b941c7bb14016f2b12c57156eca3fcdd4c0a5612bb5d934` |
| `ghcr.io/lingkaix/openkit-worker-runtimes` | `sha256:c0ef412f40b852f47fba40d0c35e7add21fc35155f1e5a0d27d443225b152216` | `sha256:4786a3af8fe83665a6d8e9acbffa28ab0f3479aab7ae4a4c4793d821da6c62a5` | `sha256:de149b55e971987cd49daa1b9a6a38dcf96e7bc02be959cc35c558c763bab4b8` |

## Independent Post-Publication Verification

The verifier role is reviewer, under [the reviewer contract](../../roles/reviewer.md). The coordinator's dispatch identifies the model family as Codex `gpt-6.1-sol`. The verifier did not produce the release.

Round 1 checked the published rc.4 artifacts. Check 1, tag and commit, passed. Check 2, the tag workflow, passed. Check 3, the GitHub Release and body, passed. Check 4, the attachments, passed. Check 5, the images, platforms, anonymous access, and `latest`, passed. Check 6, earlier releases untouched, was partial. Check 7, the registry HTTP fallback, was not needed. Check 8, visibility, passed. The round 1 verdict was `not verified` because of one P2 evidence gap: the rehearsal baseline records rc.2 and rc.3 tag name, prerelease flag, publication time, and body digest, and it records neither draft state nor the asset set.

Round 2 closed that gap through provenance-checked committed records and fresh downloaded bytes. Its verdict is `VERDICT: verified`. The lesson is that a rehearsal baseline records each earlier release's draft state and full asset metadata.

## Verification Evidence

The tag run, the GitHub Release read, the rehearsal reports, and the two independent verification rounds supply the evidence above. This writer did not rerun publication or the catalog story. On the tree that contains this closeout, `release-notes/v0.1.0-rc.5.md`, and the rc.5 record, these checks passed: `node scripts/validate-spec-lifecycle.mjs` printed `Validated spec lifecycle metadata.` and exited 0; `node scripts/validate-story-schema.mjs` printed `Validated story schema (10 stories).` and exited 0; `node scripts/validate-doc-model.mjs` printed `Validated documentation model (471 documents).` and exited 0; `node scripts/generate-doc-index.mjs --check` printed `Documentation index is current.` and exited 0; `node scripts/validate-test-governance.mjs` printed no output and exited 0; `node scripts/release-notes.mjs --check --repo-root . --tag v0.1.0-rc.5` printed `Release notes input passed for v0.1.0-rc.5.` and exited 0; `node --test tests/release-notes.test.mjs` reported 7 pass, 0 fail, and exited 0. Before the commit, `git diff -U0 | rg "^\+" | rg "[\x{4e00}-\x{9fff}]"` printed no output.

## Closeout

`v0.1.0-rc.4` is published from `33ef34436fbedb2e8249f2826ddc5c6cad5f91d2` and independently verified for the assigned publication checks. Story 2 did not pass. Worker qualification did not run. Both continue on rc.5. Item 29 is done in `a908f57f`. Item 31 keeps `notrucked/openkit` and its packages. Items 34 and 35 stay open. The lifecycle is `verified`. This records the independent publication verdict. It does not accept this writer's documentation diff, and it does not close the R001 runtime gate or a stable release.

Raw complexity for `v0.1.0-rc.3` through P: `git diff --shortstat v0.1.0-rc.3 33ef34436fbedb2e8249f2826ddc5c6cad5f91d2` reported 88 files changed, 6,865 insertions, and 6,809 deletions. Eleven specification documents changed, and no Core document changed. Six decision records changed. No new product durable registry is claimed from that name inventory. These figures exclude this closeout.
