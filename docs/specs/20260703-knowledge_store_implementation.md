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

This spec turns the accepted Knowledge Store governance rules into an implementable contract. It pins the portable envelope to OKF v0.2 via a repository snapshot, defines the scoped notebook layout and record encodings, specifies validation before authoritative page writes, defines one deterministic governed retrieval owner for current knowledge-reading surfaces, projects the fixed-base Git notebook publisher through existing command owners, names the product operation families, defines the store-side effects consumed by Knowledge Manager and S39, and specifies the direct migration from the current minimal knowledge slice.

The design principle is file-system-first with one deterministic rebuildable index projection: governed Markdown bytes in the published notebook Git tree are authoritative, V1 uses the portable JSON indexes under `indexes/`, and no SQLite, vector, graph, or other accelerator may become a second source of truth or a second retrieval owner.

## Goals / Non-goals

Goals:

- Make the Knowledge Store buildable without further design decisions for the v1 retrieval-first scope.
- Pin OKF conformance to a fixed snapshot so external drift cannot silently change OpenKit validity rules.
- Keep every governed record inspectable and portable as plain files.
- Make retrieval deterministic, explainable, and traceable in v1.
- Keep retired Workspace `memory` aliases absent while implementing intentional User Memory through the common scope resolver.

Non-goals:

- No hidden scheduler, universal RAG engine or general-purpose Agent filesystem; bounded multi-page maintenance follows the notebook editing owner.
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

The scoped learning owner defines User/Workspace/Server admission; `20260909-knowledge_notebook_editing.md` owns one Git content history and fixed-base multi-file publication. The physical-root owner remains the storage layout. Scope, profile and schema migrate directly to v4 with all readers/writers together: move the validated Workspace schema to `knowledge/schema/scope-schema.yaml`, retain schema history and the migration report, and reject conflicting old/new files before changing either. New User/Server notebooks start directly in the target layout. This is Not Started, not a compatibility alias.

Every operation, lookup and request hash includes exact `ownerScope`. Profile v4 has no page revision counter: `notebookRevision` is the opaque full published Git commit ID, and `contentDigest` is SHA-256 of the exact page bytes. API `revision` fields project that same commit. Git retains prior bytes; Sources retain original evidence rather than duplicate page history. A forgotten page identity remains reserved by existing suppression metadata; a later explicit save uses a new identity and current notebook base.

Human edits, ordinary delegated edits and reviewed candidates use the same publisher and scope writer fence. Existing proposal/review records retain an exact base and candidate commit, source versions and responsible actor. Older immutable decisions remain historical evidence and cannot authorize a new effect. Generated pages can be editing/comparison inputs with exact lineage; they cannot bootstrap factual authority by citing each other. Current source, audience, conflict and assessment checks remain independent of content-version provenance.

### File layout and identifiers

The workspace knowledge tree follows the workspace scope layout in the storage spec:

```text
<workspace>/
  knowledge/
    schema/
      scope-schema.yaml
      history/
    notebook.git/  # authoritative published tree and retained history
    pages/         # optional materialization of one commit
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

`pages/` in the published Git tree is the OKF bundle root; `knowledge/pages/` is only its optional materialization, so the reserved `index.md` and `log.md` files live inside `pages/`, and the bundle-root `index.md` carries the `okf_version` declaration. The governance surfaces outside the bundle — `schema/`, `proposals/`, `reviews/`, `observations/`, `claims/`, `conflicts/`, and `traces/` — match the governance spec's notebook-versus-maintenance split and are not part of the exported OKF bundle. Concept IDs follow the snapshot rule: bundle-relative path with the `.md` suffix removed.

A `knowledgePageId` is 1 to 240 UTF-8 bytes of forward-slash-separated lowercase ASCII segments, each matching `[a-z0-9][a-z0-9._-]{0,63}`; empty segments, `.` or `..`, final `index` or `log`, trailing `.md`, backslash, absolute paths, control characters, NUL and `@` are invalid. Reserved files are excluded at every depth. Resolve IDs only within the admitted commit's `pages/` tree; reject symlinks, non-regular content and unsafe materialization parents. Published paths remain stable; title/index edits and archive/supersede plus new pages provide reorganization. The notebook owner defines confirmed deletion and forgetting; no published-path move or identity-history engine is added.

`sources/` is a sibling record family, not a subdirectory of `knowledge/`, even though the Knowledge Store conceptually governs sources and derived representations: the evidence layer is consumed by context packages, evidence bundles, audit traces, and artifacts as well as by knowledge pages, and it has different size, immutability, backup, and retention characteristics than the notebook. Physical layout follows record family and lifecycle; conceptual ownership stays with `docs/core/knowledge.md`.

Knowledge pages are OKF concept documents whose frontmatter carries the OpenKit required fields from the governance spec (`type`, `title`, `schema_version`, `openkit_status`, `scope`, `source_refs`, `review_state`, `sensitivity`, `freshness`, `created_at`, `updated_at`) as producer-defined extension keys, which the pinned snapshot explicitly permits. OKF `description`, `tags`, `resource`, `sources`, `generated`, `verified`, `status`, `stale_after`, and Attested Computation metadata retain snapshot semantics as data. `updated_at` remains authoritative for OpenKit freshness computation; no timestamp or citations compatibility fallback exists. OpenKit Knowledge Profile is `openkit-knowledge-profile-v4` and the default Scope Schema is `openkit-scope-knowledge-schema-v4`. The schema configuration file's own `status: active` and `allowed_statuses` keys retain their separate configuration meaning.

The Scope Schema for the Workspace projection is a YAML file at `knowledge/schema/scope-schema.yaml` with `schema_version`, owner metadata, active status, timestamps, allowed types, field constraints, source-reference shape, proposal rules, review requirements, and lint rules per the governance spec. Previous schema versions and migration reports are preserved under `knowledge/schema/history/`.

Proposals remain Markdown records with `type: proposal`, `operation: notebook-change`, `owner_scope`, `base_revision`, `candidate_revision`, `source_references`, `rationale`, `confidence`, `review_required`, authenticated `producer` and `created_at`. `proposalId` remains `kp_` plus SHA-256 of canonical JSON `{ownerScope,requestId}`. A service-owned Git ref `refs/proposals/<proposalId>` retains exactly the immutable candidate commit whose sole parent is `base_revision`; its server-computed `candidate_revision` binds all final page bytes and changed paths. The proposal body is a human-readable summary, never substitute candidate bytes. Confidence adds no authority. Sources are verified before persistence; changed candidate/base/source requirements require a new proposal. Completed-Worker provenance still requires the strict terminal Worker/Item/S39 trio.

The generated-proposal `sourceReferences` field is one bytewise-sorted, duplicate-free array of strings with this closed grammar:

- `source:<sourceId>@<contentDigest>` names one registered Knowledge Source and its exact captured content digest.
- `knowledge:<knowledgePageId>@<contentDigest>` names one admitted Knowledge Page and exact digest at the proposal base commit. Its publication/source lineage must verify; generated content is comparison material and cannot alone corroborate a new factual claim.
- `turn:<turnId>` names one terminal same-Workspace worker Turn.
- `item:<itemId>` names one completed immutable Item owned by a cited Turn.
- `context-package:<turnId>@<contextPackageDigest>` names that Turn's exact accepted S39 trace and package digest.

The `@` separator is forbidden inside ids. A registered `sourceId` is server-generated as `ks_` plus one lowercase canonical UUID and MUST satisfy the same single safe path-segment and symlink-containment checks at registry, material, derived, read, and import boundaries. `contentDigest` is `sha256:` plus 64 lowercase hexadecimal digits, and `contextPackageDigest` uses S39's exact digest format. A generated proposal that claims completed worker output MUST contain one matching terminal direct-Task `turn`, the final completed `assistant-message` Item projected by that Turn, and that Turn's strict live `context-package` reference; citing its `user-message` request Item, another completed Item, or an imported-history trace does not prove new worker output. The three owners must agree on Workspace, Thread, Turn, terminality, and delivery lineage. Bare ids, external URLs, nonterminal work, unverified generated-Page references, current-page substitution, and unsupported reference prefixes fail validation and create no proposal. This closed proposal-evidence vocabulary does not replace Knowledge Page `source_refs`, create a generic record-reference abstraction, or authorize new source records. Evidence outside this V1 set must first be captured through the existing registered Knowledge Source owner.

`knowledge/reviews/<proposalId>.json` is `{proposalId,ownerScope,decisions}`. Append-only decisions are `{reviewId,requestId,decision,actor,proposalDigest,baseRevision,candidateRevision,decidedAt}`; `reviewId` is `kr_` plus SHA-256 of canonical JSON `{ownerScope,proposalId,requestId}`. Decision is deferred, accepted or rejected; accepted/rejected are terminal with exactly one terminal row. The accepted base/candidate must equal the fixed proposal and current published base. Atomically replace the review file with previous exact rows plus the new row. Changed request input conflicts; no combined edit-and-accept operation exists. Historical older rows never authorize a new notebook publication.

Observations are JSONL ledger rows per the governance spec, one file per month, excluded from the OKF bundle and from notebook views. Source registry records are JSON files carrying the source identity fields from the governance spec; captured first-slice text material lives under `sources/materials/<sourceId>/content.txt`; derived representations live under `sources/derived/<sourceId>/` with lineage back to the exact source id and content digest.

Proposal application and restoration share the notebook publisher; Git supplies content history, existing Proposal/Review supplies required decisions, and Audit/command receipts supply effect evidence. No page counter, prior-page Source copy, application ledger, rollback record or recovery workflow is added.

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

Persisted indexes are publication-neutral projections tagged with their source notebook commit. Valid pages in all supported states use one candidate/index path, preserving human/Agent attribution; active authorized `user-authored`, `delegated` and exactly reviewed `accepted` pages are the default selectable set. Explicit state inspection uses the same postings. Eligibility derives from current publication lineage and current source/audience checks, not a request-supplied human-review proof map. Imported attribution is provenance rather than a grant. External Turn/Item/S39 references still require their actual current owners before content is returned. Generated-to-generated links cannot bootstrap truth or bypass source disclosure. Current permissions, suppression, conflicts and assessment requirements are evaluated at retrieval; a stored index never grants access.

### Retrieval pipeline

The request is `{query,limit,pinnedConceptIds,states?}`: query is non-empty, limit is 1 through 20 with default 5, and pins are bytewise-sorted and duplicate-free. `states` is an explicit nonempty subset of `active | draft | archived | superseded`, defaults to `[active]`, and is accepted only for explicit user inspection; automatic context callers cannot broaden it. Trusted assembly supplies ordered authorized scopes and pins one published commit per scope before index lookup. Actor, audience and revision selection are not model overrides. Exact history reads use the separately authorized notebook history operation.

The `unicode-simple-v1` tokenizer lowercases the exact query with the runtime's Unicode lowercase mapping, extracts every maximal `Letter` or `Number` sequence with `/[\p{L}\p{N}]+/gu`, deduplicates the resulting terms, and sorts them bytewise. The index uses the same tokenizer. Candidate gathering addresses every pinned id, every indexed Page with at least one posting for a query term; an unpinned zero-term page is not addressed and leaves no exclusion row. Retrieval performs no semantic search, graph expansion, all-page negative scan, or model call. For each unique query term, a page's term score adds the posting occurrence count plus 2 when that term occurs in the title. Candidates sort by pinned first, then descending term score, then bytewise ascending `knowledgePageId`; a pin does not otherwise change the score.

Before disposition, retrieval reads every addressed authoritative page at the pinned commit and recomputes the fields and digest used by the projection. A missing or unreadable page is `source_unavailable`, whether pinned or reached through a stale posting. Any other disagreement between authoritative bytes and an index row or posting returns `recovery_required` with zero selected result and no retrieval row; the operator may run the existing full rebuild, and no background repair state is created. Each coherent addressed candidate then receives exactly one first-match disposition in this order: a readable restricted sensitivity label is `sensitive_content`; invalid or below `scope-schema-valid` is `lower_conformance`; current authorization or policy denial is `policy_excluded`; state outside the requested filter, unresolved conflict, weak evidence or invalid publication lineage is `lower_conformance`; expired freshness is `freshness_expired`; an eligible candidate beyond `limit` is `budget_exceeded`; every remaining candidate is selected. Denied, restricted, missing, or unreadable candidates expose no content digest. S39 may deliver a smaller subset through its separately owned deterministic package-budget step and records only exclusions caused at that later boundary.

The existing JSONL trace becomes `{traceId,ownerScopes,notebookRevisions,caller,requestDigest,retrievalParameters,selected,excluded,createdAt}`. `notebookRevisions` binds one opaque commit to each ordered admitted scope. `traceId` is `krt_` plus a server UUID and must be unique in its owning trace ledger. `caller` remains `assistant | task-mode | app-api`; `requestDigest` hashes canonical `{ownerScopes,caller,request}`. Parameters contain normalized `{limit,pinnedConceptIds,states}`. Selected rows contain `{ownerScope,knowledgePageId,revision,contentDigest,score,sourceReferences}`; excluded rows contain the same identity tuple and reason, with digest null for denied/restricted/missing/unreadable content. Inaccessible scopes expose no private candidate identities. Query/matched terms never enter the trace, audit summary or public errors. Arrays follow the deterministic ranking above; cross-scope ties follow the scoped learning owner. The trace is immutable selection evidence, never a lifecycle or S39 delivery proof.

This pipeline and row are the one governed retrieval owner for product search, Knowledge Manager `answer`, Knowledge Manager `prepare-context-material`, and direct-Task Context Package selection. Callers may project different bounded responses but MUST NOT implement a parallel direct-read, substring-search, candidate-selection, filter, ranker, or trace. Retrieval never mutates knowledge. Its trace proves selection and audit facts only; `prepare-context-material` references that same trace, and only S39 may prove exact worker-Turn materialization and delivery. A future worker capability plane requires a separately accepted design and cannot add another retrieval owner.

### Knowledge operations

Product surfaces reach the Knowledge service through its existing transport-neutral operation catalog, App API, Core Client and bundled CLI, never raw Git/file access. Page read/list, Sources, observations/claims/conflicts, retrieval, schema/index inspection and report-only health remain with their current owners. Direct page edits, Agent maintenance, required Proposal decisions and history restoration all call the single notebook publisher. Merge/split/archive are ordinary multi-file edits, not additional executors. Worker-facing Knowledge capability routes remain outside the current accepted surface.

The scoped notebook resource exposes read/history/diff, update and restore under the existing User/Workspace/Server Knowledge route namespaces. Read/history/diff accept an exact admitted revision (current by default); history is paginated, initially 20 entries and at most 100, with an opaque commit cursor; diff accepts exact base/target commits and selected page IDs, returns at most 256 paths and 64 KiB text with explicit truncation indicators. Truncation must never be used to authorize an incomplete destructive confirmation. Update accepts the exact base and changed files defined by the notebook owner. Restore accepts `{baseRevision,fromRevision,pageIds,summary}` and computes the changes server-side. Mutations use existing request identity, current authorization, Policy, Audit and command receipts; no model can set the responsible actor or approval result. Missing revisions return typed not-found; inaccessible content returns the existing bounded denial without disclosing bodies or paths.

### Proposal decision, application, and restoration

`knowledge.proposal-decide` (`knowledge.proposal.decide` in the command ledger) retains accepted/rejected/deferred decisions. Canonical input fixes request ID, proposal ID, proposal digest, base/candidate commits and decision. The human actor comes from authentication. Rejected/deferred append only their decision. Accepted rechecks exact current base, candidate, sources, audience, latest conflicts, schema and required assessment under the shared scope fence, appends the fixed human decision, and invokes the same Git publisher. Required evidence precedes content publication; review, Git ref and SQLite receipt are not one transaction.

Completed identical commands replay their existing result; changed input returns `idempotency_key_conflict`. Stale base returns `conflict`; missing/contradictory partial evidence returns `recovery_required` without overwrite, inferred success or automatic continuation. The former same-request missing-page completion exception is retired at the coordinated Git cutover. An accepted Review alone is not publication; only the published ref activates the candidate. The new notebook owner defines exact pre/post-ref and crash outcomes.

Replace the unimplemented broadening of `knowledge.proposal-reverse` with ordinary history restoration. Restore selected paths from the proposal base into the current base, validate the full diff and require exact confirmation for removals; publish a new commit. This neither rewinds history nor undoes external effects. Current create-only reversal remains an implementation fact below until the direct cutover, not a second target contract.

### Knowledge Manager invocation boundary

`docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` exclusively owns the V1 Knowledge Manager operation and caller contract. This specification owns only the Knowledge Store effects those operations consume: validated reads through the single governed retrieval owner, that owner's selection trace, pending proposal writes or delegated notebook publication through their common owner, and report-only repair or health inspection. A preparation response may reference the S61 retrieval trace, but it does not create another trace or materialization owner. This specification does not authorize passive post-event calls, scheduled jobs, hidden hooks, a private Knowledge Manager lifecycle, or a missing Goal integration.

### Migration from the legacy memory projection

The `memory` vocabulary has been renamed directly, with no compatibility aliases, across protocol schemas, item projections, workspace routes, internal-agent mode names, and the workspace directory. Worker-facing Knowledge capability routes are outside the current accepted surface. The governed Knowledge Store migration maps existing minimal knowledge entries to pages with mapped types (`preference` and `project-context` to `KnowledgePage`, `task-summary` to `SourceSummary` or `KnowledgePage` by content), `review_state: user-authored` for user-created entries, and synthesized required fields validated against the initial workspace schema. Existing knowledge proposals migrate to governed knowledge proposals. The migration produces a validation report; entries that cannot be migrated cleanly become invalid drafts flagged for review.

## Contract / Expected Behavior

- The system MUST interpret OKF conformance exclusively against `docs/okf-spec-v0.2-snapshot.md`.
- Every authoritative Knowledge Page create, update, and accepted generated-proposal application MUST pass through the knowledge service and complete the four-stage validation pipeline before any authoritative page write; no other component may write into `knowledge/` or `sources/`.
- Invalid material MUST NOT enter active retrieval or default context package selection.
- The published Git tree of page bytes MUST remain the source of truth; every derived knowledge index MUST be rebuildable from them with identical retrieval results.
- One governed retrieval owner MUST serve product search, Knowledge Manager answer and preparation, and direct-Task context selection with deterministic results for identical inputs, index state, and policy state.
- Retrieval traces MUST preserve selected and excluded exact `ownerScope + knowledgePageId + revision + contentDigest` tuples plus reasons as selection and audit evidence, but MUST NOT claim worker delivery; only S39 may prove what exact Knowledge Page bytes reached a worker Turn.
- A required-review proposal MUST fix exact scope, base/candidate commit, sources, producer and decision. Ordinary delegated publication uses explicit current maintenance authority instead of manufacturing a human Review.
- Decision and application replay MUST be idempotent under one request id; any unverified partial decision/application returns `recovery_required` without inference, repeated effects, evidence deletion, or a recovery workflow.
- Missing completed command evidence after publication MUST return `recovery_required`; no missing-page continuation or automatic evidence repair is retained after cutover.
- Restoration MUST create a new validated revision and retain intervening content and decision history.
- Portable Workspace clone/remint export MUST exclude actionable Proposal and Review owners; accepted Knowledge Pages remain portable as ordinary authoritative pages, while complete data-root backup and restore preserve Proposal and Review files only under their unchanged Workspace identity.
- Knowledge pages MUST NOT contain secret values; the profile validator MUST reject secret-like fields per the vault boundary.
- Implicit cross-Workspace factual access MUST NOT occur through retrieval, indexes, traces or context packages. Explicit current-user Memory plus selected-Workspace retrieval is the audience-bounded exception defined by the scoped learning owner; it is not unrestricted union of Workspace notebooks.
- Published concept paths remain stable; reorganization uses title/index edits, new pages and archive/supersede without a generalized identity-history family.
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
- The current implementation satisfies the accepted V1 validation, proposal, review, page, audit, command-idempotency, and S39 delivery contracts through their existing owners. The one retrieval path does not yet read latest conflict-ledger authority and therefore cannot surface or exclude relevant unresolved conflicts as S60 requires; this keeps the specification Partial alongside the unimplemented scoped ownership, revision, replacement and bounded learning extension. Current implementation adds no revision or event family, recovery workflow, application record, second retrieval path, or second context-delivery owner. YAML comment/format-preserving round-tripping, binary source handling, derived representations beyond text metadata, external reference resolution beyond HTTP(S) syntax validation, SQLite FTS5 acceleration, structured patch proposals and worker-facing Knowledge capabilities remain deferred; Git notebook editing, history and delegated publication are accepted design but not implemented.

## Alternatives Considered

- Track live OKF upstream instead of pinning: rejected; upstream is a draft that can change conformance semantics under us, which is exactly the drift this spec exists to prevent.
- SQLite as source of truth with file export: rejected; contradicts the file-system-first storage principle and makes user inspection, git-friendly backup, and external editing second-class.
- Vector-first retrieval in v1: rejected; the v1 knowledge posture is retrieval and governance first, deterministic ranking is explainable and testable, and embeddings can be added later behind the same interface without contract changes.
- Compatibility aliases from `memory.*` to `knowledge.*`: rejected under the internal development rule; a direct rename with one migration is cheaper than maintaining dual vocabularies.

## Consequences

- OpenKit gains a fixed, testable definition of OKF compatibility and a conformance suite target.
- Knowledge remains portable: a workspace notebook is a valid OKF bundle that other tools can consume.
- One governed deterministic retrieval owner makes product, Knowledge Manager, and context selection reproducible and auditable, at the cost of lower recall than semantic search; that cost is accepted for V1.
- One Git history and publisher replace per-page counters and prior-page Source snapshots. Existing Sources remain immutable original evidence.
- Retired Workspace Memory aliases remain absent; User Memory is a deliberate product scope of the same implementation, not compatibility debt.

## Testing Strategy / Acceptance Criteria

Focused checks cover OKF/profile/schema and source validation, fixed-base multi-file publication, request replay, crash/partial evidence, exact review where required, history restoration, active-only default retrieval and rebuild equivalence. The notebook editing owner supplies the publication/confinement predicates; this owner supplies identical tokenizer/scorer/trace results across product, Knowledge Manager and S39 selection. Scope and pinned commit/digest must survive every consumer. S39 alone proves worker delivery, and S18 retains its one real reviewed-learning composition without imposing that review path on all edits. Current create-only tests change with the coordinated cutover; no dual writer or second retrieval path remains.

## Risks & Mitigations

- Risk: the pinned OKF draft diverges far from ecosystem adoption. Mitigation: the snapshot pattern makes re-pinning a small deliberate change; conformance logic is isolated in one module.
- Risk: deterministic retrieval misses relevant material. Mitigation: pins, explicit references, and agent hints give users and coordinators direct control; recall gaps become observations feeding v2.
- Risk: validation strictness frustrates rough-note capture. Mitigation: invalid drafts preserve material without blocking users; only active retrieval is gated.
- Risk: FTS quality varies across languages. Mitigation: tokenizer choice is isolated behind the index layer; see Resolved Decisions.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: mixed-language and CJK search uses the portable JSON term index for deterministic first-release retrieval, while SQLite FTS5 trigram indexing remains a deferred accelerator behind the same retrieval owner; first-slice ingest ships explicit text material registration and deterministic projection for governed pages, while richer plain-text, Markdown, code, transcript, PDF, and media extraction arrives through capability-mediated worker or Knowledge Manager proposal tasks; all admitted page edits publish through the fixed-base notebook contract, including multi-page organization and exact required human decisions.

## Deferred / Future Work

- Vector and graph retrieval accelerators behind the retrieval interface.
- SQLite FTS5 trigram indexing behind the retrieval interface when retrieval volume or CJK quality justifies the extra storage and indexing dependency.
- YAML comment/format-preserving round-tripping and external notebook editor writeback.
- Binary source capture, conversion, and derived representation pipelines beyond V1 text material registration.
- Unattended triggers beyond the accepted opted-in personal capture boundary.
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
