# Retrieval Kernel

This Rust executable implements the accepted [Retrieval Kernel](../../docs/specs/20261014-retrieval_kernel.md). R1 owns the kernel, directory adapter, CLI, stdio MCP, and trusted local stdio service. NanoCore adapters, owner amendments, deployment, and release packaging belong to R2.

Use the app-local mise Rust 1.97.1 pin and bare Cargo commands. Run `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test` from this directory. The root Cargo workspace contains this app. NanoHost retains its independent manifest and lockfile.

The implementation and its service contract are in preparation. Independent review belongs to the primary and engineer.
