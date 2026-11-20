---
status: Accepted
implementation: Partial
kind: boundary
aspect: protocol
---
# Protocol Identifiers And Enums

This specification is the single owner of the OpenKit entity identifier registry and derivation encoding, the canonical structured-value digest encoding and its named retained exceptions, the Item delta inventory and item-to-delta matrix, and closed protocol enum values.

## Scope

Owns entity prefixes, fixed UUIDv5 derivation namespaces, canonical name bytes, kind-specific identifier admission, canonical structured-value JSON encoding and SHA-256 digest rules (`@openkit/protocol`), named retained digest and identity exceptions, Item types and delta kinds, item-to-delta combinations, delta correlation and validation, ordered reasoning-effort values, and closed protocol lifecycle and boundary enums.

Does not own:
- Record allocation authority, lifecycle, retry, recovery, or deletion ([Core Concepts](../core/core-concepts.md), [Protocol](../core/protocol.md), and each record owner).
- Record envelope fields, required-feature registration, or digest-reference migration closure ([Schema Evolution And Record Envelope](20260703-schema_evolution_record_envelope.md)).
- Public operation identifiers, agent-facing Tool naming, or operation descriptor enums ([Operation Definition](20261002-operation_definition.md)).
- Worker MCP process health states ([Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md)).

Core: [Core Concepts](../core/core-concepts.md), [Protocol](../core/protocol.md), [AgentSession](../core/agent-session.md), [Contract Evolution](../core/contract-evolution.md).

## IDs

[Core Concepts](../core/core-concepts.md#identifier-semantics) owns identifier opacity. Consumers MUST NOT use an identifier's encoded time, routing, ownership, storage, or provider information as authority.

This document owns the shared text form and independent generation rule for OpenKit entity identifiers, and the output encoding of the derived kinds below. The machine-readable schemas in `@openkit/protocol` define the concrete ID fields and project this rule into each record family. Each record owner retains allocation authority and its lifecycle.

Every new independently generated OpenKit entity identifier MUST use a UUIDv7 from one shared function, as defined by [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7). Each covered kind has one text form: its prefix, one underscore, and canonical lowercase UUID text. The UUID text MUST use the 8-4-4-4-12 hexadecimal layout with hyphens. The prefix MUST be nonempty. TypeID base32 is not this format.

If a covered kind's owner derives identifiers, its derived output MUST use [UUIDv5](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.5) in that same text form. UUIDv5 hashes the 16-byte namespace UUID plus the canonical UTF-8 name bytes with SHA-1 and sets version 5 and RFC 9562 variant bits; it is not a SHA-256 content digest. The name is the owner's complete derivation input, in the canonical byte encoding below. Its scope, request, purpose, role, and other distinguishing inputs MUST remain unchanged. An existing discriminator carried by a longer output prefix remains part of the derivation input when the output uses the short kind prefix. This rule governs output encoding, not allocation triggers or retry semantics.

Each kind has one fixed OpenKit namespace UUID. It is UUIDv5 in the RFC 9562 URL namespace `6ba7b811-9dad-11d1-80b4-00c04fd430c8`, with the UTF-8 name `openkit:entity-kind:` followed by its exact prefix. That definition fixes the namespace independently of any entity, deployment, request, or clock. The derived-family table gives the resulting constants for its current kinds. A namespace is a derivation constant, not a new entity or durable state.

The canonical name bytes are the UTF-8 output of the [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html) (JCS) applied through `canonicalIdentifierName` in `@openkit/protocol` to the owner's exact declared JSON name value. Each owner MUST state every input, its fixed array position or object member, and any literal purpose or role. `canonicalIdentifierName` uses the shared JCS encoder in Canonical Structured-Value Digests below and additionally MUST reject `undefined` object members so derivation tuples stay complete. Name length does not change UUIDv5 derivation. A derivation MUST use immutable admitted or recorded values, never a freshly read clock or random value. An owner with unstable inputs MUST resolve that input before applying this encoding.

If a parameter or field names a covered entity kind, its admission validator MUST check that kind's prefix and canonical UUID text. The validator MUST accept version 7, and version 5 only when that kind's owner defines a derivation. It MUST check the RFC 9562 variant bits. A wrong-kind or malformed identifier MUST fail validation before an effect. The validator MUST NOT infer allocation, ownership, or authority from the UUID version, coerce an older encoding, or infer a missing kind. Only a boundary whose parameter or field names the expected kind may check the prefix. Every other consumer MUST treat the complete identifier as opaque when storing, displaying, or forwarding it. Identifier lookup follows the owner's not-found, conflict, or access-denial contract.

Within one kind, lexical sorting of independently generated UUIDv7 identifiers follows their 48-bit millisecond allocation timestamp. A derived UUIDv5 has no allocation-time ordering promise. Prefixes group different kinds before time. Identifiers MUST NOT replace event sequences, record timestamps, or explicit lineage as authority. Equal milliseconds, clock changes, and separate generators do not establish a total creation order. Consumers MUST NOT extract the UUIDv7 timestamp for product behavior. The prefix makes the kind visible in logs, paths, and APIs; it grants no authority.

Derived identifiers remain with their allocating owners and retain their inputs, allocation triggers, and retry semantics. A prefixed identifier exposed in a field that names its kind uses that kind's UUIDv5 namespace and the shared text form. This includes derived Workspace, Thread, Turn, Item, Artifact, Material, Material revision, Artifact Review, and Knowledge Review identifiers. The shared independent generator MUST NOT replace a derived identifier with a fresh UUIDv7 value.

A derived value without a kind-named prefixed field remains opaque and owner-defined. Light App `appId` and record `recordId` carry bare owner-derived UUIDv5 values; Light App `col_` and `fld_` identifiers reuse prior admitted IDs across schema evolution or allocate fresh UUIDv7 values; Knowledge Proposal `kp_` identifiers use a `kp_`-tagged SHA-256 JCS digest; and Worker Context Package IDs use literal `ctxpkg_${turnId}`, as listed in Canonical Structured-Value Digests below. Command request IDs, composite receipt keys (`command + '|' + requestId + '|' + scopeKey`), operation names, revision numbers, Workspace root selectors, Goal card and Plan revisions, and authored selector names remain outside the entity identifier rule. A Light App index has no identifier.

For an independently generated entity identifier, the record owner MUST assign it once and preserve it through update, termination, replay, and restart. Recovery of that same record MUST preserve its identifier. If an accepted import or recovery contract independently generates a new entity identifier, it MUST use the shared function. An exact retry MUST follow the request and result owners rather than allocate a replacement identifier. If generation fails, the owner MUST fail creation before its effect. Missing, conflicting, stale, or unavailable authority MUST follow the record owner's failure contract; an identifier MUST NOT repair it. Identifier deletion follows the record owner's lifecycle and adds no separate lifecycle.

External, provider-native, and adapter-native runtime identifiers are excluded from the shared generator and remain opaque. A Codex thread ID is an adapter-native runtime identifier, not an OpenKit Thread ID. Such identifiers MUST NOT become Core protocol identity. An owning schema may retain them as explicit external references under an extension namespace or as private implementation projections. Content digests, secret credentials, and temporary-file nonces are also excluded. A content digest remains an integrity value rather than a generated entity identifier.

Pre-stable identifiers from before the UUIDv7/UUIDv5 cutover are not migrated; deployment data holding them is disposed of under [Contract Evolution](../core/contract-evolution.md#retained-data-continuity), with no legacy reader for discarded identifier encodings.

Identical namespace and canonical input bytes MUST produce the same derived output across retry and restart.

### Independent Entity Kinds And Prefixes

This table names prefixes for independent generation paths. Workspace, Thread, Turn, Item, Artifact, Material, Material revision, Artifact Review, Knowledge Review, CapabilityCall, Access Token, AuditEvent, PermissionDecision, Knowledge retrieval trace, and Workspace export also have owning derivations, so their named-kind validators accept both UUIDv7 and UUIDv5 in the same text form where declared below. A row does not require independent generation for a reference, projection, or revision.

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

These kinds retain their owning derivations and use the same text form as any independent UUIDv7 allocation of that kind. Only a kind with an owning derivation admits UUIDv5.

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

The `aud` admission covers only the three accepted boot-start, boot-outcome, and shutdown producers. The `pd` admission covers only the admitted captured Pending Request execution decision. The `krt` admission covers only the direct Task-preparation and Coordinator direct-Task trace producers. The `cap` admission covers only Pending Request execution, mediated MCP, terminal-checkpoint runtime accounting, and Workspace export accounting. Knowledge Review `kr` derives from `{ownerScope, proposalId, requestId}`, and Generative UI answer-source Item `it` derives from `["generative-ui.publish", workspaceId, actor.id, requestId, "answer-source"]`. Each allocating owner declares its complete immutable name under the [accepted producer decisions](../decisions/20261016-identifier_derivation_and_import_allocations.md). Other independent allocation of these kinds remains UUIDv7. The [accepted declaration boundary](../decisions/20261015-identifier_owner_declarations.md) requires owner-backed derivation authority for every producer; kind registration never authorizes another deterministic-looking call ID. A UUID validates shape, not current attribution, claim, permission, or effect status.

Clients and channel adapters MUST assign UUID `requestId` values for mutating commands. These unprefixed command identities remain separate from entity identifiers.

Protocol timestamps MUST be RFC 3339 strings assigned by Core for Core-created records and events. Event ordering MUST use `sequence`; timestamps are for human time, indexing, and cross-system correlation.

### Cross-Owner Storage Receipts

For an internal cross-owner command, derive the bare request UUID with UUIDv5 in the RFC URL namespace. Its name is the complete UTF-8 JCS encoding of `["openkit:storage-receipt:v1", deploymentId, sourceOwner, verb, occurrenceKey]`. Use the exact deployment and source-owner identities and the original occurrence. Inbound occurrence identity binds channel kind, event family and authenticated external event coordinates across principals. Retain the tuple. Compare target, expected generation and semantic input hash independently of UUID equality. A changed request conflicts. Public request IDs keep their existing contract. Keep the permanent channel-neutral `channel.inbound` key separate from external-trigger deduplication. The [deciding owner](20261019-durable_execution_and_control_store.md#cross-owner-command-settlement) retains the receipt or equivalent uniqueness for the replay horizon. The initiator settles its original intent and publishes once only when that receipt permits publication.

## Canonical Structured-Value Digests

New structured-value digests MUST use the shared browser-safe canonical JSON encoder (`canonicalJsonText` in `@openkit/protocol`) and lowercase hexadecimal SHA-256 (`sha256CanonicalJson` in the Node-only `@openkit/protocol/digest` subpath), unless an owning specification and the table below declare a retained exception. The browser root of `@openkit/protocol` MUST NOT import Node crypto. `sha256CanonicalJson(value)` returns untagged lowercase hex; callers own any `sha256:`, `ctxpkg_sha256_`, or `kp_` prefix and domain framing.

`canonicalJsonText` implements RFC 8785 (JCS): it emits recursive object members directly in UTF-16 code-unit order (including integer-looking keys, without building an intermediate object that would reorder numeric-index keys under ECMAScript enumeration), preserves array order and valid Unicode string contents without normalization, formats finite numbers using ECMAScript JSON text, and emits UTF-8 without a byte-order mark or trailing newline. It admits `null`, booleans, finite numbers, valid Unicode strings, arrays, and plain objects (including null-prototype objects). It MUST reject root `undefined`, `undefined` array elements, sparse arrays, named array properties, symbol keys or values, functions, `bigint`, nonfinite numbers, class instances, cycles, and invalid Unicode, and MUST NOT invoke class `toJSON` conversions or coerce rejected values to `null`. The general encoder omits `undefined` object members; `canonicalIdentifierName` and `policyDigest` enforce the stricter complete-name rule and MUST reject `undefined` object members.

Exact original file or payload bytes, binary framing, and incremental stream hashes are not canonical JSON; readers verify them by hashing exact stored bytes. Digest-reference stability and one-way migration closure rules belong to [Schema Evolution And Record Envelope](20260703-schema_evolution_record_envelope.md#canonical-structured-values-and-exact-bytes).

Retained values and derived identities that use owner-specific framing, serializers, or algorithms on `main` are named exceptions; readers and writers MUST preserve their existing form until an accepted migration changes the complete reference closure:

| Surface / owner | Retained form on `main` |
| --- | --- |
| Covered derived entity IDs | `<kind>_` + UUIDv5(`namespace[kind]`, UTF-8(`canonicalIdentifierName(name)`)). Name bytes are strict complete-name JCS; UUIDv5 hashes namespace + name with SHA-1 per RFC 9562. |
| Generic command receipt semantic-input hash and Generative Kernel semantic fingerprint | `sha256:` + SHA-256 of local `stableJson(input)` (recursively emits UTF-16-sorted object entries, omits `undefined` object members, preserves array order, coerces primitive `undefined` to `null`). Generative Kernel hashes `{actor: context.actor, ...spec.input}` while keeping `{workspaceId, appId}` in the receipt scope key (`command + '\|' + requestId + '\|' + scopeKey`). |
| Light App `appId` and `recordId` | Bare UUIDv5 over literal UTF-8 strings: `appId` uses RFC URL namespace `6ba7b811-9dad-11d1-80b4-00c04fd430c8` and `openkit:kernel.apps.create:${workspaceId}:${requestId}` (with `ws_` prefix retained); `recordId` uses parsed 16-byte `appId` namespace and `kernel.records.create:${requestId}:${entryIndex}` (ordinal `0` for standalone) or `kernel.records.batch:${requestId}:${entryIndex}`. |
| Admitted Light App schema digest / `definitionVersion` | `sha256:` + SHA-256 of `JSON.stringify(admitted) + '\n'` (exact serialized definition file bytes including trailing newline). |
| Knowledge Proposal `kp_` identity | `kp_` + untagged SHA-256 of JCS `{ownerScope, requestId}`, where `ownerScope` is the complete `{kind:'workspace',workspaceId}`, `{kind:'user',userId}`, or `{kind:'server'}` object. |
| Knowledge Proposal document digest | `sha256:` + SHA-256 of exact serialized Proposal Markdown bytes (`\n`-joined lines, or retained original bytes for unchanged admitted Workspace core). |
| Notebook-change Proposal `contentDigest` | `sha256:` + SHA-256 of `JSON.stringify(changes)` over the prepared ordered path/content change array (Server Knowledge and User Memory). |
| Knowledge retrieval `requestDigest` | `sha256:` + SHA-256 of owner `canonicalJson({queryContext, sourceScope, caller: input.caller, request})`, which recursively sorts object keys by UTF-8 byte order, constructs plain objects (subject to JS integer-index key ordering), and calls `JSON.stringify`. |
| Conversation retrieval `requestDigest` | `sha256:` + SHA-256 of insertion-order `JSON.stringify({query, workspaceId, threadId, turnId})`. |
| Session-static `SessionCompatibilityKey` | Base digest is `sha256:` + SHA-256 of local `stableJson({agent, backend, control: sessionStaticControl(control), layout, policy, runtime, vault})` with absent components as `null` and Turn-specific sinks removed; final NanoCore key is `sha256:` + SHA-256 of insertion-order `JSON.stringify({sessionWorkspaceKey: baseDigest, allowedLogicalModelIds: sortedAllowedIds})`. |
| NanoHost `AgentSessionCompatibilityKey` | Untagged `sha256CanonicalJson({nativeConversation: {adapterId, adapterVersion, harnessCompatibilityKey}, sessionCompatibilityKey, threadId})`. |
| Worker Context Package ID and digests | Package ID is literal `ctxpkg_${turnId}`; trace digest is `ctxpkg_sha256_` + SHA-256 of owner `canonicalJson(traceWithoutDigest)` over the retained representation before public normalization; package-root digest is `sha256:` + SHA-256 of serialized delivery inventory; WMR policy digest hashes owner-serialized `{backendKind, packageSnapshotId, requiredCapabilities: [...input]}`; file and worker-request digests hash exact bytes. The owner serializer constructs UTF-16-sorted objects before `JSON.stringify` (integer-looking keys follow JS enumeration order). |
| Policy and runtime configuration digests | `policyDigest(value)` is `sha256:` + SHA-256 of complete-name JCS (refusing `undefined` object members). Loaded runtime configuration `contentHash` is untagged `sha256CanonicalJson(snapshotSemanticSummary(snapshot))`. Fixed `policySnapshotId` labels (`runtime_config_gateway_policy`, `worker_turn_launch_policy`, `policy_snapshot_runtime`) are literal identifiers, not content digests. |
| Generative UI digests | `semanticInputHash` is `sha256:` + SHA-256 of insertion-order `JSON.stringify({threadId, turnId, title, fallbackText, messages, source, actions})` before answer shorthand normalization; presentation `contentDigest` hashes `JSON.stringify(messages)`; Item-source digest hashes exact UTF-8 source text. |
| AEP snapshot and OpenAPI projection digests | AEP snapshot digest is untagged SHA-256 of `JSON.stringify(snapshot)`. OpenAPI `x-openkit-source-digest` is `sha256:` + SHA-256 of insertion-order `JSON.stringify({components, info, openapi, paths, protocolVersion, operationStability})`. |

## Item Delta Kinds

OpenKit separates item lifecycle events from item-type-specific streaming updates. Each item type MUST declare which item delta kinds it supports.

Core item delta kinds are a closed 11-value enum (`ItemDeltaKindSchema` in `@openkit/protocol`):

| Delta kind | Source shape category | Meaning |
| --- | --- | --- |
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
| `knowledge-injection-updated` | Context projection update | Record knowledge-derived context selected or injected for the turn. |

Low-level payload operations such as append, replace, and patch MAY appear inside a typed delta payload, but they are not top-level item delta kinds. Agents and adapters MUST NOT introduce vendor-specific streaming modes by hiding them inside an existing delta kind. A new streaming mode requires a new item delta kind, a protocol compatibility note, and conformance fixtures. Adding an item delta kind is a compatibility-sensitive protocol change.

Core item types are a closed 17-value enum (`ItemTypeSchema` in `@openkit/protocol`) with the following allowed delta kinds:

| Item type | Delta kinds |
| --- | --- |
| `user-message` | `snapshot-updated` |
| `assistant-message` | `text-delta`, `indexed-text-delta`, `part-started`, `progress-updated`, `request-started`, `request-resolved`, `snapshot-updated` |
| `plan` | `text-delta`, `progress-updated`, `snapshot-updated` |
| `reasoning` | `text-delta`, `indexed-text-delta`, `part-started`, `progress-updated`, `snapshot-updated` |
| `command-execution` | `output-delta`, `interaction-delta`, `progress-updated`, `request-started`, `request-resolved`, `snapshot-updated` |
| `file-change` | `progress-updated`, `snapshot-updated` |
| `tool-call` | `request-started`, `request-resolved`, `progress-updated`, `snapshot-updated` |
| `knowledge-injection` | `knowledge-injection-updated`, `snapshot-updated` |
| `approval-request` | `progress-updated`, `snapshot-updated` |
| `approval-decision` | `snapshot-updated` |
| `user-input-request` | `progress-updated`, `snapshot-updated` |
| `user-input-response` | `snapshot-updated` |
| `agent-handoff` | `progress-updated`, `snapshot-updated` |
| `artifact-reference` | `artifact-updated`, `snapshot-updated` |
| `generative-ui-reference` | `snapshot-updated` |
| `context-summary` | None; published as a completed Item. |
| `status` | `progress-updated`, `snapshot-updated` |

`item.delta` events MUST include `deltaKind`. Delta payloads are selected by `deltaKind`, not by a generic string field. Text-like delta kinds carry `delta`, `indexed-text-delta` and `part-started` carry `partId`, request delta kinds carry `requestRefId`, and artifact, context, progress, and snapshot updates carry bounded structured payloads.

`item.completed` remains authoritative. Clients MAY render streamed deltas optimistically, but they MUST reconcile the item with the completed payload. `artifact-reference` is the canonical artifact item type when the item log anchors a durable artifact record in workspace, thread, and turn history.

### Delta Correlation Fields

- `request-started` deltas MUST include `requestRefId`.
- `request-resolved` deltas MUST include the same `requestRefId` as the request they resolve.
- `part-started` deltas MUST include `partId`.
- `indexed-text-delta` deltas MUST include `partId` or another item-type-defined part reference that was previously introduced by `part-started` or by the initial item payload.

`requestRefId` and `partId` are item-local identifiers. Delta producers MUST preserve these correlations across each Item's event sequence. Conformance fixtures MUST check prior part introduction and matching request resolution; a stateless envelope check proves only field presence.

### Request Modeling Rules

Independent `approval-request` items are for session-level, permission-level, workspace-level, or cross-tool approvals. `request-started` deltas on `tool-call`, `command-execution`, `file-change`, or similar items are for inline approval, elicitation, or review requests that belong to that specific item. Core and adapters SHOULD avoid representing the same human decision as both an independent `approval-request` item and an inline `request-started` delta.

### Snapshot Size Rules

`snapshot-updated` is for bounded structured previews and aggregate state that are reasonable to resend as a whole. Large diffs, long terminal output, long files, media, and other high-volume content SHOULD use `output-delta`, `part-started` plus indexed deltas, workspace-plane pointers, or artifact-plane pointers instead of repeated full snapshots.

### Interaction Framing Rules

`interaction-delta` may carry text, structured interaction events, base64 payloads for small binary fragments, or pointers to workspace-plane or artifact-plane content. Large binary content such as screenshots, audio, video, browser captures, or terminal recordings SHOULD travel through the workspace plane or artifact plane and be referenced from the delta payload. Control-plane streams SHOULD NOT carry large binary blobs inline.

### Context Injection Rules

A turn SHOULD use at most one `knowledge-injection` item for Core-mediated knowledge or context unless a product rule requires splitting it. Multiple context selections or injections during the same turn SHOULD be represented as `knowledge-injection-updated` deltas on that item.

### Delta Validation

Core MUST validate each `item.delta` against the declared item type and delta kind table for the active protocol version. If an agent emits an undeclared item type and delta kind combination, Core MUST treat it as a protocol violation. Protocol violations SHOULD be dropped from the product item log, recorded as audit events, and reported through a stable `core.protocol.*` error code where feedback to the caller or adapter is available.

The tolerant stream consumer parser in `@openkit/protocol` accepts unknown future Item types or delta kinds for forward-compatible consumers, but known current item-type and delta-kind pairs MUST NOT bypass strict payload validation through that parser.

## Canonical Enums

This section is the single human-readable inventory for core closed protocol enum families. Generated and source Zod schemas in `@openkit/protocol` are the validation source for implementations. `ItemType` (17 values, `ItemTypeSchema` in `packages/protocol/src/models/item.ts`) and `ItemDeltaKind` (11 values, `ItemDeltaKindSchema` in `packages/protocol/src/common/item-delta.ts`) are listed once in [Item Delta Kinds](#item-delta-kinds) above.

Workspace status (`WorkspaceRecordSchema.shape.status` in `packages/protocol/src/models/workspace.ts`):

```text
active
archived
```

Thread status (`ThreadSchema` `status` field in `packages/protocol/src/models/thread.ts`):

```text
active
archived
```

Thread visibility (`ThreadSchema` `visibility` field in `packages/protocol/src/models/thread.ts`):

```text
private
workspace
server
```

Thread source (`ThreadSchema` optional `threadSource` field in `packages/protocol/src/models/thread.ts`):

```text
conversation
worker
```

Thread entry path (`ThreadEntryPathSchema` in `packages/protocol/src/models/thread.ts`):

```text
conversation
administration
knowledge-manager
```

Item status (`ItemStatusSchema` in `packages/protocol/src/models/item.ts`):

```text
in_progress
completed
failed
declined
```

Item receiving ingress (`BaseItemSchema` optional `ingress` field in `packages/protocol/src/models/item.ts`; absence is treated conservatively as externally influenced, and Turn and AgentSession records carry optional sticky boolean `externallyInfluenced` where `true` or absent cannot be cleared by lifecycle replacement):

```text
api
remote-mcp
channel
provider
tool
import
core
```

Terminal event `stopReason` (`StopReasonSchema` in `packages/protocol/src/models/turn.ts`):

```text
completed
error
aborted
length
budget_exhausted
```

Turn trigger-source kind (`TurnTriggerSourceSchema.shape.kind` in `packages/protocol/src/models/turn.ts`):

```text
user-input
system-input
automation
retry
handoff
approval-resolution
running-work-steering
```

Reasoning effort, ordered from lowest to highest (`ReasoningEffortSchema` and `REASONING_EFFORT_LEVELS` in `packages/protocol/src/common/reasoning-effort.ts`):

```text
none
minimal
low
medium
high
xhigh
max
```

Turn status (`TurnStatusSchema` in `packages/protocol/src/models/turn.ts`):

```text
pending
running
completed
interrupted
cancelled
failed
```

Approval status (`ApprovalStatusSchema` in `packages/protocol/src/models/approval.ts`):

```text
pending
granted
denied
expired
superseded
withdrawn
```

Worker canonical event type, `WorkerCanonicalEventTypeSchema` in `packages/worker-protocol/src/index.ts`:

```text
worker.ready
worker.heartbeat
item.created
item.delta
item.completed
artifact.created
artifact.updated
observation.recorded
observation.content.chunk
turn.completed
turn.failed
```

Upward worker-control operation, `WorkerControlOperationSchema` in the same module:

```text
heartbeat
artifact_notice
event_append
final_status
supply_refresh_ack
capability_summary
```

Private Harness operation, `HarnessOperationSchema` in `packages/worker-protocol/src/harness-control.ts`:

```text
session.open
session.inspect
turn.start
turn.steer
turn.interrupt
session.close
harness.drain
```

Harness refusal reason, `HarnessRefusalReasonSchema` in `packages/worker-protocol/src/harness-control.ts`:

```text
missing
stale
conflict
unsupported
busy
dependency_failed
cleanup_required
```

Exhausted bound, `HarnessExhaustedBoundSchema` in that module:

```text
harness.activeTurns
harness.openSessions
agentSession.activeTurn
harness.draining
sandbox.activeTurns
adapter.isolationProof
```

Terminal worker status, `WorkerCanonicalTerminalStatusSchema` in `packages/worker-protocol/src/index.ts`:

```text
blocked
cancelled
completed
degraded
failed
interrupted
lost
```

AgentSession status (`AgentSessionStatusSchema` in `packages/protocol/src/models/agent.ts`):

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

Release record stage name (`scripts/release-record.mjs`):

```text
candidate
publication
app
nanohost
worker
qualification
```

Release record stage result (`scripts/release-record.mjs`):

```text
passed
failed
unknown
not-run
```

## Implementation

- `packages/protocol/src/`
- `packages/protocol/conformance/`
- `apps/nanocore/src/`

## Implementation Gaps

- Cross-owner storage receipts - The deterministic internal receipt tuple, comparison and replay rules await implementation - #947

- Mutating command UUID `requestId` admission - Some mutation request schemas admit arbitrary nonempty `requestId` strings instead of enforcing UUID syntax - #638

## Decisions

- [Control Kernel And Service Storage](../decisions/20261120-control_kernel_and_service_storage.md)

- [One Identifier Mechanism](../decisions/20261014-one_identifier_mechanism.md)
- [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [Identifier Owner Declarations](../decisions/20261015-identifier_owner_declarations.md)
- [Identifier Derivation And Import Allocations](../decisions/20261016-identifier_derivation_and_import_allocations.md)
