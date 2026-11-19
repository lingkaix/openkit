---
type: change-plan
status: in-progress
date: "2026-11-19"
started: "2026-11-19"
branch: main
---
# v0.1.0-rc.12 Prerelease Preparation

[Release Management](../../specs/20260829-release_management.md), the [Release Cookbook](../../cookbooks/release.md), [Development Security](../../specs/20261109-development_security.md) and the [standing scratch grant](../../decisions/20261015-standing_scratch_rehearsal_grant.md) own the publication procedure.

## Intent

### Intent Revision 1 (2026-11-19 UTC)

Prepare a prerelease from the scope that landed through `ea158a3868b552596d13339f32bf888e48fa0a8c`. It includes disk-backed Worker image acquisition, golden-path capture retry (#749), the forward-migration operator guidance and Data Root power-loss durability (#223). Preserve Data Root compatibility with the published rc.11. Record the rc.11 early sweep and the outstanding judged rc.12 runs.

### Intent Revision 2 (2026-11-19 UTC)

Include the grok-4.7 shipped xAI default in the exact publication subject. Verify the pinned model metadata and seeded Data Root before naming the subject. The independent review covers this change.

## Preparation Checkpoint (Rewritable)

| Field | Evidence or gate |
| --- | --- |
| Previous release | `v0.1.0-rc.11` at `2f075c8756bfad5154fc67b01a8dc24f2f826cae`. |
| Update path | The SQL files, database baseline, migration ledgers, layout versions and retained formats match rc.11. The manifest assertion binds the published rc.11 amd64 App config. |
| Publication subject | One empty commit after the preparation scope is on main. Hosted CI, build-mode golden and the independent delta review use its exact source. |
| Publication rehearsal | Use a fresh scratch name and admit only the approved exact-digest security register bindings through 2026-12-17. |
| Closeout | Verify published assets, checksums, attestations and image visibility. Run the published golden path on amd64 and arm64. |

## Next Action

Complete the shipped-template gates and the guarded landing, then name and qualify the exact publication subject. Deployment and judged Worker qualification use the published release under separate authority.
