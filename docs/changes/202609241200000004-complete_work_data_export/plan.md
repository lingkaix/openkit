---
type: change-plan
status: verified
date: "2026-09-24"
---
# Complete Work Data Export

## Intent Revision 1 — 2026-09-24

On 2026-09-24 the engineer decided that a portable Workspace export carries admitted original bodies of retained work data, restricted originals included, intact, and that import restores them intact, because export must keep its information complete enough that a re-imported Workspace keeps what it was exported with. Other users' private Threads and system-managed secret material stay excluded, and export never widens who may read a body. [Engineering Governance Landing](../202609231611190001-engineering_governance_landing/plan.md) amended the owners and drafted this plan for the implementation. The outcome is that export and import round-trip every admitted original body without loss. The engineer transfers this plan to a primary before work starts. No commit, push, deployment, or external publication is authorized by this draft.

## Owners

[Workspace Backup Export Import](../../specs/20260704-workspace_backup_export_import.md) owns portable inventory and body inclusion. [Work Data Retention Format](../../specs/20260921-work_data_retention_format.md) owns the work-data families and the export posture. [Audit Usage Evidence Records](../../specs/20260703-audit_usage_evidence_records.md) owns EvidenceBundle retention, hold, and expiry, and the portable-export exception to its restricted-evidence API rule.

## Accepted Decisions

- [Restricted Original Bodies Travel Intact In A Portable Export](../../decisions/20260924-restricted_bodies_travel_in_export.md).
- [Export Does Simple Necessary Processing And Then Exports Completely](../../decisions/20260921-export_simple_and_complete.md).
- [Sensitive Data Is Handled Outside The System Before Each Use](../../decisions/20260924-sensitive_data_handled_outside_the_system.md).

## Closeout

The implementation and independent review are complete. The shared import, lineage test and storage guide changes are split through verified temporary snapshots: export-only content is committed independently, while Goal changes remain in the working tree. Reapplying the Goal-only patch to those snapshots reproduces the exact full-file SHA-256 values; no production bytes were discarded. The independent real-storage regression first failed because restricted body bytes were absent from the export inventory. Export now inventories original binary bytes separately from canonical UTF-8 text; import verifies bundle ownership and digests, remints references, and restores bytes through the existing staging publication path. The known imported EvidenceRef kinds include work-observation-body so restored published content remains readable. Source sensitivity, retention class and creation time survive; no new expiry or hold record family was introduced.

Independent review identified a real failure branch: transcript collection can retain quarantined raw provenance without a normalized index. Import now validates the exact existing failed RuntimeEvidence and source AEP tuple before reminting that branch, rejects multiple raw bundle aliases and backend or digest disagreement, and preserves quarantine. It creates neither a replacement normalized index nor synthetic completed observations. Grok's final actual-source review accepted these guards; the deciding negative cases remain in the lineage oracle.

## Verification

Observed on 2026-09-24: `pnpm --filter @openkit/nanocore exec vitest run src/storage/workspace-export.test.ts src/storage/workspace-export-boundaries.test.ts src/storage/workspace-export-lineage.test.ts src/storage/workspace-export-observations.test.ts src/evidence-bundles.test.ts --reporter=dot` passes five files and 126 tests. Output is temp/changes/202609241200000004-complete_work_data_export/export-all-five.txt. The independent oracle covers exact body bytes, arbitrary non-UTF-8 runtime provenance, missing and tampered binary rejection, remint closure, restart reads, legal-hold retention, expired-body non-resurrection, private-Thread export refusal, stored Vault secret exclusion and public-list exclusion. Goal portability cases preserve the original source digest so an imported pending successor cannot silently regain approval against reminted source evidence.

Raw complexity: the focused export commit changes eight files, amends no normative document, and touches three accepted concern owners: portability, retained work data, and EvidenceBundle lifecycle. It adds no dependency, record family or registry. One existing known EvidenceRef-kind set gains work-observation-body, which the existing retained-content owner already defines. The separate Goal import extension is not counted in this export-only slice. Repository-wide checks remain with the active handoff; no deployment or publication occurred.

## Verification Direction

Name the seam between export collection, the portable package, and import restore, and cover it with an in-process composition test with fault injection at the crossing, as L2 requires. Keep held, unavailable, and expired content on its existing path, and keep the audience and secret exclusions as negative cases. Run the NanoCore storage suites and the repository gates in proportion.

## Intent Revision 2 — 2026-09-28

The engineer clarified that Workspace export targets external analysis, evaluation, and audit; lossless re-import into OpenKit is not required. Backup / restore will be designed separately. The preceding round-trip checks record completed implementation facts, not acceptance criteria for the next export design. Goal-related export structures remain frozen pending Goal product Redesign. See [the decision](../../decisions/20260928-goal_freeze_and_export_backup_boundary.md).
