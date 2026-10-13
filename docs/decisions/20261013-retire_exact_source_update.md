---
status: Accepted
date: "2026-10-13"
decider: Engineer
---
# Retire The Exact-Source Update Procedure

## Decision

On 2026-10-13 the engineer ruled to clean up item 29 after publication. The coordinator reads that ruling as retiring the exact-source update procedure after publication of `v0.1.0-rc.4`. The coordinator stated that reading to the engineer twice on 2026-10-13 and in the v0.1.0-rc.4 release record, and the engineer did not object. Because `v0.1.0-rc.4` is published, this retirement proceeds.

[App Update Delivery](../specs/20260910-app_update_delivery.md), [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md) and [Release Management](../specs/20260829-release_management.md) own the rule. A persistent deployment updates only to a published release. No supported exact-source update procedure exists.

The same ruling also names item 31. This record does not decide item 31.

## Reason

The following sentence is a faithful English translation of the engineer's ruling on 2026-10-13.

Faithful English translation: "Items thirty-one and twenty-nine: clean them up after you complete the publication."

The coordinator reads item 29 as this retirement. The coordinator stated that reading to the engineer twice on 2026-10-13 and named it in the v0.1.0-rc.4 release record. The engineer did not object.

The following sentences are context for that reading. They are not a new rule.

[Remove The App Update Helper's Exact-Commit Mode](20261010-remove_app_update_exact_commit.md) already removed the helper's exact-commit mode. Since [L6 Story Reorganization](20261012-l6_story_reorganization.md), the release gate and the catalog stories run only on published prereleases. No current procedure needs an unpublished commit on a persistent deployment. A persistent deployment updates only to a published release; the release gate uses the built-in update tools.

## Rejected Alternatives

- Keep the procedure as an unsupported operator option. The helper is release-only, and the release gate and catalog stories use published prereleases. No current procedure needs an unpublished commit on a persistent deployment, so retaining this option would preserve a second update path without a current need.

## Revisit When

When a persistent deployment must update to an unpublished commit, revisit this retirement.

## Affected Owners

- [App Update Delivery](../specs/20260910-app_update_delivery.md) states that a persistent deployment updates only to a published release.
- [Persistent Deployment Acceptance](../specs/20260909-persistent_deployment_acceptance.md) states the same limit and keeps the historical exact-commit observation.
- [Release Management](../specs/20260829-release_management.md) states the same limit.
- [Persistent live acceptance](../cookbooks/persistent-live-acceptance.md) no longer carries the procedure.
- [NanoCore operations](../../skills/openkit-ops/references/nanocore-operations.en.md) covers only a published release in Update NanoCore And Web.
- [Product Roadmap](../roadmap.md) no longer states that the procedure remains.
- [App image guide](../../containers/app/README.md) no longer names the procedure.
