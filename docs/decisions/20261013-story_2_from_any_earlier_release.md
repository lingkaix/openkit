---
status: Accepted
date: "2026-10-13"
decider: Engineer
---
# Story 2 From Any Earlier Release

## Decision

On 2026-10-13 the engineer ruled that a story 2 update is not limited to the previous release. [Release Management](../specs/20260829-release_management.md) owns the rule. The [Release Cookbook](../cookbooks/release.md) is its projection.

When the test server runs an earlier published release with its real data, the operator runs story 2 from that release to the latest published prerelease. The earlier published release is the previous release or an older published release. When the test server is empty, the operator runs story 1.

Before the first stable release, the story 2 run that qualifies a stable promotion starts from the previous prerelease. After the first stable release, that run still starts from the previous stable release with its real data. When the test server does not already run that stable release, the operator restores the persistent deployment from a cold backup.

This record changes only the starting release for ordinary prerelease runs in [Catalog Story Cadence](20261012-catalog_story_cadence.md). Its stable-promotion requirements and every other cadence element remain in force.

## Reason

The question this ruling answers is item 33, question A. That question asks which catalog story runs when the test server is neither empty nor on the previous release. One example is a test server that runs an older prerelease.

The following paragraph is a faithful English translation of the engineer's ruling on 2026-10-13:

Faithful English translation: "On item thirty-three: our update rule is not limited to the previous version. That is, if the server is on an older version, the test updates it from that older version to the latest version awaiting release. You may need to clarify this in the relevant documents."

This record interprets the source phrase translated as "version awaiting release" as the latest published prerelease.

The operator runs story 2. The operator updates the deployment from the earlier release it runs, with its real data, to the latest published prerelease.

## Rejected Alternatives

- Limit story 2 to the previous release. The engineer rejected that limit. An older published release on the test server still starts story 2.

## Revisit When

Revisit this rule when an ordinary prerelease run must start from a release the test server does not already run.

## Affected Owners

- [Release Management](../specs/20260829-release_management.md) owns the rule.
- [Release Cookbook](../cookbooks/release.md) is its projection.
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md) states catalog story 2.
- [persistent-deployment-prerelease-update](../../tests/stories/persistent-deployment-prerelease-update.story.md) states the starting world.
- [Catalog Story Cadence](20261012-catalog_story_cadence.md) remains the record of the other cadence elements.
- [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md) owns cold backup and is unchanged.
