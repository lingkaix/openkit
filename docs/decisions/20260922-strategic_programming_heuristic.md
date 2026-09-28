---
status: Accepted
date: "2026-09-22"
decider: Engineer, adopted as doctrine by the primary agent
---
# Strategic Programming With A 10–20% Design Heuristic

## Decision

Strategic Programming makes continual design maintenance part of useful delivery. For non-trivial changes, roughly 10–20% additional design attention is a useful heuristic, not a time quota, score, or entitlement to expand scope, and no-change is a valid result. The engineer proposed the practice and the figure; the primary agent recorded it in the doctrine as a heuristic rather than a quota. The engineering doctrine states it.

## Reason

The engineer proposed Strategic Programming, described as spending roughly 10–20% of each change on design maintenance. The figure comes from John Ousterhout's Stanford CS190 material on strategic programming; the project adopts it as a reminder to invest in design rather than as a per-commit quota, and does not treat the book's illustrated payoff as measured benefit.

Source: change record 202609220200000001-runtime_child_retention; the 2026-09-23 exclusion is in change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, topic one.

## Rejected Alternatives

- A per-change time quota. Rejected when the doctrine adopted the percentage as a heuristic, and listed among the exclusions the engineer broadly agreed to on 2026-09-23; no specific reason for rejecting a quota was recorded.

## Revisit When

When design maintenance is repeatedly skipped, or the figure starts being enforced as a quota.

## Affected Owners

- docs/engineering-doctrine.md
