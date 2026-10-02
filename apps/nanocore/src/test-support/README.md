# Test Support

This directory owns explicit reusable NanoCore test fixtures and no production behavior.

## Boundaries

- `demo-store.ts` creates an isolated `FsStore` and explicitly seeds the Demo Workspace fixture.
- `git-repository.ts` seeds a writable Git repository with one resolvable HEAD commit.
- `agent-environment.ts` records deterministic production-shaped AEP snapshots for scheduler recovery fixtures.
- `goal-intent.ts` creates a completed user Turn and initial objective Item so Goal fixtures bind a real `createdByItemId` and `currentIntentItemId` lineage.
- `app.ts` creates an app with an explicit simulated executor unless a test supplies another executor. Its explicit `createAppWithWorkspaceAuthority` fixture creates real temporary local identity and Workspace membership records for storage-only HTTP fixtures that exercise definition-derived operations, and closes those fixture databases after each test. Explicit databases and server authority remain caller-owned.
- Both app fixtures accept omitted options. Tests whose subject is file-backed configuration loading or reload supply an explicit `runtimeConfigManager` so synthetic Gateway and Provider defaults do not replace the authored initial snapshot.
- `workspace-sync.ts` records deterministic trusted input and materialization lineage for review fixtures.
- `mcp-stdio-stub.mjs` publishes a descendant-written PID and credential digest receipt so MCP process cleanup tests verify inherited credentials on supported POSIX hosts without Linux-specific process inspection.
- `mcp-http-stub.ts` can hold its `delayed` tool response on a test-owned Promise; the test observes request ingress and releases the gate during cleanup to establish concurrency without a guessed delay.
- `knowledge-operation.ts` projects explicit test selectors and supplied request bytes to definition-derived routes. It supplies no Workspace authority, request identity, data or admission default; malformed bodies stay malformed.
- Fixtures must use production public paths where practical, stay deterministic, and avoid silently changing production defaults.
- Add shared helpers only when multiple tests repeat the same fixture knowledge.

## Verification

Run the tests that consume the changed fixture and the NanoCore package test suite.

See [NanoCore README](../../README.md) for the package test model.

## Confirmed Synthetic Images

`native-environment.ts` explicitly confirms synthetic image defaults through the production settlement path for fixtures whose subject is another contract. `prepared-agent-environment.ts` resolves production AEP/metadata/compatibility against that fixture evidence and supplies explicit server-scoped default-off capture when unrelated consumer fixtures omit it. Explicit capture values remain unchanged. Missing/stale image and capture admission regressions call the production resolver directly. Historical image-effect fixtures may retain a package without the optional environment record; newly resolved packages always require confirmed evidence.

Simulated and metadata-only consumers may explicitly install `withTestPreparedNativeEnvironment` in their test module. It runs the production resolver with fixture-owned confirmed evidence and preserves capture, credential and scheduler checks. Fixture-only databases are removed after the test module; real production paths retain no automatic admission or empty-default fallback.

`operation-request.ts` exports `operationRequest`, the generic request helper, reused for Artifact, Task, conversation, attention and Pending Request selectors and caller-supplied request bytes on the derived HTTP path. It adds no authority, fixture data, request identity or admission default and leaves malformed bodies malformed.

The HTTP MCP fixture exposes server-observed header snapshots for exact bearer and raw-header replacement assertions. These observations contain only synthetic test canaries and stay fixture-local.
