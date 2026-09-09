---
status: Accepted
implementation: Partial
---
# Knowledge Store Implementation Contract

## Owns

- The pinned OKF version decision and the conformance relationship between OpenKit and the OKF snapshot.
- Concrete file layout, record encodings, and identifier rules for knowledge pages, sources, derived representations, observations, claims, proposals, reviews, and indexes.
- The validation pipeline: parser, OpenKit Knowledge Profile validator, scope schema validator, conformance computation, and save-path enforcement mechanics.
- The single v1 governed retrieval pipeline that selects knowledge candidates for product search, Knowledge Manager reads, context preparation, and Task Context Package assembly.
- Product-facing Knowledge operation families and their store-side effects.
- The Knowledge Store validation, retrieval, proposal, and trace effects consumed by the separately owned Knowledge Manager operations.
- The one-time migration from the minimal knowledge implementation projection to governed Knowledge Store vocabulary and layout.

## Does Not Own

- Canonical knowledge semantics, roles, and invariants, owned by `docs/core/knowledge.md`.
- Governance rules, conformance levels, required fields, base types, observation retention, conflict states, proposal rules, and trace visibility policy, owned by `docs/specs/20260702-knowledge_store_governance_rules.md`.
- Context package assembly, categories, materialized worker file layout, and worker-delivery proof, owned by `docs/specs/20260703-worker_context_package.md`.
- The Knowledge Manager operation names, caller contract, typed outputs, and request lifecycle, owned by `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`.
- Worker capability transport, authentication, and route envelope rules, owned by `docs/specs/20260703-worker_agent_capability.md`.
- Physical `DATA_ROOT` ownership and database-per-scope rules, owned by `docs/specs/20260703-storage_layout_record_ownership.md`.
- Policy evaluation semantics, owned by `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`.
- Notebook UI design and Web product surfaces.

## Core References

- `docs/core/knowledge.md`
- `docs/core/storage.md`
- `docs/core/agent-capability.md`
- `docs/core/audit.md`

## Related Docs

- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`

## Summary

This spec turns the accepted Knowledge Store governance rules into an implementable contract. It pins the portable envelope to OKF v0.2 via a repository snapshot, defines the scoped notebook layout and record encodings, specifies validation before authoritative page writes, defines one deterministic governed retrieval owner for current knowledge-reading surfaces, fixes source-linked create and exact-base replace application plus bounded create reversal through existing owners, names the product operation families, defines the store-side effects consumed by Knowledge Manager and S39, and specifies the direct migration from the current minimal knowledge slice.

The design principle is file-system-first with one deterministic rebuildable index projection: governed Markdown page files are authoritative, V1 uses the portable JSON indexes under `indexes/`, and no SQLite, vector, graph, or other accelerator may become a second source of truth or a second retrieval owner.

## Goals / Non-goals

Goals:

- Make the Knowledge Store buildable without further design decisions for the v1 retrieval-first scope.
- Pin OKF conformance to a fixed snapshot so external drift cannot silently change OpenKit validity rules.
- Keep every governed record inspectable and portable as plain files.
- Make retrieval deterministic, explainable, and traceable in v1.
- Keep retired Workspace `memory` aliases absent while implementing intentional User Memory through the common scope resolver.

Non-goals:

- No unattended or multi-page synthesis beyond the bounded candidate extraction and single-page consolidation owned by the scoped learning extension.
- No mandatory vector search, graph database, or embedding infrastructure in v1.
- No domain-specific workspace schemas as part of the core contract.
- No notebook UI component design.

## Background

`docs/specs/20260702-knowledge_store_governance_rules.md` defines the layered contract (OKF-compatible files, OpenKit Knowledge Profile, Scope Schema), conformance levels, required fields, save-time enforcement rules, observation and claim governance, proposal rules, and Knowledge Manager responsibilities. It deliberately does not define file layouts, encodings, pipelines, or operation names. This spec closes that gap. The product vision fixes the v1 posture as retrieval-first: knowledge selection over knowledge generation, history first, explicit knowledge over speculative knowledge.

## Decision

### OKF version pinning

OpenKit targets OKF version 0.2 exactly as captured in `docs/okf-spec-v0.2-snapshot.md`. All OpenKit statements about OKF compatibility, bundle conformance, reserved filenames, frontmatter shape, linking, index files, and log files MUST be interpreted against that snapshot, never against the live upstream document. Adopting a newer OKF revision requires a new dated snapshot plus an update to this spec; until then, upstream changes have no effect on OpenKit behavior. User, Workspace and Server knowledge bundles MUST declare `okf_version: "0.2"` in the bundle-root `index.md` frontmatter block, the only place the snapshot permits index frontmatter.

The `OKF-compatible` conformance level from the governance spec is defined operationally as passing the snapshot's §11 conformance rules: parseable YAML frontmatter in every non-reserved `.md` file, a non-empty `type` field, and reserved-filename structure when `index.md` or `log.md` are present. The permissive consumption rules in §11 apply to import; they do not weaken OpenKit save-time enforcement for governed records.

Frontmatter uses one YAML mapping with string keys, rejects parse errors and duplicate keys, and bounds alias expansion through the installed YAML parser. Nested mappings, sequences, scalars, and unknown fields are preserved. Base concept conformance requires only parseable frontmatter and a non-empty string `type`; unknown types, absent optional metadata, broken links, and a missing index do not reject an external bundle. A bare `verified` mapping is read as one verification entry without rewriting its raw representation. Higher OpenKit profile and Scope Schema checks remain separate. `source_refs` must contain only strings before any reference comparison, sorting, or reminting.

The existing Knowledge layout/write boundary ensures the root index once: missing creates a version block, heading, and immediate directory links; valid existing v0.2 bytes remain unchanged; a structurally valid body-only index receives only the version block before its unchanged body. Malformed frontmatter, a non-string version, or another version fails without overwriting that file. Native portability retains reserved Markdown bytes; import may add a missing target index but never replace a valid human-authored index. Page edits do not maintain index navigation. Every page enumerator excludes reserved basenames at every depth.

### Scoped Memory And Revision Extension

This implementation owner also owns the direct schema migration: move the one validated Workspace schema from `knowledge/schema/workspace-schema.yaml` to `knowledge/schema/scope-schema.yaml`, update it and page metadata to profile/scope-schema v3, and retain the existing schema history and migration report. Preflight rejects conflicting source/destination files or mixed revisions without overwriting either. User and Server stores are created directly in the new layout. Current implementation still writes the old Workspace schema path; that is a migration gap, not a compatibility alias.

`20260909-personal_memory_and_knowledge_learning.md` extends this same implementation with explicit User/Workspace/Server ownership, profile v3 revision metadata, source-registered personal conversation, single-page replacement and bounded learning. `20260703-storage_layout_record_ownership.md` is the sole physical-root owner. The concrete field changes below project the scoped and replacement governance in S60; existing V1 behavior is identified only in Current Implementation Projection and is not a second target contract.

The target `scope` is the exact resolved owner object and all operation identities, deterministic proposal/review request hashes and lookup keys include it rather than assuming `workspaceId`. Page profile and scope schema v3 require `openkit_revision`; create uses 1 and every exact-base replacement/direct edit increments it. A forgotten/deleted identity retains its last revision in the existing maintenance record and cannot be recycled as revision 1. Removed generated-create ids remain reserved; monotonic revisions additionally guard exact-base replacement and prevent an earlier create reversal from removing later replacements. Explicit saving after removal uses a new page identity.

Proposals add `operation: replace`, `expected_base: { revision, content_digest }` and `base_source_ref` for a registered exact prior-page snapshot; create supplies an explicit absent base. Candidate bytes still occupy the existing proposal body. Reviews replace the Workspace-only identity with owner scope and replace `targetAbsentAtDecision` with `targetStateAtDecision: { kind: absent } | { kind: revision, revision, contentDigest }`, fixed from current owner facts. The latter must exactly match the proposal base. This is a direct schema migration, not a dual-format compatibility path. Existing Review rows remain immutable historical evidence and cannot authorize a new versioned effect.

Registered Source snapshots remain the evidence bridge for conversation and retained base bytes. A replace target may cite its exact current generated-page base as comparison material, but independent source lineage must ground new factual claims. No arbitrary generated-page authority graph is admitted. Shared parsing, validation, schema migration, current-source authorization, one deterministic retrieval owner and exact review/page completion continue to apply. New scoped behavior is Not Started and is not implied by the V1 implementation projection below.

### File layout and identifiers

The workspace knowledge tree follows the workspace scope layout in the storage spec:

```text
<workspace>/
  knowledge/
    schema/
      scope-schema.yaml
      history/
    pages/
      index.md
      log.md
      <concept-path>.md
    proposals/
      <proposalId>.md
    reviews/
      <proposalId>.json
    observations/
      <YYYYMM>.jsonl
    claims/
      <YYYYMM>.jsonl
    conflicts/
      <YYYYMM>.jsonl
    traces/
      <YYYYMM>.jsonl
  sources/
    registry/
      <sourceId>.json
    materials/
      <sourceId>/content.txt
    derived/
      <sourceId>/
  indexes/
```

`knowledge/pages/` is the OKF bundle root for the workspace notebook, so the reserved `index.md` and `log.md` files live inside `pages/`, and the bundle-root `index.md` carries the `okf_version` declaration. The governance surfaces outside the bundle — `schema/`, `proposals/`, `reviews/`, `observations/`, `claims/`, `conflicts/`, and `traces/` — match the governance spec's notebook-versus-maintenance split and are not part of the exported OKF bundle. Concept IDs follow the snapshot rule: bundle-relative path with the `.md` suffix removed.

A V1 `knowledgePageId` is 1 to 240 UTF-8 bytes of forward-slash-separated lowercase ASCII segments, each matching `[a-z0-9][a-z0-9._-]{0,63}`; empty segments, `.` or `..`, a final segment `index` or `log`, a trailing `.md`, backslash, absolute paths, control characters, NUL, and `@` are invalid. Lowercase-only identity prevents case-folding collisions on portable default file systems while reserving `index.md` and `log.md` at every hierarchy level. Before proposal persistence and every page read or write, NanoCore joins `<knowledgePageId>.md` beneath the canonical `knowledge/pages/` root, rejects any existing symlink or non-directory parent, rejects a symlink target, and verifies that the normalized target remains inside that root. Renaming or moving a page changes its id and is not a V1 mutation operation; a future design must define reference repair before such an operation is authorized.

`sources/` is a sibling record family, not a subdirectory of `knowledge/`, even though the Knowledge Store conceptually governs sources and derived representations: the evidence layer is consumed by context packages, evidence bundles, audit traces, and artifacts as well as by knowledge pages, and it has different size, immutability, backup, and retention characteristics than the notebook. Physical layout follows record family and lifecycle; conceptual ownership stays with `docs/core/knowledge.md`.

Knowledge pages are OKF concept documents whose frontmatter carries the OpenKit required fields from the governance spec (`type`, `title`, `schema_version`, `openkit_status`, `openkit_revision`, `scope`, `source_refs`, `review_state`, `sensitivity`, `freshness`, `created_at`, `updated_at`) as producer-defined extension keys, which the pinned snapshot explicitly permits. OKF `description`, `tags`, `resource`, `sources`, `generated`, `verified`, `status`, `stale_after`, and Attested Computation metadata retain snapshot semantics as data. `updated_at` remains authoritative for OpenKit freshness computation; no timestamp or citations compatibility fallback exists. OpenKit Knowledge Profile is `openkit-knowledge-profile-v3` and the default Scope Schema is `openkit-scope-knowledge-schema-v3`. The schema configuration file's own `status: active` and `allowed_statuses` keys retain their separate configuration meaning.

The Scope Schema for the Workspace projection is a YAML file at `knowledge/schema/scope-schema.yaml` with `schema_version`, owner metadata, active status, timestamps, allowed types, field constraints, source-reference shape, proposal rules, review requirements, and lint rules per the governance spec. Previous schema versions and migration reports are preserved under `knowledge/schema/history/`.

Proposals are Markdown files with `type: proposal`, `operation: create | replace`, `owner_scope`, `knowledge_page_id`, `content_digest`, `source_references`, `rationale`, `confidence`, `review_required: true`, authenticated `producer`, and `created_at`. Create has an explicit absent `expected_base`; replace has `expected_base: { revision, content_digest }` plus `base_source_ref` to the exact prior registered page bytes. `proposalId` is `kp_` plus the SHA-256 of canonical JSON `{ ownerScope, requestId }`. Candidate bytes are the complete UTF-8 page file immediately after the proposal frontmatter and closing newline; content digest includes all bytes and the server-computed next revision without normalization. Confidence ranges from 0 to 1 and adds no authority. The candidate must be scope-schema valid, active, accepted on application, and have exactly the proposal's normalized source references. Changed bytes, base or scope require a new proposal. A never-used create id starts at revision 1; a retained removed/forgotten id remains reserved. The completed-Worker provenance projection is true only for the existing strict matching terminal Worker/Item/S39 trio; registered conversation evidence never sets it.

The V1 generated-proposal `sourceReferences` field is one bytewise-sorted, duplicate-free array of strings with this closed grammar:

- `source:<sourceId>@<contentDigest>` names one registered Knowledge Source and its exact captured content digest.
- `knowledge:<knowledgePageId>@<contentDigest>` names one existing directly `user-authored` Knowledge Page and its exact canonical-byte digest; an `accepted` generated Page is not V1 proposal evidence.
- `turn:<turnId>` names one terminal same-Workspace worker Turn.
- `item:<itemId>` names one completed immutable Item owned by a cited Turn.
- `context-package:<turnId>@<contextPackageDigest>` names that Turn's exact accepted S39 trace and package digest.

The `@` separator is forbidden inside ids. A registered `sourceId` is server-generated as `ks_` plus one lowercase canonical UUID and MUST satisfy the same single safe path-segment and symlink-containment checks at registry, material, derived, read, and import boundaries. `contentDigest` is `sha256:` plus 64 lowercase hexadecimal digits, and `contextPackageDigest` uses S39's exact digest format. A generated proposal that claims completed worker output MUST contain one matching terminal direct-Task `turn`, the final completed `assistant-message` Item projected by that Turn, and that Turn's strict live `context-package` reference; citing its `user-message` request Item, another completed Item, or an imported-history trace does not prove new worker output. The three owners must agree on Workspace, Thread, Turn, terminality, and delivery lineage. Bare ids, external URLs, nonterminal work, accepted generated-Page references, current-page substitution, and unsupported reference prefixes fail validation and create no proposal. This closed proposal-evidence vocabulary does not replace Knowledge Page `source_refs`, create a generic record-reference abstraction, or authorize new source records. Evidence outside this V1 set must first be captured through the existing registered Knowledge Source owner.

`knowledge/reviews/<proposalId>.json` is one canonical object `{ proposalId, ownerScope, decisions }`. Decisions are append-only exact rows `{ reviewId, requestId, decision, actor, proposalDigest, knowledgePageId, contentDigest, targetStateAtDecision, decidedAt }`; `reviewId` is `kr_` plus SHA-256 over canonical JSON `{ ownerScope, proposalId, requestId }`. Decision is deferred, accepted or rejected. Accepted `targetStateAtDecision` is `{ kind: absent }` for create or `{ kind: revision, revision, contentDigest }` for replace, resolved from the current safe path and exactly matching the proposal; other decisions use null. Atomically replace this file with its previous exact rows plus one row. Accepted/rejected are terminal, exactly one terminal row is permitted, and changed request input conflicts. No combined edit-and-accept operation exists. Historical pre-v3 rows are retained as immutable evidence and never authorize a new v3 effect.

Observations are JSONL ledger rows per the governance spec, one file per month, excluded from the OKF bundle and from notebook views. Source registry records are JSON files carrying the source identity fields from the governance spec; captured first-slice text material lives under `sources/materials/<sourceId>/content.txt`; derived representations live under `sources/derived/<sourceId>/` with lineage back to the exact source id and content digest.

Proposal application and reversal add no record family. The existing Knowledge Proposal, append-only Knowledge Review, authoritative Knowledge Page, and audit owners preserve fixed page id, bytes, digest, sources, decision, actor, and effect lineage; the command-idempotency owner supplies only request identity, input hash, standard resource identifiers, and replay boundary. No separate application record, revision archive family, rollback record, recovery ledger, or second workflow is authorized. The scoped extension stores its monotonic revision in the existing page and retains base bytes through existing Knowledge Sources.

### Upload intake and source registration

User uploads through product surfaces are work-history records, not sources by default. The bytes land under the originating turn at `threads/<threadId>/turns/<turnId>/inputs/`, and the item log records file id, filename, content digest, size, and sensitivity hint; their lifecycle follows thread history and its retention classes.

An upload becomes a Knowledge Source only through explicit registration, which copies the bytes into the source store and creates one `sources/registry/` record carrying the originating Workspace, Thread, Turn, file id, and content digest. Registration is a copy, not a move: later thread compaction or deletion must not create holes in the evidence layer, and source immutability must not depend on thread records.

Current V1 registration begins only from an explicit authorized user action before proposal drafting. The accepted scoped extension additionally admits trusted Assistant registration of selected conversation snapshots within the user-enabled bounded capture operation. Both paths complete source registration before drafting; proposal review/application never captures sources, and arbitrary uploads are not automatically registered. Capture remains off by default.

The consumption boundary is: knowledge pages, claims, and source summaries MUST cite registered `sourceId`s and MUST NOT reference raw thread attachments; context packages MAY carry unregistered uploads as work-history material for the turn that owns them, and re-using a prior upload as a later work input is a work-history reference by file id and digest that requires no knowledge governance. Content-addressed deduplication of upload and source bytes is a deferred optimization that must not change these record semantics.

### Validation pipeline

A dedicated implementation module owns four stages, in order: OKF parse (frontmatter and body split, YAML parse, reserved-filename structure), profile validation (OpenKit required fields, base types, forbidden secret-like fields, source-reference shape), scope schema validation (allowed types, field constraints, review rules), and conformance computation (`OKF-compatible`, `OpenKit-profile-valid`, `scope-schema-valid`).

Proposal intake applies one bounded pre-persistence text guard to both exact candidate bytes and rationale. V1 rejects the existing raw credential canaries (`sk-`, `hf_`, `ghp_`, and `okt_`) and obvious local-home path forms (`/Users/...`, `/home/...`, `~/...`, Windows drive-absolute paths, and UNC paths) as `400 invalid_request` before any Proposal write, and the public error never echoes the rejected text. This is a proportional defense-in-depth predicate, not general DLP: S18's reviewing agent remains responsible for taking the no-proposal branch for other secret, sensitive, cross-Workspace, or unrestricted-host material rather than probing persistence with it.

All writes to governed records MUST pass through NanoCore's knowledge service; nothing else writes into `knowledge/` or `sources/`. For every create, direct edit, and accepted generated-proposal application, NanoCore MUST run all four stages against the candidate bytes and current schema before it writes, replaces, renames, or removes any authoritative Knowledge Page. A failed validation returns the bounded structured validation result with zero authoritative page, proposal-application, or derived-index mutation.

Imports, rough notes, and Knowledge Manager drafts MAY be saved only through an explicitly addressed draft path with `openkit_status: draft`, standard `status: draft` and `review_state: needs-review`, with the validation report persisted through the existing maintenance owner. An invalid draft MUST NOT replace a valid active page, and post-write index exclusion is not a substitute for save-time enforcement.

Direct title/body edits preserve existing unknown YAML metadata by updating only the managed fields in the current document. The existing service produces one final candidate byte sequence, validates it, and gives those same bytes to the existing persistence boundary; it does not reread and reserialize between validation and write. Import remints `source_refs` through the parsed YAML node, including block sequences. Proposal wrappers consume native YAML boolean, number, object, and string-array values while preserving their fixed canonical page bytes and digest across restart. No public metadata bag or parallel writer is introduced.

Default Workspace Schema v1 data is upgraded by one explicit stopped-server deployment maintenance operation, not the unrelated whole-Workspace layout migration or a permanent runtime migration API. Its reviewed command is retained as execution evidence. Preflight every registry-owned Workspace before any write: the supported predecessor has no Knowledge Markdown files and its schema bytes exactly equal the canonical v1 default with SHA-256 `830a3d0ae6a3c3e9b85933be7cb564903f4d18437a1f421d5b80a23d947e3ee6`. The replacement is the canonical v2 default. Version equality alone is insufficient; custom schemas, Markdown-bearing workspaces, unsafe paths, and unknown bytes fail before mutation.

For each eligible Workspace, exclusively retain the old bytes at `knowledge/schema/history/okf-v0.1-default.yaml`, atomically replace the current schema through a fsynced same-directory file, then exclusively write `knowledge/schema/history/okf-v0.2-migration.json`. That deterministic report contains only `workspaceId`, `oldSha256`, `newSha256`, and `outcome: "completed"`. The initial state is old current bytes with absent history/report. Retry accepts exactly old current plus matching history and no report (continue replacement), new current plus matching history and no report (finish report), or new current plus matching history and the exact report (complete). Old current plus a completed report, conflicting history/report, and every other state fail during the all-Workspace preflight; retries never overwrite history or reports. The operation resumes only those explicit partial writes and does not infer migration completion from a version string.

The normal parser and writer use only the new profile/schema meaning and do not dual-read legacy status fields. A deployment outside this narrow default-schema/no-Markdown state needs a separately explicit migration before upgrade; this operation never rewrites pages, credentials, users, or other Workspace data.

Validation is deterministic and versioned: a validation result records the schema version, profile version, and OKF snapshot identity it was computed against, so conformance can be recomputed and explained after schema migrations.

### Indexes

The portable JSON projection under `indexes/` holds derived, rebuildable index records: a page index (Knowledge Page id, exact content digest, type, `status` projected from authoritative `openkit_status`, scope, review state, sensitivity, freshness, timestamps, conformance level), a full-text term index over titles, descriptions, tags, and body text, a link graph (directed edges from markdown links per snapshot §6.1), a source-reference index, and a validation report index. A full index rebuild from authoritative files MUST be possible with one command and MUST produce identical retrieval behavior; index corruption is repaired by rebuild, never by hand-editing index rows. SQLite FTS5, embeddings, and vector or graph search are optional accelerators behind the same owner and are out of V1 scope.

Persisted indexes are proof-neutral projections, not review authority. Directly `user-authored` active Pages whose file-owned references resolve may enter persisted search, full-text, and link projections. An `accepted` Page remains present in validation and source-reference projections but has `indexed: false` until request-scoped authority is supplied; references whose owner is outside the file bundle, including Turn, Item, and S39 references, remain unresolved in those persisted projections. Retrieval may add an accepted Page to the same candidate set only from an exact current proof bound to its `knowledgePageId`, canonical content digest, and complete bytewise-sorted `source_refs`, then uses the same tokenizer, scorer, ordering, policy, and trace owner as ordinary candidates. Neither proposal grammar, a persisted index, nor an earlier retrieval or S39 trace can create that proof.

For a target-local accepted Page, the proof is projected only from the exact immutable Proposal, terminal accepted Review, unchanged current Page, and every current cited Source, directly `user-authored` Knowledge Page, Turn, Item, and strict S39 owner. A portable imported accepted Page has no imported Proposal or Review; its bounded proof instead requires the current unchanged Page, Workspace `importedFrom` lineage, and every current reminted cited Source, directly `user-authored` Knowledge Page, and imported-history S39 owner. Accepted-to-accepted Knowledge references fail closed rather than creating a transitive authority graph. This is request-scoped computation and creates no per-Page import ledger. Administrator-level mutation inside the trusted data root remains outside the V1 threat boundary; missing or contradictory files fail closed rather than being repaired or inferred.

### Retrieval pipeline

The V1 request is exactly the existing schema `{ query, limit, pinnedConceptIds }`: `query` is a non-empty string, `limit` is 1 through 20 with default 5, and `pinnedConceptIds` is normalized to a bytewise-sorted duplicate-free array. Current authorization and policy context are server-owned inputs, not request fields. There is no separate explicit-page-id field.

The `unicode-simple-v1` tokenizer lowercases the exact query with the runtime's Unicode lowercase mapping, extracts every maximal `Letter` or `Number` sequence with `/[\p{L}\p{N}]+/gu`, deduplicates the resulting terms, and sorts them bytewise. The index uses the same tokenizer. Candidate gathering addresses every pinned id, every directly indexed Page with at least one posting for a query term, and every current proof-backed accepted Page with at least one query term; an unpinned zero-term page is not addressed and leaves no exclusion row. The proof-backed pass is bounded by the supplied proof map and MUST NOT scan all Pages or implement a second ranker. Retrieval performs no semantic search, graph expansion, all-page negative scan, or model call. For each unique query term, a page's term score adds the posting occurrence count plus 2 when that term occurs in the title. Candidates sort by pinned first, then descending term score, then bytewise ascending `knowledgePageId`; a pin does not otherwise change the score.

Before disposition, retrieval rereads every addressed authoritative page and recomputes the fields and digest used by the projection. A missing or unreadable page is `source_unavailable`, whether pinned or reached through a stale posting. Any other disagreement between authoritative bytes and an index row or posting returns `recovery_required` with zero selected result and no retrieval row; the operator may run the existing full rebuild, and no background repair state is created. Each coherent addressed candidate then receives exactly one first-match disposition in this order: a readable restricted sensitivity label is `sensitive_content`; invalid or below `scope-schema-valid` is `lower_conformance`; current authorization or policy denial is `policy_excluded`; unresolved conflict, weak evidence, or non-accepted review state is `lower_conformance`; expired freshness is `freshness_expired`; an eligible candidate beyond `limit` is `budget_exceeded`; every remaining candidate is selected. Denied, restricted, missing, or unreadable candidates expose no content digest. S39 may deliver a smaller subset through its separately owned deterministic package-budget step and records only exclusions caused at that later boundary.

The existing JSONL retrieval row is exactly `{ traceId, workspaceId, caller, requestDigest, retrievalParameters, selected, excluded, createdAt }`. `traceId` is a server-generated `krt_` prefix plus one lowercase canonical UUID and MUST resolve to exactly one row within the Workspace; a duplicate id is rejected before append. `caller` is `assistant`, `task-mode`, or `app-api`; `requestDigest` is `sha256:` over canonical JSON of `{ workspaceId, caller, request }`; and `retrievalParameters` is exactly `{ limit, pinnedConceptIds }` from the normalized request. Each `selected` entry is exactly `{ knowledgePageId, contentDigest, score, sourceReferences }`. Each `excluded` entry is exactly `{ knowledgePageId, contentDigest, reason }`, with `contentDigest=null` for denied, restricted, missing, or unreadable material. Arrays retain the candidate order above. Ranking may use the raw query and matched terms in memory, but neither the query nor its matched terms enter this portable row, audit summaries, or public errors. The exact selected/excluded page identities and digests are sufficient evidence for this bounded selection; no unused index-snapshot digest is persisted. The row has no mutable status or lifecycle.

This pipeline and row are the one governed retrieval owner for product search, Knowledge Manager `answer`, Knowledge Manager `prepare-context-material`, and direct-Task Context Package selection. Callers may project different bounded responses but MUST NOT implement a parallel direct-read, substring-search, candidate-selection, filter, ranker, or trace. Retrieval never mutates knowledge. Its trace proves selection and audit facts only; `prepare-context-material` references that same trace, and only S39 may prove exact worker-Turn materialization and delivery. A future worker capability plane requires a separately accepted design and cannot add another retrieval owner.

### Knowledge operations

Product surfaces reach knowledge through NanoCore-owned operations, not raw file access. The V1 operation families are page read and list; direct page create, update, and bounded delete; proposal draft, review decision, and proposal-created-page reversal; source register and read; observation, claim, and conflict maintenance; deterministic retrieval; schema and index inspection; and explicit report-only health and repair suggestions. Accepted claims may guide an authorized ordinary proposal draft through their already-valid source references, but V1 has no separate claim-promotion proposal producer. Worker-facing `knowledge.*` operations and worker-control proposal-summary ingestion remain disabled and create no current route or test obligation.

Direct page create, update, and delete remain the existing authorized human commands. Create and update MUST use the scope/revision guard, retain any prior full bytes as a registered Source, and run the four-stage validator before mutation and write `review_state: user-authored`, so changed proposal-accepted bytes never preserve their earlier accepted-review label. A direct edit may retain exact digest-qualified registered-Source or directly `user-authored` Page references only after their current bytes verify; a currently `accepted` generated Page never passes merely because an earlier accepted Review exists. References that require external Turn, Item, or S39 verification fail the Store-local edit rather than being inferred, and the user may register the underlying material as a Source or create a separate user-authored Page. Direct delete remains manual Knowledge governance and MUST NOT be projected as the proposal-reversal result below. The scoped extension adds the exact owner/revision/digest guard and scoped request identity to these existing commands. Reuse existing Audit, Source and maintenance owners for change evidence, prior bytes and forgetting suppression; no parallel command, history or event family is introduced.

### Proposal decision, application, and reversal

A generated proposal eligible for application MUST preserve exact scope/page identity, canonical candidate bytes/digest and verified source references. Create fixes an absent target; profile v3 replace fixes the current target revision/digest and a registered prior-byte source under the scoped extension. Current implementation remains create-only; the target contract below and the scoped extension define replacement without implying it is implemented. The proposal response is not lineage authority, and an unpersisted source reference, caller-supplied current page, recomputed replacement, or different byte string cannot substitute for the fixed proposal content.

The existing transport-neutral `knowledge.proposal-decide` operation, whose internal command-ledger name is `knowledge.proposal.decide`, owns both the human decision and any authorized create application. Its request id is the idempotency key, its actor is assigned from current authentication, and its canonical input includes the proposal id, `accepted`, `rejected`, or `deferred` decision, and the proposal's fixed page id, digest, and source references. Rejected and deferred decisions append only their review row. Accepted MUST re-read and verify the pending proposal, exact proposal digest, source references, authorization, safe expected target state, canonical bytes, and digest, run the four-stage validator, and apply S60's exact latest-conflict predicate immediately before appending the accepted review row with the verified `targetStateAtDecision` and before the page write. An existing create target, stale replace base or relevant unresolved conflict returns `409 conflict` with zero Review or Page mutation.

The review and page are separate existing file writes. The exact proposal, accepted human review, fixed page revision and digest, sources, producer, reviewer, and owner scope form the business activation tuple. Success is acknowledged only after that tuple verifies and the existing Audit and command receipt preserve the decision request and command result. The standard command receipt stores only its normal input hash and response resource kind/id; a completed receipt with identical canonical input replays the current owner projection. Changed input returns `409 idempotency_key_conflict`, and a competing or post-terminal decision returns `409 conflict` without mutation.

An accepted review is not proof of application by itself. If its exact row is durable, the exact `targetStateAtDecision` matches the still-absent create target or unchanged replace base, and the same request's proposal, review, actor, source, authorization, validation, bytes, and digest all match, that same command may complete the one missing page write and then persist Audit and receipt. Once the complete business activation tuple exists, the exact page is active even when Audit or receipt completion was interrupted; the command still returns `409 recovery_required` and MUST NOT claim or reconstruct success. A different target or any missing or contradictory business authority also returns `409 recovery_required`. A dependency failure proven before every decision and page effect returns the existing typed redacted failure with zero mutation. No branch creates a rollback, repair, settlement, retry, background, or recovery workflow.

`knowledge.proposal-reverse` is the one bounded reversal command. Its request is exactly `{ requestId, proposalId, reviewId, knowledgePageId, expectedContentDigest }`; the authenticated actor and exact owner scope come from the route, not the body. The named accepted create review and create proposal must own the same page and digest; a replace proposal or a page later replaced is ineligible. The command may remove only that original proposal-created page while its current canonical bytes still match `expectedContentDigest`, then write the existing audit and standard command receipt. A completed receipt names the proposal resource and replays the reversal projection from proposal, review, audit, and page absence; it stores no reversal body or state. Changed input conflicts, changed page bytes return `409 conflict`, and a missing page without the receipt or any contradictory authority returns `409 recovery_required`. The original proposal, review, decision request, command, source, and audit evidence remain durable. Reversal creates no Knowledge revision, event, tombstone, replacement page, new proposal, rollback record, or workflow and never claims to reverse external effects caused by prior use.

The public failure boundary is closed: malformed proposal or candidate input and failed pre-write validation return `400 invalid_request` with bounded structured details; a missing proposal discovered before any effect returns `404 not_found`; a pre-existing create target, stale replace base or changed reversal target returns `409 conflict`; changed input under one request id returns `409 idempotency_key_conflict`; and partial or contradictory review, page, command, or reversal authority returns `409 recovery_required`. Caught exception text, stack traces, local paths, source bytes, credentials, and secret-like values MUST NOT enter public errors.

### Knowledge Manager invocation boundary

`docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` exclusively owns the V1 Knowledge Manager operation and caller contract. This specification owns only the Knowledge Store effects those operations consume: validated reads through the single governed retrieval owner, that owner's selection trace, pending proposal writes through the proposal owner, and report-only repair or health inspection. A preparation response may reference the S61 retrieval trace, but it does not create another trace or materialization owner. This specification does not authorize passive post-event calls, scheduled jobs, hidden hooks, a private Knowledge Manager lifecycle, or a missing Goal integration.

### Migration from the legacy memory projection

The `memory` vocabulary has been renamed directly, with no compatibility aliases, across protocol schemas, item projections, workspace routes, internal-agent mode names, and the workspace directory. Worker-facing Knowledge capability routes are outside the current accepted surface. The governed Knowledge Store migration maps existing minimal knowledge entries to pages with mapped types (`preference` and `project-context` to `KnowledgePage`, `task-summary` to `SourceSummary` or `KnowledgePage` by content), `review_state: user-authored` for user-created entries, and synthesized required fields validated against the initial workspace schema. Existing knowledge proposals migrate to governed knowledge proposals. The migration produces a validation report; entries that cannot be migrated cleanly become invalid drafts flagged for review.

## Contract / Expected Behavior

- The system MUST interpret OKF conformance exclusively against `docs/okf-spec-v0.2-snapshot.md`.
- Every authoritative Knowledge Page create, update, and accepted generated-proposal application MUST pass through the knowledge service and complete the four-stage validation pipeline before any authoritative page write; no other component may write into `knowledge/` or `sources/`.
- Invalid material MUST NOT enter active retrieval or default context package selection.
- Authoritative page files MUST remain the source of truth; every derived knowledge index MUST be rebuildable from them with identical retrieval results.
- One governed retrieval owner MUST serve product search, Knowledge Manager answer and preparation, and direct-Task context selection with deterministic results for identical inputs, index state, and policy state.
- Retrieval traces MUST preserve selected and excluded exact `ownerScope + knowledgePageId + revision + contentDigest` tuples plus reasons as selection and audit evidence, but MUST NOT claim worker delivery; only S39 may prove what exact Knowledge Page bytes reached a worker Turn.
- A generated proposal MUST fix scope, target id and expected absence or exact base revision/digest, canonical candidate bytes/digest, verified sources, producer and accepting human review. Create and replace use the same owners; Audit and idempotency separately prove success/replay.
- Decision and application replay MUST be idempotent under one request id; any unverified partial decision/application returns `recovery_required` without inference, repeated effects, evidence deletion, or a recovery workflow.
- The same authorized accepted command MAY complete its one missing deterministic page write after the review file is durable; no other repair or background completion is allowed.
- Bounded reversal MUST remove only the unchanged proposal-created page and retain the original proposal, review, command, source, and audit evidence.
- Portable Workspace clone/remint export MUST exclude actionable Proposal and Review owners; accepted Knowledge Pages remain portable as ordinary authoritative pages, while complete data-root backup and restore preserve Proposal and Review files only under their unchanged Workspace identity.
- Knowledge pages MUST NOT contain secret values; the profile validator MUST reject secret-like fields per the vault boundary.
- Implicit cross-Workspace factual access MUST NOT occur through retrieval, indexes, traces or context packages. Explicit current-user Memory plus selected-Workspace retrieval is the audience-bounded exception defined by the scoped learning owner; it is not unrestricted union of Workspace notebooks.
- Concept renames and moves are not V1 mutation operations; no page-event or generalized identity-history family is authorized.
- Migration MUST be one-way and complete: after migration, no retired Workspace `memory`-named route, schema, directory or capability remains; intentional User Memory is a scoped projection.

## Current Implementation Projection

The removed `@openkit/mcp` facade must not be restored through compatibility or replacement work. The current Knowledge interface is the transport-neutral operation catalog exposed through the unified `openkit` Skill and its bundled CLI.

- `packages/protocol` exposes minimal `KnowledgeEntry` schemas, workspace knowledge request/response schemas, and `knowledge-injection` item projections.
- `apps/nanocore/src/app.ts` exposes `/api/workspaces/:workspaceId/knowledge` routes and the governed proposal decision and reversal operations. Decisions are accept, reject, or defer; changing candidate bytes requires a new proposal. Acceptance applies the frozen target page id, bytes, digest, and source lineage, and the bounded two-file completion rule returns success only after both the decision and exact page are durable. NanoCore exposes no `/api/worker-capabilities/knowledge/*` routes.
- `apps/nanocore/src/app.ts` also exposes explicit Knowledge Source identity registration and read surfaces through `/api/app/workspaces/:workspaceId/knowledge/sources` and `/api/app/workspaces/:workspaceId/knowledge/sources/:sourceId`. Registration computes a `sha256:` digest, stores the product-safe source identity record, and copies submitted first-slice text material into `sources/materials/<sourceId>/content.txt`; the API response never returns the submitted content.
- `apps/nanocore/src/storage/fs-layout.ts` creates `knowledge/` and `sources/`.
- `apps/nanocore/src/lib/store.ts` projects current app-local `KnowledgeEntry` records into minimal OKF Markdown pages under `knowledge/pages/<knowledgeEntryId>.md`, writes the default workspace schema at `knowledge/schema/workspace-schema.yaml`, uses the `KnowledgePage` base type, keeps the app-local kind in the `openkit_entry_kind` extension, and validates authoritative page bytes before mutation. The store also projects current app-local `KnowledgeProposalRecord` summaries under `knowledge/proposals/<proposalId>.md`, records app-local knowledge proposal review decisions under `knowledge/reviews/<proposalId>.json`, stores first-slice source identity records under `sources/registry/<sourceId>.json`, stores registered text material under `sources/materials/<sourceId>/content.txt`, and writes first-slice text derived representation metadata under `sources/derived/<sourceId>/text.json` with lineage back to the source content digest.
- `@openkit/app-api-schemas`, `@openkit/core-client`, and NanoCore OpenAPI expose the same Knowledge Source registration, list, and read surface through `client.app.registerKnowledgeSource`, `client.app.listKnowledgeSources`, and `client.app.readKnowledgeSource`; the unified `openkit` Skill projects those contracts through the `knowledge.source-register`, `knowledge.source-list`, and `knowledge.source-read` bundled-CLI operations. Register and read responses include derived representation metadata without returning captured source content.
- `apps/nanocore/src/knowledge/okf.ts` owns the first-slice OKF document parser, OpenKit Knowledge Profile validator, default workspace schema parser, workspace schema validator, conformance report metadata, secret-like field rejection, and active-page predicate. `apps/nanocore/src/storage/index-rebuild.ts` now uses that module when reading file-backed pages, skips OKF reserved files, reads the workspace schema file when present, reads registered source ids from `sources/registry/`, reads file-backed knowledge ids, validates external source references as HTTP(S) URLs, and keeps pages out of the derived search index unless they are active `Workspace-schema-valid` records whose local `source:<sourceId>` and `knowledge:<knowledgeEntryId>` references resolve and whose external references pass the syntax gate. The same rebuild pass writes `indexes/knowledge-links.json`, a first-slice directed Markdown concept-link graph for active valid pages with broken local links recorded as unresolved edges and external URLs excluded from the concept graph, `indexes/knowledge-validation.json`, a first-slice per-page validation report that records conformance, active/indexed state, profile/schema errors, and local or external reference errors, `indexes/knowledge-source-refs.json`, a first-slice source-reference index that classifies page references as registered sources, workspace knowledge references, or external references with local resolution or external syntax status, and `indexes/knowledge-fts.json`, a first-slice rebuildable full-text term index for active valid knowledge page titles and bodies. NanoCore exposes those derived knowledge indexes through `GET /api/app/workspaces/:workspaceId/knowledge/indexes`; `@openkit/core-client` exposes `client.app.readKnowledgeIndexes`, and the unified `openkit` Skill projects it as `knowledge.indexes` through the bundled CLI. NanoCore also exposes deterministic first-slice retrieval through `POST /api/app/workspaces/:workspaceId/knowledge/retrievals`, which ranks active valid pages from `knowledge-fts.json`, supports bounded selection plus pinned concepts, returns selected and excluded candidates with reasons, and appends the same trace to `knowledge/traces/<YYYYMM>.jsonl`; `@openkit/core-client` exposes `client.app.retrieveKnowledge`, and the bundled CLI projects it as `knowledge.retrieve`.
- Knowledge Manager `answer` and context preparation delegate to the governed retrieval implementation above. Task Mode supplies exact accepted-page authority proofs to that same request-scoped candidate set, which then uses the same tokenizer, scorer, ordering, policy, and trace owner as ordinary user-authored candidates.
- `apps/nanocore/src/lib/store.ts` appends first-slice observation records to monthly workspace JSONL ledgers under `knowledge/observations/<YYYYMM>.jsonl` and reads them back as maintenance records. NanoCore exposes append/list routes through `/api/app/workspaces/:workspaceId/knowledge/observations`; `@openkit/core-client` exposes `client.app.recordKnowledgeObservation` and `client.app.listKnowledgeObservations`, and the bundled CLI projects them as `knowledge.observation-record` and `knowledge.observation-list`.
- `apps/nanocore/src/lib/store.ts` appends first-slice claim records to monthly workspace JSONL ledgers under `knowledge/claims/<YYYYMM>.jsonl` and reads them back as maintenance records. NanoCore exposes append/list routes through `/api/app/workspaces/:workspaceId/knowledge/claims`; `@openkit/core-client` exposes `client.app.recordKnowledgeClaim` and `client.app.listKnowledgeClaims`, and the bundled CLI projects them as `knowledge.claim-record` and `knowledge.claim-list`. Claims remain maintenance evidence; the former `knowledge.claim-promote` and worker-control `knowledge_proposal_summary` proposal producers are deleted without aliases, and an accepted Claim may guide only an ordinary authorized `knowledge.proposal-draft` request through valid source references.
- `apps/nanocore/src/lib/store.ts` appends first-slice conflict records and conflict resolution updates to monthly workspace JSONL ledgers under `knowledge/conflicts/<YYYYMM>.jsonl`, keeps append history, and reads back the latest row per conflict id as the maintenance record. NanoCore exposes append/list/resolve routes through `/api/app/workspaces/:workspaceId/knowledge/conflicts` and `/api/app/workspaces/:workspaceId/knowledge/conflicts/:conflictId/resolution`; `@openkit/core-client` exposes `client.app.recordKnowledgeConflict`, `client.app.listKnowledgeConflicts`, and `client.app.resolveKnowledgeConflict`, and the bundled CLI projects them as `knowledge.conflict-record`, `knowledge.conflict-list`, and `knowledge.conflict-resolve`.
- `POST /api/app/workspaces/:workspaceId/knowledge/manager/context` returns the existing governed retrieval trace reference and exposes no standalone Knowledge trace readback or worker-context materialization endpoint through Core Client or the unified Skill. Only S39 owns worker-Turn materialization and delivery.
- The current Knowledge Manager implementation consists of direct deterministic operations exposed through governed App API routes for answer, context preparation, proposal draft, repair suggestion, and health inspection; it is not a generic internal-agent mode, Quick Chat tool allowlist, separate Core tool executor, or context-delivery owner.
- The current implementation satisfies the accepted V1 validation, proposal, review, page, audit, command-idempotency, and S39 delivery contracts through their existing owners. The one retrieval path does not yet read latest conflict-ledger authority and therefore cannot surface or exclude relevant unresolved conflicts as S60 requires; this keeps the specification Partial alongside the unimplemented scoped ownership, revision, replacement and bounded learning extension. Current implementation adds no revision or event family, recovery workflow, application record, second retrieval path, or second context-delivery owner. YAML comment/format-preserving round-tripping, binary source handling, derived representations beyond text metadata, external reference resolution beyond HTTP(S) syntax validation, SQLite FTS5 acceleration, structured patch proposals and worker-facing Knowledge capabilities remain deferred; exact single-page replacement is accepted design but not implemented.

## Alternatives Considered

- Track live OKF upstream instead of pinning: rejected; upstream is a draft that can change conformance semantics under us, which is exactly the drift this spec exists to prevent.
- SQLite as source of truth with file export: rejected; contradicts the file-system-first storage principle and makes user inspection, git-friendly backup, and external editing second-class.
- Vector-first retrieval in v1: rejected; the v1 knowledge posture is retrieval and governance first, deterministic ranking is explainable and testable, and embeddings can be added later behind the same interface without contract changes.
- Compatibility aliases from `memory.*` to `knowledge.*`: rejected under the internal development rule; a direct rename with one migration is cheaper than maintaining dual vocabularies.

## Consequences

- OpenKit gains a fixed, testable definition of OKF compatibility and a conformance suite target.
- Knowledge remains portable: a workspace notebook is a valid OKF bundle that other tools can consume.
- One governed deterministic retrieval owner makes product, Knowledge Manager, and context selection reproducible and auditable, at the cost of lower recall than semantic search; that cost is accepted for V1.
- Create/replace application and unchanged-create reversal remain source-linked and fail closed, with revision inside the existing page and prior bytes inside existing Sources, without a revision archive, event, application or recovery record family.
- Retired Workspace Memory aliases remain absent; User Memory is a deliberate product scope of the same implementation, not compatibility debt.

## Testing Strategy / Acceptance Criteria

- L1 covers OKF/profile/schema validation, safe page paths, canonical bytes and digests, pre-write save enforcement, deterministic retrieval and trace rows, fixed proposal evidence, review decisions, application, and reversal.
- L2 covers pinned OKF conformance, rebuild equivalence, and identical S61 results across product search, Knowledge Manager reads, and direct-Task selection.
- One existing NanoCore black-box flow covers proposal draft, accept, exact page publication, receipt replay, and bounded reversal; one representative interruption test covers the accepted-review/missing-page exception and contradictory `recovery_required` result.
- S18 owns the single real L6 composition and S39 owns worker-delivery tests; this implementation spec does not duplicate them.

Acceptance: all authoritative page writes pass validation before mutation; one governed retrieval owner serves every knowledge-reading surface; a rebuilt index reproduces candidate results byte-for-byte; every applied generated proposal is create or exact-base replace and fixes scope, page id/revision, bytes/digest, sources, review, actor and command lineage; success requires both separate review and page writes; same-command completion is limited to its missing deterministic page effect; every other unverified partial state returns `recovery_required` without a workflow; reversal removes only the unchanged proposal-created page and retains evidence; retrieval evidence never counts as S39 delivery proof; and no retired Workspace `memory` alias remains; intentional User Memory follows the scoped extension.

## Risks & Mitigations

- Risk: the pinned OKF draft diverges far from ecosystem adoption. Mitigation: the snapshot pattern makes re-pinning a small deliberate change; conformance logic is isolated in one module.
- Risk: deterministic retrieval misses relevant material. Mitigation: pins, explicit references, and agent hints give users and coordinators direct control; recall gaps become observations feeding v2.
- Risk: validation strictness frustrates rough-note capture. Mitigation: invalid drafts preserve material without blocking users; only active retrieval is gated.
- Risk: FTS quality varies across languages. Mitigation: tokenizer choice is isolated behind the index layer; see Resolved Decisions.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: mixed-language and CJK search uses the portable JSON term index for deterministic first-release retrieval, while SQLite FTS5 trigram indexing remains a deferred accelerator behind the same retrieval owner; first-slice ingest ships explicit text material registration and deterministic projection for governed pages, while richer plain-text, Markdown, code, transcript, PDF, and media extraction arrives through capability-mediated worker or Knowledge Manager proposal tasks; generated proposals apply as exact create or single-page replace under the scoped learning contract, while multi-page merge, split, patch, archive and generated delete application remain deferred.

## Deferred / Future Work

- Vector and graph retrieval accelerators behind the retrieval interface.
- SQLite FTS5 trigram indexing behind the retrieval interface when retrieval volume or CJK quality justifies the extra storage and indexing dependency.
- YAML comment/format-preserving round-tripping and external notebook editor writeback.
- Binary source capture, conversion, and derived representation pipelines beyond V1 text material registration.
- Unattended and multi-page synthesis beyond the accepted bounded preference extraction and single-page consolidation contract.
- Cross-workspace explicit knowledge sharing.
- OKF re-pinning process automation and upstream change monitoring.

## Links

- `docs/okf-spec-v0.2-snapshot.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/core/knowledge.md`
