---
date: "2026-11-15"
---
# Independent Documentation Audit: Fault-Tolerance Group

This non-authorizing record holds the fault-tolerance group of round 2 of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `3cd345759782795e388abd73974a8f2aa8ea7ec0` (`main` on 2026-11-15). Issue #440 releases this group.
- Core document: `docs/core/fault-tolerance.md` (FT).
- Specification: `20261019-durable_execution_and_control_store.md` (DECS), `status: Draft`, `implementation: Partial`.
- Cited records read: the [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md), `20261020-control_store_mixed_writer_exception.md`, `20261025-native_admission_fairness.md`, `20261112-private_active_capture_pin.md`, and the accepted [bootstrap readiness specification](../specs/20260704-nanocore_bootstrap_readiness.md) for the held boot items.
- G3 inspection: two read-only inspector contexts (DECS lines 1-349 and 350-623). They read code only and ran no tests. The auditor verified each kept finding against the code at the base SHA.

## G2 Core Against Specifications

- FT-G2-01: FT (Principles) said that the owning-scope rule "is storage-neutral and applies before and after the control-store replacement". The second clause is rollout wording; Core is implementation-neutral. Removed; the rule stays unconditional.
- FT-G2-02: FT (OpenKit and storage) said "Pending replacement, existing file-backed publication still must acknowledge ...". The opening words are rollout status. Corrected to "File-backed publication must acknowledge only synchronized content and report incomplete authority explicitly." The obligation is unchanged.
- FT-G2-03: FT (Boundary) said "not the duplicate universal Run or event ledger previously excluded". "Previously excluded" is history. Corrected to "not a duplicate universal Run or event ledger".
- FT-G2-04: FT and DECS (Failure Scope And Boot) agree: Workspace authority failure quarantines that Workspace, and server-scoped authority failure refuses boot. No action.
- FT-G2-05: FT and Core storage cite the accepted decision, not DECS. Accepted specifications and decisions delegate current or target behavior to the Draft DECS. Question Q-222.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| FT-DECS-A-01, RT-G2-04 | DECS frontmatter `status: Draft` | The [documentation model](../documentation-model.md) says that a Draft proposes a design contract. Accepted owners route behavior through DECS: storage layout (`20260703-storage_layout_record_ownership.md:15`), scheduler (`20260703-durable_scheduler_design.md:11`), scale (`20260703-durable_scheduler_design.md#scale-limits`), bootstrap readiness (`:18`), NanoHost runtime (`:12`), and accepted decisions `20261025-native_admission_fairness.md:36`, `20261020-control_store_mixed_writer_exception.md:11` and `20261112-private_active_capture_pin.md:32` | Undecided: the design decision is accepted, the specification text is not | Question Q-222 |
| FT-DECS-A-02 | DECS (Write And Space Budget): "remaining Main Core connections use the native owner's 5,000 ms bounded wait" | The accepted [control-store mixed writer exception decision](../decisions/20261020-control_store_mixed_writer_exception.md) says that Main writable handles and bounded busy handling follow DX and rejects "native seconds-long main busy waiting"; the accepted storage layout owner (`20260703-storage_layout_record_ownership.md:354`, written after the QA091 text) records the 5 ms Core writers; DECS (Commit Rule) records that #616 landed in `a1df05e57`; `apps/nanocore/src/storage/db.ts:138` defaults the busy wait to 5 ms | Stale interim exception; later accepted records decide | Corrected to the 5 ms rule for Core, User and Workspace with the interim exception marked retired; the sentence that the retired exception "adds no retry and does not satisfy" the gates is removed with the exception |
| FT-DECS-A-03 | DECS cites `control-store-products.ts` for `closeWorkspaceProductReadHandles` | The function is at `apps/nanocore/src/storage/control-store-product-records.ts:825` | Projection drift | Corrected |
| FT-DECS-A-04 | DECS (Workspace Authorities Outside The Control Database): authored configuration uses "SQL admitted heads"; Core storage also names configuration-head records | The accepted configuration contract (`20260628-nanocore_config_identity_contract.md`, Configuration Scope And Files and Sandbox Template Configuration) edits authored files through the runtime-config file service with revision-checked writes and the exact SHA-256 revision and CAS; `apps/nanocore/src/config/runtime-config-files.ts:298-329` implements it; no configuration-head table exists | Undecided across Core, a Draft and an accepted specification (held M2-G25) | Question Q-223 |
| FT-DECS-A-05 | DECS layout table names `workspaces/<id>/content/`, `workspaces/<id>/projections/` and a top-level `mcp-data/` | The storage layout owner places `mcp-data/` under `catalog/`; `apps/nanocore/src/storage/fs-layout.ts:439` has `catalog/mcp-data`; no `content` or `projections` directory exists | Draft target or stale projection | Question Q-222 |
| FT-DECS-A-06 | DECS: progress commits are at least 100 ms apart | No throttle in `apps/nanocore/src` or `apps/nanohost/src`; the Ablation Plan lists throttled coalescing as pending comparison | Draft rule with no code | Question Q-222 |
| FT-DECS-A-07 | DECS (Unverified Worker Markers) | `openkit.report.origin` and `openkit.report.verified` occur only in test data | Draft rule with no code | Question Q-222 |
| FT-DECS-A-08 | DECS (Journal-To-Lifecycle Mapping) maps actual invocations to ten stages | `deliver-steer` is a closed step kind (`apps/nanocore/src/runtime/execution-step-journal.ts:26`) with no row | Undecided; the telemetry owner defers the map to DECS | Question Q-222; evidence group Question Q-225 covers the stage vocabulary |
| FT-DECS-A-09 | Accepted decision `20261025-native_admission_fairness.md:36` links `#dx-write-and-space-budget` | The DECS heading is "Write And Space Budget" | Dangling anchor in an accepted decision record | Recorded only; decision records are not edited, and no heading is renamed to fit the link |
| FT-DECS-B-01 | DECS acceptance: "Both pass the 20/50 ms limits" and "main event-loop delay p99 <= 25 ms" | `apps/nanocore/src/test-support/load-observe.ts:99` (20/50 ms quiet budget); `apps/nanocore/src/storage/l-ops-load.test.ts:542` (25 ms envelope) | Two bounds, one defined only in test code | Question Q-222 |
| FT-DECS-B-02 | DECS Ablation Plan image and Sandbox-ready clocks | Native-open 60 s and native-request 8 s match. The candidate image clock is the Host helper deadline (`apps/nanocore/src/runtime/turn-executor-factory.ts:7907`): 900 s for `image.acquire` and `image.build`, 300 s for other operations; the Ablation Plan says "Image 300s" | Draft ablation value; the candidate clock differs for image operations | Question Q-222 |

## Held G1 Probe Findings

| Item | Verdict | Disposition |
| --- | --- | --- |
| M2-G25 | Stands | Question Q-223 |
| M2-G37 | Partly: DECS (Portability, Snapshot Closure And Garbage Collection) lists the GC roots; "backups expire under retention" names no owner or default | Question Q-222 |
| M2-G39 | Resolved: DECS sets `auto_vacuum` at creation, including the authorized reset, and `secure_delete` per connection; the [Pre-Release SQL Baselines decision](../decisions/20261114-pre_release_sql_baselines.md) gives fresh databases | No action |
| M3-G22 | Partly: Core identity (`docs/core/identity.md:78`) and the storage layout owner (`20260703-storage_layout_record_ownership.md:586`) require boot to fail closed when existing authority cannot prove fresh initialization; the concrete test (no Core database, no `server/layout.json`, and empty `server/`, `users/`, `workspaces/`, `local/` and `logs/` roots) is only in `apps/nanocore/src/storage/db.ts:453-460`, computed before layout creation (`apps/nanocore/src/index.ts:275`) | Round-1 Question Q-01 (code-only detail) |
| M8-G23 | Resolved: the storage layout owner (`20260703-storage_layout_record_ownership.md:358`) fails closed on a predecessor marker, a root-level `core.sqlite` and owner-nested Workspace trees, and Core identity (`docs/core/identity.md:78`) fails closed when fresh initialization is not proven | No action |
| M8-G24 | Resolved: the bootstrap readiness owner orders layout verification, the lock and migration; `apps/nanocore/src/index.ts` runs `data-root-layout`, `instance-lock` and `migrations` in that order | No action |
| M8-G25 | Partly: the owner names the holder and a diagnostic heartbeat, and says that shutdown SHOULD be bounded by a deadline; the 5 s heartbeat interval (`apps/nanocore/src/bootstrap/lock.ts:8`) and the 5,000 ms shutdown deadline (`SHUTDOWN_DEADLINE_MS`, `apps/nanocore/src/index.ts:158`) are in code only | Round-1 Question Q-23 (experience-chosen numbers) |
| M8-G26 | Resolved: the owner fixes the subsystem states and makes route and payload shapes an implementation projection | No action |
| M8-G27 | Stands: DECS gives the cutover sequence; `apps/nanocore/src/index.ts` still boots through the pre-cutover recovery functions that the Replacement Inventory deletes | Question Q-222 |
| M5-G02, M7-G06, RT-RSS-02 (runtime-model hand-off) | Stands | Question Q-222 |

## G4 Organization

No move, merge, or split is applied. DECS holds dated measurement reports (Write And Space Budget, Implementation Plan And Acceptance) and commit narratives in its projection paragraphs. These are evidence that the documentation model places in change or audit records (Question Q-224).

## G5 Writing

The measurement reports, the commit narrative in the implementation projection, the "earlier 72.0-74.4% result" history sentence and the two FT "replaces" sentences are recorded in Question Q-224. The FT sentences are not changed here: each also states the target owner, so a rewrite needs the same sweep.

## Semantic Preservation

| File | Normative sentences | Other sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- | --- |
| FT | 53 unchanged, 1 changed | 131 unchanged, 2 changed | none | 8 unchanged | 17 unchanged | 17 unchanged |
| DECS | 153 unchanged, 1 added | 658 unchanged, 4 changed or removed, 2 added | 99 unchanged | 131 unchanged, 1 changed (file name) | 30 unchanged | 38 unchanged |

- FT: the normative sentence keeps "must acknowledge only synchronized content and report incomplete authority explicitly"; only the rollout opening is removed. The two other sentences lose only rollout and history words.
- DECS: the 5 ms busy-wait rule now names Core with User and Workspace, and states that the QA091 interim 5,000 ms Core exception is retired. The Commit Rule projection keeps the integrity reader and commit facts. The removed sentence "This exception adds no retry and does not satisfy the single-owner retirement or Main-loop acceptance gates" qualified the retired exception only. The 10 ms BEGIN qualification criterion, the no-retry rule and the immediate-write-intent rule are kept.

## Issues Opened

None. FT-DECS-A-02 is a stale interim exception, not a code defect.

## Questions For The Engineer

### Q-222. Which parts of the Draft control-store specification govern current work?

- Context: DECS is `status: Draft` and `implementation: Partial`. The [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md) accepts the direction, and accepted owners and decisions route current or target behavior through DECS (FT-DECS-A-01). DECS also holds rules with no code and Draft-only targets: the 100 ms progress throttle, unverified Worker markers, the stage map without `deliver-steer`, the 20/50 ms and 25 ms main-loop bounds, the `content/`, `projections/` and top-level `mcp-data/` directories, the backup expiry owner, and boot before cutover (M8-G27). The scheduler and recurring targets (M5-G02, M7-G06) and the scale owner's delegation (RT-RSS-02) depend on the same answer. Worker Turns already write the Workspace execution and step journal rows beside the scheduler attempt rows (runtime-model RT-DSD-05); the decision's rejected alternatives name "an auxiliary journal beside mutable files and existing control tables" and "dual writes", so the answer also decides whether this side-by-side write is allowed until cutover.
- Options: (A) Accept DECS with a per-section status (current, target, or pending ablation). (B) Keep DECS Draft and have each accepted owner state its current rule and name DECS only as the target. (C) Split DECS into an accepted current contract and a Draft target.
- Recommendation: A. The decision is accepted, the code implements most families, and a per-section status lets readers tell current rules from targets without moving text.
- Meanwhile: no change.

### Q-223. Which authority selects the admitted authored configuration revision?

- Context: Core storage says that the scope control store owns configuration-head records and that database heads select the admitted revision. DECS says "SQL admitted heads over exact immutable revision bytes; editable files are drafts", and also says that the remaining configuration families "keep their existing owners" and need "native or file publication" (DECS, Replacement Inventory). The accepted configuration contract edits authored files through the runtime-config file service with revision-checked writes and the exact SHA-256 revision and CAS, and the code implements that service. No configuration-head table exists.
- Options: (A) Database heads are the target; the configuration contract states the file revision as the pre-cutover mechanism. (B) The file revision service stays the authority; Core storage and DECS drop configuration heads.
- Recommendation: A, because Core is the higher owner (Core storage, Source Of Truth) and the accepted [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md) moves mutable control authority to scope SQLite and makes files immutable content or projections.
- Meanwhile: no change.

### Q-224. May the fault-tolerance writing cleanups be applied?

- Context: DECS keeps dated measurement reports, commit and issue narratives in its projection paragraphs, and the "earlier 72.0-74.4% result" history sentence. FT (Principles and Durable Execution) keeps two rollout verbs: "Durable execution replaces its scattered state and bespoke recovery" and "replaces scattered execution and recovery authority". The documentation model places evidence and history in change, audit and decision records.
- Options: (A) Move the measurements and narratives to the change record that produced them and keep links. (B) Keep the text.
- Recommendation: A, under the round-1 delegated sweep for labels and history wording.
- Meanwhile: no change.

## Independent Review

One fresh reviewer read the group diff, this record and the claim inventory against the base SHA. It confirmed FT-G2-01 to FT-G2-03, FT-DECS-A-03, the held verdicts M2-G39, M8-G24 and M8-G26, and the routing of FT-DECS-A-04 to A-08 and B-01 to questions. It returned seven findings; the auditor verified each against the base SHA and applied all of them:

- The first FT-DECS-A-02 correction claimed that only the read-only integrity check keeps a 5,000 ms wait. Other handles keep the driver default. The clause and the commit narrative are removed; DECS states only the 5 ms rule and the retired exception.
- FT-DECS-A-02 now cites the accepted mixed writer exception decision and the storage layout owner, and calls the old text a stale interim exception.
- M3-G22 is now Partly under round-1 Question Q-01; M8-G23 cites the storage layout and Core identity fail-closed rules.
- Q-223 now rests on the accepted decision and Core storage, adds the DECS Replacement Inventory row to the context, and drops an unclear sentence.
- M8-G25 now includes the 5,000 ms shutdown deadline.
- FT-DECS-B-02 names the candidate Host helper clock and goes to Question Q-222.
- The two FT "replaces" sentences are recorded under Question Q-224.

## Checks

At commit time: `node scripts/validate-doc-model.mjs` passed, `node scripts/generate-doc-index.mjs` regenerated `docs/INDEX.md`, `pnpm check:repo` passed, and the content scan of the staged diff found no email, token, credential path, private host, local absolute path or Vietnamese text.
