---
status: Accepted
date: "2026-10-12"
decider: Engineer
---
# Catalog Story Cadence

## Decision

[Release Management](../specs/20260829-release_management.md) owns this rule. The [Release Cookbook](../cookbooks/release.md) is its projection. A release cycle is every prerelease that shares the version of the prerelease a stable release promotes. Within a release cycle, every catalog story passes at least once. A prerelease need not run every catalog story. When the test server already runs the previous release with its real data, the operator runs story 2. When the test server is empty, the operator runs story 1. The promoted prerelease itself passed story 2 and Worker qualification. Within the cycle, a catalog story's latest product verdict decides whether that story has passed. A later run that confirms a product defect, including a known defect, cancels an earlier pass until a later prerelease passes that story again. A run classified as environment failure, tool failure, inconclusive, or accepted external behaviour cancels nothing. The stable release record names, for each catalog story, the prerelease on which that story passed. That prerelease may be an earlier prerelease of the cycle. After the first stable release, the story 2 run that qualifies a stable promotion starts from the previous stable release. When the test server does not already run that release, the operator restores that deployment from a cold backup. Before the first stable release, that story 2 run starts from the previous prerelease. A Worker qualification pass counts only for the prerelease on which it ran. That pass is on the deployment that story 1 or story 2 produced for that prerelease. This decision changes the cadence part of [L6 Story Reorganization](20261012-l6_story_reorganization.md).

## Reason

The engineer proposed on 2026-10-12, quoted verbatim:

> 「我认为关于 release cookbook 应该写上一条，就是在一个开发与 released 区间内，L6 story 至少运行一次。另外，根据测试与验证所使用的服务器的状态，story 1 和 story 2(也就是全新安装和更新到预发布的最新版本，两者之间) 二选一运行一次就可以了」

Faithful English translation: "I think the release cookbook should state one rule: within one interval from development to release, the L6 stories run at least once. Also, depending on the state of the server used for testing and verification, it is enough to run one of story 1 and story 2 (that is, a fresh install, or an update to the latest prerelease) once."

The coordinator asked whether "at least once" means that every prerelease runs every catalog story (interpretation 1, the previous rule) or that every catalog story passes at least once within a release cycle while a prerelease need not run every catalog story (interpretation 2). The coordinator also asked whether the prerelease promoted to stable must pass story 2, and whether the engineer had a further reason. The engineer answered, quoted verbatim:

> 「一，采用理解二。二，我同意这一条。三, 我主要是从测试与版本发布需求的 general sense 出发的，没有特别的理由。如果你认为有 不合理，或还可以进一步完善的地方，请提出来。」

Faithful English translation: "One: adopt interpretation 2. Two: I agree with this point. Three: I started mainly from a general sense of testing and release needs; there is no special reason. If you think something is unreasonable or could be improved further, raise it."

The engineer gave no special reason beyond a general sense of testing and release needs.

The coordinator then proposed five refinements. The engineer confirmed them, quoted verbatim:

> 「我确认这五点。」

Faithful English translation: "I confirm these five points."

The reasons in the rest of this section are the coordinator's recommendations. The engineer accepted those recommendations. They are not the engineer's own words.

The coordinator recommended the main rule for three reasons. Prereleases are frequent. Running all ten catalog stories on each prerelease costs too much. Deterministic CI guards regressions between prereleases. The coordinator recommended that the promoted prerelease pass story 2 for three reasons. Story 2 is the only catalog story that protects data continuity. The data obligation applies from the first stable release. Migration code changes between prereleases. The coordinator recommended that the test server's state choose the story on each prerelease. A server that already runs the previous release with real data runs story 2. An empty server runs story 1. The coordinator recommended that story 1 and story 2 each still pass at least once in the cycle, because every catalog story does.

1. The coordinator defined a release cycle as every prerelease of the version that is promoted to stable. The coordinator's example is that the cycle of `v0.1.0` is every `v0.1.0-rc.N`. The coordinator's reason is that the scope can be checked from the tags alone, so no separate record of a cycle's start and end is needed.
2. The coordinator recommended that, within a cycle, a story's latest product verdict decide. A later run that confirms a product defect cancels an earlier pass of that story in the same cycle until a later prerelease passes it again. A run classified as environment failure, tool failure, inconclusive, or accepted external behaviour proves nothing about the product and cancels nothing. The coordinator's reason is that, without this, a story that is known to be broken could reach stable on an old pass.
3. The coordinator recommended that the stable release record name, for each catalog story, the prerelease on which that story passed. The existing compact-record row already names a published identity. The amendment only states that this identity can be an earlier prerelease of the cycle. The coordinator's reason is that the engineer, who holds the stable gate, sees how old each piece of evidence is and decides whether to run a story again. The coordinator added no new mechanism.
4. The coordinator recommended that, after the first stable release, the story 2 run that qualifies a stable promotion start from the previous stable release. The persistent deployment runs the previous stable release with its real data, restored from a cold backup when the test server does not already run that release. Before the first stable release, there is no previous stable release, and that story 2 run starts from the previous prerelease. The coordinator's reason is that the data obligation applies from the first stable release, and real users update from one stable release to the next and skip the prereleases between them. Cold backup and restore are an existing supported operation that [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md) owns.
5. The coordinator recommended that Worker qualification stay on the promoted prerelease. A qualification pass on an earlier prerelease of the cycle does not count for the promoted prerelease. The deployment words change from "on the deployment that story 2 updated" to "on the deployment that story 1 or story 2 produced for that prerelease". The coordinator's reason is that every tag builds new image bytes, a stable release promotes exactly the promoted prerelease's bytes, and qualification is the only direct proof that those Worker image bytes work. Qualification is four runtimes and costs little.

## Rejected Alternatives

- Interpretation 1, in which every prerelease runs every catalog story. The coordinator recommended against it because prereleases are frequent, running all ten catalog stories on each prerelease costs too much, and deterministic CI guards regressions between prereleases. The engineer adopted interpretation 2.
- A stable promotion that does not require a story 2 pass on the promoted prerelease. The coordinator recommended against it because story 2 is the only catalog story that protects data continuity, the data obligation applies from the first stable release, and migration code changes between prereleases. The engineer agreed that the promoted prerelease must pass story 2.

## Revisit When

Revisit this rule when a defect reaches a stable release that a catalog story would have found on the promoted prerelease's bytes, or when catalog story runs become cheap enough to run every catalog story on every prerelease.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md) owns the rule.
- [Release Cookbook](../cookbooks/release.md) is its projection.
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md) uses "release cycle" and is unchanged.
- [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md) owns cold backup and is unchanged.
