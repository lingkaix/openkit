# Test Support

This directory owns explicit reusable NanoCore test fixtures and no production behavior.

## Boundaries

- `demo-store.ts` creates an isolated `FsStore` and explicitly seeds the Demo Workspace fixture.
- `workspace-sync.ts` records deterministic trusted input and materialization lineage for review fixtures.
- Fixtures must use production public paths where practical, stay deterministic, and avoid silently changing production defaults.
- Add shared helpers only when multiple tests repeat the same fixture knowledge.

## Verification

Run the tests that consume the changed fixture and the NanoCore package test suite.

See [NanoCore README](../../README.md) for the package test model.
