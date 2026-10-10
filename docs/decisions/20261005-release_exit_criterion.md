---
status: Superseded
date: "2026-10-05"
decider: Engineer
superseded-by: docs/decisions/20261010-release_exit_criterion_revised.md
---
# A Fixed Scenario Set And Consecutive Clean Release Rounds

## Decision

On 2026-10-05 the engineer approved a fixed acceptance scenario set and release readiness only after two consecutive complete rounds with zero new product defects. [Release Management](../specs/20260829-release_management.md) owns the rule and records two as the current default. The cookbook carries the concrete first-release procedure. The coordinator's clarified interpretation binds the candidate to one exact source commit: both clean rounds deploy that commit through the supported product installation or update path, recording deployed artifact identities per round. Rebuilding that commit through the path between rounds does not reset the count; changing the candidate commit or fixed set does. Publication is from that same commit, and the tag workflow rebuilds and verifies the published bytes rather than claiming byte identity with the tested deployment. The rule supplies readiness evidence and does not grant publication authorization or waive other release blockers.

## Reason

Live acceptance on the persistent staging deployment has run for dozens of rounds, and each round still surfaces new defects. Convergence needs an explicit stopping rule instead of testing until it feels done. Freezing coverage makes rounds comparable; consecutive complete clean rounds show that defects have stopped emerging within that declared scope. Testing the same source commit binds the readiness claim to the source released. The existing exact-commit deployment path can rebuild that source for each round, and the existing tag workflow separately builds, smokes and verifies the published artifacts; requiring reuse of the tested deployment bytes would need a new promotion path that the first release does not need. The earlier [external Provider behaviour ruling](20261002-external_provider_behavior_accepted.md) keeps inconsistent external behaviour outside OpenKit's responsibility while preserving OpenKit's own service stability, data correctness, and product logic. The separately approved use of the product installation path on staging makes that path part of the round rather than an assumed prerequisite.

## Rejected Alternatives

- Open-ended testing: it gives no stopping condition while new defects keep appearing.
- A single clean round: it gives no consecutive repeat observation after the last defect or product change.
- A fixed time window: elapsed time does not prove that every scenario executed or that the candidate stopped revealing new product defects.

The alternative explanations above describe the trade-offs of the recorded ruling; they are not additional quoted engineer statements.

## Revisit When

Proposed revisit conditions, not a separate engineer ruling: repeated complete clean rounds fail to predict first-release stability, the approved release scope changes, or the fixed set no longer represents the supported product paths. A different set or count requires the engineer's decision and a fresh sequence under the owner.

## Affected Owners

- docs/specs/20260829-release_management.md
- docs/cookbooks/release.md
- docs/specs/20260909-persistent_deployment_acceptance.md
- docs/specs/20260529-l6_story_acceptance.md
