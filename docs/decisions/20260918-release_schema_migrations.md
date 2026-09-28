---
status: Accepted
date: "2026-09-18"
decider: Engineer
---
# Schema Migrations Start At First Release

## Decision

Before the first release, schema changes may be consolidated into each scope's initial baseline. After release an applied migration is immutable, and each release that changes a schema adds an incremental SQL migration, executed by Drizzle at startup through its native ledger. A test database built from an older unpublished baseline needs an explicit operator cutover or recreation; ordinary startup neither adopts an old ledger nor resets data. The storage layout specification owns the rule.

## Reason

The engineer corrected a proposed design on 2026-09-18 and asked for release SQL files executed by Drizzle at startup, clarifying that the unpublished initial schema intentionally stays consolidated and that each schema-changing release after publication adds an incremental migration.

Source: change record 202609160700000000-self_hosted_development, Intent Epoch Release Migrations And Handoff.

## Rejected Alternatives

- Refusing startup when a setup-file hash differs. Rejected by the engineer as the database solution.
- A migration for every development commit, an automatic data reset, and a permanent compatibility path for predecessor schemas. Rejected in the same correction.

## Revisit When

At the first release, when the consolidation phase ends.

## Affected Owners

- docs/specs/20260703-storage_layout_record_ownership.md
