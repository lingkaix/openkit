# Smoke Tests

This directory owns direct-execution checks for built release artifacts.

Smoke scripts start the built artifact, verify its minimum health surface, and shut it down without becoming product workflow or regression suites. The NanoCore Worker-listener smoke boots a clean disposable root using authored configuration, checks public health and metadata plus private-listener readiness, and proves orderly child and listener shutdown. It imports only Node modules. Task admission, NanoHost carriage, canonical imports, governed MCP calls and retained evidence belong to the public-process L3 case in `apps/nanocore/e2e/worker-mcp-lifecycle.spec.ts`. The exact retained schema body remains an invariant of its schema-snapshot owner tests. Package or module behavior belongs in its L1 owner.

Run the complete built-artifact smoke gate from the repository root:

```bash
pnpm -w test:smoke
```

Individual scripts may be run directly after building their owning artifact. Smoke scripts do not receive sibling unit tests; non-trivial behavior must move to the lowest existing L1-L4 owner instead.

The NanoCore health smoke first probes the recovered deletion fence through `POST /api/app/operations/workspace.dashboard` and requires HTTP 403 `workspace_access_denied`. It then continues its exact retained deletion request through `POST /api/app/operations/workspace.delete` with the logical Workspace selector and `x-openkit-request-id`, and checks the cleaned lifecycle outcome.
