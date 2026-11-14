---
status: Accepted
date: "2026-11-14"
decider: Engineer
---
# Pre-Release SQL Baselines

## Decision

Before the first stable release, `v0.1.0`, Core and Workspace each use one current SQL baseline. The engineer directed this consolidation after the security publication schema landed, rather than at the final release candidate. Later pre-release changes edit the baseline directly, without another schema version or migration entry. Retire intermediate pre-release upgrade tests, fixtures and release-pair instruments. The retained-format register describes one current pre-v0.1.0 baseline, not a sequence of supported development formats. User and App journals are unchanged by this Core/Workspace consolidation.

[Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md) owns the physical setup. [Release Management](../specs/20260829-release_management.md) owns release qualification. Its earlier requirement to upgrade from each previous release candidate does not apply before `v0.1.0`. From the first stable release, [Contract Evolution](../core/contract-evolution.md#retained-data-continuity) still requires continued use of retained data under the accepted owners.

This decision authorizes no deployment reset, account action or cleanup of retained runtime or evidence databases. Existing reset procedures still need explicit operator authorization and must preserve the designated accounts. Unsupported database identities fail closed. Startup must not reset them or infer publication authority from old files. Ordinary access, retention, transaction, physical close and acknowledgement rules remain binding.

## Reason

The engineer rejected development-format compatibility work before the first stable release. Repeated intermediate migrations and their upgrade fixtures create maintenance work without a released-data obligation. Consolidating the current schema now keeps one clear fresh setup and removes that work. Current schema constraints, real fresh publication, failure handling and native ownership still need tests; removing old upgrade scenarios does not remove these requirements.

## Rejected Alternatives

Waiting until the final release candidate was rejected in favor of consolidation immediately after the security schema landing. Keeping intermediate pre-release formats, upgrade fixtures or a previous-candidate qualification gate would preserve the work the engineer directed us to remove. Automatic reset is not an alternative: this decision does not authorize destructive action on any deployment.

## Revisit When

At the first stable release, freeze its released baseline and apply the retained-data continuity obligation. Revisit earlier only if the engineer accepts a separate continuity requirement. Any actual reset remains a separately authorized operator action.

## Affected Owners

- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [Retained Format Register](../specs/20261017-retained_format_register.md)
- [Release Management](../specs/20260829-release_management.md)
