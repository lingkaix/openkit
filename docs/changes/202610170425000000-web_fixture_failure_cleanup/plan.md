---
type: change-plan
status: implemented
date: 2026-10-17
---
# Web Fixture Failure Cleanup

## Intent Revision 1

The coordinator's 2026-10-17 04:25Z RESUME notice reports three orphaned Web processes from the SIGTERM and descendant cleanup tests. Investigate the failure paths and fix a confirmed leak with one regression. The effect boundary is local test children and their temporary roots. No deployed service, product operation, public contract or durable data changes. Existing [Test Strategy](../../specs/20260529-test_strategy.md) and [Verification Instruments](../../verification-instruments.md) own the regression and its evidence.

## Working Checkpoint

The failure fixtures await startup settlement before emergency signals and rely on PID markers that may not exist after an early assertion failure. The builder owns only `apps/web/e2e/_lib/servers.spec.ts` in an isolated worktree from lane/web d6b3a61d; the primary owns integration, the Web guide and this record. Retain actual child handles and detached process groups, kill owned children before awaiting startup, keep capture active for late spawns, and reap the children. Restore the existing process patches and temporary roots. Preserve the existing process-stop and permission assertions. No production readiness change is needed for this correction.

One regression triggers an assertion failure with a real detached leader and SIGTERM-ignoring descendant while startup has not settled. The old ordering leaves both alive; the corrected ordering removes both. An outer cleanup guard owns the red run too. The primary inspected the actual source diff and terminal red and green logs. Builder source57ec0ed3 changes only the fixture spec and was normally merged into the lane. No production fixture code changed.

The complete fixture module on the builder's pre-Notebook base ended15 passed and1 failed. All cleanup cases passed. The unchanged Material simulator test timed out during its final Core restart near the end of its60-second budget; this is a retained failure, not a complete-module pass. The builder removed its verified remaining Web process group and reported zero matching owned processes afterward. Web package typecheck passed but excludes e2e; the direct e2e typecheck reported untouched declaration and child-stdio types, so it is not a passing e2e typecheck. Raw checks and traces remain outside Git in the lane evidence. The final exact-head gate must exercise the complete browser suite on current main before publication.

Next Action: normally merge the committed helper branch, inspect exact terminal evidence, obtain independent review of the integrated head, and run the exact local gate including the complete Web browser suite. Land through the express path after current main is green and watch the containing main-push CI. P27 stays separate and waits for P17 on main.
