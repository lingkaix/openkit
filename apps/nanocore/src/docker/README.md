# Container Artifact Tests

This directory owns tests for NanoCore container build and run artifacts; the artifacts themselves remain under the repository's Docker and script paths.

## File Map

- `app-dockerfile.test.ts` and `openshell-worker-dockerfile.test.ts` validate image definitions.
- `app-run-script.test.ts` and `app-persistence-smoke.test.ts` validate container startup and persistence contracts.
- `container-images-manifest.test.ts` validates the image manifest.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/docker` and the relevant built-process smoke tests after changing a container artifact.

See [NanoCore README](../../README.md) for package-level container and smoke commands.
