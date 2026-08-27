# Shared Worker Image Build

This directory owns the internal common build stage for the three independently published Worker Agent images.

`Dockerfile` exposes the final targets `worker-codex`, `worker-opencode`, and `worker-pi`. The common stage installs the generic OpenKit worker shim, Node.js and Python development toolchains, source-control and build tools, editors, and network diagnostics; it contains no native Agent runtime, credential, or baked OpenShell policy.

`openkit-worker-shim` is the shared sanitized launcher. It accepts exactly two distinct 43-character base64url stdin lines plus EOF, passes the worker-control token only through descriptor 3, and passes the inference token only as sanitized `OPENKIT_WORKER_INFERENCE_TOKEN`; malformed, missing, equal, extra, or trailing input fails with value-free diagnostics. The installed shim owns the fixed `127.0.0.1:17891` Sandbox Integration binding and authenticated `starting` latch before releasing one native child, and no direct NanoCore control URL enters the sanitized environment. `openkit-file-effect` is the fixed Node.js standard-library helper for bounded `reference.import` into canonical read-only workspace slots, the sole import-only `package-config/package.json` placement at `/openkit/config/package.json`, and `file.export` from canonical writable workspace slots; it accepts only normalized slot-relative paths, rejects linked or non-regular targets, performs no-overwrite verified placement, and reports only an explicitly optional final-leaf absence as exit `2` with empty output. It has no configurable config root or command. `smoke-common.sh` verifies both fixed executables, the common non-root execution environment, and the fixed Integration export before each runtime-specific smoke script verifies its one native Agent runtime.

Build through `scripts/docker/build-image.sh <image-id>` so `containers/images.json` selects the correct final target.

The owning design is `docs/specs/20260721-worker_execution_environment_images.md`.
