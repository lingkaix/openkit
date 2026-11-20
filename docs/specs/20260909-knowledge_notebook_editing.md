---
status: Accepted
kind: concept
implementation: Partial
aspect: knowledge
---
# Knowledge Notebook Editing And Publication

This specification owns the fixed-base editing and publication contract for an owner-scoped Open Knowledge Format (OKF) notebook: retained Git content revisions, bounded Knowledge Manager virtual-filesystem editing, final-tree validation, authority and conflict checks, multi-page publication, typed domain pages, history/diff/restore, and administrator masking rules.

## Scope

### Owns

- The single fixed-base editing and publication contract across User Memory, Workspace Knowledge, and Server Knowledge notebooks, including Git commit metadata, candidate refs, and multi-page final-tree validation.
- The Knowledge Manager in-memory `just-bash` editing workspace (`knowledge.notebook-workspace.update`), command profile, and resource bounds.
- Public page operations (`knowledge.notebook.list`, `create`, `update`, `delete`, history, diff, restore), typed domain pages (`Rule`, `Effect`, `Objective`), and Light App pinned meaning resolution.
- Embedded raw-file pointer extension rules and the future administrator page-masking (`masks.json`) contract.

### Does Not Own

- Canonical Knowledge meaning and authority in `docs/core/knowledge.md`, OKF profile and governance rules in `docs/specs/20260702-knowledge_store_governance_rules.md`, or storage encodings and governed retrieval in `docs/specs/20260703-knowledge_store_implementation.md`.
- Physical storage roots in `docs/specs/20260703-storage_layout_record_ownership.md`, or raw file storage and Knowledge Package interchange in `docs/specs/20261018-file_storage_and_knowledge_packages.md`.
- Knowledge Manager role invocation in `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`, or Personal Memory and reflection rules in `docs/specs/20260909-personal_memory_and_knowledge_learning.md`.
- Identity, Policy, Human Attention, command receipts, Audit, Worker Context Package delivery (`docs/specs/20260703-worker_context_package.md`), or Workspace backup (`docs/specs/20260704-workspace_backup_export_import.md`).

### Core

- `docs/core/knowledge.md`
- `docs/core/storage.md`
- `docs/core/policy.md`
- `docs/core/mediation.md`

## Transactional Publication Head And Source Pointer Extension

Under [Durable Execution And Control Store](20261019-durable_execution_and_control_store.md) and [decision](../decisions/20261019-durable_execution_and_control_store.md), immutable page and pointer content lives in `notebook.git`, while Workspace Knowledge commits its current head selection, expected-base check, applicable original Review, local Audit, and original command receipt in one native Workspace SQLite transaction after Git object synchronization (`FsStore.commitWorkspaceKnowledge`), making Git refs and materialized files projections for Workspace Knowledge. User Memory and Server Knowledge retain their ordered physical stages: for an accepted reviewed candidate, the original Review-file stage runs before the common publisher's admission Audit, `refs/heads/published` compare-and-set, completion Audit, and receipt (`apps/nanocore/src/knowledge/notebook-publication.ts`). Fixed-base conflict checks, exact actor and current permission, review and suppression, source references, retained history, and reference-may-miss rules apply across all scopes.

[File Storage And Knowledge Packages](20261018-file_storage_and_knowledge_packages.md) extends the published Git tree with OKF `SourceSummary` pointers at `sources/<source-id>.md`, superseding the external Source registry while keeping raw bytes outside Git; original changes update one pointer in one commit, and an old digest pin resolves only while matching authorized bytes remain available. The publisher contract also requires auto-admitting embedded raw files (resolved via RFC 3986 from each page directory inside Knowledge Base `raw/`), pinning their digests in `sourceReferences` in the same commit, and rewriting referrers on raw rename/move or admitted page relocation (`#507`). Package import validates the remapped Source and page graph before publication and never replaces retained history merely because the current view is empty.

## Scope And Maintenance Authorization

Each notebook is addressed by `ownerScope` (`KnowledgeOwnerScopeSchema` in `packages/protocol/src/models/knowledge-notebook.ts`). The authored `knowledgeMaintenance` setting on `user.jsonc`, `workspace.jsonc`, or `server.jsonc` is defined by `KnowledgeMaintenanceSchema` (`packages/config-schema/src/knowledge-maintenance.ts`), with current defaults `enabled: false`, `schedule.enabled: false`, and `reviewRequiredPageIds: []`. It is written only by the current user for User scope, active Workspace members under configuration Policy for Workspace scope, or deployment administrators for Server scope, and disabling it takes effect before the next publication. A one-off explicit user request may authorize one ordinary maintenance invocation without changing settings. `enabled` delegates ordinary publication; `schedule.enabled` separately enables the daily runs in [Knowledge Manager](20260704-knowledge_manager_internal_agent_runtime.md#query-and-maintenance-execution); neither enables automatic source capture.

Each invocation carries the responsible user's current identity, and membership, source access, and disclosure are rechecked before reads, proposal/review display, and publication. A shared notebook MUST NOT receive information disclosable only to its requesting member. Server Knowledge admission never grants access to another user's Memory; administrative Memory inspection requires current administrator eligibility under Core Policy, retains the original User owner and truthful actor, and never broadens Assistant recall or a `me` route. No model argument may select an actor, local root, authorization mode, or approval identifier.

`reviewRequiredPageIds` names exact page IDs outside editable notebook content; creating, editing, deleting, or changing the status of any listed page requires the exact human Proposal and Review path, and model-authored metadata cannot remove a page from that set. Existing authored required-assessment policies remain effective, and changing source restrictions or scope is never an ordinary content edit.

Server Knowledge maintenance uses the same fixed-base publisher, retained candidate refs, Proposal Markdown (`server/knowledge/proposals/`), and human Review records (`server/knowledge/reviews/`) under `{kind: "server"}` with current Server administration authority required for every candidate disclosure and decision.

## Content, Revisions, And History

Each notebook root contains a bare `notebook.git` repository whose `refs/heads/published` (or SQL-selected commit for Workspace Knowledge) identifies the current content tree containing the OKF bundle under `pages/` and, when masking is active, reserved `masks.json` metadata. The tree contains no credentials, source originals, schema/configuration, Proposal/Review store, indexes, hooks, executable assets, or Git submodules. Physical `knowledge/pages/` is an optional rebuildable materialization with a service-owned commit stamp outside its bundle, built completely before stamp publication and never used as a live authority. Product reads pin a commit at request start and read that immutable tree.

For a fresh authorized scope, initialization creates `notebook.git` and a root commit with the valid empty OKF bundle and versioned root `index.md` before exposing the notebook (attributing an empty system seed to the system actor when no caller attribution exists, without authored pages or maintenance authority). An already initialized notebook with a missing ref, object, or SQL head is `recovery_required`, never silently recreated as empty.

A revision is the opaque full Git commit ID, and exact content identity is `{ownerScope, notebookRevision, pageId, contentDigest}` where `contentDigest` is the SHA-256 digest of exact page bytes. Page front matter has a closed core and open descriptive extensions; no page-level origin or trust field is required.

Every non-initial commit has one parent (the exact edited base), Git-native author/committer metadata recording the responsible actor and time, and a commit message consisting of one service-serialized canonical JSON object matching `KnowledgeNotebookCommitMetadataSchema` (`packages/protocol/src/models/knowledge-notebook.ts`, with `KNOWLEDGE_NOTEBOOK_COMMIT_SCHEMA_VERSION = "openkit-knowledge-notebook-commit-v1"`, `KnowledgeNotebookAuthoritySchema`, and `KnowledgeNotebookAdmissionSchema`, decoded by `Notebook.decodeCommit` in `apps/nanocore/src/knowledge/notebook.ts`). The canonical commit decoder validates the complete object and exact service-serialized canonical JSON bytes: missing, malformed, contradictory, or noncanonical metadata (including duplicate keys anywhere in the object or trailing JSON fragments) returns `recovery_required` with no inferred authority; historical absence of only the `schemaVersion` format marker is interpreted as version `1` while any other explicit marker is rejected without rewriting retained bytes. `KnowledgeNotebookCommitMetadataSchema` also reserves optional boolean `externallyInfluenced`, which is decoded and preserved on commit metadata; absence proves no clear ancestry. Publication derives the revision bit from the trusted writing context and inherited revision; human Review retains the exact candidate bit, and unknown ancestry remains influenced. Governed reads propagate the bit into the actual receiving Turn and bound AgentSession before disclosure. `summary` is bounded untrusted display text (at most `4,096` UTF-8 bytes), JSON-escaped and never interpreted as instructions. `producer` distinguishes human and Agent authorship with model/invocation lineage. Direct or delegated `authority` records the trusted instruction reference or exact resolved `knowledgeMaintenance` value and its SHA-256 digest; a required-review candidate fixes `authority: {kind: "proposal", proposalId}` before commit creation, and terminal Review later binds that exact candidate commit without rewriting it. Saved review candidates are pinned at `refs/proposals/<proposalId>` while their Proposal/Review evidence is retained, including rejected candidates. Service-owned Git configuration disables reflogs, automatic maintenance/GC, hooks, signing callbacks, external diff/textconv/filter drivers, remotes, and submodule/network operations; the Agent never sees `.git`, chooses Git arguments, changes the published head, or edits commit metadata.

## One Editing Workspace

`knowledge.notebook-workspace.update` is a Knowledge Manager-only Tool taking `{script: string}` (at most `64 KiB` UTF-8). Trusted invocation assembly binds one notebook, its fixed base commit, source audience, and an in-memory `just-bash` virtual filesystem populated from admitted files of that immutable revision (`/notebook` for editable OKF pages and reserved `index.md`/`log.md`; read-only `/sources` for selected authorized Source material). The temporary filesystem persists across Tool calls within that single bounded Turn and never mounts live `DATA_ROOT`, another scope, mutable source originals, schema/settings, credentials, or host Git metadata.

The Tool executes only the fixed code-owned in-memory command set (`cat`, `printf`, `echo`, `ls`, `mkdir`, `rmdir`, `touch`, `rm`, `cp`, `mv`, `pwd`, `head`, `tail`, `wc`, `stat`, `grep`, `rg`, `sed`, `awk`, `sort`, `uniq`, `cut`, `paste`, `tr`, `rev`, `nl`, `fold`, `expand`, `unexpand`, `join`, `tee`, `find`, `basename`, `dirname`, `tree`, `du`, `xargs`, `true`, `false`, `jq`, `yq`, `diff`, `seq`, `expr`, `sha256sum`) with no host shell/process spawning, network/fetch, Python, JS runtime, native SQLite, symlinks, hardlinks, or special files. Fixed editing bounds are `32 MiB` admitted text per workspace, `2 MiB` per file, `256` changed files, and `64 KiB` combined returned output (`{exitCode, stdout, stderr, truncated}`) per Tool call, bounded by the remaining shared-runtime Turn deadline. An oversized workspace is rejected before execution; omitted files remain immutable members of the base tree, and final validation still resolves links across the complete resulting tree. Cancellation discards unpublished volatile edits.

## Public Page Contract

Public operations are `knowledge.notebook.list`, `knowledge.notebook.create`, `knowledge.notebook.update`, `knowledge.notebook.delete`, plus history, diff, and restore (`ListKnowledgeNotebookResponseSchema`, `CreateKnowledgeNotebookPageRequestSchema`, `UpdateKnowledgeNotebookRequestSchema`, `UpdateKnowledgeNotebookResponseSchema`, and `DeleteKnowledgeNotebookPageRequestSchema` in `packages/app-api-schemas/src/knowledge-notebook.ts`):

- `knowledge.notebook.list` returns complete canonical Markdown content (including frontmatter) rather than a title/body projection, binding `knowledgeBaseId` and `notebookRevision` even when empty.
- `knowledge.notebook.create` creates a new page path only and cannot replace an existing page; `knowledge.notebook.delete` requires exact `expectedContentDigest` and `confirmRemoval: true` for human-confirmed removal from the current tree.
- `knowledge.notebook.update` takes `{summary: string}` for the Agent's current virtual workspace (recording a `KnowledgeMaintenanceOutcomeSchema` Status Item with the native outcome before later model continuation can fail) or `UpdateKnowledgeNotebookRequestSchema` for public User editor updates, which rejects `null` content with a diagnostic directing the caller to `knowledge.notebook.delete`.

## Final-Tree Validation And Multi-Page Operations

Workspace Knowledge intake stages complete Pages intended for ordinary retrieval as active in the exact reviewed candidate. Deliberate drafts remain draft. Web reads Page lifecycle from the complete immutable candidate bytes in the Proposal preview and identifies draft Pages as excluded from ordinary retrieval. Acceptance still publishes the exact reviewed candidate through current schema, Source, conflict, and human authority checks.

Before publication, the service computes one candidate tree and runs the OKF parser, profile, Scope Schema, and source-disclosure checks across all changed files and affected references:

- `openkit_entry_id`, when present, MUST equal the path-derived concept ID; case collisions, non-regular files, and oversized files are rejected; unknown OKF metadata and unedited body bytes are preserved while normalizing service-owned system facts (attribution and, for User Memory `tell`, lifecycle and timestamps per `docs/specs/20260909-personal_memory_and_knowledge_learning.md`).
- Governed ScopeSchema admission MUST refuse `Procedure` in `allowed_types`, and governed page validation MUST refuse `type: Procedure` even if an in-memory or authored schema attempts to admit it, directing the caller to Skills.
- A Claim requires finite numeric `confidence` in `[0, 1]` (Observation `confidence` carries no core assessment meaning). Recorded `conflict_status` (`KNOWLEDGE_CONFLICT_STATES` in `apps/nanocore/src/knowledge/okf.ts`) is only `unresolved` or `resolved`; absence is not a resolution, and low confidence never implies weak evidence or a conflict.
- A subject-bound Observation requires non-empty canonical URI `subject_refs` whenever `subject_refs` or `conflict_status` is present (`source_refs` is supporting evidence only); exact digest pins apply to those bytes, unpinned references apply to the object, and unsupported target families fail closed. Current draft or active `unresolved` Observations drive Proposal target/source refusal and active retrieval exclusion.
- Concept links and local page/source references resolve against the entire resulting tree. Unresolved-link feedback returns at most `8` `{code, pageId, target}` entries ordered by `pageId` then document position with `target` sliced to `256` characters, solely to the admitted author and never to process logs.
- Published paths are stable identifiers (rename/move is not a notebook operation; reorganize via titles, index links, new pages, and archived/superseded originals). Confirmed deletion requires repairing affected live Markdown links in the same candidate or returns bounded referrer diagnostics, and every repaired page is a full content edit that invalidates prior content-bound Review/assessment and applies protected-page rules; explicit `forget` instead resolves affected links as redacted/unavailable from the suppression record without rewriting referrers.

## Publication, Failure, And Restart

Within the per-scope mutation fence (covering final validation, admission, and publication only, never the model run), the publisher rechecks current scope and source authority, `knowledgeMaintenance` delegation or exact human Review decision, current schema and assessment requirements, and equality of the current head with `baseRevision`. Missing required approval saves one pending Proposal with exact base/candidate/input/source evidence and returns `review_required`.

For Workspace Knowledge, the native SQLite transaction commits the selected Notebook and Scope Schema heads, applicable original Review, required Audit, and original command receipt together after Git object synchronization. For User Memory and Server Knowledge, an accepted Review decision is recorded in the scope's Review file before the publisher persists Audit admission, advances `refs/heads/published` by compare-and-set, and completes the post-publication result, Audit, and receipt stages. If the base changed, the publisher returns `409 conflict` with zero mutation; if publication occurred with incomplete command/receipt evidence, or if Git objects/heads are missing or corrupt, it returns `recovery_required` without fabricating success or recreating an empty notebook. Identical completed requests replay their stored receipt; changed input under the same `requestId` returns `idempotency_key_conflict`. Restart reads the committed head and immutable tree without resuming an editing session or rerunning a model.

## Typed Domain Pages

`Rule`, `Effect`, and business `Objective` (`OPENKIT_DOMAIN_TYPES` in `apps/nanocore/src/knowledge/okf.ts`) are governed ScopeSchema domain types:

- Each requires non-empty `applies_to` containing declared tool or work-step identifiers.
- `Effect` additionally requires a non-empty descriptive `basis` and `last_checked_at` (using explicit-offset timestamp rules); writers preserve supplied values and MUST NOT fabricate a `basis` or `last_checked_at`.
- Native retrieval and the Knowledge Manager search Tool accept optional non-empty `types` and `appliesTo` lists (any-match within each list, intersection across lists, applied after safety/freshness gates and before budget selection, including for pins). `types` matches exact governed type names; `appliesTo` matches exact `applies_to` identifiers only on valid `Rule`, `Effect`, or `Objective` pages. Mismatches record disposition `selector_mismatch` in the response and retrieval trace, and absent filters add no keys to `retrievalParameters`.

## Retrieval, Notebook UI, Restoration, And Portability

Retrieval indexes, state-filtered search (`active` by default; `draft`, `archived`, or `superseded` only on explicit authorized inspection), and deterministic ranking use `docs/specs/20260703-knowledge_store_implementation.md`. Light App meaning discovery resolves exact pinned `openkit:` page references within the bounded `100`-record published ancestry under current scope, schema, Source, and Review checks (excluding unpublished candidates and User Memory, and reporting unavailable on missing, mismatched, or denied targets).

The Notebook UI exposes page editing, state selection, source links, revision history, changed-file lists, and text diffs with responsible human/Agent attribution; denied history rows withhold their summary, producer, and changed paths, and Web Proposal review requires inspecting every complete changed page before submitting the displayed `{proposalId, proposalDigest, baseRevision, candidateRevision}` tuple. Restore computes a candidate diff from selected historical paths into the current base and publishes a new commit (refusing removal on self User Memory or a suppressed identity). Explicit `forget` requires Item-backed human confirmation, suppresses current and normal historical reads and automatic re-extraction from the same source versions, and retains Git, Source, evidence, and backup bytes under disclosed retention rules without physical erasure. Same-owner backup preserves the Git object graph and authority records; optional history export requires the entire requested published historical closure to pass disclosure checks or fails closed; Knowledge Package current-tree import rewrites scope and source IDs and refuses unavailable historical subject or supporting page pins.

## Administrator Masking (Not Implemented)

When implemented (`#263`), an administrator operation may mask a page's exact content by appending a tombstone to reserved `masks.json` (`{version: 1, tombstones: [{pageId, contentDigest, actor, createdAt, reason}]}` with no masked body) at the notebook tree root and publishing an ordinary commit after declaring the masking feature in the notebook format envelope. Only the administrator operation may add tombstones; ordinary edits and restores carry `masks.json` forward unchanged and cannot restore masked bytes, and all history, diff, restore, search, editing-workspace, export, and Knowledge Manager reads withhold masked bytes and resolve references to the tombstone, failing closed if `masks.json` is missing or malformed once declared.

## Acceptance

- Disk-durability verification exercises the real filesystem and Git publication boundary—not a Git API mock—across pre-publication failure, post-ref/pre-receipt interruption, and restart recovery, proving that restart never regenerates content or fabricates missing command evidence.

## Implementation

- Notebook Git publisher, virtual editing workspace, history/diff, meaning reference, and schema application: `apps/nanocore/src/knowledge/`.
- Knowledge Package import/export, index rebuild, and Workspace SQL authority: `apps/nanocore/src/storage/`, `apps/nanocore/src/lib/`.
- Notebook models, operation schemas, and maintenance config schemas: `packages/protocol/src/`, `packages/app-api-schemas/src/`, `packages/config-schema/src/`.

## Implementation Gaps

- Embedded raw-file auto-admission, digest pinning in `sourceReferences`, and referrer rewrite on raw rename or move - Not implemented in the notebook publisher - #507
- Administrator page masking and reserved `masks.json` tombstones - Not implemented - #263
- Proposal candidate ref (`refs/proposals/<proposalId>`) pruning - Proposal refs and Review evidence are retained without pruning - #564
- Complete native-stage retirement for User and Server proposal and forget orchestration - Residual Main-stage orchestration remains in User and Server proposal and forget paths - #616

## Decisions

- [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [Knowledge Manager Agent And Compaction](../decisions/20261017-knowledge_manager_agent_and_compaction.md)
- [Durable Execution And Control Store](../decisions/20261019-durable_execution_and_control_store.md)
