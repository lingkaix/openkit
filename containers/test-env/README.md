# Test Execution Environment Image

This image is the environment ordinary deterministic repository checks run in. It is not a release artifact and is never deployed, but it is not optional tooling either: `docs/toolchain.md` Test Execution Environment makes it the single declared capability set for those checks. Docker-driving and explicitly opted-in real-runtime or provider gates remain host-placed.

The point is that this Dockerfile, rather than the host, decides what a check may do. Binding a loopback listener, creating a symlink, and signalling a process the test itself spawned are capabilities of this image on every machine and every runner. Nothing about the developer's laptop, CI runner, or agent sandbox changes them, so no per-environment configuration exists to drift.

## What It Provides

Node.js 24.16.0, pnpm, Git, the exact NanoHost-scoped Rust toolchain (`RUST_VERSION`, mirrored from `apps/nanohost/mise.toml`), the C/C++ build tools NanoHost Cargo compilation requires (`gcc`, `g++`, `make`, `cmake`, `pkg-config`, `libc6-dev`), and a Playwright Chromium install at `PLAYWRIGHT_BROWSERS_PATH` are the image contents. Contents are derived from what the gates execute rather than from what a developer might reach for at a shell, and `smoke.sh` checks that required set with no optional entries. Rust is present so ordinary `turbo run build|test|lint|format` can execute `@openkit/nanohost` Cargo scripts inside the image. Xvfb is not installed because no gate uses it.

No worker runtime is installed. Codex and OpenCode were here when this was a developer toolbox, and no in-image gate used either: the checks that drive a real runtime run on the host under `scripts/test-env.sh host`. Installing one would also put its release cadence on the critical path of every unrelated gate, because a runtime version bump changes this Dockerfile and therefore the image tag.

Two declarations exist for the execution contract rather than for the tooling:

- `OPENKIT_TEST_EXECUTOR=1` marks the image. `scripts/test-env.sh` reads it to decide whether to run a check directly or re-enter the image first.
- `npm_config_store_dir=/pnpm/store` fixes the pnpm store at a stable path so a caller can mount a cache volume over it.

## Commands

Nothing here needs to be invoked directly. `pnpm test`, `pnpm verify`, and the other ordinary deterministic root gates enter this image on their own; see the command table in `README.md`.

To build or smoke the image on its own:

```bash
scripts/docker/build-image.sh test-env
scripts/docker/smoke-image.sh test-env
```

`scripts/docker/test-image-tag.mjs` prints the content-addressed tag that `scripts/test-env.sh` and CI both resolve. The tag is a digest of `containers/test-env/Dockerfile`, `containers/test-env/smoke.sh`, and `apps/web/package.json`, so a tree can never be tested against an image built from different image or Playwright package inputs. Changing the Dockerfile (including the Rust pin) changes `OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST` and forces a rebuild and republish of that digest tag.

When `scripts/test-env.sh image` is invoked from inside the image, it compares the image's embedded build-input digest with the digest of the current mounted tree. A mismatch exits before dependency installation or the requested command, so an already-running stale image cannot validate a newer tree.

## What Does Not Run Here

Checks that drive Docker or a real worker runtime themselves run on the host: the NanoCore restart gate, the real-codex smoke, the real-provider, real-subscription, and real-task-mode gates, and the container build and smoke scripts. Placing a container-orchestrating check inside a container would require a Docker socket this image deliberately does not receive, and a real-runtime check needs a CLI and credentials that belong to the developer's machine rather than to a shared image. `scripts/test-env.sh host` guards that boundary.

## Related Design

- Owning decision: `docs/toolchain.md` Test Execution Environment
- Image catalog and build scripts: `containers/README.md`
- Test taxonomy and verification depth: `docs/specs/20260529-test_strategy.md`
- Container rule, platform-divergence rule, and oracle classification: `docs/verification-instruments.md`
