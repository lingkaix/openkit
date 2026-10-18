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

The new focused regression exercises the actual candidate and final-tree validators. Expected red on the unchanged base is that default Procedure admission and authored/direct schema bypasses remain accepted. External Procedure parsing and descriptive Topic/context with exact Skill references must remain accepted. Dependencies and the baseline Protocol build will be checked in the same shared-slot acquisition as that deciding red. Source changes wait for the actual red result. Root owns independent review and the complete integration gate; no producer result accepts this artifact.
