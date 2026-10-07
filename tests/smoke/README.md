# Smoke Tests

This directory owns direct-execution checks for built release artifacts.

Smoke scripts start the built artifact, verify its minimum health surface, and shut it down without becoming product workflow or regression suites. The NanoCore worker MCP smoke first admits its shared adjudicator through stand-in PASS, FAIL, and TIMEOUT outcomes, then carries one public Task over a disposable native NanoHost HTTP/2 session and an SDK client without invoking a real agent binary. Its disposable fixture explicitly seeds synthetic digest-bound image/default evidence through the built production settlement seam, matching the existing confirmed-synthetic-image fixture; its native image inspection reports the same defaults. This satisfies ordinary Task admission without claiming real image qualification or installing a production fallback. The stand-in reports an empty native Workspace baseline and unchanged captures, services AEP imports before `session.open`, and observes terminal Task state by exact `task.start` replay after durable admission. The no-human-intervention assertion reads the current `attention.list` projection rather than the retired Turn `humanGate`. Its selected echo tool proves governed Gateway dispatch without host repository setup or publication. NanoCore process/API behavior belongs in `apps/nanocore/e2e/`, and package or module behavior belongs in its L1 owner.

Run the complete built-artifact smoke gate from the repository root:

```bash
pnpm -w test:smoke
```

Individual scripts may be run directly after building their owning artifact. Smoke scripts do not receive sibling unit tests; non-trivial behavior must move to the lowest existing L1-L4 owner instead.

The Worker MCP smoke reads `scheduler_execution_attempts.phase = 'closed'` as durable execution-release proof alongside the cleaned backend and complete Workspace handoff; product completion alone does not satisfy release.

The NanoCore health smoke first probes the recovered deletion fence through `POST /api/app/operations/workspace.dashboard` and requires HTTP 403 `workspace_access_denied`. It then continues its exact retained deletion request through `POST /api/app/operations/workspace.delete` with the logical Workspace selector and `x-openkit-request-id`, and checks the cleaned lifecycle outcome.
