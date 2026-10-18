---
type: change-plan
status: in-progress
---
# Typed Knowledge Pages

## Intent Revision 1

The coordinator assigned the bounded C04/C05 reset-cohort increment on 2026-10-19: admit governed Rule, Effect and business Objective pages through existing notebook publication, and refuse competing Procedure page authority. Work starts from landed main `29258b5a66b21a50408c2c0573326c0fc096c33f`. The coordinator owns independent review, consumer dispatch, complete feature verification and landing. This increment performs no reset, host, Web or CI dispatch action.

## Owners And Scope

[Information consolidation](../../specs/20261018-nanocore_interception_and_information_consolidation.md#information-and-record-authority), [Knowledge](../../core/knowledge.md), and [notebook editing](../../specs/20260909-knowledge_notebook_editing.md#final-tree-validation-and-multi-page-operations) own the accepted behavior. The existing profile, ScopeSchema and fixed-base final-tree validator remain the admission path. No conversion, legacy reader, new store, lifecycle or prose classifier is introduced.

## Shape And Ablation

- `type` identifies Rule, Effect or Objective as a ScopeSchema domain type; without it, type-aware selection cannot distinguish the accepted domain meaning.
- `applies_to` is a nonempty list of nonempty declared tool or work-step identifiers; without it, applicability selection cannot determine which tools or steps the page concerns.
- Effect `basis` is a nonempty descriptive string; without it, an Effect has no stated basis for its reusable understanding.
- Effect `last_checked_at` uses the existing offset ISO timestamp rule; without it, an Effect does not state when its basis was last checked.

These fields retain ordinary scope, source, sensitivity, freshness and review governance. Descriptive extensions remain data. Applicability, Effect basis and retrieved rules grant no authority. Procedure is permitted as external OKF input but refused at governed ScopeSchema and page admission, including authored schemas. Descriptive Topic context and exact Skill references remain valid.

## Working Checkpoint

The isolated writer owns only the dispatched OKF implementation/tests/local guide, this plan, and the specified C04/C05 owner paragraphs. The first deciding regression is `typed-knowledge-pages.test.ts`, which exercises the existing final-tree publication validator and shared candidate diagnostics. Expected red evidence is default refusal of valid Rule/Effect/Objective pages, absent typed-field validation under authored schemas, and admitted Procedure authority. Dependency setup and the focused regression run are next. A pushed shape candidate will go to the coordinator before any complete feature gate.
