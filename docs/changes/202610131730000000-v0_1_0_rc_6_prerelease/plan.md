---
type: change-plan
status: in-progress
date: "2026-10-14"
started: "2026-10-14"
branch: main
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

### Intent Revision 2 — 2026-10-14

Source: the engineer's message to the coordinator on 2026-10-14. The coordinator had proposed six goals for the next release. Item 3 was one active Turn per Thread inside a Sandbox instead of one active Turn per Sandbox, so that the four Worker runtime groups can run in parallel ([#204](https://github.com/lingkaix/openkit/issues/204)). Item 6 was the release and deployment fixes [#233](https://github.com/lingkaix/openkit/issues/233), [#243](https://github.com/lingkaix/openkit/issues/243), [#239](https://github.com/lingkaix/openkit/issues/239), [#230](https://github.com/lingkaix/openkit/issues/230), the timing-dependent tests [#244](https://github.com/lingkaix/openkit/issues/244), [#212](https://github.com/lingkaix/openkit/issues/212), [#231](https://github.com/lingkaix/openkit/issues/231) and [#178](https://github.com/lingkaix/openkit/issues/178), and the recommended [#238](https://github.com/lingkaix/openkit/issues/238) and [#234](https://github.com/lingkaix/openkit/issues/234). For [#243](https://github.com/lingkaix/openkit/issues/243) the coordinator recommended option (b), a changed scenario A, over option (a), retained Pi native-context evidence.

The engineer's words, quoted verbatim:

> 3&6: 我同意你在六当中提到的那些修复目标。我们应该把三和六当中的问题都修复了，然后发布 RC6。目标是清除之后版本发布的障碍。现在的版本发布速度特别的慢，而且充满了各种 blocker，需要额外的授权与使用外部的agent进行辅助的验收、发布和部署更新。 考虑到接下来我们的发布版本会非常的密集，一天可能会有两到三个发版，因此我们需要提升这个从验收到发布，再到部署更新的速度和工作量。 好，这部分工作，我认为你已经可以分派下去开始进行了。

Faithful English translation: "3 and 6: I agree with the fix goals you named in item 6. We should fix the problems in both item 3 and item 6, and then publish RC6. The goal is to clear the obstacles to later releases. Releases are now very slow and full of blockers, and they need extra authorization and external agents to help with acceptance, publication and deployment updates. Because our releases will be very frequent from now on, possibly two or three releases a day, we need to improve the speed and reduce the work from acceptance to publication to deployment update. Good, I think you can already dispatch this work and start it."

Outcome: `v0.1.0-rc.6` carries the [#242](https://github.com/lingkaix/openkit/issues/242) fix, concurrent Worker Turns across distinct Threads ([#204](https://github.com/lingkaix/openkit/issues/204)), and the item 6 fixes. The candidate `67bf536b` is not published as rc.6.

Acceptance observations: release, deployment update, catalog story and Worker qualification run to completion on rc.6 without an inconclusive result caused by a known instrument or product gap; the four Worker runtime groups run concurrently; the work and elapsed time from candidate to updated deployment fall enough to support two or three prereleases a day, with less engineer authorization work and less external-agent assistance per release.

Effect boundary: the engineer authorized dispatch and local work. Tag push, workflow dispatch, publication, push to `origin`, and changes to the persistent test deployment remain unauthorized until the engineer grants them. A change to a reserved gate in [Release Management](../../specs/20260829-release_management.md), such as per-tag publication authorization, needs an explicit engineer decision.

The engineer gave the other four goals (Chat Mode, retrieval, Artifacts, Workspace data view) to later work before `v0.1.0`. They are outside this plan.

### Intent Revision 3 — 2026-10-14

Source: the engineer's message to the coordinator on 2026-10-14, after the WP4 proposal. The engineer's words, quoted verbatim:

> 对于你上一轮新让我决定的八条，我都按照你的建议给你 yes。不过关于第七条，你可否向我再详细的解释一下一九三、二四零和二二五分别都是什么问题，会造成什么样的影响，为什么我们可以推后？ 另外，我还需要补充一点，当前我们所工作的这台机器是专门用于 OpenKit 开发的机器，因此你可以在上面自由的安装与部署任何与 OpenKit 相关的库、依赖、软件和开发包。 你可以把这台机器作为开发与测试的机器，并正好在这台机器上新安装一个 OpenKit 系统，来跑一遍我们的 L6 story 1. 这台机器是X86架构的, 一旦在本机器上开发与测试完成之后，你可以使用 SSH a1 （arm64，nanocore 通过 dokploy 部署在容器中。）作为 staging 服务器，部署最新的版本，用作额外的使用和测试等（我们也会把它作为我们的 dogfooding 服务器。我们会逐渐的把我们所有的维护和开发本系统的工作都搬迁到这台服务器上的 OpenKit 系统内）。 而SSH a2是我们的线上生产服务器。

Faithful English translation: "For the eight items you newly asked me to decide last round, I say yes to all of them as you recommended. But for item 7, can you explain in more detail what #193, #240 and #225 each are, what effect they have, and why we can defer them? Also, one addition: the machine we are working on is dedicated to OpenKit development, so you may freely install and deploy any OpenKit-related library, dependency, software and development package on it. You may use this machine for development and testing, and install a new OpenKit system on it to run our L6 story 1. This machine is x86. Once development and testing on this machine are complete, you may use SSH `a1` (arm64; NanoCore is deployed in a container through Dokploy) as the staging server and deploy the latest version to it for additional use and testing. (We will also use it as our dogfooding server. We will gradually move all our work of maintaining and developing this system into the OpenKit system on that server.) SSH `a2` is our production server."

Outcome change: the engineer accepts the eight WP4 decisions as recommended; the rulings section records them.

Effect boundary change:

- The development machine (x86_64) may receive any OpenKit-related library, dependency, software and development package. The coordinator may install a new OpenKit system on it and run catalog story 1 there.
- After development and testing pass on the development machine, the coordinator may deploy the latest version to `a1`, the arm64 staging, dogfooding and persistent deployment. Other services on `a1` are outside this authorization.
- `a2` is the production server. This revision authorizes no action on `a2`.
- Push to `origin` stays unauthorized until the engineer grants it.

### Intent Revision 4 — 2026-10-14

Source: the engineer's messages to the coordinator on 2026-10-14, after the coordinator explained #193, #240 and #225 and asked for five confirmations. The engineer's words, quoted verbatim:

> 关于一九三，我同意关闭。 二四零和二二五在发布第一个稳定版的时候实现。 关于 story 1，虽然本机器上有源码，但是你可以不使用源码，从公开仓库和 release 来完成 story 1 的操练，因此不要启动虚拟机。我们正好要在这台机器上部署一套 OpenKit，因此我们就在机器上面来做这套操作。 需要我确认的，是的，之前 A2 是被用来进行测试部署，现在我们会把它当做一个稳定的线上服务器，转而使用 A1 来作为 staging server。 关于A1，是的，我们需要在这个新版本发布之后，在A1上做一次手动的更新。 RC6算在授权里。 另外，我给你永久的授权，可以 push 代码到远程的主分支上。现在你可以提交这两份 plan。 还有新的一轮你提交给我的问题，我同意你的这个搜索引擎的设计。我们先做一个最简单的实现，能够把最基本的功能提供给客户。至于 Pi AI 没有 embedding 接口的问题，等到我们实现多模态检索的时候，再来处理。 另外，你作为 coordinator 时，尽量少介入具体的任务，以节省你的上下文窗口，把任务都分派下去。同时，由于你在使用 Opus 5.5 作为模型， 因此，当你作为 coordinator 的时候，不允许你再调用其他任何 Claude 家族的模型作为具体工作的 workers，除非得到我的明确授权。

> 已经正在使用 Claude 模型进行的任务不用停下来。我是说以后。

Faithful English translation: "On #193, I agree to close it. #240 and #225 are implemented when we publish the first stable release. On story 1: although this machine has the source, you can avoid the source and complete the story 1 exercise from the public repository and the release, so do not start a virtual machine. We want to deploy an OpenKit on this machine anyway, so we do this on the machine itself. On what you asked me to confirm: yes, `a2` was used earlier for the test deployment; now we will treat it as a stable production server and use `a1` as the staging server instead. On `a1`: yes, after this new version is published, we need one manual update on `a1`. rc.6 is included in the authorization. Also, I give you a permanent authorization to push code to the remote main branch. You may now commit these two plans. On your new round of questions: I agree with your retrieval engine design; we first build the simplest implementation that gives customers the most basic functions; the missing pi-ai embedding interface waits until we implement multimodal retrieval. Also, as the coordinator, take as little part in concrete tasks as possible to save your context window, and dispatch the tasks. Because you use Opus 5.5, as the coordinator you may not call any other Claude-family model as a worker for concrete work without my explicit authorization." Second message: "Tasks already running on Claude models need not stop. I meant from now on."

Effect boundary change:

- Push to `origin/main` has a standing authorization.
- The standing prerelease publication authorization covers `v0.1.0-rc.6`.
- Catalog story 1 runs on the development machine from the public repository and the published release assets, without use of the local source and without a virtual machine. The installation stays as this machine's OpenKit deployment.
- `a2` was the earlier persistent test deployment and is now the stable production server. `a1` is the staging server. After rc.6 is published, the coordinator updates `a1` once by the manual operator path.
- [#193](https://github.com/lingkaix/openkit/issues/193) is closed as superseded. [#240](https://github.com/lingkaix/openkit/issues/240) and [#225](https://github.com/lingkaix/openkit/issues/225) are required before the first stable release.
- The coordinator dispatches concrete work and dispatches no Claude-family worker without explicit engineer authorization.

## Preparation Checkpoint — Rewritable

This checkpoint is rewritable and is not authority.

| Field | Current fact or pending observation |
| --- | --- |
| Intended tag | `v0.1.0-rc.6`, a non-draft prerelease that never becomes GitHub Latest and never creates or changes a GHCR `latest` tag |
| Controlled asset set | The rc.5 set, with the tag replaced by `v0.1.0-rc.6`, as detailed below |
| Publication authorization | Standing prerelease authorization, which covers rc.6 (Intent Revision 4); it applies after its Release Management amendment lands and its conditions hold |
| Tested commit T and publishing commit P | Not fixed. Intent Revision 2 supersedes the candidate `67bf536b`, which passed candidate CI and is not tagged. P will carry the Intent Revision 2 work packages, this record and `release-notes/v0.1.0-rc.6.md` |
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

## Work Packages For Intent Revision 2 — Rewritable

The coordinator is the primary of this plan. Each package runs in its own Git worktree on its own local branch from `67bf536b`. One writer owns each path. A package that needs a path owned by another package stops that part and reports to the primary.

| Package | Scope | Role and dispatch | Writable paths |
| --- | --- | --- | --- |
| WP1 concurrent Worker Turns | [#204](https://github.com/lingkaix/openkit/issues/204) under the accepted concurrent-Turn target, and [#231](https://github.com/lingkaix/openkit/issues/231) | Builder; Pi with `openai/gpt-6.1-sol`, high thinking | `apps/nanocore/src/**` except the WP2 paths; `packages/worker-shim/src/**` except the WP3 file; `packages/config-schema/**`; `apps/nanohost/**` except `apps/nanohost/src/nanocore_session.rs`; draft amendments of `docs/specs/20260703-runtime_scheduling_scale.md`, `docs/specs/20260802-nanohost_runtime_and_transport.md` and `docs/specs/20260703-durable_scheduler_design.md`; affected app and package guides |
| WP2 App update path | [#233](https://github.com/lingkaix/openkit/issues/233), [#239](https://github.com/lingkaix/openkit/issues/239), [#230](https://github.com/lingkaix/openkit/issues/230), [#238](https://github.com/lingkaix/openkit/issues/238), [#234](https://github.com/lingkaix/openkit/issues/234), [#184](https://github.com/lingkaix/openkit/issues/184) | Builder; Codex with `gpt-6.1-sol`, high reasoning | `apps/nanocore/src/app-update/**`, `apps/nanocore/src/diagnostics/**`, the operation definitions and implementations of the new App-update reads, `packages/app-api-schemas/**`, `scripts/docker/app-update-helper*.py`, `skills/openkit-ops/**`, the administrator CLI `doctor` source, Web diagnostics files, `docs/specs/20260910-app_update_delivery.md`, `docs/specs/20260910-agent_operator_skill.md`, only the helper-suite step in `.github/workflows/ci.yml`, `tests/package-release-assets.test.mjs` for the helper fixture and its archived-bytes assertion, and `tests/openkit-skill-interface.test.mjs` for the `app-update.preflight` inventory entry and its empty-input mapping assertion (both granted 2026-10-14 on WP2's request) |
| WP3 deterministic tests | [#244](https://github.com/lingkaix/openkit/issues/244), [#212](https://github.com/lingkaix/openkit/issues/212), [#178](https://github.com/lingkaix/openkit/issues/178) | Builder; Grok Build with `grok-4.7`, high | The test module of `apps/nanohost/src/nanocore_session.rs`, `apps/web/src/screens/chat/chat.test.tsx`, `packages/worker-shim/src/adapters/codex.test.ts` |
| WP5 release cadence implementation | The eight WP4 decisions that the engineer accepted on 2026-10-14, with their owner amendments and a decision record | Builder; Codex with `gpt-6.1-sol`, high reasoning; dispatched 2026-10-14 from `67bf536b` on `rc6/wp5-release-cadence-impl` | Phase 1: `docs/specs/20260829-release_management.md`, the CI and release gate sections of `docs/specs/20260529-test_strategy.md`, `docs/specs/20260909-persistent_deployment_acceptance.md`, projection alignment in `docs/specs/20260529-l6_story_acceptance.md`, new files under `docs/decisions/`, `docs/cookbooks/release.md`, `docs/cookbooks/persistent-live-acceptance.md`, `scripts/release-notes.mjs` and new `scripts/release-*.mjs`, `tests/support/release-round*`, `tests/README.md`, `tests/support/README.md`, `tests/release-*.test.mjs`, and test and verify entries in the root `package.json`. Phase 2, after WP2 lands: `.github/workflows/ci.yml`, `docs/specs/20260910-app_update_delivery.md`, and `skills/openkit-ops/**` where a projection must change |
| WP4 release cadence proposal | A measured proposal for two or three prereleases a day, including the [#243](https://github.com/lingkaix/openkit/issues/243) choice and [#193](https://github.com/lingkaix/openkit/issues/193), [#225](https://github.com/lingkaix/openkit/issues/225), [#241](https://github.com/lingkaix/openkit/issues/241) | Consultant, stance guide, gap capability and independence; Codex with `gpt-6-astra`, xhigh reasoning | NONE; the proposal returns in the report |

The primary owns this record and `release-notes/v0.1.0-rc.6.md`. Each package receives independent review from a different model family before integration. Release-procedure and runner changes wait for the engineer's decisions on the WP4 proposal.

## Pending Engineer Decisions

This plan needs the following decisions from the engineer.

This record does not invent a ruling.

- The WP1 capacity model, if it amends an accepted owner beyond the accepted concurrent-Turn target, is pending.

## Engineer Rulings For Intent Revision 2

On 2026-10-14 the engineer set the default active-Turn bound per Sandbox, verbatim: "Active turn 的 default value 我们要设置的高一些，比如二十。这主要考虑到我们是把沙盒当做是一个 半永久的agents的长期工作环境。 特别是在高 mode 下面，Coordinator 可能会同时拉起很多任务，同时在一个沙盒环境当中执行。因此，除了资源局限的考虑之外，我们应尽可能的放宽这个并行限制。"

Faithful English translation: "Set the active-Turn default high, for example twenty. We treat the Sandbox as a semi-permanent, long-term work environment for agents. Especially in Goal mode, the Coordinator may start many Tasks at once in one Sandbox. So, apart from resource limits, we should relax this concurrency limit as much as possible."

The default is 20 active Turns per Sandbox, as authored configuration. Resource limits remain the binding bound. This replaces the coordinator's proposed default of four. The coordinator forwarded the ruling to WP1 on 2026-10-14. Revisit when a measured host cannot sustain the default within its resource limits.

WP4 returned its proposal on 2026-10-14. On 2026-10-14 the engineer accepted its eight decisions as the coordinator recommended them (Intent Revision 3 quotes the words):

1. A standing publication authorization for prereleases replaces per-tag authorization, together with a release-blocker label policy. Stable publication stays an engineer-reserved gate.
2. The test-deployment update after publication is automated. Catalog stories 1 and 2 move to a release-cycle and change-driven cadence; story 2 stays required on the prerelease that a stable release promotes.
3. CI stops running the unit suites twice; the coverage run replaces the separate unit run.
4. Worker qualification runs automatically and concurrently, sixteen Turns per prerelease.
5. [#243](https://github.com/lingkaix/openkit/issues/243) takes option (b) with a benign exact-reply prompt.
6. The compact release record is generated, and [#241](https://github.com/lingkaix/openkit/issues/241) gets a narrow machine-readable manifest.
7. [#193](https://github.com/lingkaix/openkit/issues/193) and [#240](https://github.com/lingkaix/openkit/issues/240) are deferred from the cadence-critical path. [#225](https://github.com/lingkaix/openkit/issues/225) is required before the first stable release.
8. The release-gate CI runs on every push to `main`.

These decisions take effect through amendments to [Release Management](../../specs/20260829-release_management.md) and its projections. Until those amendments land, the current owner text stays binding, including per-tag publication authorization. After the coordinator explained decision 7, the engineer changed it (Intent Revision 4): #193 is closed as superseded, and #240 and #225 are required before the first stable release. The first App update to rc.6 on `a1` uses the manual operator path; the automated path starts with the next prerelease.

## Publication Authorization

The mission text does not name `v0.1.0-rc.6` or this asset set.

On 2026-10-14 the engineer accepted a standing publication authorization for prereleases (WP4 decision 1) and stated that it covers `v0.1.0-rc.6` (Intent Revision 4). The tag is published only after the Release Management amendment that defines the grant lands and its conditions hold for this tag: reviewed work packages merged into `main`, a successful candidate gate on exact P, and no open release blocker.

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
