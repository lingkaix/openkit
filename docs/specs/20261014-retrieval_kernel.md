---
status: Accepted
implementation: Partial
kind: mechanism
date: "2026-10-14"
---
# OpenKit Retrieval Kernel

This specification defines one domain-free mechanism for indexing and searching caller-admitted documents of every type. It owns derived Markdown sidecars, UTF-8 text indexing, publication per scope, result completeness, and the shared Rust execution boundary.

## Owns

- The Document, derived Markdown sidecar, source key, scope, chunk, provenance, index generation, query, and result contracts.
- Scope filtering before ranking or scanning, without authorization inside the kernel.
- The rebuildable lexical index per scope and its identity, lifecycle, recovery, and failure semantics.
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

Before v0.1.0, users need one retrieval tool over Knowledge, Workspace data, Artifacts and uploads, and past conversations. The engineer's size target applies to one upload. Its admission owner defines the maximum and byte unit; the kernel does not define upload admission.

On 2026-10-14, the engineer accepted a [domain-free Retrieval Kernel](../decisions/20261014-retrieval_kernel_design.md) patterned after the Policy Kernel. The refined ruling 7 indexes readable UTF-8 directly and uses sidecars only for files that are not directly readable or indexable. Multimodal vectors follow lexical retrieval; optical character recognition (OCR) comes last.

This accepted specification defines the retrieval mechanism. The existing product owners retain their responsibilities and receive the amendments listed below before or with the corresponding implementation changes. [Chat Mode](20260704-chat_mode_assistant.md#assistant-history-tool) owns the accepted Assistant history Tool effect binding.

## Goals / Non-goals

Phase 1 provides Best Matching 25 (BM25) ranked search, literal exact search, regular-expression search, Chinese and Japanese segmentation, and metadata discovery. All four source families use the same kernel. The redesigned Chat Mode Assistant can search eligible Items across past conversations.

Phase 1 excludes type-specific extraction, embeddings, model calls, OCR, linked Git acquisition, cloud-source synchronization, fuzzy search, query-language operators, and semantic reranking. It adds no interchangeable backend or separate product search engine.

## Decision

One Rust executable uses Tantivy for lexical indexing. NanoCore supervises that executable as its one phase-1 integration. The CLI and MCP faces use the same indexing, filtering, and query implementation. Thin source and transport adapters translate inputs and outputs; they do not implement another search algorithm.

Tantivy serves the accepted CPU-only lexical phase. Each scope has its own committed generation, with no mixed-scope index. Exact and regex queries scan admitted sidecar text and canonical UTF-8 because indexed terms cannot prove arbitrary text matches. The initial implementation uses the ripgrep grep crates for that scan.

These choices can be replaced only through an accepted amendment that preserves this contract. Phase 1 has no engine selector.

## Definition And Exclusions

### Document, Source Key, And Scope

A Document is one revision of a caller-supplied source unit. Its core identity is source key, scope, source revision, and verified content digest. Directly readable UTF-8 text, Markdown, JSON, and stored conversation and Knowledge text are indexed directly. They receive no sidecar. An unreadable file is represented by its derived Markdown sidecar. The kernel does not accept an unrestricted host path from a product query.

Direct text retains its canonical title and provenance as indexed fields where its owner supplies them. A Document may also carry a source language hint and media type. The adapter supplies a bounded readable text stream or an admitted matching sidecar handle. This does not create a metadata document or a sidecar for directly readable text.

A sidecar is one plain Markdown document for a file that is not easy to read or index directly. Binary, PDF, Office, image, audio, video, and archive files use this representation. The adapter generates its identity metadata from the source: source key, content digest, media type, size, and name. Other metadata, such as path, timestamps, source kind, and producer, may be included when its owner supplies it. Missing optional fields remain unavailable; the adapter does not invent values.

Phase 1 has no type-specific processor. Its sidecar contains identity metadata only, which supports discovery by name, type, and other supplied metadata. The kernel indexes sidecar text in place of unreadable source bytes. A sidecar is not a user-authored file or a new canonical source. Authored Markdown descriptions, if separately admitted by the Artifact/upload owner, remain ordinary source text; this specification does not decide their storage.

When a processor exists, it adds content fragments to the same sidecar shape. Each fragment retains its representation, source key/link, and locator, such as page, sheet, slide, timestamp or time range, or archive entry. Later fragments may also carry a preview reference. Results return the original source key and fragment locator so a person or agent can return to the evidence. A phase-1 metadata match has a metadata locator and claims no page, timestamp, or extracted content.

Sidecar fields and fragment boundaries have deterministic Markdown serialization and escaping. Index identity records that serialization. Source metadata and generated fragments are untrusted content, never instructions or permission. The searchable representations are direct `text` and `sidecar`; results identify the representation and metadata field or fragment that matched. A sidecar does not give its source a second Document identity.

A source key is the opaque pair of adapter namespace and source-local identity. It is unique within one index. The adapter preserves it across updates. Two adapters that expose the same bytes retain distinct source keys and provenance.

A scope is an opaque exact identifier for documents with the same read eligibility. It is not a policy expression or a grant. Each Document has one scope. The adapter uses a narrower scope when a broad Workspace or notebook scope cannot express source restrictions. Each scope owns a separate index generation; private content never enters a Workspace-shared generation. No durable scope registry is required.

The caller supplies the exact readable scope set for each query. For product queries, trusted assembly derives this set within one current `(Server, Workspace, Actor)` and its Thread/Turn when present; request input may only narrow the admitted sources. It cannot select another User or arbitrary owner. The Assistant's current User is a context fact. Memory recall and Knowledge retrieval are separate invocations with labelled results and separate budgets; Workers cannot read Memory. The kernel performs no identity, membership, visibility, sensitivity, publication, or permission evaluation. An empty set returns no results and reads no source content. A missing set or an unknown required input is an invalid request, never a request to search everything. The direction and reason are recorded in [Query Context, Sources, References And Acts](../decisions/20261015-context_sources_references_query_acts.md).

Product pins, trace entries and citations identify the original source by `(scope id, object id)` under [Core Protocol](../core/protocol.md#scope-qualified-object-references). The scope is its logical owner, not this kernel's read-eligibility partition. The adapter maps that reference to a kernel source key without discarding its owner. Page object ids retain the existing stable bundle-relative path without `.md`; revision and digest remain separate evidence. A future cross-server reference adds server identity before remote resolution. No new page UUID or source-binding registry is introduced.

### Chunks And Provenance

A chunk is a bounded contiguous range of one Document's direct text or sidecar representation. The kernel assigns a stable ordinal and text offsets. It prefers paragraph or line boundaries and splits oversized units without splitting a UTF-8 code point. Phase 1 uses no overlapping chunks. A processor fragment identifies evidence within a source; a chunk only bounds indexing text. Splitting a fragment into chunks must preserve its source locator.

Each chunk retains the source key, scope, revision, source digest, representation, representation digest, text offsets, and an original locator. Locators identify a sidecar metadata field, processor fragment, Item, or canonical text byte range. A sidecar hit also retains processor identity. Sidecar offsets must not be represented as binary-file offsets.

Chunk boundaries affect BM25 units, not literal or regex scan boundaries. A scanner must find a supported match across a chunk boundary. It must not join separate Items, sidecar metadata fields, processor fragments, or representations into a false match. Each metadata field or fragment is one searchable sidecar unit with its own locator.

### Index Generation

An index generation is one committed, tombstone-free snapshot of Document revisions, sidecar cache references, representation identities, text statuses, and lexical postings for one scope. A query pins one generation for each readable scope. It cannot combine postings, sidecar text, status, or identity from different generations of that scope. Referenced cache entries stay immutable and available for the lifetime of that generation's readers.

Each generation includes a derived inventory for its scope. The adapter's canonical inventory remains authoritative. A query opens only the generations named by the caller's scopes, including for coverage counts and exact/regex scans. It has no global inventory read or mixed-scope memory map. There is no cross-scope atomic publication claim.

### Query Modes

Every query supplies a nonempty query string, one mode, the readable scopes, and a positive bounded result limit. Unknown modes, invalid regex syntax, and inputs above query limits fail before content access. Phase 1 provides three modes:

| Mode | Contract |
| --- | --- |
| `lexical` | Tokenize ordinary query text and rank matching chunks with BM25 inside each admitted scope generation. Match any query term. Return one hit per Document using its highest-scoring chunk, and prefer title matches. Merge scope hits by score, then source key and chunk ordinal. No Boolean, phrase, fuzzy, or regex parser operates on this query. |
| `exact` | Find literal, case-sensitive substrings in admitted sidecar or direct text. Preserve Unicode code points, whitespace, and line endings; apply no case folding or Unicode normalization. A literal can span lines within one searchable unit. |
| `regex` | Apply the Rust regex dialect through the grep matcher to each line of the searchable representation. Lines exclude the terminating line-feed (LF) byte; a preceding carriage-return (CR) byte remains content. Anchors refer to that line. Backreferences, lookaround, and explicit LF literals are unsupported and fail explicitly. Character classes operate within a line and cannot match across lines. |

Exact and regex results identify each returned occurrence and its text range. Their deterministic order is source key, representation, sidecar field where applicable, then match offset. They never use BM25 top results as the only scan candidates. Zero-length regex matches are rejected in phase 1 to prevent unbounded empty occurrences.

Knowledge pins belong to the governed Knowledge adapter, not the kernel query. The kernel provides lexical match/score enumeration before the adapter applies its product limit. The trusted adapter consumes that bounded stream to disposition every addressed page; the CLI and MCP project bounded hit lists from it. If enumeration stops early, it cannot establish a complete governed selection. A BM25 score is local to its index and does not establish relevance across independent indexes. The low-level scope merge is not a product-wide relevance order: adapters must not use it to combine Memory and Knowledge or independent Knowledge bases into one ranked result.

### Results And Completeness

A result contains the scope-to-generation identities, mode, ordered hits, bounded snippets, source provenance, matched representation, and coverage. Lexical hits include their score. Each face preserves the same semantics.

Coverage counts come only from the named scope generations. They report admitted objects, searched representations, stale revisions, and stopped work. Text statuses use the closed set `text-extracted`, `partial`, `unsupported`, `failed`, and `resource-limited`; `text-extracted` means existing UTF-8 was indexed, not that a format converter ran. `unsupported` describes a non-text body, not failure to index its sidecar. Unknown required status values fail closed; unknown additive metadata may be ignored.

The result distinguishes whether the admitted inventory was searched, whether all declared searchable representations were processed, and whether the response omitted matches. `complete` is true only when all three are complete. For lexical mode, match completeness means the requested top results, not every matching Document.

Limits, cancellation, output truncation, missing searchable representations, and stale inventory prevent an unqualified complete result. A binary body marked `unsupported` does not make a complete sidecar search incomplete. The result states that binary content was not searched. A bounded response may aggregate excess diagnostics by reason with an explicit omitted count. It cannot hide that omission or include inaccessible identities, titles, paths, counts, or errors.

Exactness refers to searchable sidecar text or canonical UTF-8, not arbitrary binary bytes or visual layout. Results identify the searched representations. A complete empty sidecar result cannot prove absence of a word inside a binary body.

## Kernel And Adapter Boundary

### Preconditions, Postconditions, And Invariants

Before a product query, NanoCore and the source adapters construct readable scopes through the Policy Kernel using current canonical facts. They also apply each source owner's non-authorization eligibility rules. Model-supplied scope identifiers cannot widen the resulting set.

The adapter reconciles each admitted inventory with its scope generation before asserting freshness. Scope construction must separate distinct read eligibility from creation. If current authorization no longer covers a complete generation, rebuild that scope from current admitted records before opening it. If that cannot complete, fail the affected operation explicitly; do not silently drop a shared scope as the normal query path. A final hit check cannot substitute for this pre-ranking boundary.

For Assistant use, NanoCore resolves both the source read scope and the destination audience under [Permissions](../core/permissions.md#assistant-disclosure-authorization). It excludes sources that cannot reach that audience before the query supplies model context. Every concrete read and later publication retain their current permission checks.

For every query mode, the kernel resolves the caller's scope set before opening any generation or canonical scan text. BM25 document counts, document frequencies, field lengths, coverage counts, and scans operate only inside those named generations. It merges only their eligible hits. Unauthorized generations cannot become speculative candidates or contribute statistics. A scope Boolean clause over a mixed index and a post-filter over ranked hits are both insufficient.

The adapter verifies current eligibility and the exact source revision before returning a hit to a product caller. A revoked or deleted source is withheld immediately, even when its postings remain. Missing authorization facts fail the affected request closed. Index cleanup is not the confidentiality barrier.

The kernel returns only source-linked retrieval facts. The adapter owns product citations, redaction, governed selection evidence, and any subsequent read or disclosure. The kernel cannot infer permission from an index row, prior result, file presence, or process restart.

### Governed Knowledge And Memory Alignment

[Knowledge Store Implementation](20260703-knowledge_store_implementation.md#retrieval-pipeline) remains the only governed Knowledge retrieval owner. The kernel replaces its lexical projection, not its governed selection operation. The page index, link graph, source-reference index, and validation report remain non-lexical JSON projections with their existing owners.

The governed request is `{query,limit,pinnedReferences,states?,sourceScope?}` with limit 1 through 20, default 5. Pins carry `{scopeId,objectId}` under Core Protocol's fixed path grammar, not ambiguous plain page ids. `sourceScope` is omitted, `workspace`, or `server`: omitted and `workspace` select current Workspace Knowledge; `server` selects only already admitted current Server Knowledge. Any other value is invalid. Trusted context admits the current Workspace Knowledge base and current Server Knowledge under its existing owner checks; one invocation narrows to one admitted base, defaulting to Workspace Knowledge. It cannot select User Memory or a different Workspace or Server. Memory recall is a separate Assistant-only invocation, not a union option or a new Tool id defined here. Default selection remains active-only; explicit state inspection retains its current admission. Exact and regex stay kernel modes for directory faces and separately admitted source adapters. They add no mode field or parallel substring route to governed Knowledge. Knowledge's lexical fields remain title, description, tags, and body. File sidecar discovery does not widen that governed candidate predicate or create sidecars for readable Knowledge pages.

The adapter addresses every pin through current source admission and obtains every readable lexical match from the kernel. A pin never widens a scope or changes the BM25 score. A pin for another source is invalid rather than a request to search it. Within one source, order by pinned first, descending local score, then bytewise page id and revision. A second source invocation retains its own labelled result and budget; Memory and Knowledge scores are never compared. The kernel's source-key tie-break does not replace product ordering.

Each addressed page retains exactly one existing first-match disposition and one selected or excluded trace entry. The adapter preserves sensitivity, conformance, policy, state/conflict/publication, freshness, and budget decisions in their current order. Current audience admission precedes opening a scope generation; inaccessible scopes contribute no private candidate identity. Discoverable denied pins use the existing redacted disposition, never a kernel scan of denied text.

The adapter rereads addressed canonical pages at their pinned notebook commit and verifies revision, digest, and metadata before selection. Missing or unreadable pages remain `source_unavailable`. Other authoritative/index disagreements remain `recovery_required`, with zero selected result and no trace row. Incomplete kernel enumeration cannot produce a successful governed selection; the adapter reports its owning typed failure instead.

The querying act owns one immutable file per trace under its Thread/Turn at the paths defined by Knowledge Store and Storage Layout. A direct User App query without a Thread or Turn publishes none and returns no trace id or reference; it retains the same context-derived source, narrowing, qualified-reference and current-access rules. A caller cannot omit existing lineage to skip publication. When a trace exists, every result that identifies it uses `{retrievalTraceRef}` and never a bare trace id. It binds trusted query context, one source, the notebook revision, caller, request digest, normalized parameters, qualified selected/excluded references and reasons. It stores no copied source content, snippets, query text or matched terms. An Assistant trace stays in its private Timeline; a Worker trace stays in its Task/Goal Thread and contains no Memory selection. Trace reads, ordinary export and direct record projections require current containing-record and source access; revocation cannot be bypassed through retained references. No User/Workspace combined ledger, source-owned trace or second trace store is added. Knowledge Manager and Task preparation consume this governed result without reranking; only the Context Package owner proves Worker delivery.

The proposed tokenizer amendment applies to indexing, query analysis, and Knowledge Manager answer sufficiency together. The current answer rule requires two distinct query terms in the page, or a one-term query in the title. This revision keeps that sufficiency rule; finding a short term in a body is not by itself a sufficient answer. The same selected tokenizer must analyze query, title, and body.

These mappings govern the required owner amendments listed below. Knowledge Governance, Core Permissions, the Policy Model, and their active-page, forgetting, conflict, confidentiality, and deterministic-selection rules remain binding.

### Source Adapter Registry

Each adapter must answer the same questions: canonical inventory and revision, stable source key, current readable scopes, eligible content, original locator, update/removal trigger, and response validation. The following table names the owners; it does not replace their semantics.

| Source adapter | Owned answers at the edge |
| --- | --- |
| Knowledge | [Knowledge Store Implementation](20260703-knowledge_store_implementation.md) supplies published page bytes and exact notebook commit/digest. [Knowledge Governance](20260702-knowledge_store_governance_rules.md) supplies publication, state, conformance, source, freshness, conflict, suppression, and audience rules. User, Workspace, and Server ownership stay distinct. Existing selection traces and pins remain with this adapter; a kernel result never proves Worker delivery. |
| Workspace data | [Work Resource Interaction](20260713-work_resource_interaction_model.md) supplies admitted Material revisions and other owner-exposed text/file units. [Workspace Data Source Catalog](20260704-workspace_data_source_catalog.md) supplies source identity where applicable. Registration alone does not authorize acquisition. Phase 1 indexes locally available admitted data, not every host or Sandbox directory. |
| Artifacts and uploads | [Work Resource Interaction](20260713-work_resource_interaction_model.md) supplies exact Artifact versions and provenance. [Knowledge Store Implementation](20260703-knowledge_store_implementation.md#upload-intake-and-source-registration) supplies attachment identity where applicable. [Thread Visibility](20260909-thread_visibility_and_sharing.md) supplies immutable-origin audience checks. An upload remains work history unless explicitly registered as a Knowledge Source. |
| Conversation history | [Thread Visibility](20260909-thread_visibility_and_sharing.md) supplies the parent audience. Canonical Item owners supply retained user-visible message text, metadata, Item identity, sequence, and revision/digest. The adapter excludes hidden reasoning, credentials, raw provider payloads, and unadmitted diagnostics. It indexes Items independently and links hits to their Workspace, Thread, Turn, and Item. |

Conversation search covers every eligible Item in every Thread the caller may read, including other past Threads and Items outside the current context window. It does not depend on provider memory, summarize history into Knowledge, or authorize private-to-shared transfer. The Assistant calls product adapters only; it receives no directory MCP or NanoCore host-checkout reader through this specification.

Linked Git repositories are a later adapter increment. They must use the accepted source and Workspace-view owners; the kernel will not clone repositories or become a NanoCore host-checkout reader.

## Phase 1 Searchable Representations

Index directly readable UTF-8 text from its canonical owner. This includes Markdown, JSON, source code, Items, Knowledge pages, Materials, and current text Artifacts. Do not create a sidecar for this text. Treat stored markup as text; do not execute code or render it.

An adapter declares direct text through its owner, not through a filename alone. Invalid declared UTF-8 fails without replacement characters. For a file that cannot be indexed directly, index its identity-only Markdown sidecar and report `unsupported` for body search. No type-specific parser, native extraction dependency, or extraction subprocess runs in phase 1.

Stream canonical UTF-8 through bounded buffers into chunks and postings. Exact and regex scans read the admitted canonical text or a matching committed sidecar through its adapter. Verify the pinned source revision, content digest, and sidecar processor identity before accepting matches. A changed or unavailable representation produces truthful incomplete coverage. The kernel does not publish a second scan-text copy of directly readable canonical UTF-8.

Bound sidecar and query size, line buffers, token/chunk size, memory, CPU/wall time, output, and temporary cache/index disk. Use named implementation constants and fix each test ceiling before the subject runs. A test cannot derive its expected bound from the run it judges. Admission of a large upload is not permission to allocate its entire body.

Failure or resource exhaustion preserves canonical bytes and yields `failed`, `resource-limited`, or `partial` as observed. The supervised executable must not crash NanoCore. It receives only admitted handles and packaged tokenizer data; it has no implicit network, credential, code-execution, or unrestricted host-path capability.

### Sidecar Cache Lifecycle

The adapter side owns the derived sidecar cache within the source's current ownership and audience boundary. Keep cache files separate from user-authored files. The storage owner assigns the exact path through its required amendment. Plain Markdown makes a sidecar file-readable; it does not grant a Worker access or establish a Workspace mount.

Create one sidecar when an unreadable source appears. Its cache identity binds source key, verified content digest, and processor identity, including version and output-changing configuration. A committed cache entry also pins the exact sidecar byte digest and source metadata revision. Phase 1 uses only an identity-metadata processor. A product sidecar uses the verified content digest already stored by its canonical owner. If that digest is missing, the sidecar is unavailable and the retrieval service leaves the body unopened. The directory adapter still computes incremental digests for files under its root.

When the content digest or processor identity changes, generate a replacement sidecar and retire the old active association. A metadata-only change refreshes the identity fields even when content bytes are unchanged. Remove the active sidecar and its index entries when the source is removed; invalidate access immediately on revocation, before cache cleanup. Any retained reader or backup copy stays subject to its source audience and the existing retention owner.

Stage generation under the existing adapter writer boundary. Publish a complete replacement atomically and keep earlier immutable entries while committed-generation readers need them. Metadata refresh does not overwrite an entry pinned by a reader. Once readers release, remove unreferenced retired entries through derived-cache cleanup. Failure preserves canonical bytes and reports unavailable or incomplete content; it cannot publish a partial file as a complete sidecar. A query uses the exact sidecar identity committed with its scope generation, not a later file silently substituted under the same path.

After restart, reuse only a cache entry whose source identity, digest, processor, integrity, and current audience still verify. A missing, stale, or corrupt sidecar can be rebuilt. Rebuild may be expensive; reuse valid entries rather than recreating them for every query or index rebuild. If rebuilding cannot complete, report that outcome instead of claiming content coverage. A sidecar is never canonical evidence, an original-file backup, or an authorization source. This cache adds no scheduler or retry queue.

## Durable Authority And Projection Boundary

Canonical records and authored configuration remain in their existing owners. The index, sidecars, chunks, statuses, and scope inventories are derived data. They can be discarded and rebuilt without changing canonical records. They carry no index migration or permanent legacy-reader obligation.

The index identity includes schema, sidecar serialization and processor identity, scoring/chunking rules, tokenizer code and configuration, normalization, and dictionary digests. A generation binds its scope, source keys, revisions, representation digests, and source digests. A later processor's version and output-changing settings must enter sidecar and index identity before its fragments become searchable. Compatible machinery does not prove fresh content.

A machinery mismatch makes a generation unusable and requires a rebuild of that scope. The kernel must not mix incompatible identities, read old projections permanently, or dual-write old and new indexes. Canonical notebook history, Items, Artifacts, uploads, and required evidence retain their owners' data-continuity obligations.

Derived content retains source confidentiality at rest. Product reads use scoped adapters, not raw index files or a public query socket. Index backups and diagnostics cannot widen source audiences. Storage layout places each generation in its owning User, Server, Workspace-shared, or private-source boundary. Another member's ordinary Workspace export excludes private generations. A local directory index stays outside product export and cannot inherit product authority. No new canonical retrieval database is introduced.

## Lifecycle And Recovery

1. **Index:** The adapter enumerates an exact admitted inventory for one scope and supplies verified revisions and direct text or valid sidecar references. The kernel indexes admitted text, records outcomes, and builds an unpublished generation.
2. **Update by key:** Replace the key's chunks, sidecar reference where applicable, representation identities, and status in the next scope generation. Repeating identical metadata and revision/digest is a no-op. A scope move removes the key from its former scope and adds it to its new scope under current adapter admission; there is no cross-scope transaction.
3. **Remove by key:** Omit that key and all its derived content from the next scope generation. Removing an absent key is a no-op. This operation does not delete the canonical source.
4. **Rebuild:** Re-enumerate that scope's canonical records and construct a complete replacement projection. Preserve per-representation unsupported or resource-limited outcomes; do not omit them and claim full content coverage.
5. **Publish:** Build a fresh tombstone-free Tantivy index for each publication, including after updates or removals. Make referenced sidecars durable, then commit postings, cache references, inventory, statuses, and identity and atomically flip that scope's one durable current-generation pointer. Acknowledge only after the pointer is durable. Queries see the previous complete tuple or the new complete tuple, never staged members. No incremental tombstones contribute to published BM25 statistics.
6. **Recover:** After a crash, open the last valid committed generation named by that scope's pointer. Ignore incomplete staging. If no compatible committed generation exists, report that scope's index unavailable and rebuild from canonical sources.

One writer owns a scope index at a time. A conflicting writer fails before mutation. Updates use an expected scope generation and the adapter's fixed source revisions. A changed generation or contradictory digest for the same source revision returns `conflict`; the caller must re-enumerate current truth before retry.

The kernel owns no automatic background watcher or retry lifecycle. NanoCore calls it from existing source operations and explicit rebuild/startup paths. A failed or uncertain publication is inspected against the scope's committed pointer and generation, then retried by current source key/revision. Recovery never invents a source revision or replays a canonical write.

Queries pin their named scope generations until completion. Cancellation releases their readers and temporary resources. Old generations may be removed only after their readers release them; cleanup touches derived bytes only. This lifecycle terminates with removal or index disposal and creates no retained-data deletion authority.

## Conflict, Missing, Stale, Restart, And Dependency Failure

| Condition | Required behavior |
| --- | --- |
| Stale source inventory | Return `complete=false` for the generic result and withhold changed or deleted hits until their current revision is indexed. A stale empty result cannot prove absence in current history. Governed Knowledge retains its stricter pinned-commit disagreement failure. Authorization loss follows the pre-open scope guard, not stale-hit filtering. |
| Missing canonical bytes | Return a bounded source-unavailable outcome for an otherwise discoverable source. Do not substitute another revision or create an empty canonical source. |
| Index identity mismatch or corruption | Refuse that generation and request rebuild. If a compatible valid committed generation remains, it may serve with truthful freshness; incompatible fallback is forbidden. |
| Partial or unsupported text | An unreadable file keeps its valid identity sidecar searchable and reports body search as `unsupported`. Partially processed declared UTF-8 sets `complete=false`; a direct-text failure does not manufacture a sidecar. |
| Sidecar missing, stale, or corrupt | Rebuild under current source authority or report unavailable/incomplete coverage. Do not use a wrong digest or processor, silently substitute fragments, or claim that the sidecar is canonical. |
| Query scan limit or cancellation | Return available hits only with explicit incomplete coverage and the stopping reason. A retry is a new query against current scopes and generation; phase 1 has no durable search cursor. |
| Required tokenizer or dictionary missing | Fail the dependent operation explicitly. Do not silently select another tokenizer. Independently healthy scope generations may remain queryable when they do not need the missing dependency. |
| UTF-8 indexing or scan failure | Report `failed` or `resource-limited` as observed. Preserve canonical input and identify the affected representation. |
| Disk exhaustion or publication failure | Preserve the last committed generation and canonical bytes. Refuse further growth; do not purge retained sources or acknowledge an incomplete generation. |
| Authorization or audience dependency failure | NanoCore fails closed before supplying content or returning product hits. It does not turn an indeterminate permission result into partial authorization. |
| Restart | Reconstruct current scopes from their owners and open the last valid commit. Prior results, cached scopes, and derived status never restore access. |

Full exact-search completeness requires the adapter's complete admitted inventory at fixed revisions and a successful scan of every declared searchable representation. The CLI also detects files changed during reads and reports incomplete coverage. Without a filesystem snapshot, it cannot claim a point-in-time snapshot of a concurrently changing directory.

## Three Faces And Packaging

NanoCore supervises the executable as a local service in phase 1. The service accepts only trusted local adapter requests; it has no network listener or independent permission database. There is no second in-process integration in this phase.

The executable provides a directory CLI that defaults to the current directory and accepts one named directory. The directory adapter binds one scope index to that root and derives source keys from root-relative paths. It reads text directly, creates identity-only sidecars only for files it cannot index directly, and computes digests incrementally. It visits regular files under the selected root, includes dotfiles, and skips its own derived cache/index. It does not apply implicit Git ignore rules or follow symlinks. Unavailable files and concurrent changes appear in coverage. Directory selection and operating-system access bound this local tool; they do not grant product access.

The executable also provides one MCP search tool over an already admitted adapter view. The tool accepts the same modes, query, and limit and returns the same result semantics. Product scope construction stays in NanoCore. A local directory MCP launch binds its root at startup; a model cannot widen it by passing another path. MCP uses standard input/output and adds no remote server, authentication store, or write tool. Index preparation and explicit rebuild use the same executable operations outside the search tool.

Package the executable and tokenizer dictionaries for amd64 and arm64. Linux application distributions must contain target-matched artifacts for both architectures. NanoCore source support on Linux and macOS also requires compatible retrieval supply for both architectures; source-build support does not imply qualified macOS Sandbox support. Phase 1 installs no CLI or MCP face inside a Sandbox.

Runtime packages must not download dictionaries on first query. Package their identity and license notices. Qualify each supported platform's service resource enforcement and tokenizer compatibility. Missing mandatory packaged content fails explicitly. The combined deployment resource recommendation is not a retrieval-only budget or mandatory minimum.

## Current Implementation Projection

Partially implemented. The Rust executable provides CLI, MCP and trusted local service faces. NanoCore supervises the service, admits current product sources and replaces Knowledge lexical JSON postings with kernel retrieval while retaining non-lexical projections. Canonical Git notebooks, commit-bearing evidence and User/Server scope surfaces remain pre-existing unimplemented requirements. The current file-backed Workspace path verifies exact observed page bytes without claiming retained commit pinning. The 2026-10-15 context/source/reference/query-act direction supersedes the union pin/trace questions; the coordinator and Consultant accepted its request and trace details under the engineer's delegation, and Phase B implements them. The governed path uses qualified pins, separate scored responses and immutable query-owned trace files; threadless direct User calls publish none. The current byte-backed projection records no retained notebook commit. The upload maximum remains dependent on the Artifacts owner. [Chat Mode](20260704-chat_mode_assistant.md#assistant-history-tool) now defines the accepted history Tool binding; its implementation remains separate evidence.

The dependency baseline is Tantivy 0.26.2, tantivy-jieba, and Lindera 5.0.1 with the runtime-packaged IPADIC Japanese dictionary. OpenKit adapts the Lindera Segmenter directly to Tantivy tokens; the unused lindera-tantivy and lindera-analysis dependencies are removed under #249 with characterization checks for token fields and scoped retrieval. Select one segmentation tokenizer per Document: Chinese Jieba, Japanese Lindera, or Unicode word tokenization for other text. A reliable source language hint selects it. Without a hint, kana selects Japanese, Han without kana selects Chinese, and other text selects Unicode tokenization. Query, sidecar, title, and body use the corresponding settings and shared Latin normalization. Do not run both dictionary tokenizers because a hint is absent.

For `htmlescape 0.3.1`, OpenKit elects Apache-2.0 and packages the unedited canonical license text with separate OpenKit election/provenance metadata. That metadata is not an upstream notice. The corrected Linux dependency graphs exclude `kanaria`. These source corrections do not close [#249](https://github.com/lingkaix/openkit/issues/249): both target packages still require inspection for exact license/provenance bytes and the corrected dependency graph.

Keep the accepted n-gram fallback field for terms that segmentation misses, including one-character candidates. It does not select a second dictionary tokenizer. Verify gram candidates against the admitted representation before treating them as literal matches. The scan baseline is `grep-searcher` plus `grep-regex`. Compatible versions belong to the implementation lockfile; output-changing versions enter index identity. These choices are not qualified build or resource claims.

The storage-layout amendment assigns exact index and sidecar-cache paths. Their ownership homes are the existing User, Server, Workspace-shared, or private-origin boundary, with derived cache files separate from user files. Private Thread material remains in its Workspace under that Thread's audience, outside the shared index. The scope identifier selects a safe derived location, not an arbitrary path. No path alone supplies read authority; export resolves the owning audience.

## Rollout / Migration Plan

Accept this specification and the affected owner amendments before production changes. Replace the lexical Knowledge JSON index and tokenizer directly with the kernel projection per scope. Preserve canonical notebook and source records, the governed request and dispositions, and required selection evidence. Non-lexical JSON projections keep their owners.

Build fresh scope generations from canonical records, verify their identity and acceptance predicates, and switch all affected retrieval consumers together. Remove the replaced lexical path. No compatibility shim, dual write, or second governed Knowledge ranker remains. Arbitrary-file admission, authored description storage, and the Workspace view retain their separate owner work. Sidecar generation does not authorize those contracts.

## Testing Strategy / Acceptance Criteria

Use the existing test strategy and test execution owners. These predicates prescribe observations, not a new runner or assurance framework. All five DOC-017 classes apply to this mechanism; none is omitted as not applicable.

1. **Chinese and Japanese regression:** Index `我们完成了测试，并修复了缺陷。` and `検索機能を改善しました。` with unrelated titles. Lexical queries `测试`, `修复`, and `検索` find the body Documents. Exercise mixed Latin and Chinese/Japanese/Korean (CJK) identifiers, punctuation, Traditional Chinese, kana, compounds, title preference, deterministic ties, and one-character fallback candidates on shipped dictionaries. Through Knowledge Manager `answer`, the one-term body-only queries return `insufficient-evidence` under the preserved title rule; a matching title permits a cited answer. The two-term queries `测试 修复` and `検索 改善` produce cited answers from those bodies. This distinguishes the [#222 retrieval regression](https://github.com/lingkaix/openkit/issues/222) from answer sufficiency.
2. **Filtering order:** Give readable and unreadable scopes identical terms and private markers. For lexical, exact, and regex, observe generation opens, statistics, and canonical reads: only named readable scopes participate. Adding or changing an unreadable generation changes no visible score, order, count, snippet, or diagnostic. Apply revocation before generation access and repeat after restart through each face.
3. **Rebuild equivalence:** Within one scope, publish an update and a removal, then compare with a clean rebuild of the same live records. Both published indexes contain no tombstones. With identical identities, revisions, tokenization, and limits, ordered hits, scores, provenance, and coverage are identical. Repeat the same scope merge to establish deterministic combined results. Index bytes and generation identifiers need not be identical.
4. **Exact completeness:** Compare literal and regex results with an independent exhaustive scan of searchable sidecar units and canonical UTF-8. Include low-BM25 documents, chunk-boundary and multiline literals, CJK, Unicode, CR/LF handling, no-match queries, and rejected regex features. Limits and omitted matches change completeness explicitly. A complete empty result proves absence only in the stated searchable representations. Governed Knowledge retains its lexical request and adds no exact/regex route.
5. **Hostile input bounds:** Before the run, fix named fixture ceilings for memory, CPU/wall time, output, line buffers, and temporary index disk. Exercise oversized sidecars, long lines, invalid UTF-8, excessive query/regex size, cancellation, and disk exhaustion. Observe each ceiling without deriving it from subject output. No network, code execution, path escape, canonical mutation, or NanoCore crash occurs. Binary bytes invoke no format parser.
6. **One admitted upload at the admission owner's maximum:** Under the accepted upload owner, index a UTF-8 object with markers near its start and end. Observe allocations and peak memory; no process allocates the whole upload. Also index a binary object's sidecar at that admitted maximum without reading its body for type-specific processing. Limits yield truthful incomplete status without losing original bytes. This specification chooses no upload byte count or unit.
7. **Lifecycle and status fixtures:** Interrupt index preparation, update, removal, index commit, pointer publication, and restart. Postings, sidecar references, representation identities, inventory, and statuses come from one committed generation per scope. Verify last-pointer recovery, idempotent updates/removals, and writer/expected-generation conflict. A changed canonical revision returns generic `complete=false`, withholds the old hit, and leaves an empty result unable to prove absence. Exercise binary-body `unsupported`, malformed-text `failed`, stopped-work `partial`, and exhausted-budget `resource-limited`. Unreadable files retain valid identity-sidecar discovery; direct-text failures create no sidecar.
8. **Source and governed integration:** Search a published Knowledge Page, Workspace Material, eligible Artifact/upload, and past Items through the same kernel. Through the governed adapter, verify context-derived source admission, request bounds, qualified pins, states, all dispositions, source-local page-id/revision ties, canonical disagreement failures, querying-act trace ownership and current-access redaction. Equal page paths in different sources never alias. A request cannot widen its context; separate Memory/Knowledge invocations expose labelled results and separate budgets without comparing index scores; Workers receive no Memory. Revocation after selection withholds referenced content on trace read. Knowledge Manager answer and preparation share that result without another selector. The Assistant finds eligible Items in a different past Thread and never reads another user's private history or a host checkout.
9. **Direct text and sidecar discovery:** UTF-8, Markdown, JSON, conversation Items, and Knowledge pages are indexed directly with zero sidecar files. An unreadable file has exactly one active identity-only Markdown sidecar. Match its source key, digest, media type, size, and name, plus optional metadata where supplied. Return the original source key, sidecar representation, and metadata locator. Binary-body markers do not appear as extracted content. Agents with separately admitted file access can read the plain Markdown. Private fields and cache/index generations remain absent from another member's search and ordinary export.
10. **Packaged faces:** Run shipped amd64 and arm64 packages without dictionary downloads or inference. Verify the supervised NanoCore service, current-or-named-directory CLI, the single scoped directory query path, and startup-bound MCP root confinement. Sandbox CLI/MCP installation is absent. Verify service resource enforcement and the same result semantics on each supported platform.

11. **Sidecar cache:** Source appearance creates the cache entry; digest or processor change replaces it; metadata change refreshes identity; removal invalidates and removes it. Interrupt replacement before and after publication, then restart. Reuse a valid entry without processing again; rebuild a missing/corrupt entry or report unavailable without canonical mutation. Old readers retain their exact committed cache identity. No stale, wrong-processor, partial, or revoked sidecar returns a complete hit. Later processor fixtures must return the original source and exact fragment locator, not sidecar offsets as evidence coordinates.

## Owner Amendments Required

Each line identifies an existing owner and the accepted rule to retain or replace. The Knowledge Store, Knowledge Manager, Personal Memory, Storage Layout, Core Storage, Work Resource Interaction, and Deployment Host Requirements owners include these retrieval amendments. [Chat Mode](20260704-chat_mode_assistant.md#assistant-history-tool) defines the accepted history Tool effect binding; this specification introduces no Tool or operation id. Upload admission remains with the Artifact/upload owner.

- [Knowledge Store Implementation](20260703-knowledge_store_implementation.md): replace its lexical JSON term index, `unicode-simple-v1`, occurrence-count/title-bonus scorer, and JSON CJK default with per-scope kernel BM25 and segmentation; retain the non-lexical JSON indexes, limits, explicit-state admission, addressed-page dispositions, strict pinned-commit disagreement failure and one governed retrieval owner; amend requests, pins and query-act trace ownership as mapped above. Its prohibition of a parallel substring path remains; phase 1 adds no Knowledge query mode. Its deferred format extraction remains deferred under ruling 7.
- [Personal Memory And Knowledge Learning](20260909-personal_memory_and_knowledge_learning.md): replace the private User/Workspace union with context-derived, separate Memory recall and Knowledge retrieval, labelled sections and separate budgets. Use qualified references and source-local ranking; query acts retain their own traces. Preserve source/audience admission and forgetting; the kernel never grants access.
- [Knowledge Manager Service](20260704-knowledge_manager_internal_agent_runtime.md): use the same selected tokenizer for indexing, query, title, body, and deterministic answer sufficiency; retain the two-term page or one-term title rule, cited/insufficient-evidence outcomes, S61-only answer/preparation delegation, caller assignment, typed failures, and S39-only delivery proof.
- [Storage Layout And Record Ownership](20260703-storage_layout_record_ownership.md): replace the SQLite full-text classification and mixed `indexes/search.json` retrieval projection with scoped index and adapter-side sidecar-cache ownership; assign exact paths separately from user files and retain unrelated SQLite projections. Resolve private Thread ownership before index publication or export; private generations cannot enter another member's ordinary Workspace export, and local directory indexes cannot enter product export. Backup retains its separate authority.
- [Core Storage](../core/storage.md): change both the instruction to use SQLite for full-text search and the SQLite full-text default to the rebuildable Retrieval Kernel projection; retain SQLite's other companion-store uses and canonical ownership/data continuity.
- [Chat Mode And Core Assistant](20260704-chat_mode_assistant.md#assistant-history-tool): owns `thread.history.read` and its accepted bounded past-Thread Item search through the conversation-history adapter, current-User eligibility, source/output-audience rechecks, qualified references, and querying-Turn trace. Object sidecar discovery stays on the Artifact and Material adapter: an admitted Artifact sidecar uses `artifact.read`, and a Material uses `workspace.read`. `knowledge.search` remains the governed Knowledge Tool. Retain current source/output audience, Knowledge Manager delegation, and the prohibition on a directory MCP or NanoCore host-checkout reader. The [accepted binding](../decisions/20261015-assistant_history_tool_binding.md) adds no operation id or durable record beyond the existing query trace.
- [Work Resource Interaction](20260713-work_resource_interaction_model.md): supply canonical file identity for sidecars of unreadable Artifacts/uploads, keep readable Artifact/Material text direct, and define any missing upload identity through the Artifact/upload topic; retain exact versions, immutable origin, current audience, admission limits, and storage ownership. Authored description storage and arbitrary-file upload admission remain separate pending owner decisions, not new kernel state.
- [Deployment Host Requirements](20260909-deployment_host_requirements.md): include the target-matched supervised retrieval executable, dictionaries, and measured UTF-8 service resource requirements for amd64 and arm64; remove no existing qualification boundary and add no format extractor or conversion of resource advice into a hard minimum.

Knowledge Governance, Core Permissions, Thread Visibility, the Policy Model, and Policy Enforcement Mapping remain binding and unamended. Their confidentiality, source, active-page, conflict, forgetting, effect, and evidence boundaries are preserved by the adapters. The Workspace data view remains a separate topic, not an implied mount or storage amendment.

## Open Decisions

- **Worker CLI/MCP and sidecar exposure:** The Workspace data view has not been discussed. Phase 1 installs neither face inside a Sandbox. Its owner decides whether Workers receive the CLI/MCP, ordinary file tools, and separately admitted plain Markdown sidecars after fixing audience, content identity, freshness, and mount boundaries. Any Markdown/JSON object manifest is also that view's projection, not kernel state. File readability alone grants no Worker access.
- **Authored descriptions:** The Artifact and upload owner must decide where user- or agent-authored Markdown descriptions live and how they are versioned and published. An admitted description is directly readable text with no sidecar of its own. The kernel creates no authored-description store.

The refined ruling 7 settles direct text versus derived sidecars. No extraction question or format-specific design remains open here. Sidecar storage paths belong to the required storage-owner amendment, not a kernel path choice.

## Later Phases

Type-specific processors are later increments with the accepted Artifact and upload owner. PDF/Office text, captions, transcripts, and measured OCR exceptions add fragments to the same sidecar shape. Their format, resource, provenance, and coverage designs wait for that work; no native extractor or subprocess is selected here. Linked Git/cloud adapters and additional encodings also wait for their source/view owners.

Phase 2 is multimodal vector retrieval, informed by zvec-grep, Tencent WeKnora, and the Indexed fragment pattern. Each fragment gains a vector beside its representation, source link, locator, and preview reference. Index and query use one fixed model identity, dimensions, and preprocessing in one retrieval space. Those identities enter sidecar/vector index identity; a mismatch requires rebuild. Filtering must not compute distance against unauthorized vectors. The Gateway embedding capability, including pi-ai's missing interface, waits for that work. No model, store, transport bypass, or provider adapter is chosen here.

OCR follows multimodal retrieval and applies only to measured failure classes where multimodal retrieval works very badly. Its design and resource contract wait for that work. WeKnora's use of OCR for scanned PDFs is evidence to test, not authority to reverse this order.

## Review Assumptions And Evidence Limits

The engineer fixed the architecture, four sources, lexical-first order, three faces, rebuildability, filtering boundary, later-phase constraints, and ruling 7's sidecar/text boundary. The engineer's refinement fixes sidecars only for unreadable files, their cache lifecycle, and the later fragment/locator/preview pattern. Description storage and Workspace exposure remain owner dependencies. The Consultant corrections prescribe separate scope generations, tombstone-free publication, governed adapter preservation, and the supervised NanoCore face. The following details remain draft choices:

- No-overlap chunks, maximum chunk score, title preference, and source-key ties inside the kernel.
- Literal case/normalization rules, line-based regex, rejection of empty matches, and sidecar field serialization.
- Inventory reconciliation, revision verification, the generic completeness/status contract, and safe cache publication/reuse within the required ownership boundary.
- One writer, expected-generation conflicts, explicit retry without a watcher/queue/cursor, directory inclusion rules, no symlink traversal, and startup-bound stdio MCP.
- The dependency baseline, deterministic language selection without hints, n-gram fallback, and package contents.

The research inspected source and a small tokenizer probe; it did not build this Rust stack. No OpenKit relevance, ambiguous-Han, dictionary-memory, package-size, or small-host benchmark exists. The Consultant identified index-wide BM25 statistics and tombstones in Tantivy 0.26.2. Scope isolation and fresh publication address those mechanisms, but their implementation still needs observed generation-open and score-equivalence evidence.

No hostile-text, maximum-admitted-upload, platform-resource, or crash-publication qualification was run. Exact/regex completeness needs an independent exhaustive oracle. The supplied Indexed report illustrates fragment recall and return to evidence; it does not qualify OpenKit retrieval quality, cost, or cache recovery. Sidecars do not prove that the pending upload owner admits every file type or has decided description storage. Structural validation cannot settle those owner decisions or certify retrieval behavior.

No decision record is added within the allowed writer paths. Independent review and owner acceptance remain with the primary and engineer. This specification stays one mechanism after considering the writing guide's split trigger: scope isolation, governed adapter mapping, publication, and acceptance need to be read together; format-specific design has been removed.

## Related Docs

- [OpenKit Policy Model](20260629-openkit_policy_model.md)
- [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md)
- [Test Strategy](20260529-test_strategy.md)
- [Thread Visibility And Explicit Sharing](20260909-thread_visibility_and_sharing.md)
