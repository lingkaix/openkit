---
status: Accepted
date: "2026-09-20"
decider: Engineer
---
# Work-Data Retention Excludes Indexing And Retrieval Acceleration

## Decision

The work-data retention format does not cover indexing, BM25, or multimodal semantic search. Indexes are rebuildable derivatives of the retained records and carry no format semantics. The Work Data Retention Format specification owns the exclusion.

## Reason

The engineer excluded how to index and how to accelerate retrieval from the retention discussion because the engineer already has a set direction for that part. The authors added that any index is a derivative that can be rebuilt if lost, so it needs no place in the format.

Source: change record 202609211900000000-work_data_capture_and_turn_lifecycle, proposal. The reason that the engineer already had a direction for indexing is recorded only in a temporary retention working note of 2026-09-20.

## Rejected Alternatives

None recorded.

## Revisit When

When the engineer's direction for indexing and retrieval is written down, or when a retrieval need requires a field the retained format lacks.

## Affected Owners

- docs/specs/20260921-work_data_retention_format.md
