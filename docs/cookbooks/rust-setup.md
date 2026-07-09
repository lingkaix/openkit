# Rust Setup Cookbook

Use this cookbook when a repository based on this template needs to add a Rust app or package.

## Policy

- Follow this cookbook instead of inventing a custom Rust setup flow.
- Use `mise` to install and manage the Rust toolchain and Rust development tools for this sub-project.
- Keep Rust-related tool versions in the appropriate `mise.toml` for the scope that owns the toolchain.
- Run Rust setup and maintenance commands through `mise exec -- ...`.
- Use `cargo` for package management and builds.
- Use `cargo fmt` as the formatter.
- Use `cargo clippy` as the linter.
- Use `cargo test` for testing.

## Tooling Matrix

- runtime/compiler: `rustc`
- package manager: `cargo`
- builder: `cargo build`
- linter: `cargo clippy --all-targets --all-features -- -D warnings`
- formatter: `cargo fmt`
- test runner: `cargo test`

## Setup Flow

1. Scaffold the project with `mise exec -- cargo new ...`.
2. Add a local `README.md`.
3. Add package-level commands for build, test, lint, and format.
4. Add a local `AGENTS.md` only when the project has local agent execution rules.

## Notes

- If Rust is still an opt-in local stack, prefer a sub-project `mise.toml`; only promote Rust entries into the root `.mise.toml` when the repository adopts Rust as shared infrastructure.
- Keep Rust opt-in and local to the sub-project until the repository deliberately promotes Rust to a root-level default stack.
