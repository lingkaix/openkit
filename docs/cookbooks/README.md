# Cookbook Index

Use this index to find the repository's reusable setup and operational guides before creating a new app, package, or optional language stack.

## Available Cookbooks

- [Claude Design + Claude Code Web UI loop](./claude-design-web-ui-loop.md): the agent-first reference-backed or frame-backed workflow for implemented Web UI. New or materially changed frames require human finalization before implementation; every implemented surface requires final human fidelity review. See [`docs/specs/20260710-web_ui_rebuild_stack.md`](../specs/20260710-web_ui_rebuild_stack.md) for the target stack (React, Tailwind + Adobe Spectrum tokens, React Aria, A2UI).
- [Solid SPA setup](./spa-solid-vite.md): **Retired.** Stub that points at the React + Spectrum stack and design→code loop above; do not use it to scaffold `apps/web`.
- [Release](./release.md): cut a semantic version tag from `main`, run the release gate, publish GHCR images, and verify GitHub Release notes
- [Docker app image](./docker-app.md): build and run the single-container app image with Caddy, NanoCore, and web assets
- [Test execution image](./docker-test-env.md): build, run, and troubleshoot the `test-env` image that every repository check executes inside
- [NanoHost real-use host](./nanohost-real-use-host.md): use `pnpm host:provision a1`, `pnpm host:assert a1`, `pnpm host:nanohost:bring-up a1`, and `pnpm host:teardown a1` for the exact A1 host workflow, then retain the redacted result at `temp/state/nanohost/host-manifest/a1/result.json`
- [Python setup](./python-setup.md): add a Python app or package with `uv`, `ruff`, `mypy`, and `pytest`
- [Go setup](./go-setup.md): add a Go app or package with Go modules, `gofmt`, `golangci-lint`, and `go test`
- [Rust setup](./rust-setup.md): add a Rust app or package with `cargo`, `cargo fmt`, and `cargo clippy`
- [Zig setup](./zig-setup.md): add a Zig package or native bridge layer with `zig build`

## Working Rules

- Read the cookbook that matches your task before scaffolding anything.
- Scaffolding source preference is owned by `docs/toolchain.md` under `## Owns`, Setup And Dependency Procedure.
- Run cookbook commands as bare commands; `docs/toolchain.md` owns how the pinned toolchain reaches `PATH`.
- After scaffolding an app or package, add the required local `README.md` and add `AGENTS.md` only when local agent execution rules are needed.
