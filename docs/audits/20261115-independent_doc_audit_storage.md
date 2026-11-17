---
date: "2026-11-15"
---
# Independent Documentation Audit: Storage Group

This non-authorizing record holds the storage group of round 2 of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `3cd345759782795e388abd73974a8f2aa8ea7ec0` (`main` on 2026-11-15). Issue #440 releases this group.
- Core document: `docs/core/storage.md` (CS).
- Specifications: `20260703-storage_layout_record_ownership.md` (SLR), `20261018-file_storage_and_knowledge_packages.md` (FSK), `20260801-nanohost_workspace_data_boundary.md` (NWB), `20260921-work_data_retention_format.md` (WDR), and `20260704-workspace_backup_export_import.md` (BEI).
- Cited decisions read: `20261019-durable_execution_and_control_store.md`, `20261027-workspace_export_administrator_only.md`, `20261114-pre_release_sql_baselines.md`, and `20261014-pre_stable_data_continuity.md`.
- G3 inspection: five read-only inspector contexts (ST-SLR, ST-FSK, ST-NWB, ST-WDR, ST-BEI). They read code only and ran no tests. The auditor verified each kept finding against the code at the base SHA and dropped one finding that did not hold (ST-NWB-04).

## G2 Core Against Specifications

- ST-G2-01: CS said that "the server config and data layout spec" defines the path tree. The [Core README](../core/README.md) rule says that Core cites no specification. Corrected to "This aspect does not fix the concrete path tree; the physical layout owner defines it."
- ST-G2-02: CS (SQLite Layers) held three implementation-status sentences: cold App readers "now join native admission", default Core reads use a read-only view, and "These changes do not establish complete physical-writer coverage or busy-capture qualification." Core is implementation-neutral. Removed; SLR (Light App authority bullet) and the control-store specification (Current implementation projection) already hold the same facts.
- ST-G2-03: CS (Shared File Storage) said that S3-compatible roots, NAS, and cloud drives are later backend candidates. FSK (Storage Package And Access) holds the same statement as the owner. Removed from Core as a duplicate implementation plan.
- ST-G2-04: SLR made a corrupt shared Workspace SQLite database a process boot failure. CS, [Fault Tolerance](../core/fault-tolerance.md#principles) and the [failure-scope ruling](../decisions/20261019-durable_execution_and_control_store.md) quarantine only that Workspace, and the code refuses that scope only (`apps/nanocore/src/storage/workspace-storage-migration.ts:1258-1267`). The later accepted decision changed the rule, so SLR is corrected in six places: the Light App boundary sentence, the integrity-failure sentence and its recovery paragraph, the Light App acceptance sentence, the resolved-decision bullet, and the test bullet (ST-SLR-05). The User database part is Question Q-204.
- ST-G2-05: FSK says that no Policy storage-lease grant exists, and then that Policy owns the lease format; CS and the Core README say that Policy grants leases. Question Q-208 (ST-FSK-01).
- ST-G2-06: CS and SLR say that `restricted-raw` is an access class, not a duration, while SLR (Resolved Decisions) and the audit usage evidence specification give it a bounded retention window. Question Q-207 (ST-SLR-18, held M2-G09).
- Kept in Core and noted: the "This supersedes the mixed-writer and unmeasured-cold-family allowance" amendment sentence and the release-specific "rc.10 cutover" paragraph (Question Q-214), and the encrypted-file Vault realization sentence, which names the current Vault backend as a fact that Vault owns.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| ST-SLR-01 | SLR Summary names `control-store-products.ts` for `closeWorkspaceProductReadHandles` | `apps/nanocore/src/storage/control-store-product-records.ts:825` | Projection drift | Corrected |
| ST-SLR-02 | SLR: present writers do not enforce a terminal branch | `apps/nanocore/src/lib/store.ts:3374,4665` throw `terminalTurnWriteRejected` | Projection drift | Corrected to the enforced branch |
| ST-SLR-03 | SLR admission grid line cites and the `persistConversationWorkerResultItem` writer names | Cited lines no longer match the functions; both writes use `FsStore.refreshDisplayProjectionItem` (`apps/nanocore/src/mode-entry-routes.ts:307,336`) | Projection drift | Line cites replaced by function and file names; writer names corrected |
| ST-SLR-04 | SLR grid row "Task-to-Goal explanation Item" at `mode-entry-routes.ts:3950-3962` | No Task-to-Goal publisher outside tests | Dangling pointer | Pointer removed; the row stays: Question Q-205 |
| ST-SLR-05 | SLR: Core, User, and Workspace SQLite integrity failure fails boot | See ST-G2-04 | Document outdated by a later accepted decision | Corrected for Workspace; User is Question Q-204 |
| ST-SLR-06 | SLR: `turn.json` carries the capture pair and `writeTurnDirectory` rewrites it | No `writeTurnDirectory` in `apps/nanocore/src`; the Turn record carries `captureCoverage` (`apps/nanocore/src/storage/control-store-products.ts:2573-2581`) | Projection drift | Corrected to the `control_turns` record |
| ST-SLR-07, -08, -16 | SLR tree and file lists (`thread.json`, `turn.json`, `items.jsonl`, `session.json`), observation torn-tail rule, and data-root tree | Mutable records live in scoped SQLite; the tree omits `light-apps/`, `files/`, `data/` and other created paths | Accepted control-store decision changed authority; the rewrite of the tree changes meaning | Question Q-203 |
| ST-SLR-09 | SLR: `server/files` holds server-owned exported bundles; elsewhere `server/exports` | `apps/nanocore/src/storage/workspace-transfer-routes.ts:334,605`, `fs-layout.ts:256` and `apps/nanocore/src/workspace-deletion-evidence.ts:180-181` write to `server/exports` | Internal contradiction; code and two SLR statements agree | Bullet removed from the `server/files` list; a `server/exports` owner line added |
| ST-SLR-10 | SLR Light App table rows `app_meta` and `schema_revisions` | `apps/nanocore/drizzle/app/0000_setup.sql:41` has `app_metadata`; historical schema bytes are `definitions/<sha256>.json` files | Undecided: first principles may favor the code | Question Q-206 |
| ST-SLR-11 | SLR: "Runtime implementation remains absent" for generative families | `apps/nanocore/src/storage/generative-portability.ts` exists; SLR itself names it | Projection drift | Sentence removed |
| ST-SLR-12 | SLR Artifact descriptor `formatVersion: 1` | `packages/protocol/src/common/retained-format.ts:5-8` writes `schemaVersion: 1` | Projection drift (held M2-G04) | Corrected |
| ST-SLR-13 | SLR `candidateSelections`; "ordinary additive SQLite migration" | Candidate choices are `select` entries of the `judgements` array (`apps/nanocore/src/artifact-reviews.ts:1049-1058`); the [Pre-Release SQL Baselines](../decisions/20261114-pre_release_sql_baselines.md) decision puts the fields in `0000_baseline` | Projection drift and a later accepted decision | Corrected |
| ST-SLR-14 | SLR: `ensureLayout` accepts only `workspace-export` and `data-root-backup` | `apps/nanocore/src/storage/fs-layout.ts:71-77` also accepts `source`, `thread`, `workspace-deletion-closure` | Projection drift | Corrected |
| ST-SLR-15 | SLR `ensureWorkspaceLayout` list | `fs-layout.ts:436-440` also creates `catalog/` paths and `light-apps/` | Projection drift | Corrected |
| ST-SLR-17 | SLR Resolved Decisions: legacy root `core.sqlite` is "implementation debt"; the derived index rebuild is "for workspace search" | Layout verification rejects the root path; `apps/nanocore/src/storage/index-rebuild.ts:389-391` rebuilds Knowledge link, validation and source-reference indexes | Projection drift | Corrected |
| ST-SLR-19 | SLR partial server database inventory | Inventory is partial, not wrong | No conflict | No action |
| ST-FSK-02 to -05 | FSK raw placement, raw-path field, case-folded duplicates, manifest literal `raw/` | `apps/nanocore/src/storage/knowledge-package/archive.ts:71`, `format.ts:128`, `apps/nanocore/src/knowledge/source-pointer-codecs.ts:16-27` | Undecided gaps in the package format | Question Q-209 |
| ST-NWB-01 | NWB: additional credential channels "are not yet implemented" | `apps/nanocore/src/runtime/credential-helper-exchange.ts`, `packages/worker-shim/src/credential-helper-protocols.ts` (git, docker, aws, kubernetes, google), `credential-helper-agent.ts` (SSH agent) | Projection drift | NWB now defers status to the credential declaration owner; that owner's stale projection is Question Q-215 |
| ST-NWB-02, -05 | NWB "eleven-root pin"; circular `Partial` condition | No referent for the label; every stated condition is claimed met | Undefined label and unclear status rule | Question Q-211 |
| ST-NWB-04 | NWB: `workspace.collect` adds no tighter `runtimeEnv` count or per-value cap | `apps/nanohost/src/workspace_collect.rs:26-27` caps at 128 values and 64 KiB; NRT line 1071 admits at most 128 entries and 64 KiB per value | Not a defect: the caps equal the runtime-environment owner's bounds | Dropped |
| ST-WDR-01 | WDR target default `on` versus current `off` | `packages/config-schema/src/server.ts:281` `default('off')`; `apps/nanocore/src/config/runtime-config.ts:332-339` resolves only the server scope | Target and gap are both stated; Workspace and Task overrides are missing from the gap row | Gap row corrected; issue #732 |
| ST-WDR-02 | WDR: the coverage binding is in `turn.json` | See ST-SLR-06 | Projection drift | Corrected; other `thread.json` declarations go to Q-203 |
| ST-WDR-03 | WDR torn-tail and per-file `seq` rules for files | Observations live in `control_work_observations` | Same as ST-SLR-07 | Question Q-203 |
| ST-WDR-04 | WDR `config.model` observation type | `apps/nanocore/src/storage/work-observations.ts:233-318` has `model.observed`, `model.capture-gap`, `content.published`, and no `config.model` | Projection gap; the type strings are held M2-G26 | Gap row "Observation types" added; issue #732 |
| ST-WDR-05 | WDR gap row: no truncation records | `packages/worker-shim/src/runtime-capture.ts:241-304` emits truncation records when coverage is `on` | Projection drift | Gap row corrected |
| ST-WDR-06, -07 | WDR historical and cross-document line pins | Pins have drifted; heading names mostly resolve | G5 navigation | Question Q-214 |
| ST-WDR-09 | WDR segmentation `segment` ordinal | `packages/protocol/src/models/thread.ts:23` has `parentThreadId`; no `segment` field | Unimplemented required behavior not in the gap table | Gap row "Segmentation" added; issue #732 |
| ST-WDR-10 | WDR `ts` is RFC3339 UTC milliseconds | `work-observations.ts:154,243` accept any precision | Code differs from a current accepted document | Issue #724 |
| ST-BEI-01 | BEI: V3 MUST include the three Knowledge ledgers; BEI also requires the verifier to reject them | `apps/nanocore/src/storage/workspace-export.ts:95-104` rejects them; the Knowledge store specification retires them | Internal contradiction resolved by the later Knowledge owner | Inclusion list removed; the projection "all four authoritative knowledge ledgers" corrected to `records/knowledge.jsonl` |
| ST-BEI-02 | BEI projection: the guard checks private history | [Administrator-only export](../decisions/20261027-workspace_export_administrator_only.md); `canReadWorkspaceExport` in `workspace-transfer-routes.ts:117-148` has no private-history branch | Document outdated by a later accepted decision | Corrected |
| ST-BEI-03, -04 | BEI: the verifier rejects legacy proposal paths, `workspace.json`, record `name` or defaults, and a config without a name | `verifyWorkspaceExportTree` (`workspace-export.ts:995-1175`) has none of these rules | Code differs from a current accepted document | Issue #723; the projection claim is corrected |
| ST-BEI-05 | BEI Owns a Light App package envelope | No code; BEI elsewhere keeps Light App interchange with its owner | Internal contradiction | Question Q-210 |
| ST-BEI-06 | BEI: "Live MOVE-in and source reactivation remain pending" | Operation definitions and an offline CLI exist; the server composes only backup capture and verify | "Live" is true as written | No action; noted in Q-214 |
| ST-NWB-03, ST-WDR-08, ST-BEI-07 | Stale frontmatter `updated` dates | Git history | Metadata | No action |

## Held G1 Probe Findings

The [G1 probe record](20261023-independent_doc_audit_g1_probe.md) marks these findings Held for this group. They get these verdicts:

| Items | Verdict | Disposition |
| --- | --- | --- |
| M1-G01, M5-G01 | Partly: SLR now gives mutable record authority to the control store; its tree and file lists still name files | Question Q-203 |
| M1-G16, M1-G25, M2-G06, M2-G08, M3-G12 | Stand inside the SLR tree and the WDR file wording | Question Q-203 |
| M1-G15, M2-G02, M2-G03, M2-G13, M2-G17, M2-G18, M2-G20, M2-G22, M2-G26, M3-G01, M5-G03, T1 | Stand: schemas, ledgers, bundle and wire formats exist in code only | Round-1 Question Q-01 (delegated sweep); no new text |
| M2-G04 | Resolved | Corrected (ST-SLR-12) |
| M2-G07 | Partly: staging names are internal | No action |
| M2-G09 | Stands | Question Q-207 |
| M2-G11 | Partly: target and gap are both stated | Gap row corrected (ST-WDR-01) |
| M2-G12 | Partly: the pre-`v0.1.0` online MUST is met for idle Workspaces only | Existing issues #417 and #418 |
| M2-G14 | Partly: `moved-out` is outside the registry states, but no text says so | Round-1 Question Q-01 |
| M2-G15, M6-G12 | Resolved | Corrected (ST-BEI-01) |
| M2-G16, M2-G35 | Partly: the control-store specification uses logical names and names no recurring home | Hand-off to the fault-tolerance group |
| M2-G19 | Partly: family list corrected; the fresh-versus-missing predicate is in code only (`apps/nanocore/src/storage/db.ts:453-460`) | Corrected (ST-SLR-14); predicate under round-1 Question Q-01 |
| M2-G27 | Partly | Gap row added (ST-WDR-09) |
| M2-G28, T5 | Partly | Round-1 Question Q-23 (delegated sweep) |
| M2-G30 | Resolved | Corrected (ST-SLR-09) |
| M2-G31 | Stands: BEI's USTAR limit cannot carry every valid Knowledge page path | Question Q-212 |
| M2-G32, M6-G24 | Partly: field schemas are in `packages/app-api-schemas` and the Source codecs | No action |
| M2-G34 | Partly: exact-release restore is stated; no rule after `v0.1.0` | Question Q-213 |
| M2-G36, M2-G40 | M2-G36 is explicitly deferred by BEI; M2-G40 partly | No action; M2-G40 joins Q-209 |

## G4 Organization

No move, merge, or split is applied. BEI repeats "Ordinary portable import is removed" in about fifteen places, and NWB repeats its one-stream and `no_new_head` paragraphs four to six times. A single statement with links would carry each; the reduction is Question Q-214.

## G5 Writing

- The CS "This supersedes ..." sentence, the CS "rc.10 cutover" paragraph, the WDR C1 to C7 "Withdrawn" and "Moot" blocks, the WDR closed Open Questions, and the drifted line pins in WDR are recorded in Question Q-214. Round-1 practice treats label, number and digest cleanups as questions, not rewrites.
- The former aspect name "Permissions" is replaced by "Policy" or "Core Policy", as in round-1 finding SUP-C-06: FSK (one), WDR (two), BEI (six), and SLR (one).

## Semantic Preservation

The table gives the inventory counts from the semantic inventory tool. A normative sentence is one that holds a requirement keyword.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| CS | 112 unchanged, 1 removed (status) | 7 unchanged | 16 unchanged | 16 unchanged | 19 unchanged |
| SLR | 156 unchanged, 6 changed | 21 unchanged, 27 removed (code line numbers) | 322 unchanged, 22 removed, 20 added | 43 unchanged | 36 unchanged, 1 added |
| FSK | 77 unchanged | 13 unchanged | 113 unchanged | 22 unchanged | 26 unchanged |
| NWB | 175 unchanged | 68 unchanged | 182 unchanged | 60 unchanged | 17 unchanged |
| WDR | 221 unchanged, 1 changed | 71 unchanged, 1 added (issue number) | 296 unchanged, 7 added | 62 unchanged | 25 unchanged, 1 added |
| BEI | 223 unchanged, 4 changed or removed | 20 unchanged, 1 added (issue number) | 208 unchanged, 3 added | 58 unchanged | 30 unchanged, 2 added |

Changed normative sentences:

- SLR: the integrity-failure sentence, its recovery paragraph, the two Light App sentences, the resolved-decision bullet and the test bullet (Workspace quarantine, ST-SLR-05); the new `server/exports` owner line (ST-SLR-09); the terminal-branch sentence (ST-SLR-02); the admission grid row and the equality sentence (line cites only, ST-SLR-03); the `ensureLayout` family list (ST-SLR-14).
- WDR: the Coverage gap row (ST-WDR-01).
- BEI: the removed V3 inclusion list for the three retired ledgers (ST-BEI-01), the private-history guard sentence (ST-BEI-02), and two "Core Permissions" renames.

The removed CS sentences are status facts that SLR and the control-store specification already hold. The removed SLR numbers and identifiers are code line ranges and the stale names `writeTurnDirectory`, `writeOwnedDescriptiveJson`, `formatVersion: 1`, and `candidateSelections`. No acceptance item was removed. No heading changed, no file moved, and no inbound anchor needed repointing. CS gained no specification reference.

## Issues Opened

- #723 `[workspace-export] The V3 verifier does not reject the removed workspace.json path, record-owned name or defaults, a config without a name, or the legacy Knowledge Proposal and Review paths`, ordinary.
- #724 `[work-observations] The observation reader admits a ts value without milliseconds`, low.
- #732 `[work-data] Capture Coverage Workspace and Task overrides, continuous-output segmentation, and the config.model observation are not implemented`, enhancement, blocking candidate (retained data format).
- Existing #417 and #418 cover held M2-G12.

## Questions For The Engineer

### Q-203. Should the storage layout tree and file wording follow the control-store authority?

- Context: SLR gives mutable Workspace, Thread, Turn, Item and AgentSession records to scoped SQLite under the [control-store decision](../decisions/20261019-durable_execution_and_control_store.md), but its target tree, canonical-directory rule and file lists still name `thread.json`, `turn.json`, `items.jsonl` and `session.json`, and its tree omits `light-apps/`, `files/`, `data/` and other paths that the code creates. WDR declares delays and envelopes on `thread.json` and `turn.json` and keeps per-file torn-tail and `seq` rules, while observations live in `control_work_observations`. Held M1-G01, M1-G16, M1-G25, M2-G06, M2-G08, M3-G12 and M5-G01 are the same theme.
- Options: (A) Rewrite the SLR tree and the WDR file wording to the current physical families (scoped SQLite tables by owner, immutable blobs, Light App directories, catalog, export record paths), and keep file rules only for the portable export and Worker capture. (B) Keep the file tree as the portable layout and state that it is not live authority.
- Recommendation: A. The accepted decision moved authority, and the tree is a projection of it.
- Meanwhile: only the stale `turn.json` projections are corrected.

### Q-204. Does a corrupt User database fail process boot?

- Context: SLR and CS make the User SQLite store process-critical, and Fault Tolerance refuses boot for server-scoped authority. [NanoCore Bootstrap Readiness](../specs/20260704-nanocore_bootstrap_readiness.md) says instead that user-private failures block the affected user's dependencies unless server authority is also untrustworthy. The code refuses only that User scope and continues (`apps/nanocore/src/storage/workspace-storage-migration.ts:1258-1267`). Two accepted specifications disagree, so the audit does not choose.
- Options: (A) Contain a User failure to that User, as the code does, and correct SLR. (B) Keep boot failure and open an issue.
- Recommendation: A, if a User database holds only that User's data. One damaged User should not stop every other User.
- Meanwhile: SLR keeps User as process-critical.

### Q-205. Is the Task-to-Goal explanation Item row still needed?

- Context: the SLR admission grid has a row for a Task-to-Goal explanation Item. No non-test code publishes it, and Goal Mode is a composition of existing capabilities.
- Options: (A) Remove the row. (B) Keep it as a future path.
- Recommendation: A, unless a Goal owner still requires that Item.
- Meanwhile: the dangling code pointer is removed; the row stays.

### Q-206. Which Light App table layout is the contract?

- Context: SLR names `app_meta` and a `schema_revisions` table. The code has `app_metadata` with `schema_revision`, `schema_digest` and `schema_json` columns, and keeps historical schema bytes as immutable `definitions/<sha256>.json` files.
- Options: (A) Correct SLR to the code layout. (B) Keep SLR and open an issue.
- Recommendation: A. Content-addressed definition files already give immutable history.
- Meanwhile: no change.

### Q-207. Does `restricted-raw` have a retention window?

- Context: CS and SLR say that `restricted-raw` is an access class, not a duration. SLR (Resolved Decisions) and the audit usage evidence specification give it a bounded retention window, and no window is assigned anywhere.
- Options: (A) Keep the access-class rule and remove the window wording. (B) Assign a window owner and a default.
- Recommendation: A, with retention set by the retention class and holds. The evidence group links this question.
- Meanwhile: no change.

### Q-208. Who owns the storage lease?

- Context: FSK says that there is no Policy storage-lease grant and later that Policy owns the lease format. CS and the Core README say that leases reuse Policy grants. Commit `2dbea2e8b` removed the unused storage-lease grants from Policy code, and no lease producer exists (`basis: 'lease'` only as a type in `packages/storage/src/contract.ts:14`).
- Options: (A) Leases reuse ordinary Policy grants and runtime enforcement; FSK owns the lease record. (B) Policy owns a lease format.
- Recommendation: A, which matches CS.
- Meanwhile: no change.

### Q-209. Should the Knowledge package format state its archive details?

- Context: FSK omits the raw placement `sources/<id>/original`, says that frontmatter carries a raw path field that the code does not store, does not state the case-folded duplicate rule (`archive.ts:71`), and does not name the manifest literal `raw/` default root (`format.ts:128`). Held M2-G40 adds header dialect, entry order, mode and mtime, and the bare `application/x-tar` body.
- Options: (A) Add these as format rules. (B) Mark them as implementation choices.
- Recommendation: A for rules a reader must apply (duplicate rule, default root, body media type); B for the others.
- Meanwhile: no change.

### Q-210. Does the backup specification own a Light App package envelope?

- Context: BEI Owns "the Light App-scoped import/export package envelope ... and identity rewriting", while BEI elsewhere leaves Light App interchange with its owner and removes ordinary import. No such envelope exists in code.
- Options: (A) Remove the Owns entry. (B) Move it to the Generative Kernel owner.
- Recommendation: A.
- Meanwhile: no change.

### Q-211. What is the "eleven-root pin", and when does NWB become implemented?

- Context: NWB says that the path is admitted "by the eleven-root pin"; no document or code defines the label. NWB stays `Partial` until three conditions hold, and NWB itself claims all three; only an undefined "broader declared data-source and reuse target" remains.
- Options: (A) Define or remove the label, and name the open item or set `implementation: Implemented`. (B) Keep both.
- Recommendation: A.
- Meanwhile: no change.

### Q-212. How does the export archive carry a long Knowledge page path?

- Context: BEI limits archive paths to USTAR name 100 bytes plus prefix 155 bytes with no PAX entries (`apps/nanocore/src/storage/workspace-archive.ts:39-46`), and the Knowledge store specification allows a 240-byte page identifier. A valid page under its prefix can exceed the limit, so export of that Workspace fails.
- Options: (A) Admit PAX path records in the export archive. (B) Lower the page identifier limit. (C) Keep both and state the export refusal.
- Recommendation: A. PAX is the standard extension for long paths, and the identifier is retained data.
- Meanwhile: no change.

### Q-213. Can a backup restore into a later release after `v0.1.0`?

- Context: BEI requires the exact same release for restore and MOVE and gives no end date. Data continuity starts at `v0.1.0` under the [pre-stable data continuity decision](../decisions/20261014-pre_stable_data_continuity.md), and NONNEG-001 keeps retained data usable across versions.
- Options: (A) After `v0.1.0`, a later release restores an older backup through the normal upgrade path. (B) Keep exact-release restore and state that a backup is release-bound.
- Recommendation: A. SLR already says that supported older data follows its normal upgrade path after restore.
- Meanwhile: no change.

### Q-214. May the storage writing cleanups be applied?

- Context: CS keeps the amendment sentence "This supersedes the mixed-writer ..." and a release-specific "rc.10 cutover" paragraph; WDR keeps withdrawn and moot C1 to C7 blocks, closed Open Questions and drifted line pins into other documents; BEI repeats one removal sentence about fifteen times and uses the undefined word "Live" for MOVE; NWB repeats two paragraphs four to six times.
- Options: (A) Remove history wording, replace line pins with section links, and keep one statement of each repeated rule with links. (B) Keep the text.
- Recommendation: A, under the round-1 delegated sweep for labels and history wording.
- Meanwhile: no change.

### Q-215. May the audit correct the credential declaration projection?

- Context: the Current Implementation Projection of `20260709-worker_credential_access_declarations.md` (vault group, audited in round 1) says that Harness Login selection, Codex host-managed tokens, on-demand helpers and generic HTTP bearer refresh are not yet implemented, and NRT (Credential Channel Ownership) says the same. The code has helper protocols for git, docker, aws, kubernetes and google, an SSH agent facade (`packages/worker-shim/src/credential-helper-agent.ts`), a dormant Harness Login selection path (`apps/nanocore/src/runtime/harness-login-selection.ts`), and a Codex host-managed login path (`packages/worker-shim/src/adapters/codex.ts`, `hostManagedLogin`). Each status needs its own check.
- Options: (A) Correct that projection in the close-out. (B) Leave it to the next vault change.
- Recommendation: A, after the close-out verifies each named channel against its owner and its activation state.
- Meanwhile: NWB defers to that owner.

## Independent Review

A fresh Reviewer context received the staged diff, this record, and the claim inventory, and checked the code itself at the base SHA. Verdict: accept with changes. Dispositions:

1. SLR still kept process-boot failure for shared Workspace corruption in the Light App boundary sentence and the Light App acceptance sentence. Accepted; both now quarantine the Workspace, and ST-G2-04 lists six places.
2. The Q-215 context said that no host-managed code exists. Accepted; the context now names the Codex host-managed login path, the dormant Harness Login selection path and the NRT statement.
3. The WDR "Observation types" gap row named code-only type strings, which is the subject of held M2-G26. Accepted; the row keeps only the missing `config.model` observation.
4. Three WDR gap rows had no traceable task. Accepted; issue #732 covers them and the rows link it.
5. The Q-204 context omitted the bootstrap readiness rule for user-private failures. Accepted; added as a conflict between two accepted specifications.
6. The new Workspace quarantine sentence sat next to the "MUST NOT move the file to quarantine" prohibition. Accepted; it now ends "boot does not move, delete, repair, replace or migrate that database".
7. Removing the `server/files` bullet left no `server/exports` owner sentence. Accepted; an owner line is added.
8. Citation and completeness corrections (ST-SLR-03 writer names, the refusal line range, `fs-layout.ts:436-440`, `workspace-export.ts:995-1175`). Accepted.
9. The `ArtifactReview` row called `judgements` a candidate-choice array. Accepted; candidate choices are its `select` entries.
10. The control-store specification names the same wrong file as ST-SLR-01. Accepted as a hand-off; the fault-tolerance group corrects it.

The Reviewer confirmed the remaining corrections against the code, the drop of ST-NWB-04, that Q-203 to Q-215 change no text, that Core gained no specification reference, and that the diff has no content-safety problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (714 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
