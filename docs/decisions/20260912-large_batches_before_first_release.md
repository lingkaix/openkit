---
status: Accepted
date: "2026-09-12"
decider: Engineer
---
# Large Batches And One Acceptance Campaign Before The First Release

## Decision

Before the first release, implementation advances in a few large cohesive batches, followed by one consolidated release-candidate testing and acceptance campaign; integrated performance evaluation goes last. Development uses OpenKit and the authorized repository path rather than waiting for a product-native engineering loop. The roadmap owns the cadence, and the evaluation harness Draft projects its schedule.

## Reason

The engineer stated on 2026-09-12 that fewer than one week remained before the first release.

Source: change record 202609120959160001-roadmap_execution_refresh, Intent Epoch 2.

## Rejected Alternatives

- Serial feature-by-feature live acceptance. Superseded by the batch cadence.
- Making a product-native pull-request and merge loop a prerequisite for developing the release. Rejected in the same correction.

## Revisit When

The premise was dated: fewer than one week before the first release, as of 2026-09-12. When that window has passed, ask the engineer whether the cadence still holds.

## Affected Owners

- docs/roadmap.md
- docs/specs/20260711-evaluation_harness_design.md
