# NanoHost (`@openkit/nanohost`)

NanoHost is the OpenKit execution-host service: one Rust binary crate that owns one private Runtime Epoch at a time, talks to one stock OpenShell Gateway over a loopback client channel, and maintains one authenticated NanoCore transport session.

## Scope

- One binary crate named `nanohost` under `apps/nanohost`
- App-local Rust toolchain pin `1.97.1` via `mise.toml`
- The official OpenShell SDK fixed by Cargo, external release identities under `openshell/release.json`, and three source-backed transport assumptions under `openshell/`
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
| Epoch-external retained Worker volumes | `src/persistent_volume.rs` |

Credential-slot ownership stays under the NanoCore-session role boundary rather than becoming another transport role: `src/credential_slots.rs` owns the stable deployment-configured A/B Token slot pair (raw `okt_` secret + non-secret companion metadata), `0600` usability checks, companion parse, runtime generation selection, the same-owner `write_credential_slot` delivery helper, and `clear_credential_slot` for rotation cutover/abort steady-state cleanup.

`src/nanocore_session.rs` consumes `credential_slots::select_usable_credential`, classifies NanoCore rendezvous TLS requirements (exact same-host loopback plaintext only; all other hosts require server-authenticated TLS), prepares a minimum rustls verified-TLS client for non-loopback HTTPS using either platform roots or the configured CA PEM exclusively (rejecting plaintext downgrade and missing, unreadable, empty, invalid, or unusable trust material), opens the exact TCP/TLS stream, presents at most the selected usable slot, and refuses post-rejection second-slot fallback. Its outbound H2 client sends the exact `{}` admission body and accepts NanoCore's assigned generation and verified identity/deployment binding. Only after `EpochCoordinator::start` succeeds and that admission is authoritative does the same physical connection send exact `{ "physicalEpoch": "<64 lowercase hexadecimal characters>" }` to fixed private `POST /api/nanohost/transport/session/readiness`, await its durable empty `204`, and begin the first effect poll. The retained connection polls and submits correlated results for exactly eleven fixed command/result pairs: `sandbox.create`, `sandbox.delete`, `bridge.open`, `bridge.close`, `image.acquire`, `image.build`, `file.export`, `reference.import`, `image.inspect`, `storage.inspect`, and `storage.purge`; the request path selects the local owner and the body cannot select an operation. A complete fair cycle in which all eleven paths return empty `204` waits 100 milliseconds before the next cycle, while an accepted command is dispatched without that idle delay. Read-only inspection results are not retained across connection loss. Purge returns `purged`, `retained`, or `unknown`; loss of its result requires fresh inspection instead of deletion replay or unrelated epoch restart. Immediately after accepting one fixed poll and before dispatching its local owner, NanoHost writes one value-free journal marker carrying only the closed operation name. `sandbox.create` requires the complete NanoCore-derived structured AEP policy and exact storage association and places NanoHost-derived mounts directly in the pinned raw OpenShell request, rejecting missing or malformed policy. After an observed close, a strictly increasing successor repeats admission and readiness before restoring carriage without rebuilding or relaunching the live epoch, while close or failure fences the exact prior generation non-ready. At process entry NanoHost installs the existing ring provider before any runtime or TLS construction, and each NanoCore-session client configuration also selects it explicitly for module-local construction. Certificate-pin references are not a supported V1 projection, and no alternate endpoint, trust source, credential slot, or transport fallback exists.

`src/sandbox_bridge.rs` owns the one fixed `127.0.0.1:17891` Sandbox Integration target, the stock `TcpForwardFrame` byte adapter, one bounded standard HTTP/2 server with the exact worker-control, inference, and selected-MCP capability namespaces, predecessor fencing, and the epoch-local 8 MiB/300-second produced-fact buffer. `src/openshell_client.rs` opens that pair through one connected SDK client by issuing `CreateSshSession`, calling `ForwardTcp` once, and revoking or discarding the short-lived authorization at close. `bridge.open` uses that client's fixed unary `ExecSandbox` request to Start exactly `/usr/local/bin/openkit-worker-shim` in `/workspace` with no arguments, environment values, stdin bytes, or interactive selector; it accepts the arbitrarily split fixed `OPENKIT_WORKER_SHIM_ENTRY_V1\n` stdout marker after the image-owned listener is installed, retains the response monitor concurrently with `ForwardTcp`, and releases readiness only after the exact first credential-free Harness poll returns empty `204`. The bridge projects only `/worker-control/harness/poll` and `/worker-control/harness/result` with the current private binding, rejects client-supplied bearer or binding headers, and preserves the long-lived Harness and monitor across outer reconnect without relaunch. Per-Turn export uses the existing final-status and process-group-absence barriers; clean bootstrap Exit and response completion are required only when the Harness ends. This adds no generic exec, caller or configuration selector, fallback, fourth namespace, or second connection.

The NanoHost starts one fresh Runtime Epoch beneath `/var/lib/openkit/nanohost` and `/run/openkit/nanohost`. The locally implemented Docker realization keeps the NanoHost parent on the host NanoCore route while placing the epoch-private `containerd`, dedicated `dockerd`, and checksum-verified stock OpenShell Gateway in one fresh network namespace reached by one manifest-owned foreground `slirp4netns` member. Deployment remains blocked until the dedicated A1 noninterference gate proves that this correction prevents the system Docker `docker0` and nftables damage observed with the preceding `--bridge none` realization. The service and every sandbox payload remain in `openkit-nanohost.slice`, normal stop and abnormal exit deactivate the whole slice, and no member has an independent restart path.

The private Image Store at `/var/lib/openkit/nanohost-images` is outside the Runtime Epoch and credential roots. It retains verified inert content, re-verifies content on read and removes corrupt entries. Verified images are never automatically evicted. Its host-local `capacity` file defaults to 200 GiB and controls subsequent growth; lowering the limit preserves existing images and running Workers. Per-transaction directory locking coordinates service and administrator access; explicit unlock at transaction exit prevents a concurrently forked child from retaining that lock until exec. Physical content-file sizes include incomplete and temporary archives in capacity accounting. Exact administrator removal affects the named stored image, not private-backend images, running containers or retained Worker volumes. The store has no listener or credential surface.

The retained Worker volume store at `/var/lib/openkit/nanohost-work` is also outside Runtime Epoch roots. NanoHost hashes opaque Core refs into root-owned mode-`0700` association paths, keeps scope, layout, and attachment identity outside worker-writable children, and validates metadata and mount targets without following symlinks. `image.inspect` reads only an exact locally installed digest and derives the ordered layout from numeric OCI `User`, `WorkingDir`, platform, `Config.Volumes`, and the descriptive `org.openkit.storage.family` and `org.openkit.storage.version` labels. First attachment seeds each new target once through a stopped, never-executed private-Docker container and bounded staging validation; existing targets are never reseeded and missing initialized targets fail closed. The Gateway enables bind mounts, while `src/openshell_client.rs` alone emits fixed writable Docker binds from verified local paths. Sandbox deletion and a proved whole-epoch writer fence release attachment metadata without deleting bytes. Epoch cleanup and image pruning never purge this store; only exact `storage.purge` after generation and writer-fence checks removes one association.

Readiness starts the private backend and stock Gateway without preloading Worker images. Empty Worker-image storage is valid. The pinned stock OpenShell Gateway may still contact GHCR to obtain its Supervisor before Gateway health and NanoCore readiness; this accepted upstream bootstrap remains unchanged and means startup is not guaranteed to work offline. Inspect the exact NanoHost/Gateway failure and host DNS, HTTPS and proxy access when diagnosing it; do not bypass TLS, change pinned binaries or erase retained Worker data.

Point-of-use `image.acquire` verifies retained image content before checking or importing the exact digest into the private backend, followed by readonly `image.inspect` before storage admission and Sandbox creation. A bare canonical `sha256:` reference is local-only and never falls back to a registry or build. A registry reference can reuse verified retained content without fetching. Missing or invalid content fails the current operation without restarting an otherwise healthy epoch. Imports pass a verified file descriptor directly to Docker stdin, reject archive-supplied names in the reserved private alias namespace, use the existing 45-second bound and re-inspect the selected manifest through Docker's `Descriptor.digest`. Docker presence probes, loads and post-load inspections retain distinct failure categories, with subprocess diagnostics in the service journal.

The bounded build path validates immutable local inputs, invokes direct `/usr/bin/docker buildx build` against the exact private socket and owned build-root working directory, and loads its generated sibling policy through `cwd://policy.rego` with reset and strict default deny. Policy equality uses explicit `:443` for default HTTPS while preserving an already declared port and exact endpoint path. The path checks Buildx 0.35, BuildKit 0.31, and `exec.proxy`, and relies on Buildx's OCI-output pre-Solve capability check before any build effect. Its closed verifier accepts one standard Buildx OCI index descriptor with typed annotations and platform metadata, then verifies the exact manifest and complete config/layer graph. The connected `image.build` effect admits that verified OCI result to the Image Store and imports its exact digest into the epoch-private Docker backend; it does not push, publish, use a shell, or project build egress into a runtime sandbox. Exact-digest build parents use verified Image Store content first. One naming-neutral OCI archive per unique parent preserves and reverifies the manifest/configuration/layer bytes before private backend import; source annotations and Docker RepoTags cannot overwrite backend aliases. The serialized lifecycle owner binds `openkit.invalid/retained-parent:<manifest-sha256>` only when absent, reuses an exact binding and refuses conflicts. A named `docker-image` context preserves the authored FROM, while strict policy requires both that alias and the resolved manifest checksum independently of broader registry allows. Definite Store absence alone permits registry resolution; retained import or alias failures never fall back. Verified inputs and temporary projections each have a 20 GiB aggregate bound, projections share existing build-root cleanup, and the declared build deadline covers preparation and imports. Aliases use the existing private daemon cache and epoch lifetime without a new journal or cleanup owner. The authored Dockerfile, empty AEP context, strict policy and public effect contract remain unchanged.

Registry acquisition accepts only the two closed trigger classes and anonymous exact-digest Docker Hub or GHCR references. The crate-private acquisition path keeps authentication and blob transfer in ORAS `oci-client`; a bounded `reqwest` manifest GET replaces that dependency's whole-body manifest helper, preserving HTTPS, the selected reference and raw digest checks. It rejects image indexes and supplied credentials, streams each config and layer under its declared size and the 20 GiB archive bound, verifies every descriptor, generates only a minimal private OCI layout, cleans staging before admission, and reuses the full OCI archive verifier and Image Store admission. Archive transfer and hashing use at most 64 KiB chunks; each buffered OCI index, manifest or config is limited to 512 KiB. The connected `image.acquire` effect invokes this path for one authorized attempt and imports the resulting exact digest into the epoch-private Docker backend; readiness never invokes it.

The two data effects use one fixed file-data stream on the same authoritative outer H2 physical connection, while control-effect JSON continues to carry only bounded metadata and references. `reference.import` receives the exact regular-file body as the raw command response, verifies it in NanoHost request-private staging, then uses the fixed `/usr/local/bin/openkit-file-effect` helper through the existing internal `ExecSandboxInteractive` RPC to stream it into the declared sandbox slot. The helper completes from the declared request length under the 64 KiB frame and 256 MiB aggregate bounds; NanoHost keeps the request sender open through exact Exit and clean response completion and drops it only after settlement, never sending request EOF first. After the terminal barrier, `file.export` uses that same fixed helper and internal RPC to collect one bounded regular file, computes its actual digest and length, atomically stages it under the private export root, and sends the exact body and produced facts as the raw result; the Workspace change manifest alone may instead return the exact proved optional-absence JSON without staging bytes. NanoCore verifies either closed result before handing present bytes to the existing canonical owner or treating the absent manifest as no changes. This is not a general sandbox-exec surface and accepts no caller-selected executable, second connection, or generic transfer envelope.

After accepted byte-free build metadata, NanoHost fetches the exact 1-through-268,435,456-byte inline Dockerfile once on fixed `POST /api/nanohost/transport/effects/image.build/input` as the third use of that file-data reservation, matches request identity, both lengths, digest, complete UTF-8 body, and at-most-64-KiB releases before any build effect, while pre-verification failure and post-admission reconnect retain only the correlated unchanged result and never refetch or replay input bytes.

Private epoch invalidation evidence is appended under `/var/lib/openkit/nanohost-evidence` before every initiated fence. One bounded worker isolates each report write from the fence, which proceeds after at most two seconds without waiting for slow filesystem work. Uncertain sandbox create reports retain only the operation, sandbox and attempt lineage, elapsed time, and one closed certainty-loss point from the request, response, typed Ready observation, Error phase, or fixed Ready deadline; a Ready identity mismatch remains a distinct member identity change. Reports and observable-state prior-epoch disposition notes are redacted, bounded to 8 MiB, mode `0600` under a mode-`0700` root, and pruned together to the newest 20 owned artifacts by their validated timestamp-sequence suffix. Startup records one disposition note before fresh epoch creation when residual epoch roots prove NanoHost-absent recovery. Reports and notes remain forensic output only: recovery, readiness, and capacity never read them. A separate temporary first-fence timestamp carries the 90-second target and inclusive 300-second hard-limit measurement across process restarts, every later failure path preserves it, and authoritative admission derives one absolute monotonic deadline from the remaining interval that covers readiness request construction, send, and the complete exact empty `204` response. Only an acknowledgement completed within that deadline consumes the marker, and a true fresh start has no marker.

Containerd creates one recursively private mount namespace with a single read-only `/etc/resolv.conf` projection of the validated epoch resolver set. Dockerd and Gateway join that same mount namespace so containerd sees Docker-mounted image roots; NanoHost proves each member against the retained mount descriptor. The Gateway connector enters only the retained network namespace, and the NanoHost parent and slirp resolver remain unchanged. Docker `--dns` supplies the same set to containers; it does not configure daemon registry lookups. The inherited system Docker socket mask remains in place, and the host resolver is unchanged. An unavailable upstream or failed resolver projection fails startup without a fallback.

The readiness witness is the SHA-256 of the actual fresh `EpochPlan` name, retained by the live coordinator across reconnects and lost acknowledgements. A new physical Epoch gets a new witness; connection generation and readiness timestamps do not identify it. NanoCore binds physical handles to their originating witness and requires current authenticated readiness before reuse or retirement. Upgrading a predecessor without this witness requires the coordinated cold conversion described in the [operations reference](../../skills/openkit-ops/references/nanocore-operations.en.md#convert-a-pre-witness-deployment); ordinary App-only updates preserve the running Host.

## Distribution

Tagged releases include `openkit-nanohost-<tag>-linux-arm64.tar.gz` and the shared `SHA256SUMS`. The archive contains the NanoHost binary, the exact pinned stock OpenShell Gateway and license files, the service unit, generated manifest, inner checksums, and `install.sh`.

After verifying the outer checksum and extracting the archive, run `./install.sh --check` to verify package bytes, the exact promoted host prerequisites, and one of `installable`, `already-installed`, `resumable`, or nonzero `destination-conflict` without writing or invoking `systemctl`. Run `DESTDIR=/new/canonical/path ./install.sh` for a contained staging installation. A live `./install.sh` writes only the two binaries and service unit, reports the remaining configuration, enrollment, and service-start work, and never starts, stops, restarts, enables, or reloads a service.

`nanohost --version` prints the Cargo-owned version before Tokio runtime construction or configuration and runtime effects. The unique execution-host identity bytes consumed by host assertion and release packaging live at `deploy/host-manifest.json`.

## Native service

`/etc/openkit/nanohost.env` is the sole execution-host input source. Set required non-empty `OPENKIT_NANOHOST_IDENTITY_ID`, `OPENKIT_NANOHOST_DEPLOYMENT_ID`, and `OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL`; four absolute pairwise-distinct `OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE`, `OPENKIT_NANOHOST_TOKEN_SLOT_A_COMPANION_FILE`, `OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE`, and `OPENKIT_NANOHOST_TOKEN_SLOT_B_COMPANION_FILE` references; and optional absolute `OPENKIT_NANOHOST_NANOCORE_CA_FILE`. Worker-image digests are not service inputs and image availability is checked when work requests it. The raw `okt_` Token exists only in the two mode-`0600` secret files and never in the environment file.

NanoHost validates every session input before evidence, recovery, Image Store, Runtime Epoch, backend, Gateway, or network-session effects. It then starts the fresh Runtime Epoch, selects the usable credential at connection time, and runs the authenticated NanoCore session concurrently with epoch member supervision; either terminal session failure or member failure exits the service so the existing fail-stop group is torn down.

The current one-Sandbox realization rejects a second create before calling OpenShell while any Sandbox, bridge, or Harness monitor remains retained. NanoCore owns compatible reuse and clean retirement of an incompatible idle Sandbox; this preflight prevents an invalid second create from producing an untracked native Sandbox.

The operator must first install the exact manifest-owned `/usr/bin/slirp4netns` OS package; repository host provisioning never installs or upgrades it and host assertion will verify its path, version, and SHA-256. Then build and install the NanoHost binary, checksum-verified stock OpenShell `v0.0.99` Gateway, and the single systemd service from `apps/nanohost`:

```bash
cargo build --release
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

For authorized host-local image maintenance, use `/usr/lib/openkit/nanohost image import <archive> <expected-digest>`, `image remove <digest>`, `image list`, or `image capacity [<bytes>]`. These commands use the fixed private Image Store without loading service credentials, opening a network connection or starting the service/epoch. Capacity is a positive integer byte count; removal requires an exact digest and may make future Agent admissions unavailable until its image is supplied again. A busy store fails the current command; inspect and issue a fresh authorized request after the active transaction completes.

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
- OpenShell upgrades and failure diagnosis: [docs/cookbooks/openshell-upgrade.md](../../docs/cookbooks/openshell-upgrade.md)
- Apps index: [apps/README.md](../README.md)

Preparation image results may receive exact empty `503` while NanoCore cannot persist their validated outcome. NanoHost redelivers the identical result once per second on the same connection, pauses subsequent lifecycle effects including output collection, and never terminates the epoch merely because this deferral persists. Other operations and malformed responses retain their existing strict failure rules; independent member and connection failures still apply.
