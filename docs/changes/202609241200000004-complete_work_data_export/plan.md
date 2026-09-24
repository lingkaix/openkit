---
type: change-plan
status: planned
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

## Working Checkpoint

Status is planned. Facts observed on 2026-09-24 by independent review: apps/nanocore/src/storage/workspace-export.ts converts restricted bundles into expired, reference-free records; apps/nanocore/src/storage/workspace-import.ts rejects portable work-observation bodies unless they are expired and reference-free; apps/nanocore/src/storage/workspace-export-observations.test.ts pins that omission. Those tests encode the superseded rule and change with the owner. Unknown: how restricted bodies are stored relative to their EvidenceBundle, and whether import can restore them under the target's evidence retention without a new record family.

Predicted Next Action: a test author writes the round-trip regression from the amended owner before any code changes: starting from the existing real-storage composition fixture, export a Workspace whose Turn holds a restricted original body, import it into a new Workspace, and assert that the body bytes and content digests are identical and that the references are correctly reminted and resolve to the corresponding bodies in the target, including a remint collision case, with parent and reference closure intact and excluded external references left unresolved; that the imported body keeps its retention class, sensitivity, hold state, and original expiry; and that another user's private Thread and secret material stay absent and no other product API exposes the body. Expected observable: the regression fails on the current code at the export step. Evidence that would change the route: body storage that cannot be carried without a new portable record family, which returns to the backup/export owner first.

## Verification Direction

Name the seam between export collection, the portable package, and import restore, and cover it with an in-process composition test with fault injection at the crossing, as L2 requires. Keep held, unavailable, and expired content on its existing path, and keep the audience and secret exclusions as negative cases. Run the NanoCore storage suites and the repository gates in proportion.
