---
status: Accepted
date: "2026-10-14"
decider: Engineer
---
# Pre-Stable Data Continuity

## Decision

The data-continuity obligation of NONNEG-001 and COMPAT-001 starts with the first stable release. Before that release, deployments hold no production data. A change may reset deployment data instead of carrying it forward, and no compatibility work is required. A prerelease does not start the obligation. [Contract Evolution](../core/contract-evolution.md#retained-data-continuity) owns the rule. The proposed COMPAT-001 amendment requires the engineer to edit root AGENTS.md.

This ruling changes when continuity starts. It leaves the scope of continuity after that boundary, Core semantics, strict validation, and the Safety Kernel intact. It does not authorize an automatic startup reset. This documentation change deletes no deployment data.

## Reason

On 2026-10-14, the engineer stated that the development, staging, and production deployments contain no production data and that no formal release exists. The source is Intent Revision 5 in change record 202610131730000000-v0_1_0_rc_6_prerelease. The following wording is from its faithful English translation: "the data on all three of our servers is not production data; just delete it" and "because we have not published any formal release, we need not consider any compatibility".

The engineer permits deletion instead of migration for the identifier change. This assignment states the durable boundary as the first stable release. Earlier decisions applied continuity immediately to canonical files and configuration, and from the first release to SQLite. This ruling replaces those start conditions only. [Compatibility Obligations Rest On Data](20260928-compatibility_rests_on_data.md) retains the reason for the later data obligation. [Schema Migrations Start At First Release](20260918-release_schema_migrations.md) retains the consolidation mechanism and its refusal of automatic resets.

## Rejected Alternatives

The engineer rejected compatibility work and identifier migration for the current change because there is no production data and no formal release. The new stable-release boundary also excludes a prerelease as the start of the data-continuity obligation. No other rejected alternative was recorded.

## Revisit When

Revisit the pre-stable premise if a deployment acquires production data before the first stable release. At the first stable release, apply data continuity. A later proposal to remove retained data needs the explicit retirement decision required by its owner.

## Affected Owners

- Root AGENTS.md, NONNEG-001 and COMPAT-001: the engineer must apply the proposed start-condition amendment.
- [Contract Evolution](../core/contract-evolution.md#retained-data-continuity): the continuity start condition and reset permission.
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md): the release boundary for SQLite consolidation and later migration work.
- [Contract Stability Baseline](../specs/20260715-contract_stability_baseline.md): classifications that depend on the continuity boundary.
