# Self-Improvement Loop Foundations

Type: change-plan
Status: verified

## Intent

Close G07 by delivering the smallest source-traceable learning loop that current OpenKit use justifies: an authorized agent explicitly reviews one completed work history, creates an existing pending Knowledge Proposal, a human accepts or rejects it through the existing Knowledge Review owner, a later Task receives the accepted knowledge through the single S39 Context Package delivery trace, and the proposal-created page can be reversed through its owning Knowledge boundary.

This package does not build an autonomous improvement platform. The Task Evaluator remains a reserved Core direction; V1 reflection is an explicit composition of existing public work-history, evidence, Knowledge Proposal, review, and Agent Skill operations. NanoCore validates and persists the proposal and its effects but does not create a persistent Reflector, evaluation run lifecycle, scheduler, Judge, suite, or Harness.

## Inherited Audit Responsibility

This plan is WP-6 of the [OpenKit Execution Program](./202607172152230001-openkit_execution_program.md) and absorbs G07 from the [alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md). G07 covers C12 Knowledge, S17-S19, S60-S61, and their supporting projections. The bounded review-only preamble, both implementation entry gates, Stages 1-3, and the WP-6 exit are complete.

### G07 Review-Only Preamble (2026-07-19)

- Authority map: C12 owns Knowledge meaning; S60 owns governance; S61 owns file-backed pages, sources, validation and deterministic retrieval; proposal Markdown owns proposed content and review records own decisions; indexes, Action Center, clients and Skills are projections.
- Authority map: S17 owns request-scoped Knowledge Manager calls; S39 owns the only accepted worker Context Package delivery trace. Knowledge preparation and retrieval traces are inputs and audit evidence, never a second delivery receipt. C03 retains Task Evaluator as a reserved direction.
- `SECURITY-GAP`: freeze product-safe Knowledge error mapping instead of returning caught host paths or private messages. Future historical evaluation also must not replay stale AEP authority or retain cross-Workspace fixtures without current authorization, but S19 remains non-authorizing and no Harness enters V1.
- `OWNERSHIP-CONFLICT`: delete the duplicate substring selection authority and route Task Knowledge selection through S61's existing governed deterministic retrieval; delete the standalone Knowledge Manager context trace and materialization projections and keep S39 as delivery authority.
- `IMPLEMENTATION-DEFECT`: freeze exact S17 callers with no client override, save-time validation, proposal application that never reports success before the exact page effect and can fail closed from a discoverable interrupted boundary, and exact selected Knowledge content, digest and source lineage in the existing S39 package and trace. Goal-mode Knowledge selection remains deferred because no current Goal projection consumes it.
- `DESIGN-DEFECT`: the persistent Reflector, universal ImprovementProposal state machine, provisional citation self-confirmation, schedule/fire recovery platform, Skill Catalog, replay reconstruction prerequisite, evaluation area, suites, two-Cell Harness, Judge workflow, budget queue and long-horizon tier exceed G07 and conflict with the program's standing prohibitions.
- `TEST-GAP`: use one existing NanoCore Task integration path plus one risk-focused invalid/restricted case to prove Knowledge selection reaches worker-visible S39 bytes; use the existing Skill/CLI and A1 acceptance surface for one real loop. No runner, harness, crash matrix or duplicate L6 platform is authorized.
- `REAL-USE-GAP`: synthetic fixtures and prior interface acceptance do not prove retained work history that a reflection can mine. WP-6 production implementation waits until one useful stock-OpenShell Task with normal Thread, Turn, Item, evidence and S39 records is retained.
- Frozen scope and exit criteria: correct the existing Knowledge owners, complete an explicit proposal-only human-reviewed loop, prove later S39 use and bounded reversal, and preserve source traceability, exact callers, deterministic selection, human evaluation authority and no passive agent framework. All other findings are dispatched below.

## Scope

### Owning-document correction

- Narrow S18 to an explicit, proposal-only V1 composition and keep the concrete internal Task Evaluator architecture reserved.
- Keep S19, recurring/event triggers, and Skill Catalog versioning Draft and non-authorizing; move their present speculative mechanisms to roadmap criteria.
- Reconcile S17, S60, S61 and S39 around one selection owner, one accepted delivery trace, exact caller assignment, save-time validation, create-only generated proposals, and bounded reversal.
- Keep provisional auto-promotion disabled; ordinary pending proposals and human review are the only V1 activation path.

### Existing-owner correctness

- Replace Task Mode's duplicate substring selector with the existing governed deterministic retrieval owner.
- Assign `app-api`, `assistant`, and `task-mode` internally; public request bodies cannot assert semantic caller identity.
- Return bounded product-safe Knowledge errors and retain private diagnostics only in existing audit/log owners.
- Validate governed page writes before they become active rather than relying on a later index rebuild to exclude invalid data.
- Extend the existing S39 package and immutable trace with exact selected Knowledge entry bytes, content digest, source references, and package path. A content digest is the V1 selected-version identity; no separate Knowledge delivery record is added.
- Make generated improvement proposals create-only in V1. The proposal fixes the target page id, exact page bytes, content digest, and source lineage before review. Human acceptance uses the existing proposal/review owner to apply that exact page idempotently. Success is not reported until both the accepted decision and matching page exist; an interruption between file writes remains discoverable and the same authorized command either completes the deterministic missing effect or returns `recovery_required`. Reversal removes that exact proposal-created page while retaining proposal, review, command and audit evidence.

### Explicit reflection composition

- Reuse the unified `openkit` Skill and bundled CLI to inspect one completed Thread and its existing projections for advisory analysis, then call the existing Knowledge Proposal operation with S61's closed same-Workspace evidence set: one terminal direct-Task worker Turn, its final completed `assistant-message` Item, the matching strict S39 trace and digest, and optional exact registered-Source or directly `user-authored` Knowledge-Page references. Imported history and accepted generated Pages are not new proposal evidence. Other evidence must first use the existing explicit source-registration owner. The later delivery proof remains an S39 system predicate; this plan does not add a Context Package read operation merely for reflection.
- Treat the reviewing agent's analysis as advisory. Human Knowledge Review remains the only activation authority.
- Missing history, unavailable source bytes, provider failure, contradictory lineage, or an already changed target returns a typed unavailable, conflict, or `recovery_required` result through the existing owners; it creates no private retry or recovery state. A user may make a new authorized attempt.

## Non-Goals And Deferred Work

- No persistent Reflector, passive hook, event subscriber, recurring reflection, private run/session/checkpoint, or automatic retry.
- No provisional auto-promotion, TTL, citation counter, citation-based self-confirmation, or sweep.
- No generic `ImprovementProposal` record or lifecycle; each future target uses its own Knowledge, Skill, Artifact, Review, Approval, or specification owner.
- No EvalTask, suite, evaluation area, frozen Harness, Judge Cell, A/A injection, health sweep, trajectory platform, evaluation dashboard, or new acceptance runner.
- No Skill Catalog, prompt-template versioning, runtime Skill mutation, cross-Workspace graduation, catalog import/export, or pin lifecycle until a real worker Skill and repeated proposal demand exist.
- No generic historical reconstruction. Existing retained S39 bytes are usable; missing or drifted history is unavailable and does not repair delivery authority.
- No Goal-mode Knowledge integration, worker `knowledge.*` capability plane, semantic/vector retrieval, external crawling, general notebook editor, or Web projection in this package.
- No recurring Automation replacement. The current non-executing Automation facade is handled separately rather than becoming a trigger platform inside G07.

## Starting Baseline (2026-07-19)

- C12, S60 and S61 already have a substantial file-backed V1: governed Markdown projections, sources, observations, claims, conflicts, deterministic derived indexes and retrieval traces, explicit Knowledge Manager operations, proposal review, Core Client, CLI and Skill projections.
- Task Mode calls a second substring selector, carries only Knowledge ids in its worker request, and S39 currently ignores those refs when building worker-visible files. Goal Mode does not select Knowledge.
- Standalone Knowledge preparation persists a separate `ctxpkg_${operationId}` trace and materialization that cannot prove accepted worker delivery. S39's `ctxpkg_${turnId}` trace is the sole accepted delivery owner.
- Public Knowledge Manager bodies still accept stale caller values, some caught failures expose raw messages, active writes are validated only during later index rebuild, generic accepted proposals do not apply page content, and claim-backed acceptance can persist the review before the page effect.
- S18 is Accepted / Partial as the explicit existing-operation composition. S19, recurring triggers and Skill Catalog remain Draft / Not Started, and no Reflector, Harness, Judge, evaluation records, recurring trigger records, Skill Catalog records or ImprovementProposal records exist.

## Entry Gates

- WP-5A must exit through its separate owning plan before any G07 production change begins.
- One useful completed direct-Task history and one review, feedback, redo, refinement, or correction signal must already be retained through existing owners before Stage 1 production implementation begins. Synthetic fixtures, a skipped story, or history created by a G07-only runner do not satisfy this gate; Stage 2 consumes the same history.

## Execution Plan

### Stage 0 — Authority correction

- Rebaseline S18 while keeping the three formerly proposed prerequisite Drafts — S19, recurring triggers, and Skill Catalog — as non-authorizing future boundaries rather than WP-6 prerequisites.
- Reconcile S17, S60, S61, S39, C03, roadmap and current projections with the frozen V1 and bounded fallbacks.
- Make documentation-only authority corrections and record the bounded G07 preamble; do not change production code, tests, generated contracts, or runtime state in this stage.

### Stage 1 — Knowledge correctness and accepted delivery

- Land tests first for exact internal callers, client-override rejection, product-safe errors, save-time validation, coherent index-to-page retrieval, idempotent create-only proposal application, bounded reversal, and the single governed retrieval owner.
- Delete `knowledge.claim-promote` and worker-control `knowledge_proposal_summary` end to end without aliases. Accepted Claims remain readable evidence for the one ordinary `knowledge.proposal-draft` producer.
- Extend the existing S39 Task package/trace and strict verifier with Knowledge bytes, content digest, source references and package path; delete the standalone Knowledge context trace, readback and materialization routes and projections without aliases.
- Run focused protocol/schema/NanoCore/Client/Skill suites and one existing Task black-box path. Do not add Goal or Web scope.

### Stage 2 — Real explicit loop

- Through the existing unified Skill/CLI and stock OpenShell path, use the retained useful completed Task and its review, feedback, redo, refinement, or correction signal from the entry gate.
- Explicitly review that exact history, draft one source-linked create-only Knowledge Proposal, obtain a human decision, run one later Task that receives the accepted page through S39, then reverse the proposal-created page.
- Record only durable owner evidence and one curated checkpoint; no new story runner or harness.

### Stage 3 — Closeout

- Run affected-package suites, repository gates and the owning package-exit verification once.
- Perform a deletion-first review for duplicate selection, delivery, proposal, recovery, runner and lifecycle ownership.
- Update this plan, the Execution Program and the alignment audit with exact evidence and remaining roadmap handoffs; close WP-6 only when every inherited G07 exit predicate is proved.

## Verification

- L1/L2: exact callers, override rejection, safe errors, write validation, deterministic retrieval, proposal application/reversal, S39 serialization and strict verification.
- L3: one existing direct-Task path proves one active valid Knowledge page enters the exact accepted package and one invalid or restricted candidate does not.
- L6: one agent-first real-use loop on the existing Skill/CLI and A1 surface; a skipped or synthetic story is not acceptance evidence.
- Package exit: affected package suites, generated contract checks, `CI=true pnpm run check:repo`, `git diff --check`, and one deletion-first review. `verify:full` runs only once at exit.

## Risks And Bounded Compromises

- Manual reflection may be missed; this is accepted until real use proves cadence is worth a trigger owner.
- V1 generated proposals are create-only. Meaning-changing updates, merges and generalized revision history remain with later S60/S61 work.
- A missing retained S39 snapshot makes historical reflection unavailable; V1 does not reconstruct across owners or repair accepted delivery.
- Agent judgment may be wrong. It remains advisory, source-linked and pending until a human decides, and the created page has one bounded reversal path.
- Content digests identify the exact selected V1 page bytes. A general Knowledge revision model is deferred until update/merge use proves it necessary.

## Checkpoints

- 2026-07-11 — Original broad plan created; implementation not started.
- 2026-07-19 — G07 preamble completed. The plan was reduced from eight cross-system build stages to existing-owner correctness plus one explicit human-reviewed loop; the real-history and provider/effect entry gates remain open.
- 2026-07-19 — Stage 0 exited docs-only after contract, minimality, lifecycle, documentation-model, repository, index, and whitespace checks. Exact proposal replay, source/review identities, live S39 projection, index coherency, output isolation, and deletion of duplicate proposal producers are frozen; WP-5A is active and no G07 production or test change has begun.
- 2026-07-19 — The real-history entry gate passed on disposable A1 through stock OpenShell `0.0.80` and Codex `0.144.1`. One useful direct Task retained a completed Turn, one completed assistant Item, strict-verifier-confirmed S39 bytes and digest, normal runtime evidence, and one meaningful positive feedback record; the source repository remained clean and whole-Cell cleanup returned zero containers and sandboxes.
- 2026-07-19 — Three entry-path defects were reduced without expanding G07: OpenShell exec arguments are newline-free, the existing story supervisor is the sole request deadline, and the Codex adapter creates its isolated `0700` home before launch. Commits `4b8f55f`, `51d12b7`, `e0d13f5`, `14e9c82`, `13f856b`, and `0c0ebcb` passed their focused or package suites. Stage 1 is active.
- 2026-07-20 — WP-6/G07 implementation closed through `fb67760`. S17 and S18 are Implemented; the verified S60/S61 slice selects accepted pages through one governed S61 path, materializes exact bytes and lineage through the existing Turn trace, and retains bounded fail-closed recovery and reversal without another durable owner. The later WP-7 inventory correctly keeps S60/S61 Partial until retrieval consumes unresolved conflict authority.
- 2026-07-20 — One disposable-A1 stock OpenShell/Codex loop used retained completed work to draft an exact source-linked proposal, applied it only after human acceptance, selected and delivered the accepted page to a later Task, observed the expected governed value after explicitly directing the worker to consume the package index, reversed the unchanged page, and then observed no selection. Runtime provenance passed, the checkout stayed clean, and cleanup left no listener or sandbox.
- 2026-07-20 — The final independent authority review found three fail-closed gaps and closed them test-first in `14b9986` and `ec410c9`: imported history cannot claim new local completed work, accepted generated Pages cannot form a proposal-evidence chain, and an accepted Page id remains permanently reserved against later generated proposals after reversal. These are bounded V1 compromises over existing owners, not new revision, dependency-graph, settlement, or recovery mechanisms.
- 2026-07-20 — Follow-up minimality review removed one over-tight historical-source check in `ec181cd` and `fb67760`: a human direct edit converts current bytes to `user-authored` and may then serve as evidence after current local references verify, while an unchanged `accepted` generated Page still fails closed. No compatibility or transitive authority path was added.

## Implementation Summary

WP-6 corrected only the existing Knowledge owners. NanoCore now assigns exact Knowledge Manager callers, rejects caller overrides, redacts public failures, validates page bytes before mutation, routes every read and Task selection through S61, freezes create-only proposal bytes and lineage, applies the one bounded accepted-review missing-page effect, reserves every accepted generated Page id against later generated proposals, reverses only an unchanged proposal-created page, and projects exact selected Knowledge bytes through S39. New proposals may cite registered Sources, current directly `user-authored` Pages, or one strict local completed-work trio; imported history remains read-only and unchanged accepted generated Pages do not create a transitive authority graph. A human direct edit revalidates current local references and replaces the accepted label with `user-authored`; external work-history references fail that Store-local edit rather than gaining inferred authority. Duplicate claim promotion, worker proposal production, standalone Knowledge context traces, and standalone materialization surfaces were deleted without aliases. No reflection endpoint, persistent evaluator, trigger, scheduler, settlement or recovery workflow, revision family, runner, Harness, fork, patch, compatibility path, or dependency was added.

## Final Verification

Focused Knowledge, proposal, review, retrieval, portability, and S39 suites passed together with the complete NanoCore suite, NanoCore typecheck, lint, format, and build, App API schemas, Agent Skill interface, generated OpenAPI validation, repository checks, and whitespace checks. The A1 L6 loop ran against stock OpenShell `0.0.80` and Codex `0.144.1`, proved exact completed-work lineage, human-only activation, S39 worker-visible delivery, bounded reversal, runtime provenance, clean Git state, and zero residual sandboxes. Goal-mode Knowledge selection remains separately deferred outside this package's accepted scope; S39 remains Partial only for broader candidate-audit and worker-output citation projections, which are not WP-6 or G07 exit criteria.
