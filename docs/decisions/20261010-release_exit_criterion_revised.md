---
status: Superseded
date: "2026-10-10"
decider: Engineer
supersedes: docs/decisions/20261005-release_exit_criterion.md
superseded-by: docs/decisions/20261010-release_acceleration.md
---
# The Release Exit Criterion, Revised

## Decision

This record replaces [A Fixed Scenario Set And Consecutive Clean Release Rounds](20261005-release_exit_criterion.md). The engineer's 2026-10-10 confirmation changes only the deployment path; every other element of the 2026-10-05 decision is unchanged.

Release readiness uses a fixed acceptance scenario set and two consecutive complete rounds with zero new product defects. [Release Management](../specs/20260829-release_management.md) owns the rule and records two as the current default. The [Release Cookbook](../cookbooks/release.md) carries the concrete first-release procedure. The coordinator's clarified interpretation recorded with the 2026-10-05 decision binds the candidate to one exact source commit, with deployed artifact identities recorded per round. Each round now deploys that candidate through the maintained [external-operator exact-source procedure](../cookbooks/persistent-live-acceptance.md#update-an-exact-source-build), replacing the product installation or update path under [the App update-mode removal decision](20261010-remove_app_update_exact_commit.md). Rebuilding the same commit through that maintained procedure between rounds does not reset the count; changing the candidate commit or fixed set does. Publication is from that same commit, and the tag workflow rebuilds and verifies the published bytes without claiming byte identity with the tested deployment. The rule supplies readiness evidence and grants no publication authorization or waiver of any other release blocker.

## Reason

The engineer's 2026-10-10 confirmation, quoted verbatim:

> 1&2: 关于发布流程的问题，你理解的没有错。3: kind 字段 以及那些只服务于构建的字段 按照你的建议 如果确认不需要了的话，去掉。并且按照我们一贯的做法，对于未知的键保持 开放扩展式的兼容（也就是 读取的时候忽略掉）。

Faithful English translation: "1 and 2: your understanding of the release-flow questions is correct. 3: following your recommendation, remove the kind field and the fields that serve only building if they are confirmed to be unnecessary. And follow our usual approach of open extension compatibility for unknown keys, meaning ignore them when reading."

The release-flow confirmation preserves exact-candidate deployment for counted rounds through the external-operator procedure. The separately recorded [2026-10-10 removal decision](20261010-remove_app_update_exact_commit.md) explains why the product's exact-commit source-build mode was removed and records the field-removal ruling quoted above. The maintained procedure preserves source and deployed-artifact attribution without requiring that removed product mode.

The 2026-10-05 reason remains: live acceptance on persistent staging had run for dozens of rounds while new defects continued to appear. Convergence needs an explicit stopping rule. Freezing coverage makes rounds comparable; consecutive complete clean rounds show that defects have stopped emerging within the declared scope. Testing the same source commit binds readiness to the source released. The tag workflow separately builds, smokes and verifies the published artifacts; requiring reuse of tested deployment bytes would need a new promotion path that the first release does not need. The earlier [external Provider behaviour ruling](20261002-external_provider_behavior_accepted.md) keeps inconsistent external behaviour outside OpenKit's responsibility while preserving its service stability, data correctness and product logic. Deployment remains an observed part of each round rather than an assumed prerequisite; the 2026-10-10 ruling changes how that deployment occurs.

## Rejected Alternatives

- Keep the product exact-commit path for counted rounds only: rejected with the 2026-10-10 removal of that mode; exact-source candidate deployment remains an external-operator procedure.
- Open-ended testing: the 2026-10-05 decision rejected it because it gives no stopping condition while new defects keep appearing.
- A single clean round: the 2026-10-05 decision rejected it because it gives no consecutive repeat observation after the last defect or product change.
- A fixed time window: the 2026-10-05 decision rejected it because elapsed time does not prove that every scenario executed or that the candidate stopped revealing new product defects.

The alternative explanations describe the trade-offs of the recorded rulings; they are not additional quoted engineer statements.

## Revisit When

Proposed revisit conditions carried from the 2026-10-05 record, not a separate engineer ruling: repeated complete clean rounds fail to predict first-release stability, the approved release scope changes, or the fixed set no longer represents the supported product paths. A different set or count requires the engineer's decision and a fresh sequence under the owner.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md): readiness and counted-round deployment path.
- [Release Cookbook](../cookbooks/release.md): the concrete first-release procedure.
