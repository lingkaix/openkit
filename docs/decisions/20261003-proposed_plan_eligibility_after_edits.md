---
status: Accepted
date: "2026-10-03"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Consultant's analysis
---
# Proposed Plan Eligibility After Edits

## Decision

The Coordinator decided that a later intent revision or card edit does not by itself make an unchanged proposed Plan version ineligible, end its pending request, or invalidate its unconsumed grant. [Goal](../specs/20261002-goal.md#plan-version) owns eligibility. Approval and consumption recheck exact bytes and digest, current authority, an open Goal, and the applicable Pending Request conditions. The recorded basis identifies the approved commitment rather than imposing an equality fence against current intent or cards. New proposals end only older pending requests. Activation changes neither current intent nor cards and authorizes no work; later admission checks current intent and cancellation, with the Coordinator judging permitted card adjustments. An older version cannot replace a later active version.

## Reason

The active-version ruling did not settle proposed-version eligibility. The Consultant recommended preserving exact approval while avoiding repeated human approval for harmless edits, consistent with the engineer's recorded reason for Coordinator latitude and low attention load. Activation is distinct from admission: an intent-only change remains binding even when no card changes. This is the Coordinator's resolution of owner silence, not a new ruling attributed to the engineer.

Source decision: temp/comm-redesign/engineer-queue.md, entry "Goal: an unchanged proposed Plan version stays eligible after a later intent revision or card edit". Source analysis: temp/interface-unification/reports/consult-goal-proposed-plan.md, dated 2026-10-03. Landing commit: 183b58fc384b8f7c5e23ed5d53dfc17b296cf30a. These are provenance references, not behavioral authority.

## Rejected Alternatives

- A stale-basis fence: it creates approval churn even for harmless edits without a demonstrated need.
- Coordinator judgment at grant consumption: it adds a second model judgment gating exact approval while retaining the later admission judgment.

## Revisit When

None recorded.

## Affected Owners

- [Goal](../specs/20261002-goal.md)
- [Pending Requests](../specs/20260930-pending_requests.md)
