---
status: Accepted
date: "2026-10-16"
decider: Engineer
---
# Assistant Predecessor Execution At The Identifier Cutover

## Decision

Use the approved P14 clean-candidate reset boundary for predecessor receipt-free Assistant Task admissions. Any retained bytes remain inspect-only as `recovery_required`. Do not automatically resume them, fabricate a prior exact human confirmation, add a compatibility reader, perform a separate P19 reset or implement a carry-forward migration. Add a no-resumption regression and name this disposition in the landing change record for the next prerelease notes. An ordinary pending outcome without the new descriptor retains its unchanged source-hash tuple.

## Reason

The coordinator accepted this disposition through the L-AK question channel on2026-10-16 after independent review identified the predecessor proof mismatch. The [pre-stable continuity decision](20261014-pre_stable_data_continuity.md) starts mandatory cross-release continuity at `v0.1.0`. The engineer stated that the development and two deployment environments hold no important data. The already approved P14 clean-candidate reset defines the prerelease disposition and retains its own protected-account, operator, fencing and evidence requirements. This decision grants no reset effect to L-AK.

## Rejected Alternatives

A new carry-forward migration would need to prove predecessor admission without inventing the new exact human selection or repeating uncertain effects. It is unnecessary at this accepted reset boundary. A permanent compatibility reader, synthetic confirmation, replacement receipt or implicit reset would violate the selected authority and failure boundaries.

## Revisit When

Revisit if the engineer changes the P14 reset scope, requires a predecessor Task to continue across this prerelease, or accepts a separate carry-forward design. Mandatory continuity from `v0.1.0` remains governed by Contract Evolution.

## Affected Owners

- [Chat Mode And Core Assistant](../specs/20260704-chat_mode_assistant.md).
- [Pending Requests](../specs/20260930-pending_requests.md).
- [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md).
- [Release Management](../specs/20260829-release_management.md).
