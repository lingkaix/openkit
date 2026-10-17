---
type: change-plan
status: verified
date: 2026-10-17
---
# Web Fixture Failure Cleanup

## Intent Revision 1

The coordinator's 2026-10-17 04:25Z RESUME notice reports three orphaned Web processes from the SIGTERM and descendant cleanup tests. Investigate the failure paths and fix a confirmed leak with one regression. The effect boundary is local test children and their temporary roots. No deployed service, product operation, public contract or durable data changes. Existing [Test Strategy](../../specs/20260529-test_strategy.md) and [Verification Instruments](../../verification-instruments.md) own the regression and its evidence.

## Working Checkpoint

The failure fixtures await startup settlement before emergency signals and rely on PID markers that may not exist after an early assertion failure. The builder owns only `apps/web/e2e/_lib/servers.spec.ts` in an isolated worktree from lane/web d6b3a61d; the primary owns integration, the Web guide and this record. Retain actual child handles and detached process groups, kill owned children before awaiting startup, keep capture active for late spawns, and reap the children. Restore the existing process patches and temporary roots. Preserve the existing process-stop and permission assertions. No production readiness change is needed for this correction.

One regression triggers an assertion failure with a real detached leader and SIGTERM-ignoring descendant while startup has not settled. The old ordering leaves both alive; the corrected ordering removes both. An outer cleanup guard owns the red run too. The primary inspected the actual source diff and terminal red and green logs. Builder source 57ec0ed3 changes only the fixture spec and was normally merged into the lane. No production fixture code changed.

The complete fixture module on the builder's pre-Notebook base ended 15 passed and 1 failed. All cleanup cases passed. The unchanged Material simulator test timed out during its final Core restart near the end of its 60-second budget; this is a retained failure, not a complete-module pass. The builder removed its verified remaining Web process group and reported zero matching owned processes afterward. Web package typecheck passed but excludes e2e; the direct e2e typecheck reported untouched declaration and child-stdio types, so it is not a passing e2e typecheck. Raw checks and traces remain outside Git in the lane evidence. The final exact-head gate must exercise the complete browser suite on current main before publication.

The first integrated exact-head gate at 2b777bd0 passed repository, lint, typecheck, all nine matching builds and the complete 16-case fixture module, including Material. The browser aggregate remains failed: 27 passed and one Workspace self-check failed. That case expected Overview within five seconds while Workspace creation was still pending. Its later connection refusal followed test teardown, so it does not prove a backend rejection. Test-only correction 3859f777 captures the exact creation POST response before the click and checks success before the unchanged navigation assertion. No timeout or existing assertion changed. The focused corrected journey passed, including every later privacy, member, disclosure and Debug check. The primary normally merged this correction and current main; independent delta review and the corrected complete browser gate remain required.

Next Action: normally merge the committed helper branch, inspect exact terminal evidence, obtain independent review of the integrated head, and run the exact local gate including the complete Web browser suite. Land through the express path after current main is green and watch the containing main-push CI. P27 stays separate and waits for P17 on main.

## Implementation Summary and Final Verification Evidence

The correction retains actual owned children and detached process groups during each failure fixture, sends emergency signals before startup settlement, and reaps the children. One real-child regression distinguishes the old and corrected ordering. The later Workspace self-check correction waits for successful creation before its unchanged navigation assertion. No production behavior, authority, durable data or timeout changed.

Exact head 0fa4a5d656e2da19ebfbd6fad9300030f34cfb6e completed LOCAL-GATE PASS at 2026-10-17 04:57:57Z. Repository checks, lint, typecheck, matching Retrieval Kernel and Native/Web builds passed. All 28 browser cases passed in 7.5 minutes, including all 16 fixture cases and both Workspace and Material journeys. The earlier failed gate and direct e2e typecheck limits remain recorded above. Independent source review L-WEB-cleanup-0fa4a5d656e2.md approves the correction; the external lane evidence retains the exact commands and terminal logs. This document-only closeout preserves the checked implementation and requires its exact repository/static check before landing. Publication still waits for current green main and the landing window, followed by the containing main-push CI. No deployed authentication or whole-server backup is claimed.
