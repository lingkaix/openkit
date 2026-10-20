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

The accepted owner amendments preceded implementation. The independently authored two-file regression commit `c0506298a5fc31cb585e2ddc80195a1f45b33b49` was inspected and merged normally. It reached 25 behavioral failures and four passing controls against unchanged production; missing-route refusals are not accepted as completed retirement behavior. The later test-only commit `e4a41924eb80f4e6f3f94c25bf4b0fd0bae16da0` was inspected across all five authorized test files and merged normally. It corrects the cleanup identity predicate to the existing `target` contract, aligns the accepted seventh source and exact Core0012 inventory, and adds only the exact fault-injection test-path allowance. The general source-DDL scanner and the 100-item/262144-byte limits are unchanged.

The integrated retirement and surrounding checks pass 296 NanoCore tests across fourteen files, 58 shared-schema tests, 14 Web cleanup-panel tests and 93 root operation-inventory tests. Four real-process cases execute the actual source boot entry: the active-registry control changes a retained running CapabilityCall, while retired readable, corrupt and missing authority preserves target bytes and permits healthy-sibling HTTP progress. The original in-process restart checks remain separate coverage. Native retained-byte, hold/runtime-fence, transaction rollback, exact replay, personal identity and populated Core0011-to-Core0012 upgrade assertions pass. Affected production typechecks and test governance pass. The independent explicit test-type comparison reports no introduced diagnostics; its eight inherited broader-fixture diagnostics remain outside this change, not a clean broad test-type result.

The first exact-candidate CI run was not accepted: it found the missing existing Web projection and stale operation/migration fixtures. Independently authored commits `24b1e1e8ba46d77dfefae853af58d37a20eac04b`, `f34d419edc2e01101b69216f4c338e807db584e5` and `496bd6cffce5577052a4651a994dc865483b148d` align those consumers without removing assertions or changing limits. The extracted boot phase now receives real retirement restoration and the real mutation gate rather than bypassing either.

After reconciling main `c2fc5cdc8ffaf16f3e7b64cddf3febb2bf2396ca`, calibration showed the raw readonly SQLite status observer itself creates sidecars before the child starts. Independent commit `52cc7e67be2ce04f2e60d4abca967aa5e2714ceb` isolates each stopped-database observation on a fresh directory copy, including all retained journals. It adds exact source path/byte equality around every observation; all original process, status, inventory and hold assertions remain unchanged. The complete integrated focused checks above pass in the provisioned checkout. Supplemental explicit test-type checks retain their reported inherited diagnostics; none is presented as a clean broader check.

One approved replacement exact-candidate CI and coordinator landing remain open. These checks do not qualify a packaged artifact, physical power loss or remote Host lifecycle. No live operation, deployment or Host action is part of this change.

## Next Action

Qualify the final exact candidate through the approved replacement branch CI, including all four NanoCore partitions and Native shards. The actual retirement diff has 41 paths against the reconciled main baseline. Shared write leases were explicitly returned after source publication; no further shared edit is authorized without reacquisition. Inspect the named CI execution output, report exact results and remaining limits, and request coordinator landing only after the required jobs pass. Execution reporting does not satisfy the reserved acceptance or landing decision.
