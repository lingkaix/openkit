# Schema Evolution And Record Envelope

Status: Accepted
Implementation: Implemented

## Owns

- Forward-compatible extension rules for OpenKit-authored storage records and manifest-like files.
- The common envelope required by canonical file-backed records.
- Reader behavior for unknown fields, unknown record families, unsupported required features, and namespaced extensions.
- The boundary between current internal clean-target changes and future additive schema evolution.

## Does Not Own

- Core semantic definitions for workspace, thread, turn, item, artifact, knowledge, audit, usage, vault, or agent session.
- Complete schemas for every record family.
- SQLite table DDL, migration scripts, ORM layout, or query model design.
- External provider schemas, object-store schemas, Git schemas, OpenShell-native payloads, or runtime-native config files.
- Legacy migration from old internal OpenKit data roots.

## Core References

- `docs/core/storage.md`
- `docs/core/protocol.md`
- `docs/core/audit.md`
- `docs/core/vault.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/knowledge.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`

## Summary

This spec defines how OpenKit-owned files evolve after the current storage and manifest baseline is established.

The current internal development phase does not preserve old internal shapes, paths, or compact manifest formats.

Once the new baseline is established, future additions should be additive by default: older readers may ignore or preserve unknown optional fields, while unsupported authority-bearing semantics must fail closed.

## Goals

- Let storage records and agent manifests add fields without forcing every older reader to fail.
- Prevent older readers from silently ignoring new security, permission, vault, sandbox, provider, mount, write-scope, or audit obligations.
- Give canonical file-backed records one recognizable envelope for ownership, lineage, digest, redaction, and feature requirements.
- Keep old internal migration concerns out of the long-term runtime contract.

## Non-goals

- Do not require backward compatibility for pre-baseline internal storage layouts, route shapes, command forms, or manifest shapes.
- Do not require older systems to provide newer functionality.
- Do not make unknown backend-native fields part of the stable product contract.
- Do not define every record family schema in this spec.

## Decision

Use additive schema evolution with explicit required-feature gates.

Unknown optional fields MAY be ignored by readers that do not understand them.

Readers SHOULD preserve unknown optional fields when rewriting a record in place, but they are not required to preserve unknown derived indexes, cached diagnostics, or generated materialization outputs.

Unknown authority-bearing semantics MUST NOT be silently ignored.

Writers MUST mark any new field or record behavior that changes authority, permission, vault use, sandbox policy, provider routing, mount access, workspace write scope, retention, audit obligation, or billing-relevant measurement with `requiredFeatures`, `minCoreVersion`, or an equivalent required capability list owned by the record family.

Readers MUST reject records whose required features are unsupported.

This spec is the single normative source for the general evolution rules. Other core documents and specs MUST reference this contract and add only domain-specific rules; they MUST NOT restate the general rules in their own normative language, because parallel restatements drift.

## Baseline Compatibility Posture

OpenKit is currently in active internal development.

The clean target wins over old internal compatibility.

For the current storage and manifest reset, OpenKit does not need permanent legacy readers, aliases, shims, or fallback paths for old internal shapes.

The compatibility contract in this spec starts at the accepted baseline created by the active storage, manifest, audit, vault, and context specs.

Future versions should remain forward-tolerant for optional fields and fail closed for required semantics.

## Record Envelope

Canonical file-backed records SHOULD use this common envelope unless the owning spec explicitly defines a narrower line-oriented format:

```text
schemaVersion
recordType
id
ownerScope
lineage
createdAt
updatedAt
contentDigest
redactionLevel
sensitivity
requiredFeatures
extensions
```

`schemaVersion` identifies the major schema family for the record.

`recordType` identifies the record family, such as workspace, thread, turn, item-log-entry, artifact, knowledge-page, source, context-package, aep-snapshot, evidence-bundle, or runtime-evidence.

`ownerScope` identifies whether the record is server-owned, user-owned, workspace-owned, or future organization-owned.

`lineage` carries stable IDs needed to relate the record to workspace, thread, turn, item, artifact, knowledge, agent, agent session, AEP snapshot, capability call, policy decision, vault grant, request, and evidence records when those IDs exist.

`contentDigest` identifies the canonical payload or file content used for replay, import, verification, or evidence linkage.

`redactionLevel` and `sensitivity` describe the product visibility and handling boundary.

`requiredFeatures` lists semantic features a reader must understand before it can safely process the record.

`extensions` contains namespaced optional extension fields.

## Reader Contract

Readers MUST validate known required fields.

Readers MUST reject unsupported `schemaVersion` major versions unless the owning spec explicitly defines a compatible version range.

Readers MUST reject unsupported `requiredFeatures`.

Readers MAY ignore unknown optional fields when reading.

Readers SHOULD preserve unknown optional fields on same-record writes when preservation is practical and safe.

Readers MUST NOT treat unknown canonical record types as processed.

Readers MAY ignore unknown derived indexes, cached read models, generated runtime-native files, and backend-private evidence payloads.

Readers MUST NOT infer permission, vault, sandbox, provider, mount, write, retention, audit, or billing semantics from unknown optional fields.

## Writer Contract

Writers SHOULD prefer additive fields over changing the meaning of existing fields.

Writers MUST bump the relevant schema version or required feature when changing the meaning of an existing field.

Writers MUST put runtime-native or adapter-private hints under a namespaced `extensions` area.

Writers MUST use required features for new authority-bearing behavior.

Writers SHOULD keep generated files, derived indexes, and backend receipts separate from canonical product records.

## Digest Stability

`contentDigest` values are referenced by evidence bundles, lineage links, materialization records, and audit rows. Unknown-field handling must not break those references.

Rules:

- A canonical record whose `contentDigest` is referenced by another durable record MUST NOT be rewritten in place with content changes. Changes create a successor record that supersedes the original and records the predecessor digest.
- When an implementation legitimately rewrites such a record in place for non-content reasons, it MUST preserve unknown optional fields byte-compatibly so the digest remains stable; for digest-referenced records the preservation rule is MUST, not SHOULD.
- If a migration upgrades a digest-referenced record to a new schema version, the migration report MUST map the predecessor digest to the successor digest so existing references remain resolvable.
- Records that are never digest-referenced may be rewritten under the ordinary SHOULD-preserve rule.

## Field Naming And Surface Mapping

Canonical envelope and record field names are camelCase in JSON, JSONL, and SQLite-projected surfaces, such as `schemaVersion`, `ownerScope`, and `requiredFeatures`.

Markdown frontmatter surfaces, including Knowledge Store records under the OKF envelope, use snake_case projections of the same fields, such as `schema_version`, `source_refs`, and `review_state`.

The mapping is mechanical camelCase-to-snake_case and is owned by this spec. Validators MUST treat the two casings of one field as the same field with the same semantics, and one surface MUST NOT mix casings. New fields are defined once in the owning spec and inherit both projections.

## Line-Oriented Records

Some record families are line-oriented, such as append-only item logs and observation ledgers. The full envelope is too heavy per line, so line-oriented families use a split envelope:

- Every line MUST carry a minimal header: a schema version discriminator, a record type discriminator, a stable id when the line is individually addressable, and a timestamp.
- File-level envelope fields — `ownerScope`, lineage, `requiredFeatures`, redaction and sensitivity defaults — belong to a file-level or directory-level manifest that the owning storage spec defines.
- Rotation and compaction MUST preserve the file-level manifest linkage so lines remain attributable after file operations.

The owning storage spec decides the concrete header field names per family; the split-envelope minimum above is normative for all line-oriented canonical families.

## Storage Versus Protocol Strictness

Storage tolerance never relaxes protocol strictness.

Protocol payloads, App API payloads, and generated JSON Schema surfaces remain strictly validated under `docs/core/contract-evolution.md`.

When tolerant storage records project into protocol or App API payloads, the projection layer MUST emit strictly valid current-contract payloads and MUST drop unknown optional storage fields rather than forwarding them. A storage record that cannot project into a valid current payload after dropping unknown optional fields is a diagnostics case, not a reason to weaken protocol validation.

## Authority-Bearing Fields

Authority-bearing fields include any field that changes:

- filesystem read or write access
- workspace root or mount access
- sandbox isolation
- network access
- provider routing
- model or inference endpoint authority
- vault reference use
- secret injection
- permission or approval policy
- capability exposure
- audit or evidence obligations
- retention or legal hold behavior
- billing-relevant usage measurement

Adding one of these fields without a required feature is invalid.

## Required Feature Registry

Fail-closed behavior only works when feature names are canonical and discoverable. The registry is therefore part of the first implementation slice, not deferred work.

Rules:

- `requiredFeatures` values are lowercase dot-separated identifiers of the form `<domain>.<area>.<feature>`, for example `workspace.mount.fuse`, `workspace.writeback.external`, `session.concurrent-turns`, `vault.injection.query-param`, and `audit.retention.legal-hold`.
- All feature identifiers MUST be defined in one shared registry exported from a single implementation package and mirrored as a table in this spec's registry section once implementation begins. Writers MUST NOT invent unregistered identifiers.
- Readers advertise the feature set they support from the same registry; rejection diagnostics MUST name the unsupported identifier.
- Feature identifiers are never removed; a withdrawn feature is marked withdrawn in the registry so old records still produce a meaningful diagnostic.

`requiredFeatures` is the preferred gate. `minCoreVersion` is a discouraged escape hatch: version coupling reintroduces the drift this spec exists to prevent, so writers SHOULD express requirements as features and MAY use `minCoreVersion` only when a requirement genuinely cannot be named as a feature. Readers MUST still enforce `minCoreVersion` when present.

Current registry implementation lives in `@openkit/config-schema` and exports `REQUIRED_FEATURE_REGISTRY`, `listRequiredFeatureDefinitions`, `RecordEnvelopeSchema`, `parseRecordEnvelope`, and `rewriteRecordEnvelope`.

The implementation includes package tests for unknown optional field tolerance, unsupported required-feature fail-closed parsing, unregistered writer feature rejection, same-record unknown-field preservation, source-catalog manifest fail-closed behavior, workspace export and backup manifest envelope parsing, and registry/spec-table alignment.

| Feature | Status | Description |
| --- | --- | --- |
| `audit.retention.legal-hold` | active | Audit retention is controlled by a legal-hold policy. |
| `session.concurrent-turns` | active | Agent session may process more than one turn concurrently. |
| `vault.injection.query-param` | active | Vault injection may place secret references into query parameters. |
| `workspace.mount.fuse` | active | Workspace input requires a FUSE-style mount implementation. |
| `workspace.writeback.external` | active | Workspace writes are committed through an external writeback mechanism. |

## Extension Namespaces

`extensions` fields MUST be namespaced.

Examples:

```text
extensions.openshell
extensions.codex
extensions.connector.googleDrive
extensions.storage.r2
```

Extension fields MAY carry adapter hints, diagnostics, generated backend labels, or provider-specific options.

Extension fields MUST NOT be the only place where an OpenKit product-semantic decision is stored.

If an extension changes authority, it must be paired with a required feature or promoted into the owning canonical schema.

## Storage Structure Evolution

Storage directories may gain new sibling directories under the owning scope.

Older readers may ignore unknown sibling directories unless those directories contain canonical record families selected by a manifest, index, or required feature that the reader claims to process.

Derived directories such as indexes, read models, search tables, vector stores, cached diagnostics, and generated runtime materialization outputs are rebuildable or disposable unless the owning spec says otherwise.

Canonical file-backed record directories must be listed by the owning storage spec before product code treats them as source of truth.

## Manifest Evolution

Agent manifests may add optional fields and optional sections over time.

Older readers may ignore fields they do not understand, but they must reject a manifest when `requiredFeatures`, `minCoreVersion`, or required backend capabilities name unsupported behavior.

New fields under `workspace`, `vault`, `policy`, `sandbox`, `providers`, `mcp`, `tools`, `resources`, `scale`, `observability`, or `lifecycle` are authority-bearing unless the owning manifest spec explicitly marks them as descriptive metadata.

Manifest writers should prefer explicit required features for new mount kinds, source kinds, credential injection modes, provider attachment modes, runtime placement modes, and worker-visible capability families.

## Audit And Evidence Evolution

Audit and usage readers may ignore unknown optional descriptive fields, but they must reject unsupported required features that affect responsibility, policy, permission, vault use, resource attribution, evidence retention, or redaction.

Evidence bundle readers must not promote unknown evidence kinds into canonical product records.

Unknown evidence may be retained as restricted evidence when storage policy allows it, but it must stay unpromoted until a reader understands and verifies it.

## Testing Strategy

- Schema tests should accept records with unknown optional fields.
- Schema tests should reject unsupported required features.
- Manifest tests should prove unsupported authority-bearing additions fail closed.
- Storage fixture tests should prove unknown derived directories do not block boot.
- Round-trip tests should preserve unknown optional fields where the implementation rewrites canonical records.
- Redaction tests should prove unknown fields cannot leak secrets through diagnostics, audit, or product APIs.
- Promotion tests should prove unknown evidence kinds cannot become canonical items, artifacts, audit events, or workspace changes.

## Risks & Mitigations

- Risk: Optional fields hide real authority changes. Mitigation: require `requiredFeatures` for all authority-bearing semantics and test fail-closed behavior.
- Risk: Parsers become too permissive. Mitigation: validate known fields strictly and only tolerate unknown optional additions.
- Risk: Extension namespaces become product contracts. Mitigation: promote product semantics into owning specs and keep extensions subordinate.
- Risk: Older systems appear to support newer features. Mitigation: unsupported required features block launch, import, or processing.

## Resolved Decisions

- Current internal migration does not require compatibility with old internal storage or manifest shapes.
- Future schema evolution is additive by default.
- Unknown optional fields may be ignored or preserved.
- Unsupported required features must fail closed.
- Authority-bearing fields must never be silently ignored.
- Namespaced extensions are optional hints, not the stable product contract.
- Canonical file-backed records should use a common envelope unless their owning spec defines a narrower line-oriented format.
- This spec is the single normative source for general evolution rules; other documents reference it instead of restating it.
- Digest-referenced canonical records are superseded by successor records instead of being rewritten in place; migrations map predecessor digests to successor digests.
- Canonical field names are camelCase on JSON/JSONL surfaces and snake_case on Markdown frontmatter surfaces, with a mechanical mapping owned by this spec.
- Line-oriented families use a split envelope: minimal per-line header plus a file-level manifest.
- The required feature registry ships in the first implementation slice; `requiredFeatures` is preferred over `minCoreVersion`.
- Storage tolerance never relaxes protocol strictness; projections emit strictly valid current payloads.

## Deferred / Future Work

- Adopt the common envelope helper in each canonical file-backed record family as those families leave their current transitional formats.
- Add redaction and projection leak tests for unknown optional fields before exposing envelope-backed records through product APIs.
- Add promotion tests proving unknown evidence kinds cannot become canonical items, artifacts, audit events, or workspace changes.
- Extend the registry table when new authority-bearing features are introduced; withdrawn features stay listed with `withdrawn` status instead of being removed.

## Links

- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-worker_context_package.md`
