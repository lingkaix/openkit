---
date: "2026-10-24"
---
# Independent Documentation Audit: Contract-Evolution Group

This non-authorizing record holds the contract-evolution group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `4aa0e655f36beb6771201fb4658c1555e6a1c85a` (`main` on 2026-10-24, unchanged since the foundation group). Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/contract-evolution.md`.
- Specifications: `20260703-schema_evolution_record_envelope.md`, `20260715-contract_stability_baseline.md`, `20261017-retained_format_register.md`, `20260522-vendor_snapshot_packages.md`, and `20261012-product_integrity_check.md`.
- Cited decisions read: `20260930-closed_core_open_extension.md` (through the Core text), `20261005-open_extension_partition.md`, `20261014-pre_stable_data_continuity.md` (through the Core text), `20261019-durable_execution_and_control_store.md`, `20260930-pi_native_mcp_discovery.md`, and `20261012-product_integrity_check.md` (through the specification).
- G3 inspection: four read-only inspector contexts (CE-ENV, CE-CSB, CE-RFR, and CE-VPI for the vendor snapshot and integrity specifications). They read code only and ran no tests. The auditor verified each kept finding against the code. One inspector switched the working tree to the base SHA and back during its run; the auditor confirmed afterwards that the branch, HEAD, and the uncommitted edits were intact, and the inspector brief now forbids any command that changes HEAD, the index, or the working tree.

## G2 Core Against Specifications

- CE-G2-01: the Manifest Evolution section of the record-envelope specification said that older readers "may ignore fields they do not understand". [Contract Evolution](../core/contract-evolution.md#hand-written-configuration) says that an unknown key inside an authority-bearing section of authored configuration fails closed, and [Open Extension Partition](../decisions/20261005-open_extension_partition.md) (2026-10-05) is later than the specification text. Disposition: document outdated by a later accepted record. The sentence now says "descriptive fields", and a new sentence states the authority-bearing fail-closed rule with both citations.
- CE-G2-02: the record-envelope specification states the identifier form `<domain>.<area>.<feature>` and gives `session.concurrent-turns`, which has two segments, as an example. Disposition: carried in issue #458, which asks for the form to state the segment count.
- CE-G2-03: `20261017-retained_format_register.md` describes itself as a Storage inventory, and its primary Core home is `docs/core/storage.md`, which is held under #440. The Phase 0 grouping placed it here because it inventories retained formats under Contract Evolution. Its projection drift follows the held control-store work (Q-16).
- No other conflict was found. The specifications cite Contract Evolution for stability classes and continuity and do not redefine them.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| CE-ENV-01, 02, 03, 05 | Record-envelope Reader Contract and Required Feature Registry: reject unsupported `schemaVersion` majors and `requiredFeatures`, enforce `minCoreVersion`, name the identifier | `packages/config-schema/src/schema-evolution.ts:196` accepts any positive `schemaVersion`; `packages/config-schema/src/workspace-export.ts:44` adds no literal; agent and environment schemas refuse any `minCoreVersion` with `z.never()`, and no envelope reader compares a version; `packages/config-schema/src/gateway.ts:42` never checks `requiredFeatures`; `apps/nanocore/src/storage/fs-layout.ts:674-686` drops the identifier for scoped files | Code differs from a current accepted document | Issue #457 (blocking candidate: retained data) |
| CE-ENV-REG | Identifier form `<domain>.<area>.<feature>` | `packages/config-schema/src/schema-evolution.ts:139` registers `recurring-history-v1`; `apps/nanocore/src/workspace-deletion-evidence.ts:47` writes it into retained closures | Code differs from a current accepted document | Issue #458 (blocking candidate: retained data) |
| CE-ENV-04 | Field Naming: frontmatter uses snake_case and "one surface MUST NOT mix casings" | `apps/nanocore/src/knowledge/okf.ts:25-37` requires `requiredFeatures` beside `schema_version`; `20260703-knowledge_store_implementation.md:92` names `requiredFeatures` | Two accepted documents conflict (PRECEDENCE-003) | Question Q-15 |
| CE-ENV-06, 07, 08 | Boot supported feature set, retained `thread` family, unused rewrite helper | `fs-layout.ts:664` supports the whole registry; Threads are in `control_threads`; `rewriteRecordEnvelope` has test callers only | Low confidence or no defect | Noted; `thread` is part of Q-16 |
| CE-CSB-01 | Readiness: "V2 export" | `packages/config-schema/src/workspace-export.ts:16` sets format version 3 | Projection drift | Corrected to "format version 3" |
| CE-CSB-02 | Readiness and projection: "the rebuilt Web remains deferred" | `apps/web/README.md:3` ("This is the rebuilt app"); membership and invitation screens and `apps/web/e2e/account-sharing.spec.ts` | Projection drift; S10 completion not verified | Corrected to state the implemented membership surface; S10 keeps the remaining multi-user Web work and its browser acceptance. The same wording in `20260715-multi_user_workspace_system.md` is carried to the identity group. |
| CE-CSB-03 | Readiness and projection: fixed owner/editor/viewer roles, equal membership as a target | `apps/nanocore/drizzle/core/0004_equal_workspace_members.sql` removes access levels; the multi-user projection already says the cutover removed them | Projection drift | Corrected to equal active-member eligibility |
| CE-CSB-04 | Projection: the eleven bearer-reachable operations are the ones projected "through the catalog, bundled CLI, and remote MCP" | `skills/openkit-operations.mjs:441-535` excludes no Workspace lifecycle operation; `apps/nanocore/src/remote-mcp-routes.ts:52-60` exposes every definition | Projection drift; the counts are correct | Corrected: all fifteen are projected, and eleven are reachable with a bearer credential |
| CE-CSB-05 | Release-coupled gate: "one exact contract identity or digest" and a typed incompatibility before unsupported work | Only `PROTOCOL_VERSION` (`packages/protocol/src/common/version.ts:4`), the CLI `doctor` check, and response-parse failure exist | No record decides whether this satisfies the gate | Question Q-13 |
| CE-CSB-06 | Cutover removed the access-change command | `workspace.member.access.change` remains in two type unions (`apps/nanocore/src/lib/store.ts:387`, `apps/nanocore/src/workspace-sharing-operations.ts:990`) with no producer | Code residue, not a document conflict | Noted for the identity group |
| CE-CSB-07 | Testing Strategy: L0 checks classify new surfaces and reject removed compatibility language | `scripts/validate-spec-lifecycle.mjs` checks only `status` and `implementation` | Projection drift in a testing statement | Question Q-14 |
| CE-RFR-03, 04, 05 | Register reader, fixture, and marker cells | `TurnFileMetadataSchema` does not exist; the boundaries and schema test files are `workspace-file-record-*.test.ts`; `gateway.test.ts` and `user.test.ts` do not exist; `packages/retrieval-kernel/src/store.rs:15` uses `schema=5` | Projection drift | Corrected |
| CE-RFR-01, 02, 06 to 12 | Register rows for Workspace, Thread, Turn, Item, Event, AgentSession, and work observations name files; the SQLite section claims to cover all product-table groups | `apps/nanocore/src/storage/workspace-file-records.ts:851-870` reads `control_*` tables; `control_work_observations`, `control_executions`, `workspace_recovery_admissions`, and others have no row; `scripts/upgrade-from-previous.mjs` reads the register row names | Projection drift caused by [Durable Execution And Control Store](../decisions/20261019-durable_execution_and_control_store.md), whose specification is held | Question Q-16 |
| CE-VSP-01 | Contract Evolution: no new dependency patch | `pnpm-workspace.yaml:4-5` patches `@earendil-works/pi-coding-agent@1.0.2`; `20260716-pi_worker_adapter.md:137` and `20260930-pi_native_mcp_discovery.md` name it as workspace-patched | No record names it as an exception to the Core rule | Question Q-09 |
| CE-VSP-02 | Snapshot packages own externally sourced snapshots under `packages/` | `packages/retrieval-kernel/vendor/` holds an unmodified dictionary archive with provenance and checksum and no governing specification | Undecided scope | Question Q-11 |
| CE-VSP-03 | Snapshot evidence MUST come from an immutable upstream tag checkout and record the tag and commit; Accepted Design says refreshes use the "pinned local Codex CLI" | `packages/codex-app-server-schema/metadata.json:6-7` records `npm-0.160.0` and `packument-has-no-gitHead`; the package README forbids a local CLI; models.dev is a rolling API | Undecided | Question Q-10 |
| CE-VSP-04 | Projection omits per-file checksum validation | `packages/codex-app-server-schema/scripts/validate.mjs:105-156` checks per-file SHA-256 values, implementation values, and dispositions | Projection drift | Corrected; the deferred item about aggregate checksums is kept, because no record closes it |
| CE-VSP-05 | `implementation: Partial`; only the newest models.dev snapshot is validated | `packages/models-dev-catalog/scripts/validate.mjs:7` | Low confidence | Noted |
| CE-PIC-01 | Projection: "Its loader passes repair true at ... line 1543" | `apps/nanocore/src/storage/workspace-file-records.ts:1573` delegates to `readNativeTurnEvents`, which pages control-store rows and immutable content | Projection drift; the event-file design of the predicate is overtaken by the 2026-10-19 decision | Projection corrected; the contract text is Question Q-12 |
| CE-PIC-03 | Stories name invariants of an operation that does not exist yet | Three files under `tests/stories/` | Allowed by the specification | Noted |

## G4 Organization

No move, merge, or split is proposed. The retained format register is a Storage projection placed in this group (CE-G2-03).

## G5 Writing

- The integrity check specification referred to "Contract Evolution ... at lines 31 to 37". A line reference drifts, so it now links the `#closed-core-open-extension` anchor.
- The integrity check specification called itself "this draft" twice although it is Accepted. Both now say "this specification".

## Semantic Preservation

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260522-vendor_snapshot_packages.md` | 25 unchanged | 0 | 48 unchanged | 22 unchanged | 0 |
| `20260703-schema_evolution_record_envelope.md` | 62 unchanged, 1 changed (CE-G2-01), 1 added (CE-G2-01) | 0 | 126 unchanged | 30 unchanged | 2 unchanged, 2 added |
| `20260715-contract_stability_baseline.md` | 28 unchanged, 2 changed (CE-CSB-03 readiness rows) | 0 | 44 unchanged | 36 unchanged | 25 unchanged |
| `20261012-product_integrity_check.md` | 31 unchanged, 1 changed ("this draft"), 1 removed (CE-PIC-01 projection sentence about the low-level helper) | 0 | 470 unchanged, 1 added | 32 unchanged | 35 unchanged, 1 moved to an anchor |
| `20261017-retained_format_register.md` | 6 unchanged | 0 | 108 unchanged | 16 unchanged | 16 unchanged |

The inventory tool does not parse table cells as numbers; the register's marker change from schema 4 to schema 5 is CE-RFR-05. No heading anchor or file moved.

## Issues Opened

- #457 `[record-envelope] Envelope readers skip schemaVersion, minCoreVersion and Gateway requiredFeatures checks`, blocking candidate.
- #458 `[record-envelope] Required feature recurring-history-v1 does not use the registered identifier form`, blocking candidate.

## Questions For The Engineer

### Q-09. Is the Pi coding agent patch an accepted exception to the no-patch rule?

- Context: Contract Evolution says that newly introduced dependencies use official unmodified releases and that missing capability is handled by a local guard, an upstream change, or reconsideration, not a patch. `pnpm-workspace.yaml` patches `@earendil-works/pi-coding-agent@1.0.2` to expose `onConnectionState`. The Pi adapter specification and a 2026-09-30 decision describe the patch but do not name it as an exception.
- Options: (A) Record a decision that grants a bounded exception with an upstream removal condition. (B) Replace the patch with a local guard or an upstream release. (C) Leave it.
- Recommendation: A, then B when upstream ships the hook. The patch exists and works; an exception with a removal condition makes it governed.
- Meanwhile: no change.

### Q-10. How should snapshot evidence work for registry and rolling-API sources?

- Context: the vendor snapshot specification requires an immutable upstream tag checkout and a recorded tag and commit. The Codex snapshot comes from an npm package with no git commit, and models.dev is a rolling API. The Accepted Design also says Codex refreshes use the pinned local CLI, while the package README forbids a local CLI.
- Options: (A) Amend the evidence rule to name three source kinds (source tag, registry release, rolling API) with the identity each records. (B) Keep the rule and change the packages.
- Recommendation: A. B is impossible for a rolling API.
- Meanwhile: no change.

### Q-11. Does the vendor snapshot contract cover the Retrieval Kernel dictionary archive?

- Context: `packages/retrieval-kernel/vendor/` holds an unmodified archive with provenance, checksum, and license notice. No specification governs it.
- Options: (A) State in the vendor snapshot specification that package-local build-supply archives are outside it and owned by their consuming specification. (B) Bring it under the snapshot contract.
- Recommendation: A. It is build supply, not a runtime or catalog boundary snapshot.
- Meanwhile: no change.

### Q-12. Should the Terminal Turn Consistency read design be re-derived against the control store?

- Context: the integrity check specification (2026-10-12) reads a line-oriented event log with final-fragment repair off and has fixtures for an incomplete final fragment. The 2026-10-19 control-store decision moved Turn events into control-store rows and immutable content, and the current reader has no final fragment. The operation is Not Started.
- Options: (A) Re-derive the read seam and the fragment fixtures against the control-store reader when the operation is implemented. (B) Amend the specification now.
- Recommendation: A. The control-store specification is held under #440, so its reader is still moving.
- Affected contract text: the read description in Terminal Turn Consistency, the two final-fragment fixtures, and the event-log sentence in Proposed Design.
- Meanwhile: only the projection was corrected.

### Q-13. What mechanism satisfies the release-coupled contract identity gate?

- Context: the stability baseline requires one exact contract identity or digest and a typed incompatibility before unsupported work. The implementation has a hand-set protocol version, a CLI `doctor` check, and response-parse failure; no digest is exchanged per call.
- Options: (A) State that the protocol version, the `doctor` check, and strict response parsing are the current mechanism. (B) Add a per-call identity check.
- Recommendation: A. Release-coupled surfaces need typed failure, not a handshake, and B adds machinery with no present consumer.
- Meanwhile: no change.

### Q-14. Should the L0 testing statement of the stability baseline be narrowed?

- Context: the statement says L0 checks classify new surfaces and reject removed compatibility language. Only the `status` and `implementation` frontmatter check exists.
- Options: (A) Narrow the sentence to the existing frontmatter check. (B) Add the two checks.
- Recommendation: A. A text scan for compatibility words would flag this very document.
- Meanwhile: no change.

### Q-15. Which casing does Knowledge frontmatter use for required features?

- Context: the record-envelope specification maps fields mechanically to snake_case in frontmatter and forbids mixed casing. The Knowledge store specification names `requiredFeatures` for scoped pages, and code requires `requiredFeatures` beside `schema_version`.
- Options: (A) Add a named exception for `requiredFeatures` to the casing rule. (B) Rename the field to `required_features` before `v0.1.0`.
- Recommendation: A. It changes no retained page, and Contract Evolution asks not to churn a settled mechanism without a design need.
- Meanwhile: no change.

### Q-16. When is the retained format register re-baselined against the control store?

- Context: the register still names Workspace, Thread, Turn, Item, Event, AgentSession, and work-observation files as canonical, while code keeps them in control-store tables, and several retained tables with their own `schema_version` have no row. The release upgrade harness reads the register row names.
- Options: (A) Re-baseline the register in the change that lands the held control-store specification. (B) Re-baseline it now.
- Recommendation: A. The storage group is held under #440, and a re-baseline now would chase a moving design.
- Meanwhile: only the three exact cell errors were corrected.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory counts, and checked the cited code itself. Verdict: accept with changes. Dispositions:

1. The readiness cell and the projection dropped S10's ownership of remaining Web work although S10 completion was not verified. Accepted; both now say that S10 owns the remaining multi-user Web work and its browser acceptance.
2. The CE-ENV evidence said that `minCoreVersion` has no reader, but agent and environment schemas refuse it with `z.never()`. Accepted; the evidence cell now says so. Issue #457 already describes the `z.never()` refusal.
3. Q-12 should name the affected contract text. Accepted; it now lists the three places.
4. The same change also adds the owning-rule link to the foundation group record. Accepted as part of this commit; the documentation model validator requires that link in every audit record.
5. The Reviewer did not re-derive the fifteen and eleven operation counts. The auditor relies on the inspector's per-operation listing (sixteen lifecycle definitions minus `workspace.retire-quarantined`); no rewording depends on it.

The Reviewer confirmed CE-G2-01 is a correct alignment because agent manifests are authored configuration, confirmed the spot-checked findings and the inventory counts, and found no content-safety problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (663 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
