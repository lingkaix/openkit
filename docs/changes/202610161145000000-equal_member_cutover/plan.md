---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/ga-equal
---
# Equal Active-Member Access Cutover

## Intent Revision 1

Source: P22 inventory #159/R049 and D53, coordinator dispatch on 2026-10-16. Implement the accepted equal active-member eligibility in [Core Permissions](../../core/permissions.md) and [Multi-User Workspace System](../../specs/20260715-multi_user_workspace_system.md#active-member-authorization-target). Remove obsolete editor/viewer fields and access-changing surfaces consistently. Preserve Policy, credential intersection, exact human gates, private audiences, owner-transfer integrity and deletion recovery. The release-coupled deletion attribution and narrow private recovery export predicates are frozen in the existing owner before production edits. No new membership tier, recovery owner, bypass, workflow or external effect is authorized.

## Working Checkpoint

The branch starts at `e4f423d58bfff6b9e82f1b2c104d86c1ec6462bd`; pushed WIP is `68785dd889a1a379a8546fe8fc0217713cc4dc86`. Full filesystem access provides no operating-system enforcement of its exclusive worktree scope. The migration and equal-member policy, lifecycle, public schema, API, CLI and Web cutover are implemented. Ownership remains a continuity identity. New deletion requests bind their exact initiating human separately from the recovery owner, and the internal private export rechecks the canonical deleting request, target and registry revision. No D06, Server MCP, Vault request/review, Goal or general Web feature production code is changed.

The deciding native migration/member deletion/replay/private recovery/lifecycle suites passed30 tests. Both typechecks passed. Schema113 and typed-client83 tests passed. The affected Web run passed736 tests in20 unchanged consumer suites; final account and administrator recovery reruns passed105 tests in2 suites. An observed leave-modal reuse defect was corrected by keying the confirmation to its exact Workspace identity; the regression now proves that the old confirmation disappears and the next selected Workspace retains member controls. The real local retrieval executable built successfully. The48-file affected native suite is still running and remains required evidence.

OpenAPI generation and validation, bundled CLI generation, documentation index generation and OpenAPI30 tests passed. Changed-file Biome reported no errors, with one existing warning and five existing informational suggestions. Final Web typecheck, documentation model517 documents, test governance and index check passed. Playwright collected the updated account-sharing test but did not execute its browser stack. That test now preserves the stale-session refusal through actual membership removal after transfer, because transfer alone leaves member eligibility intact. The native server-auth fixture removes the retired invitation tier input.

Root operation inventory tests passed86 of88. The two failures are inherited Server projection omissions: the Skill's explicit administrator inventory omits the new Server operations, and the Web count expects240 while the current catalog has257. The primary is correcting its Server feature separately; this branch retains those exact failures and does not claim all root gates pass. Integration must merge the primary's correction and regenerate shared output. Full logs and exact cross-surface path rationales remain under uncommitted backlog `evidence/L-GA/equal-*`.

No pre-change behavior RED was observed. Regressions were authored before production, but queue and setup failures are not behavior evidence. The first native132/140 and affected Web834/841 results exposed local implementation and oracle errors; their corrections retain current authority, private audience, request conflict and zero-effect predicates. Independent acceptance and main integration remain with the primary; no whole-feature acceptance is claimed.

Current complexity:113 changed files,2 owning documents changed,2 governing owners touched. The existing product operation registry is unchanged; its Workspace association is reduced to one active-member association. The migration removes2 tier columns and adds no permanent table. The existing deletion request gains1 optional retained-compatible initiating-user field. Generated OpenAPI and CLI bytes and required fixture changes account for most cross-surface churn.

Primary scoped reconciliation: the L-GA primary reconciled the deletion error paragraph after inspecting the existing central admission tests: unadmitted missing, revoked or disabled authority remains non-enumerating `403` or transport authentication refusal, while an admitted request that loses authority or has contradictory exact facts returns `409` `recovery_required` before effects. The owner links Operation Definition admission and current permission enforcement explicitly. This scoped clarification changes no production behavior solely for error spelling and retains phase, closed-gate, no-substitution and no-destructive-effect criteria.
