---
status: Draft
implementation: Not Started
kind: mechanism
date: "2026-10-14"
---
# OpenKit Retrieval Kernel

This specification defines one domain-free mechanism for indexing and searching caller-admitted documents. It owns lexical retrieval, bounded text extraction, index publication, result completeness, and the shared Rust execution boundary.

## Owns

- The Document, source key, scope, chunk, provenance, index generation, query, and result contracts.
- Scope filtering before ranking or scanning, without authorization inside the kernel.
- The rebuildable lexical index and its identity, lifecycle, recovery, and failure semantics.
- One implementation shared by NanoCore, the directory command-line interface (CLI), and a Model Context Protocol (MCP) tool.
- Phase 1 acceptance predicates and the boundary of later phases.

## Does Not Own

The kernel does not own canonical content, source retention, upload admission, Knowledge publication, Thread visibility, authorization, destination disclosure, or Worker materialization. It does not create a source registry, permission store, retrieval trace store, scheduler, or retry queue.

The kernel does not decide whether a retrieved claim is true. It does not publish Knowledge, deliver a Context Package, or prove Worker receipt.

## Core References

- [Storage](../core/storage.md)
- [Knowledge](../core/knowledge.md)
- [Permissions](../core/permissions.md)

## Summary

Before v0.1.0, users need one retrieval tool over Knowledge, Workspace data, Artifacts and uploads, and past conversations. One upload is at most 1 GB (1,000,000,000 bytes). Accepting a file type does not promise text extraction from that type.

On 2026-10-14, the engineer accepted a domain-free Retrieval Kernel patterned after the Policy Kernel. The engineer also accepted the simplest lexical implementation first. Multimodal vectors follow lexical retrieval; optical character recognition (OCR) comes last.

This Draft specifies that accepted direction for review. It does not supersede the existing owners. The amendments listed below must be accepted before the corresponding implementation changes.

## Goals / Non-goals

Phase 1 provides Best Matching 25 (BM25) ranked search, literal exact search, regular-expression search, Chinese and Japanese segmentation, and bounded extraction. All four source families use the same kernel. The redesigned Chat Mode Assistant can search eligible past conversation Items.

Phase 1 excludes embeddings, model calls, OCR, linked Git acquisition, cloud-source synchronization, fuzzy search, query-language operators, and semantic reranking. It adds no interchangeable backend or separate product search engine.

## Decision

One Rust codebase uses Tantivy for lexical indexing. Its library and executable share the same extraction, indexing, filtering, and query implementation. Thin source and transport adapters translate inputs and outputs; they do not implement another search algorithm.

Tantivy serves the accepted CPU-only lexical phase and supplies committed index generations. Exact and regex queries use a text scan because indexed terms cannot prove arbitrary text matches. The initial implementation uses the ripgrep grep crates for that scan.

These choices can be replaced only through an accepted amendment that preserves this contract. Phase 1 has no engine selector.

## Definition And Exclusions

### Document, Source Key, And Scope

A Document is one revision of a caller-supplied source unit. It contains a source key, scope, source revision, content digest, title, media type, optional language hint, and a bounded readable content stream. An adapter may supply text directly or provide a seekable file handle for extraction. The kernel does not accept an unrestricted host path from a product query.

A source key is the opaque pair of adapter namespace and source-local identity. It is unique within one index. The adapter preserves it across updates. Two adapters that expose the same bytes retain distinct source keys and provenance.

A scope is an opaque exact identifier for documents with the same read eligibility. It is not a policy expression or a grant. Each Document has one scope. The adapter must use a narrower scope when a broad Workspace or notebook scope cannot express source restrictions. No durable scope registry is required.

The caller supplies the exact readable scope set for each query. The kernel performs no identity, membership, visibility, sensitivity, publication, or permission evaluation. An empty set returns no results and reads no source content. A missing set or an unknown required input is an invalid request, never a request to search everything.

### Chunks And Provenance

A chunk is a bounded contiguous range of extracted text from one Document revision. The kernel assigns a stable ordinal and text offsets. It prefers paragraph or line boundaries and splits oversized units without splitting a UTF-8 code point. Phase 1 uses no overlapping chunks.

Each chunk retains the source key, scope, revision, original content digest, extraction profile, extracted-text offsets, and an original locator. Locators identify an Item, byte range, PDF page, worksheet and cell, slide, or ZIP entry as applicable. Extracted offsets must not be represented as original-file offsets when the extractor cannot establish that mapping.

Chunk boundaries affect BM25 units, not literal or regex scan boundaries. A scanner must find a supported match across a chunk boundary. It must not join separate Items, pages, sheets, slides, or archive entries into a false match.

### Index Generation

An index generation is one committed snapshot of Document revisions, extraction outcomes, extracted text, and lexical postings. A query pins one generation. It cannot combine postings from one generation with text or status from another.

The generation includes a derived source inventory so the kernel can report unsearchable documents. This inventory is not a second source registry. The adapter's canonical inventory remains authoritative.

### Query Modes

Every query supplies a nonempty query string, one mode, the readable scopes, and a positive bounded result limit. Unknown modes, invalid regex syntax, and inputs above query limits fail before content access. Phase 1 provides three modes:

| Mode | Contract |
| --- | --- |
| `lexical` | Tokenize ordinary query text and rank matching chunks with BM25. Match any query term. Return one hit per Document, using its highest-scoring chunk. Prefer title matches and break equal scores by source key, then chunk ordinal. No Boolean, phrase, fuzzy, or regex parser operates on this query. |
| `exact` | Find literal, case-sensitive substrings in the searchable text representation. Preserve Unicode code points, whitespace, and line endings; apply no case folding or Unicode normalization. A literal can span lines within one extraction unit. |
| `regex` | Apply the Rust regex dialect through the grep matcher to each line of the searchable representation. Lines exclude the terminating line-feed (LF) byte; a preceding carriage-return (CR) byte remains content. Anchors refer to that line. Backreferences, lookaround, and explicit LF literals are unsupported and fail explicitly. Character classes operate within a line and cannot match across lines. |

Exact and regex results identify each returned occurrence and its text range. Their deterministic order is source key, extraction unit, then match offset. They never use BM25 top results as the only scan candidates. Zero-length regex matches are rejected in phase 1 to prevent unbounded empty occurrences.

The Knowledge adapter may also supply pinned source keys, because the current Knowledge contract requires pins. The kernel addresses readable pins before unpinned lexical hits. Pins do not bypass scopes, revision validation, or extraction status. Other adapters need no pin option.

### Results And Completeness

A result contains the generation identity, mode, ordered hits, bounded snippets, source provenance, and coverage. Lexical hits include their score. Each face preserves the same semantics.

Coverage reports the admitted inventory, searched units, unsearchable or partly extracted documents, stale revisions, and any stopped scan. Per-document statuses use the closed set `text-extracted`, `partial`, `no-text-layer`, `unsupported`, `encrypted`, `failed`, and `resource-limited`. Unknown required status values fail closed; unknown additive metadata may be ignored.

The result distinguishes three questions: whether the admitted corpus was searched, whether extraction covered the selected profile, and whether the response omitted matches. `complete` is true only when all three are complete. For lexical mode, match completeness means the requested top results, not every matching Document.

Limits, cancellation, output truncation, unsupported documents, and extraction omissions must prevent an unqualified complete result. A bounded response may aggregate excess diagnostics by reason with an explicit omitted count. It cannot hide that omission or include inaccessible identities, titles, paths, counts, or extraction errors.

Exactness refers to searchable text, not arbitrary binary bytes or visual layout. Results state the representation and extraction exclusions. A complete PDF text-layer search does not claim to search text shown only in images.

## Kernel And Adapter Boundary

### Preconditions, Postconditions, And Invariants

Before a product query, NanoCore and the source adapters construct readable scopes through the Policy Kernel using current canonical facts. They also apply each source owner's non-authorization eligibility rules. Model-supplied scope identifiers cannot widen the resulting set.

The adapter reconciles the current admitted inventory with the generation inventory before asserting freshness. Every supplied scope must describe eligible documents in that generation. If a stored scope groups newly ineligible content with eligible content, exclude that scope until an update separates or removes the ineligible content. Report affected discoverable coverage as incomplete. A final hit check cannot substitute for this pre-ranking boundary.

For Assistant use, NanoCore resolves both the source read scope and the destination audience under [Permissions](../core/permissions.md#assistant-disclosure-authorization). It excludes sources that cannot reach that audience before the query supplies model context. Every concrete read and later publication retain their current permission checks.

The kernel intersects the pinned generation with the supplied scopes before opening scan text, computing document scores, collecting top results, or producing snippets. Unauthorized documents cannot become speculative scan candidates. The implementation must establish this ordering; a post-filter over ranked hits is insufficient. Ranking statistics must describe the admitted corpus so hidden documents cannot alter visible scores or ordering.

The adapter verifies current eligibility and the exact source revision before returning a hit to a product caller. A revoked or deleted source is withheld immediately, even when its postings remain. Missing authorization facts fail the affected request closed. Index cleanup is not the confidentiality barrier.

The kernel returns only source-linked retrieval facts. The adapter owns product citations, redaction, governed selection evidence, and any subsequent read or disclosure. The kernel cannot infer permission from an index row, prior result, file presence, or process restart.

### Source Adapter Registry

Each adapter must answer the same questions: canonical inventory and revision, stable source key, current readable scopes, eligible content, original locator, update/removal trigger, and response validation. The following table names the owners; it does not replace their semantics.

| Source adapter | Owned answers at the edge |
| --- | --- |
| Knowledge | [Knowledge Store Implementation](20260703-knowledge_store_implementation.md) supplies published page bytes and exact notebook commit/digest. [Knowledge Governance](20260702-knowledge_store_governance_rules.md) supplies publication, state, conformance, source, freshness, conflict, suppression, and audience rules. User, Workspace, and Server ownership stay distinct. Existing selection traces and pins remain with this adapter; a kernel result never proves Worker delivery. |
| Workspace data | [Work Resource Interaction](20260713-work_resource_interaction_model.md) supplies admitted Material revisions and other owner-exposed text/file units. [Workspace Data Source Catalog](20260704-workspace_data_source_catalog.md) supplies source identity where applicable. Registration alone does not authorize acquisition. Phase 1 indexes locally available admitted data, not every host or Sandbox directory. |
| Artifacts and uploads | [Work Resource Interaction](20260713-work_resource_interaction_model.md) supplies exact Artifact versions and provenance. [Knowledge Store Implementation](20260703-knowledge_store_implementation.md#upload-intake-and-source-registration) supplies attachment identity where applicable. [Thread Visibility](20260909-thread_visibility_and_sharing.md) supplies immutable-origin audience checks. An upload remains work history unless explicitly registered as a Knowledge Source. |
| Conversation history | [Thread Visibility](20260909-thread_visibility_and_sharing.md) supplies the parent audience. Canonical Item owners supply retained user-visible message text, Item identity, sequence, and revision/digest. The adapter excludes hidden reasoning, credentials, raw provider payloads, and unadmitted diagnostics. It indexes Items independently and links hits to their Workspace, Thread, Turn, and Item. |

The conversation adapter exposes eligible history beyond the Assistant's current context window. It does not depend on provider memory, summarize history into Knowledge, or authorize private-to-shared transfer.

Linked Git repositories are a later adapter increment. They must use the accepted source and Workspace-view owners; the kernel will not clone repositories or become a NanoCore host-checkout reader.

## Phase 1 Text Extraction

Phase 1 supports the following extraction profiles. All other file types remain retainable through their source owner and receive an honest search status.

| Input | Searchable representation and exclusions |
| --- | --- |
| UTF-8 text | Stream exact text, including Markdown, source code, JSON, and transcripts. Do not execute or parse code. HTML is searchable as source text, not rendered text. Invalid UTF-8 fails without replacement characters; non-UTF-8 encodings wait for a later increment. |
| PDF | Extract the text layer page by page with PDFium. Preserve page identity. Image-only pages report `no-text-layer`; mixed coverage reports `partial`. No OCR or page rendering is required in phase 1. Reading order and font mappings are extractor output, not visual fidelity guarantees. |
| DOCX | Read the main document's current paragraph and table text in document order through bounded ZIP and XML reads. Include insertions and exclude deleted revision text, comments, embedded objects, and external relationships. Headers, footers, and footnotes wait for a later increment; report their omitted text parts when present. |
| XLSX | Read worksheets in workbook order with calamine's incremental cell reader where available. Preserve sheet and cell coordinates. Include stored values and formula text as distinct representations; never evaluate formulas, macros, or external links. Bound shared strings and sparse dimensions. Images and drawings are excluded. |
| PPTX | Read slide text and table text in presentation order through bounded ZIP and XML reads. Preserve slide identity. Notes, chart internals, diagrams, and embedded objects wait for a later increment; report omitted text parts when present. |
| ZIP | Visit safe regular entries in stable name order and apply the supported profiles. Preserve archive and entry identity. Do not expand nested generic archives or follow links. DOCX, XLSX, and PPTX inside a ZIP may use their own bounded package reader. Unsupported entries and skipped nested archives make coverage incomplete. |

The extractor detects content type without trusting a filename alone. Encrypted documents require no credential prompt or password storage; they report `encrypted`. A supported format without any text reports `no-text-layer`. If known text-bearing parts are omitted, the document reports `partial` and names the profile exclusions.

The executable runs untrusted extraction in its own subprocess mode. The caller supplies only admitted input handles and bounded output channels. The parent bounds memory, CPU/wall time, output, temporary disk, archive entry count, expanded bytes, nesting, compression ratio, XML depth, and spreadsheet dimensions. Limits are implementation defaults with the protected resource named; the 1 GB upload ceiling is not an allocation or decompression budget.

The subprocess cannot execute document code, resolve external relationships, fetch URLs, or obtain credentials. It receives no ambient product store or secret access. The supervisor confines it to its input, packaged dependencies, and bounded scratch space. Archive paths cannot escape the input boundary. Reject unsafe absolute paths, parent traversal, duplicate entry identities, and symlink entries before content access. A parser panic, native fault, timeout, or memory failure terminates that subprocess and yields a per-document outcome; it must not crash NanoCore.

Upload intake may spool bytes once through its canonical owner. Extraction uses bounded buffers and seekable reads, not a whole-upload byte array. Extracted text flows into bounded chunks and derived scan text. A large ordinary text file can be processed incrementally; a large hostile or compressed file may correctly be resource-limited.

Phase 1 excludes legacy Office binaries, ODS, media transcription, rendered HTML, nested archive expansion, and additional encodings. These are later lexical increments, not new query modes or backend options.

## Durable Authority And Projection Boundary

Canonical records and authored configuration remain in their existing owners. The index, extracted scan text, chunks, statuses, and source inventory are derived data. They can be discarded and rebuilt without changing canonical records. They carry no index migration or permanent legacy-reader obligation.

The index identity includes schema, scoring/chunking rules, tokenizer code and configuration, normalization, dictionary digests, extraction profiles, and extractor versions. A generation also binds its source keys, revisions, and content digests. Both identities are needed: compatible machinery does not prove fresh content.

A machinery mismatch makes a generation unusable and requires a rebuild. The kernel must not mix incompatible tokenizers or extractors, read old projections permanently, or dual-write old and new indexes. Canonical notebook history, Items, Artifacts, uploads, and required evidence retain their owners' data-continuity obligations.

Derived content retains source confidentiality at rest. Product reads use scoped adapters, not raw index files or a public query socket. Index backups and diagnostics cannot widen source audiences. No new canonical retrieval database is introduced.

## Lifecycle And Recovery

1. **Index:** The adapter enumerates an exact admitted source inventory and supplies verified revisions. The kernel extracts documents, records outcomes, and builds an unpublished generation.
2. **Update by key:** Replace all chunks, scan text, metadata, and status for one source key in the next generation. Repeating identical Document metadata and revision/digest is a no-op. A scope change replaces the old scope association even when the content is unchanged.
3. **Remove by key:** Remove that key and all its derived content from the next generation. Removing an absent key is a no-op. This operation does not delete the canonical source.
4. **Rebuild:** Re-enumerate canonical sources and construct a complete replacement projection. Rebuild may record unsupported or resource-limited documents, but it cannot omit those outcomes and claim full coverage.
5. **Publish:** Commit postings, inventory, scan text, statuses, and identity as one discoverable generation. Acknowledge publication only after its commit is durable. Queries see the previous complete generation or the new complete generation, never staged members.
6. **Recover:** After a crash, open the last valid committed generation. Ignore incomplete staging. If no compatible committed generation exists, report index unavailable and rebuild from canonical sources.

One writer owns an index at a time. A conflicting writer fails before mutation. Updates use an expected generation and the adapter's fixed source revisions. A changed generation or contradictory digest for the same source revision returns `conflict`; the caller must re-enumerate current truth before retry.

The kernel owns no automatic background watcher or retry lifecycle. NanoCore calls it from existing source operations and explicit rebuild/startup paths. A failed or uncertain publication is inspected against the committed generation, then retried by current source key/revision. Recovery never invents a source revision or replays a canonical write.

Queries pin their generation until completion. Cancellation releases their reader and temporary resources. Old generations may be removed only after their readers release them; cleanup touches derived bytes only. This lifecycle terminates with removal or index disposal and creates no retained-data deletion authority.

## Conflict, Missing, Stale, Restart, And Dependency Failure

| Condition | Required behavior |
| --- | --- |
| Stale source inventory | Report stale coverage. The adapter withholds changed or deleted hits until their current revision is indexed. Current source checks prevent old authorized bytes from surviving revocation. A stale empty result cannot prove absence in current history. |
| Missing canonical bytes | Return a bounded source-unavailable outcome for an otherwise discoverable source. Do not substitute another revision or create an empty canonical source. |
| Index identity mismatch or corruption | Refuse that generation and request rebuild. If a compatible valid committed generation remains, it may serve with truthful freshness; incompatible fallback is forbidden. |
| Partial or unsupported extraction | Search available admitted text, return its provenance, and report coverage as incomplete. Do not label the document fully searchable. |
| Query scan limit or cancellation | Return available hits only with explicit incomplete coverage and the stopping reason. A retry is a new query against current scopes and generation; phase 1 has no durable search cursor. |
| Extractor or dictionary missing | Fail the dependent operation explicitly. A missing required tokenizer cannot silently select another tokenizer. Other healthy documents may remain queryable in a compatible committed generation. |
| Extraction subprocess failure | Report `failed` or `resource-limited` as observed. Preserve canonical input and isolate the failure to that document. |
| Disk exhaustion or publication failure | Preserve the last committed generation and canonical bytes. Refuse further growth; do not purge retained sources or acknowledge an incomplete generation. |
| Authorization or audience dependency failure | NanoCore fails closed before supplying content or returning product hits. It does not turn an indeterminate permission result into partial authorization. |
| Restart | Reconstruct current scopes from their owners and open the last valid commit. Prior results, cached scopes, and derived status never restore access. |

Full exact-search completeness requires the adapter's complete admitted inventory at fixed revisions and successful extraction/scan of every selected unit. The CLI also detects files changed during reads and reports incomplete coverage. Without a filesystem snapshot, it cannot claim a point-in-time snapshot of a concurrently changing directory.

## Three Faces And Packaging

NanoCore uses the Rust library when it can link it safely. Otherwise, it supervises the same executable as a local service with the same contract. This is an integration choice, not a user-selectable backend. The service accepts only trusted local adapter requests; it has no network listener or independent permission database.

The executable provides a directory CLI that defaults to the current directory and accepts one named directory. The directory adapter binds its index to that root, derives source keys from root-relative paths, and computes digests incrementally. It visits regular files under the selected root, includes dotfiles, and skips its own derived index. It does not apply implicit Git ignore rules or follow symlinks. Unreadable files and concurrent changes appear in coverage. Directory selection and operating-system access bound this local tool; they do not grant product access.

The executable also provides one MCP search tool over an already admitted adapter view. The tool accepts the same modes, query, and limit and returns the same result semantics. Product scope construction stays in NanoCore. A local directory MCP launch binds its root at startup; a model cannot widen it by passing another path. MCP uses standard input/output and adds no remote server, authentication store, or write tool. Index preparation and explicit rebuild use the same executable operations outside the search tool.

Package the executable, tokenizer dictionaries, extractor subprocess mode, and native PDFium dependency for amd64 and arm64. Linux application distributions must contain target-matched artifacts for both architectures. NanoCore source support on Linux and macOS also requires compatible retrieval supply for both architectures; source-build support does not imply qualified macOS Sandbox support.

Runtime packages must not download dictionaries or native libraries on first query. Package their identity and license notices. Qualify each supported platform's subprocess resource enforcement and library compatibility. Missing mandatory packaged content fails explicitly. The combined deployment resource recommendation is not a retrieval-only budget or mandatory minimum.

## Current Implementation Projection

Not implemented. The current Knowledge JSON index and `unicode-simple-v1` remain implementation facts until the coordinated owner amendment and cutover.

The initial dependency baseline from the research is Tantivy 0.26.2, tantivy-jieba, and lindera-tantivy with the runtime-packaged IPADIC Japanese dictionary. Chinese uses Jieba search segmentation; Japanese uses Lindera. Index and query tokenization use the same settings. When no reliable language hint exists, both fields participate with a language-independent n-gram fallback field. Gram matches are candidates, not proof of an exact substring; exact mode verifies text. Latin normalization is shared across query and index.

The extraction baseline is PDFium, bounded `zip` plus `quick-xml` readers for Office Open XML (OOXML) packages, and calamine for XLSX. The scan baseline is `grep-searcher` plus `grep-regex`. These are proposed dependency choices, not qualified build or resource claims. Compatible versions belong to the implementation lockfile; version changes affect index identity where their output can change.

## Rollout / Migration Plan

Accept this specification and the affected owner amendments before production changes. Replace the lexical Knowledge JSON index and tokenizer directly with the kernel projection. Preserve canonical notebook and source records and required selection evidence. Unrelated link, validation, and source-reference projections keep their owners.

Build a new generation from canonical records, verify its identity and acceptance predicates, and then switch all affected retrieval consumers together. Remove the replaced lexical path. No compatibility shim, dual write, or second Knowledge ranker remains. Arbitrary-file upload intake and the Workspace view retain their separate owner work; extraction does not authorize those contracts.

## Testing Strategy / Acceptance Criteria

Use the existing test strategy and test execution owners. These predicates prescribe observations, not a new runner or assurance framework. All five DOC-017 classes apply to this mechanism; none is omitted as not applicable.

1. **Chinese and Japanese regression:** Index `我们完成了测试，并修复了缺陷。` and a Japanese sentence such as `検索機能を改善しました。`. Lexical queries `测试`, `修复`, and `検索` find their containing Documents. Test mixed Latin and Chinese/Japanese/Korean (CJK) identifiers, punctuation, Traditional Chinese, kana, compounds, title preference, deterministic ties, and one-character fallback candidates. Repeat on every shipped tokenizer/dictionary package. These observations close [issue #222](https://github.com/lingkaix/openkit/issues/222), including the Knowledge Manager's answer-sufficiency consumer.
2. **Filtering order:** Give authorized and unauthorized scopes identical query terms and private markers. Observe the scoring and scan boundaries: no unauthorized document is scored or scanned. Counts, snippets, scores, status, and errors reveal no inaccessible source. Revocation takes effect before deferred index cleanup, including after restart and through each face.
3. **Rebuild equivalence:** With identical canonical inventory, revisions, machinery identity, scopes, and query, an incremental index and clean rebuild return identical ordered hits, scores, provenance, and coverage. Index bytes and generation identifiers need not be identical.
4. **Exact completeness:** Compare literal and regex results with an independent exhaustive scan of the advertised representation. Include low-BM25 documents, chunk-boundary literals, multiline literals, CJK, Unicode, CR/LF handling, no-match queries, and rejected regex features. Limits and omitted matches must change completeness explicitly. A complete empty result proves no match only in its stated inventory and representation.
5. **Hostile input bounds:** Exercise malformed PDF/XML/ZIP, path traversal, duplicate entries, compression bombs, sparse worksheets, invalid encoding, parser faults, and cancellation. Observe bounded memory, time, disk, and output; no network, code execution, path escape, canonical mutation, or NanoCore crash occurs.
6. **One 1 GB upload:** Index an admitted 1 GB UTF-8 text upload with incremental reads and searchable markers near its start and end. Observe peak memory and allocations; no process allocates the whole upload. Also exercise a compressed upload that reaches an extraction bound and returns `resource-limited` without losing original bytes. Upload acceptance alone is not indexing success.
7. **Lifecycle faults:** Interrupt extraction, update, removal, commit, publication, and restart. Queries return only a complete committed generation with truthful document outcomes. Repeating an exact update or removal creates no duplicate hit. Concurrent writers and stale expected generations return conflict without overwriting current content.
8. **Source and face integration:** Search a published Knowledge Page, Workspace Material, eligible Artifact/upload, and a past conversation Item through the same kernel. Resolve exact citations and current audience. Verify current-or-named-directory CLI behavior and MCP root confinement. The Assistant finds eligible old Items outside its context window without exposing another user's private history.
9. **Packaged operation:** Run the shipped amd64 and arm64 packages with no dictionary/library download or inference dependency. Verify native loading, dictionary identity, extraction subprocess bounds, and the same result contract on each supported platform.

## Owner Amendments Required

- [Knowledge Store Implementation](20260703-knowledge_store_implementation.md): replace its lexical JSON index, `unicode-simple-v1`, term scorer, and scan exclusions with the kernel while preserving publication checks, pins, deterministic selection, and trace ownership.
- [Core Storage](../core/storage.md): replace the SQLite full-text default with the rebuildable Retrieval Kernel projection and preserve canonical record ownership.
- [Chat Mode And Core Assistant](20260704-chat_mode_assistant.md): add unified retrieval over eligible past Items and files to its history Tool contract without widening source or output audience.
- [Deployment Host Requirements](20260909-deployment_host_requirements.md): include the target-matched retrieval executable, dictionaries, PDFium supply, and measured extraction requirements without converting resource advice into a hard minimum.

This draft edits none of those owners. Source-specific upload and Workspace-view changes remain with their own work and are not implied by this mechanism.

## Open Decisions

Only one decision remains: whether Workers inside Sandboxes receive the CLI and MCP faces over their Workspace data view. The engineer has not yet discussed that view's contract. Recommend providing both faces over only the admitted view, with its existing audience and resource bounds. Defer packaging them into Sandboxes until the Workspace-view owner fixes admission, content identity, freshness, and mount boundaries. No host-directory access or new Worker authority follows from this recommendation.

## Later Phases

Phase 2 is multimodal vector retrieval, informed by zvec-grep and Tencent WeKnora. Filtering must not compute distance against unauthorized vectors. Index identity includes the embedding model and all representation settings that can change vectors. The Gateway embedding capability, including pi-ai's missing interface, waits for that work. No model, vector store, transport bypass, or provider adapter is chosen here.

OCR follows multimodal retrieval and applies only to measured failure classes where multimodal retrieval works very badly. Its design and resource contract wait for that work. WeKnora's use of OCR for scanned PDFs is evidence to test, not authority to reverse this order.

## Review Assumptions And Evidence Limits

The engineer fixed the architecture, four sources, lexical-first order, three faces, rebuildability, filtering boundary, and later-phase constraints. The following details are draft design choices for Consultant scrutiny, not verbatim engineer decisions:

- The initial format profiles, omitted Office parts, UTF-8-only policy, no-overlap chunks, ZIP nesting policy, formula representation, and decimal interpretation of GB.
- Any-term BM25, maximum chunk score per Document, title preference, deterministic tie order, Knowledge pin mapping, literal case/normalization rules, line-based regex, and rejection of empty regex matches.
- One exact scope per Document, narrower scopes for distinct eligibility, exclusion of stale eligibility groups, admitted-corpus ranking statistics, inventory reconciliation, revision verification, freshness reporting, and the proposed completeness fields/statuses.
- One writer, expected-generation conflicts, publication of scan text with postings, and explicit retry without a watcher, queue, or durable cursor.
- Directory inclusion rules, no symlink traversal, startup-bound stdio MCP, and the proposed mapping of library versus supervised service integration.
- The dependency baseline and the proposed package contents for each platform.

The research inspected upstream source and a small tokenizer probe; it did not build this combined Rust stack. It did not benchmark OpenKit relevance, admitted-corpus BM25, ambiguous Han text, dictionary memory, native package size, or small-host latency. Tantivy filtering documentation alone does not prove filtering before score computation; the implementation must demonstrate it.

No hostile-parser, 1 GB, platform-resource, or crash-publication qualification was run. PDFium random access and incremental worksheet APIs do not prove bounded parser memory. Office text order and extraction coverage need fixtures. The exact/regex completeness contract requires a separate exhaustive oracle, not the same scanner used twice.

The acceptance source is the engineer's 2026-10-14 ruling supplied with this task. No durable decision record is added within this writer's allowed paths. Independent review and owner acceptance remain with the primary and engineer; structural validator results do not establish design acceptance.

## Related Docs

- [OpenKit Policy Model](20260629-openkit_policy_model.md)
- [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md)
- [Test Strategy](20260529-test_strategy.md)
- [Thread Visibility And Explicit Sharing](20260909-thread_visibility_and_sharing.md)
