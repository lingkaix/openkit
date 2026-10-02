---
status: Accepted
date: "2026-10-02"
decider: "Engineer, on the coordinator's recommendation for rulings 2 and 3, and on the engineer's own choice for ruling 1"
---
# Goal Contract Gap Rulings

## Decision

The engineer ruled on 2026-10-02 on three gaps in the accepted Goal contract. Goal owns the Plan-eligibility and operation rules. Pending Requests owns the request that those operations raise and the ending of that request.

1. Plan eligibility after a card edit. Whether the Coordinator may admit work for a card whose current revision differs from the revision the active Plan version recorded is decided by that version's permitted adjustments. The Coordinator judges whether the current card revision is within them. When it is not, the Coordinator proposes a new Plan version instead of admitting. The admission still cites the card revision and the Plan version. An intent revision does not by itself invalidate the active version.
2. Completion candidate. The Coordinator calls accept completion with the candidate. Because the Coordinator has no authority to accept, that call becomes a Pending Request whose exact intent is the captured call, in the same pattern as an approval-required tool call. After a person or a currently usable administrator grants it, the captured call executes with the granting actor recorded as the decider. No eleventh operation is added. Propose Plan still raises its own approval.
3. Cancellation and supersession. When a Goal is cancelled, every open Plan approval and completion request of that Goal closes at once as invalidated, with the reason that the Goal was cancelled. A granted but unconsumed grant is refused with a conflict when its consumption is attempted. A new Plan proposal invalidates any older open Plan proposal of the same Goal in the same way. The person sees the closing reason where the request is shown. Open means the request is still pending. The supersession reason is that a newer Plan proposal superseded the older open proposal.

## Reason

The engineer's words for ruling 1, translated from Chinese: "Goal Mode should give the Coordinator Agent more authority to schedule and advance progress. During a Goal, adjusting the Plan's steps is a high-frequency operation for both the user and the Coordinator, so I do not want to constrain it so tightly that it limits the agent's ability and flexibility, and I want the agent to help the user minimize cognitive and attention load. If this causes instability or safety concerns that need a deterministic mechanism, we can discuss it again." After the ruling, the coordinator assessed that no additional mechanism is needed because the hard boundaries stay deterministic (current intent, Goal and card cancellation, Plan version, actor authority, and effect-specific approvals and Sandbox checks), every admission cites the card revision and Plan version it relied on, and completion still needs a person's or an administrator's acceptance; the engineer did not comment on that assessment.

The engineer accepted the coordinator's recommendation for rulings 2 and 3 and did not state a separate reason.

## Rejected Alternatives

- A deterministic revision-mismatch fence, which would refuse admission whenever the current card revision differs from the revision the active Plan version recorded. The engineer did not choose it.
- A new propose-completion operation. The engineer did not choose it.
- Leaving open Plan approvals and completion requests until consumption. The engineer did not choose it.

## Revisit When

Revisit ruling 1 if the Coordinator's delegated flexibility causes instability or safety concerns that need a deterministic mechanism.

## Affected Owners

- docs/specs/20261002-goal.md
- docs/specs/20260930-pending_requests.md
