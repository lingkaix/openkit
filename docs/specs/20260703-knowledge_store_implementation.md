# Knowledge Store Implementation Contract

Status: Accepted
Implementation: Partial

## Owns

- The pinned OKF version decision and the conformance relationship between OpenKit and the OKF snapshot.
- Concrete file layout, record encodings, and identifier rules for knowledge pages, sources, derived representations, observations, claims, proposals, reviews, and indexes.
- The validation pipeline: parser, OpenKit Knowledge Profile validator, workspace schema validator, conformance computation, and save-path enforcement mechanics.
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
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`

## Summary

This spec turns the accepted Knowledge Store governance rules into an implementable contract. It pins the portable envelope to OKF v0.1 via a repository snapshot, defines the workspace file layout and record encodings, specifies validation before authoritative page writes, defines one deterministic governed retrieval owner for current knowledge-reading surfaces, fixes source-linked create-only proposal application and bounded reversal through existing owners, names the product operation families, defines the store-side effects consumed by Knowledge Manager and S39, and specifies the direct migration from the current minimal knowledge slice.

The design principle is file-system-first with one deterministic rebuildable index projection: governed Markdown page files are authoritative, V1 uses the portable JSON indexes under `indexes/`, and no SQLite, vector, graph, or other accelerator may become a second source of truth or a second retrieval owner.

## Goals / Non-goals

Goals:

- Make the Knowledge Store buildable without further design decisions for the v1 retrieval-first scope.
- Pin OKF conformance to a fixed snapshot so external drift cannot silently change OpenKit validity rules.
- Keep every governed record inspectable and portable as plain files.
- Make retrieval deterministic, explainable, and traceable in v1.
- Remove the `memory` naming debt in one direct migration.

Non-goals:

- No knowledge synthesis, preference inference, or v2 knowledge-driven improvement behavior.
- No mandatory vector search, graph database, or embedding infrastructure in v1.
- No domain-specific workspace schemas as part of the core contract.
- No notebook UI component design.

## Background

`docs/specs/20260702-knowledge_store_governance_rules.md` defines the layered contract (OKF-compatible files, OpenKit Knowledge Profile, Workspace Schema), conformance levels, required fields, save-time enforcement rules, observation and claim governance, proposal rules, and Knowledge Manager responsibilities. It deliberately does not define file layouts, encodings, pipelines, or operation names. This spec closes that gap. The product vision fixes the v1 posture as retrieval-first: knowledge selection over knowledge generation, history first, explicit knowledge over speculative knowledge.

## Decision

### OKF version pinning

OpenKit targets OKF version 0.1 exactly as captured in `docs/okf-spec-v0.1-snapshot.md`. All OpenKit statements about OKF compatibility, bundle conformance, reserved filenames, frontmatter shape, linking, index files, and log files MUST be interpreted against that snapshot, never against the live upstream document. Adopting a newer OKF revision requires a new dated snapshot plus an update to this spec; until then, upstream changes have no effect on OpenKit behavior. Workspace knowledge bundles MUST declare `okf_version: "0.1"` in the bundle-root `index.md` frontmatter block, the only place the snapshot permits index frontmatter.

The `OKF-compatible` conformance level from the governance spec is defined operationally as passing the snapshot's §9 conformance rules: parseable YAML frontmatter in every non-reserved `.md` file, a non-empty `type` field, and reserved-filename structure when `index.md` or `log.md` are present. The permissive consumption rules in §9 apply to import; they do not weaken OpenKit save-time enforcement for governed records.

### File layout and identifiers

The workspace knowledge tree follows the workspace scope layout in the storage spec:

```text
<workspace>/
  knowledge/
    schema/
      workspace-schema.yaml
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

A V1 `knowledgePageId` is 1 to 240 UTF-8 bytes of forward-slash-separated lowercase ASCII segments, each matching `[a-z0-9][a-z0-9._-]{0,63}`; empty segments, `.` or `..`, root ids `index` and `log`, a trailing `.md`, backslash, absolute paths, control characters, NUL, and `@` are invalid. Lowercase-only identity prevents case-folding collisions on portable default file systems while reserving the OKF bundle's root `index.md` and `log.md`. Before proposal persistence and every page read or write, NanoCore joins `<knowledgePageId>.md` beneath the canonical `knowledge/pages/` root, rejects any existing symlink or non-directory parent, rejects a symlink target, and verifies that the normalized target remains inside that root. Renaming or moving a page changes its id and is not a V1 mutation operation; a future design must define reference repair before such an operation is authorized.

`sources/` is a sibling record family, not a subdirectory of `knowledge/`, even though the Knowledge Store conceptually governs sources and derived representations: the evidence layer is consumed by context packages, evidence bundles, audit traces, and artifacts as well as by knowledge pages, and it has different size, immutability, backup, and retention characteristics than the notebook. Physical layout follows record family and lifecycle; conceptual ownership stays with `docs/core/knowledge.md`.

Knowledge pages are OKF concept documents whose frontmatter carries the OpenKit required fields from the governance spec (`type`, `title`, `schema_version`, `status`, `scope`, `source_refs`, `review_state`, `sensitivity`, `freshness`, `created_at`, `updated_at`) as producer-defined extension keys, which the pinned snapshot explicitly permits. OKF `description`, `tags`, `resource`, and `timestamp` remain available with snapshot semantics; `updated_at` is authoritative for OpenKit freshness computation even when `timestamp` is present.

The workspace schema is a YAML file at `knowledge/schema/workspace-schema.yaml` with `schema_version`, owner metadata, active status, timestamps, allowed types, field constraints, source-reference shape, proposal rules, review requirements, and lint rules per the governance spec. Previous schema versions and migration reports are preserved under `knowledge/schema/history/`.

Proposals are Markdown files whose frontmatter contains exactly the proposal metadata fields `type: proposal`, `operation: create`, `knowledge_page_id`, `content_digest`, `source_references`, `rationale`, `confidence`, `review_required: true`, `producer`, and `created_at`. The file name `proposalId` is deterministically `kp_` plus the 64 lowercase hexadecimal SHA-256 digest of canonical JSON `{ workspaceId, requestId }` for the existing draft command; this safe owner id lets retry locate a proposal written before its receipt without persisting another request field or record. `producer` is the server-owned authenticated C10 `ActorRef`, not client attribution; `confidence` is a number from 0 through 1; `created_at` is an RFC 3339 timestamp; and the remaining identities use the exact rules below. The byte sequence immediately after the proposal frontmatter's closing delimiter and newline is the complete target Knowledge Page file, including its own frontmatter. These exact schema-valid UTF-8 bytes are the canonical page bytes; `contentDigest` is SHA-256 over that sequence with no newline, YAML-key-order, Unicode, or other implicit normalization. V1 generated-proposal application is create-only: the proposal fixes one absent `knowledgePageId`, its complete canonical bytes, and their exact digest before review. The candidate page itself MUST resolve in the proposal's Workspace, carry `type: KnowledgePage`, `status: active`, and `review_state: accepted`, and carry `source_refs` exactly equal to the proposal's normalized closed `sourceReferences` array. Candidate `freshness`, `sensitivity`, and `scope` are the exact values inside these digested bytes. `generatedFromCompletedWorkHistory` is a deterministic projection that is true exactly when the normalized references contain a matching terminal `turn`, its final completed `assistant-message`, and its accepted S39 `context-package`; it is false otherwise and is not a duplicate proposal field. Candidate changes require a new proposal; review input cannot substitute response-only content.

The V1 generated-proposal `sourceReferences` field is one bytewise-sorted, duplicate-free array of strings with this closed grammar:

- `source:<sourceId>@<contentDigest>` names one registered Knowledge Source and its exact captured content digest.
- `knowledge:<knowledgePageId>@<contentDigest>` names one existing Knowledge Page and its exact canonical-byte digest.
- `turn:<turnId>` names one terminal same-Workspace worker Turn.
- `item:<itemId>` names one completed immutable Item owned by a cited Turn.
- `context-package:<turnId>@<contextPackageDigest>` names that Turn's exact accepted S39 trace and package digest.

The `@` separator is forbidden inside ids. A registered `sourceId` is server-generated as `ks_` plus one lowercase canonical UUID and MUST satisfy the same single safe path-segment and symlink-containment checks at registry, material, derived, read, and import boundaries. `contentDigest` is `sha256:` plus 64 lowercase hexadecimal digits, and `contextPackageDigest` uses S39's exact digest format. A generated proposal that claims completed worker output MUST contain one matching terminal direct-Task `turn`, the final completed `assistant-message` Item projected by that Turn, and that Turn's `context-package` reference; citing its `user-message` request Item or another completed Item does not prove worker output. The three owners must agree on Workspace, Thread, Turn, terminality, and delivery lineage. Bare ids, external URLs, nonterminal work, current-page substitution, and unsupported reference prefixes fail validation and create no proposal. This closed proposal-evidence vocabulary does not replace Knowledge Page `source_refs`, create a generic record-reference abstraction, or authorize new source records. Evidence outside this V1 set must first be captured through the existing registered Knowledge Source owner.

`knowledge/reviews/<proposalId>.json` is one canonical JSON object `{ proposalId, workspaceId, decisions }`. `decisions` is an append-only ordered array of exact rows `{ reviewId, requestId, decision, actor, proposalDigest, knowledgePageId, contentDigest, targetAbsentAtDecision, decidedAt }`, where `reviewId` is deterministically `kr_` plus the 64 lowercase hexadecimal SHA-256 digest of canonical JSON `{ workspaceId, proposalId, requestId }`, `decision` is `deferred`, `accepted`, or `rejected`, `proposalDigest` is `sha256:` over the exact proposal-file bytes, and `targetAbsentAtDecision` is `true` only for an accepted row after the safe target path and absence check and is `null` otherwise. The deterministic id uniquely resolves one decision row for replay and reversal without a new owner. An update atomically replaces the JSON file with its prior exact rows plus one row; it never removes or rewrites a row. Deferred rows leave the proposal reviewable; accepted and rejected rows are terminal, exactly one terminal row is allowed, and changed input under one request id conflicts. There is no combined edit-and-accept operation.

Observations are JSONL ledger rows per the governance spec, one file per month, excluded from the OKF bundle and from notebook views. Source registry records are JSON files carrying the source identity fields from the governance spec; captured first-slice text material lives under `sources/materials/<sourceId>/content.txt`; derived representations live under `sources/derived/<sourceId>/` with lineage back to the exact source id and content digest.

Proposal application and reversal add no record family. The existing Knowledge Proposal, append-only Knowledge Review, authoritative Knowledge Page, and audit owners preserve fixed page id, bytes, digest, sources, decision, actor, and effect lineage; the command-idempotency owner supplies only request identity, input hash, standard resource identifiers, and replay boundary. No application record, revision or event family, rollback record, recovery ledger, or second workflow is authorized.

### Upload intake and source registration

User uploads through product surfaces are work-history records, not sources by default. The bytes land under the originating turn at `threads/<threadId>/turns/<turnId>/inputs/`, and the item log records file id, filename, content digest, size, and sensitivity hint; their lifecycle follows thread history and its retention classes.

An upload becomes a Knowledge Source only through explicit registration, which copies the bytes into the source store and creates one `sources/registry/` record carrying the originating Workspace, Thread, Turn, file id, and content digest. Registration is a copy, not a move: later thread compaction or deletion must not create holes in the evidence layer, and source immutability must not depend on thread records.

Registration has exactly one V1 entry point: an explicit authorized user action completed before proposal drafting. Proposal review and application never register source material. Automatic or proposal-driven registration remains deferred; nothing registers silently by default, per the retrieval-first posture.

The consumption boundary is: knowledge pages, claims, and source summaries MUST cite registered `sourceId`s and MUST NOT reference raw thread attachments; context packages MAY carry unregistered uploads as work-history material for the turn that owns them, and re-using a prior upload as a later work input is a work-history reference by file id and digest that requires no knowledge governance. Content-addressed deduplication of upload and source bytes is a deferred optimization that must not change these record semantics.

### Validation pipeline

A dedicated implementation module owns four stages, in order: OKF parse (frontmatter and body split, YAML parse, reserved-filename structure), profile validation (OpenKit required fields, base types, forbidden secret-like fields, source-reference shape), workspace schema validation (allowed types, field constraints, review rules), and conformance computation (`OKF-compatible`, `OpenKit-profile-valid`, `Workspace-schema-valid`).

All writes to governed records MUST pass through NanoCore's knowledge service; nothing else writes into `knowledge/` or `sources/`. For every create, direct edit, and accepted generated-proposal application, NanoCore MUST run all four stages against the candidate bytes and current schema before it writes, replaces, renames, or removes any authoritative Knowledge Page. A failed validation returns the bounded structured validation result with zero authoritative page, proposal-application, or derived-index mutation.

Imports, rough notes, and Knowledge Manager drafts MAY be saved only through an explicitly addressed draft path with `status: draft` and `review_state: needs-review`, with the validation report persisted through the existing maintenance owner. An invalid draft MUST NOT replace a valid active page, and post-write index exclusion is not a substitute for save-time enforcement.

Validation is deterministic and versioned: a validation result records the schema version, profile version, and OKF snapshot identity it was computed against, so conformance can be recomputed and explained after schema migrations.

### Indexes

The portable JSON projection under `indexes/` holds derived, rebuildable index records: a page index (Knowledge Page id, exact content digest, type, status, scope, review state, sensitivity, freshness, timestamps, conformance level), a full-text term index over titles, descriptions, tags, and body text, a link graph (directed edges from markdown links per snapshot §5.3), a source-reference index, and a validation report index. A full index rebuild from authoritative files MUST be possible with one command and MUST produce identical retrieval behavior; index corruption is repaired by rebuild, never by hand-editing index rows. SQLite FTS5, embeddings, and vector or graph search are optional accelerators behind the same owner and are out of V1 scope.

### Retrieval pipeline

The V1 request is exactly the existing schema `{ query, limit, pinnedConceptIds }`: `query` is a non-empty string, `limit` is 1 through 20 with default 5, and `pinnedConceptIds` is normalized to a bytewise-sorted duplicate-free array. Current authorization and policy context are server-owned inputs, not request fields. There is no separate explicit-page-id field.

The `unicode-simple-v1` tokenizer lowercases the exact query with the runtime's Unicode lowercase mapping, extracts every maximal `Letter` or `Number` sequence with `/[\p{L}\p{N}]+/gu`, deduplicates the resulting terms, and sorts them bytewise. The index uses the same tokenizer. Candidate gathering addresses every pinned id plus every page with at least one posting for a query term; an unpinned zero-term page is not addressed and leaves no exclusion row. Retrieval performs no semantic search, graph expansion, all-page negative scan, or model call. For each unique query term, a page's term score adds the posting occurrence count plus 2 when that term occurs in the title. Candidates sort by pinned first, then descending term score, then bytewise ascending `knowledgePageId`; a pin does not otherwise change the score.

Before disposition, retrieval rereads every addressed authoritative page and recomputes the fields and digest used by the projection. A missing or unreadable page is `source_unavailable`, whether pinned or reached through a stale posting. Any other disagreement between authoritative bytes and an index row or posting returns `recovery_required` with zero selected result and no retrieval row; the operator may run the existing full rebuild, and no background repair state is created. Each coherent addressed candidate then receives exactly one first-match disposition in this order: a readable restricted sensitivity label is `sensitive_content`; invalid or below `Workspace-schema-valid` is `lower_conformance`; current authorization or policy denial is `policy_excluded`; unresolved conflict, weak evidence, or non-accepted review state is `lower_conformance`; expired freshness is `freshness_expired`; an eligible candidate beyond `limit` is `budget_exceeded`; every remaining candidate is selected. Denied, restricted, missing, or unreadable candidates expose no content digest. S39 may deliver a smaller subset through its separately owned deterministic package-budget step and records only exclusions caused at that later boundary.

The existing JSONL retrieval row is exactly `{ traceId, workspaceId, caller, requestDigest, retrievalParameters, selected, excluded, createdAt }`. `traceId` is a server-generated `krt_` prefix plus one lowercase canonical UUID and MUST resolve to exactly one row within the Workspace; a duplicate id is rejected before append. `caller` is `assistant`, `task-mode`, or `app-api`; `requestDigest` is `sha256:` over canonical JSON of `{ workspaceId, caller, request }`; and `retrievalParameters` is exactly `{ limit, pinnedConceptIds }` from the normalized request. Each `selected` entry is exactly `{ knowledgePageId, contentDigest, score, sourceReferences }`. Each `excluded` entry is exactly `{ knowledgePageId, contentDigest, reason }`, with `contentDigest=null` for denied, restricted, missing, or unreadable material. Arrays retain the candidate order above. Ranking may use the raw query and matched terms in memory, but neither the query nor its matched terms enter this portable row, audit summaries, or public errors. The exact selected/excluded page identities and digests are sufficient evidence for this bounded selection; no unused index-snapshot digest is persisted. The row has no mutable status or lifecycle.

This pipeline and row are the one governed retrieval owner for product search, Knowledge Manager `answer`, Knowledge Manager `prepare-context-material`, and direct-Task Context Package selection. Callers may project different bounded responses but MUST NOT implement a parallel direct-read, substring-search, candidate-selection, filter, ranker, or trace. Retrieval never mutates knowledge. Its trace proves selection and audit facts only; `prepare-context-material` references that same trace, and only S39 may prove exact worker-Turn materialization and delivery. A future worker capability plane requires a separately accepted design and cannot add another retrieval owner.

### Knowledge operations

Product surfaces reach knowledge through NanoCore-owned operations, not raw file access. The V1 operation families are page read and list; direct page create, update, and bounded delete; proposal draft, review decision, and proposal-created-page reversal; source register and read; observation, claim, and conflict maintenance; deterministic retrieval; schema and index inspection; and explicit report-only health and repair suggestions. Accepted claims may guide an authorized ordinary proposal draft through their already-valid source references, but V1 has no separate claim-promotion proposal producer. Worker-facing `knowledge.*` operations and worker-control proposal-summary ingestion remain disabled and create no current route or test obligation.

Direct page create, update, and delete remain the existing authorized human commands. Create and update MUST run the four-stage validator before mutation and write `review_state: user-authored`, so changed proposal-accepted bytes never preserve their earlier accepted-review label. Direct delete remains manual Knowledge governance and MUST NOT be projected as the proposal-reversal result below. G07 adds no direct-mutation CAS field, actor-scoped ledger key, exact Audit encoding, revision, event, tombstone, or history family; the existing command and Audit posture remains unchanged.

### Proposal decision, application, and reversal

Every V1 generated proposal eligible for application is create-only and MUST preserve one absent target `knowledgePageId`, the exact canonical page bytes, their exact `contentDigest`, and the exact verified source references in the existing Knowledge Proposal owner. The proposal response is not lineage authority, and an unpersisted source reference, caller-supplied current page, recomputed replacement, or different byte string cannot substitute for the fixed proposal content.

The existing transport-neutral `knowledge.proposal-decide` operation, whose internal command-ledger name is `knowledge.proposal.decide`, owns both the human decision and any authorized create application. Its request id is the idempotency key, its actor is assigned from current authentication, and its canonical input includes the proposal id, `accepted`, `rejected`, or `deferred` decision, and the proposal's fixed page id, digest, and source references. Rejected and deferred decisions append only their review row. Accepted MUST re-read and verify the pending proposal, exact proposal digest, source references, authorization, safe target absence, canonical bytes, and digest, run the four-stage validator, then append the accepted review row with `targetAbsentAtDecision=true` before the page write. A target page present before this authorized effect returns `409 conflict` with zero mutation.

The review and page are separate existing file writes. The exact proposal, accepted human review, fixed page and digest, sources, producer, reviewer, and Workspace form the business activation tuple. Success is acknowledged only after that tuple verifies and the existing Audit and command receipt preserve the decision request and command result. The standard command receipt stores only its normal input hash and response resource kind/id; a completed receipt with identical canonical input replays the current owner projection. Changed input returns `409 idempotency_key_conflict`, and a competing or post-terminal decision returns `409 conflict` without mutation.

An accepted review is not proof of application by itself. If its exact row is durable, `targetAbsentAtDecision=true`, the fixed target is still absent, and the same request's proposal, review, actor, source, authorization, validation, bytes, and digest all match, that same command may complete the one missing page write and then persist Audit and receipt. Once the complete business activation tuple exists, the exact page is active even when Audit or receipt completion was interrupted; the command still returns `409 recovery_required` and MUST NOT claim or reconstruct success. A different target or any missing or contradictory business authority also returns `409 recovery_required`. A dependency failure proven before every decision and page effect returns the existing typed redacted failure with zero mutation. No branch creates a rollback, repair, settlement, retry, background, or recovery workflow.

`knowledge.proposal-reverse` is the one bounded reversal command. Its request is exactly `{ requestId, proposalId, reviewId, knowledgePageId, expectedContentDigest }`; the authenticated actor and Workspace come from the route, not the body. The named accepted review and proposal must own the same page and digest. The command may remove only that proposal-created page while its current canonical bytes still match `expectedContentDigest`, then write the existing audit and standard command receipt. A completed receipt names the proposal resource and replays the reversal projection from proposal, review, audit, and page absence; it stores no reversal body or state. Changed input conflicts, changed page bytes return `409 conflict`, and a missing page without the receipt or any contradictory authority returns `409 recovery_required`. The original proposal, review, decision request, command, source, and audit evidence remain durable. Reversal creates no Knowledge revision, event, tombstone, replacement page, new proposal, rollback record, or workflow and never claims to reverse external effects caused by prior use.

The public failure boundary is closed: malformed proposal or candidate input and failed pre-write validation return `400 invalid_request` with bounded structured details; a missing proposal discovered before any effect returns `404 not_found`; a pre-existing target or changed reversal target returns `409 conflict`; changed input under one request id returns `409 idempotency_key_conflict`; and partial or contradictory review, page, command, or reversal authority returns `409 recovery_required`. Caught exception text, stack traces, local paths, source bytes, credentials, and secret-like values MUST NOT enter public errors.

### Knowledge Manager invocation boundary

`docs/specs/20260704-knowledge_manager_internal_agent_runtime.md` exclusively owns the V1 Knowledge Manager operation and caller contract. This specification owns only the Knowledge Store effects those operations consume: validated reads through the single governed retrieval owner, that owner's selection trace, pending proposal writes through the proposal owner, and report-only repair or health inspection. A preparation response may reference the S61 retrieval trace, but it does not create another trace or materialization owner. This specification does not authorize passive post-event calls, scheduled jobs, hidden hooks, a private Knowledge Manager lifecycle, or a missing Goal integration.

### Migration from the legacy memory projection

The `memory` vocabulary has been renamed directly, with no compatibility aliases, across protocol schemas, item projections, workspace routes, internal-agent mode names, and the workspace directory. Worker-facing Knowledge capability routes are outside the current accepted surface. The governed Knowledge Store migration maps existing minimal knowledge entries to pages with mapped types (`preference` and `project-context` to `KnowledgePage`, `task-summary` to `SourceSummary` or `KnowledgePage` by content), `review_state: user-authored` for user-created entries, and synthesized required fields validated against the initial workspace schema. Existing knowledge proposals migrate to governed knowledge proposals. The migration produces a validation report; entries that cannot be migrated cleanly become invalid drafts flagged for review.

## Contract / Expected Behavior

- The system MUST interpret OKF conformance exclusively against `docs/okf-spec-v0.1-snapshot.md`.
- Every authoritative Knowledge Page create, update, and accepted generated-proposal application MUST pass through the knowledge service and complete the four-stage validation pipeline before any authoritative page write; no other component may write into `knowledge/` or `sources/`.
- Invalid material MUST NOT enter active retrieval or default context package selection.
- Authoritative page files MUST remain the source of truth; every derived knowledge index MUST be rebuildable from them with identical retrieval results.
- One governed retrieval owner MUST serve product search, Knowledge Manager answer and preparation, and direct-Task context selection with deterministic results for identical inputs, index state, and policy state.
- Retrieval traces MUST preserve selected and excluded exact `knowledgePageId + contentDigest` pairs plus reasons as selection and audit evidence, but MUST NOT claim worker delivery; only S39 may prove what exact Knowledge Page bytes reached a worker Turn.
- A V1 generated proposal MUST be create-only and MUST fix one absent target Knowledge Page id, exact canonical bytes and digest, verified sources, producer, and accepting human review through the existing proposal, review, and page owners; Audit and idempotency owners separately prove command success and replay.
- Decision and application replay MUST be idempotent under one request id; any unverified partial decision/application returns `recovery_required` without inference, repeated effects, evidence deletion, or a recovery workflow.
- The same authorized accepted command MAY complete its one missing deterministic page write after the review file is durable; no other repair or background completion is allowed.
- Bounded reversal MUST remove only the unchanged proposal-created page and retain the original proposal, review, command, source, and audit evidence.
- Knowledge pages MUST NOT contain secret values; the profile validator MUST reject secret-like fields per the vault boundary.
- Cross-workspace knowledge access MUST NOT occur through retrieval, indexes, traces, or context packages.
- Concept renames and moves are not V1 mutation operations; no page-event or generalized identity-history family is authorized.
- Migration MUST be one-way and complete: after migration, no legacy `memory`-named route, schema, directory, or capability remains.

## Current Implementation Projection

The removed `@openkit/mcp` facade must not be restored through compatibility or replacement work. The current Knowledge interface is the transport-neutral operation catalog exposed through the unified `openkit` Skill and its bundled CLI.

- `packages/protocol` exposes minimal `KnowledgeEntry` schemas, workspace knowledge request/response schemas, and `knowledge-injection` item projections.
- `apps/nanocore/src/app.ts` exposes `/api/workspaces/:workspaceId/knowledge` routes and `/api/app/workspaces/:workspaceId/knowledge/proposals/:proposalId/decision`. The proposal decision route currently executes first-slice accept, edit, reject, and defer decisions, but G07 deletes the edit branch because changed candidate bytes require a new proposal. Accepted page application is limited to the claim-derived first slice and does not yet preserve the frozen proposal's exact target page id, bytes, digest, source lineage, or fail-closed two-file completion contract. NanoCore exposes no `/api/worker-capabilities/knowledge/*` routes, and G07 does not add them.
- `apps/nanocore/src/app.ts` also exposes explicit Knowledge Source identity registration and read surfaces through `/api/app/workspaces/:workspaceId/knowledge/sources` and `/api/app/workspaces/:workspaceId/knowledge/sources/:sourceId`. Registration computes a `sha256:` digest, stores the product-safe source identity record, and copies submitted first-slice text material into `sources/materials/<sourceId>/content.txt`; the API response never returns the submitted content.
- `apps/nanocore/src/storage/fs-layout.ts` creates `knowledge/` and `sources/`.
- `apps/nanocore/src/lib/store.ts` projects current app-local `KnowledgeEntry` records into minimal OKF Markdown pages under `knowledge/pages/<knowledgeEntryId>.md`, writes the default workspace schema at `knowledge/schema/workspace-schema.yaml`, uses the `KnowledgePage` base type, and keeps the app-local kind in the `openkit_entry_kind` extension. The current page save writes or overwrites the authoritative projection before the four-stage validator used by index rebuild, so save-time prevalidation remains incomplete. The store also projects current app-local `KnowledgeProposalRecord` summaries under `knowledge/proposals/<proposalId>.md`, records app-local knowledge proposal review decisions under `knowledge/reviews/<proposalId>.json`, stores first-slice source identity records under `sources/registry/<sourceId>.json`, stores registered text material under `sources/materials/<sourceId>/content.txt`, and writes first-slice text derived representation metadata under `sources/derived/<sourceId>/text.json` with lineage back to the source content digest.
- `@openkit/app-api-schemas`, `@openkit/core-client`, and NanoCore OpenAPI expose the same Knowledge Source registration, list, and read surface through `client.app.registerKnowledgeSource`, `client.app.listKnowledgeSources`, and `client.app.readKnowledgeSource`; the unified `openkit` Skill projects those contracts through the `knowledge.source-register`, `knowledge.source-list`, and `knowledge.source-read` bundled-CLI operations. Register and read responses include derived representation metadata without returning captured source content.
- `apps/nanocore/src/knowledge/okf.ts` owns the first-slice OKF document parser, OpenKit Knowledge Profile validator, default workspace schema parser, workspace schema validator, conformance report metadata, secret-like field rejection, and active-page predicate. `apps/nanocore/src/storage/index-rebuild.ts` now uses that module when reading file-backed pages, skips OKF reserved files, reads the workspace schema file when present, reads registered source ids from `sources/registry/`, reads file-backed knowledge ids, validates external source references as HTTP(S) URLs, and keeps pages out of the derived search index unless they are active `Workspace-schema-valid` records whose local `source:<sourceId>` and `knowledge:<knowledgeEntryId>` references resolve and whose external references pass the syntax gate. The same rebuild pass writes `indexes/knowledge-links.json`, a first-slice directed Markdown concept-link graph for active valid pages with broken local links recorded as unresolved edges and external URLs excluded from the concept graph, `indexes/knowledge-validation.json`, a first-slice per-page validation report that records conformance, active/indexed state, profile/schema errors, and local or external reference errors, `indexes/knowledge-source-refs.json`, a first-slice source-reference index that classifies page references as registered sources, workspace knowledge references, or external references with local resolution or external syntax status, and `indexes/knowledge-fts.json`, a first-slice rebuildable full-text term index for active valid knowledge page titles and bodies. NanoCore exposes those derived knowledge indexes through `GET /api/app/workspaces/:workspaceId/knowledge/indexes`; `@openkit/core-client` exposes `client.app.readKnowledgeIndexes`, and the unified `openkit` Skill projects it as `knowledge.indexes` through the bundled CLI. NanoCore also exposes deterministic first-slice retrieval through `POST /api/app/workspaces/:workspaceId/knowledge/retrievals`, which ranks active valid pages from `knowledge-fts.json`, supports bounded selection plus pinned concepts, returns selected and excluded candidates with reasons, and appends the same trace to `knowledge/traces/<YYYYMM>.jsonl`; `@openkit/core-client` exposes `client.app.retrieveKnowledge`, and the bundled CLI projects it as `knowledge.retrieve`.
- Knowledge Manager `answer` and context preparation currently use a separate minimal substring-search path instead of delegating to the governed retrieval implementation above, so the one-owner retrieval contract is not implemented.
- `apps/nanocore/src/lib/store.ts` appends first-slice observation records to monthly workspace JSONL ledgers under `knowledge/observations/<YYYYMM>.jsonl` and reads them back as maintenance records. NanoCore exposes append/list routes through `/api/app/workspaces/:workspaceId/knowledge/observations`; `@openkit/core-client` exposes `client.app.recordKnowledgeObservation` and `client.app.listKnowledgeObservations`, and the bundled CLI projects them as `knowledge.observation-record` and `knowledge.observation-list`.
- `apps/nanocore/src/lib/store.ts` appends first-slice claim records to monthly workspace JSONL ledgers under `knowledge/claims/<YYYYMM>.jsonl` and reads them back as maintenance records. NanoCore exposes append/list routes through `/api/app/workspaces/:workspaceId/knowledge/claims`; `@openkit/core-client` exposes `client.app.recordKnowledgeClaim` and `client.app.listKnowledgeClaims`, and the bundled CLI projects them as `knowledge.claim-record` and `knowledge.claim-list`. The current `knowledge.claim-promote` route and the worker-control `knowledge_proposal_summary` route are duplicate proposal producers that do not freeze the authoritative target page id, bytes, digest, source lineage, server-owned producer, or reversal tuple. G07 deletes both surfaces and their projections without aliases; an accepted Claim may instead guide an ordinary authorized `knowledge.proposal-draft` request through its existing valid source references.
- `apps/nanocore/src/lib/store.ts` appends first-slice conflict records and conflict resolution updates to monthly workspace JSONL ledgers under `knowledge/conflicts/<YYYYMM>.jsonl`, keeps append history, and reads back the latest row per conflict id as the maintenance record. NanoCore exposes append/list/resolve routes through `/api/app/workspaces/:workspaceId/knowledge/conflicts` and `/api/app/workspaces/:workspaceId/knowledge/conflicts/:conflictId/resolution`; `@openkit/core-client` exposes `client.app.recordKnowledgeConflict`, `client.app.listKnowledgeConflicts`, and `client.app.resolveKnowledgeConflict`, and the bundled CLI projects them as `knowledge.conflict-record`, `knowledge.conflict-list`, and `knowledge.conflict-resolve`.
- `POST /api/app/workspaces/:workspaceId/knowledge/manager/context` currently persists a second standalone Knowledge selection trace and exposes readback and materialization endpoints through Core Client and the unified Skill. Those duplicate projections are implementation drift: G07 deletes them and makes context preparation reference the existing governed retrieval trace instead. They MUST NOT be retained as a compatibility path or promoted into delivery proof; only S39 owns worker-Turn materialization and delivery.
- The current Knowledge Manager implementation consists of direct deterministic operations exposed through governed App API routes for answer, context preparation, proposal draft, repair suggestion, and health inspection, including the context-package surface above; it is not a generic internal-agent mode, Quick Chat tool allowlist, or separate Core tool executor.
- The current implementation remains Partial because authoritative pages are not always validated before write, Knowledge Manager reads do not reuse the governed retrieval owner, proposals do not freeze exact target page identity and bytes, two-file decision/application replay lacks the frozen completion and `recovery_required` semantics, unchanged-page reversal is absent, and the duplicate standalone context trace and materialization path remain. Closing those gaps MUST reuse the current knowledge service, proposal, review, page, audit, command-idempotency, retrieval, and S39 owners; it MUST NOT add a revision or event family, recovery workflow, application record, second retrieval path, or second context-delivery owner. Richer YAML round-tripping, binary source handling, derived representations beyond text metadata, external reference resolution beyond HTTP(S) syntax validation, SQLite FTS5 acceleration, generated update application, structured patch proposals, and worker-facing Knowledge capabilities remain deferred.

## Alternatives Considered

- Track live OKF upstream instead of pinning: rejected; upstream is a draft that can change conformance semantics under us, which is exactly the drift this spec exists to prevent.
- SQLite as source of truth with file export: rejected; contradicts the file-system-first storage principle and makes user inspection, git-friendly backup, and external editing second-class.
- Vector-first retrieval in v1: rejected; the v1 knowledge posture is retrieval and governance first, deterministic ranking is explainable and testable, and embeddings can be added later behind the same interface without contract changes.
- Compatibility aliases from `memory.*` to `knowledge.*`: rejected under the internal development rule; a direct rename with one migration is cheaper than maintaining dual vocabularies.

## Consequences

- OpenKit gains a fixed, testable definition of OKF compatibility and a conformance suite target.
- Knowledge remains portable: a workspace notebook is a valid OKF bundle that other tools can consume.
- One governed deterministic retrieval owner makes product, Knowledge Manager, and context selection reproducible and auditable, at the cost of lower recall than semantic search; that cost is accepted for V1.
- Create-only generated-proposal application and unchanged-page reversal remain source-linked and fail closed without a revision, event, application, or recovery record family.
- One coordinated rename removes the `memory` debt across protocol, nanocore, and web.

## Testing Strategy / Acceptance Criteria

- L1 covers OKF/profile/schema validation, safe page paths, canonical bytes and digests, pre-write save enforcement, deterministic retrieval and trace rows, fixed proposal evidence, review decisions, application, and reversal.
- L2 covers pinned OKF conformance, rebuild equivalence, and identical S61 results across product search, Knowledge Manager reads, and direct-Task selection.
- One existing NanoCore black-box flow covers proposal draft, accept, exact page publication, receipt replay, and bounded reversal; one representative interruption test covers the accepted-review/missing-page exception and contradictory `recovery_required` result.
- S18 owns the single real L6 composition and S39 owns worker-delivery tests; this implementation spec does not duplicate them.

Acceptance: all authoritative page writes pass validation before mutation; one governed retrieval owner serves every knowledge-reading surface; a rebuilt index reproduces candidate results byte-for-byte; every applied generated proposal is create-only and fixes exact page id, bytes, digest, sources, review, actor, and command lineage; success requires both separate review and page writes; same-command completion is limited to its missing deterministic page effect; every other unverified partial state returns `recovery_required` without a workflow; reversal removes only the unchanged proposal-created page and retains evidence; retrieval evidence never counts as S39 delivery proof; and no `memory` vocabulary remains after migration.

## Risks & Mitigations

- Risk: the pinned OKF draft diverges far from ecosystem adoption. Mitigation: the snapshot pattern makes re-pinning a small deliberate change; conformance logic is isolated in one module.
- Risk: deterministic retrieval misses relevant material. Mitigation: pins, explicit references, and agent hints give users and coordinators direct control; recall gaps become observations feeding v2.
- Risk: validation strictness frustrates rough-note capture. Mitigation: invalid drafts preserve material without blocking users; only active retrieval is gated.
- Risk: FTS quality varies across languages. Mitigation: tokenizer choice is isolated behind the index layer; see Resolved Decisions.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: mixed-language and CJK search uses the portable JSON term index for deterministic first-release retrieval, while SQLite FTS5 trigram indexing remains a deferred accelerator behind the same retrieval owner; first-slice ingest ships explicit text material registration and deterministic projection for governed pages, while richer plain-text, Markdown, code, transcript, PDF, and media extraction arrives through capability-mediated worker or Knowledge Manager proposal tasks; V1 generated proposals apply only by creating their one fixed absent Knowledge Page from exact bytes, digest, and sources, while generated update, replacement, merge, split, patch, archive, and delete application remain deferred.

## Deferred / Future Work

- Vector and graph retrieval accelerators behind the retrieval interface.
- SQLite FTS5 trigram indexing behind the retrieval interface when retrieval volume or CJK quality justifies the extra storage and indexing dependency.
- Richer YAML-compatible serialization and external notebook editor writeback.
- Binary source capture, conversion, and derived representation pipelines beyond V1 text material registration.
- Knowledge v2 synthesis: preference extraction, task-pattern learning, and confidence-governed generated knowledge per the product vision.
- Cross-workspace explicit knowledge sharing.
- OKF re-pinning process automation and upstream change monitoring.

## Links

- `docs/okf-spec-v0.1-snapshot.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/core/knowledge.md`
