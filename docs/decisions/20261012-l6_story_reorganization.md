---
status: Accepted
date: "2026-10-12"
decider: Engineer
supersedes: docs/decisions/20261010-release_acceleration.md
---
# L6 Story Reorganization

## Decision

On 2026-10-12 the engineer accepted the L6 story form, the actor-channel limit, improvement suggestions beside friction, product-side reduction, named integrity invariants, and the post-tag catalog gate. [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md) owns the story form, the catalog of ten intents, actor channels, suggestions, reduction, invariant names, and the story-run evidence bundle. [Release Management](../specs/20260829-release_management.md) owns when that catalog runs: deterministic CI before the prerelease tag, the ten catalog stories on the published prerelease, Worker qualification on the updated deployment, and stable promotion of a passing prerelease without a rebuild. This change does not define the product integrity-check operation.

This record replaces [Release Acceleration](20261010-release_acceleration.md) whole. These parts carry forward unchanged into Release Management: exact-commit candidate CI reuse, publication-path proof for a changed publication job, the compact release record with generated verdicts and targeted independent checks, one public parameterized runner with private parameters and evidence, and sequential Worker groups under the one-active-Worker-Turn boundary, with [issue #204](https://github.com/lingkaix/openkit/issues/204) tracking concurrency. The completed authorization to publish `v0.1.0-rc.3` stays historical. It is not a new publication grant.

The exact-source procedure that [Remove The App Update Helper's Exact-Commit Mode](20261010-remove_app_update_exact_commit.md) names is no longer the release-gate deploy path. The helper's release-only contract in that record stays. This record does not supersede that record.

Product facts never depend on OpenTelemetry. Operational telemetry uses OpenTelemetry. Evaluation evidence is one bundle per story run, and a telemetry file in that bundle is diagnostic input and never the verdict. This change states that bundle and one run-scoped Collector in the L6 owner only. It changes no product code. NanoCore Turn-chain spans, NanoHost tracing, and in-sandbox Worker telemetry stay deferred until after the RC4 release as issues #219, #220, and #221.

## Reason

L6 answers whether a real user can reach a real outcome with the shipped artifact through user surfaces while the system's records stay true.

The engineer asked on 2026-10-12, quoted verbatim:

> 现在我们来讨论 L6 story。我们先不考虑当前我们的实际状态，从 First principle出发，你认为 L6 story 理想的形态是什么样的？

Faithful English translation: "Let us discuss the L6 story now. Let us first set aside our current actual state and start from first principles. What do you think the ideal form of an L6 story is?"

The engineer then said, quoted verbatim:

> 让我们回到 L6 Story , 我同意你的这个判断与设计方向。

Faithful English translation: "Let us return to the L6 story. I agree with this judgment and this design direction."

The engineer then said, quoted verbatim:

> 你给我的六点回复，我都同意。关于你需要我采取的四件事，我一件一件的说。第一件，这个恰恰就是我 上一轮对话想问你的问题，就是这个 prepare 的流程是否应该进入某个 story 呢？还是你认为应当保持现在的这个 prepare 的设计？第二点我同意。第三点我同意。 不过需要提交一个issue，就是对旧文档的审计与改写、修复与更新。最终我们是需要把我们所有的文档都整理干净，统一。第四个问题，先按照这十个的清单来。当然，我们现在 L6 Story 有一些留存的旧的 Story，你可以看一下其中有没有有价值的信息。如果有的话，提取到我们新的 Story 设计当中来，最后把它清理干净。

Faithful English translation: "I agree with all six points in your reply. On the four things you need me to do, I will take them one by one. The first is exactly the question I wanted to ask in the previous round: should this prepare flow enter some story, or do you think we should keep the current prepare design? I agree with the second point. I agree with the third point. We do need to file an issue for the audit, rewrite, repair, and update of the old documents. In the end we need every document tidy and uniform. On the fourth point, start from this list of ten. Our L6 stories still include some retained old stories. Look for valuable information in them. If there is any, extract it into the new story design, and then clean them up."

The engineer then said, quoted verbatim:

> 你提到的这个新设计，我同意。 你说的那处 story 格式强制要求的冲突，我也同意你的修改意见。

Faithful English translation: "I agree with the new design you described. I also agree with your proposed change where the story format's mandatory requirement conflicts."

On telemetry, the engineer said on 2026-10-12, quoted verbatim:

> 关于 telemetry，我同意你的这个方案。

Faithful English translation: "On telemetry, I agree with this proposal of yours."

The parts carried forward from the 2026-10-10 acceleration ruling keep their reasons. Exact-commit candidate CI reuse avoids repeating the same tests on the critical path when the tagged commit already has a successful same-workflow latest attempt. Publication-path proof is required when a publication job changes, because an unchanged job already has a successful real tag run. The compact record and the one public runner replace narrative reports and copied per-round scripts while complete evidence stays private. Sequential Worker groups follow the deployment's one-active-Worker-Turn boundary.

The engineer's question of 2026-10-10, quoted verbatim from the superseded record:

> 我发现从 RC one 到我们现在基本上快把 RC two 做完，整个的验收过程超过了八个小时。这中间除了你对 CI 的一个 fix 之外，我们只是在更新一些文档。你认为这个时间长度正常吗？中间的这些工作与流程都是必要的吗？我们能否优化 验收与发布速度呢？

Faithful English translation: "I noticed that from RC one to now, when we have almost finished RC two, the whole acceptance process has taken more than eight hours. Apart from your one CI fix, we have only been updating some documentation. Do you think this duration is normal? Were all the work and procedures in between necessary? Can we optimize acceptance and release speed?"

The engineer's decision of 2026-10-10, quoted verbatim:

> 采纳你的 A 到 F 的全部建议。我授权给你去进行改进。你可以调起独立的 agents 作为你 coordinator的 advisor、builder、reviewer 等角色。按照你的建议把已经几乎完成了RC2按照当前的流程走完, 然后把这些改进做完(包括对发布的 Cookbook 和 Guideline 的update) 作为 RC3，按照新的流程发布。

Faithful English translation: "I adopt all your recommendations A through F. I authorize you to make the improvements. You may call independent agents in roles such as advisor, builder, and reviewer for you as coordinator. As you recommended, finish the almost-completed RC2 under the current process, then complete these improvements, including updates to the release Cookbook and Guideline, as RC3 and publish it under the new process."

After the consultant found that the deployment admits one active Worker Turn rather than four, the engineer selected, verbatim:

> 推迟到 rc.3 之后（推荐）

Faithful English translation: "Defer until after rc.3 (recommended)."

## Rejected Alternatives

- Make `prepare` a story. It is stage-manager setup, not a user intent. Its deploy part reaches new code through a privileged path over test data, not over the previous release's data, and without a NanoHost or Worker update.
- Run L6 on an unpublished candidate. That tests bytes users never install. The published prerelease tests the bytes users get.
- Limit the actor's intelligence. That causes many failures and stops the actor from finding more problems and proposing improvements. The accepted rule limits privileged channels and records a workaround as friction.
- Reduce every actor trajectory. Agent runs are nondeterministic, so reducing every trajectory is not feasible. The product cause is what a reduced defect records.
- Keep two consecutive clean rounds and the product-input comparison as the release gate. Those rounds ran before the tag, through a privileged deploy over test data. The catalog on the published prerelease replaces them, so the comparison that preserved those rounds has no release obligation.
- Use telemetry as the story oracle or as a store of product facts. Export may sample, batch, and drop data, and it does not commit with the state change, so it cannot prove completeness.
- Define the product integrity-check operation in this change. Stories name invariants. The operation is a later specification.

## Revisit When

Revisit the catalog when these ten intents no longer cover the supported user journeys, or when the engineer removes a story whose only distinct risk has moved to a lower layer. Revisit the post-tag gate when the published prerelease is not the bytes users install. Revisit Worker qualification when issue #204 accepts real Worker concurrency and a separate qualification exists for it. Revisit the evidence bundle when a telemetry export commits with the product state change and can prove completeness. Revisit stable promotion without a rebuild only if the passing prerelease's published bytes cannot be the stable bytes. These are proposed observations, not new engineer rulings.

## Affected Owners

- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md)
- [Release Management](../specs/20260829-release_management.md)
- [Test Strategy](../specs/20260529-test_strategy.md)
- [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md)
- [Operational Telemetry](../specs/20260731-operational_telemetry_standardization.md) is linked and not edited.
- [Release Cookbook](../cookbooks/release.md)
- [Persistent Live Acceptance](../cookbooks/persistent-live-acceptance.md)
- [Engineering Glossary](../glossary.md)
