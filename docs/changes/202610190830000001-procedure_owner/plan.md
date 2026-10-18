---
type: change-plan
status: in-progress
---
# Skill Procedure Ownership

## Intent Revision 1

The coordinator's post-Astra reset ruling separates C04 Procedure refusal from new additive C05 page types. Implement only C04 from `29258b5a66b21a50408c2c0573326c0fc096c33f` on `lane/ak-procedure-owner`; retain `lane/ak-typed-knowledge-pages` at `a60e3404b22fcea0583a28a0211e6074ef143433` as a frozen future C05 reference. Rule, Effect and Objective defaults, fields and retrieval activation are outside this branch. Claim/Observation work, reset, landing, CI, host and Web actions remain outside this task.

## Owners And Method

[Knowledge](../../core/knowledge.md), [information consolidation](../../specs/20261018-nanocore_interception_and_information_consolidation.md#information-and-record-authority), [notebook publication](../../specs/20260909-knowledge_notebook_editing.md#final-tree-validation-and-multi-page-operations), and [Knowledge governance](../../specs/20260702-knowledge_store_governance_rules.md) own the boundary. The existing parser, ScopeSchema admission and final-tree publication validator remain the implementation seam. Removing Procedure from default types prevents ordinary competing page authority; explicit schema/page refusals prevent authored or in-memory schemas from restoring it. Without the explicit refusals, a permissive schema bypasses Skill ownership. No prose classifier, retained field, new store, conversion or legacy reader is introduced.

## Checkpoint

The focused regression exercises the actual candidate and final-tree validators. On the unchanged base, the Protocol build passed and the deciding red observed four intended failures: default Procedure remains allowed, governed Procedure publication remains allowed, authored schemas can admit it, and an in-memory schema can bypass Skill ownership. The two external parsing and descriptive Topic/reference controls passed. Evidence is `temp/changes/202610190830000001-procedure_owner/red.log`; the command was `pnpm --filter @openkit/protocol build && pnpm --filter @openkit/nanocore exec vitest run src/knowledge/procedure-owned-by-skills.test.ts`, through the shared weight-one runner with Node 24.18.0 and pnpm 10.33.3. Only after that observation, `okf.ts` removed Procedure from the default base set and added the two deterministic schema/page checks. No C05 or Claim fields were added. Root owns independent review and the complete integration gate; no producer result accepts this artifact.

The weight-one focused batch passed all 130 tests in five complete files in 30.53 seconds: `pnpm --filter @openkit/nanocore exec vitest run src/knowledge/procedure-owned-by-skills.test.ts src/knowledge/okf.test.ts src/knowledge/okf-scoped-profile.test.ts src/knowledge/notebook-validation.test.ts src/knowledge/notebook-publication.test.ts`. The same batch passed strict TypeScript over `okf.ts` and the new regression using the repository compiler options, Biome, specification lifecycle validation, documentation-model validation over 602 documents, and `git diff --check`. Evidence is `temp/changes/202610190830000001-procedure_owner/green.log`. A final lightweight two-file Biome check reported no fixes. The actual source diff has only default Procedure removal and the two owner-directed refusals; owner/local-guide text covers only C04. All commands are terminal. The source/owner lease releases after the pushed head is reported; independent review, integration and landing remain with root.
