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

The independent branch starts at `e4f423d58bfff6b9e82f1b2c104d86c1ec6462bd`. Full filesystem access provides no operating-system enforcement of its exclusive worktree scope. The implementation and consumer cutover are written and remain work in progress. Dependency installation and five dependency builds passed. The first NanoCore typecheck found two cutover integration errors: the retired access-level type re-export and explicit undefined at an exact-optional internal deletion context. Both are corrected but not rechecked. The behavioral suites did not run because typecheck stopped the command. No pre-change RED was observed; authored regressions preceded production work, but CPU-slot queue and setup outcomes are not behavior evidence. Changed-file Biome parsed 96 files and fixed 29; its one new implicit-any error was corrected. One unrelated existing warning and five informational suggestions remain untouched.

The coordinator requested a WIP commit and helper idle interval for independent Server feature review. Resume with NanoCore typecheck and the eight focused suites from `equal-focused-initial.log`, then schema/client/Web/CLI and affected fixture checks. Generated OpenAPI, bundled CLI and documentation index are pending final stable verification and integration coordination. Exact output and required cross-surface path rationales remain under uncommitted backlog `evidence/L-GA/equal-*`. Independent acceptance and main integration remain with the primary. No whole-feature acceptance is claimed.
