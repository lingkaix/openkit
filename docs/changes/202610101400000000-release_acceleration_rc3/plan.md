---
type: change-plan
status: in-progress
date: "2026-10-10"
branch: rc3-docs
---
# Release Acceleration And v0.1.0-rc.3

This record preserves the accepted source intent, bounded release acceleration work and eventual rc.3 verification evidence. It adds no design authority or authorization; [Foundation](../../core/foundation.md), [Architecture](../../core/architecture.md), [Release Management](../../specs/20260829-release_management.md), [Persistent Deployment Acceptance](../../specs/20260909-persistent_deployment_acceptance.md), [Test Strategy](../../specs/20260529-test_strategy.md) and their linked owners govern the work. [Release Acceleration](../../decisions/20261010-release_acceleration.md) records the accepted ruling, and the [Release Cookbook](../../cookbooks/release.md) supplies its procedure.

## Intent Epoch 1 — 2026-10-10

**Source and outcome.** Reduce unnecessary acceptance and publication latency without weakening product proof, attribution, retained-data continuity or publication integrity. Finish rc.2 under its current process, then implement A, B, C, E and F and publish rc.3 under the amended process. The task brief explicitly names this initial entry Intent Epoch 1; it is append-only under [Change Execution](../../change-execution.md).

The engineer's question of 2026-10-10, quoted verbatim:

> 我发现从 RC one 到我们现在基本上快把 RC two 做完，整个的验收过程超过了八个小时。这中间除了你对 CI 的一个 fix 之外，我们只是在更新一些文档。你认为这个时间长度正常吗？中间的这些工作与流程都是必要的吗？我们能否优化 验收与发布速度呢？

Faithful English translation: "I noticed that from RC one to now, when we have almost finished RC two, the whole acceptance process has taken more than eight hours. Apart from your one CI fix, we have only been updating some documentation. Do you think this duration is normal? Were all the work and procedures in between necessary? Can we optimize acceptance and release speed?"

The engineer's decision, quoted verbatim:

> 采纳你的 A 到 F 的全部建议。我授权给你去进行改进。你可以调起独立的 agents 作为你 coordinator的 advisor、builder、reviewer 等角色。按照你的建议把已经几乎完成了RC2按照当前的流程走完, 然后把这些改进做完(包括对发布的 Cookbook 和 Guideline 的update) 作为 RC3，按照新的流程发布。

Faithful English translation: "I adopt all your recommendations A through F. I authorize you to make the improvements. You may call independent agents in roles such as advisor, builder, and reviewer for you as coordinator. As you recommended, finish the almost-completed RC2 under the current process, then complete these improvements, including updates to the release Cookbook and Guideline, as RC3 and publish it under the new process."

After the consultant found that the deployment admits one active Worker Turn rather than four, the engineer selected, verbatim:

> 推迟到 rc.3 之后（推荐）

Faithful English translation: "Defer until after rc.3 (recommended)."

The selected option keeps A, B, C, E and F in rc.3, runs the four runtime groups sequentially, permits overlap only for work holding no Worker, and defers real concurrency to [issue #204](https://github.com/lingkaix/openkit/issues/204) with a fix suggestion. [Runtime Scheduling Scale](../../specs/20260703-runtime_scheduling_scale.md) owns the single-active-Turn boundary; the consultant also observed the executable `CHECK (max_active_turns = 1)` constraint. The source option and consultant finding explain the decision; they are not additional quoted engineer words.

**Proposal summary and correction.** The coordinator proposed product-input counting (A), pre-tag publication rehearsal (B), #200 correction and candidate CI reuse (C), runtime concurrency (D), compact records with generated verdicts (E), and one parameterized runner (F). The engineer adopted the proposals and subsequently deferred D after the consultant found its premise wrong. B is satisfied by a successful real tag run for unchanged publication jobs; changed jobs require different-owner rehearsal with separate scratch-effect authorization. The coordinator's corrected F instruction at 13:50Z selects public `tests/support/release-round.mjs`, with every deployment-specific value in private parameters and complete evidence kept private; the tests builder documents exact subcommands and fields in `tests/README.md`.

**Non-negotiables and exclusions.** Preserve retained data, protected configuration and credential custody under their owners. Keep exactly the rc.2 controlled asset set and immutable release identities; never move, delete, overwrite or replace published tags/assets. Stable release and any other prerelease tag remain unauthorized. Prerelease GHCR latest and GitHub Latest stay untouched. Visibility mutation and scratch-target/package creation need separate engineer authorization. Product Worker concurrency is deferred to issue #204; this plan performs no capacity, scheduler or durable-lifecycle change for D. Keep all 21 scenarios, expected outcomes, deciding records and the no-retry rule; changing the frozen checklist section still starts a fresh count under A.

**Acceptance.** Two consecutive complete clean rounds on exact tested commit T and a frozen scenario set meet the amended Release Exit Criterion, with every observed defect classified and linked and other blockers preserved. Publication selects T or a later main commit P only with exit 0 and retained classified output from `node scripts/release-product-inputs.mjs --tested <T> --publishing <P>`. P has its own successful completed candidate workflow dispatch selecting release-gate or full. Each eligible tag job either records exact-commit same-workflow/latest-attempt success or runs its tests; all other tag jobs still run. Publication-path proof and the public runner's admission are recorded before they decide acceptance. Compact verdicts retain full private evidence and independent checks for every non-pass or undecidable row, with scenario-owned independent proof unchanged. Published bytes are rebuilt from P and verified separately, with no identity claim against the tested deployment.

**Effect boundary and authorization.** The engineer's source decision authorizes exactly `v0.1.0-rc.3` and the same controlled asset set as `v0.1.0-rc.2` once the amended Release Exit Criterion is met. Other applicable release gates and effect-specific authority remain required. The source's "RC3" is applied to that exact prerelease identity by the supplied coordination brief, not expanded into stable or rc.4 authority. Operator deployment, Provider consumption, GitHub scenario writes and Pending Request decisions keep their existing specific grants; role assignment grants none of those effects.

**Completion truth.** Opening this record proves no completed implementation, counted round, candidate CI, tag run or publication. Pending sections are filled only from actual artifacts and named execution results; producer reports alone do not accept the owner amendments or instrument.

## Preparation Checkpoint — Rewritable

| Field | Current fact or pending observation |
| --- | --- |
| Intended tag and asset set | `v0.1.0-rc.3`; same controlled set as rc.2, detailed below |
| Publication authorization | Recorded in Intent Epoch 1; conditional on the amended Release Exit Criterion and remaining release obligations |
| Tested commit T / publishing commit P | PENDING — full commits after implementation/review and candidate selection |
| Classified non-product diff | PENDING — complete T-to-P classification, command result and exit status; unknown paths and symlinks/gitlinks are product |
| Candidate CI proof | PENDING — exact-P workflow-dispatch run, release-gate/full selection, completed result and latest-attempt job proofs |
| Visibility posture | PENDING — fresh repository/package observations; no visibility mutation authorized |
| Frozen checklist identity | PENDING — the First-Release Scenario Set section blob at rc.3 tested commit T, frozen before its first counted round, plus the private non-secret input revision |
| Known-defect dispositions | PENDING — pre-round defect references, blockers and accepted-external boundary evidence; no inherited failure is silently waived |
| Maintained runner | Public `tests/support/release-round.mjs`; PENDING — admitted commit/digest and tests-guide interface, plus private per-round parameter digests |
| Publication-path proof | Designated rc.2 real tag run; PENDING — run/job evidence and unchanged publication-job comparison since `d3423328` |
| Method and frontier | Draft the owner/guide amendments, integrate bounded builders and obtain independent review before freezing and running rc.3 |
| Material unknowns | Final implementation and instrument admission, hosted #200 correction, candidate identity/CI, actual rc.2 publication proof, round results and publication verification remain unobserved in this record |
| Next Action | Coordinator integrates the owner/guide diff with builder artifacts and obtains independent actual-diff review; expected artifact is a coherent admitted candidate, and failed boundary checks reframe dependent work before a round or tag |

The rc.3 frozen checklist identity is the First-Release Scenario Set section blob at the rc.3 tested commit. Moving Record And Classify Every Round from level three to level two removes it from that frozen section, and the publishing-source sentence edit within Deployment Through The Maintained Exact-Source Procedure also changes the section's bytes. Keep both changes and freeze the new section blob before rc.3's first counted round. Later changes to the record format outside that section are not scenario-set changes; the 21 scenarios' inputs, expected outcomes and deciding records are unchanged. Changes to the frozen section still reset the count under the release owner.

### Expected Bundle

- Every release-enabled catalog image with exact-version, version-without-v and source-revision tags and digests; prerelease latest remains unchanged.
- `openkit-ops-skill-v0.1.0-rc.3.tar.gz` containing the complete operations Skill, generated administrator executable and repository license.
- `openkit-nanohost-v0.1.0-rc.3-linux-amd64.tar.gz` and `openkit-nanohost-v0.1.0-rc.3-linux-arm64.tar.gz` under the NanoHost owner's target and qualification contract.
- `SHA256SUMS` over those three archives, yielding exactly four controlled attachments on one non-draft GitHub prerelease with digests, gate evidence, visibility, checksums and NanoHost limitation.

### Work Packages And Review

These packages describe the accepted work, not a mandatory role order or frozen dispatch queue. The coordinator assigns exact disjoint write ownership in each actual dispatch and alone integrates shared paths; this documentation dispatch launches no agents.

| Package | Work and deciding observation | Status |
| --- | --- | --- |
| A and C builder | Fail-closed product-input classifier and per-job exact-commit CI proof/reuse; focused boundary regressions and actual workflow dependency review | PENDING — artifact and exact checks |
| #200 builder | Investigate/correct the hosted DeepSeek timing family without weakening product deadlines or dropping native coverage; retain isolated-versus-contended and hosted candidate results | PENDING — artifact and exact checks |
| Round kit and verdicts | Public fixed parameterized runner with private parameters/evidence, one new directory per round, summarize without product effects, no retry/repair/approval, commit/digest pins; subcommands/fields documented by its builder in tests/README.md | PENDING — runner, negative/timeout admission and retained-evidence replay |
| Owners and guides | Amend the release and persistent-acceptance owners, tag-gate projection, decision records, cookbooks and generated index; criterion-by-criterion reconciliation and document checks | IN PROGRESS — bounded writer diff; independent acceptance pending |
| Independent review | Inspect actual owner/implementation diff, classifier boundaries, CI attribution and every unchanged publication check, runner admission/effects/confidentiality; record objections and dispositions | PENDING — independent context and artifact references |
| B proof | Record the qualifying rc.2 tag run and unchanged publication jobs; rehearse changed jobs only after separate different-owner scratch authority | PENDING — real job and comparison evidence |
| D deferred | Real concurrency remains outside rc.3; issue #204 receives the single-slot finding and fix suggestion for separately accepted product work | DEFERRED — no concurrency proof claimed |

### Manual-Gate Disposition And Known Limitations

PENDING — identify every applicable reserved decision and blocker from its owner and retain its current disposition. The NanoHost R001 runtime/stable-release boundary remains owned separately; an installable archive does not establish Worker readiness. Known defects and accepted external differences remain failed workflows rather than successful outputs. Sequential rounds currently took about 40 to 50 minutes each (observed 49.8 and 39.4); these are observations for planning, never time limits or a reason to omit evidence.

## Publication Authorization

Exactly `v0.1.0-rc.3` with the Expected Bundle is authorized by the source decision in Intent Epoch 1 once the amended Release Exit Criterion is met. Exercise it only after exact-P candidate CI, publication-path proof and the other owning release obligations hold. Stable release, other tags, visibility changes and creation of a scratch repository/packages remain outside this authorization. This writer performs no tag, publication or external write.

## Candidate And Frozen Checklist — Pending Coordinator Entry

PENDING — final implementation commits and independent review, full T/P, main membership and unused release source identity, classified diff/exit-0 result, exact-P candidate run/job evidence, observed visibility and Latest posture, frozen checklist section and non-secret input identities, known-defect dispositions, authorized deployment baseline, admitted runner commit/digest and private parameter-file digests. Freeze a new rc.3 checklist revision before counting; D's scheduling clarification changes no scenario predicate, while any actual edit of the frozen section remains an A reset.

## Ordered Round Results — Pending Coordinator Entry

No round has been entered or counted by this record. The maintained runner generates these rows from retained product records; the public projection omits private deployment values and all Thread identifiers/transcripts.

| Round | Tested candidate / frozen set | Deployment identity / window | Per-scenario outcomes | Counts / sequence | New defects / other dispositions | Retained evidence / non-pass checks |
| --- | --- | --- | --- | --- | --- | --- |
| PENDING | Full T and frozen checklist identity | Exercised component digests, non-secret configuration identity, UTC start/end | Deploy; Codex A–D; Pi A–D; OpenCode V2 A–D; DeepSeek A–D; Chat; Task; Goal; External | Executed; incomplete; successful; new; known; external; complete; clean; consecutive count; reset reason | Defect references and other dispositions | Neutral evidence alias/digest; runner commit/digest; private parameter digest; independent reference for each non-pass/undecidable row |

Codes: P pass, K known defect, E accepted external, N new defect, T environment or tool failure, I inconclusive. Retain complete private evidence and previous failed/incomplete outcomes. Independent checks are limited to non-pass/undecidable rows without removing scenario-owned independent proof. Each round deploys T through the maintained exact-source procedure; runtime groups stay sequential and only work holding no Worker may overlap. Record completeness, count and every reset under the release owner.

## CI Run On Publishing Candidate — Pending Coordinator Entry

PENDING — exact P, workflow identity, dispatch selection, run id/URL, UTC observations, all attempts and final result, same-job latest-attempt evidence and reuse eligibility. If P changes, obtain new candidate CI on P even when A preserves live rounds. Record failures and reruns without replacing historical evidence.

## Tag Workflow Run — Pending Coordinator Entry

PENDING — condition satisfaction before tag, exact authorized tag/commit and push time, tag-run id/URL, reused L0-L2/L3 proof references or fresh test results, every other tag job, publication-path proof, packaging/qualification, candidate and promoted image digests, immutable tag posture, anonymous worker-common check, GitHub prerelease creation/upload, failures and any admitted same-tag retry. A new tag after a defective or ambiguous promoted artifact requires new exact-tag authorization.

## Independent Post-Publication Verification — Pending Coordinator Entry

PENDING — independent observer/UTC time and actual final output, fresh non-draft prerelease read, exactly four attachments, downloaded checksums, complete Skill inspection and Node.js 24 discovery outside the checkout, both target-aware NanoHost verifier/contained-staging results, recorded-versus-observed image digests, anonymous exact-digest worker-common inspection after logout, observed visibility, unchanged GHCR latest and GitHub Latest, manual-gate disposition and NanoHost limitation. A producer summary does not establish this verification.

## Closeout — Pending Coordinator Entry

PENDING — delivered artifacts/commits, accepted owners and independent actual-diff review, exact check results, rounds/readiness and publication observations, external effects, cleanup and retained state, unresolved findings and residual risks, completion disposition and accurate lifecycle status. Record actual files changed, owning documents changed, distinct owners touched and any closed set or registry added under Change Execution; no complexity numbers or completion claims are invented now.
