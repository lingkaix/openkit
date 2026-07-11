# Cookbook Index

Use this index to find the repository's reusable setup and operational guides before creating a new app, package, or optional language stack.

## Available Cookbooks

- [Claude Design + Claude Code Web UI loop](./claude-design-web-ui-loop.md): the agent-first workflow for turning a design request into finalized Claude Design frames and then implemented Web UI. This is the current guide for Web UI work; see [`docs/specs/20260710-web_ui_rebuild_stack.md`](../specs/20260710-web_ui_rebuild_stack.md) for the target stack (React, Tailwind + Adobe Spectrum tokens, React Aria, A2UI).
- [Solid SPA setup](./spa-solid-vite.md): **Deprecated for the Web UI default.** Historical scaffold guide for a browser-only Vite + SolidJS + Tailwind + daisyUI app; superseded by the React + Spectrum stack above.
- [Release](./release.md): cut a semantic version tag from `main`, run the release gate, publish GHCR images, and verify GitHub Release notes
- [Docker app image](./docker-app.md): build and run the single-container app image with Caddy, NanoCore, and web assets
- [Docker dev/e2e image](./docker-dev-e2e.md): build and run the debug-only image for NanoCore and web e2e validation
- [Python setup](./python-setup.md): add a Python app or package with `uv`, `ruff`, `mypy`, and `pytest`
- [Go setup](./go-setup.md): add a Go app or package with Go modules, `gofmt`, `golangci-lint`, and `go test`
- [Rust setup](./rust-setup.md): add a Rust app or package with `cargo`, `cargo fmt`, and `cargo clippy`
- [Zig setup](./zig-setup.md): add a Zig package or native bridge layer with `zig build`

## Working Rules

- Read the cookbook that matches your task before scaffolding anything.
- Prefer official CLIs and generators over hand-written starter files.
- Run cookbook commands through `mise exec -- ...` unless the cookbook documents an exception.
- After scaffolding an app or package, add the required local `README.md` and add `AGENTS.md` only when local agent execution rules are needed.
