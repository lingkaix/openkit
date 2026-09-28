---
type: change-plan
status: planned
date: "2026-09-29"
---
# Chat And Task Experience, Retention Stability, And Export Handoff

## Intent Revision 1 — 2026-09-29

The engineer requests finishing the known Chat defect and currently actionable closeout work, merging the current branch and the remaining PR into main, and handing the broader remaining work to a colleague. The receiving colleague owns real-user Chat / Task verification and repairs, retained-data stability verification and repairs, and work arising from the revised export / backup scope. This record also inventories unfinished work from the earlier governance handoff so it is not lost. Goal Mode remains frozen pending explicit activation of complete product Redesign. This handoff does not activate that Redesign or turn a candidate backup technology into an approved implementation.

The engineer's revised AGENTS.md in commit 70b81fb3 supersedes earlier compatibility wording: retained canonical data and authored configuration stay usable; SQLite source-of-truth continuity applies from the first release. First-party APIs, wire formats, clients, and implementations released together have no incidental compatibility obligation. Follow the current accepted contract-evolution owner, not older proposals or this summary. Internal replacement deletes obsolete implementations; it does not add shims or dual writes.

## Entry And Ownership

Read root AGENTS.md, docs/change-execution.md, docs/roles/README.md, and the local guides for each touched application. Resolve behavioral authority through docs/INDEX.md. Use CodeGraph before source discovery. Web work also reads apps/web/AGENTS.md and DESIGN.md. Match role dispatch to docs/agent-harnesses.md; use gpt-6-sol for internal delegates under the engineer's current instruction. Name one writer per path.

The earlier [governance handoff](../202609241400000001-governance_landing_handoff/plan.md) and [runtime retention change](../202609220200000001-runtime_child_retention/plan.md) retain historical evidence. This is the current receiving record for the work listed below, not a new behavioral owner. The [roadmap](../../roadmap.md) sets Chat / Task experience and retained-data stability ahead of Goal composition. No production deployment target is selected by this file: choose the authorized target, exact build, effect boundary, cleanup, and retained evidence before live operations under the existing persistent-live-acceptance cookbook.

## Workstream 1 — Real Chat And Task User Journeys

Owners: [Chat Mode](../../specs/20260704-chat_mode_assistant.md), [Task Mode](../../specs/20260704-task_mode_worker_delegation.md), and [Web projection](../../specs/20260628-web_product_surface_projection.md), together with DESIGN.md and apps/web/AGENTS.md.

Start from the merged implementation rather than recreating it. Exercise ordinary direct answers and explicit scoped knowledge requests, Chat-to-Task handoff, worker selection/start, streaming progress and child activity, user clarification and approval, cancellation, errors, recovery, result and Artifact inspection, navigation/reload, and continued conversation. Verify access boundaries and that presentation reports known outcomes without inventing success or silently repeating an uncertain effect. Include keyboard operation, focus restoration, accessible labels and announcements, narrow layouts, empty/loading/stale/error states, user-input preservation, retry, duplicate clicks, and stale-response races where relevant.

Derive focused regressions from each reproduced fault, repair through existing owners, and re-exercise the affected real journey. Capture the exact build, environment, model/runtime, scenario, public work identifiers, observed outcome, and remaining limits. A unit pass does not stand in for browser or real-provider evidence. Done means the selected supported journeys have actual evidence, no unresolved blocking defects, and independent review of the repairs; do not convert subjective experience quality into an invented score.

RCR-FND-010 is corrected in 44119012 and independently accepted: ordinary answers do not pre-read Knowledge, while explicit Knowledge Manager selection and replay remain. Four focused files passed 72 tests; the merged quick-chat suite also passed. Reuse this regression and verify the actual user journey rather than reimplementing the fix.

## Workstream 2 — Retained Work Data Stability

Owners: [Work Data Retention](../../specs/20260921-work_data_retention_format.md), [runtime sub-agent provenance](../../specs/20260711-worker_runtime_subagent_provenance.md), [storage ownership](../../specs/20260703-storage_layout_record_ownership.md), and [contract evolution](../../core/contract-evolution.md).

Validate the actual Chat / Task producer-to-storage-to-readback path, including nested/multiple sub-agents, original admitted inputs and outputs, exact identity and ancestry, duplicates and interleaving, partial frames and unavailable collectors, interrupted calls, restart/replay, source/parser faults, required append failures, and access/retention boundaries. Distinguish complete retained data from bounded timeline presentation. Inspect retained bytes and references after reload/restart; a projection or digest alone does not prove body preservation. Confirm recorded collection gaps do not rewrite the actual work result, while required persistence failures remain fail-closed under the accepted owner.

Use existing coverage policies and credential boundaries; this does not authorize retaining secrets or unpublished model reasoning. Reconcile every producer in the retention owner's First-Release Capture Matrix, recording required Collect coverage and direct evidence producer by producer; missing required producers cannot be relabeled as unsupported. Test full-capture-off metadata, crash before and after receipt/publication, expiry and non-resurrection as well as enabled capture. Explicitly reconcile the earlier stale-dashboard, credential-reconstruction, replay-conflict, and resumed-watermark observations against their actual closure evidence. State legitimate runtime-source limitations without weakening the matrix. Preserve existing canonical records and authored configuration when implementation changes under the current continuity rules. Reconcile stale Current Implementation Projection claims, including the claimed absence of file/directory fsync, against the current appendCanonicalTextFile and writeFileAtomic implementation; fsync calls alone do not prove crash-boundary durability. A needed new storage decision follows the engineer-confirmed design path, not an ad hoc compatibility layer. Done means the supported non-Goal formats and lifecycle paths have coherent owners, representative read/write/restart evidence and independent assessment; no Goal schema correction is authorized here.

## Workstream 3 — Analytical Export And Separate Backup Design

Owners: [Workspace transfer](../../specs/20260704-workspace_backup_export_import.md), work-data retention, and contract evolution. The engineer's [scope decision](../../decisions/20260928-goal_freeze_and_export_backup_boundary.md) separates external analysis from recovery.

Reconcile active export requirements with external analysis, evaluation, audit, and ingestion by other software. Determine the useful external inventory, original content, identity/lineage, metadata, format version, integrity information, and explicit omissions under existing access boundaries. Complete the design with the engineer before changing unsettled format contracts. Validate the approved export with an independent external consumer or inspection workflow, rather than using lossless Workspace re-import as the product acceptance criterion. Existing import behavior and tests remain implementation facts; any removal needs a deliberate scoped change, not blanket deletion of tests.

Design Workspace and whole-server backup / restore separately. The engineer named filesystem snapshots/synchronization to S3-compatible storage, possibly cloud drives, static SQLite snapshots, and possible future Litestream use as candidate directions. Settle backup scope, SQLite/file consistency, concurrent writers, encryption/access, retention, integrity, recovery procedure, restoration checks, external Worker-volume coverage, and acceptable loss/recovery objectives before implementation. Synchronization alone is not a verified restore. Do not install integrations or select backend semantics from this handoff. Goal-related export structures remain frozen for Goal Redesign.

## Workstream 4 — Governance And Documentation Carryover

Complete bounded closeout of the delivered retention and built-in prompt work using actual artifacts and named evidence. The three fixed built-in prompts were centralized with a 3000-Unicode-code-point cap; verify the non-Goal entrypoints and count guard without extending frozen Goal behavior. Preserve outstanding Goal failures as deferred, not passing or silently skipped. Record raw complexity observations and what the adopted engineering practices actually changed; historical tests or reviewer reports do not establish framework causality.

The earlier [documentation normalization plan](../202609241200000002-documentation_normalization/plan.md) and [framework evaluation plan](../202609241200000003-governance_framework_evaluation/plan.md) remain carried backlog, after the immediate product and retention work. The separately controlled normalization and framework experiments were queued behind explicit activation; listing them here preserves that boundary. Evaluation of already completed active work was explicitly authorized and remains owed as bounded closeout, independently of those experiments; preserve its direct observations and remaining limits in the final checkpoint. Normalization must preserve every criterion with independent checking; a full corpus rewrite is not a prerequisite for fixing Chat. Framework replay, seeded defects, rebuild/discovery probes, and concentrated maintenance rounds retain their registered-prediction and engineer interpretation requirements. No new scores or line-count targets.

## Frozen And Recorded-Only Work

- Goal planning authority and completed-result references: GOALCONT-FND-001 and GOALCONT-FND-002 remain deferred in the [continuous Goal findings](../202609241800000001-continuous_goal_and_builtin_prompts/findings.md). RCR-FND-007 belongs to the same future Goal Redesign. The known no-Review post-checkpoint-cleanup regression remains unresolved evidence; merge does not imply acceptance of it.
- Goal candidate inputs GOVLAND-FND-001 through GOVLAND-FND-004 wait for Goal Redesign.
- Runtime qualification including DeepSeek Harness, and per-harness observed dispatch (GOVLAND-FND-011), remain recorded-only unless activated. Do not claim live runtime support from schema tests.
- Platform-reference organization (GOVLAND-FND-012) remains recorded-only.
- Temporary evidence is retained; temp inventory cleanup belongs to the engineer. No deletion is requested.
- PR #106's later delegated-policy-maintenance slices remain governed by their own Draft and plan; merging its failure-explanation delivery does not approve the deferred features.

## Working Checkpoint

The engineer's governance revisions are committed as 70b81fb3 and ee8a59bd. Configuration tolerance is already independently verified in 2b64298a. Original-body export is implemented and verified within its earlier bounded scope in 5d931915; neither needs rebuilding. Checkpoint cba4e11a contains frozen Goal work and its known failing regression.

The preparing primary fixed the Chat ambient Knowledge pre-read in 44119012 and integrated origin/main's Git-fetch fixes. PR #106 at 06bb1d2b9733f0ae20cb1fe758e1fa986ec1be6c is integrated in e31a2127, preserving capture and typed failure explanations together. GitHub merged PR #106 into main as f0cbc2db; 71a33e78 incorporates that merge without changing the reviewed tree. Conflicts required retaining both schema imports and guide paragraphs and regenerating the index and bundled CLI. Integration also required regenerating OpenAPI, classifying the imported Draft as concept under current documentation governance, and binding a new PR test fixture to the persistent Store needed by capture admission. A Git-timeout regression required separating setup latency from the target timeout without weakening its deadline or no-fallback assertion.

Fresh independent review accepted the combined Chat and PR implementation after inspecting the actual diff and outputs; the separate handoff review accepted the corrected obligations. No current-build real-user, full-suite, Goal acceptance, or complete retention-stability PASS is claimed. Temporary raw output is under temp/changes/202609290900000001-chat_task_stability_handoff/; the Chinese working note remains temp/quality-governance/runtime-retention-working-note.md.

## Bounded Governance Evaluation

The earlier independent retention review supports concrete structural observations: four capture-binding definitions became one schema, three timeline-limit owners became one, and three Store-admitted internal callers share capture construction while Gateway keeps its distinct authenticated admission. No new universal factory or policy engine was needed. The Chat correction removes ambient work and caller branching instead of adding a query classifier or compatibility path. These observations illustrate reduced duplicate responsibility and smaller implicit caller obligations; they do not prove the framework caused better productivity or experience.

Independent handoff review detected and corrected omitted matrix coverage, crash/expiry obligations, old findings requiring evidence reconciliation, and the distinction between already-authorized closeout evaluation and separately gated experiments. The receiving colleague still owes real-use and complete retained-data evidence. No discovery/rebuild replay, comparative score, live deployment, or broad stability claim is supplied by this closeout. PR #106 contributes 38 changed paths before integration; Chat's bounded fix changes three paths, no normative owner, and no closed set or registry. The PR retains its own accepted failure-schema owners and no policy-write authority is introduced by integration.

## Verification And Delivery

The receiving colleague should keep these workstreams in this shared handoff, selecting the smallest cohesive seam and recording defects, repairs, exact evidence, and next action as work progresses. Preserve engineer intent in append-only revisions. Independent review inspects actual diffs and outputs. Close each bounded scope only when its observed acceptance is satisfied; distinguish completed code from real-use evidence still owed. The primary reports externally visible effects and all unresolved findings.

## Combined Verification — 2026-09-29

- Build and typecheck: 16 successful tasks; frozen install passed.
- Core integration: five files passed 152 tests; the sixth initially failed two new PR fixtures before target execution because the Store lacked capture admission. Correcting that fixture to the existing persistent data root preserves production checks; its complete 132-test file then passed.
- Worker shim: workspace-git and CLI passed 154 tests after making target-fetch timeout independent of setup latency. The initial run's timeout during Git initialization is retained as failure evidence. A separate file named shim-timeout-oracle-completed-refusal-red.log contains a passing run and is not red or mutation-proof evidence.
- Protocol failure explanations: 16 passed; Worker startup-failure schema: six passed; rebuilt Skill interface: 44 passed. Fixed prompt guard: two passed.
- Repository check passed with three warnings and 18 informational diagnostics. Final changed-source Biome, documentation model (367 documents), lifecycle, index and diff checks passed. Protocol schemas, OpenAPI and CLI were regenerated; OpenAPI validation passed.
- An isolated production package deployment loaded WorkerHarness and its Worker Protocol / Protocol dependency chain from inside that deployment. This is package proof, not Docker/image or real-enforcement proof.

Logs are in the temporary directory named above. No full Core suite or live deployment was run; frozen Goal failures remain unaccepted. Current engineering principles affected the result through reuse of existing owners, removal of ambient behavior, direct regression evidence, independent review, and explicit unresolved dispositions. These are bounded observations, not a comparative framework experiment.

## Receiving Next Action

Start with Workstream 1 and the non-Goal producer inventory in Workstream 2 on the merged main revision, first naming the real-use target and the smallest representative Chat / Task journey. Check existing evidence before creating a new test or rebuilding a delivered feature. Finish export / backup design clarification under Workstream 3 with the engineer before implementing unsettled contracts. Carry normalization and framework experiments without silently activating them. Goal redesign and temporary-data deletion remain excluded. This handoff remains planned because those receiving tasks are deliberately unfinished, not because the preparing primary's known Chat correction or PR integration is still pending.

## Clean-Checkout Correction

The first PR #107 CI run failed because two historical pilot records linked to ignored local temp files absent from a clean checkout, while the same validator passed locally with those files present. The records now name those paths as uncommitted evidence without promising resolvable documentation links. The validator and historical observations are unchanged; retain both the initial CI failure and subsequent rerun outcome. This illustrates why a local structural pass is not sufficient evidence of checkout completeness.
