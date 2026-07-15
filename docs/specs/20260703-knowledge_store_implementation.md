# Knowledge Store Implementation Contract

Status: Accepted
Implementation: Partial

## Owns

- The pinned OKF version decision and the conformance relationship between OpenKit and the OKF snapshot.
- Concrete file layout, record encodings, and identifier rules for knowledge pages, sources, derived representations, observations, claims, proposals, reviews, and indexes.
- The validation pipeline: parser, OpenKit Knowledge Profile validator, workspace schema validator, conformance computation, and save-path enforcement mechanics.
- The v1 retrieval pipeline that selects knowledge candidates for context packages and worker capability search.
- Knowledge operation surfaces: product-facing knowledge operations and worker-facing `knowledge.*` capability operations.
- Knowledge Manager operational loop mechanics for passive, active, and scheduled maintenance.
- The one-time migration from the minimal knowledge implementation projection to governed Knowledge Store vocabulary and layout.

## Does Not Own

- Canonical knowledge semantics, roles, and invariants, owned by `docs/core/knowledge.md`.
- Governance rules, conformance levels, required fields, base types, observation retention, conflict states, proposal rules, and trace visibility policy, owned by `docs/specs/20260702-knowledge_store_governance_rules.md`.
- Context package assembly, categories, and materialized worker file layout, owned by `docs/specs/20260703-worker_context_package.md`.
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
- `docs/specs/20260703-storage_layout_record_ownership.md`

## Summary

This spec turns the accepted Knowledge Store governance rules into an implementable contract. It pins the portable envelope to OKF v0.1 via a repository snapshot, defines the workspace file layout and record encodings, specifies the validation pipeline and save-path enforcement, defines a deterministic retrieval-first pipeline suitable for v1, names the knowledge operations exposed to products and workers, defines Knowledge Manager loop mechanics, and specifies the direct migration from the current minimal knowledge slice.

The design principle is file-system-first with rebuildable SQLite indexes: governed Markdown files are the source of truth, `workspace.sqlite` holds derived search and lineage indexes that can always be rebuilt from files, and no retrieval accelerator becomes a second source of truth.

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

`docs/specs/20260702-knowledge_store_governance_rules.md` defines the layered contract (OKF-compatible files, OpenKit Knowledge Profile, Workspace Schema), conformance levels, required fields, save-time enforcement rules, observation and claim governance, proposal rules, and Knowledge Manager action groups. It deliberately does not define file layouts, encodings, pipelines, or operation names. This spec closes that gap. The product vision fixes the v1 posture as retrieval-first: knowledge selection over knowledge generation, history first, explicit knowledge over speculative knowledge.

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
      <reviewId>.json
    observations/
      <YYYYMM>.jsonl
    claims/
      <YYYYMM>.jsonl
    conflicts/
      <YYYYMM>.jsonl
  sources/
    registry/
      <sourceId>.json
    derived/
      <sourceId>/
  indexes/
```

`knowledge/pages/` is the OKF bundle root for the workspace notebook, so the reserved `index.md` and `log.md` files live inside `pages/`, and the bundle-root `index.md` carries the `okf_version` declaration. The governance surfaces outside the bundle — `schema/`, `proposals/`, `reviews/`, `observations/`, `claims/`, and `conflicts/` — match the governance spec's notebook-versus-maintenance split and are not part of the exported OKF bundle. Concept IDs follow the snapshot rule: bundle-relative path with the `.md` suffix removed. Concept IDs are the stable public identifier for knowledge pages; renames and moves MUST be recorded as page events so links, source references, proposals, and traces can be repaired deterministically.

`sources/` is a sibling record family, not a subdirectory of `knowledge/`, even though the Knowledge Store conceptually governs sources and derived representations: the evidence layer is consumed by context packages, evidence bundles, audit traces, and artifacts as well as by knowledge pages, and it has different size, immutability, backup, and retention characteristics than the notebook. Physical layout follows record family and lifecycle; conceptual ownership stays with `docs/core/knowledge.md`.

Knowledge pages are OKF concept documents whose frontmatter carries the OpenKit required fields from the governance spec (`type`, `title`, `schema_version`, `status`, `scope`, `source_refs`, `review_state`, `sensitivity`, `freshness`, `created_at`, `updated_at`) as producer-defined extension keys, which the pinned snapshot explicitly permits. OKF `description`, `tags`, `resource`, and `timestamp` remain available with snapshot semantics; `updated_at` is authoritative for OpenKit freshness computation even when `timestamp` is present.

The workspace schema is a YAML file at `knowledge/schema/workspace-schema.yaml` with `schema_version`, owner metadata, active status, timestamps, allowed types, field constraints, source-reference shape, proposal rules, review requirements, and lint rules per the governance spec. Previous schema versions and migration reports are preserved under `knowledge/schema/history/`.

Proposals are Markdown files with frontmatter (`proposal` type, target concept IDs, requested operation, rationale, source references, confidence, freshness, review requirement) and a body that carries the proposed page content or a readable description of the change. Reviews are append-only JSON decision records referencing the proposal, decision, reviewer identity, and timestamp. Observations are JSONL ledger rows per the governance spec, one file per month, excluded from the OKF bundle and from notebook views. Source registry records are JSON files carrying the source identity fields from the governance spec; captured first-slice text material lives under `sources/materials/<sourceId>/content.txt`; derived representations live under `sources/derived/<sourceId>/` with lineage back to the source version.

### Upload intake and source registration

User uploads through product surfaces are work-history records, not sources by default. The bytes land under the originating turn at `threads/<threadId>/turns/<turnId>/inputs/`, and the item log records file id, filename, content digest, size, and sensitivity hint; their lifecycle follows thread history and its retention classes.

An upload becomes a Knowledge Source only through explicit registration, which copies the bytes into the source store, creates the `sources/registry/` record, and writes a capture record whose lineage cites the originating workspace, thread, turn, and file id plus the content digest. Registration is a copy, not a move: later thread compaction or deletion must not create holes in the evidence layer, and source immutability must not depend on thread records.

Registration has exactly three entry points: an explicit user action, a Knowledge Manager proposal, or a workspace policy that explicitly opts specific upload classes into automatic registration. Nothing registers silently by default, per the retrieval-first posture.

The consumption boundary is: knowledge pages, claims, and source summaries MUST cite registered `sourceId`s and MUST NOT reference raw thread attachments; context packages MAY carry unregistered uploads as work-history material for the turn that owns them, and re-using a prior upload as a later work input is a work-history reference by file id and digest that requires no knowledge governance. Content-addressed deduplication of upload and source bytes is a deferred optimization that must not change these record semantics.

### Validation pipeline

A dedicated implementation module owns four stages, in order: OKF parse (frontmatter and body split, YAML parse, reserved-filename structure), profile validation (OpenKit required fields, base types, forbidden secret-like fields, source-reference shape), workspace schema validation (allowed types, field constraints, review rules), and conformance computation (`OKF-compatible`, `OpenKit-profile-valid`, `Workspace-schema-valid`).

All writes to governed records MUST pass through NanoCore's knowledge service; nothing else writes into `knowledge/` or `sources/`. Save-path behavior implements the governance spec directly: direct active updates that fail validation are rejected with a structured validation report; imports, rough notes, and Knowledge Manager drafts MAY be saved with `status: draft` and `review_state: needs-review`, with the validation report persisted alongside the draft as a maintenance record; invalid material never enters active retrieval, and an invalid edit never overwrites the latest valid active record.

Validation is deterministic and versioned: a validation result records the schema version, profile version, and OKF snapshot identity it was computed against, so conformance can be recomputed and explained after schema migrations.

### Indexes

`workspace.sqlite` holds derived, rebuildable index records: a page index (concept ID, type, status, scope, review state, sensitivity, freshness, timestamps, conformance level), a full-text index over titles, descriptions, tags, and body text, a link graph (directed edges from markdown links per snapshot §5.3), a source-reference index, and a validation report index. A full index rebuild from files MUST be possible with one command and MUST produce identical retrieval behavior; index corruption is repaired by rebuild, never by hand-editing index rows. Embeddings and vector search are optional accelerators behind the same retrieval interface and are out of v1 scope.

### Retrieval pipeline

v1 retrieval is deterministic and layered. Given a retrieval request (task description, explicit scope filters, pins, and agent hints), the pipeline runs four stages:

1. Candidate gathering: union of user-pinned pages, explicitly referenced concept IDs, tag and type filter matches, full-text search matches, and one-hop link expansion from strong candidates. Only active `Workspace-schema-valid` records enter default candidate sets, per the governance conformance table.
2. Deterministic ranking: pinned material ranks above explicit references, which rank above full-text relevance, adjusted by scope proximity, freshness state, and review state. Stale, conflicting, or weak-evidence records are demoted, never silently promoted.
3. Policy and sensitivity filtering: every candidate passes a policy check before selection; exclusions are recorded with reasons.
4. Budget fitting: selected material is fitted to the context package budget with per-category limits; overflow exclusions are recorded.

The pipeline output is a scored, filtered candidate set handed to context package assembly under `docs/specs/20260703-worker_context_package.md`, together with the trace material (selected, excluded, reasons, digest inputs) that the governance spec requires. Retrieval never mutates knowledge.

### Knowledge operations

Product surfaces and workers reach knowledge through NanoCore-owned operations, not raw file access. The operation families are: page read, list, and search; direct page create and edit where policy allows; proposal create, list, and review resolution through the human-attention flow; source ingest and source read; observation append (internal producers only); schema read and schema change proposal; and maintenance operations (validate, health report, index rebuild). Worker-facing operations are exactly `knowledge.search`, `knowledge.read`, and `knowledge.propose` under the capability plane rules, with conformance minimums from the governance spec enforced at the operation boundary. Route paths, request schemas, and protocol field names belong to the protocol and capability specs; this spec fixes the operation families and their enforcement obligations.

### Knowledge Manager loops

Passive actions run as post-event hooks after worker turns, ingest events, user edits, and review decisions; they may record observations, validate conformance, attach source references, and draft proposals. Active actions run on user request through the normal internal-agent path. Scheduled actions run as workspace maintenance jobs producing prioritized health reports; the automation trigger uses the existing closed turn trigger vocabulary. All Knowledge Manager writes go through the same knowledge service and are subject to the same validation, proposal, and low-risk repair rules as any other producer; the auto-applicable low-risk repair list is owned by the governance spec.

### Migration from the legacy memory projection

The `memory` vocabulary has been renamed directly, with no compatibility aliases, across protocol schemas, item projections, workspace routes, internal-agent mode names, and the workspace directory. Worker capability routes are not currently implemented; their accepted future names are `knowledge.search`, `knowledge.read`, and `knowledge.propose`. The governed Knowledge Store migration maps existing minimal knowledge entries to pages with mapped types (`preference` and `project-context` to `KnowledgePage`, `task-summary` to `SourceSummary` or `KnowledgePage` by content), `review_state: user-authored` for user-created entries, and synthesized required fields validated against the initial workspace schema. Existing knowledge proposals migrate to governed knowledge proposals. The migration produces a validation report; entries that cannot be migrated cleanly become invalid drafts flagged for review.

## Contract / Expected Behavior

- The system MUST interpret OKF conformance exclusively against `docs/okf-spec-v0.1-snapshot.md`.
- Every governed record write MUST pass through the knowledge service and the four-stage validation pipeline; no other component may write into `knowledge/` or `sources/`.
- Invalid material MUST NOT enter active retrieval, default worker knowledge search, or default context package selection.
- Files MUST remain the source of truth; every SQLite knowledge index MUST be rebuildable from files with identical retrieval results.
- Retrieval MUST be deterministic for identical inputs, index state, and policy state, and MUST produce trace records sufficient to answer what a worker saw, did not see, and why.
- Worker knowledge operations MUST enforce the conformance minimums defined in the governance spec's capability conformance table.
- Knowledge pages MUST NOT contain secret values; the profile validator MUST reject secret-like fields per the vault boundary.
- Cross-workspace knowledge access MUST NOT occur through retrieval, indexes, traces, or context packages.
- Concept renames and moves MUST preserve identity continuity through recorded page events, and link repair MUST be deterministic from those events.
- Migration MUST be one-way and complete: after migration, no legacy `memory`-named route, schema, directory, or capability remains.

## Current Implementation Projection

References to `@openkit/mcp` in this section describe the current removal-only facade. They are not the target Knowledge interface and must not receive new capability work; the accepted replacement is the transport-neutral operation catalog, bundled CLI, and unified end-user Skill.

- `packages/protocol` exposes minimal `KnowledgeEntry` schemas, workspace knowledge request/response schemas, and `knowledge-injection` item projections.
- `apps/nanocore/src/app.ts` exposes `/api/workspaces/:workspaceId/knowledge` routes and `/api/app/workspaces/:workspaceId/knowledge/proposals/:proposalId/decision`. The proposal decision route executes first-slice accept, edit, reject, and defer review decisions; edit decisions persist human-edited proposal title and summary before closing the pending review row. NanoCore currently exposes no `/api/worker-capabilities/knowledge/*` routes; worker operations remain accepted target behavior for the future capability plane.
- `apps/nanocore/src/app.ts` also exposes explicit Knowledge Source identity registration and read surfaces through `/api/app/workspaces/:workspaceId/knowledge/sources` and `/api/app/workspaces/:workspaceId/knowledge/sources/:sourceId`. Registration computes a `sha256:` digest, stores the product-safe source identity record, and copies submitted first-slice text material into `sources/materials/<sourceId>/content.txt`; the API response never returns the submitted content.
- `apps/nanocore/src/storage/fs-layout.ts` creates `knowledge/` and `sources/`.
- `apps/nanocore/src/lib/store.ts` projects current app-local `KnowledgeEntry` records into minimal Workspace-schema-valid OKF Markdown pages under `knowledge/pages/<knowledgeEntryId>.md`, writes the default workspace schema at `knowledge/schema/workspace-schema.yaml`, uses the `KnowledgePage` base type, and keeps the app-local kind in the `openkit_entry_kind` extension. It also projects current app-local `KnowledgeProposalRecord` summaries under `knowledge/proposals/<proposalId>.md`, records app-local knowledge proposal review decisions under `knowledge/reviews/<proposalId>.json`, stores first-slice source identity records under `sources/registry/<sourceId>.json`, stores registered text material under `sources/materials/<sourceId>/content.txt`, and writes first-slice text derived representation metadata under `sources/derived/<sourceId>/text.json` with lineage back to the source content digest.
- `@openkit/app-api-schemas`, `@openkit/core-client`, NanoCore OpenAPI, and `@openkit/mcp` expose the same Knowledge Source registration, list, and read surface through `client.app.registerKnowledgeSource`, `client.app.listKnowledgeSources`, `client.app.readKnowledgeSource`, `openkit.register_knowledge_source`, `openkit.list_knowledge_sources`, and `openkit.read_knowledge_source`. Register and read responses include derived representation metadata without returning captured source content.
- `apps/nanocore/src/knowledge/okf.ts` owns the first-slice OKF document parser, OpenKit Knowledge Profile validator, default workspace schema parser, workspace schema validator, conformance report metadata, secret-like field rejection, and active-page predicate. `apps/nanocore/src/storage/index-rebuild.ts` now uses that module when reading file-backed pages, skips OKF reserved files, reads the workspace schema file when present, reads registered source ids from `sources/registry/`, reads file-backed knowledge ids, validates external source references as HTTP(S) URLs, and keeps pages out of the derived search index unless they are active `Workspace-schema-valid` records whose local `source:<sourceId>` and `knowledge:<knowledgeEntryId>` references resolve and whose external references pass the syntax gate. The same rebuild pass writes `indexes/knowledge-links.json`, a first-slice directed Markdown concept-link graph for active valid pages with broken local links recorded as unresolved edges and external URLs excluded from the concept graph, `indexes/knowledge-validation.json`, a first-slice per-page validation report that records conformance, active/indexed state, profile/schema errors, and local or external reference errors, `indexes/knowledge-source-refs.json`, a first-slice source-reference index that classifies page references as registered sources, workspace knowledge references, or external references with local resolution or external syntax status, and `indexes/knowledge-fts.json`, a first-slice rebuildable full-text term index for active valid knowledge page titles and bodies. NanoCore exposes those derived knowledge indexes through `GET /api/app/workspaces/:workspaceId/knowledge/indexes`; `@openkit/core-client` exposes `client.app.readKnowledgeIndexes`, and `@openkit/mcp` exposes `openkit.read_knowledge_indexes`. NanoCore also exposes deterministic first-slice retrieval through `POST /api/app/workspaces/:workspaceId/knowledge/retrievals`, which ranks active valid pages from `knowledge-fts.json`, supports bounded selection plus pinned concepts, returns selected and excluded candidates with reasons, and appends the same trace to `knowledge/traces/<YYYYMM>.jsonl`; `@openkit/core-client` exposes `client.app.retrieveKnowledge`, and `@openkit/mcp` exposes mutating tool `openkit.retrieve_knowledge`.
- `apps/nanocore/src/lib/store.ts` appends first-slice observation records to monthly workspace JSONL ledgers under `knowledge/observations/<YYYYMM>.jsonl` and reads them back as maintenance records. NanoCore exposes append/list routes through `/api/app/workspaces/:workspaceId/knowledge/observations`; `@openkit/core-client` exposes `client.app.recordKnowledgeObservation` and `client.app.listKnowledgeObservations`, and `@openkit/mcp` exposes `openkit.record_knowledge_observation` and `openkit.list_knowledge_observations`.
- `apps/nanocore/src/lib/store.ts` appends first-slice claim records to monthly workspace JSONL ledgers under `knowledge/claims/<YYYYMM>.jsonl` and reads them back as maintenance records. NanoCore exposes append/list routes through `/api/app/workspaces/:workspaceId/knowledge/claims`; `@openkit/core-client` exposes `client.app.recordKnowledgeClaim` and `client.app.listKnowledgeClaims`, and `@openkit/mcp` exposes `openkit.record_knowledge_claim` and `openkit.list_knowledge_claims`. Accepted, current, non-conflicting claims can now be promoted into pending Knowledge Proposals through `POST /api/app/workspaces/:workspaceId/knowledge/claims/:claimId/promotion`, `client.app.promoteKnowledgeClaim`, and `openkit.promote_knowledge_claim`; accepted claim-derived proposals create source-linked `project-context` knowledge entries through the existing proposal review route.
- `apps/nanocore/src/lib/store.ts` appends first-slice conflict records and conflict resolution updates to monthly workspace JSONL ledgers under `knowledge/conflicts/<YYYYMM>.jsonl`, keeps append history, and reads back the latest row per conflict id as the maintenance record. NanoCore exposes append/list/resolve routes through `/api/app/workspaces/:workspaceId/knowledge/conflicts` and `/api/app/workspaces/:workspaceId/knowledge/conflicts/:conflictId/resolution`; `@openkit/core-client` exposes `client.app.recordKnowledgeConflict`, `client.app.listKnowledgeConflicts`, and `client.app.resolveKnowledgeConflict`, and `@openkit/mcp` exposes `openkit.record_knowledge_conflict`, `openkit.list_knowledge_conflicts`, and `openkit.resolve_knowledge_conflict`.
- `POST /api/app/workspaces/:workspaceId/knowledge/manager/context` now returns and persists a first-slice Knowledge Manager context package trace. The trace records the package id, deterministic package digest, `knowledge-context-v1` policy version, selected knowledge entry ids, selected explicit artifact ids, selected explicit workspace-owned file paths, selected explicit workspace-root file refs, selected accepted claim ids, selected unresolved conflict ids, excluded candidate count, and effective selection budget for the knowledge-derived material handed to the Workflow Coordinator. NanoCore appends the returned response snapshot to `knowledge/context-packages/<YYYYMM>.jsonl` with the context package id, workspace id, operation id, and creation timestamp so equivalent prepare calls are auditable after the route returns. `GET /api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId`, `client.app.readKnowledgeContextPackageTrace`, and `openkit.read_knowledge_context_package_trace` read back one persisted trace by package id. `POST /api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId/materialization`, `client.app.materializeKnowledgeContextPackage`, and `openkit.materialize_knowledge_context_package` write the first worker-visible `/openkit/context` snapshot from that trace, including captured text snippets for registered sources referenced by selected knowledge material, files for explicitly selected inline artifacts, files for explicitly selected workspace-owned text files, files for explicitly selected materialized workspace-root text files, first byte/file/token-estimate budget metadata, package-relative paths, `normal` or `redacted` entry sensitivity labels, source entry provenance fields for source id, kind, URI, content digest, derived representation id, and citation label in the manifest, workspace file provenance through `workspace:<relativePath>` source references and raw content digests, workspace-root file provenance through `workspace-root:<rootId>:<relativePath>` source references and raw content digests, raw-secret-shaped material redaction before worker-visible files are written, and `source_unavailable` decisions when referenced sources cannot be materialized. `GET /api/app/workspaces/:workspaceId/knowledge/manager/context/:contextPackageId/materialization`, `client.app.readKnowledgeContextPackageMaterialization`, and `openkit.read_knowledge_context_package_materialization` read the stored materialization back without rematerializing and verify file digests against the manifest. The response also carries selected accepted claim records, selected artifact records, selected workspace file summaries, selected workspace-root file summaries, unresolved conflict records related to selected knowledge or claims, and the compact context policy summary. `@openkit/core-client` and `@openkit/mcp` validate and relay the same shape through `client.app.prepareKnowledgeContext` and `openkit.prepare_knowledge_context`.
- `apps/nanocore/src/internal-agents/quick-chat.ts` retains the `searchKnowledge` diagnostic allowlist identifier. The current Knowledge Manager implementation is the App API context-package surface above, not a separate internal-agent mode or Core tool executor.
- The accepted V1 implementation keeps the validation, observation-ledger, claim-ledger, claim-to-proposal promotion and accepted-claim application, conflict-ledger-and-resolution, derived-index, retrieval-trace, and Knowledge Manager context-package-trace slices inside NanoCore; extraction to a shared package remains a later option only when another package needs the same implementation. Richer YAML round-tripping, binary/upload source byte handling beyond the first text material slice, derived representations beyond text metadata, external reference resolution beyond HTTP(S) syntax validation, SQLite FTS5 trigram storage, automatic workspace-root file selection, binary root-file conversion beyond explicit text refs, complete replay reconstruction with richer sensitivity/exclusion detail, and structured patch proposal application are deferred future work over the V1 file-system-first contract.

## Alternatives Considered

- Track live OKF upstream instead of pinning: rejected; upstream is a draft that can change conformance semantics under us, which is exactly the drift this spec exists to prevent.
- SQLite as source of truth with file export: rejected; contradicts the file-system-first storage principle and makes user inspection, git-friendly backup, and external editing second-class.
- Vector-first retrieval in v1: rejected; the v1 knowledge posture is retrieval and governance first, deterministic ranking is explainable and testable, and embeddings can be added later behind the same interface without contract changes.
- Compatibility aliases from `memory.*` to `knowledge.*`: rejected under the internal development rule; a direct rename with one migration is cheaper than maintaining dual vocabularies.

## Consequences

- OpenKit gains a fixed, testable definition of OKF compatibility and a conformance suite target.
- Knowledge remains portable: a workspace notebook is a valid OKF bundle that other tools can consume.
- Deterministic retrieval makes context package selection reproducible and auditable, at the cost of lower recall than semantic search; that cost is accepted for v1.
- One coordinated rename removes the `memory` debt across protocol, nanocore, and web.

## Rollout / Migration Plan

1. Land the format and validation layer with L1 unit tests and the OKF snapshot conformance fixtures.
2. Land the workspace layout, source registry, and index rebuild command.
3. Land the knowledge service, operation families, and worker capability routes under the new names, with the protocol rename committed first, then nanocore, then web.
4. Run the memory migration on existing data roots with a validation report; unresolvable entries become invalid drafts.
5. Land the retrieval pipeline and context package trace persistence.
6. Enable Knowledge Manager passive and scheduled loops last, after validation and proposal flows are stable.

## Testing Strategy / Acceptance Criteria

- L1: unit tests for the OKF parser, profile validation, workspace schema validation, conformance computation, deterministic ranking, and V1 materialization surfaces.
- L2: contract tests with fixture bundles for each conformance level; a conformance suite derived from snapshot §9 that MUST pass for import and MUST enforce stricter save rules for governed records; index rebuild equivalence tests proving file-to-index determinism.
- L3: black-box NanoCore tests covering save rejection, invalid draft handling, proposal review through the human-attention flow, worker `knowledge.search`/`knowledge.read`/`knowledge.propose` enforcement, retrieval trace persistence, and the memory migration end state.
- L6: a story where a user ingests a rough source, reviews a Knowledge Manager proposal, and a subsequent worker turn receives and cites the accepted knowledge through a context package.

Acceptance: all governed writes flow through validation; a rebuilt index reproduces retrieval results byte-for-byte at the candidate list level; no `memory` vocabulary remains after migration; a worker turn's knowledge selection is fully explainable from persisted trace records.

## Risks & Mitigations

- Risk: the pinned OKF draft diverges far from ecosystem adoption. Mitigation: the snapshot pattern makes re-pinning a small deliberate change; conformance logic is isolated in one module.
- Risk: deterministic retrieval misses relevant material. Mitigation: pins, explicit references, and agent hints give users and coordinators direct control; recall gaps become observations feeding v2.
- Risk: validation strictness frustrates rough-note capture. Mitigation: invalid drafts preserve material without blocking users; only active retrieval is gated.
- Risk: FTS quality varies across languages. Mitigation: tokenizer choice is isolated behind the index layer; see Resolved Decisions.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: mixed-language and CJK search uses the portable JSON term index for deterministic first-release retrieval, while SQLite FTS5 trigram indexing remains a deferred accelerator behind the same retrieval interface; first-slice ingest ships explicit text material registration and deterministic projection for governed pages, while richer plain-text, Markdown, code, transcript, PDF, and media extraction arrives through capability-mediated worker or Knowledge Manager proposal tasks; update proposals carry full replacement page content, with structured patch proposals deferred until replacement semantics prove too coarse.

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
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/core/knowledge.md`
