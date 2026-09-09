---
type: change-plan
status: verified
date: 2026-09-09
completed: 2026-09-09
---
# Personal Assistant, Memory And Shared Knowledge Design

## Intent Epoch 1

Source: the engineer's current request and preceding accepted discussion. Commit the complete pre-existing work before this revision; then the primary personally writes and edits documentation, an independent Claude Code Agent is consultant, and independent sub-agents review and audit. Do not modify Product Vision. Defer Pi selection until after this work. This is design and documentation, not production implementation or a release.

The Assistant is a Personal Assistant with private continuity, governed Workspace capabilities and a management entry path over the shared internal runtime. It can consume admitted MCP and Skills. Current requesting-user authority determines operations: active membership permits ordinary Workspace and Light App operations; usable administrator authority permits corresponding deployment administration. Neither a private conversation nor a shared answer grants additional authority. Quick Chat and Assistant/management conversations default to private; Task and Goal work default to Workspace sharing; broader disclosure and private-to-shared handoff are explicit.

User-scoped reusable information is called Memory to emphasize personality. Workspace- and Server-scoped reusable information is called Knowledge. Skill is another representation of valuable learning: procedural instructions and optional code, with existing candidate/version/comparison/promotion/rollback ownership. Reuse Open Knowledge Format and existing knowledge mechanisms, rather than adding a separate Memory engine. Use Codex Memory and Dreaming as reference for automatic extraction, proposals, evaluation and records; users can inspect and edit. Optional AI prove may assess important information and Knowledge. Do not misrepresent automatic proposal production, comparison or assessment as evidence of truth, authorized promotion, or already implemented A/B infrastructure.

## Owners And Write Ownership

The primary is the sole writer of this plan and all canonical Core, specification, Roadmap, index and local-guide changes. Claude is read-only consultant in Herdr `personal-consultant`, session `cd1b7369-60f5-4e09-bc95-aba116e8fb85`. Independent reviewer and auditor may write only assigned temporary evidence files and inspect the actual diff. No production paths or Product Vision are assigned. [Knowledge Core](../../core/knowledge.md), [Permissions](../../core/permissions.md), [Assistant](../../specs/20260704-chat_mode_assistant.md), [Thread Visibility](../../specs/20260909-thread_visibility_and_sharing.md), [Scoped Learning](../../specs/20260909-personal_memory_and_knowledge_learning.md), and existing storage, Skill, audit, portability and command owners hold design authority; this record holds none.

## Baseline Evidence

Before any current-round document edits, commit `ec3c61e0` saved the previously reviewed deployment and recurring-scheduling design plus the requested old-plan status correction. `git status --short` then returned empty. Documentation model validated 238 documents; lifecycle and index checks passed; 22 root/governance tests passed; `git diff --check` passed. That commit does not implement B1/B2 or the work below.

## Checkpoint

Current phase: documentation design verified. The primary completed the canonical edits; independent Claude consultation closed material objections, the independent reviewer accepted the exact design for coordinated lifecycle promotion, and the auditor found no remaining intent mismatch. Both new owners are Accepted / Not Started. The existing Assistant and Knowledge implementation projections remain Partial; S18 now explicitly records its pending scoped request-identity adaptation. No production implementation, Product Vision change, Pi decision or current-round commit is part of this closeout.

The initial proposal is uncommitted at `temp/changes/202609090420370001-personal_assistant_memory_design/proposal.md`. Codex reference inspection is pinned to source commit `44918ea10c0f99151c6710411b4322c2f5c96bea` from the existing local research checkout; it is evidence of that snapshot, not a claim about current hosted Codex behavior. First-slice delivery and larger accepted extensions will be distinguished in owning specifications.

## Intent Epoch 2

Clarification of Epoch 1 shorthand against the same engineer discussion: Task and Goal work is Workspace-shared, not an optional private execution mode; default language applies to personal conversations. Skill means procedural reusable instructions and optional supporting code, not an arbitrary alternative home for facts or personality. The primary's concrete fields, bounds and rollout order are design choices under this drafting commission, not quotations attributed to the engineer.

## Consultation Decisions

Claude identified duplication and concrete lifecycle gaps. The primary removed the newly drafted management specification and merged its finite tool/action contract into the existing Assistant owner. Selected conversation capture reuses Knowledge Source registration. User Memory uses the existing User scope, independently of Quick Chat. Thread visibility is durable classification, while Permissions resolves dynamic audience; the old multi-user blanket shared-record wording is directly amended.

The narrowed learning design reuses existing Proposal/Review/Page/Source/Observation families: exact-base replace retains prior bytes as a registered Source, page metadata carries monotonic revision, multi-scope retrieval has explicit scopes and deterministic tie-breaks, and AI prove records evidence without becoming review authority. Multi-page mutation, generalized rollback, unattended scheduling, new runtime selection and an experiment platform remain outside this slice. Server Knowledge and optional assessment are retained because the engineer explicitly requested them; the consultant's initial suggestion to omit them was not adopted.

Independent falsification also exposed stale cross-owner create-only/absence rules, overly broad MCP implementation substitution, and missing disclosure/forget boundaries. Corrections preserve completed-Worker reflection as its own create-only composition while the shared command supports exact replacement; third-party bindings may implement only the two bounded read semantics in the ordinary Assistant entry. Sharing stages an inaccessible destination tuple before one publication barrier; forgetting uses the existing exact-target confirmation. Authority-bearing records require registered feature admission before writing or import. No User re-enable or hard-deletion lifecycle is introduced.

Claude reread the corrected bytes and returned no remaining material objection; its final bounded verdict is retained at `temp/changes/202609090420370001-personal_assistant_memory_design/claude-consultant-final.txt`. Independent reviewer and auditor findings are corrected in the actual owners before lifecycle closure. The original five findings, then the S18/Knowledge Manager/MCP follow-up findings, are retained in temporary evidence rather than promoted as a second design document.

## Implementation Summary

This documentation-only change settles Personal Assistant management, private/shared Thread disclosure and User Memory/scoped Knowledge learning in their existing owners plus two accepted implementation specifications. Production implementation remains pending.

## Verification Evidence

Independent evidence is retained under `temp/changes/202609090420370001-personal_assistant_memory_design/` in `reviewer.md`, `auditor.md` and `claude-consultant-final.txt`. The reviewer inspected the actual corrected bytes and accepted the coordinated lifecycle transition; the auditor independently traced scope, privacy, learning, ownership and current implementation. No content finding remains open in this design slice.

Final verification: documentation model validates 241 documents; specification lifecycle and generated index checks pass; AgentSession terminology passes 2 tests; all 144 local Markdown link targets across 33 changed documents resolve; `git diff --check` passes. Product Vision, apps, packages, scripts and tests have no current-round diff. The baseline remains commit `ec3c61e0`; this round remains an uncommitted documentation change for engineer inspection.

Implementation is the next separate change and must retain the owning specifications' staged scope and required migration, current-authority, private-data, writer-fence and interrupted-effect checks. B4 is design-clear but not implemented. B6 is clear for bounded single-page learning; multi-page/generated archive and related full-R072 decisions remain outside this change. Pi runtime evaluation remains deferred to the engineer's next discussion.
