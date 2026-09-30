# Test Support

This directory owns explicit reusable NanoCore test fixtures and no production behavior.

## Boundaries

- `demo-store.ts` creates an isolated `FsStore` and explicitly seeds the Demo Workspace fixture.
- `git-repository.ts` seeds a writable Git repository with one resolvable HEAD commit.
- `agent-environment.ts` records deterministic production-shaped AEP snapshots for scheduler recovery fixtures.
- `goal-intent.ts` creates a completed user Turn and initial objective Item so Goal fixtures bind a real `createdByItemId` and `currentIntentItemId` lineage.
- `app.ts` creates an app with an explicit simulated executor unless a test supplies another executor.
- `workspace-sync.ts` records deterministic trusted input and materialization lineage for review fixtures.
- `mcp-stdio-stub.mjs` publishes a descendant-written PID and credential digest receipt so MCP process cleanup tests verify inherited credentials on supported POSIX hosts without Linux-specific process inspection.
- Fixtures must use production public paths where practical, stay deterministic, and avoid silently changing production defaults.
- Add shared helpers only when multiple tests repeat the same fixture knowledge.

## Verification

Run the tests that consume the changed fixture and the NanoCore package test suite.

See [NanoCore README](../../README.md) for the package test model.

## Confirmed Synthetic Images

`native-environment.ts` explicitly confirms synthetic image defaults through the production settlement path for fixtures whose subject is another contract. `prepared-agent-environment.ts` resolves production AEP/metadata/compatibility against that fixture evidence. Missing/stale admission regressions call the production resolver directly. Historical image-effect fixtures may retain a package without the optional environment record; newly resolved packages always require confirmed evidence.

Simulated and metadata-only consumers may explicitly install `withTestPreparedNativeEnvironment` in their test module. It runs the production resolver with fixture-owned confirmed evidence and preserves capture, credential and scheduler checks. Fixture-only databases are removed after the test module; real production paths retain no automatic admission or empty-default fallback.
