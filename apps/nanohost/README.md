# NanoHost (`@openkit/nanohost`)

NanoHost is the OpenKit execution-host service: one Rust binary crate that owns one private Runtime Epoch at a time, talks to one stock OpenShell Gateway over a loopback client channel, and maintains one authenticated NanoCore transport session.

## Scope

- One binary crate named `nanohost` under `apps/nanohost`
- App-local Rust toolchain pin `1.97.1` via `mise.toml`
- OpenShell pin evidence and protobuf snapshot under `openshell-pin/` (owned separately from this scaffold)
- One controlled `linux/arm64` distribution with a verified installer that never manages service lifecycle

## Internal roles

These are responsibility boundaries inside one binary, not separate crates, plugins, or public interfaces:

| Role | Module |
| --- | --- |
| Epoch coordinator | `src/epoch_coordinator.rs` |
| NanoCore-session owner | `src/nanocore_session.rs` |
| OpenShell-client owner | `src/openshell_client.rs` |
| Per-sandbox bridge owner | `src/sandbox_bridge.rs` |
| Epoch-external image store | `src/image_store.rs` |
| Image acquisition and build | `src/image_acquisition.rs` |
| Epoch invalidation evidence | `src/epoch_evidence.rs` |

Credential-slot ownership stays under the NanoCore-session role boundary rather than becoming another transport role: `src/credential_slots.rs` owns the stable deployment-configured A/B Token slot pair (raw `okt_` secret + non-secret companion metadata), `0600` usability checks, companion parse, runtime generation selection, the same-owner `write_credential_slot` delivery helper, and `clear_credential_slot` for rotation cutover/abort steady-state cleanup.

`src/nanocore_session.rs` consumes `credential_slots::select_usable_credential`, classifies NanoCore rendezvous TLS requirements (exact same-host loopback plaintext only; all other hosts require server-authenticated TLS), prepares a minimum rustls verified-TLS client for non-loopback HTTPS using either platform roots or the configured CA PEM exclusively (rejecting plaintext downgrade and missing, unreadable, empty, invalid, or unusable trust material), opens the exact TCP/TLS stream, presents at most the selected usable slot, and refuses post-rejection second-slot fallback. Its outbound H2 client sends the exact `{}` admission body and accepts NanoCore's assigned generation and verified identity/deployment binding. Only after `EpochCoordinator::start` succeeds and that admission is authoritative does the same physical connection send exact `{}` to fixed private `POST /api/nanohost/transport/session/readiness`, await its durable empty `204`, and begin the first effect poll. The retained connection polls and submits correlated results for exactly eight fixed command/result pairs: `sandbox.create`, `sandbox.delete`, `bridge.open`, `bridge.close`, `image.acquire`, `image.build`, `file.export`, and `reference.import`; the request path selects the local owner and the body cannot select an operation. A complete fair cycle in which all eight paths return empty `204` waits 100 milliseconds before the next cycle, while an accepted command is dispatched without that idle delay. Immediately after accepting one fixed poll and before dispatching its local owner, NanoHost writes one value-free journal marker carrying only the closed operation name. `sandbox.create` requires the complete NanoCore-derived structured AEP policy and places it directly in the pinned raw OpenShell request, rejecting missing or malformed policy. After an observed close, a strictly increasing successor repeats admission and readiness before restoring carriage without rebuilding or relaunching the live epoch, while close or failure fences the exact prior generation non-ready. At process entry NanoHost installs the existing ring provider before any runtime or TLS construction, and each NanoCore-session client configuration also selects it explicitly for module-local construction. Certificate-pin references are not a supported V1 projection, and no alternate endpoint, trust source, credential slot, or transport fallback exists.

`src/sandbox_bridge.rs` owns the one fixed `127.0.0.1:17891` Sandbox Integration target, the stock `TcpForwardFrame` byte adapter, one bounded standard HTTP/2 server with the exact worker-control, inference, and selected-MCP capability namespaces, predecessor fencing, and the epoch-local 8 MiB/300-second produced-fact buffer. `src/openshell_client.rs` opens that pair through one connected SDK client by issuing `CreateSshSession`, calling `ForwardTcp` once, and revoking or discarding the short-lived authorization at close. `bridge.open` uses that client's fixed unary `ExecSandbox` request to Start exactly `/usr/local/bin/openkit-worker-shim` in `/workspace` with no arguments, environment values, stdin bytes, or interactive selector; it accepts the arbitrarily split fixed `OPENKIT_WORKER_SHIM_ENTRY_V1\n` stdout marker after the image-owned listener is installed, retains the response monitor concurrently with `ForwardTcp`, and releases readiness only after the exact first credential-free Harness poll returns empty `204`. The bridge projects only `/worker-control/harness/poll` and `/worker-control/harness/result` with the current private binding, rejects client-supplied bearer or binding headers, and preserves the long-lived Harness and monitor across outer reconnect without relaunch. Per-Turn export uses the existing final-status and process-group-absence barriers; clean bootstrap Exit and response completion are required only when the Harness ends. This adds no generic exec, caller or configuration selector, fallback, ninth effect, fourth namespace, or second connection.

The NanoHost starts one fresh Runtime Epoch beneath `/var/lib/openkit/nanohost` and `/run/openkit/nanohost`. The locally implemented Docker realization keeps the NanoHost parent on the host NanoCore route while placing the epoch-private `containerd`, dedicated `dockerd`, and checksum-verified stock OpenShell Gateway in one fresh network namespace reached by one manifest-owned foreground `slirp4netns` member. Deployment remains blocked until the dedicated A1 noninterference gate proves that this correction prevents the system Docker `docker0` and nftables damage observed with the preceding `--bridge none` realization. The service and every sandbox payload remain in `openkit-nanohost.slice`, normal stop and abnormal exit deactivate the whole slice, and no member has an independent restart path.

The private Image Store at `/var/lib/openkit/nanohost-images` is outside the Runtime Epoch and credential roots. It retains verified inert content plus private bounded metadata, re-verifies content on read, discards corrupt entries, enforces a 200 GiB ceiling, and protects required deployment and live-attempt digests during least-recently-imported eviction. It has no listener or credential surface.

Readiness imports a non-empty required deployment digest set only from the Image Store after the fresh private containerd and Docker sockets are ready and before the Gateway is spawned. It applies a 45-second per-image bound and re-inspects each exact digest before startup can proceed to Gateway health. Missing deployment inputs, missing or corrupt store content, import failure, or digest mismatch terminate the partial backend epoch and remain fail-closed; readiness performs no acquisition or build.

Docker presence probes, image loads, and post-load inspections retain distinct failure categories. Load and inspection subprocess diagnostics flow directly to the existing service journal.

Each import attempt removes its archive and then its empty staging directory before returning, allowing the same private backend to serve later attempts without relaxing fresh-only directory creation.

The bounded build path validates immutable local inputs, invokes direct `/usr/bin/docker buildx build` against the exact private socket and owned build-root working directory, and loads its generated sibling policy through `cwd://policy.rego` with reset and strict default deny. Policy equality uses explicit `:443` for default HTTPS while preserving an already declared port and exact endpoint path. The path checks Buildx 0.35, BuildKit 0.31, and `exec.proxy`, and relies on Buildx's OCI-output pre-Solve capability check before any build effect. Its closed verifier accepts one standard Buildx OCI index descriptor with typed annotations and platform metadata, then verifies the exact manifest and complete config/layer graph. The connected `image.build` effect admits that verified OCI result to the Image Store and imports its exact digest into the epoch-private Docker backend; it does not tag, push, publish, use a shell, or project build egress into a runtime sandbox.

Registry acquisition accepts only the two closed trigger classes and anonymous exact-digest Docker Hub or GHCR references. The crate-private ORAS `oci-client` path retains the raw source image manifest, rejects image indexes and supplied credentials, streams each config and layer under its declared size and the total store bound, verifies every descriptor, generates only a minimal private OCI layout, cleans staging before admission, and reuses the full OCI archive verifier and Image Store admission. The connected `image.acquire` effect invokes this path for one authorized attempt and imports the resulting exact digest into the epoch-private Docker backend; readiness never invokes it.

The two data effects use one fixed file-data stream on the same authoritative outer H2 physical connection, while control-effect JSON continues to carry only bounded metadata and references. `reference.import` receives the exact regular-file body as the raw command response, verifies it in NanoHost request-private staging, then uses the fixed `/usr/local/bin/openkit-file-effect` helper through the existing internal `ExecSandboxInteractive` RPC to stream it into the declared sandbox slot. The helper completes from the declared request length under the 64 KiB frame and 256 MiB aggregate bounds; NanoHost keeps the request sender open through exact Exit and clean response completion and drops it only after settlement, never sending request EOF first. After the terminal barrier, `file.export` uses that same fixed helper and internal RPC to collect one bounded regular file, computes its actual digest and length, atomically stages it under the private export root, and sends the exact body and produced facts as the raw result; the Workspace change manifest alone may instead return the exact proved optional-absence JSON without staging bytes. NanoCore verifies either closed result before handing present bytes to the existing canonical owner or treating the absent manifest as no changes. This is not a general sandbox-exec surface and accepts no caller-selected executable, second connection, or generic transfer envelope.

After accepted byte-free build metadata, NanoHost fetches the exact 1-through-268,435,456-byte inline Dockerfile once on fixed `POST /api/nanohost/transport/effects/image.build/input` as the third use of that file-data reservation, matches request identity, both lengths, digest, complete UTF-8 body, and at-most-64-KiB releases before any build effect, while pre-verification failure and post-admission reconnect retain only the correlated unchanged result and never refetch or replay input bytes.

Private epoch invalidation evidence is appended under `/var/lib/openkit/nanohost-evidence` before every initiated fence. One bounded worker isolates each report write from the fence, which proceeds after at most two seconds without waiting for slow filesystem work. Reports and observable-state prior-epoch disposition notes are redacted, bounded to 8 MiB, mode `0600` under a mode-`0700` root, and pruned to the newest 20 owned artifacts. Startup records one disposition note before fresh epoch creation when residual epoch roots prove NanoHost-absent recovery. Reports and notes remain forensic output only: recovery, readiness, and capacity never read them. A separate temporary prior-fence timestamp carries the 90-second target and inclusive 300-second hard-limit measurement across one process restart, is consumed after successful readiness, and is absent on a true fresh start.

## Distribution

Tagged releases include `openkit-nanohost-<tag>-linux-arm64.tar.gz` and the shared `SHA256SUMS`. The archive contains the NanoHost binary, the exact pinned stock OpenShell Gateway and license files, the service unit, generated manifest, inner checksums, and `install.sh`.

After verifying the outer checksum and extracting the archive, run `./install.sh --check` to verify package bytes, the exact promoted host prerequisites, and one of `installable`, `already-installed`, `resumable`, or nonzero `destination-conflict` without writing or invoking `systemctl`. Run `DESTDIR=/new/canonical/path ./install.sh` for a contained staging installation. A live `./install.sh` writes only the two binaries and service unit, reports the remaining configuration, enrollment, image, and service-start work, and never starts, stops, restarts, enables, or reloads a service.

`nanohost --version` prints the Cargo-owned version before Tokio runtime construction or configuration and runtime effects. The unique execution-host identity bytes consumed by host assertion and release packaging live at `deploy/host-manifest.json`.

## Native service

`/etc/openkit/nanohost.env` is the sole execution-host input source. Set required non-empty `OPENKIT_NANOHOST_IDENTITY_ID`, `OPENKIT_NANOHOST_DEPLOYMENT_ID`, and `OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL`; four absolute pairwise-distinct `OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE`, `OPENKIT_NANOHOST_TOKEN_SLOT_A_COMPANION_FILE`, `OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE`, and `OPENKIT_NANOHOST_TOKEN_SLOT_B_COMPANION_FILE` references; optional absolute `OPENKIT_NANOHOST_NANOCORE_CA_FILE`; and `OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS=sha256:<digest>[,sha256:<digest>...]`. The digest input accepts one to four unique canonical lowercase digests, and every referenced OCI archive must already be admitted to the Image Store before service start. The raw `okt_` Token exists only in the two mode-`0600` secret files and never in the environment file.

NanoHost validates every session and image input before evidence, recovery, Image Store, Runtime Epoch, backend, Gateway, or network-session effects. It then starts the fresh Runtime Epoch, selects the usable credential at connection time, and runs the authenticated NanoCore session concurrently with epoch member supervision; either terminal session failure or member failure exits the service so the existing fail-stop group is torn down.

The current one-Sandbox realization rejects a second create before calling OpenShell while any Sandbox, bridge, or Harness monitor remains retained. NanoCore owns compatible reuse and clean retirement of an incompatible idle Sandbox; this preflight prevents an invalid second create from producing an untracked native Sandbox.

The operator must first install the exact manifest-owned `/usr/bin/slirp4netns` OS package; repository host provisioning never installs or upgrades it and host assertion will verify its path, version, and SHA-256. Then build and install the NanoHost binary, checksum-verified stock OpenShell `v0.0.99` Gateway, and the single systemd service from `apps/nanohost`:

```bash
mise exec -- cargo build --release
sudo install -D -m 0755 target/release/nanohost /usr/lib/openkit/nanohost
sudo install -D -m 0755 /path/to/checksum-verified/openshell-gateway /usr/lib/openkit/openshell-gateway
sudo install -D -m 0644 deploy/openkit-nanohost.service /etc/systemd/system/openkit-nanohost.service
sudo systemctl daemon-reload
```

Start, stop, and inspect the service and its shared slice with:

```bash
sudo systemctl start openkit-nanohost.service
sudo systemctl stop openkit-nanohost.service
sudo systemctl status --no-pager openkit-nanohost.service
sudo systemctl show openkit-nanohost.service -p ControlGroup -p Slice -p KillMode -p Restart -p TimeoutStopUSec
sudo systemctl status --no-pager openkit-nanohost.slice
```

A1 subsequently disproved the earlier host-network noninterference claim: three private Docker starts removed the live system Docker `docker0` projection because the dedicated rootful daemon still shared the host network namespace. The epoch-private namespace correction is locally implemented and independently reviewed, but NanoHost must remain stopped on A1 until exact rebuilt bytes prove both its internal lifecycle and unchanged system Docker bridge, nftables, business-container attachments, and build egress across start, stop, member failure, and NanoHost `SIGKILL`.

## Commands

From the repository root:

```bash
pnpm --filter @openkit/nanohost build
pnpm --filter @openkit/nanohost test
pnpm --filter @openkit/nanohost lint
pnpm --filter @openkit/nanohost format
```

From `apps/nanohost` with the app-local mise pin active:

```bash
cargo build
cargo test
cargo fmt --check && cargo clippy --all-targets --all-features -- -D warnings
cargo fmt
```

## Related documentation

- Spec: [docs/specs/20260802-nanohost_runtime_and_transport.md](../../docs/specs/20260802-nanohost_runtime_and_transport.md)
- Rust setup: [docs/cookbooks/rust-setup.md](../../docs/cookbooks/rust-setup.md)
- Apps index: [apps/README.md](../README.md)
