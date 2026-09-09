---
type: change-plan
status: verified
date: 2026-09-09
---
# Unified Knowledge Notebook Design

## Intent Epoch 1

The engineer's 2026-09-09 discussion rejects per-operation maintenance machinery that limits Agents and accepts one stable notebook foundation for User Memory and Workspace/Server professional Knowledge. The requested notebook is jointly maintained by humans and Agents, uses structured OKF files and active-state default retrieval, permits batch editing/merge/split through a confined just-bash workspace, and retains Git diff/history. The engineer then explicitly accepts the proposed fixed-base editing, final-tree validation and version publication scheme and requests implementation-ready canonical documentation, independent Claude Code consultation, independent reviewer/auditor scrutiny, and a final commit. The accepted proposal includes ordinary automatic publication after scope-bound maintenance authorization, with critical content and sensitive actions retaining required human decisions. This replaces mandatory human Review of every generated edit; it does not waive scope, source confidentiality, data preservation or destructive-effect authority.

## Owners And Method

Primary alone writes canonical docs. Knowledge Core owns meaning and authority; S60 owns profile/governance; S61 owns storage/retrieval effects; the notebook editing specification owns bounded edit/publication/history composition. Knowledge Manager, scoped learning, storage, portability, S39 delivery, Policy and Web keep their responsibilities. Claude is a read-only consultant. Reviewer and auditor write only their named reports in the matching temporary change directory. Product Vision, production code, dependencies and agent configurations are excluded.

## Checkpoint

Started clean at `298bcc4c`. Source research is pinned under `temp/research/20260909-knowledge-maintenance/`: Codex `9e868bd9dc007c05e84a98e0b1f4e31dc98c5e6a`, just-bash `062ce005c0a7676163852fb6f0c8590cbdaa1d45`, and a passed Git publication primitive probe. Codex's destructive single-baseline reset is not retained notebook history; just-bash OverlayFs is copy-on-write but not a fixed snapshot. Reuse the existing Knowledge publisher and command/evidence owners, add neither a second runtime nor a per-operation maintenance workflow. The initial proposal preserves published commit identity, base checking, source restrictions and attributable changes while removing duplicated page revision/full-byte history mechanisms.

## Closeout Scope

The implementation-ready design is complete; independent final review is complete and the new specification is Accepted / Not Started. The authorized documentation commit closes this work. This change implements documentation, not the runtime feature. Subsequent implementation must replace live-page writers/readers together and prove filesystem durability, virtual-filesystem confinement and current source authorization; the primitive Git probe does not prove those properties.

## Implementation Summary

Added the notebook editing owner and reconciled Knowledge Core, profile/storage/retrieval, scoped learning, Knowledge Manager, internal capability admission, configuration, portability, S39 delivery, Web projection and Roadmap. One retained Git history replaces the proposed page counter and duplicate prior-page Source copies. Ordinary delegated publication and required exact human decisions share one publisher. Stable published paths, archive/supersede and new pages support organization without a rename/identity engine. Source evidence remains separate; history restore appends a revision and forgetting suppresses current/historical disclosure without claiming physical erasure. B6 is design-resolved; R071/R072 remain unchecked implementation work.

Independent Claude consultation closed immutable-candidate authority, commit metadata parsing, candidate retention, path identity and bounded repair concerns. Independent intent audit verified the original accepted discussion and closed the candidate/Review cycle, all-state single-index search and required-feature alignment. Reviewer feedback removed implementation detail from Core, aligned draft repair authority and kept retrieval/index authority exclusively in S61. Their exact reports remain uncommitted in `temp/changes/202609090924450001-knowledge_notebook_design/`; neither reports nor this plan supply design authority. Canonical writing was primary-only.

## Canonical Owners

- [Knowledge Core](../../core/knowledge.md)
- [Notebook editing](../../specs/20260909-knowledge_notebook_editing.md)
- [Knowledge implementation](../../specs/20260703-knowledge_store_implementation.md)

## Verification Evidence

Independent Reviewer returned Continue after inspecting the actual diff, surrounding implementation and final corrections, including fresh-scope initialization. Auditor returned Continue after direct source-intent and protected-path checks. Claude Code Consultant returned Continue after narrow reinspection of its resolved findings. No consequential finding or engineer decision remains open in this documentation scope.

Observed focused checks: `node scripts/validate-doc-model.mjs` passed (245 documents); `node scripts/validate-spec-lifecycle.mjs` passed; `node scripts/generate-doc-index.mjs --check` passed; `node scripts/validate-agent-interface-reachability.mjs` passed; `node scripts/validate-agent-session-terminology.mjs` passed (2 tests); `git diff --check` passed. Canonical backtick document references in all 20 changed Markdown files resolve. The final metadata/index transition is checked again before commit. Product Vision, root AGENTS, production apps/packages, tests/scripts, dependencies and agent configurations have no diff from `298bcc4c`.

No runtime tests, dependency installation, deployment or external publication were performed. Source research, probes and independent reports remain uncommitted under `temp/`; no generated evidence becomes design authority. Runtime confinement, Git crash durability and coordinated storage/API cutover remain subsequent implementation acceptance work. The commit containing this verified plan is the documentation closeout; no push is requested.
