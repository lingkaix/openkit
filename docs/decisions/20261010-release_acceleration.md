---
status: Accepted
date: "2026-10-10"
decider: Engineer
supersedes: docs/decisions/20261010-release_exit_criterion_revised.md
---
# Release Acceleration

## Decision

Adopt release acceleration A, B, C, E and F for rc.3 and defer D's real Worker concurrency until afterward. This record supersedes [The Release Exit Criterion, Revised](20261010-release_exit_criterion_revised.md) for its reset and same-commit-publication rule. Its deployment-path ruling stays in force: counted rounds deploy the same tested commit through the maintained external-operator exact-source procedure, and same-commit rebuilding does not reset the count. The two consecutive complete clean rounds, fixed scenario authority, classifications, incomplete-round treatment, no-repair/no-retry boundaries and all other release obligations remain binding in [Release Management](../specs/20260829-release_management.md).

Live-round counts follow product inputs. Publication may select tested commit T or a later main commit P only with the release owner's complete classified non-product comparison proof. CI evidence remains exact-commit: P needs its own candidate dispatch, and each eligible tag job reuses only its own qualifying same-workflow, same-commit latest-attempt success. All other tag jobs and published-byte checks still execute. An earlier successful real tag run proves an unchanged publication job; a changed job requires a separately authorized different-owner scratch rehearsal before the real tag.

Use a compact release header and one row per round, with kit-generated verdicts backed by complete private product evidence. Independent checks apply to non-pass and undecidable rows; scenario-owned independent proof remains required. The maintained round kit uses the public parameterized runner `tests/support/release-round.mjs`, private per-round parameter files and new private evidence directories without copying or literal editing. The [tests guide](../../tests/README.md) documents its subcommands and fields. Pin its commit/digest and each parameter-file digest; no automatic retry, repair or approval is introduced.

The engineer's decision authorizes publication of exactly `v0.1.0-rc.3` with the same controlled asset set as `v0.1.0-rc.2` once the amended Release Exit Criterion is met and other applicable release obligations hold. Stable release, another tag, a visibility mutation, and scratch-target/package creation remain outside that authorization. Finish rc.2 under its existing process before applying the improvements and publishing rc.3.

## Reason

The engineer's question of 2026-10-10, quoted verbatim:

> 我发现从 RC one 到我们现在基本上快把 RC two 做完，整个的验收过程超过了八个小时。这中间除了你对 CI 的一个 fix 之外，我们只是在更新一些文档。你认为这个时间长度正常吗？中间的这些工作与流程都是必要的吗？我们能否优化 验收与发布速度呢？

Faithful English translation: "I noticed that from RC one to now, when we have almost finished RC two, the whole acceptance process has taken more than eight hours. Apart from your one CI fix, we have only been updating some documentation. Do you think this duration is normal? Were all the work and procedures in between necessary? Can we optimize acceptance and release speed?"

The engineer's decision, quoted verbatim:

> 采纳你的 A 到 F 的全部建议。我授权给你去进行改进。你可以调起独立的 agents 作为你 coordinator的 advisor、builder、reviewer 等角色。按照你的建议把已经几乎完成了RC2按照当前的流程走完, 然后把这些改进做完(包括对发布的 Cookbook 和 Guideline 的update) 作为 RC3，按照新的流程发布。

Faithful English translation: "I adopt all your recommendations A through F. I authorize you to make the improvements. You may call independent agents in roles such as advisor, builder, and reviewer for you as coordinator. As you recommended, finish the almost-completed RC2 under the current process, then complete these improvements, including updates to the release Cookbook and Guideline, as RC3 and publish it under the new process."

After the consultant found that the deployment admits one active Worker Turn rather than four, the engineer selected, verbatim:

> 推迟到 rc.3 之后（推荐）

Faithful English translation: "Defer until after rc.3 (recommended)."

The selected option keeps A, B, C, E and F in rc.3, runs the four runtime groups sequentially, permits overlap only for work holding no Worker, and defers real concurrency to [issue #204](https://github.com/lingkaix/openkit/issues/204) with a fix suggestion. [Runtime Scheduling Scale](../specs/20260703-runtime_scheduling_scale.md) owns the single-active-Turn boundary; the consultant also observed the executable `CHECK (max_active_turns = 1)` constraint. The source option and consultant finding explain the decision; they are not additional quoted engineer words.

The coordinator's A–F analysis attributed roughly two and a half hours of repeated live rounds to a workflow-only fix, found unexercised publication steps and repeated CI on the critical path, and identified verbose reports and copied script literals as avoidable work. A changes the reset predicate, B requires real publication-path proof when it changes, C combines the #200 timing-family correction with exact-commit test reuse, E replaces narrative with a compact evidence projection, and F maintains one parameterized runner. This summarizes the source proposal rather than reproducing it or treating its estimates as observed guarantees.

The consultant's single-slot finding defeated D's assumed operator-only concurrency change. Observed sequential rounds took about 49.8 and 39.4 minutes, supporting about 40 to 50 minutes per round for current planning rather than a limit or a promised 20-to-25-minute round. The corrected F instruction keeps the instrument public and repeatable while deployment-specific parameters and complete evidence remain private. Instrument corrections under tests are non-product for counting, subject to admission and complete deciding evidence.

For rc.3 the designated unchanged-publication proof is the `v0.1.0-rc.2` tag run, with its actual successful jobs and unchanged-job comparison since `d3423328` to be recorded. That designation does not assert an unobserved result. Published assets are rebuilt from P and verified by the tag workflow; the decision retains the existing exclusion of byte identity with tested deployment artifacts.

## Rejected Alternatives

- Reset on every commit change: the workflow-only fix between rc.1 and rc.2 forced about two and a half hours of repeated acceptance without changed product inputs. Product-input proof preserves useful rounds while candidate CI and publication verification remain tied to P.
- Rehearse in a different-owner scratch repository for every release: an unchanged job already executed successfully by a real tag has direct proof. Rehearsing only changed publication jobs avoids repeated external effects while retaining pre-tag proof where needed.
- Run four real Workers concurrently in rc.3: the existing deployment admits one active Worker Turn, so this would require product capacity and lifecycle work. The engineer deferred it to issue #204; sequential groups and overlap only for work without a Worker fit the accepted scope.

## Revisit When

Revisit the classification if an excluded path changes shipped behavior or installed content, an unknown input defeats its fail-closed boundary, or product-equivalent rounds fail to predict release stability. Revisit CI reuse if exact workflow/commit/job/latest-attempt attribution fails, and publication-path proof when any proved publication job changes. Revisit concurrency only through a separately accepted implementation and qualification for issue #204. Revisit the compact projection or runner if missing deciding evidence, admission failures or staging-value disclosure defeats reproducibility or confidentiality. These are proposed revisit observations, not new engineer rulings or a waiver of existing owners.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md): product-input counting, publishing-commit proof, exact-commit CI reuse, publication-path proof and compact records.
- [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md): complete retained evidence with generated verdicts and targeted independent checks.
- [Test Strategy](../specs/20260529-test_strategy.md): the tag-gate projection of CI evidence reuse.
- [Release Cookbook](../cookbooks/release.md) and [Persistent Live Acceptance](../cookbooks/persistent-live-acceptance.md): procedures projecting those owners and the maintained public runner with private parameters/evidence.
