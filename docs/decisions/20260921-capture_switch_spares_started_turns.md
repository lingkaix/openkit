---
status: Accepted
date: "2026-09-21"
decider: Engineer
---
# A Capture Setting Change Never Interrupts A Started Turn

## Decision

A change of the capture setting takes effect at the next Turn; an already-started Turn is never interrupted for it, and no mid-Turn interrupt path for that change may be introduced. The switch defaults to off. Security revocation of routes remains the session-continuity owner's rule and is not this switch. Core protocol and the Work Data Retention Format specification own the rule.

## Reason

The engineer's words, translated from Chinese: "Do not interrupt a Turn that has already started. Reason: our Turns run fairly briefly, so cutting capture off midway does not lose much data." And: "The switch stays off by default." The consequences of default-off, that the capture binding is needed on almost every Turn and that the fine-tuning need is unmet until a user turns the switch on, were recorded by the authors, not given by the engineer as reasons.

Source: change record 202609211900000000-work_data_capture_and_turn_lifecycle, proposal, ruling R42 items 1 and 2.

## Rejected Alternatives

- Interrupting running Turns when the setting changes. Rejected for the reason above.
- A Thread-level append-only changelog. The engineer had agreed to it on cost grounds; the author withdrew the recommendation after finding the Turn record is already rewritten.

## Revisit When

When Turns routinely run long, for example long tool-running Turns, so that the premise that little data is lost no longer holds.

## Affected Owners

- docs/core/protocol.md
- docs/specs/20260921-work_data_retention_format.md
