# Docker Dev/E2E Image

The `containers/dev-e2e/Dockerfile` image is a debug and e2e contract for local OpenKit validation.

It exists for CI diagnostics, browser e2e runs, NanoCore black-box e2e runs, and local reproduction work.

**WARNING: This image is NOT for app deployment.**

The app image has a separate contract and lands independently from this cookbook.

## Build

```bash
scripts/docker/build-image.sh dev-e2e
```

The image is built from `node:24-bookworm-slim` to match `.node-version`.

It enables pnpm 10 through Corepack and includes debug/test tooling for the local e2e surface.
Codex is installed from the platform-native Linux payload and exposed as `/opt/codex/bin/codex`, with `/usr/local/bin/codex` as a symlink.
The image does not run the npm Codex wrapper at runtime.

The image does not copy the repository into the container.

Bind-mount the checkout when running it.

## Run

```bash
docker run --rm -it -v "$PWD:/workspace" -w /workspace openkit/dev-e2e:dev bash
```

The container defaults NanoCore to local mode and binds services to `0.0.0.0` so forwarded ports are reachable from the host.

The container also defaults `OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR=1`, which enables the internal self-check executor for tests without external agent credentials.

## Smoke

```bash
openkit-dev-e2e-smoke
```

The smoke command reports Node and pnpm versions.

It also reports Caddy, native Codex, and OpenCode versions when those commands are present on `PATH`.

Missing optional tools print `not-installed` and do not fail the smoke script.

## Test Surface

Use this image for the local release-gate commands that need bundled debug and browser test tooling:

```bash
pnpm --filter @openkit/nanocore run test:e2e
pnpm --filter @openkit/web e2e
```

The NanoCore e2e command builds NanoCore and runs the Vitest black-box e2e suite.

The web e2e command runs Playwright against the internal self-check NanoCore server and the Vite preview server.
