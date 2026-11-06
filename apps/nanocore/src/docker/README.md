# Container Artifact Tests

This directory owns tests for NanoCore container build and run artifacts; the artifacts themselves remain under the repository's Docker and script paths.

## File Map

- `container-images-manifest.test.ts` validates the image catalog: existing Dockerfiles and smoke scripts, the empty common worker base, the ordered four-runtime deployment set, and digest-pinned release bases.
- `app-run-script.test.ts` and `app-persistence-smoke.test.ts` validate container startup and persistence contracts.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/docker` and the relevant built-process smoke tests after changing a container artifact.

See [NanoCore README](../../README.md) for package-level container and smoke commands.

The development-grant regression also checks explicit encoded-slash opt-in on npm only across all four templates; Git path rules and every other development grant retain strict parsing.
