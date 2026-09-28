---
status: Accepted
date: "2026-09-21"
decider: Engineer
---
# A Reference May Fail To Resolve But Must Never Be Wrong

## Decision

A reference in retained work data may fail to resolve, but it must never bind to a different object than the one it cites. Retention keeps the principal information, trends, and regularities, and makes a best effort to find associated external files without guaranteeing that all can be found. An architecture able to retain complete files is kept for later, to be enabled by the user for cost reasons. The Work Data Retention Format specification owns the rule.

## Reason

The engineer's words, translated from Chinese: "The principle is to keep the main information, trends, and regularities in the data. For external associated files the principle is do our best: let the user find as many related files and data as possible when using history, but do not guarantee that all can be found. Key constraint: it is allowed not to find something, but a reference must not be wrong."

Source: change record 202609211900000000-work_data_capture_and_turn_lifecycle, proposal, ruling E4.

## Rejected Alternatives

- A record that promises never to be deleted. Replaced in review by a weaker guarantee.
- A tombstone row for every legal deletion. Rejected in review.
- Any reference that could silently resolve to another object after an import remints identifiers. Ruled out by the key constraint.

## Revisit When

When the cost of complete file retention falls enough for the user-enabled option to be implemented.

## Affected Owners

- docs/specs/20260921-work_data_retention_format.md
