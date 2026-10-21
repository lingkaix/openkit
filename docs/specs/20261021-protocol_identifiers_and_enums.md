---
status: Accepted
implementation: Partial
kind: boundary
date: 2026-10-21
---
# Protocol Identifiers And Enums

This specification owns the concrete OpenKit entity identifier registry and derivation encoding, Item delta inventory, and closed protocol enum values.

## Owns

- Entity prefixes, fixed derivation namespaces, canonical name bytes, and kind-specific admission.
- Item delta kinds, item-to-delta combinations, payload correlation, framing, and validation.
- Ordered reasoning-effort values and protocol lifecycle enum inventories.

## Does Not Own

Record owners retain allocation, authority, lifecycle, retry, recovery, and deletion. This specification adds no entity, durable store, permission, or execution path. Operation identity and internal-role Tool admission retain their existing owners.

## Core References

- [Core Concepts](../core/core-concepts.md) owns shared record definitions and identifier opacity.
- [Core Protocol](../core/protocol.md) owns identifier grammar principles, delta semantics, lifecycle meaning, replay, and schema evolution.
- [AgentSession](../core/agent-session.md) owns execution continuity.
- [Contract Evolution](../core/contract-evolution.md) owns closed-core validation, retained-data continuity, and extension tolerance.

## Summary

The concrete inventories below project the accepted Core model. They retain the existing contracts without adding canonical concepts or changing allocation and lifecycle authority.

## Decision

Keep exact registries and wire-value inventories in this specification. Core retains their semantics and ownership boundaries. Machine-readable schemas remain the concrete validation source.

## Contract / Expected Behavior

## IDs

[Core Concepts](../core/core-concepts.md#identifier-semantics) owns identifier opacity. Consumers MUST NOT use an identifier's encoded time, routing, ownership, storage, or provider information as authority.

This document owns the shared text form and independent generation rule for OpenKit entity identifiers, and the output encoding of the derived kinds below. The machine-readable schemas define the concrete ID fields and project this rule into each record family. Each record owner retains allocation authority and its existing lifecycle. The decision is recorded in [One Identifier Mechanism](../decisions/20261014-one_identifier_mechanism.md).

Every new independently generated OpenKit entity identifier MUST use a UUIDv7 from one shared function, as defined by [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7). Each covered kind has one text form: its prefix, one underscore, and canonical lowercase UUID text. The UUID text MUST use the 8-4-4-4-12 hexadecimal layout with hyphens. The prefix MUST be nonempty. TypeID base32 is not this format.

If a covered kind's owner derives identifiers, its derived output MUST use [UUIDv5](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.5) in that same text form. The name is the owner's existing complete derivation input, in the canonical byte encoding below. Its existing scope, request, purpose, role, and other distinguishing inputs MUST remain unchanged. An existing discriminator carried by a longer output prefix remains part of the derivation input when the output uses the short kind prefix. This changes the output encoding, not allocation triggers or retry semantics.

Each kind has one fixed OpenKit namespace UUID. It is UUIDv5 in the RFC 9562 URL namespace `6ba7b811-9dad-11d1-80b4-00c04fd430c8`, with the UTF-8 name `openkit:entity-kind:` followed by its exact prefix. That definition fixes the namespace independently of any entity, deployment, request, or clock. The derived-family table gives the resulting constants for its current kinds. A namespace is a derivation constant, not a new entity or durable state.

The canonical name bytes are the UTF-8 output of the [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html), abbreviated JCS, applied to the owner's exact declared JSON name value. Each owner MUST state every input, its fixed array position or object member, and any literal purpose or role. JCS sorts object members recursively and preserves array order, value types, and string contents. Add no byte-order mark or trailing newline. Do not trim strings or normalize Unicode. Name length does not change UUIDv5 derivation. A derivation MUST use immutable admitted or recorded values, never a freshly read clock or random value. An owner with unstable inputs must resolve that owner before applying this encoding.

If a parameter or field names a covered entity kind, its admission validator MUST check that kind's prefix and canonical UUID text. The validator MUST accept version 7, and version 5 only when that kind's owner defines a derivation. It MUST check the RFC 9562 variant bits. A wrong-kind or malformed identifier MUST fail that validation before an effect. The validator MUST NOT infer allocation, ownership, or authority from the UUID version, coerce an older encoding, or infer a missing kind. Only a boundary whose parameter or field names the expected kind may check the prefix. Every other consumer MUST treat the complete identifier as opaque when storing, displaying, or forwarding it. Identifier lookup follows the owner's existing not-found, conflict, or access-denial contract.

Within one kind, lexical sorting of independently generated UUIDv7 identifiers follows their allocation timestamp. A derived UUIDv5 has no allocation-time ordering promise. Prefixes group different kinds before time. Identifiers MUST NOT replace event sequences, record timestamps, or explicit lineage as authority. Equal milliseconds, clock changes, and separate generators do not establish a total creation order. UUIDv7 reveals creation time to the millisecond through its allocation timestamp. Consumers MUST NOT extract that time for product behavior. The prefix makes the kind visible in logs, paths, and APIs; it grants no authority.

Derived identifiers remain with their allocating owners and retain their inputs, allocation triggers, and retry semantics. A prefixed identifier exposed in a field that names its kind uses that kind's UUIDv5 namespace and the shared text form. This includes derived Workspace, Thread, Turn, Item, Artifact, Material, Material revision, Artifact Review, and Knowledge Review identifiers. The shared independent generator MUST NOT replace a derived identifier with a fresh UUIDv7 value.

A derived value without a kind-named prefixed field remains opaque and owner-defined. Light App `appId` and record `recordId` currently carry bare owner-derived UUIDv5 values; their existing namespace and name rules remain unchanged. Command request IDs, composite keys, operation names, revision numbers, Workspace root selectors, Goal card and Plan revisions, and authored selector names remain outside this rule. A Light App index has no identifier.

For an independently generated entity identifier, the record owner MUST assign it once and preserve it through update, termination, replay, and restart. Recovery of that same record MUST preserve its identifier. If an accepted import or recovery contract independently generates a new entity identifier, it MUST use the shared function. An exact retry MUST follow the existing request and result owners rather than allocate a replacement identifier. If generation fails, the owner MUST fail creation before its effect. Missing, conflicting, stale, or unavailable authority MUST follow the record owner's existing failure contract; an identifier MUST NOT repair it. Identifier deletion follows the record owner's lifecycle and adds no separate lifecycle.

External, provider-native, and adapter-native runtime identifiers are excluded from the shared generator and remain opaque. A Codex thread ID is an adapter-native runtime identifier, not an OpenKit Thread ID. Such identifiers MUST NOT become Core protocol identity. An owning schema may retain them as explicit external references under an extension namespace or as private implementation projections. Content digests, secret credentials, and temporary-file nonces are also excluded. A content digest remains an integrity value rather than a generated entity identifier.

For this pre-stable cutover, existing identifiers are not migrated. The deployment data that holds them is deleted before the identifier change ships, under Retained Data Continuity in `docs/core/contract-evolution.md`. This documentation change performs no reset.

Acceptance requires UUIDv7 for independent generation and UUIDv5 for covered derivations, with one prefixed canonical UUID text form per kind. Identical namespace and canonical input bytes MUST produce the same derived output across retry and restart. A boundary that names a kind MUST reject a wrong prefix, malformed text, a wrong variant, and a UUID version that the kind does not permit. Other consumers MUST preserve opacity. Conformance also requires unchanged derivation inputs, allocation triggers, and exact retry and recovery semantics, exclusion of native and external identifiers, and no legacy reader for discarded identifiers.

### Independent Entity Kinds And Prefixes

This table names prefixes for independent generation paths. Workspace, Thread, and Turn also have owning derivations, so their named-kind validators accept both UUIDv7 and UUIDv5 in the same text form. A row does not require independent generation for a reference, projection, or revision. Each allocating owner decides when it independently generates an identifier under the shared rule.

| Entity kind | Prefix |
| --- | --- |
| User | `usr` |
| Workspace | `ws` |
| Knowledge Base | `kb` |
| Thread | `th` |
| Turn | `tu` |
| AgentSession | `as` |
| AutomationIdentity | `auto` |
| Recurring expired range | `range` |
| AuthSession | `auth` |
| Authentication account | `acct` |
| Authentication verification record | `verif` |
| Access Token record | `tok` |
| NanoHost transport Token record | `nhtok` |
| Invitation | `inv` |
| CapabilityCall | `cap` |
| PermissionDecision | `pd` |
| UsageRecord | `use` |
| AuditEvent, including Vault administration audit | `aud` |
| Deployment | `dep` |
| Knowledge source | `ks` |
| Knowledge observation | `ko` |
| Knowledge claim | `kc` |
| Knowledge conflict | `kf` |
| Knowledge retrieval trace | `krt` |
| Execution attempt | `attempt` |
| Worker storage binding | `wst` |
| VaultReference | `vault` |
| VaultGrant | `grant` |
| VaultUse | `vu` |
| Catalog candidate | `cand` |
| Light App collection | `col` |
| Light App field | `fld` |
| Generative presentation | `pres` |
| Workspace export | `wsexp` |
| Workspace backup | `wsbak` |
| Data-root backup | `drb` |

### Derived Entity Kinds And Namespaces

These kinds retain their owning derivations and use the same text form as any independent UUIDv7 allocation of that kind. Only a kind with an owning derivation admits UUIDv5. These constants encode existing identities; they add no independent allocation requirement.

| Entity kind | Prefix | Fixed namespace UUID |
| --- | --- | --- |
| Recurring occurrence | `occ` | `fc01b827-9017-53dc-b41b-387a2110d905` |
| Workspace | `ws` | `41710f31-94f8-5e51-9589-1744ce75680d` |
| Thread | `th` | `1ea1147f-0d1a-5ae4-ba03-7ba2cd6a0eea` |
| Turn | `tu` | `946f39c9-520d-5df2-985f-afaf05790c9d` |
| Item | `it` | `585ca877-60b4-584f-a217-02b4aea5c651` |
| Artifact | `ar` | `fbb6ef57-8026-536c-aa29-0892c321c113` |
| Workspace Material | `mat` | `68a8d824-718c-5c44-831a-3292e9846783` |
| Material revision | `mrev` | `c027bad1-40fa-5b1e-a480-421753232801` |
| Artifact Review | `arev` | `59bffd58-b464-5c91-917f-a066bc9ce605` |
| Knowledge Review | `kr` | `5e78300b-9458-5519-b104-d47e32923804` |
| CapabilityCall | `cap` | `b447467a-3e9c-5e36-b988-7b4961a0d817` |
| Stopped-server recovery Token, only the producer declared by the remote-auth owner | `tok` | `e87fb49e-00c1-53f3-adbd-a5cf0de72bcc` |
| AuditEvent | `aud` | `c3d8713d-557b-5bf8-aa9c-a28bf50775d4` |
| PermissionDecision | `pd` | `bcf1702a-4e6a-59c6-86ac-75352a8fc41d` |
| Knowledge retrieval trace | `krt` | `32a06e66-912c-53a4-b9d2-85b0a9edfe0b` |
| Workspace deletion recovery export, only the producer declared by Workspace Deletion | `wsexp` | `d8e266d0-77a0-5e91-b599-de82740626ff` |

Core MUST assign the IDs of Core-owned durable records according to their owning schema and accepted specification.

The `aud` admission covers only the three accepted boot-start, boot-outcome and shutdown producers. The `pd` admission covers only the admitted captured Pending Request execution decision. The `krt` admission covers only the direct Task-preparation and Coordinator direct-Task trace producers. The `cap` admission covers only Pending Request execution, mediated MCP, terminal-checkpoint runtime accounting and Workspace export accounting. Each allocating owner declares its complete immutable name under the [accepted producer decisions](../decisions/20261016-identifier_derivation_and_import_allocations.md). Other independent allocation of these kinds remains UUIDv7. The [accepted declaration boundary](../decisions/20261015-identifier_owner_declarations.md) requires owner-backed derivation authority for every producer; kind registration never authorizes another deterministic-looking call ID. A UUID validates shape, not current attribution, claim, permission or effect status. Existing record failure, retry, retention and recovery rules remain binding. Acceptance requires stable complete-name encoding across reopen, correct kind admission, unchanged contact counts and refusal before effects on malformed or wrong-kind input.

Clients and channel adapters MUST assign `requestId` values for mutating commands.

Protocol timestamps MUST be RFC3339 strings assigned by Core for Core-created records and events. Event ordering MUST use `sequence`; timestamps are for human time, indexing, and cross-system correlation.

## Item Delta Kinds

OpenKit separates item lifecycle events from item-type-specific streaming updates.

Each item type MUST declare which item delta kinds it supports.

The OpenKit delta taxonomy should be easy for runtime adapters to project from native event streams while remaining OpenKit-owned.

Core item delta kinds are a closed enum:

| Delta kind | Source shape category | Meaning |
| --- | --- |
| `text-delta` | Text stream append | Append ordinary text to a text-bearing item. |
| `indexed-text-delta` | Named content-part text stream | Append text to a named or indexed content part inside an item. |
| `part-started` | Section or part boundary | Mark a new streamed part or section boundary inside an item. |
| `output-delta` | Execution output stream | Append stdout, stderr, terminal, or log output to an execution-like item. |
| `snapshot-updated` | Structured snapshot replacement | Replace a structured preview or aggregate snapshot for an item or turn-visible view. |
| `progress-updated` | Progress notification | Update non-terminal progress or review state for an item. |
| `request-started` | Pending request creation | Attach a pending request to an item while the item remains in progress. |
| `request-resolved` | Pending request resolution | Resolve or clear an item-scoped request. |
| `interaction-delta` | Interactive or realtime stream | Stream interactive terminal, voice, media, or realtime interaction content. |
| `artifact-updated` | Artifact projection update | Update artifact metadata, preview, or pointer associated with an item. |
| `context-injection-updated` | Context projection update | Record knowledge-derived context selected or injected for the turn. |

Low-level payload operations such as append, replace, and patch MAY appear inside a typed delta payload, but they are not the top-level item delta kind.

Agents and adapters MUST NOT introduce vendor-specific streaming modes by hiding them inside an existing delta kind. A new streaming mode requires a new item delta kind, a protocol compatibility note, and conformance fixtures.

Initial item-to-delta guidance:

| Item type | Delta kinds |
| --- | --- |
| `user-message` | `snapshot-updated` |
| `assistant-message` | `text-delta`, `indexed-text-delta`, `part-started`, `progress-updated`, `request-started`, `request-resolved`, `snapshot-updated` |
| `plan` | `text-delta`, `progress-updated`, `snapshot-updated` |
| `reasoning` | `text-delta`, `indexed-text-delta`, `part-started`, `progress-updated`, `snapshot-updated` |
| `command-execution` | `output-delta`, `interaction-delta`, `progress-updated`, `request-started`, `request-resolved`, `snapshot-updated` |
| `file-change` | `progress-updated`, `snapshot-updated` |
| `tool-call` | `request-started`, `request-resolved`, `progress-updated`, `snapshot-updated` |
| `context-injection` | `context-injection-updated`, `snapshot-updated` |
| `approval-request` | `progress-updated`, `snapshot-updated` |
| `approval-decision` | `snapshot-updated` |
| `user-input-request` | `progress-updated`, `snapshot-updated` |
| `user-input-response` | `snapshot-updated` |
| `agent-handoff` | `progress-updated`, `snapshot-updated` |
| `artifact-reference` | `artifact-updated`, `snapshot-updated` |
| `status` | `progress-updated`, `snapshot-updated` |

`item.delta` events MUST include `deltaKind`.

Delta payloads are selected by `deltaKind`, not by a generic string field.

Text-like delta kinds carry `delta`, `indexed-text-delta` and `part-started` carry `partId`, request delta kinds carry `requestRefId`, and artifact, context, progress, and snapshot updates carry bounded structured payloads.

`item.completed` remains authoritative. Clients MAY render streamed deltas optimistically, but they MUST reconcile the item with the completed payload.

`artifact-reference` is the canonical artifact item type. It is used when the item log needs to anchor a durable artifact record in workspace, thread, and turn history.

Adding an item delta kind is a compatibility-sensitive protocol change.

### Delta Correlation Fields

`request-started` deltas MUST include `requestRefId`.

`request-resolved` deltas MUST include the same `requestRefId` as the request they resolve.

`part-started` deltas MUST include `partId`.

`indexed-text-delta` deltas MUST include `partId` or another item-type-defined part reference that was previously introduced by `part-started` or by the initial item payload.

`requestRefId` and `partId` are item-local identifiers unless a future schema explicitly declares them as core durable IDs.

### Request Modeling Rules

Independent `approval-request` items are for session-level, permission-level, workspace-level, or cross-tool approvals.

`request-started` deltas on `tool-call`, `command-execution`, `file-change`, or similar items are for inline approval, elicitation, or review requests that belong to that specific item.

Core and adapters SHOULD avoid representing the same human decision as both an independent `approval-request` item and an inline `request-started` delta.

### Snapshot Size Rules

`snapshot-updated` is intended for bounded structured previews and aggregate state that are reasonable to resend as a whole.

Large diffs, long terminal output, long files, media, and other high-volume content SHOULD use `output-delta`, `part-started` plus indexed deltas, workspace-plane pointers, or artifact-plane pointers instead of repeated full snapshots.

If OpenKit needs fine-grained structured patching later, it should add a new explicit item delta kind instead of overloading `snapshot-updated`.

### Interaction Framing Rules

`interaction-delta` may carry text, structured interaction events, base64 payloads for small binary fragments, or pointers to workspace-plane or artifact-plane content.

Large binary content such as screenshots, audio, video, browser captures, or terminal recordings SHOULD travel through the workspace plane or artifact plane and be referenced from the delta payload.

Control-plane streams SHOULD NOT carry large binary blobs inline.

### Context Injection Rules

A turn should use at most one `context-injection` item for Core-mediated knowledge or context unless there is a clear product reason to split it.

Multiple context selections or injections during the same turn should be represented as `context-injection-updated` deltas on that item so UI clients can fold worker context cleanly.

### Delta Validation

Core MUST validate each `item.delta` against the declared item type and delta kind table for the active protocol version.

If an agent emits an undeclared item type and delta kind combination, Core MUST treat it as a protocol violation.

Protocol violations SHOULD be dropped from the product item log, recorded as audit events, and reported through a stable `core.protocol.*` error code where feedback to the caller or adapter is available.

## Canonical Enums

This section is the human-readable source for core closed enum families. Generated machine-readable schemas remain the validation source for concrete implementations.

Reasoning effort, ordered from lowest to highest:

```text
none
minimal
low
medium
high
xhigh
max
```

Turn status:

```text
pending
running
completed
interrupted
cancelled
failed
```

Approval status:

```text
pending
granted
denied
expired
superseded
withdrawn
```

Item delta kind:

```text
text-delta
indexed-text-delta
part-started
output-delta
snapshot-updated
progress-updated
request-started
request-resolved
interaction-delta
artifact-updated
context-injection-updated
```

AgentSession status:

```text
created
initializing
ready
busy
idle
degraded
interrupted
failed
closed
```

## Current Implementation Projection

The shared protocol package supplies schemas, identifier allocation and derivation, and conformance fixtures. Its concrete implementations remain subject to the contracts above; this relocation makes no activation claim.

## Rollout / Migration Plan

This change relocates documentation and updates inbound references. It changes no identifier, enum value, retained record, wire shape, capture implementation, or runtime behavior. The existing identifier cutover boundary above remains binding and this relocation performs no data reset.

## Testing Strategy / Acceptance Criteria

- Preserve every prefix, namespace constant, name-encoding rule, exclusion, and allocation or retry qualifier below the IDs heading.
- Verify canonical derivation bytes and kind-specific validation across retry and restart under the existing identifier acceptance contract.
- Verify item-type/delta-kind admission, correlation, bounded payloads, and completed-Item reconciliation under the existing delta contract.
- Verify closed enum values and reasoning-effort order against the machine-readable schema projections.
- Check inbound links and regenerate the documentation index after relocating these inventories.
