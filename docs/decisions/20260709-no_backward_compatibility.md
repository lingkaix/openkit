---
status: Accepted
date: "2026-07-09"
decider: Engineer
---
# Internal Development Does Not Consider Backward Compatibility

## Decision

Because the project is in internal development, design, decisions, implementation, and changes do not consider backward compatibility. Root AGENTS.md states the rule as one of its two Chinese meta-instructions. The 2026-09-24 decision on stable mechanisms clarifies that this removes obligations toward old data and callers and does not license churn of settled mechanisms or conflict with tolerance of unknown extensions.

## Reason

The engineer's words, translated from Chinese: "Our project is in internal development, so when designing, deciding, implementing, and modifying, do not consider any backward compatibility issue." The only reason recorded is the premise the rule states: the project is in internal development.

Source: root AGENTS.md since the initial commit of 2026-07-09; no change record carries it.

## Rejected Alternatives

None recorded.

## Revisit When

When the project leaves internal development, for example at a release with users whose data must survive upgrades; release migrations already change the rule for database schemas after the first release.

## Affected Owners

- AGENTS.md
- docs/core/contract-evolution.md
- docs/specs/20260703-storage_layout_record_ownership.md
