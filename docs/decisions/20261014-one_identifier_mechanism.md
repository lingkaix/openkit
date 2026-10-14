---
status: Accepted
date: "2026-10-14"
decider: Engineer
---
# One Identifier Mechanism

## Decision

Identifier generation becomes one shared mechanism. The engineer named user, Workspace, and Thread identifiers as examples of the inconsistency and suggested UUIDv7. [Core Protocol](../core/protocol.md#ids) owns the shared generation and format rule; record owners retain their allocation authority and lifecycle.

The coordinator's proposed realization uses one shared function to generate UUIDv7 values under RFC 9562. Each new entity identifier uses a short kind prefix, an underscore, and the UUIDv7 in TypeID base32 form. The owner contains the current entity-kind prefix registry and kind-validation rule. Every consumer except the kind validator treats identifiers as opaque. Existing identifiers are not migrated because the deployment data that holds them is deleted before the change ships.

The engineer's recorded words do not select TypeID, exact prefixes, or the detailed validation and ordering rules. Those are coordinator proposals drafted by this assignment for Consultant scrutiny. This record attributes the unified mechanism and the reset ruling to the engineer; it does not attribute the proposed realization to the engineer.

## Reason

The source is Intent Revision 5 in change record 202610131730000000-v0_1_0_rc_6_prerelease. Its faithful English translation quotes the engineer: "identifier generation in the whole system is inconsistent, for example user ID, Workspace ID and Thread ID. Can we unify it into one mechanism, for example UUIDv7 everywhere?" The same revision records permission to delete deployment data and no compatibility obligation before a formal release. [Pre-Stable Data Continuity](20261014-pre_stable_data_continuity.md) records that separate ruling.

A shared generator removes independent allocation algorithms. The coordinator proposes TypeID to show entity kinds in logs, paths, and APIs, and to reject a wrong-kind identifier at admission. UUIDv7 provides sortable allocation timestamps within one kind. Prefixes group kinds, so complete identifiers do not sort globally by time. Sorting cannot prove event order, ownership, or authorization.

UUIDv7 exposes allocation time to the millisecond. This is a privacy trade-off of the proposal, even when consumers treat identifiers as opaque. It also provides less random entropy than UUIDv4. It cannot replace a secret credential. Clock differences and equal timestamps limit creation-order claims. The proposal keeps explicit timestamps, event sequences, authority checks, and record lifecycles.

[Core Concepts](../core/core-concepts.md#identifier-semantics) owns identifier opacity. Before this amendment, Core Protocol left encoding to record schemas; no reviewed owner supplied one shared entity-ID generation format. Storage Layout owns persistence, and Multi-User Workspace System owns identity and membership semantics. Core Protocol is the cohesive existing owner for the proposed shared format.

## Rejected Alternatives

The engineer selected unification over the current inconsistent generators. No other engineer-rejected format was recorded.

The coordinator proposes against bare UUIDv7 because it cannot show a kind or let a kind validator reject a different kind. It proposes against prefixed UUID text because TypeID supplies one compact canonical encoding. These alternatives remain open to Consultant challenge; they are not recorded engineer rejections.

Migration of existing identifiers is excluded by the reset ruling. The proposal also excludes permanent legacy readers and dual writes. Deterministic UUIDv5 and hash-derived entity identifiers need replacement, but their exact retry and recovery guarantees remain required through existing owners. This record does not select a replacement transaction or add a durable mapping owner.

## Revisit When

Revisit the realization if creation-time disclosure is unacceptable, kind prefixes impede a required external boundary, or a current retry or recovery contract cannot retain its guarantees. Revisit the prefix registry when an accepted owner adds an entity kind. A dependency choice or generator placement needs implementation evidence; this ruling selects neither.

## Affected Owners

- [Core Protocol](../core/protocol.md#ids): the shared generator, format, validators, exclusions, lifecycle invariants, acceptance predicates, and prefix registry.
- [Core Concepts](../core/core-concepts.md): identifier opacity and the distinction between entities and request correlation.
- [Contract Evolution](../core/contract-evolution.md#retained-data-continuity): the pre-stable data reset boundary.
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md): concrete UUID-derived paths, schemas, and storage projections.
- [Multi-User Workspace System](../specs/20260715-multi_user_workspace_system.md): users, authentication, Workspace identity, membership, and invitation projections.
- [Generative Kernel Data Operations](../specs/20260908-generative_kernel_data_operations.md): deterministic app and record allocation, kind schemas, native SQL names, and exact command replay.
- [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md): Material, revision, and Artifact Review identities and exact retry.

These dependent owners need alignment before builder work changes their concrete formats. This writer changes only Core Protocol and the continuity owner. It does not accept a new retry, recovery, storage, or authorization design.
