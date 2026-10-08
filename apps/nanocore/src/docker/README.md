# Container Artifact Tests

This directory owns tests for NanoCore container build and run artifacts; the artifacts themselves remain under the repository's Docker and script paths.

## File Map

- `app-dockerfile.test.ts` and `openshell-worker-dockerfile.test.ts` validate image definitions, including the inherited Worker volume, numeric-user, ephemeral-control, bootstrap WorkingDir, and immutable Python boundaries. The worker launcher test executes its sanitized environment selection and checks all 15 pinned OpenShell proxy/bootstrap and client TLS trust names.
- `app-run-script.test.ts` and `app-persistence-smoke.test.ts` validate container startup and persistence contracts.
- `container-images-manifest.test.ts` validates the image manifest, including the empty common base and the ordered four-runtime deployment set. Worker tests validate all four copy-on-init templates and the independent patched Pi host deployment.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/docker` and the relevant built-process smoke tests after changing a container artifact.

See [NanoCore README](../../README.md) for package-level container and smoke commands.

The development-grant regression also checks explicit encoded-slash opt-in on npm only across all four templates; Git path rules and every other development grant retain strict parsing.
