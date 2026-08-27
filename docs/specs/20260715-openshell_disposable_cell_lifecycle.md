---
status: Deprecated
implementation: Partial
status-changed: 2026-08-02
current-guidance: "`docs/specs/20260802-nanohost_runtime_and_transport.md`"
decision-evidence: "`docs/specs/20260802-nanohost_runtime_and_transport.md`"
---
# OpenShell Disposable Cell Lifecycle

## Lifecycle Reason

The per-AgentSession disposable Cell contract is deprecated because the accepted target moves all OpenShell lifecycle effects onto one configured NanoHost and makes one Runtime Epoch the fail-stop, uncertainty, and fresh-readiness boundary. NanoCore restart no longer needs per-session runtime recreation or NanoCore-owned OpenShell lifecycle control because a live NanoHost continues local operations and reconnects through exact existing lineage and sequence.

The target preserves the safety problem this contract solved but rejects its lifecycle granularity and authority placement. An accepted create or delete whose completion cannot be proved still requires a causal fence, but the fence is now whole-Runtime Epoch invalidation rather than one cold Cell per AgentSession.

## Retention Reason

The NanoHost path passed the required fault evidence on 2026-08-26, and the legacy implementation, configuration, commands, and current-support instructions were deleted. This document remains at the active root only until the governance-required terminal archive transition is executed by an auditor; it is not selectable implementation guidance.

The document preserves the tested stock OpenShell `0.0.80` facts, A1 fail-stop and late-create evidence, detached-launch proof, retry-safe cleanup markers, remote SSH and Gateway-forward topology, and exact NanoCore read-only restoration behavior. Those facts remain historical and migration evidence; they do not authorize new Cell work.

## Current Guidance

`docs/specs/20260802-nanohost_runtime_and_transport.md` is the sole current implementation-facing authority for NanoHost identity, Runtime Epoch, OpenShell lifecycle, supervision, readiness, communication, reconnect, and cleanup uncertainty.

`docs/specs/20260801-nanohost_workspace_data_boundary.md` owns only execution/data separation, native data authority, transfer direction, and the current one-NanoHost/one-slot boundary.

Every per-session Cell, NanoCore Cell owner, NanoCore helper, lifecycle SSH invocation, Gateway-forward, direct sandbox-to-NanoCore worker-control endpoint, and NanoCore read-only OpenShell handle described below is legacy implementation. It MUST NOT guide new design or be extended.

## Criterion Disposition

| Legacy criterion | Disposition | Exact destination and target meaning |
| --- | --- | --- |
| Stock OpenShell only; no fork, patch, replacement Gateway, private Supervisor, or private protocol. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `## Sandbox-To-Gateway Communication Boundary` and `## Security And Containment Rules` require stock components, standard HTTP/2, and no OpenKit multiplexer or private OpenShell surface. |
| An accepted create that can still arrive after resource-local cleanup requires a causal fence. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` section `### Uncertain Create Or Delete` invalidates the complete Runtime Epoch and fences capacity until fresh recovery. |
| Recovery creates fresh roots, network, authentication, Gateway state, and container-runtime state. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `### Epoch Creation` and `### Readiness` require fresh ownership plus absence of prior mutable state before admission. |
| Every effect-capable process is terminated before old capacity can return. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` section `## Runtime Epoch Topology And Supervision` places the NanoHost service, Gateway, container runtime, helpers, and sandboxes in one fail-stop group. |
| The stock Gateway remains loopback-only and is not directly exposed. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `## Sandbox-To-Gateway Communication Boundary` and `## Security And Containment Rules` retain loopback-only Gateway access through stock mechanisms. |
| Read-only image archives may remain outside the failure epoch only as inert input with no mutable runtime or authentication state. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` section `### Runtime Epoch` preserves the inert verified image-archive boundary. |
| Exact vendor version, checksum, component identity, and stock snapshot authority. | `duplicate` | `docs/specs/20260522-vendor_snapshot_packages.md` section `## Contract / Expected Behavior` already owns pinned vendor snapshot identity and verification; this legacy spec's concrete `0.0.80` evidence remains historical only. |
| Component and version preflight must pass before runtime readiness. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `### Epoch Creation` and `### Readiness` require pinned stock component and image identities before work is accepted. |
| Scheduler capacity is acquired before runtime preparation or launch. | `duplicate` | `docs/specs/20260703-durable_scheduler_design.md` section `## Admission And Launch` already owns acquisition and exact lease admission. |
| Capacity is released only after exact cleanup evidence succeeds, and cleanup failure keeps it held. | `duplicate` | `docs/specs/20260703-durable_scheduler_design.md` section `## Lease, Reconnect, And Cleanup` owns capacity release; `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `### Normal AgentSession End` and `### Uncertain Create Or Delete` supply the NanoHost cleanup proof it consumes. |
| Worker lifetime is not inferred from attached stock CLI lifetime, and detached launch requires observed stock proof. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` section `## Testing Strategy / Acceptance Criteria` requires the historical detached-launch proof to be reproduced or replaced only by a stronger observed stock mechanism. |
| Containment loss or inability to exclude escape denies new admission, external effects, and egress. | `duplicate` | `docs/core/sandbox.md` section `## Principles` already owns the fail-closed admission, effect, and egress response for the owning execution-substrate epoch. |
| Containment loss interrupts affected Turns and AgentSessions and withholds unaccepted publication. | `duplicate` | `docs/core/sandbox.md` section `## Principles` already owns interruption and non-publication; the shared-epoch consequence is projected by `docs/specs/20260802-nanohost_runtime_and_transport.md` section `## Security And Containment Rules`. |
| Potentially exposed Vault material follows existing revocation or rotation authority without claiming recall. | `duplicate` | `docs/core/vault.md` section `## Lifecycle And Failure Semantics` already owns revocation, rotation, stale-session, and non-recall semantics. |
| Containment loss invalidates the complete cleanup boundary and prohibits partial cleanup or old-environment reuse. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `## Security And Containment Rules` and `### Runtime Epoch Recovery` require whole-epoch invalidation and fresh recovery. |
| NanoCore restart classifies the exact surviving attempt before any replacement or cleanup effect. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` section `### NanoCore Restart Or Short Outage` and `docs/specs/20260704-agent_session_continuity.md` section `## Exact Reconnect Contract` require exact continuity or truthful interruption. |
| NanoCore reconstructs a launch-incapable read-only OpenShell handle after restart. | `rejected` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `### NanoCore Restart Or Short Outage` and `## Current Implementation Projection` keep local runtime ownership in the NanoHost and reconnect NanoCore through durable lineage instead of reconstructing an OpenShell handle. |
| Exact process key, lease, package, backend-session lineage, and next sequence are required for adoption. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `### NanoCore Restart Or Short Outage` and `### Required Scenario 1: NanoCore Restart During Active Work` require the same identities and exact next sequence without recreation. |
| Cleanup retry never guesses the target or outcome, and cleanup failure preserves evidence and capacity ownership. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `### Uncertain Create Or Delete` and `## Missing, Stale, Conflict, Retry, And Dependency Failure Semantics` fail closed, preserve uncertainty, and require fresh authority after invalidation. |
| The fixed Cell marker, boot identity, bridge record, same-owner retry, host lock, and owner-mismatch mechanisms are the target recovery model. | `rejected` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `## Runtime Epoch Topology And Supervision` and `### Runtime Epoch Recovery` use one OS-supervised epoch fence and explicitly add no durable NanoHost operation journal; the legacy marker machinery remains deletion evidence only. |
| One cold Gateway and container runtime are created per AgentSession. | `rejected` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `## Decision` and `### Normal AgentSession End` share one healthy Runtime Epoch and delete only the ended AgentSession's sandbox. |
| NanoCore is the OpenShell lifecycle authority and invokes a privileged Cell helper. | `rejected` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `## Decision` and `### Configuration And Installation` make the NanoHost the sole lifecycle authority and prohibit Cell helper configuration. |
| Fixed helper paths, caller-owned Cell paths, fixed SSH argv, and persisted SSH-target digest bind lifecycle effects. | `rejected` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `### Configuration And Installation` and `## Security And Containment Rules` prohibit NanoCore-supplied lifecycle commands and replace the remote target with one configured NanoHost identity and deployment binding. |
| SSH prepares and recycles the remote runtime. | `rejected` | `docs/specs/20260802-nanohost_runtime_and_transport.md` section `### Configuration And Installation` permits SSH only for installation-time safe-sink delivery, diagnostics, evidence, and human-authorized break-glass work, never runtime control. |
| NanoCore reaches a forwarded Gateway and the sandbox reaches a direct NanoCore worker-control endpoint. | `rejected` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `## NanoCore-To-NanoHost Communication Boundary` and `## Sandbox-To-Gateway Communication Boundary` replace both paths with one NanoHost session and one RelayStream projection. |
| Secrets, host paths, process ids, sockets, container ids, and backend-private evidence remain outside product records and public diagnostics. | `duplicate` | `docs/core/sandbox.md` section `## Must Not Expose` and `docs/core/vault.md` section `## Prohibited Surfaces` already own the private evidence and secret boundary; the target projects it in `docs/specs/20260802-nanohost_runtime_and_transport.md` section `## Security And Containment Rules`. |
| A process-survival, cleanup, or stock-runtime observation is never generalized beyond the tested topology and identities. | `received` | `docs/specs/20260802-nanohost_runtime_and_transport.md` sections `## Current Implementation Projection` and `## Testing Strategy / Acceptance Criteria` distinguish historical Cell observations from required target evidence and leave RelayStream feasibility explicitly unproved. |
| The current release has one configured NanoHost, one target, and one active worker slot despite the epoch's zero-or-more sandbox shape. | `duplicate` | `docs/specs/20260703-runtime_scheduling_scale.md` section `## Decision` owns the current scale ceiling; `docs/specs/20260802-nanohost_runtime_and_transport.md` section `## Decision` projects it into the epoch target. |
| A future smaller blast radius uses multiple independent NanoHosts rather than per-AgentSession Cells. | `deferred` | Owner: `docs/specs/20260703-runtime_scheduling_scale.md` section `## Deferred / Future Work`; activation condition: one measured capacity, network, compliance, isolation, or blast-radius need that requires more than the current single NanoHost and slot. |

## Rollout / Migration Plan

1. Completed: stock RelayStream, nested standard HTTP/2, and OS-supervision feasibility were proved without extending the Cell path.
2. Completed: the Runtime Epoch and Sandbox Integration were implemented under the current NanoHost authority.
3. Completed: NanoCore cut over to the sole NanoHost transport without a legacy runtime selector.
4. Completed: the four required NanoHost fault scenarios and their Aggregate passed on the declared A1 topology.
5. Completed: the Cell helper, controller, per-session lifecycle calls, remote lifecycle configuration, Gateway-forward assumptions, direct worker-control configuration, obsolete tests, and current-support instructions were deleted.
6. Pending governance execution: an auditor changes this specification to `Superseded`, sets implementation to `N/A`, moves it under `docs/specs/superseded/`, and retains it only as historical evidence.

The migration exit condition is that the NanoHost path is the sole selectable runtime path, the four fault scenarios are green on the declared topology, and no current code or operator guidance depends on a Cell concept. There is no compatibility path after deletion.

## Legacy Contract Warning

All remaining sections describe the partially implemented legacy Cell path as it exists before cutover. Their normative language applies only to maintaining and safely removing that legacy implementation; it MUST NOT be used to design the NanoHost runtime or justify new Cell, SSH, Gateway-forward, direct worker endpoint, or NanoCore lifecycle behavior.

## Legacy Ownership

- The source-free lifecycle boundary that OpenKit requires around stock OpenShell worker execution.
- The disposable Cell model that groups one stock OpenShell Gateway, one dedicated containerd, one dedicated dockerd, all epoch-local runtime state, and at most one active worker backend session.
- The prepare, recycle, restart-recovery, capacity-release, and failure semantics for that Cell.
- The stock-CLI-compatible detached worker-shim launch and exact read-only session-handle restoration required for NanoCore restart recovery.
- The local and remote fixed-command controller contracts used by NanoCore to invoke the privileged Cell helper without modifying OpenShell.
- The stock OpenShell version and component-identity preflight required before a Cell may become ready.

## Legacy Exclusions

- Core sandbox concepts, which belong to `docs/core/sandbox.md`.
- General scheduler records, leases, placement, and capacity accounting, which belong to `docs/specs/20260703-durable_scheduler_design.md`.
- Workspace synchronization and public product projections, which belong to the workspace synchronization specifications.
- OpenShell policy, provider, credential-injection, or schema-snapshot mappings, which belong to `docs/specs/20260703-openshell_mechanism_internalization.md` and the policy and vault specifications.
- OpenShell source code, internal protocols, release engineering, or upstream defect remediation.

## Historical Core References

- `docs/core/sandbox.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/storage.md`
- `docs/core/audit.md`

## Legacy Summary

OpenKit must consume official OpenShell artifacts without a fork, patch, replacement binary, or private protocol variant.

Stock OpenShell `0.0.80` does not expose a causal operation identity that lets a later delete prove that every previously accepted create has terminated before capacity is released.

Stock OpenShell `0.0.80` also exposes no detached `sandbox exec` mode. OpenKit therefore sends one fixed NanoCore-owned launcher argv through the stock attached exec path; the launcher creates a sandbox-owned `setsid` session, redirects all three standard streams away from the CLI connection, and starts the worker shim without modifying OpenShell.

A resource-level delete, list probe, stable-empty delay, process-local lock, or shared-Gateway restart can improve diagnostics but cannot fence an already accepted create that is still capable of reaching the container runtime.

The accepted source-free boundary is therefore one disposable OpenShell Cell per active backend session, whether the Cell is co-located with NanoCore or runs on a remote host.

The Cell contains the complete mutation path that could finish a late create: Gateway, containerd, dockerd, their cgroups, their state roots, their sockets, and their epoch-local authentication material.

NanoCore may release scheduler capacity only after the owning Cell is killed as one unit, every owned process is gone, and the epoch state and run roots are discarded.

The next session starts a fresh Cell and verifies that both stock OpenShell and the fresh Docker runtime are empty before materialization begins.

Detached-process survival is a bounded deployment fact, not an OpenShell-wide guarantee. NanoCore adopts only the exact worker process that presents its memory-only key, exact lineage, and next sequence before the durable deadline; otherwise it uses the existing evidence-preserving recycle path.

## Legacy Goals

- Eliminate every OpenKit-maintained OpenShell source fork or patch.
- Fence the observed late-create class without claiming an unsupported stock OpenShell guarantee.
- Preserve NanoCore as the source of durable session, lease, evidence, review, and cleanup truth.
- Keep restart cleanup possible from the durable backend identity without depending on process memory.
- Let a sandbox-owned worker shim survive loss of the attached stock OpenShell exec client and reconnect within the bounded worker-control recovery window.
- Support both co-located Cells and remote Cells controlled through one fixed SSH helper invocation.
- Make the accepted compromise observable and testable: one cold Cell, one active backend session, no shared runtime reuse.

## Legacy Non-Goals

- No shared OpenShell Gateway across concurrent OpenKit worker sessions.
- No warm Cell pool, live Cell reuse, or multi-session Cell.
- No naked or shared remote OpenShell Gateway outside an OpenKit-owned disposable Cell.
- No resource-level delete fallback that reports causal teardown success.
- No OpenShell source fork, patch queue, replacement Gateway, protocol shim, or private release artifact.
- No compatibility path for the previous shared-Gateway lifecycle.
- No general remote-execution daemon or arbitrary privileged command API.
- No custom OpenShell binary path, CLI TLS-verification bypass flag, external dependency fork, or patched OpenShell artifact.
- No claim that every local, remote, tunneled, container, or host-reboot topology preserves the worker process or reconnect route.

## Legacy Cell Boundary

One Cell owns exactly these effect-capable resources:

- one systemd slice with `KillMode=control-group` descendants
- one dedicated containerd address, root, state directory, and namespace
- one dedicated dockerd socket, data root, exec root, PID file, network address pool, and containerd namespaces
- one stock OpenShell Gateway process bound to a fixed loopback control and health endpoint
- one fresh Gateway config, data root, state root, and generated JWT signing bundle
- zero or one active OpenKit backend session

Read-only image tar archives may live outside the Cell and may seed a fresh dockerd before Gateway readiness.

An image archive is inert input and must not contain a live socket, process, mutable container record, Gateway database, or epoch authentication state.

## Legacy Fixed Compromise

The first implementation has a scheduler concurrency ceiling of one for the OpenShell target.

The first implementation is pinned to the verified A1 Linux arm64 host, official OpenShell `0.0.80`, Docker `29.6.1`, and the exact supervisor artifact baked into that Gateway release. Other architectures fail closed until their official loaded-image identity and whole-Cell lifecycle are separately verified.

The A1 detached-launch proof applies only while the owning Cell, sandbox, shim process, and required control routes survive. It does not claim survival across Cell recycle, sandbox destruction, local host reboot, tunnel loss beyond the fixed deadline, or an unverified deployment topology.

Starting a second Cell while another owner is active is an error; the helper must not kill or replace a Cell owned by another backend session.

Every completed or failed session pays the cost of starting a replacement containerd, dockerd, loading cached image archives, generating fresh Gateway authentication material, and starting the stock Gateway before capacity is released.

Warm reuse and concurrent Cells remain deferred until measured demand justifies a separately reviewed design with independent ports, address pools, capacity records, and teardown proofs.

## Legacy Lifecycle

### Plan Before Effect

NanoCore persists the deterministic backend identity and staging reference before asking the helper to prepare a Cell.

The deterministic backend session id is the Cell owner id because it is already durable, bounded, shell-safe, validated against deployment lineage, and available to restart cleanup.

The durable backend target also records a stable non-secret digest of the exact local controller or configured SSH target. Restart cleanup succeeds only when that digest, placement, Gateway name, Gateway origin, deployment lineage, and deterministic session identity still match the currently configured Cell controller; a configuration change cannot redirect cleanup to another host.

### Prepare

The helper acquires one host-wide file lock and rejects prepare when an active owner marker exists.

It verifies that the official `openshell` and `openshell-gateway` binaries both report exactly `0.0.80` and that required host commands are present.

When a verified idle replacement exists, prepare atomically claims that epoch for the backend session, clears its previous recycled-owner marker, and rechecks readiness and emptiness before returning.

When no replacement exists, prepare allocates a monotonically increasing epoch, writes the owner marker before starting effects, creates fresh private state and run roots, generates the stock Gateway JWT bundle, starts containerd and dockerd inside one dedicated systemd slice, loads every configured image-cache tar into the fresh dockerd, starts the stock Gateway, enables the stock `providers_v2_enabled` setting, and waits for readiness.

Prepare succeeds only after the exact epoch Gateway service reports active, the Gateway reports ready, `providers_v2_enabled` reads back as `true`, Docker reports zero containers, and stock `openshell sandbox list` reports no sandboxes against the fresh endpoint.

Any fresh-epoch prepare failure kills the partial Cell while retaining its owner marker for deterministic same-owner recycle, and returns the original error. NanoCore must not invoke OpenShell materialization after that failure and must attempt recycle because lifecycle ownership is recorded before prepare begins.

### Materialize And Run

After prepare succeeds, NanoCore uses the existing OpenShell CLI adapter, policy compiler, provider mapping, workspace materialization, worker-control registration, launch, evidence collection, and transcript import path.

Because stock OpenShell `0.0.80` has no detached exec option, the backend compiles one fixed `/bin/sh -c` launcher that runs inside the governed worker image. The script uses `setsid`, redirects stdin, stdout, and stderr to `/dev/null` for the first slice, passes the complete worker command only through positional `"$@"` argv, starts the worker shim in the background, and returns launch acknowledgement without interpolating request-controlled text. The worker shim's normal transcript files remain the durable output contract.

The attached `openshell sandbox exec` process is launch transport only. Its exit, timeout, connection loss, or forced termination does not establish worker completion. After launch acknowledgement and the first accepted worker heartbeat, the live executor observes the durable worker-control `final_status` and existing checkpoint/lease deadlines; it does not wait on the attached CLI process as the turn's lifetime owner.

The shim sends `final_status` only after it has sealed runtime provenance and completed workspace-change publication. That accepted status is therefore the last durable-output barrier that permits collection and exact Cell cleanup; it is not merely a process-exit notification.

Backend-native ids remain private evidence and do not become Cell or product authority.

### Recycle

NanoCore first revokes process-local worker-control access and removes the materialized-session handle.

The helper acquires the same host-wide lock, verifies that the active marker owner exactly matches the durable backend session id, records the marker's kernel boot identity, stops the Gateway, removes the epoch containers and deterministic Docker network while the same-boot Docker control plane is still provable, kills the whole systemd slice, waits until every owned service is inactive and every owned cgroup process is gone, and proves the old Docker bridge remains absent.

After the effect fence and bridge proof, the helper atomically changes the durable cleanup marker from `live` to `fenced` and records the bridge identity before deleting the epoch state and run roots. If bounded root removal fails, a same-owner retry re-proves the stopped slice, empty cgroups, and absent bridge from the `fenced` marker and retries only root deletion. A same-boot missing or unresponsive Docker socket before that fence fails closed and retains the marker and roots; a later boot may skip the unavailable previous-boot Docker control plane because its processes and transient network devices cannot survive the boot boundary.

The helper then starts a replacement epoch from fresh roots and returns only after stock OpenShell and Docker both report the replacement Cell ready and empty in two checks separated by the fixed stability interval.

The replacement Cell remains unowned and may be atomically claimed by the next prepare call without reusing any previous session state.

The idle marker also retains the last successfully recycled owner. If NanoCore crashes after helper success but before durable cleanup completion, a same-owner recycle retry re-proves readiness and both stable-empty checks without replacing the already fresh epoch. Every different owner still fails before any signal or deletion.

Recycle with a different active owner fails closed and does not signal any process.

NanoCore removes its private staging directory after attempting Cell destruction and reports an aggregate cleanup failure when any required cleanup remains incomplete.

### Create Failure

Once prepare has succeeded, every later failure during preflight, provider setup, file preparation, sandbox creation, or backend registration must attempt whole-Cell recycle before the materialization promise settles.

NanoCore does not use per-resource sandbox or provider deletion as cleanup or fallback; the only successful teardown boundary is Cell destruction.

If the Cell cannot be recycled, the durable backend session remains cleanup-owned, scheduler capacity remains unavailable, and recovery must retry recycle from the persisted identity.

### Containment Loss

Confirmed containment escape and inability to exclude escape invalidate the entire active Cell. NanoCore must deny its new admissions, external effects, and egress; revoke worker-control and materialized-session handles; interrupt the affected Turn and AgentSession; reject publication of output not already accepted behind the final-status barrier; retain only redacted evidence; and call the existing same-owner whole-Cell recycle path. Potentially exposed Vault material is routed to its existing revocation or rotation owner. Per-process or per-sandbox deletion is never sufficient, and the old Cell is never reused.

After successful recycle, the fresh empty replacement epoch may serve only a fresh authorized request; it is not continuation or replay of the affected Turn. Cleanup failure retains the existing Cell owner, backend identity, and scheduler capacity exactly as other recycle failures do. This contract adds no containment incident state or workflow and does not claim automatic escape detection.

At deprecation time, the legacy implementation supplied handle revocation, Turn and AgentSession interruption paths, redacted evidence owners, and whole-Cell recycle, but it had no trusted containment-loss detector or one entry point that composed this complete response. That historical gap remains evidence only; the current containment owner is `docs/specs/20260802-nanohost_runtime_and_transport.md`.

### Restart Recovery

The active owner marker and epoch counter live outside the NanoCore process and survive NanoCore restart. The marker contains the epoch, active owner, last recycled owner, boot identity, cleanup phase, and cleanup bridge, which makes interrupted teardown retryable without treating missing mutable state as successful cleanup.

Restart recovery classifies the exact durable lease and backend session before any physical effect. An eligible previously post-launch heartbeat-live session has the sequence-zero process-key hash plus `lastWorkerSequence >= 1` and enters the bounded scheduler `awaiting-reconnect` path without Cell prepare, replacement sandbox creation, shim launch, worker-control registration, or recycle. A sequence-zero-only supervisor uses exact existing cleanup. An already-releasing session with durable accepted `final_status` proceeds directly through the existing collection, reconciliation, cleanup, lease, and capacity owners without another heartbeat.

For an eligible awaiting-reconnect or releasing session, the OpenShell backend reconstructs one exact read-only session handle from the immutable AEP snapshot, durable backend-session identity, deterministic sandbox name, deployment and package lineage, AgentSession and lease, exact Cell target, placement, Gateway name and endpoint, trusted data-root-relative staging reference, deterministic session paths, and only provider identifiers already present in durable records. Restoration fails closed before external effect when any identity, lineage, target, path, backend version, or workspace-handoff check disagrees.

The restored handle permits exact sandbox inspection, transcript and artifact download, provider and backend evidence reads, workspace-change collection, and exact cleanup after the existing terminal owners reach their cleanup fence. It is not launch-capable and must never call Cell `prepare`, create a sandbox, upload launch inputs, mutate provider setup, launch a process, register a worker-control token, or fabricate missing launch-only values merely to satisfy the old process-memory session shape.

Exact process-key, lineage, and next-sequence adoption keeps the original Cell, sandbox, backend session, worker shim, lease, checkpoint, and workspace handoff. Verification failure, deadline expiry, or an unrecoverable identity mismatch revokes control and calls the existing idempotent recycle path with the persisted backend session id; recovery never prepares or launches a replacement for that turn. Ordinary cancellation remains owned by the existing live-turn control path rather than restart recovery.

Restart closeout calls the existing lease, checkpoint, backend session, worker-control terminal record, AgentSession, workspace reconciliation, evidence, and cleanup owners directly. It adds no settlement coordinator, parallel domain workflow, or table.

Awaiting-reconnect and adopted running Cells are not recycled. Reconnect timeout first fences the lease as `needs-evidence`, then invokes exact recycle. Cleanup failure retains the exact owner marker and backend identity, holds scheduler capacity, and waits for the next boot's same-owner recycle retry; no failure path guesses a target or releases capacity to restore availability.

This contract does not guarantee that a worker survives every restart topology. A co-located host reboot normally kills the Cell, and a remote worker can reconnect only when its Cell, shim, Gateway access, and worker-control route actually survive and recover before the fixed deadline. Both outcomes use the same process-key/lineage/sequence classification rather than topology-specific compatibility behavior.

## Legacy Cell Control

The privileged helper has one fixed installed path and accepts only `prepare <owner-id>` and `recycle <owner-id>`.

For local placement, NanoCore executes `/usr/bin/sudo -n /usr/local/libexec/openkit-openshell-cell <action> <owner-id>` without a shell on the same Linux/systemd host.

For remote placement, NanoCore executes `/usr/bin/ssh -T -o BatchMode=yes -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no -o PermitLocalCommand=no -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 <ssh-target> /usr/bin/sudo -n /usr/local/libexec/openkit-openshell-cell <action> <owner-id>` without a local shell.

The remote SSH target is explicit deployment configuration, is validated before use, and identifies the same host that owns the configured disposable Cell Gateway and its sandboxes.

SSH controls only the Cell lifecycle. It does not provide worker execution, arbitrary remote commands, Gateway forwarding, or worker-control forwarding.

The helper validates the owner id before using it and derives every unit, path, socket, and state location from fixed OpenKit-owned roots plus its own numeric epoch.

NanoCore never accepts a request-supplied command, helper path, unit name, root directory, port, or shell fragment.

## Legacy Gateway And Image Contract

The Cell Gateway binds only to loopback on the Cell host and uses the stock native Gateway JWT configuration generated for that epoch.

Local placement always uses the fixed Gateway origin `http://127.0.0.1:17670`.

Remote placement requires an explicit loopback HTTP Gateway origin as seen by NanoCore. An operator-managed authenticated SSH local-forward exposes the Cell host's fixed loopback Gateway at that origin; the lifecycle controller does not create or own the tunnel.

Remote placement also requires an explicit credential-free HTTP(S) worker-control URL ending at `/api/worker-control` that the remote sandbox can reach directly. The Gateway local-forward and worker-control URL are independent directions.

The configured SSH target, Gateway origin, and worker-control URL form one placement contract. NanoCore must fail before materialization when any required remote value is absent or invalid.

The image cache directory contains operator-built or verified Docker image tar archives.

The OpenKit worker image should be built natively on the runtime host and saved into that cache so a fresh Cell does not depend on slow cross-host image transfer.

The A1 cache contains the host-built arm64 worker image and `ghcr.io/nvidia/openshell/supervisor:709aa0fe3e9e4d2b5fea336b5d6e393b45481898`, the exact tag baked into the official Gateway `0.0.80` binary. The helper verifies the Docker `29.6.1` fresh-load image id `sha256:d87e54175490a7dc5e75daef1c4aaf43955cf3fc3945827e4f03698ea99faadb` before Gateway startup.

## Legacy Capacity And Release Contract

The first OpenShell scheduler pool and target capacity are both one.

Capacity acquisition occurs before Cell prepare through the existing durable scheduler flow.

Capacity release occurs only after backend cleanup returns success, which now requires successful whole-Cell recycle, replacement readiness, two stable-empty checks, and private staging cleanup.

A sandbox delete response, empty sandbox list, empty Docker snapshot, elapsed grace window, Gateway disconnect, or NanoCore process exit is not independently sufficient to release capacity.

## Legacy Security And Failure Rules

- External OpenShell binaries, source, images, and protocols must not be patched or forked.
- Restart reconnect relies on the trusted TLS or operator-managed SSH transport already protecting the bearer token. OpenKit adds no application-layer challenge; a transport observer who obtains both bearer token and process key could race the worker.
- Detached launch must use the fixed NanoCore-owned launcher argv, `setsid`, fully redirected standard streams, and positional worker arguments; NanoCore must not interpolate request-controlled shell text or treat attached CLI lifetime as worker lifetime.
- Read-only handle restoration must validate exact durable identity before external access and must expose no prepare, create, upload, launch, provider-mutation, or worker-control-registration capability.
- The helper must use exact fixed paths and must not evaluate caller-controlled shell text.
- The helper must serialize prepare and recycle through one host lock.
- The helper must write ownership before starting effect-capable processes.
- Ownership mismatch must fail before any signal or deletion.
- The Gateway must bind to loopback on the Cell host; remote NanoCore access must use an explicit loopback HTTP origin backed by an operator-managed SSH local-forward.
- Remote lifecycle control must use the fixed non-interactive SSH command and must not accept request-supplied commands, forwarding options, helper paths, or shell text.
- Durable cleanup must remain bound to the persisted Cell-target digest and exact configured placement; a changed SSH target or Gateway target fails closed before any remote recycle.
- Remote sandboxes must receive an explicit sandbox-reachable worker-control URL rather than a host-local default.
- Secrets, JWT private keys, Docker sockets, host paths, process ids, and unit names remain backend-private.
- Partial prepare and recycle failures must preserve enough owner evidence for deterministic operator recovery.
- NanoCore must not decrement scheduler capacity after incomplete Cell destruction.
- Confirmed or unexcluded containment escape must use the complete containment-loss boundary above; no partial cleanup or old-Cell reuse may be treated as success.
- No tested process-survival result may be generalized to a topology whose Cell, sandbox, route, or host-survival properties were not verified.

## Historical A1 Stock Runtime Evidence

The design was falsified against unmodified OpenShell CLI and Gateway `0.0.80` on A1 before acceptance.

Stock `openshell sandbox exec` exposed no detach option. A focused A1 proof used the attached CLI only to start a sandbox-owned `setsid` process with stdin, stdout, and stderr redirected away from the CLI transport, then forcibly terminated the attached CLI through its timeout. The detached process continued writing its heartbeat, and a fresh stock exec observed the same surviving process and advancing heartbeat. This proves the narrow detached-launch mechanism on the tested A1 Cell; it is not a universal OpenShell, host-reboot, tunnel, or deployment-topology guarantee.

The test Cell owned a dedicated systemd slice, containerd, dockerd, Gateway, state roots, JWT bundle, and a fault-injection proxy that held the first Docker `POST /containers/create` before forwarding.

Killing the whole slice before the proxy released the request removed the Gateway, proxy, dockerd, and containerd processes, caused the stock CLI to fail with a broken transport, and left no process capable of forwarding the held create.

A new epoch started from fresh roots and returned stock Gateway `0.0.80`, zero Docker containers, and no OpenShell sandboxes in two checks ten seconds apart, while every old PID and path remained absent.

This proves the complete epoch boundary for the observed failure class on that host; it does not prove that resource-level deletion or a shared remote Gateway is safe.

The implemented helper was then exercised on A1 with a normal owner lifecycle, an intentionally missing-image prepare failure, same-owner cleanup recovery, idempotent recycle retry, wrong-owner recycle, and second-owner prepare. The failed prepare left no epoch state root, run root, active slice, or owned process while retaining the owner marker; same-owner recycle produced healthy empty epoch `7`, retry preserved `7 -> 7`, and both wrong-owner operations failed without changing the epoch.

Later A1 acceptance verified reboot recovery, Providers v2 activation, explicit Docker network removal before runtime shutdown, and repeated prepare/recycle cycles with only one fresh replacement bridge and no OpenShell sandboxes remaining.

The final implementation acceptance rebuilt `openkit/worker-codex:dev` natively on A1, passed the isolated image smoke with Node `24.18.0` and Codex `0.144.1`, installed the six-field retry-safe helper, and exercised epochs `14` through `20`. Normal prepare/recycle removed the old roots and produced an empty replacement. Stopping the same-boot Cell dockerd made recycle fail closed while retaining the `live` owner and roots; after reboot, the same owner removed the previous-boot epoch and restored a healthy empty Cell. An immutable-file fault forced root deletion to fail after the effect fence; the marker retained `fenced` plus the old bridge identity, and the same-owner retry re-proved the stopped slice, empty cgroups, and absent bridge before deleting the roots without a Docker socket. Wrong-owner recycle failed, and same-owner idempotent recycle preserved epoch `20 -> 20`.

The opt-in remote backend E2E used the checksum-verified official macOS OpenShell `0.0.80` CLI, a separate operator-managed SSH Gateway tunnel, and the fixed SSH lifecycle controller to materialize a sandbox under the A1 Cell, execute a command inside it, download the command's result file, and recycle the whole Cell into an empty replacement. A separate A1-local E2E uploaded a minimal AEP fixture and executed the real OpenKit worker shim inside the Cell. These runs complete this lifecycle specification. The separate real Codex `0.144.1` root-plus-two-child worker-runtime provenance acceptance later passed independently on A1 against stock OpenShell `0.0.80`; it validates provenance without extending this lifecycle specification's ownership.

## Historical Alternatives

### Patch Or Fork OpenShell

Rejected because external dependencies must remain official and replaceable, and OpenKit must not own an upstream protocol or release fork.

### Shared Gateway With Host Lock

Rejected because a host lock coordinates only participating OpenKit processes and cannot invalidate an already accepted Gateway request, another client, or a child that outlives the lock.

### Delete Plus Stable-Empty Window

Rejected as the release boundary because a point-in-time empty result and finite delay cannot prove that an older accepted create has no remaining path to the container runtime.

### Best-Effort Resource Cleanup Fallback

Rejected as success semantics; it may contribute diagnostics, but the scheduler lease must remain cleanup-owned until the whole Cell is recycled into a verified fresh empty epoch.

### Naked Shared Remote Gateway

Rejected because a Gateway endpoint without the matching fixed lifecycle target does not give NanoCore authority to destroy the complete remote runtime epoch before releasing capacity.

### General Remote Control Service

Rejected for the current contract because the fixed SSH invocation already supplies the two required lifecycle actions without adding another daemon, protocol, or credential surface.

## Current Legacy Implementation Projection

The whole-Cell prepare, recycle, remote fixed-controller, cleanup-fence, detached shim launch, and active read-only restart-restoration slice are implemented. The backend can reconstruct the exact existing session as read-only, collect through it, and recycle the same Cell without calling prepare, create, upload, provider mutation, launch, or worker-control registration.

- `apps/nanocore/src/runtime/openshell-cell.ts` owns the fixed local sudo and remote SSH command adapters.
- `apps/nanocore/scripts/openshell-cell.sh` owns the privileged Linux Cell lifecycle.
- `apps/nanocore/src/runtime/worker-governance-backend.ts` prepares a Cell before OpenShell preflight and recycles it on create failure and durable cleanup.
- `apps/nanocore/src/runtime/turn-executor-factory.ts` constructs the selected local or remote Cell controller and requires the remote SSH target, Gateway origin, and sandbox-reachable worker-control URL together.
- Remote configuration uses `OPENKIT_OPENSHELL_CELL_SSH_TARGET`, `OPENKIT_OPENSHELL_GATEWAY_URL`, and `OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL`; the OpenShell CLI remains the official platform-installed `0.0.80` binary and never uses the TLS-verification bypass flag. The stock Cell Gateway's unauthenticated HTTP listener remains bound to host loopback and is exported only through the separately authenticated SSH local-forward.
- `apps/nanocore/src/scheduler-records.ts` initializes the first OpenShell pool and target with one slot.

## Legacy Verification

- L1 controller tests verify exact local sudo and remote SSH argv construction, owner and target validation, bounded errors, and no shell evaluation.
- L1 backend tests verify prepare-before-preflight ordering, whole-Cell cleanup after every post-prepare failure, owner-bound restart cleanup, access revocation, retry, and absence of resource-delete success claims.
- L1 detached-launch tests verify the fixed NanoCore-owned launcher argv, `setsid`, stdin/stdout/stderr redirection, positional preservation of worker argv, absence of request-controlled shell interpolation, launch acknowledgement independent of attached CLI lifetime, runtime provenance and workspace publication before final status, and executor completion only from that last durable-output barrier or an existing authority deadline.
- L1 restoration tests verify exact durable handle reconstruction, trusted staging-path resolution, same-target and lineage checks, transcript/artifact/workspace-change download, evidence reads, and cleanup while asserting that `prepare`, sandbox creation, upload, provider mutation, launch, and worker-control registration are never called.
- L1 restart tests verify awaiting-reconnect and adoption preserve the same Cell and backend session, accepted final status uses the restored handle, timeout selects exact recycle through the lease CAS fence, cleanup failure holds capacity, and no settlement record exists.
- L1 factory tests verify both placements, required remote configuration, loopback HTTP Gateway origins, and explicit credential-free HTTP(S) worker-control reachability.
- L1 scheduler tests verify a one-slot pool and target.
- Static checks run `bash -n` over the privileged helper.
- The L5 opt-in A1 detached-launch test uses unmodified OpenShell `0.0.80`, forcibly terminates the attached CLI after the fixed launcher starts the shim, proves the same sandbox-owned process and heartbeat survive through a fresh exec, and verifies all standard streams remain detached from the dead CLI.
- The L5 opt-in A1 restart gate runs NanoCore on the local controller and the bounded worker in the remote A1 Cell through the declared operator-managed Gateway forward and sandbox-reachable worker-control route. It restarts only local NanoCore after the remote worker heartbeat, proves exact same-lease adoption without prepare, create, launch, or register, downloads transcript and evidence through the restored read-only handle, accepts durable final status, and recycles the exact remote Cell into a ready empty replacement. An A1-local NanoCore run may remain a diagnostic, but it cannot replace this remote-Gateway acceptance gate.
- The L5 opt-in remote backend test controls A1 through the fixed SSH lifecycle command, reaches its loopback Gateway through an operator-managed tunnel, materializes one sandbox, executes a bounded command, downloads its result, and proves whole-Cell cleanup leaves a fresh empty replacement; this validates only the declared A1 topology.
- The late-create A1 falsifier holds a Docker create before forwarding, destroys the Cell, starts a fresh Cell, and proves the old request cannot materialize.

## Historical Deferred Work

- Multiple independent Cells with distinct ports, address pools, capacity records, and owner markers.
- Warm image-layer seeding that remains inert and cannot preserve mutable runtime state.
- Multiple independently configured remote Cell targets and target selection.
- Upstream OpenShell causal operation support that could permit a smaller safe teardown boundary in a future pinned release.
