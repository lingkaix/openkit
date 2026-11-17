# Test Execution Image

`containers/test-env` is the authoritative environment for ordinary deterministic repository checks. CI runs every `any` gate inside it. A developer host is the primary path, and a Worker Agent sandbox is also permitted. This page is the recipe for building the image, taking an explicit second opinion, and matching CI. Docker-driving and explicitly opted-in real-runtime or provider gates remain host-placed. The owning decision is Test Execution Environment in `docs/toolchain.md`.

**WARNING: this is not a deployment artifact.** It is never published on a release tag and carries no product version. The app image has a separate contract in `docs/cookbooks/docker-app.md`.

## You Usually Do Not Touch It

`pnpm test`, `pnpm verify`, and the other ordinary deterministic root gates run on the host by default. Docker is not a prerequisite. CI runs those gates inside the image. An explicit second opinion is `OPENKIT_TEST_USE_IMAGE=1 pnpm test`; that run is labelled `OPENKIT_TEST_ENVIRONMENT=image` and does not retry or replace a host failure.

Everything below is for building the image, opening a shell inside it, or taking that second opinion.

## Build

```bash
scripts/docker/build-image.sh test-env
```

This produces the `openkit/test-env:dev` local tag from the manifest. Gates do not use that tag: they resolve a content-addressed one instead.

```bash
node scripts/docker/test-image-tag.mjs
```

The printed tag is a digest of the manifest-selected Dockerfile, smoke script, build context and platforms, plus `apps/web/package.json`, the locked browser package, the security-tool installer and pin manifest, the native-client tool downloader and its pin manifest (`scripts/download-native-client-tools.mjs`, `scripts/native-client-tools.json`), `scripts/retrieval-dictionary.py`, the vendored IPADIC archive and its COPYING notice. A change to any input yields a new tag, so a tree can never be tested against an image built from different image, Playwright package or retrieval dictionary inputs. Main and tag CI resolve the same tag with `--owner` and publish it to GHCR when it is absent. Pull-request checks instead build and load a job-local image and publish nothing; their token is read-only. Adding or bumping the image Rust pin changes that digest and requires `scripts/docker/build-image.sh test-env` (local) plus CI republish of the new digest tag.

The image embeds that full build-input digest. When `scripts/test-env.sh any` is already running inside the image, it compares the embedded value with the digest of the current mounted tree and exits before dependency installation or the requested command if they differ.

## Contents

Image contents come from `containers/test-env/Dockerfile`, the root tool declarations, `scripts/security-tools.json`, and `containers/test-env/smoke.sh`. The [toolchain guide](../toolchain.md) owns version maintenance. A mismatch between this image and those declarations is a refusal, not a second pin. The image carries the tools the ordinary gates execute, including the scoped Rust toolchain those gates need. It does not carry a worker runtime. Host-placed real-runtime gates stay outside the image.

This image is an internal sibling of `worker-common` and is not built `FROM worker-common`. There is no publication dependency. A Node digest that does not equal the worker common stage is a mirror failure: update this `FROM` line in the same change as the worker baseline, which changes `OPENKIT_TEST_IMAGE_BUILD_INPUT_DIGEST` and forces a rebuild.

Contents come from what the gates execute. No worker runtime is installed: checks that drive a real Codex, OpenCode, or Pi runtime are host-placed and use the developer's own CLI and credentials. Adding a runtime here would also put its release cadence on the critical path of every unrelated gate, because its version pin is a build input and therefore part of the tag.

The image also supplies the committed, checksum-pinned offline workflow linter. `check:repo` and release preflight require it. Native Linux hosts provision the same tool through the [toolchain guide](../toolchain.md#security-tool-provisioning). Browser files come from the digest-pinned Playwright supply stage; their CLI package uses a committed npm lock with scripts disabled. The final runtime remains on the Worker Node digest.

Two environment declarations carry contract rather than tooling:

- `OPENKIT_TEST_EXECUTOR=1` marks the image so `scripts/test-env.sh` knows an `any` check has arrived and should label `OPENKIT_TEST_ENVIRONMENT=image`.
- `npm_config_store_dir=/pnpm/store` fixes the pnpm store so a cache volume can be mounted over it.

The image does not copy the repository. `scripts/test-env.sh` bind-mounts the checkout at `/workspace` and mounts named volumes over every `node_modules` directory and the pnpm store, because `better-sqlite3` and `esbuild` are built per platform and a shared tree would hand the container the host's binaries.

## Open A Shell Inside It

```bash
OPENKIT_TEST_USE_IMAGE=1 bash scripts/test-env.sh any bash
```

This is the supported way in: it resolves the tag, builds if needed, and applies the same mounts a CI gate gets, so what you see matches what CI saw. A bare `docker run` will differ. The host default remains `bash scripts/test-env.sh any bash` without that variable.

## Smoke

```bash
scripts/docker/smoke-image.sh test-env
```

`containers/test-env/smoke.sh` is the smoke. It checks its declared required tools and explicit forbidden-tool checks. The [toolchain guide](../toolchain.md#security-tool-provisioning) owns native security-tool supply.

## Reclaim Disk

Dependency and cache volumes survive `pnpm clean`, which only clears the host tree:

```bash
docker volume rm $(docker volume ls -q --filter name=openkit-test-env-)
```

Volumes are keyed per checkout, so two working copies never share an installed dependency tree.

## What Runs On The Host Instead

`scripts/test-env.sh host` guards these checks: `test:e2e:real-codex`, `test:e2e:real-provider`, `test:e2e:real-subscription`, `test:e2e:real-task-mode`, `test:nanohost-installer-live`, `test:nanohost-maintenance-live`, `test:app-image-admin-recovery`, `app:run`, and `init`. Most of them drive Docker or a real worker runtime themselves; the installer and maintenance gates need host namespaces or a private systemd manager. They refuse to start inside the image. The image receives no Docker socket, and handing it one would make the containment it provides decorative.
