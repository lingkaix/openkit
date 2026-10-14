---
status: Accepted
date: "2026-10-14"
decider: Engineer (UUIDv7 unification); Coordinator and Consultant (delegated acceptance)
---
# One Identifier Mechanism

## Decision

On 2026-10-14, the engineer chose to unify identifier generation on UUIDv7. The engineer named user, Workspace, and Thread identifiers as examples of the inconsistency. [Core Protocol](../core/protocol.md#ids) owns the shared generation and format rule; record owners retain allocation authority and their existing lifecycles.

On the same date, the coordinator and Consultant accepted the text form, scope of derived identifiers, and reduced prefix table under the engineer's delegated-acceptance ruling. The text form is a kind prefix, one underscore, and canonical lowercase UUIDv7 text in the 8-4-4-4-12 hexadecimal layout. Only a boundary whose parameter or field names the expected kind checks its prefix. Every other consumer keeps the identifier opaque. This realization is a delegated acceptance, not an engineer selection of the text form or table.

The shared function covers newly generated independent entity identifiers only. Request-derived Item, Artifact, Material, revision, Review, Light App, and record identifiers keep their owning derivation and retry contracts. Command request IDs, Workspace roots, Goal card and Plan revisions, and Light App indexes are not independent generated entity IDs in the table. External, provider-native, and adapter-native runtime identifiers are excluded and remain opaque.

Existing identifiers are not migrated because the deployment data that holds them is deleted before the change ships. This documentation change deletes no data. The continuity decision is separate from the accepted identifier realization.

## Reason

The unification source is Intent Revision 5 in change record 202610131730000000-v0_1_0_rc_6_prerelease. Its faithful English translation quotes the engineer: "identifier generation in the whole system is inconsistent, for example user ID, Workspace ID and Thread ID. Can we unify it into one mechanism, for example UUIDv7 everywhere?" The engineer's 2026-10-14 ruling selects UUIDv7 unification. The same revision records permission to delete the current deployment data instead of migrating its identifiers.

The delegated-acceptance source is ruling 9 in change record 202610140256550000-v0_1_0_core_experience. On 2026-10-14, coordinator and Consultant agreement accepted review decision 3, option B, and review decision 4, option A. That agreement also accepted a table limited to independent generated entity IDs. These selections replace the earlier TypeID proposal and its universal-allocation scope. The earlier draft incorrectly attributed those proposals to the engineer through its decider field.

A shared generator removes independent allocation algorithms. Canonical UUID text uses one familiar representation without a base32 codec. The prefix shows the kind in logs, paths, and APIs. A boundary that already names the kind can check the prefix without requiring every consumer to parse it. UUIDv7 supports lexical sorting by allocation time within one kind; different prefixes group kinds before time. Sorting proves neither event order nor authority.

UUIDv7 reveals creation time to the millisecond through its allocation timestamp. It provides less random entropy than UUIDv4 and cannot replace a secret credential. Clock differences and equal timestamps limit creation-order claims. This decision adds no timestamp parser, alternative identifier mechanism, or global sort key.

Existing request-derived identifiers let retries find the same result after a failure. Replacing those identifiers with fresh UUIDv7 values would change the retry proof. Delegated acceptance keeps those derivations with their owners instead of adding a replacement receipt or mapping design.

[Core Concepts](../core/core-concepts.md#identifier-semantics) owns identifier opacity and points to Core Protocol for the shared format. Storage Layout owns persistence, and Multi-User Workspace System owns identity and membership semantics. The shared format changes none of those allocation or lifecycle responsibilities.

## Rejected Alternatives

The engineer chose UUIDv7 unification instead of retaining inconsistent generators.

The coordinator and Consultant rejected TypeID base32 in favor of prefixed canonical UUIDv7 text. Base32 would add a codec and a different alphabet to paths, APIs, and prompts for a shorter representation. Bare UUIDv7 text was not selected because the prefix makes the kind visible and supports checks at a boundary that names the expected kind.

The coordinator and Consultant rejected replacing request-derived identifiers with fresh UUIDv7 values. Their owners already use deterministic derivation as retry proof. The wider table was also rejected because it mixed independent generated IDs with request correlation, derived IDs, authored names, projections, and revisions.

Migration of existing deployment identifiers remains excluded for this cutover. This decision adds no legacy reader or dual write.

## Revisit When

Revisit the independent-generation format if millisecond time disclosure becomes unacceptable or a required external boundary cannot carry the prefix. Revisit a prefix when an allocating owner adds or changes an independent generation path. A proposed change to request-derived identifiers must first address that owner's retry and recovery contract. This decision selects no dependency or generator placement.

## Affected Owners

- [Core Protocol](../core/protocol.md#ids): the shared generator, canonical UUIDv7 text, validation at boundaries that name the expected kind, independent-generation scope, exclusions, lifecycle invariants, acceptance predicates, and reduced prefix table.
- [Core Concepts](../core/core-concepts.md#identifier-semantics): the shared-format owner pointer and the exclusion of adapter-native runtime identifiers.
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md): independent identifier projections; deterministic review identity remains with this owner.
- [Multi-User Workspace System](../specs/20260715-multi_user_workspace_system.md): User, authentication, Workspace identity, membership, and Invitation projections.
- [Work Data Retention Format](../specs/20260921-work_data_retention_format.md#identifiers): independent Thread and Turn generation and the unchanged request-derived Item rule.
- [Generative Kernel Data Operations](../specs/20260908-generative_kernel_data_operations.md): independent collection and field generation; app and record UUIDv5 allocation and exact command replay remain unchanged.
- [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md): request-derived Item, Artifact, Material, revision, and Review identities remain unchanged.

Concrete schemas and implementations must project the shared rule only at independent generation paths. This decision changes no owner of derived identifiers, retry, recovery, storage, or authorization and does not decide the continuity boundary.
