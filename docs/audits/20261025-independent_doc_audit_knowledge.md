---
date: "2026-10-25"
---
# Independent Documentation Audit: Knowledge Group

This non-authorizing record holds the knowledge group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `b648f860e3eeab8bf1a7a419f16b674882ed7a55`. During the group `main` moved to `d818256def07ecebfc0bcc9c85270fde5047341a`; between the two, the only changes under the knowledge code paths are two test files (`apps/nanocore/src/knowledge/control-maintenance-admission.test.ts` and `knowledge-maintenance-deadline.test.ts`), so the evidence below holds at both. Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/knowledge.md`.
- Specifications: `20260702-knowledge_store_governance_rules.md` (GOV), `20260703-knowledge_store_implementation.md` (IMP), `20260704-knowledge_manager_internal_agent_runtime.md` (KMR), `20260909-personal_memory_and_knowledge_learning.md` (PML), `20260909-knowledge_notebook_editing.md` (NBE), `20261014-retrieval_kernel.md` (RTK), `20260703-worker_context_package.md` (WCP), and `20260710-self_improvement_evaluation_loop.md` (SIE).
- G3 inspection: four read-only inspector contexts (KN-GOV for GOV and IMP; KN-KMR for KMR, PML, and SIE; KN-RTK for RTK and NBE; KN-WCP for WCP). They read code only and ran no tests. The auditor verified each kept finding against the code.
- Carried items: Q-51 (`knowledgeMaintenance.schedule`) and Q-63 (`knowledge-manager` as a `Thread.entryPath` value) asked this group to confirm an owner; the protocol group carried the `KnowledgePage` record name (PR-G2-04).

## G2 Core Against Specifications

- KN-G2-01: Core Knowledge says notebook reads and references honor current masks; NBE says administrator masking is not implemented, and issue #263 tracks it. The Core rule is the target and NBE states the gap; no action.
- KN-G2-02: Core Knowledge makes daily learning from recent authorized Threads part of v0.1.0 maintenance; SIE says "Do not mine work passively or on a schedule" without naming its scope. SIE owns only the reviewed completed-Worker-work composition, so the sentence reads as scoped, but it is unqualified. Question Q-140.
- KN-G2-03: Core Protocol lists a `KnowledgePage` record; the knowledge specifications use "Knowledge Page" and `knowledgePageId`, and the code schema is `KnowledgeNotebookPageSchema` (`packages/protocol/src/models/knowledge.ts:4`). `KnowledgePage` is the concept name and the schema name is an implementation identifier; no action.
- KN-G2-04: Core Knowledge says a Goal-dispatched Task uses the ordinary Task Knowledge path, as WCP does; see KN-WCP-01, which is handed to the held Goal specification.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| KN-IMP-01 | IMP: Source registry, captured text, and derived metadata live under `sources/registry/`, `sources/materials/`, and `sources/derived/` "until cutover" | Registration calls `publishCapturedSource` (`apps/nanocore/src/knowledge-operations.ts:775`); `knowledge/source-publication.ts` and `knowledge/source-pointers.ts` write `sources/<id>.md`; no production writer of the old paths remains | The activation condition in IMP and GOV is met; projection drift | Corrected in the IMP Shared Source References paragraphs, two IMP projection bullets, and GOV Versioned Source Pointers; IMP names the retired clauses and the rules that still apply to pointers, and the projection names the captured-byte location (`source-publication.ts:227`) |
| KN-IMP-04 | IMP Validation pipeline: proposal intake rejects `sk-`, `hf_`, `ghp_`, and `okt_` canaries | `packages/app-api-schemas/src/knowledge-manager.ts:19-33` checks only host paths; `apps/nanocore/src/knowledge-manager.test.ts:1541-1551` expects such text to pass | Document outdated by the later accepted [No Credential-Pattern Rejection Of Ordinary Content](../decisions/20261006-no_credential_pattern_rejection_of_ordinary_content.md), which removes the heuristic from every ordinary-content retained record; the code and its regression already follow it | Corrected; the host-path guard and its error rule stay |
| KN-GOV-01, KN-IMP (incomplete list) | GOV: delegated notebook editing "Not Started"; IMP: User/Server lifecycle, forgetting, virtual editing, and delegated publication incomplete | `knowledge/notebook-agent-editing.ts`, `knowledge-agent-maintenance.ts:1017,1063`, `server-knowledge-maintenance.ts`, `user-memory-agent-maintenance.ts`, `memory-forget.ts`, `notebook-publication.ts:381,480` | Projection drift | Corrected to partial implementations; remaining qualification stays with the owners |
| KN-KMR-03 | KMR projection: Server maintenance "remains a separate pending join" | `knowledge/server-knowledge-maintenance.ts:684`; daily scan in `apps/nanocore/src/app.ts`; KMR's own Server Maintenance Implementation section | Projection drift | Corrected |
| KN-PML-01 | PML projection: recent-Thread learning and Server Knowledge "remain separate joins" | `knowledge-agent-maintenance.ts:784-830` selects at most eight eligible prior Turns; Server maintenance exists | Projection drift | Corrected |
| KN-SIE-01 | SIE: the Git publisher and scoped learning extensions "remain Not Started" | `notebook-publication.ts`; Workspace, User, and Server maintenance | Projection drift | Corrected to "partly implemented under their owners" |
| KN-RTK-01, 05 | RTK projection: Git notebooks, commit evidence, and User/Server surfaces unimplemented; no retained commit; "runtime-packaged" IPADIC | `apps/nanocore/src/retrieval-knowledge-adapter.ts:249-270,983,1031,1071`; `storage/index-rebuild.ts:725,734,1144`; `packages/retrieval-kernel/Cargo.toml` `embed-ipadic` | Projection drift | Corrected |
| KN-NBE-01, 02 | NBE projection: Server and User Memory maintenance incomplete; the Source Pointer Extension's embed auto-admission not listed as pending | `server-knowledge-maintenance.ts:684`, `user-memory-agent-maintenance.ts:972`; no embed or raw-rewrite code in `notebook-publication.ts` or `notebook-validation.ts` | Projection drift, and the pending extension is accepted behavior not implemented | Corrected; the pending extension is named; issue #507 (enhancement) |
| KN-KMR-02 | KMR: an admitted `draft-proposal` entry with `knowledge.change.propose` | No `change.propose` in `apps` or `packages`; `knowledge.proposal.draft` stores the caller candidate without a model run | Accepted behavior not implemented, and the projection did not say so | Issue #504 (enhancement); projection names the gap |
| KN-IMP-02, 03 | IMP: `proposalId` hashes `{ownerScope,requestId}`; the Review file is `{proposalId,ownerScope,decisions}` | Workspace ids hash `{workspaceId,requestId}` (`knowledge-operations.ts:1044-1047`, `lib/store.ts:2476,6812`); User and Server use two other shapes; the Review file writes `workspaceId` (`storage/workspace-file-records.ts:188-194,2369`) | Code differs from the accepted specification, on retained records | Issue #502 (blocking candidate, retained data) |
| KN-KMR-04 | KMR `answer`: `page@revision` and `source@digest` citations and the observed revision time | `knowledge-manager.ts:346-365` citation `{reference,title,excerpt}` with no revision, Source citation, or time | Code differs from the accepted specification | Issue #503 |
| KN-RTK-02 | RTK: stream canonical UTF-8 through bounded buffers; per-document limits | `retrieval-sources.ts:332` and `retrieval-knowledge-adapter.ts:1011,1052,1094` send inline text; `packages/retrieval-kernel/src/store.rs:737` refuses a scope view over 8 MiB | Code differs from the accepted specification | Issue #505 |
| KN-WCP-03, 04 | WCP: binding-candidate exclusion includes `policy_excluded` and `budget_exceeded`; Knowledge exclusion rows carry `notebookRevision` | `worker-governance-turn-executor.ts:494-525,810-814`; `context/worker-context-package.ts:207-216` | Code differs from the accepted specification | Issue #506 |
| KN-WCP-01 | WCP and Core: a Goal-dispatched Task has `goalId` without `taskId` and uses the ordinary Task Knowledge path | `context/worker-context-package.ts:1231,1241,1634,2096,2103`; `worker-governance-turn-executor.ts:391,449,468-472` require both or neither and refuse Knowledge for Goal work | Goal semantics are owned by `20261002-goal.md`, which issue #440 holds | Handed to the held Goal group; no issue now |
| KN-KMR-06 (Q-51) | KMR: each scope has an independent `enabled` boolean for daily runs | `packages/config-schema/src/knowledge-maintenance.ts:16-29` separates `enabled` (delegation) from `schedule.enabled` (daily run); the config contract states the two-field shape | No accepted owner names `schedule`; confirms Q-51 | Question Q-137 |
| KN-KMR-07 (Q-63) | Thread Visibility: `entryPath` is `conversation | administration` | `packages/protocol/src/models/thread.ts:9-12` adds `knowledge-manager`, written at `knowledge-agent-maintenance.ts:345` | No accepted owner names the value; confirms Q-63 | Question Q-138 |
| KN-KMR-01 | KMR: maintenance receives search, page, Source, and history reads | Maintenance runs supply the history Tool and the two update Tools and read through the admitted snapshot (`knowledge-agent-maintenance.ts:1239-1262`) | No record decides; the code is the narrower surface | Question Q-136 |
| KN-PML-03 | PML: exclude ephemeral or no-memory work | No such marker exists on Threads | Undefined concept | Question Q-139 |
| KN-SIE-02 | SIE and IMP name `knowledge.proposal-draft`, `-decide`, `-reverse` | `packages/app-api-schemas/src/knowledge-operation-definitions.ts:204,261,277` use `knowledge.proposal.draft`, `.decide`, `.reverse`, under the KMR naming rule | Accepted documents disagree | Question Q-140 |
| KN-GOV-03, 04 | GOV and IMP: restricted labels give `sensitive_content`; expired freshness gives `freshness_expired`; freshness values | `storage/index-rebuild.ts:1005,1086` also exclude `confidential` and `stale`; `knowledge/okf.ts:93-100` adds `current`; no expiry-date validation | No record decides | Question Q-141 |
| KN-GOV-05 | GOV: secret-like field and value rejection in frontmatter | `knowledge/okf.ts:52-53,1195-1199` rejects values containing words such as `token` or `secret` | The 2026-10-06 decision may cover page frontmatter as ordinary content | Question Q-142 |
| KN-GOV-02 | GOV: the Scope Schema identifies owner, timestamps, extension points, rules, and review requirements; schema change uses a reviewed migration flow with `schema/history` | `knowledge/okf.ts:104-112,403-445` hold only version, status, and allowed lists; no schema-change operation or history writer; IMP says no migration journal exists | Code differs from the accepted specification | Issue #508 |
| KN-IMP-05, 07 | IMP: diff returns at most 256 paths with a truncation indicator; `indexes/` holds a page index | `knowledge/notebook-history.ts:156` refuses above 256 paths; `index-rebuild.ts:390-398` writes three projections and IMP's own projection says three | Internal inconsistency or undecided | Question Q-144 |
| KN-RTK-03, 04 | RTK: incomplete enumeration cannot select; reuse a valid sidecar without processing again | Governed search uses `limit: 1000` and fails when enumeration is incomplete (`index-rebuild.ts:808-815`); sidecars are per generation (`store.rs:262-340,1090`) | No record names the ceiling or the cache boundary | Question Q-145 |
| KN-NBE-03, 05, 04 | NBE: Notebook UI provides state selection; User editor update shape; maintenance setting shape | No state control in `apps/web/src/screens/workspace/KnowledgeScreen.tsx`; the update schema requires `requestId` (`packages/app-api-schemas/src/knowledge-notebook.ts:27-31`) as create and delete do; the code adds `schedule` | State selection: code differs from the accepted specification; the update shape and the setting shape are undecided | Issue #509 (state selection); Questions Q-146 and Q-137 |
| KN-WCP-05 to 08 | WCP: `descriptor` projection; complete-request counting; package file layout and policy summaries; sort order; `knowledgeBaseId` on rows | `worker-governance-turn-executor.ts:782-806`; `worker-context-package.ts:741-749,753,878,881,1197,1266` | Undecided wording or internal inconsistency | Question Q-147 |
| KN-GOV-07 | GOV: "Replacing or recapturing evidence creates a new Knowledge Source id and registry record" and the next rule | GOV Versioned Source Pointers already supersedes the rule "for this format", and the cutover is complete | Superseded text kept in place | Part of Question Q-148 |
| KN-IMP-08 | A code comment says selection observes byte revisions, not a retained notebook commit | `packages/app-api-schemas/src/knowledge-manager.ts:284`; the code pins the commit | Code comment drift, outside the documentation scope of this audit | No action; noted for the code owner |
| KN-NBE-06 | NBE: the extension supersedes Git-ref advancement as the commit point, while other NBE text names `refs/heads/published` | The extension depends on `20261019-durable_execution_and_control_store.md`, which issue #440 holds and which is not implemented | Pending a held owner | No action now |
| KN-RTK-07, KN-NBE-07, KN-WCP-09 | RTK owns embeddings while Phase 1 excludes them; NBE `pages/` names both the Git subtree and the old directory; WCP Input Categories mention claims | Phased design; ambiguous wording; low-confidence inconsistency | No defect | No action; the `pages/` wording is part of Question Q-148 |
| KN-WCP-02 | WCP: no `goal_steering` reason for a new admission | The schema keeps `goal_steering` (`worker-context-package.ts:179`) and no writer emits it | Kept for historical readers | No action |
| KN-KMR-05, KN-PML-02, KN-GOV-06, KN-IMP-06 | Typed-error mapping in context preparation; four-change cap; admission order in health; mutating posture of `answer` and `indexes` | Inspector evidence was low or medium-low confidence and not confirmed by a run | Not confirmed | No action; recorded for a later check |
| KN matches | Profile fields and status projection, claims and conflicts, OKF pin and names, retrieval request and disposition order, trace identity and paths, Review id, history bounds, Git hardening and publication, editing bounds, public notebook operations, typed pages and selectors, Knowledge Manager deadline, repair turn, overview, guidance cap, caller set, PML intake bound, SIE evidence tuple and reverse, kernel query modes, status set, scope pins, publish atomicity, tokenizers, digest-window ceilings, faces, WCP numbers and trace identity | The inspectors' tallies in the audit working space | Match | None |

## G4 Organization

No move, merge, or split is applied. KMR `### Server Maintenance Implementation` sits under `## Links`; moving it is part of Question Q-148.

## G5 Writing

- Amendment, history, and process wording: GOV "Versioned Source Pointers" and the "Implementation note" before the first heading; IMP "Shared Source References", "Scoped Memory And Revision Extension", and "The coordinator and Consultant accepted"; RTK "Owner Amendments Required", "The proposed tokenizer amendment", "This revision", "Review Assumptions And Evidence Limits", and "remain draft choices"; NBE "The Draft control-store layout" and "The engineer ruling of 2026-10-16"; WCP "This amendment changes no package history" and "the earlier standalone taxonomy draft is superseded". Question Q-148.
- Experience-chosen numbers not marked as a current default: IMP retrieval limits and history and diff bounds; KMR 4,096-byte overview and 16 KiB guidance; PML eight Turns and four changes; RTK digest-window ceilings and dependency pins; NBE "Initial named bounds"; WCP 4096-byte overview and `limit: 5`. Question Q-148.
- Undefined labels: C01, C02, C05, S17, S18, S39, S51, S60, S61, L-AW, P20, "Phase B", "refined ruling 7", and issue numbers used as authority. As Q-28: Question Q-148.

## Semantic Preservation

The inventory tool compared each changed file with the group base.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260702-knowledge_store_governance_rules.md` (GOV) | unchanged | unchanged | 73 unchanged, 3 added | unchanged | 5 unchanged, 1 added |
| `20260703-knowledge_store_implementation.md` (IMP) | 87 unchanged, 2 changed (the proposal text guard; Source registration) | unchanged | 312 unchanged, 5 removed (the four canary prefixes and `content.txt` path), 13 added | unchanged | 16 unchanged, 1 added |
| `20260704-knowledge_manager_internal_agent_runtime.md` (KMR) | unchanged | unchanged | 184 unchanged, 5 added | unchanged | unchanged |
| `20260710-self_improvement_evaluation_loop.md` (SIE) | 37 unchanged, 1 changed (implementation state) | unchanged | 48 unchanged, 1 added | unchanged | unchanged |
| `20260909-knowledge_notebook_editing.md` (NBE) | unchanged | unchanged | 120 unchanged, 2 added | unchanged | unchanged |
| `20260909-personal_memory_and_knowledge_learning.md` (PML) | unchanged | unchanged | 70 unchanged, 3 added | unchanged | unchanged |
| `20261014-retrieval_kernel.md` (RTK) | unchanged | unchanged | 66 unchanged, 2 added | unchanged | unchanged |

The only design rule removed is the IMP credential-canary rejection, which the later accepted decision removes; the host-path guard, the pre-write refusal, and the no-echo rule stay. The other changes are projection statements.

## Issues Opened

- #502 `[knowledge] Workspace Proposal id and Review file use workspaceId instead of ownerScope`, blocking candidate (retained data).
- #503 `[knowledge] Knowledge Manager answer citations omit revision, digest, Source citations, and observed time`, ordinary.
- #504 `[knowledge] Model-backed draft-proposal entry and its knowledge.change.propose Tool are not implemented`, ordinary (label `enhancement`).
- #505 `[retrieval] Product sources are sent as inline text, so a scope larger than 8 MiB fails the whole search`, ordinary.
- #506 `[context] Context Package Material exclusion never records policy_excluded or budget_exceeded, and Knowledge exclusion rows omit notebookRevision`, ordinary.
- #507 `[knowledge] Notebook publisher does not auto-admit embedded raw files or rewrite referrers on raw rename`, ordinary (label `enhancement`).
- #508 `[knowledge] Scope Schema lacks owner, timestamps, rules, and review requirements, and schema changes have no reviewed migration flow`, ordinary.
- #509 `[web] Notebook UI has no page state selection`, low (label `enhancement`).

## Questions For The Engineer

### Q-136. Which reads does a maintenance run receive?

- Context: KMR lists search, page, Source, and history reads for maintenance; the code is narrower, and changing the accepted Tool set is the engineer's decision, so this stays a question. The code supplies the admitted fixed-base snapshot, the supplied Sources, the history Tool, and the two update Tools.
- Options: (A) State that maintenance reads come from the admitted snapshot and supplied Sources, with no retrieval Tool. (B) Add the listed Tools.
- Recommendation: A, as the smaller bounded surface.
- Meanwhile: no change.

### Q-137. What is the daily maintenance switch called?

- Context: confirms Q-51. KMR says each scope has an independent `enabled` boolean for daily runs, while `enabled` means publication delegation in the config contract and NBE; the code has `schedule.enabled`, default false, and no accepted owner names it.
- Options: (A) Name `knowledgeMaintenance.schedule.enabled` in the config contract, KMR, and NBE. (B) Rename the code member.
- Recommendation: A.
- Meanwhile: no change.

### Q-138. Is `knowledge-manager` a `Thread.entryPath` value?

- Context: confirms Q-63. Thread Visibility states a closed `conversation | administration` set; the code adds `knowledge-manager` for maintenance Threads and uses it to keep them out of learning inputs.
- Options: (A) Add the value to the Thread Visibility owner and link it from KMR. (B) Remove the value and mark maintenance Threads another way.
- Recommendation: A.
- Meanwhile: no change.

### Q-139. What is "ephemeral or no-memory" work?

- Context: PML excludes such work from learning; no Thread or Turn field defines it.
- Options: (A) Remove the phrase until an owner defines the marker. (B) Define the marker.
- Recommendation: A.
- Meanwhile: no change.

### Q-140. Which proposal operation names and which scheduling rule apply to SIE?

- Context: SIE and IMP name `knowledge.proposal-draft`, `-decide`, and `-reverse`; the code and the web projection use the dotted forms under the KMR naming rule. SIE also says "Do not mine work passively or on a schedule", while Core and PML make daily scoped learning part of v0.1.0.
- Options: (A) Use the dotted names in SIE and IMP, and scope the SIE sentence to its completed-Worker-work composition. (B) Keep the text.
- Recommendation: A.
- Meanwhile: no change.

### Q-141. Which sensitivity and freshness values block default retrieval?

- Context: the code is stricter than GOV and IMP, and accepting a stricter exclusion is the engineer's decision. Retrieval also excludes `confidential` Workspace and Server pages and reports `stale` as `freshness_expired`; GOV separates stale from expired. The code adds the freshness value `current` and validates no expiry metadata.
- Options: (A) State the current rule: `restricted` and non-Memory `confidential` give `sensitive_content`, `stale` and `expired` give `freshness_expired`, and `current` is a profile value; keep date-based expiry as later work. (B) Change the code to the narrower text.
- Recommendation: A, if the engineer accepts the stricter exclusion.
- Meanwhile: no change.

### Q-142. Does the credential-pattern decision cover page frontmatter values?

- Context: GOV requires secret-like field and value rejection; the code rejects any value that contains words such as `token`, `secret`, or `password`, so a title such as "Token budget" fails. The 2026-10-06 decision removes credential-pattern rejection from ordinary-content retained records, but its Affected Owners list does not name GOV and the code still rejects such values, so whether page frontmatter is ordinary content is open.
- Options: (A) Treat page frontmatter values as ordinary content: remove value-pattern rejection, keep structural secret-like field-name rejection, and open a code issue. (B) Keep value rejection and define its patterns.
- Recommendation: A.
- Meanwhile: no change.

### Q-143. Withdrawn after review

- GOV decides the Scope Schema fields and change flow; the gap is issue #508.

### Q-144. How do diff overflow and the page index read?

- Context: IMP says diff returns at most 256 paths with a truncation indicator, but the code refuses above 256 paths; IMP lists a page index under `indexes/`, while its own projection and the code have three projections.
- Options: (A) State the refusal above 256 paths, and remove the page index from the layout. (B) Implement truncation and the page index.
- Recommendation: A.
- Meanwhile: no change.

### Q-145. What are the governed enumeration ceiling and the sidecar cache boundary?

- Context: governed retrieval fails when more than 1,000 pages match, and RTK names no ceiling; sidecars are written into each generation and reused only within it, while RTK says to reuse a valid entry and assigns the cache to the adapter side.
- Options: (A) Mark 1,000 as a current default with its typed failure, and state per-generation sidecar reuse. (B) Add a cross-generation cache and paging.
- Recommendation: A.
- Meanwhile: no change.

### Q-146. Does the User editor update take `requestId`?

- Context: the NBE User editor update shape omits `requestId`, which the code requires and which create and delete carry. (The missing state selection is issue #509.)
- Options: (A) Add `requestId` to the update shape. (B) Keep the text.
- Recommendation: A.
- Meanwhile: no change.

### Q-147. How should the WCP projection and field rules read?

- Context: the Knowledge projection never yields `descriptor`, and a non-ready preview refuses launch; package-time counting excludes history, Tool schemas, media, and output reserve; the package file layout lists `thread.md`, `policy.json`, and `artifacts/` that the code does not write, and "must include policy summaries" has no producer; digest-bearing sorts use `localeCompare`; the field lists omit `knowledgeBaseId`.
- Options: (A) State fail-closed for Knowledge pages, say which stage counts what, replace the layout block with the written files, decide the policy summary, require bytewise sorts, and add `knowledgeBaseId` to the lists. (B) Keep the text.
- Recommendation: A.
- Meanwhile: no change.

### Q-148. How should the knowledge history, numbers, labels, and placement be fixed?

- Context: the G5 items above, the KMR section placed under Links, the superseded GOV recapture rule (KN-GOV-07), the retired IMP registry clauses, and the NBE `pages/` wording.
- Options: (A) As Q-28: remove amendment, history, and draft wording or move it to change and decision records, mark experience-chosen numbers as current defaults, replace each label with its meaning or a link, move the KMR section above Links, delete the superseded and retired text, and name the Git `pages/` subtree distinctly. (B) Keep them.
- Recommendation: A.
- Meanwhile: no change.

## Independent Review

A fresh Reviewer context received the diff, this record, the inventory, and the inspector reports, and checked the cited code and issues #502 to #506 itself. Verdict: accept with fixes. Dispositions:

1. Several inspector items had no disposition, and GOV still said the old registry rules were current until cutover. Accepted; GOV Versioned Source Pointers is corrected like IMP, and rows KN-GOV-07, KN-IMP-08, KN-NBE-06, and KN-RTK-07 record the remaining items.
2. The NBE gap added to the projection had no issue. Accepted; issue #507 is opened and cited.
3. The Scope Schema requirements and the Notebook UI state selection are code gaps against accepted text, not questions. Accepted; issues #508 and #509 are opened, Q-143 is withdrawn, and Q-146 keeps only the `requestId` shape. Q-136 and Q-141 now state why they stay open.
4. The IMP "describe no current writer" sentence could let a reader drop rules that still apply, and the projection no longer named where captured bytes go. Accepted; IMP names the retired clauses, keeps the source-reference resolution rule and the copy-not-move invariant for pointers, and names `sources/<sourceId>/original`.
5. The credential-pattern decision was applied unevenly between KN-IMP-04 and Q-142. Accepted; the KN-IMP-04 row cites both the decision and the code with its regression, and Q-142 states why it stays open.
6. The PML edit overclaimed and dropped the Public Server Knowledge read join. Accepted; PML says "partial implementation" and names both joins.

The Reviewer confirmed each partial-implementation claim against the named files, the completed Source cutover, issues #502 to #506 against the code, the #502 severity, and the other open questions. It found no line-break, frontmatter, content-safety, or held-specification problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (674 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): two expected matches only. The IMP host-path guard keeps its existing placeholder forms (`/Users/...`, `/home/...`), and this record and the IMP diff name the bare canary prefixes (`sk-`, `hf_`, `ghp_`, `okt_`). Neither is a real path or credential.
