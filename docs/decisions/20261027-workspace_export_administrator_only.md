---
status: Accepted
date: "2026-10-27"
decider: Engineer
---
# Workspace Export Requires Administrator Authority

## Decision

The engineer accepted administrator-only Workspace export on 2026-10-27. Creation and download each require the existing common authorizer's current Kernel decision under [Administrator Eligibility](../core/policy.md#administrator-eligibility). Member and owner associations grant no export right. The full Workspace closure includes private Threads and private-derived content, without an ordinary-caller filter or a blanket refusal merely because private history exists.

The recorded creator must still hold current administrator authority at download. Other administrators cannot substitute for that creator. Current credential scope, revocation, exact handle and deployment identity, canonical history, integrity, secret exclusions and restricted-body retention rules remain required. Exact deleted-Workspace recovery keeps its separately accepted authority; this decision does not change its owner mapping or lifecycle.

## Reason

A Workspace contains its members' private data. An ordinary-member whole-Workspace export is therefore a false requirement: membership and private-source access cannot authorize disclosure of every member's history. Export serves systems and scenarios outside OpenKit. Re-importing an export into OpenKit is not a product requirement; OpenKit-to-OpenKit preservation and migration use backup, restore and MOVE.

## Rejected Alternatives

An ordinary-member selective exporter and an own-private-history export API preserve a false whole-Workspace requirement and duplicate audience selection. A blanket private-history refusal prevents legitimate administrator export. A re-import requirement duplicates the operational backup, restore and MOVE path. None is retained.

## Revisit When

Revisit this decision only if the engineer accepts a new outward export product with a different audience contract. Future Kernel refinements must retain current administrator eligibility, exact creator binding and complete declared content.

## Affected Owners

The analytical export format stays unchanged. User Memory and Server Knowledge remain outside this Workspace bundle. No selective exporter, new permission tier, Policy Kernel feature, retained authorization record or compatibility reader is added. Ordinary portable import and its engine are removed by the separate backup/restore cutover, rather than extended to make outward export round-trip.

The owning criteria are [Workspace Backup, Export And Import](../specs/20260704-workspace_backup_export_import.md#personal-data-and-audience-coverage) and [Thread Visibility](../specs/20260909-thread_visibility_and_sharing.md#audit-and-portability). The engineer's export ruling and portability ruling are recorded together here; the operational backup/restore design remains with its own owner.
