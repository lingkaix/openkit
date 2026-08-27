# Test Execution Image

`containers/test-env` is the environment ordinary deterministic repository checks run inside. Its Dockerfile is the only declaration of what such a check may do, which is why the same command behaves identically on a laptop, in CI, and inside an agent sandbox. Docker-driving and explicitly opted-in real-runtime or provider gates remain host-placed. The owning decision is Test Execution Environment in `docs/toolchain.md`; this page is the operational recipe.

**WARNING: this is not a deployment artifact.** It is never published on a release tag and carries no product version. The app image has a separate contract in `docs/cookbooks/docker-app.md`.

## You Usually Do Not Touch It

`pnpm test`, `pnpm verify`, and the other ordinary deterministic root gates enter the image on their own through `scripts/test-env.sh`. Docker must be running; nothing else needs configuring for those gates. The first check builds the image, and later checks reuse it until its build inputs change.

Everything below is for the cases where that is not enough.

## Build

```bash
scripts/docker/build-image.sh test-env
```

This produces the `openkit/test-env:dev` local tag from the manifest. Gates do not use that tag: they resolve a content-addressed one instead.

```bash
node scripts/docker/test-image-tag.mjs
```

The printed tag is a digest of `containers/test-env/Dockerfile`, `containers/test-env/smoke.sh`, and `apps/web/package.json`. A change to any of them yields a new tag, so a tree can never be tested against an image built from different image or Playwright package inputs. CI resolves the same tag with `--owner` and publishes it to GHCR when it is absent. Adding or bumping the image Rust pin changes that digest and requires `scripts/docker/build-image.sh test-env` (local) plus CI republish of the new digest tag.

The image embeds that full build-input digest. When `scripts/test-env.sh image` is already running inside the image, it compares the embedded value with the digest of the current mounted tree and exits before dependency installation or the requested command if they differ.

## Contents

Node 24.16.0 from `node:24.16.0-bookworm-slim`, pnpm 10 through Corepack, Git, the exact NanoHost-scoped Rust toolchain (`ENV RUST_VERSION`, mirrored from `apps/nanohost/mise.toml` via rustup minimal profile with cargo, rustc, clippy, and rustfmt on `PATH`), the C/C++ build tools NanoHost Cargo compilation requires (`gcc`, `g++`, `make`, `cmake`, `pkg-config`, `libc6-dev`), and a Playwright Chromium install at `PLAYWRIGHT_BROWSERS_PATH` are the image contents. Xvfb is not installed because no gate uses it. Rust is present so ordinary root `pnpm build`, `pnpm test`, `pnpm lint`, and `pnpm fmt` (each `turbo run …` inside this image) can execute `@openkit/nanohost` Cargo scripts without a parallel command surface.

Contents are derived from what the gates execute. No worker runtime is installed: checks that drive a real Codex, OpenCode, or Pi runtime are host-placed and use the developer's own CLI and credentials. Adding a runtime here would also put its release cadence on the critical path of every unrelated gate, because its version pin is a build input and therefore part of the tag.

Two environment declarations carry contract rather than tooling:

- `OPENKIT_TEST_EXECUTOR=1` marks the image so `scripts/test-env.sh` knows it has arrived.
- `npm_config_store_dir=/pnpm/store` fixes the pnpm store so a cache volume can be mounted over it.

The image does not copy the repository. `scripts/test-env.sh` bind-mounts the checkout at `/workspace` and mounts named volumes over every `node_modules` directory and the pnpm store, because `better-sqlite3` and `esbuild` are built per platform and a shared tree would hand the container the host's binaries.

## Open A Shell Inside It

```bash
bash scripts/test-env.sh image bash
```

This is the supported way in: it resolves the tag, builds if needed, and applies the same mounts a gate gets, so what you see matches what the gate saw. A bare `docker run` will differ.

## Smoke

```bash
scripts/docker/smoke-image.sh test-env
```

It reports Node, pnpm, Git, rustc, cargo, clippy, rustfmt, and the installed Chromium. Every entry is required; there are no optional tools, because a tool no gate executes does not belong in the image.

## Reclaim Disk

Dependency and cache volumes survive `pnpm clean`, which only clears the host tree:

```bash
docker volume rm $(docker volume ls -q --filter name=openkit-test-env-)
```

Volumes are keyed per checkout, so two working copies never share an installed dependency tree.

## What Runs On The Host Instead

`scripts/test-env.sh host` guards the checks that drive Docker or a real worker runtime themselves: `test:e2e:real-codex`, `test:e2e:real-provider`, `test:e2e:real-subscription`, `test:e2e:real-task-mode`, `app:run`, and `init`. They refuse to start inside the image. The image receives no Docker socket, and handing it one would make the containment it provides decorative.
