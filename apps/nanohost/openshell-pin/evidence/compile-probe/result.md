# WP-1A disposable Cargo compile probe — result

Run on the declared execution host (A1, Linux aarch64) against the complete non-shallow clone at
tag `v0.0.99`, commit `8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032`. Probe crate is disposable and
lives outside the repository at `~/nanohost-stage/probe` on A1; nothing was written to `apps/`.

**Result: `cargo check` passes.**

The probe references, and therefore type-checks:

- `OpenShellClient::create_sandbox`, `get_sandbox`, `list_sandboxes(ListOptions)`, `delete_sandbox`
  — the typed lifecycle surface.
- `OpenShellClient::raw_grpc()` → the generated client's `forward_tcp(...)` with an outbound
  `ReceiverStream<TcpForwardFrame>` — the raw forwarding surface.
- `openshell_sdk::raw::proto::TcpForwardFrame` — the frame type the bridge carries.
- `OpenShellClient::raw_grpc()` → the generated client's unary-request/server-streaming `exec_sandbox(ExecSandboxRequest)` used only by the worker bootstrap and response monitor, plus bidirectional `exec_sandbox_interactive(...)` with an outbound `ReceiverStream<ExecSandboxInput>` used only by the fixed interactive single-file helper. These are the two raw exec roots in the exact eleven-root consumed set.

One signature correction against the source-classification report: `list_sandboxes` takes a
`ListOptions` argument (`crates/openshell-sdk/src/client.rs:181`), it is not nullary.

## No server crates, proved from the resolved graph rather than from manifests

`cargo tree` over the probe resolves exactly two OpenShell crates:

```
openshell-core v0.0.0
openshell-sdk  v0.0.0
```

A filter for `openshell-(server|gateway-interceptors|driver|supervisor|cli|tui|prover)` returns
nothing. The SDK path therefore satisfies the no-server-crate-linking rule as an observed property
of the dependency graph, not as an inference from the manifest.

## Transport stack actually resolved

| Crate | Resolved |
| --- | --- |
| tonic | 0.14.6 |
| prost | 0.14.3 |
| hyper | 1.9.0 |
| h2 | 0.4.13 |
| rustls | 0.23.38 |
| tokio | 1.52.1 |

Toolchain used: `rustc 1.97.1`, satisfying the upstream workspace floor of `rust-version = "1.90"`
and edition 2024.

## Bounded scope of this evidence

The probe proves the client surface compiles and links no server crate. It does not prove any
runtime behaviour — pairing, streaming, cancellation, flow control, target restriction, or the
failure group are all WP-1 real-use obligations. The probe also ran under a rustup toolchain rather
than through `apps/nanohost/mise.toml`, which does not exist until the WP-1A builder creates it; the
manifest builder re-runs it through the pinned path so the oracle's toolchain clause is satisfied by
the pinned toolchain and not by this run.

## F20 exact-pin rerun

On 2026-08-11, the retained probe was staged without changing `Cargo.toml` or `Cargo.lock` beside the clean complete pinned checkout at `8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032` and run with the app-local Rust 1.97.1 toolchain. `cargo check --locked` passed, proving both the unary `raw_grpc().exec_sandbox(ExecSandboxRequest)` worker-bootstrap call and the fake `ReceiverStream<ExecSandboxInput>` call to `raw_grpc().exec_sandbox_interactive(...)` for the interactive single-file helper compile against the existing graph.

The rerun's `cargo tree --locked` still resolved exactly `openshell-sdk` and `openshell-core` among OpenShell crates. Filtering for `openshell-(server|gateway-interceptors|driver|supervisor|cli|tui|prover)` returned no matches, so the interactive call required no dependency, manifest, or lockfile change.
