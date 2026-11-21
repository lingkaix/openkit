---
status: Accepted
kind: mechanism
implementation: Partial
aspect: knowledge
---
# Knowledge Store Implementation Contract

This specification owns the pinned Open Knowledge Format (OKF) v0.2 conformance baseline, scoped file and SQLite authority layout, record encodings and derived identifiers, the four-stage validation pipeline, the single governed retrieval pipeline and selection-trace publisher, and the product-facing Knowledge Store operations and effects consumed by Knowledge Manager and Worker Context Packages.

## Scope

### Owns

- The OKF v0.2 snapshot pin (`docs/okf-spec-v0.2-snapshot.md`), scoped notebook layout, record encodings, and identifier derivations for Knowledge Pages, Sources, Derived Representations, Observations, Claims, Proposals, Reviews, and rebuildable indexes.
- The four-stage validation pipeline (OKF parse, OpenKit profile validation, Scope Schema validation, conformance computation) and save-time enforcement mechanics.
- The single governed retrieval pipeline and query-owned trace publisher serving product search, Knowledge Manager reads, context preparation, and direct-Task Context Package selection.
- Product-facing Knowledge Store operation families (`knowledge.notebook.*`, `knowledge.source.*`, `knowledge.proposal.*`, `knowledge.schema.*`, `knowledge.indexes`, `knowledge.context.prepare`), store-side effects consumed by Knowledge Manager, and external-influence provenance encoding and retrieval propagation.

### Does Not Own

- Canonical Knowledge semantics and invariants in `docs/core/knowledge.md`, or governance rules, conformance levels, required fields, and conflict policies in `docs/specs/20260702-knowledge_store_governance_rules.md`.
- Fixed-base multi-page virtual editing and publication mechanics in `docs/specs/20260909-knowledge_notebook_editing.md`, or User Memory and reflection rules in `docs/specs/20260909-personal_memory_and_knowledge_learning.md`.
- Knowledge Manager role execution, callers, and typed outputs in `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`, or Worker Context Package assembly, materialization, and delivery proof in `docs/specs/20260703-worker_context_package.md`.
- Shared raw file storage, mounts, and Knowledge Package interchange in `docs/specs/20261018-file_storage_and_knowledge_packages.md`, or physical `DATA_ROOT` and database-per-scope ownership in `docs/specs/20260703-storage_layout_record_ownership.md`.
- Worker capability transport in `docs/specs/20260703-worker_agent_capability.md`, policy evaluation in `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`, or Web UI component design.

### Core

- `docs/core/knowledge.md`
- `docs/core/storage.md`
- `docs/core/mediation.md`
- `docs/core/evidence.md`

## Shared Source References

[File Storage And Knowledge Packages](20261018-file_storage_and_knowledge_packages.md) owns the shared raw namespace, mounts, and interchange contract. Existing scope roots retain a fixed default Knowledge Base ID, and references bind it explicitly. Notebook `SourceSummary` pointers at `sources/<sourceId>.md` replace the retired external Source registry (`sources/registry/`, `sources/materials/`, `sources/derived/`) as Source authority. Version `0.1.0` package import targets a new or empty Workspace Knowledge Base; additional Knowledge Bases per scope require a later additive contract (`#265`). Sources may bind binary originals through Storage, and registration publishes a Notebook Source pointer.

The default mount's physical `raw/` directory belongs to the Knowledge Base while additional mounts travel as references. Packages preserve published `sources/<source-id>.md` pointers without creating a second registry. The Notebook publisher owns pages and Source pointers, and both the source-reference resolution rule and the copy-not-move invariant apply to Notebook Source pointers. Derivation performs conversions, retrieval owns indexes, and Knowledge Manager selects recipes through a media-handling Skill.

## OKF Version Pinning

OpenKit targets OKF version `0.2` exactly as captured in `docs/okf-spec-v0.2-snapshot.md` (`OKF_SNAPSHOT_ID` in `apps/nanocore/src/knowledge/okf.ts`). All statements about OKF compatibility, bundle conformance, reserved filenames, frontmatter shape, linking, index files, and log files MUST be interpreted against that snapshot, never against live upstream text. Adopting a newer OKF revision requires a new dated snapshot and an update to this specification. User, Workspace, and Server knowledge bundles MUST declare `okf_version: "0.2"` in the bundle-root `index.md` frontmatter block, the only place the snapshot permits index frontmatter.

The `OKF-compatible` conformance level from `docs/specs/20260702-knowledge_store_governance_rules.md` means passing §11 of the snapshot: parseable YAML frontmatter in every non-reserved `.md` file, a non-empty `type` field, and reserved-filename structure when `index.md` or `log.md` is present. The permissive consumption rules in §11 apply to import only and never weaken save-time enforcement for governed records.

Frontmatter uses one YAML mapping with string keys, rejects parse errors and duplicate keys, and bounds alias expansion (current default `50` expansions in `apps/nanocore/src/knowledge/okf.ts`, refusing alias cycles). Nested mappings, sequences, scalars, and unknown fields are preserved. Base concept conformance requires only parseable frontmatter and a non-empty string `type`; unknown types, absent optional metadata, broken links, and a missing index do not reject an external bundle. A bare `verified` mapping is read as one verification entry without rewriting its raw representation. Higher OpenKit profile and Scope Schema checks remain separate. `source_refs` MUST contain only strings before any reference comparison, sorting, or reminting.

Fresh Notebook initialization ensures the root index once: a missing root in the initial tree creates a version block, heading, and immediate page and directory links; valid supplied `0.2` bytes remain unchanged; a structurally valid body-only index receives only the version block before its unchanged body. Malformed frontmatter, a non-string version, or another version fails before initial Git publication. Native portability retains valid reserved Markdown bytes; import may add a missing target index but MUST NOT replace a valid human-authored index. Published Notebook edits retain the required root version and do not regenerate index navigation; navigation changes only when authored in a human edit or a later admitted Knowledge Manager maintenance run. Thread storage never reads or repairs a materialized `pages/` directory. Existing Git corruption returns `recovery_required`. Every page enumerator excludes reserved basenames at every depth.

## Scoped Memory And Revisions

[Personal Memory And Scoped Knowledge Learning](20260909-personal_memory_and_knowledge_learning.md) defines User, Workspace, and Server scope admission, and [Knowledge Notebook Editing](20260909-knowledge_notebook_editing.md) owns one Git content history and fixed-base multi-file publication. Governed Markdown bytes remain immutable content in Notebook Git history. Workspace SQLite selects the admitted Notebook commit and exact immutable Scope Schema reference (`notebook-workspace-selection.ts`), and owns Proposal metadata and ordered Review decisions (`FsStore.commitWorkspaceKnowledge`). User Memory and Server Knowledge retain their scope writers. A one-way pre-serving transaction transfers verified predecessor heads, original Proposals, and ordered Reviews before recording activation; fresh Workspace creation seeds that authority from its private unpublished staging root. Missing or unsupported existing authority fails as `recovery_required`; no Git ref, authored YAML, or empty-table fallback may reseed it. Fresh notebooks initialize directly in profile `openkit-knowledge-profile-v1` and schema `openkit-scope-knowledge-schema-v1` (`OPENKIT_KNOWLEDGE_PROFILE_VERSION` and `DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_VERSION` in `apps/nanocore/src/knowledge/okf.ts`). Explicit prerelease resets follow [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md) and never authorize automatic reset or reinterpretation of retained Page or schema meanings.

Profile `openkit-knowledge-profile-v1` Page frontmatter stores its complete owner mapping in `scope` (`KnowledgeOwnerScopeSchema` in `packages/protocol/src/models/knowledge-notebook.ts`, without adding a parallel `owner_scope` field on Pages, while Proposal wrappers retain `owner_scope`) and carries `required_features` (`REQUIRED_SCOPED_KNOWLEDGE_FEATURES` in `apps/nanocore/src/knowledge/okf.ts`); readers validate those semantics before returning content or mutating a notebook.

Every operation, lookup, and request hash includes exact `ownerScope`. Profile `openkit-knowledge-profile-v1` has no page revision counter: `notebookRevision` is the opaque full published Git commit ID, `contentDigest` is `sha256:` plus 64 lowercase hexadecimal digits of the exact page bytes (`KnowledgeContentDigestSchema`), and API `revision` fields project `notebookRevision`. Git retains prior bytes while Sources retain original evidence rather than duplicate page-history copies. A forgotten page identity remains reserved by suppression metadata; a later explicit save uses a new page identity at the current notebook base.

Human edits, ordinary delegated edits, and reviewed candidates share the same publisher and scope writer fence. Proposal and Review records retain an exact base commit, candidate commit, source versions, and responsible actor; older immutable decisions remain historical evidence and never authorize a new effect. Generated pages may serve as editing or comparison inputs with exact lineage, but MUST NOT bootstrap factual authority by citing each other.

## File Layout And Identifiers

The workspace knowledge tree under `docs/specs/20260703-storage_layout_record_ownership.md` is:

```text
<workspace>/
  knowledge/
    schema/
      scope-schema.yaml
      history/
    notebook.git/  # immutable content and retained history; SQL selects the Workspace head
    pages/         # optional materialization of one commit
      index.md
      log.md
      <concept-path>.md
    proposals/
      <proposalId>.md
    reviews/
      <proposalId>.json
  indexes/
```

`pages/` in the published Git tree is the OKF bundle root (`knowledge/pages/` is an optional materialization), so reserved `index.md` and `log.md` live inside `pages/`, and bundle-root `index.md` carries `okf_version`. `schema/`, `proposals/`, and `reviews/` sit outside the exported OKF bundle. For Workspace Knowledge, retained SQLite control rows and immutable references select the admitted schema, original Proposal, and ordered Reviews; readable predecessor files are not a second authority. Query selection traces belong to their querying Thread or Turn, not the notebook. Concept IDs equal the bundle-relative path without `.md`.

A `knowledgePageId` (`KnowledgeNotebookPageIdSchema` and `KnowledgeNotebookPathSchema` in `packages/app-api-schemas/src/knowledge-notebook.ts`) is 1 to 240 UTF-8 bytes of forward-slash-separated lowercase ASCII segments, each matching `[a-z0-9][a-z0-9._-]{0,63}`; empty segments, `.` or `..`, final `index` or `log`, trailing `.md`, backslashes, absolute paths, control characters, NUL, and `@` are invalid. Reserved files are excluded at every depth. Resolve IDs only within the admitted commit's `pages/` tree and reject symlinks, non-regular content, and unsafe materialization parents. Published paths remain stable; reorganization uses title/index edits, new pages, and archive/supersede without a path-move or identity-history engine.

Knowledge Pages are OKF concept documents carrying the required profile fields (`REQUIRED_PROFILE_FIELDS` and `REQUIRED_SCOPED_KNOWLEDGE_FEATURES` in `apps/nanocore/src/knowledge/okf.ts`) as producer-defined extension keys under `docs/specs/20260702-knowledge_store_governance_rules.md`. OKF `description`, `tags`, `resource`, `sources`, `generated`, `verified`, `status`, `stale_after`, and Attested Computation metadata retain snapshot semantics as data. `updated_at` is authoritative for OpenKit freshness computation. `DEFAULT_SCOPE_KNOWLEDGE_SCHEMA_TEXT` in `apps/nanocore/src/knowledge/okf.ts` defines the default Scope Schema serialization and its 14 default allowed types (`OPENKIT_BASE_TYPES` plus `OPENKIT_DOMAIN_TYPES`), while `Procedure` is refused because reusable procedures belong to Skills.

The authorized `knowledge.notebook.list` response (`ListKnowledgeNotebookResponseSchema` in `packages/app-api-schemas/src/knowledge-notebook.ts`) includes `knowledgeBaseId` beside `notebookRevision` and canonical `pages` even when empty. A client resolves a page citation to that collection only when its complete owner and `knowledgeBaseId` match, never by a coincident page path. Page-valued `source_refs` and Knowledge Manager citations use the [Core Protocol URI](../core/protocol.md#scope-qualified-object-references); a digest pin binds exact page bytes while `notebookRevision` remains separate evidence. Within Page `source_refs`, registered-source references use `source:<sourceId>` or `source:<sourceId>@<contentDigest>`, and page validation and source-reference indexes resolve them against the owning scope's Notebook Source pointers (`sources/<sourceId>.md`), reporting missing targets or unmatched pins as unresolved without rewriting page bytes or treating resolution as proof of review, byte integrity, or retrieval authorization.

The Workspace Scope Schema head selects exact immutable YAML bytes (`knowledge/schema/scope-schema.yaml` is an authored draft or readable projection, not the active head). Previous valid schema bytes and migration reports remain retained independently of receipt expiry (projected under `knowledge/schema/history/`). Unknown descriptive extensions remain intact; unknown core values and unsupported required semantics fail closed. Reviewed Workspace schema application (`knowledge.schema.apply`) follows [Durable Execution And Control Store](20261019-durable_execution_and_control_store.md#reviewed-workspace-schema-application) without an idle-Workspace lifecycle freeze: it prepares immutable inputs, compares the head, inventories current dependencies, verifies that reviewed impact classes bound actual impact, and commits the native head, Audit, and original receipt in one transaction.

Original Proposals are immutable Markdown records validated and serialized by `KnowledgeProposalRecordSchema` and `serializeKnowledgeProposalRecord` (`apps/nanocore/src/storage/knowledge-proposal-codecs.ts`, `KnowledgeManagerDraftProposalRequestSchema`, and `KnowledgeNotebookProposalChangesSchema` in `packages/app-api-schemas/src/knowledge-manager.ts`). `proposalId` (`knowledgeProposalId`) is `kp_` plus the 64-character lowercase hexadecimal digest from [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#derived-entity-kinds-and-namespaces) over `{ownerScope, requestId}`, where `ownerScope` is the complete `KnowledgeOwnerScopeSchema` object and `requestId` is the exact request string. A service-owned Git ref `refs/proposals/<proposalId>` retains the immutable candidate commit whose sole parent is `base_revision`. Workspace SQL binds the Proposal to that immutable original and candidate; User and Server Proposal files retain their scope authority.

Generated-proposal `sourceReferences` is a bytewise-sorted, duplicate-free string array using this closed five-form grammar (`@` is forbidden inside IDs):

- `source:<sourceId>@<contentDigest>`: one registered Knowledge Source (`ks_` plus lowercase canonical UUID, checked for safe single-segment path and symlink containment) and its `sha256:` content digest.
- `openkit:<page-scopeId>/<knowledgePageId>@<contentDigest>`: one admitted Knowledge Page in its exact owner/Knowledge Base and digest at the proposal base commit (comparison material only; cannot alone corroborate a new factual claim).
- `turn:<turnId>`: one terminal same-Workspace Worker Turn.
- `item:<itemId>`: one completed immutable Item owned by that cited Turn.
- `context-package:<turnId>@<contextPackageDigest>`: that Turn's exact accepted [Worker Context Package](20260703-worker_context_package.md) trace and digest.

A generated proposal claiming completed Worker output MUST contain the matching three-reference trio (`turn`, final completed `assistant-message` `item`, and strict live `context-package` reference) agreeing on Workspace, Thread, Turn, terminality, and delivery lineage. Bare IDs, external URLs, nonterminal work, unverified generated-Page references, current-page substitution, and unsupported prefixes fail validation and create no proposal.

The retained Review envelope and ordered decision rows are validated by `KnowledgeProposalReviewFileSchema` and `KnowledgeProposalReviewRecordSchema` (`apps/nanocore/src/storage/knowledge-proposal-codecs.ts`). Workspace SQL owns ordered decisions; User and Server scopes retain `knowledge/reviews/<proposalId>.json`. `reviewId` is `kr_` plus canonical lowercase UUIDv5 text in the fixed Knowledge Review namespace from [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#derived-entity-kinds-and-namespaces) over `{ownerScope, proposalId, requestId}` ([One Identifier Mechanism](../decisions/20261014-one_identifier_mechanism.md)). `decision` is `deferred`, `accepted`, or `rejected`; `accepted` and `rejected` are terminal with at most one terminal row, and duplicate request/review IDs or later terminal rows invalidate the sequence. For Workspace Knowledge, accepted publication commits the Review with both selected heads, required Audit, and original receipt in one native SQL transaction; User and Server writers atomically replace their Review file with previous exact rows plus the new row.

Claims and reusable Observations (including conflict analysis) are canonical OKF pages in the published Git tree; Claim `confidence` is finite numeric `[0, 1]`. No standalone fact-ledger operation, DTO, or monthly JSONL family exists.

## Upload Intake And Source Registration

User uploads through product surfaces are work-history records, not Knowledge Sources by default: bytes land at `threads/<threadId>/turns/<turnId>/inputs/` with item-log metadata (`fileId`, filename, content digest, size, sensitivity hint) under thread-history retention.

An upload becomes a Knowledge Source only through explicit registration (`knowledge.source.register`), which copies the bytes into `sources/<sourceId>/original` under the default mount, computes a `sha256:` digest, and publishes one Notebook `SourceSummary` pointer at `sources/<sourceId>.md` carrying the originating Workspace, Thread, Turn, file ID, and content digest. Registration is a copy, not a move, and API responses (`knowledge.source.register`, `knowledge.source.list`, `knowledge.source.read`) include derived representation metadata without returning captured source content. Registration occurs before proposal drafting through an explicit authorized user action or the user-enabled bounded conversation capture in [Personal Memory And Scoped Knowledge Learning](20260909-personal_memory_and_knowledge_learning.md); proposal review and application never capture sources, and capture is off by default. Knowledge Pages, Claims, and `SourceSummary` records MUST cite registered `sourceId`s and MUST NOT reference raw thread attachments.

## Validation Pipeline

All writes to governed records MUST pass through NanoCore's knowledge service (`knowledge/` and `sources/` have no other writer) and complete four ordered stages before writing, replacing, renaming, or removing any authoritative Knowledge Page:

1. **OKF parse**: frontmatter/body split, YAML parse, reserved-filename structure.
2. **Profile validation**: OpenKit required fields, base types, forbidden secret-like field names (per the Vault boundary), and source-reference shape.
3. **Scope Schema validation**: allowed types, field constraints, and review rules.
4. **Conformance computation**: `OKF-compatible`, `OpenKit-profile-valid`, or `scope-schema-valid`, recording the schema version, profile version, and OKF snapshot identity.

Failed validation returns a bounded structured validation result with zero authoritative page, proposal-application, or derived-index mutation. Proposal intake also applies a pre-persistence text guard to candidate bytes and rationale, rejecting local-home path forms (`/Users/...`, `/home/...`, `~/...`, Windows drive-absolute paths, UNC paths) as `400 invalid_request` without echoing the rejected text; ordinary content is not rejected for raw credential patterns ([No Credential-Pattern Rejection Of Ordinary Content](../decisions/20261006-no_credential_pattern_rejection_of_ordinary_content.md)).

Imports, rough notes, and Knowledge Manager drafts may be saved only through an explicit draft path with `openkit_status: draft`, standard `status: draft`, and `review_state: needs-review`, with the validation report persisted; an invalid draft MUST NOT replace a valid active page. Direct title/body edits preserve unknown YAML metadata by updating only managed fields in the current document and passing the exact validated byte sequence to persistence without rereading or reserializing. Knowledge Package current-tree import remints `source_refs` and conflict `subject_refs`, recalculates dependent page digests, and binds package selections to the new target commit; ordinary portable Workspace import is absent and does not remint references, retrieval-trace collections, or `krt_` IDs (while export retains original object IDs).

## Indexes

`indexes/` holds three derived, rebuildable non-lexical JSON projections rebuilt from one pinned published notebook tree and exposed via `knowledge.indexes`: `indexes/knowledge-links.json` (directed Markdown link graph per snapshot §6.1), `indexes/knowledge-validation.json`, and `indexes/knowledge-source-refs.json`. A single command rebuilds all indexes from authoritative files with identical retrieval behavior. [Retrieval Kernel](20261014-retrieval_kernel.md) owns the lexical projection over title, description, tags, and body with one generation per read-eligibility scope.

Persisted indexes are tagged with their source notebook commit. Active authorized `user-authored`, `delegated` (with valid delegated publication), and reviewed `accepted` pages form the default selectable set; other Review states produce `lower_conformance` (`review_state_ineligible`), and `accepted` or `delegated` pages missing exact reference proof produce `lower_conformance` (`reference_proof_missing_or_mismatch`). Explicit non-active state inspection requires trusted `caller: "app-api"` admission; automatic callers remain active-only. Current unresolved Observation `subject_refs` are read from published Notebook bytes (`conflicts.ts`) rather than a derived index.

## Retrieval Pipeline

The context-bound governed retrieval request (`RetrieveKnowledgeRequestSchema` and `KnowledgeQueryContextSchema` in `packages/app-api-schemas/src/knowledge-manager.ts`) requires non-empty `query` and `limit` 1 through 20 (current default 5). Trusted assembly binds `(Server, Workspace, Actor, Thread/Turn)` ([Query Context, Sources, References And Acts](../decisions/20261015-context_sources_references_query_acts.md)). `sourceScope` is omitted or `"workspace"` (current Workspace Knowledge) or `"server"` (current Server Knowledge when admitted); any other value, missing/contradictory context, or unadmitted source fails before inventory access. One invocation addresses one Knowledge Base.

A threadless direct User App call (`app.search`, `knowledge.retrieval`, Knowledge Manager `answer`, or `app-api` `prepare-context-material` without Thread/Turn) returns selection facts (`KnowledgeRetrievalResponseSchema`) with qualified page references and publishes no trace (`traceId`, `retrievalTraceId`, and `retrievalTraceRef` are absent); a caller MUST NOT omit an existing Thread or Turn to skip trace publication.

Every pin (`KnowledgePageReferenceSchema`) is a [Core Protocol reference](../core/protocol.md#scope-qualified-object-references) `{scopeId, objectId}` where `scopeId` identifies the notebook's page collection with its logical `ownerScope` and `objectId` is the `knowledgePageId` without `.md`. Pins are bytewise-sorted by `objectId`, duplicate-free, and restricted to the selected source. `states` is a non-empty subset admitted by `RetrieveKnowledgeRequestSchema` (default `[active]`, broadenable only by `caller: "app-api"`). Retrieval uses [Retrieval Kernel](20261014-retrieval_kernel.md) BM25 scores and CJK segmentation, requiring complete inventory and lexical enumeration before selection, and orders candidates within one source by: pinned first, descending local score, then bytewise `pageId` and `revision`. Scores are never compared across separate indexes or merged between Memory and Knowledge.

Before disposition, retrieval reads every addressed authoritative page at the pinned commit (`notebookRevision`) and verifies its exact revision, digest, and metadata. A missing or unreadable page is `source_unavailable`; any other disagreement between authoritative bytes and an index row or posting returns `recovery_required` with zero selected results and no trace. Each coherent candidate receives one first-match disposition (`KnowledgeRetrievalExclusionSchema` in `packages/app-api-schemas/src/knowledge-manager.ts`) in this exact order:

1. Readable `restricted` label, or `confidential` label outside User Memory -> `sensitive_content`.
2. Invalid or below `scope-schema-valid` -> `lower_conformance`.
3. Current authorization or policy denial -> `policy_excluded`.
4. State outside requested filter, unresolved conflict, ineligible `review_state`, or invalid publication lineage -> `lower_conformance` (with optional descriptive `eligibilityReason` from the closed seven-value set in `KnowledgeRetrievalExclusionSchema`).
5. `stale` or `expired` freshness -> `freshness_expired`.
6. Mismatch with supplied `types` or `appliesTo` selectors ([Knowledge Notebook Editing](20260909-knowledge_notebook_editing.md#typed-domain-pages)) -> `selector_mismatch`.
7. Eligible candidate beyond `limit` -> `budget_exceeded`.
8. Remaining candidates -> `selected`.

Denied, `restricted`, missing, or unreadable candidates expose no content digest or sub-reason.

A query with a Turn publishes one immutable trace file at `threads/<threadId>/turns/<turnId>/retrieval-traces/<traceId>.json` (or `threads/<threadId>/retrieval-traces/<traceId>.json` when only a Thread exists) via atomic temp-file rename; an existing target conflicts and stays unchanged. Ordinary trace allocation uses `krt_` UUIDv7; direct-Task preparation derives `krt_` UUIDv5 in the Knowledge Retrieval Trace namespace over `{"command":"task.start.knowledge-retrieval","actorId":actorId,"workspaceId":workspaceId,"threadId":threadId,"requestId":requestId}`, while Coordinator direct-Task preparation derives `krt_` UUIDv5 over the JSON string `requestId` in the same namespace ([Identifier Derivation And Import Allocations](../decisions/20261016-identifier_derivation_and_import_allocations.md)).

Trace metadata follows `KnowledgeRetrievalTraceSchema` and `KnowledgeRetrievalTraceReaderSchema` (`packages/app-api-schemas/src/knowledge-manager.ts`) with `caller` (`KnowledgeManagerCallerSchema`). As a named retained exception to [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md), `requestDigest` is `sha256:` plus 64 lowercase hexadecimal digits over the UTF-8 JSON of `{queryContext, sourceScope, caller, request}` (where `request` holds `query`, supplied normalized filters `types` and `appliesTo`, `limit`, normalized `pinnedReferences`, `states`, and the `user`/`workspace`/`server` source selector; absent selectors add no keys) serialized by recursively sorting object keys in UTF-8 bytewise order while preserving array order (`apps/nanocore/src/storage/index-rebuild.ts`). Selected (`KnowledgeRetrievalCandidateSchema` without `score`) and excluded (`KnowledgeRetrievalExclusionSchema`) entries retain no source bodies, titles, snippets, query text, matched terms, or scores. Trace reads and exports recheck both the containing record's audience and current source access for every reference.

This pipeline is the single governed retrieval owner for product search, Knowledge Manager `answer` and `prepare-context-material`, and direct-Task Context Package selection, sharing `knowledge.read` admission in [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md). Retrieval never mutates Knowledge; its trace proves selection only, while [Worker Context Package](20260703-worker_context_package.md) alone materializes and proves Worker delivery (including bounded excerpts or descriptors under its own byte/token budgets).

## Knowledge Operations, Restoration, And Provenance

Product surfaces invoke Knowledge operations through the declarative operation catalog (`packages/app-api-schemas/src/knowledge-operation-definitions.ts`), App API, Core Client, remote MCP, and bundled CLI; the retired `@openkit/mcp` stdio facade and retired Workspace `memory` aliases remain absent, and NanoCore exposes no `/api/worker-capabilities/knowledge/*` HTTP routes (Worker `knowledge_ask` and `knowledge_tell` use the Knowledge Manager operation projection). Verified Workspace export excludes actionable Proposal and Review owners, whereas complete data-root backup preserves them under unchanged Workspace identity.

Scoped notebook endpoints expose read, paginated history (current default 20, max 100, opaque commit cursor), diff (current default max 256 paths and 64 KiB output with explicit truncation indicator, which MUST NOT authorize an incomplete destructive confirmation), update, delete, and restore (`{baseRevision, fromRevision, pageIds, summary}`). `knowledge.proposal.decide` accepts `accepted`, `rejected`, or `deferred` under request-idempotency replay (`idempotency_key_conflict` on changed input; `conflict` on stale base; `recovery_required` on incomplete publication/receipt evidence). `knowledge.proposal.reverse` restores selected paths from the retained proposal base into the current fixed base, verifying that the current target path still matches the reviewed candidate, requiring exact human confirmation when removing a Proposal-created page, and publishing a new commit while preserving intervening history.

### Influence Encoding And Retrieval

Knowledge and Memory revisions MUST encode the conservative external-influence boolean (`externallyInfluenced` on `KnowledgeNotebookCommitMetadataSchema`) alongside content provenance ([Runtime Security](20261109-runtime_security.md) E9; [Knowledge](../core/knowledge.md)). Publication from an influenced context MUST write `true`, derived representations and consolidation MUST preserve it, validation MUST reject malformed values and treat absent or unknown ancestry as influenced, and governed retrieval MUST set the reading context's sticky bit before returning affected material; human Review never clears external influence.

## Acceptance

- Rebuilding derived indexes from the published Git tree with one command produces identical tokenizer, scorer, disposition, and trace results across product search, Knowledge Manager `answer` and `prepare-context-material`, and direct-Task Context Package selection, and reopening across restarts preserves exact scope/type distinction, unchanged existing-target trace conflicts, and zero replacement retrieval after unproved partial work.

## Implementation

- Knowledge store, OKF parser, publisher, and retrieval adapter: `apps/nanocore/src/knowledge/`, `apps/nanocore/src/`.
- Index rebuild, Proposal/Review codecs, and Workspace SQL authority: `apps/nanocore/src/storage/`, `apps/nanocore/src/lib/`.
- Protocol models, digests, and operation schemas: `packages/protocol/src/`, `packages/app-api-schemas/src/`, `packages/core-client/src/`, `packages/config-schema/src/`.

## Implementation Gaps

- Full historical trace and archive disclosure closure across exports - Full historical trace and archive disclosure closure is not implemented - #266
- Incompatible imported Notebook schema conversion - Rich imported Notebook schema conversion is not implemented - #404

## Decisions

- [No Credential-Pattern Rejection Of Ordinary Content](../decisions/20261006-no_credential_pattern_rejection_of_ordinary_content.md)
- [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [One Identifier Mechanism](../decisions/20261014-one_identifier_mechanism.md)
- [Query Context, Sources, References And Acts](../decisions/20261015-context_sources_references_query_acts.md)
- [Identifier Derivation And Import Allocations](../decisions/20261016-identifier_derivation_and_import_allocations.md)
