# Test Support

This directory owns explicit reusable NanoCore test fixtures and no production behavior.

## Boundaries

- `demo-store.ts` creates an isolated `FsStore` and explicitly seeds the Demo Workspace fixture.
- `git-repository.ts` seeds a writable Git repository with one resolvable HEAD commit.
- `agent-environment.ts` records deterministic production-shaped AEP snapshots for scheduler recovery fixtures.
- `app.ts` creates an app with an explicit simulated executor unless a test supplies another executor.
- `workspace-sync.ts` records deterministic trusted input and materialization lineage for review fixtures.
- `mcp-stdio-stub.mjs` publishes a descendant-written PID and credential digest receipt so MCP process cleanup tests verify inherited credentials on supported POSIX hosts without Linux-specific process inspection.
- Fixtures must use production public paths where practical, stay deterministic, and avoid silently changing production defaults.
- Add shared helpers only when multiple tests repeat the same fixture knowledge.

## Verification

Run the tests that consume the changed fixture and the NanoCore package test suite.

See [NanoCore README](../../README.md) for the package test model.
