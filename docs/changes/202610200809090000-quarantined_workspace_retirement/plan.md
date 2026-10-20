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

The accepted owner amendments preceded implementation. The independently authored two-file regression commit `c0506298a5fc31cb585e2ddc80195a1f45b33b49` was inspected and merged normally. It reached 25 behavioral failures and four passing controls against unchanged production; missing-route refusals are not accepted as completed retirement behavior. The implementation now reaches retained-byte, runtime-fence, transaction rollback, exact-replay, personal-identity and populated Core-upgrade assertions. A cleanup identity predicate must align with the existing `target` contract; actual process boot-order proof and exact-candidate CI remain open. Existing cleanup-source and migration-inventory fixtures also require independent alignment with the accepted new source and migration, without reducing any invariant or limit. No live operation, deployment or Host action is part of this change.

## Next Action

Complete independent oracle alignment and process boot-order proof, inspect the exact implementation and generated projections, then qualify the exact candidate through the required branch CI. Preserve the announced file boundary and shared write leases until explicit handback. Report exact check results and any remaining limitation; do not treat this implementation checkpoint as accepted or ready to land.
