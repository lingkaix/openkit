---
status: Accepted
date: "2026-11-16"
decider: "Engineer"
---
# One-Way Personal Workspace Data Ruling Of 2026-10-16

## Decision

The engineer ruling of 2026-10-16 removes pre-stable `quick-chat` home-to-`personal` Workspace data conversion, predecessor qualification, and legacy `quick-chat` kind readers. Fresh initialization creates `personal` Workspaces (`kind: "personal"`) directly with idempotent provisioning, and the ordinary SQLite schema migration remains. Any actual prerelease data reset is governed solely by [Pre-Stable Data Continuity](20261014-pre_stable_data_continuity.md) and `docs/specs/20260829-release_management.md#pre-stable-deployment-reset-and-protected-accounts`; personal Workspace provisioning grants no reset effect or one-way data migration.

## Reason

Under the pre-`v0.1.0` data-continuity boundary, building and qualifying a one-way `quick-chat`-to-`personal` data conversion and predecessor reader adds migration complexity without a post-reset consumer. Recording the 2026-10-16 ruling in a dedicated decision record preserves the authoritative no-conversion rule and retires the stale `docs/core/work-model.md` sentence that described a one-way Quick Chat data move.

## Rejected Alternatives

- Migrating existing pre-`v0.1.0` `quick-chat` Workspaces one way into `personal` Workspaces and qualifying predecessor home records.
- Retaining a legacy `quick-chat` Workspace kind reader or compatibility alias alongside `kind: "personal"`.

## Revisit When

Do not revisit for pre-`v0.1.0` `quick-chat` records. Post-`v0.1.0` changes to `personal` Workspace records follow standard retained-data continuity rules.

## Affected Owners

- [Core Work Model](../core/work-model.md)
- [Multi-User Workspace System](../specs/20260715-multi_user_workspace_system.md#personal-workspace)
- [Pre-Stable Data Continuity](20261014-pre_stable_data_continuity.md)
