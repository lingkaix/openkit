---
status: Accepted
implementation: Partial
kind: mechanism
aspect: contract-evolution
---
# Schema Evolution And Record Envelope

This specification is the single owner of the common record envelope, the required-feature registry, camelCase-to-snake_case field surface mapping, split envelopes for line-oriented records, and concrete reader and writer evolution rules for OpenKit-authored storage records and manifests.

## Scope

Owns forward-compatible extension rules for OpenKit-authored storage records and manifests, the common record envelope (`RecordEnvelopeSchema`), reader and writer behavior for unknown fields and required features, digest-reference closure, camelCase/snake_case field mapping, split envelopes for line-oriented records, and the required-feature registry (`REQUIRED_FEATURE_REGISTRY`).

Does not own:
- General contract-evolution and retained-data continuity invariants ([Contract Evolution](../core/contract-evolution.md)).
- Record family schemas, physical layout, or SQLite DDL ([Storage Layout And Record Ownership](20260703-storage_layout_record_ownership.md), [Retained Format Register](20261017-retained_format_register.md)).
- Canonical structured-value JSON encoding and SHA-256 digest construction ([Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#canonical-structured-value-digests)).
- Domain semantics for Work, Knowledge, Audit, Usage, Vault, or AgentSession ([Storage](../core/storage.md), [Knowledge](../core/knowledge.md), [Evidence](../core/evidence.md), [Vault](../core/vault.md), [AgentSession](../core/agent-session.md)).

Core: [Contract Evolution](../core/contract-evolution.md), [Storage](../core/storage.md), [Protocol](../core/protocol.md), [Evidence](../core/evidence.md), [Vault](../core/vault.md), [Agent Supply](../core/agent-supply.md), [AgentSession](../core/agent-session.md), [Knowledge](../core/knowledge.md).

## Baseline Compatibility Posture

The clean target wins over pre-baseline internal compatibility. For the current storage and manifest baseline, OpenKit provides no permanent legacy readers, aliases, shims, or fallback paths for pre-baseline internal storage layouts, route shapes, command forms, or manifest shapes. Unknown backend-native fields are not part of the stable product contract.

The shape and validation contract starts at the accepted baseline created by the active storage, manifest, audit, vault, and context specifications. Mandatory cross-release data continuity starts with `v0.1.0` under [Contract Evolution](../core/contract-evolution.md#retained-data-continuity). Before `v0.1.0`, an explicit deployment reset may replace migration; the closed-core, open-extension, and fail-closed rules still apply. Future versions follow the optional-field, fail-closed, and retained-data continuity rules in [Contract Evolution](../core/contract-evolution.md).

## Record Envelope

Canonical file-backed records SHOULD use the common envelope defined by `RecordEnvelopeSchema` in `@openkit/config-schema` (`packages/config-schema/src/schema-evolution.ts`) unless the owning specification explicitly defines a narrower line-oriented format.

For envelope-backed records, writers MUST mark any new field or record behavior that changes authority, permission, vault use, sandbox policy, provider routing, mount access, workspace write scope, retention, audit obligation, or billing-relevant measurement with `requiredFeatures`, `minCoreVersion`, or an equivalent required capability list owned by the record family. Envelope readers MUST reject records whose required features are unsupported.

`schemaVersion` identifies the major schema family for the record. Writers emit an explicit marker, and readers check it with the shared retained-format helper (`@openkit/protocol`) before decoding payload fields. New retained formats begin at version 1. An absent or unsupported marker fails closed. Family-local stored schemas define retained meaning independently of release-coupled API and Protocol response schemas; those responses project from admitted stored records. Existing native migration journals govern scalar SQL rows, while independently decoded JSON-bearing rows carry their own version marker. Original content and opaque native payloads retain exact bytes under their versioned owning descriptors.

`recordType` identifies the record family, such as `workspace`, `thread`, `turn`, `item-log-entry`, `artifact`, `knowledge-page`, `source`, `context-package`, `aep-snapshot`, `evidence-bundle`, or `runtime-evidence`.

`ownerScope` identifies whether the record is server-owned (`server`), user-owned (`user`), or workspace-owned (`workspace`). Organization and tenant scopes are not reserved; adding a new ownership scope requires an accepted design and a source-of-truth owner.

`lineage` carries stable IDs needed to relate the record to workspace, thread, turn, item, artifact, knowledge, agent, AgentSession, AEP snapshot, capability call, policy decision, vault grant, request, and evidence records when those IDs exist.

`contentDigest` identifies the canonical payload or file content used for replay, import, verification, or evidence linkage.

`redactionLevel` and `sensitivity` describe the product visibility and handling boundary.

`requiredFeatures` lists semantic features a reader must understand before it can process the record.

`extensions` contains namespaced optional extension fields.

## Reader Contract

Readers MUST validate known required fields.

Readers MUST reject unsupported `schemaVersion` major versions before decoding payload fields unless the owning specification explicitly defines a compatible version range.

Readers MUST reject unsupported `requiredFeatures`.

Readers MUST ignore unknown optional descriptive fields when reading.

Canonical history readers MUST normalize descriptive objects at every nesting level, including Actor attribution (including retained Audit actors and subjects), retained session summaries, Knowledge history, observation references and payloads, and command-receipt metadata. Owned source bytes or annotations remain separate from strictly valid emitted projections, and live observation admission uses the parsed payload rather than forwarding its original unconsumed fields.

Readers SHOULD preserve unknown optional fields on same-record writes when preservation is practical and safe.

Readers MUST NOT treat unknown canonical record types as processed.

Readers MAY ignore unknown derived indexes, cached read models, generated runtime-native files, and backend-private evidence payloads.

Readers MUST NOT infer permission, vault, sandbox, provider, mount, write, retention, audit, or billing semantics from unknown optional fields.

### Current Boot Envelope Family Registry

The data-root boot verifier checks common envelopes in `.json` files against these supported families. Retained Source registry records remain accepted even though current Source writers use Notebook pointers. Registration does not migrate or rewrite retained records.

| Record family | Stored surface |
| --- | --- |
| `data-root-backup` | Cold data-root backup manifest. |
| `source` | Retained Knowledge Source registry envelope. |
| `thread` | Workspace or Server Thread envelope. |
| `workspace-deletion-closure` | Sealed Workspace deletion manifest. |
| `workspace-export` | Workspace export manifest. |

Memory suppression envelopes use `.jsonl`, so the `.json` boot verifier does not read them. Runtime evidence and evidence bundles use versioned SQLite rows and portable JSONL records, not common `.json` envelopes. Light App and Generative UI portable rows and migration reports lack the common envelope fields and are not boot envelope candidates. Their owning readers retain responsibility for schema-version and required-feature checks.

## Writer Contract

Writers SHOULD prefer additive fields over changing the meaning of existing fields.

Writers MUST bump the relevant schema version or required feature when changing the meaning of an existing field.

Writers MUST put runtime-native or adapter-private hints under a namespaced `extensions` area.

Writers MUST use required features for new authority-bearing behavior.

Writers SHOULD keep generated files, derived indexes, and backend receipts separate from canonical product records.

## Digest Stability

`contentDigest` values are referenced by evidence bundles, lineage links, materialization records, and audit rows. Unknown-field handling must not break those references.

- A canonical record whose `contentDigest` is referenced by another durable record MUST NOT be rewritten in place with content changes. Changes create a successor record that supersedes the original and records the predecessor digest.
- When an implementation rewrites a digest-referenced record in place for non-content reasons, it MUST preserve unknown optional fields byte-compatibly so the digest remains stable.
- If a migration upgrades a digest-referenced record to a new schema version, the migration report MUST map the predecessor digest to the successor digest so existing references remain resolvable.
- Records that are never digest-referenced may be rewritten under the ordinary SHOULD-preserve rule.

### Canonical Structured Values And Exact Bytes

[Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#canonical-structured-value-digests) owns the canonical JSON encoder (`canonicalJsonText` in `@openkit/protocol`), its input-domain and refusal rules, the stricter complete-name identifier rule (`canonicalIdentifierName`), the Node-only SHA-256 helper (`@openkit/protocol/digest`), and the named retained digest exceptions. Domain owners retain field selection, prefixes, separators, length framing, and any explicitly required normalization before encoding.

Exact original bytes, binary framing, and incremental stream hashes are not canonical JSON. Readers MUST verify retained immutable content by hashing its exact stored bytes. A historical value that left the process, including a delivered Context Package, native correlation identity, or Worker control fingerprint, remains a recorded fact; readers MUST NOT re-canonicalize or recompute it from current values. Canonical encoding constructs new structured-value digests, not historical replacement evidence.

When the system recomputes a digest from retained structured input and compares it on read, a changed encoding requires the complete affected digest and reference closure to move through that family's one-way migration owner before the new reader is enabled. The predecessor/successor rules above apply. Historical digest-only attribution and fresh-input conflict comparisons do not authorize rewriting original content or physical identities. Implementations MUST NOT add a second encoder, dual writer, fallback reader, alias table, or digest ledger.

## Field Naming And Surface Mapping

Canonical envelope and record field names are camelCase in JSON, JSONL, and SQLite-projected surfaces, such as `schemaVersion`, `ownerScope`, and `requiredFeatures`.

Markdown frontmatter surfaces, including Knowledge Store records under the OKF envelope, use snake_case projections of the same fields, such as `schema_version`, `source_refs`, and `review_state`.

The mapping is mechanical camelCase-to-snake_case and is owned by this specification. Validators MUST treat the two casings of one field as the same field with the same semantics, and one surface MUST NOT mix casings. New fields are defined once in the owning specification and inherit both projections.

## Line-Oriented Records

Append-only line-oriented record families use a split envelope:

- Every line MUST carry a minimal header: a schema version discriminator, a record type discriminator, a stable id when the line is individually addressable, and a timestamp.
- File-level envelope fields (`ownerScope`, `lineage`, `requiredFeatures`, and redaction and sensitivity defaults) belong to a file-level or directory-level manifest defined by the owning storage specification.
- Rotation and compaction MUST preserve the file-level manifest linkage so lines remain attributable after file operations.

The owning storage specification defines the concrete header field names per family; the split-envelope minimum above is normative for all line-oriented canonical families.

User Memory suppression rows are a narrow exception to the split-envelope placement rule: each row in the scoped `observations/YYYYMM.jsonl` maintenance family carries the complete canonical envelope, exact User lineage, and required `openkit.memory-suppression.v1` feature. This exception retains the full envelope's closed required semantics and minimal content-free suppression facts without creating another record family, granting human confirmation, or activating a public forget/history endpoint.

## Storage Versus Protocol Strictness

Reader tolerance never relaxes emitted projection strictness.

Descriptive protocol and App API readers ignore unknown optional keys under [Contract Evolution](../core/contract-evolution.md); effect instructions and authority-bearing shapes refuse unknown fields. Emitters and generated known-core fixtures remain strictly validated.

When tolerant storage records project into protocol or App API payloads, the projection layer MUST emit strictly valid current-contract payloads and MUST drop unknown optional storage fields rather than forwarding them. Unknown optional fields MUST NOT leak secrets through diagnostics, audit records, or product APIs. A storage record that cannot project into a valid current payload after dropping unknown optional fields is a diagnostics failure, not a reason to weaken protocol validation.

## Personal Scope And Knowledge Profile Projection

Thread `visibility` and `privateOwnerUserId` are authority-bearing creation metadata owned by [Thread Visibility And Sharing](20260909-thread_visibility_and_sharing.md); missing or contradictory data cannot default to shared. The scoped Knowledge extension adds exact owner scope under profile v4 plus notebook Git base and candidate commit assertions on publication and required Review; page revision counters are absent. Implementations MUST apply these through the record and schema migration owners, preserving source lineage and failing closed on ambiguous scope or revision. Retired Workspace Memory aliases remain absent; User Memory is a distinct scoped projection, not a compatibility parser.

## Authority-Bearing Fields

Authority-bearing fields include any field that changes filesystem read or write access, workspace root or mount access, sandbox isolation, network access, provider routing, model or inference endpoint authority, vault reference use, secret injection, permission or approval policy, capability exposure, audit or evidence obligations, retention or legal-hold behavior, or billing-relevant usage measurement. Adding one of these fields without a required feature is invalid.

## Required Feature Registry

- `requiredFeatures` values MUST be lowercase dot-separated identifiers of the form `<domain>.<area>.<feature>`.
- All feature identifiers MUST be defined in `REQUIRED_FEATURE_REGISTRY` in `@openkit/config-schema` (`packages/config-schema/src/schema-evolution.ts`). Writers MUST NOT invent unregistered identifiers.
- Readers advertise the feature set they support from the same registry; rejection diagnostics MUST name the unsupported identifier.
- Feature identifiers are never removed after an externally supported release; a withdrawn feature stays listed with `withdrawn` status so older records produce a meaningful diagnostic.

The table mirrors `REQUIRED_FEATURE_REGISTRY` and the package test keeps them aligned.

| Feature | Status | Description |
| --- | --- | --- |
| `runtime.evidence.v1` | active | Runtime evidence retains execution outcomes, backend summaries, and evidence bundle linkage. |
| `worker.runtime-provenance.v1` | active | Worker runtime provenance links admitted Agent Environment Packages to retained transcript evidence. |
| `worker.harness-login.v1` | active | Workspace-bound Codex Login requirements and harness Login execution require explicit reader support. |
| `evidence.bundle.v1` | active | Evidence bundles retain exact lineage, content digests, retention, sensitivity, and import disposition. |
| `openkit.workspace-resource-policy.v1` | active | Workspace configuration carries managed resource boundaries and exact associations and prohibitions across verified export. Ordinary portable Workspace import is absent and does not carry them. |
| `openkit.memory-suppression.v1` | active | User Memory suppression reserves forgotten page identities and requires current and historical disclosure suppression. |
| `agent.resource-catalog.v1` | active | Workspace export includes the Skill, MCP, and Agent Plugin portable catalog projection. |
| `audit.retention.legal-hold` | active | Audit retention is controlled by a legal-hold policy. |
| `openkit.work-observations.v1` | active | Turn-scoped work observations, restricted content publication and exact portable reference closure. |
| `openkit.server-threads.v1` | active | Thread, Turn and Item history has an immutable Server owner without a Workspace anchor. |
| `openkit.thread-entry.v1` | active | Thread records preserve the immutable server-authored conversation or administration entry path. |
| `openkit.knowledge-git-notebook.v1` | active | Notebook Git revisions own page content, exact-base publication and retained history. |
| `openkit.knowledge-owner-scope.v1` | active | Knowledge records retain exact User, Workspace or Server ownership and source restrictions. |
| `openkit.thread-visibility.v1` | active | Thread records require explicit private or Workspace audience and exact private ownership. |
| `session.concurrent-turns` | active | A Harness may process active Turns concurrently only across distinct single-flight AgentSessions and Threads. |
| `vault.injection.query-param` | active | Vault injection may place secret references into query parameters. |
| `workspace.generative-kernel.v1` | active | Workspace export includes Light App identity, admitted definitions, native records, and app-local audit. |
| `workspace.generative-ui.native-v1` | active | Workspace export includes immutable native Generative UI presentations and their Item references. |
| `workspace.recurring-triggers.v1` | active | Workspace export includes inert recurring definitions and exact occurrence and expired-range history. |
| `workspace.recurring-history.v1` | active | Workspace deletion closures retain the inert recurring definitions and exact occurrence and expired-range history. |
| `workspace.mount.fuse` | active | Workspace input requires a FUSE-style mount implementation. |
| `workspace.writeback.external` | active | Workspace writes are committed through an external writeback mechanism. |

`requiredFeatures` is the preferred gate. `minCoreVersion` is a discouraged escape hatch: writers SHOULD express requirements as features and MAY use `minCoreVersion` only when a requirement genuinely cannot be named as a feature. Readers MUST enforce `minCoreVersion` when present; no current common-envelope writer admits a version-coupled requirement, and `RecordEnvelopeSchema` (`packages/config-schema/src/schema-evolution.ts`) fails closed by refusing any present `minCoreVersion` value rather than ignoring it as an optional descriptive key.

The `worker.harness-login.v1` marker gates the closed Workspace-bound `runtime-token`/`codex-login` requirement and the corresponding current-version harness Login semantics. Retained setup evidence preserves only its visibility discriminator, requirement identity, grant identity, and fixed consumer; it carries no credential material or live declaration identifier. Unknown captured feature names remain evidence, not current launch support. Registering this marker neither enables a Worker capability nor certifies native activation.

The `session.concurrent-turns` identifier describes a Harness capability and never authorizes more than one active Turn in one AgentSession or Thread. The current scheduler does not grant this capability.

Writers emit `workspace.generative-kernel.v1` and `workspace.generative-ui.native-v1` only when the corresponding portable families are present. The native UI marker does not admit HTML delegates, saved-view lifecycles, or executable Plugin resources.

Writers emit `workspace.recurring-triggers.v1` and `workspace.recurring-history.v1` for inert recurring definitions and exact occurrence and expired-range history. Unknown required recurring semantics MUST fail closed rather than importing active execution or silently omitting history.

Writers emit `openkit.thread-visibility.v1`, `openkit.knowledge-owner-scope.v1`, and `openkit.knowledge-git-notebook.v1` on the covered record families and dependent export manifests so unsupported readers reject before disclosing private content or weakening mutation guards. Registration does not establish complete User or Server Memory lifecycle implementation.

## Extension Namespaces

`extensions` fields MUST be namespaced (for example `extensions.openshell`, `extensions.codex`, `extensions.connector.googleDrive`, or `extensions.storage.r2`).

Extension fields MAY carry adapter hints, diagnostics, generated backend labels, or provider-specific options. Extension fields MUST NOT be the only place where an OpenKit product-semantic decision is stored. If an extension changes authority, it MUST be paired with a required feature or promoted into the owning canonical schema.

## Storage Structure Evolution

Storage directories may gain new sibling directories under the owning scope. Older readers MAY ignore unknown sibling directories unless those directories contain canonical record families selected by a manifest, index, or required feature that the reader claims to process.

Derived directories such as indexes, read models, search tables, vector stores, cached diagnostics, and generated runtime materialization outputs are rebuildable or disposable unless the owning specification says otherwise. Unknown derived directories MUST NOT block boot. Canonical file-backed record directories MUST be listed by the owning storage specification before product code treats them as source of truth.

## Manifest Evolution

Agent manifests may add optional fields and optional sections over time. Older readers MAY ignore descriptive fields they do not understand, but they MUST reject a manifest when `requiredFeatures`, `minCoreVersion`, or required backend capabilities name unsupported behavior. An unknown key inside an authority-bearing section of an authored manifest fails closed under [Contract Evolution](../core/contract-evolution.md#hand-written-configuration).

New fields under `workspace`, `vault`, `policy`, `sandbox`, `providers`, `mcp`, `tools`, `resources`, `scale`, `observability`, or `lifecycle` are authority-bearing unless the owning manifest specification explicitly marks them as descriptive metadata. Manifest writers SHOULD use explicit required features for new mount kinds, source kinds, credential injection modes, runtime placement modes, and worker-visible capability families.

## Audit And Evidence Evolution

Audit and usage readers MAY ignore unknown optional descriptive fields, but they MUST reject unsupported required features that affect responsibility, policy, permission, vault use, resource attribution, evidence retention, or redaction.

Evidence bundle readers MUST NOT promote unknown evidence kinds into canonical items, artifacts, audit events, or workspace changes. Unknown evidence may be retained as restricted evidence when storage policy allows it, but it MUST stay unpromoted until a reader understands and verifies it.

## Implementation

- `packages/config-schema/src/`
- `packages/protocol/src/`
- `apps/nanocore/src/storage/`

## Implementation Gaps

- Common envelope `ownerScope` closed set (`server`, `user`, `workspace`) - `RecordOwnerScopeSchema` in `packages/config-schema/src/schema-evolution.ts` admits `organization` without an accepted organization scope owner - #761

## Decisions

- [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [Open Extension Partition](../decisions/20261005-open_extension_partition.md)
