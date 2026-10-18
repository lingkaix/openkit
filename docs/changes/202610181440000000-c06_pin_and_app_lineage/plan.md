---
type: change-plan
status: in-progress
---
# Skill Pin And Light App Execution Lineage

## Intent Revision 1

The coordinator approved the L-GO C03/C04/C06 plan on 2026-10-18 at 14:40Z. This increment implements only additive C06 A13/A15. A current Skill pin must identify its winning command, including repeated identical pins. A Light App mutation must retain its actual executing Turn when trusted invocation supplies one. Existing Audit fields and record owners remain authoritative. Reset-dependent app/domain separation and procedure-owner changes are prepared separately and cannot land before the coordinator announces the pre-reset cut.

## Owners And Write Boundaries

[Information Consolidation](../../specs/20261018-nanocore_interception_and_information_consolidation.md) owns C06. [Skill Versioning](../../specs/20260711-skill_catalog_versioning_pinning.md) owns pins and selected-version lineage. [Kernel Operations](../../specs/20260908-generative_kernel_data_operations.md) owns app-local mutation evidence. Audit and current invocation admission keep their existing owners.

L-GO owns catalog pin publication, its read projection, Kernel command context and operation joins. L-AK agreed the seam and alone writes Knowledge paths. L-RT owns AEP/runtime consumer paths and the single C04 no-private-procedure-copy regression. L-CH owns the mediation Audit and Policy schema edits; this change does not edit those files. The A15 helper writes only its separate Kernel/operation worktree and branch, which is merged rather than cherry-picked.

## Field Necessity

| Field or populated edge | What fails without it |
| --- | --- |
| Optional SkillPinRecord.pinAuditRef | Repeated same-digest pin commands cannot be joined uniquely to the actor/request that published the current pin. |
| Optional catalog Skill summary pinAuditRef | Authorized App, CLI and other catalog readers cannot inspect the retained current pin-to-command edge. |
| Trusted Kernel command execution context | The operation-to-Kernel join drops the actual executing Thread/Turn before the app transaction. |
| Existing app Audit.threadId and Audit.turnId | Generic mutations retain only request/actor and cannot join to the actual executing work. |
| AEP pin-selection reference, owned by L-RT | A later pin command can replace the live pointer, so historical selected work needs its observed winner rather than a lookup of the current catalog. |

## Implementation And Failure Boundary

Pin publication points to the existing command admission Audit, written before the catalog publication. A new same-digest pin replaces the edge, receipt replay does not republish it, and clear removes the live pin without deleting history. Direct native setup without an Audit reference remains unknown. Existing readers preserve additive annotations. The public read exposes known evidence only. Portable source pins remain historical and import creates no target pin or authority.

Kernel context uses trusted Worker or internal invocation lineage and validates the owning retained Thread/Turn. Human presentation context is not an executing Turn. Existing app-local Audit writes remain in the mutation transaction; no new table, record family or cross-store transaction is introduced. Historical absent links remain unknown. No timestamp, string similarity, current pin or presentation Item is used to invent an execution edge.

## Verification And Landing

Write regressions before production edits. The cheap baseline pin-schema probe must show that existing pins parse while the proposed pinAuditRef is refused as unknown. Native tests exercise repeated pins, exact actor/request joins, read projection, replay and clear. Kernel tests inspect actual app Audit rows for trusted execution and absence for human presentation actions. Run complete affected module directories, changed package suites and shared inventories through the exact local gate; generate and check OpenAPI/CLI projections. Independent Sol review names the final head and checks each field necessity above. Land additively by express on green main, then watch the containing main CI. This change performs no host, reset or release action.
