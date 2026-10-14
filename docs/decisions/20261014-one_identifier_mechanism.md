---
status: Accepted
date: "2026-10-14"
decider: Engineer (UUIDv7 unification); Coordinator and Consultant under delegated acceptance (realization)
---
# One Identifier Mechanism

## Decision

On 2026-10-14, the engineer proposed UUIDv7 unification as a question, the coordinator recommended it, and the engineer then confirmed it. Verbatim: "统一使用 UUIDv7：确认". Translation: "Use UUIDv7 everywhere: confirmed."

The coordinator and Consultant agreed on prefixed canonical UUID text, preservation of derivation inputs and retry semantics, and a table limited to current entity kinds. Ruling 9 delegates ordinary acceptance when they agree. It leaves blockers, authorizations, important problems, and disagreements with the engineer. [Core Protocol](../core/protocol.md#ids) owns the format and encoding; record owners retain allocation authority and their existing lifecycles.

Independent allocation uses UUIDv7. A kind with an owning derivation keeps its existing complete input and retry semantics, and encodes that input as UUIDv5 in one fixed OpenKit namespace per kind. Both use the same kind prefix, one underscore, and canonical lowercase UUID text in the 8-4-4-4-12 layout. Only a boundary whose field or parameter names the kind checks that prefix. It accepts version 7, and version 5 only for a kind with an owning derivation. Every other consumer keeps the identifier opaque.

Covered derived outputs include Workspace, Thread, Turn, Item, Artifact, Material, Material revision, Artifact Review, and Knowledge Review. The output encoding changes; inputs, allocation triggers, publication, and retry and recovery rules do not. Light App and record fields carry bare UUIDv5 values without the shared prefix, so they remain opaque owner-defined values with their existing namespace and name rules. Command request IDs, Workspace root selectors, Goal card and Plan revisions, and Light App indexes remain outside the independent entity table. External, provider-native, and adapter-native runtime identifiers remain excluded and opaque.

Existing identifiers are not migrated because the deployment data that holds them is deleted before the change ships. This documentation change deletes no data. The continuity decision is a separate record.

## Reason

The source is Intent Revision 5 in change record 202610131730000000-v0_1_0_rc_6_prerelease. The engineer's exact question was: "比如我们统一使用 uuidv7, 你认为呢？" Translation: "For example, should we use UUIDv7 everywhere? What do you think?" The coordinator recommended unification. The next engineer message permits deletion of the current deployment data instead of identifier migration and says compatibility need not be considered because no formal release exists. The engineer confirmed UUIDv7 explicitly later the same day, as quoted in the Decision section.

Rulings 8 and 9 are present in change record 202610140256550000-v0_1_0_core_experience on the rebased branch. Ruling 8 accepts the Retrieval Kernel specification. Ruling 9 supplies delegated acceptance; it does not select an identifier algorithm. Coordinator and Consultant agreement covers the realization only; the engineer's confirmation covers the choice of UUIDv7.

A shared generator removes independent allocation algorithms. Canonical UUID text uses one familiar representation without a base32 codec. The prefix shows the kind in logs, paths, and APIs. A boundary that already names the kind can check the prefix without requiring every consumer to parse it. UUIDv7 supports lexical sorting by allocation time within one kind; different prefixes group kinds before time. Derived UUIDv5 values have no allocation-time ordering promise. Sorting proves neither event order nor authority.

UUIDv7 reveals creation time to the millisecond through its allocation timestamp. It provides less random entropy than UUIDv4 and cannot replace a secret credential. Clock differences and equal timestamps limit creation-order claims. This decision adds no timestamp parser or global sort key. It adds no mechanism to hide the disclosed time.

Existing derivation inputs let retries find the same result after a failure. Replacing a derived identifier with fresh UUIDv7 would change that proof. UUIDv5 preserves repeatability while giving mixed kinds one text form and one kind check. The fixed namespace for each prefix is derived once from the standard URL namespace and the name `openkit:entity-kind:` plus that prefix. Canonical names use RFC 8785 JSON Canonicalization Scheme bytes of each owner's declared complete JSON value. Array positions and existing purpose or role inputs remain fixed; canonical sorting removes dependence on object-member insertion order. This selects output encoding only; it adds no business input, durable mapping, or retry design.

[Core Concepts](../core/core-concepts.md#identifier-semantics) owns identifier opacity and points to Core Protocol for the shared format. Storage Layout owns persistence, and Multi-User Workspace System owns identity and membership semantics. The shared format changes none of those allocation or lifecycle responsibilities.

## Rejected Alternatives

Keeping the existing inconsistent generators was rejected because each kind would keep its own allocation algorithm and text form.

The coordinator and Consultant rejected TypeID base32 in favor of prefixed canonical UUID text. Base32 would add a codec and a different alphabet to paths, APIs, and prompts for a shorter representation. Bare UUID text was not selected because the prefix makes the kind visible and supports checks at a boundary that names the expected kind.

The coordinator and Consultant rejected replacing derived identifiers with fresh UUIDv7 values. Their owners already use deterministic derivation as retry proof. Keeping different derived text forms within a covered kind was rejected because a kind check would reject valid owner-derived values. UUIDv5 output preserves the inputs and repeatability instead. The wider table was also rejected because it mixed independent generated IDs with request correlation, derived IDs, authored names, projections, and revisions.

Migration of existing deployment identifiers remains excluded for this cutover. This decision adds no legacy reader or dual write.

## Revisit When

Revisit the independent-generation format if millisecond time disclosure becomes unacceptable or a required external boundary cannot carry the prefix. Revisit a prefix when an allocating owner adds or changes an independent generation path. A proposed change to derivation inputs or allocation triggers must first address that owner's retry and recovery contract. This decision selects no dependency or generator placement.

## Affected Owners

- [Core Protocol](../core/protocol.md#ids): the shared text form, UUIDv7 generation, fixed kind namespaces, canonical derivation-name bytes, UUIDv5 output, validation at boundaries that name a kind, exclusions, and acceptance predicates.
- [Core Concepts](../core/core-concepts.md#identifier-semantics): the shared-format owner pointer and the exclusion of adapter-native runtime identifiers.
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md): derived Material, revision, Review, and follow-up Turn output encoding; transaction and uniqueness owners remain unchanged.
- [Multi-User Workspace System](../specs/20260715-multi_user_workspace_system.md): Quick Chat Workspace output encoding; the canonical-user input and authorization predicates remain unchanged.
- [Work Data Retention Format](../specs/20260921-work_data_retention_format.md#identifiers): UUIDv7 for independent allocation and UUIDv5 for derived Thread, Turn, and Item output, without changing derivation or retention semantics.
- [Generative Kernel Data Operations](../specs/20260908-generative_kernel_data_operations.md): independent collection and field generation; app and record UUIDv5 allocation and exact command replay remain unchanged.
- [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md): UUIDv5 output for derived Item, Artifact, Material, revision, Review, and introduction Turn identities, with unchanged inputs and retry predicates.
- [Chat Mode Assistant](../specs/20260704-chat_mode_assistant.md): derived Chat and handoff output encoding, including frozen outcome-source scope, with unchanged inputs and replay rules.
- [Knowledge Store Implementation](../specs/20260703-knowledge_store_implementation.md): Knowledge Review output encoding with unchanged scope, proposal, request, append, and retry semantics.
- [Pending Requests](../specs/20260930-pending_requests.md): Item output encoding with unchanged request/role inputs and publication and restart-completion rules.

Concrete schemas and implementations must preserve the independent-versus-derived allocation choice made by each owner. This decision changes covered derived output encodings only, and selects no new retry, recovery, storage, authorization, or continuity rule.
