---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Earlier-Version Data And Sessions Are Not Carried Across The Agent Communication Redesign

## Decision

The agent communication redesign carries no data, Thread, Turn, Item, Approval, request, AgentSession, native runtime conversation, scheduler or checkpoint row, or stored agent manifest from earlier versions. Its first deployment starts from a new data root, and the new version does not read a data root written by an earlier version. This is the explicit data-retirement decision that `docs/core/contract-evolution.md` requires for removing retained data instead of migrating it, and it is limited to this cutover; it does not relax the data continuity obligation for later releases.

It removes from the redesign:
- the one-way upgrade migration of retained approvals and user-input requests into the pending-request record, the closing of open legacy gates, and the stripping or rewriting of removed Turn and AgentSession fields;
- the classification of pre-upgrade native conversations as carried or not carried;
- the one-way rewrite of stored agent manifests that reference the removed single-runtime images;
- every reader kept only for records such an earlier version wrote, such as the readability of `nanocore-boot-reconciliation` denials.

## Reason

The engineer stated on 2026-09-30, while the primary was resolving review findings about the upgrade migration and the continuity of pre-upgrade native conversations: 「不需要考虑旧版本的数据和会话的问题。」, which translates as "There is no need to consider the issue of earlier-version data and sessions." OpenKit has not yet made its first release, the retained data exists only in test environments, and the migration had become the largest source of unresolved review findings without serving a user need.

## Rejected Alternatives

- **A one-way migration of retained requests, gates, and fields**, which three review rounds could not bring to a complete and truthful classification of historical effects.
- **Carrying pre-upgrade native conversations where an adapter proves support**, which needed an engineer trade-off and per-adapter compatibility tests for data that no user depends on.
- **Rewriting stored agent manifests to the combined image**, which only served retained configuration.

## Revisit When

A release has shipped and its retained data carries the continuity obligation; any later breaking change then needs a migration or a new data-retirement decision.

## Affected Owners

- docs/specs/20260930-pending_requests.md
- docs/core/agent-session.md
- docs/core/protocol.md
- docs/specs/20260704-goal_mode_coordination.md
- docs/specs/20260721-worker_execution_environment_images.md
- docs/specs/20260708-container_image_packaging.md
- docs/decisions/20260930-one_multi_runtime_worker_image.md, whose manifest rewrite this decision removes
