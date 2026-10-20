---
type: change-plan
status: in-progress
date: 2026-10-20
---
# Retained Workspace Retirement

## Intent Revision 1

Source: engineer approval on 2026-10-20. Implement retained-only retirement for a quarantined Workspace. Retirement keeps all data and reclaims no storage. Operations must present it as distinct from deletion. Amend the owners before implementation, establish independent contract-derived failing tests, and qualify the exact candidate before landing.

## Authority And Boundary

The [Workspace lifecycle specification](../../specs/20260715-multi_user_workspace_system.md#retained-retirement-of-a-quarantined-workspace) owns the operation and registry lifecycle. [Audit and evidence](../../specs/20260703-audit_usage_evidence_records.md), [storage](../../core/storage.md) and [boot](../../specs/20260704-nanocore_bootstrap_readiness.md) preserve retention and exclusion. The [decision](../../decisions/20261020-quarantined_workspace_retirement.md) records the reason and rejected alternatives.

Use the existing Core registry, command receipt, AuditEvent and Workspace mutation gate. Do not add a request family, runner, timer, automatic retry, cleanup effect or repair. No Workspace content admission, export, directory move/removal, storage reclamation or capacity release is authorized by this operation. Current administrator authority and exact identity/revision remain strict.

## Verification

Independent tests must reach the native operation and actual Core authority on the unchanged implementation. Import or collection failures do not establish behavioral failure. Cover missing/corrupt Workspace authority, healthy siblings, current authorization, exact replay/conflict, transaction interruption, lost reply and restart. Preserve complete retained bytes, holds, reservations and runtime fences. Observe no Workspace open or Host effect. Check the bounded administrator projection and ordinary admission after retirement and restart.

Focused checks follow the changed packages. Complete qualification uses the exact candidate's existing four-part NanoCore CI and other affected gates. A partial pass or interrupted run is not complete qualification.

## Current Checkpoint

The accepted owner amendments are recorded. Independent regressions are in progress against unchanged production; implementation remains pending. The additive Core migration must retain existing records and all prior migration bytes. No live operation, deployment or Host action is part of this change.

## Next Action

Establish independent behavioral failure, then implement the smallest registry-only path and reconcile each affected projection. Report the actual changed-file boundary before expanding it, inspect the final artifact and named execution output, and retain unresolved findings explicitly.
