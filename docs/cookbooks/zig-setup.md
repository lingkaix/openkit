# Zig Setup Cookbook

Use this cookbook when a repository based on this template needs to add a Zig package or native bridge layer.

## Policy

- Follow this cookbook instead of inventing a custom Zig setup flow.
- Use `mise` to install and manage the Zig toolchain and Zig development tools for this sub-project.
- Keep Zig-related tool versions in the appropriate `mise.toml` for the scope that owns the toolchain.
- Run Zig setup and maintenance commands through `mise exec -- ...`.
- Use Zig for native libraries, C/C++ bridge layers, and WebAssembly outputs when the same core library must serve both native and web targets.
- Use `zig build` as the builder.
- Use `zig fmt` as the formatter.

## Tooling Matrix

- runtime/compiler: `zig`
- package manager: Zig project tooling
- builder: `zig build`
- formatter: `zig fmt`
- linter/static checks: repository-specific; document the chosen strategy in the local `README.md`

## Setup Flow

1. Scaffold the package with `mise exec -- zig init`.
2. Add a local `README.md`.
3. Document output targets for native artifacts, C ABI bridges, or WebAssembly if applicable.
4. Add package-level commands for build and format.
5. Add a local `AGENTS.md` only when the package has local agent execution rules.

## Notes

- If Zig is still an opt-in local stack, prefer a sub-project `mise.toml`; only promote Zig entries into the root `.mise.toml` when the repository adopts Zig as shared infrastructure.
- If the Zig package becomes the foundation for multiple language bindings, document the binding strategy in the local `README.md`.
