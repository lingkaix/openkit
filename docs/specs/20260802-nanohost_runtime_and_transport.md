---
status: Accepted
implementation: Partial
date: 2026-08-02
updated: 2026-09-01
---
# NanoHost Runtime And Transport

## Owns

- The implementation-facing definition, lifecycle, failure boundary, recovery, and readiness contract for one configured NanoHost and its private Runtime Epoch.
- The binding between one configured NanoHost identity, one NanoHost service, one stock OpenShell Gateway, one configured container backend, and the sandboxes hosted by the current epoch.
- The accepted shared-Sandbox topology: one Sandbox, multiple compatibility-keyed Harnesses, multiple open AgentSessions for distinct Threads, bounded concurrent active Turns across distinct AgentSessions, and independent AgentSession binding and Turn execution-lease projections.
- `SandboxCompatibilityKey`, `HarnessCompatibilityKey`, and `AgentSessionCompatibilityKey` as the three exact placement and reuse decisions.
- The container-backend selection boundary, the classification of a backend effect domain as host-local or external, and the rule that only a host-local effect domain may be configured while whole-epoch cgroup termination is the fence.
- The epoch-external NanoHost Image Store, its digest-addressed inert content contract, and the NanoHost-local image-acquisition boundary for registry retrieval and authorized build from a NanoCore-supplied build definition.
- The one-session NanoCore-to-NanoHost transport projection and its authentication, predecessor fencing, route carriage, reconnect, and failure rules.
- The per-Turn AEP-before-Context-before-`turn.start` import order through the existing fixed file-data mechanism, with AgentSession-private destinations and no Sandbox-wide authorization package.
- The fixed unary `ExecSandbox` Sandbox-Integration entry marker, retained Integration-lifetime response-monitor contract, marker-before-bridge ordering, and value-free fail-stop evidence boundary.
- The NanoHost-Service-to-Gateway loopback management boundary and the stock `ForwardTcp`/`RelayOpen`/`ConnectSupervisor`/`RelayStream` bridge used to carry one sandbox HTTP/2 session.
- The one-RelayStream sandbox-to-Gateway transport projection, its nested standard HTTP/2 session, and the Sandbox Integration boundary.
- The exact connection- and Harness-bound projection for private `/worker-control/harness/poll` and `/worker-control/harness/result` carriage, including pre-AgentSession admission and the rule that it is neither a NanoHost effect nor a per-Turn worker command.
- The transport envelope for the nested sandbox session and the NanoHost-to-NanoCore session: per-route-family stream reservation, flow-control accounting, the worker-control liveness bound, and the bridge re-establishment bound.
- The NanoHost service implementation boundary: one Rust application at `apps/nanohost`, one compiled OpenShell client surface, one separately running stock Gateway process, and the minimum internal runtime roles required to project those transports.
- The NanoHost-local OpenShell lifecycle authority, OS-supervised fail-stop group, uncertain-operation invalidation, fresh-empty recovery, and capacity-readiness proof.
- The Epoch Invalidation Report: the bounded redacted forensic record exported before fail-stop termination, and its explicit incapacity to resume, adopt, or settle any operation.
- The epoch rebuild cost budget and the falsifiable premise that makes the shared-epoch decision reviewable rather than assumed.
- The NanoHost transport credential class, issuance and enrollment ceremony, secret delivery and storage boundary, rotation, revocation, audit, decommission, and transport-trust contract.
- The separation between NanoHost credentials, worker-control tokens, inference tokens, capability tokens, and OpenShell-local credentials.
- The bounded migration from the legacy NanoCore-owned per-session Cell implementation to the NanoHost-owned Runtime Epoch target.
- The location and required content of the OpenShell pin manifest, which lives with the NanoHost rather than in a vendored snapshot package.

## Does Not Own

- Product-visible Workspace, Thread, Turn, Item, AgentSession, Artifact, Review, approval, or terminal-status records.
- Scheduler admission, claim selection, SessionLease, capacity accounting, exact worker-control message schemas, inference semantics, capability semantics, route usage, route audit, PermissionDecision, or Vault material.
- Human access-token, server-admin token, AuthSession, worker-control token, inference token, capability token, Gateway credential, provider credential, and Vault credential lifecycles.
- Agent Environment Package content authority, native Git or object-store semantics, Workspace synchronization, Artifact review, or large-data transfer semantics.
- Worker image content, the repository-owned worker Dockerfile, published image identity, image capability baselines, or which image an authored AgentManifest may select.
- A container backend other than the one configured host-local backend, a backend abstraction layer, a driver framework, or the fencing contract for an external non-host-local effect domain such as a remote Kubernetes cluster.
- A product-visible NanoHost, Runtime Epoch, Gateway, container, network, process, or backend-native record.
- Dynamic NanoHost discovery, fleet scheduling, multi-NanoHost placement, AgentSession migration between live Harnesses, active-active execution of one AgentSession, or high availability.
- An OpenShell fork, patch, replacement Gateway, private Supervisor, custom multiplexer, arbitrary proxy, arbitrary tunnel, or private OpenShell protocol.
- A Go or TypeScript NanoHost implementation, an in-process OpenShell Gateway server, normal lifecycle management through OpenShell CLI subprocesses, an OpenShell source fork or submodule, or a second NanoHost library package.
- Operator installation, diagnostics, or incident-response procedure beyond the execution-protocol exclusions stated here.

## Core References

- `docs/core/communication.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/sandbox.md`
- `docs/core/identity.md`
- `docs/core/vault.md`
- `docs/core/agent-capability.md`
- `docs/core/audit.md`

## Related Specifications

- `docs/specs/20260801-nanohost_workspace_data_boundary.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260704-remote_auth_credential_bootstrap.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260704-agent_session_continuity.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260708-container_image_packaging.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`

## Summary

`Execution Host` is the generic deployment role; `NanoHost` is OpenKit's sole concrete product and current implementation of that role. OpenKit replaces the target design of one NanoCore-controlled disposable OpenShell Cell per AgentSession with one configured NanoHost that owns one private Runtime Epoch at a time.

One Runtime Epoch contains the NanoHost service, one stock OpenShell Gateway, the effect-capable members of exactly one configured container backend, their private roots and authentication state, and zero or more sandboxes. The epoch contains only the configured backend; it never instantiates every backend that stock OpenShell can drive. The target pins the official unmodified OpenShell `0.0.99` release exactly; "latest" is not a version range or runtime resolution rule, and a newer published upstream release does not change the pin until the realization gate is re-run. One compatible Sandbox may contain multiple declared Harnesses for different runtime families or different static configurations, each may retain multiple open AgentSessions, and bounded active Turns may run concurrently only across distinct AgentSessions and Threads under the scheduling owner.

Verified image content lives in the epoch-external NanoHost Image Store and is imported into a fresh epoch by digest. Registry retrieval and authorized build write into that store, never into the readiness path, so epoch rebuild cost does not include network retrieval or image construction.

The NanoHost is the sole OpenShell lifecycle authority. NanoCore selects and authorizes work through existing owners, but it does not prepare, create, delete, inspect, or recycle OpenShell resources and does not know a Cell, Cell owner, Cell epoch, Cell helper, remote Gateway endpoint, Docker endpoint, or SSH lifecycle target.

The NanoHost service is one Rust binary crate owned by `apps/nanohost/` with repository package name `@openkit/nanohost`. It compiles only an exact-`v0.0.99` OpenShell client surface into the NanoHost and communicates with the official stock Gateway through one loopback gRPC/HTTP/2 channel. The stock Gateway remains a separately identifiable foreground process inside the Runtime Epoch; OpenKit does not compile the Gateway server into the NanoHost and does not shell out to the OpenShell CLI for ordinary lifecycle or forwarding operations.

The NanoHost service, Gateway, configured container backend, and all hosted sandboxes form one OS-supervised fail-stop group. An uncertain accepted create or delete, an abnormal exit or identity change of an effect-capable member, or an independent member restart invalidates the complete epoch. Recovery terminates or fences the prior effect domain, creates fresh runtime state, proves the new runtime empty, and only then advertises readiness.

NanoCore and the NanoHost use exactly one authoritative NanoHost-initiated authenticated transport session at steady state. Every declared worker-control, inference, capability, and fixed NanoHost-effect route between those participants reuses that physical session while retaining its own credential, authority, bounds, retry, failure, usage, and audit semantics. Native large-data systems remain outside its semantic routes; the exact V1 single-file effects and sole fixed `image.build/input` Dockerfile response use one distinct fixed file-data stream on the same physical connection.

Each active sandbox uses exactly one current stock OpenShell bridge: one NanoHost-side `ForwardTcp` stream paired by the Gateway with one Supervisor-side `RelayStream`. The paired byte stream carries one standard HTTP/2 session between Sandbox Integration and the NanoHost service for `/worker-control/*`, `/inference/*`, and `/capabilities/*`. OpenKit defines no frame multiplexer over that stock bridge.

The durable requirement is one authenticated bidirectional byte stream per active sandbox carrying one standard HTTP/2 session with Integration as client, stated under Sandbox Transport Requirement. The stock `ForwardTcp`/`RelayOpen`/`ConnectSupervisor`/`RelayStream` bridge is its pinned realization, enumerated in the Stock Realization Annex, and is an accepted mandatory design rather than an observed pinned-stock capability. Its feasibility, reconnect behavior, flow control, intermediate buffering, and required stock OpenShell behavior remain unproved until the realization gate runs. Implementation MUST stop and return to that annex if the gate fails; it MUST NOT substitute an OpenKit protocol, OpenShell fork, arbitrary tunnel, direct Gateway exposure, or weaker transport.

## Decision

Use exact stock OpenShell `0.0.99`, one configured NanoHost identity, and one NanoHost-owned Runtime Epoch as the only target lifecycle boundary for OpenShell execution. The NanoHost is the sole OpenShell lifecycle authority, shares one stock Gateway and dedicated container runtime across ordinary AgentSession lifecycles, closes only the ended AgentSession inside a compatible shared Sandbox after proved local cleanup, and invalidates the complete epoch whenever an accepted runtime effect or effect-capable member cannot be proved safe.

Use one authoritative NanoHost-initiated authenticated NanoCore transport session for every declared control, inference, capability, and fixed NanoHost-effect route, with predecessor fencing before replacement. Reserve one distinct fixed file-data stream on that same physical connection for the exact V1 single-file effects. Use one stock `ForwardTcp`/`RelayStream` pair containing one standard HTTP/2 session per active sandbox for `/worker-control/*`, `/inference/*`, and `/capabilities/*`, without an OpenKit multiplexer and without merging route credentials or semantics. Carry the six fixed Harness operations only through Integration-initiated private `/worker-control/harness/poll` and `/worker-control/harness/result` requests bound to that existing nested connection and one NanoHost-injected non-secret Harness binding; add no ninth effect, fourth namespace, reverse request direction, second connection, or `bridge.open` credential.

Implement the NanoHost service as one Rust application under `apps/nanohost`. Prefer the exact-tag upstream Rust client SDK when immutable `v0.0.99` evidence proves its required lifecycle and raw forwarding surface; otherwise generate the minimum Tonic client from the exact refreshed `v0.0.99` protobuf snapshot. In both cases, link only client code, run the checksum-verified stock Gateway as a separate foreground process in the OS-supervised failure group, and use its gRPC API directly rather than the CLI for normal operation.

Keep the current implementation inside the small-deployment profile owned by `docs/specs/20260703-runtime_scheduling_scale.md`, and add to it only the backend count this specification owns: exactly one configured host-local container backend. Obtain a smaller future blast radius through multiple independent NanoHosts under a separate accepted scale design, not by restoring per-AgentSession Cells or Runtime Epochs.

This specification owns the shared-Sandbox Harness behavior that it previously deferred. Existing transport carriage alone did not authorize multiplicity; this amendment supplies the topology, compatibility, lifecycle, failure, authority, and acceptance contract for multiple Harnesses and bounded concurrent AgentSessions. That ownership change creates no public runtime identity, new product session, second transport, independent capacity grantor, or scheduler authority beyond the contracts stated here and in the scheduling owner.

## Goals / Non-goals

### Goals

- Make the same one-NanoHost topology work when NanoCore is co-located, containerized, or on another host.
- Reduce NanoCore-to-execution networking to one NanoHost-initiated authenticated session and keep each active sandbox on one stock `ForwardTcp`/`RelayStream` pair managed entirely inside the Runtime Epoch.
- Preserve exact worker lineage and sequence across NanoCore restart without recreating the sandbox or runtime.
- Keep local OpenShell operations independent of NanoCore connection lifetime.
- Retain the legacy Cell design's late-create fence, fresh-empty proof, fail-stop behavior, detached-launch evidence requirement, and stock OpenShell boundary at the NanoHost lifecycle level.
- Make uncertain local runtime state invalidate the complete Runtime Epoch instead of guessing resource-local success.
- Reuse stock OpenShell and standard HTTP/2 without a fork, patch, private Supervisor, or OpenKit multiplexer.
- Keep one small execution-host binary with a reproducibly pinned Rust toolchain and exact OpenShell client boundary instead of duplicating lifecycle logic in NanoCore or scripts.
- Keep route credentials and semantics separately bound even though they share transport infrastructure, with enforceable mechanisms and measured bounds rather than a deprecated priority scheme. This supports conversation-context isolation and does not claim security and adjudication isolation from a compromised shared Harness.
- Support more than one container backend by configuration selection while instantiating and rebuilding only the one configured backend.
- Keep epoch rebuild cost bounded by local import from a durable epoch-external image store rather than by network retrieval or image construction.
- Host multiple runtime families or differently configured instances in one Sandbox through the existing Harness record, adapter registry, and fixed operation set.
- Preserve independent state roots, route credentials, interruption, output, and cleanup for concurrent Turns in distinct AgentSessions.
- Preserve a bounded redacted forensic record of every epoch invalidation without creating a durable operation journal.

### Non-goals

- Do not exceed the small-deployment profile stated by `docs/specs/20260703-runtime_scheduling_scale.md`, and do not implement more than one configured NanoHost, one configured container backend, or one OpenShell backend in the current release.
- Do not introduce per-session Runtime Epochs, Cells, Gateways, container runtimes, or cold runtime startup.
- Do not build dynamic placement, fleet management, automatic failover, live migration, warm pools, or multi-cloud scheduling.
- Do not carry Workspace trees, Artifact payloads, repository packs, model files, or other large data through control, readiness, worker-control, inference, or capability streams merely because the physical HTTP/2 connection exists; only the exact fixed single-file effect carriage below may carry file bytes on that connection.
- Do not merge route tokens, scopes, limits, retries, failure meanings, usage, audit, or protocol ownership.
- Do not make Sandbox Integration a capability gateway, Core participant, scheduler, workflow engine, durable owner, or authorization authority.
- Do not make OpenKit-managed, exposed, configured, or caller-selected SSH, an operator-managed or externally exposed Gateway forward, a direct worker endpoint, or a sandbox-direct NanoCore connection part of the execution protocol. The NanoHost-owned loopback `ForwardTcp` stream and the one pinned opaque internal SSH relay beneath the fixed single-file `ExecSandboxInteractive` use defined below are stock Gateway implementation closure, not selectable SSH transport or that rejected topology.
- Do not add a durable NanoHost operation journal, settlement coordinator, or recovery state machine for in-flight OpenShell operations.
- Do not add a second NanoHost implementation, multi-crate NanoHost workspace, plugin or driver framework, actor framework, NanoHost database, in-process Gateway server, or per-operation OpenShell CLI wrapper.
- Do not build a container-backend abstraction layer, driver interface, capability negotiation, or runtime backend switch; the NanoHost holds one concrete configured backend integration.
- Do not configure a backend whose effect domain this specification's fence cannot reach, and do not reinterpret whole-epoch invalidation as a fence for a remote orchestrator.
- Do not turn the NanoHost Image Store into a registry, a published artifact, a product record, canonical storage, or a network service.
- Do not let an authorized build become a host instruction, obtain broader network authority than its target sandbox, or produce a published or tagged repository image.
- Do not let the Epoch Invalidation Report become a durable operation journal, a recovery input, a product surface, or a scheduling input.

## Definitions And Exclusions

### Configured NanoHost Identity

The configured NanoHost identity is the single deployment-scoped integration identity that NanoCore accepts as the current execution target. It is not a user, server administrator, worker, AgentSession, OpenShell Gateway identity, sandbox identity, credential, lease, or product record.

The configured NanoHost identity is a deployment-scoped projection of the Core `IntegrationIdentity` family, and governed actions use its integration `ActorRef` when attribution is required. This specification introduces no new Core identity family.

Exactly one configured NanoHost identity exists in the current deployment profile. Reconfiguration replaces the accepted identity rather than adding a fleet member. A stale, unknown, revoked, or conflicting identity fails closed and cannot claim work, carry route traffic, report readiness, or supersede the current connection.

### NanoHost service

The NanoHost service is the trusted execution-host process that owns local OpenShell lifecycle effects, the Runtime Epoch, the NanoCore transport, package materialization, sandbox creation and deletion, Sandbox Integration attachment, evidence transfer, and cleanup reporting.

The NanoHost service applies only already-authorized work selected by NanoCore's existing scheduler and policy owners. It does not select product work, broaden permission, create product state, settle an uncertain external effect, apply Workspace changes, or infer Turn completion.

The V1 NanoHost service is one Rust binary crate at `apps/nanohost`. `apps/nanohost` is a deployable application rather than a shared `packages/` library, and Rust remains scoped to that application unless another accepted owner later establishes a repository-wide need. The NanoHost MUST NOT have a parallel Go or TypeScript service implementation.

### Runtime Epoch

A Runtime Epoch is the private lifecycle, readiness, and failure boundary for one generation of epoch-local execution infrastructure. It contains:

```text
Runtime Epoch
├── NanoHost service
├── stock OpenShell Gateway
├── configured container backend (V1: dedicated dockerd and its containerd)
└── zero or more sandboxes and AgentSession executions

outside every epoch, durable and inert
└── NanoHost Image Store (digest-addressed verified image content)
```

The epoch includes every mutable root, socket, network, cgroup, process, authentication material, and backend handle that could complete an accepted OpenShell effect. The NanoHost Image Store and the NanoHost Token sink remain outside the epoch under the exclusion rules defined below, and they MUST NOT contain mutable runtime state, live sockets, process identity, Gateway data, container records, or epoch authentication material.

Runtime Epoch identity is private execution evidence. It MUST NOT become a Core protocol record, App API field, scheduling identity, user-visible lifecycle, Workspace truth, or substitute for AgentSession identity.

### Sandbox Integration

Sandbox Integration is the sandbox-local runtime code that adapts a concrete worker Agent or harness to the local worker-control, inference, capability, policy, provider, and runtime bindings supplied through the NanoHost and stock OpenShell.

Sandbox Integration owns only the outer transport adaptation and sandbox-local injection of already-governed runtime context. It MUST NOT choose work, models, provider fallback, permissions, capabilities, tools, rate limits, usage ownership, audit ownership, terminal outcomes, or Workspace publication.

This specification permits one Sandbox Integration instance to supervise multiple compatibility-keyed Harnesses, each with multiple open Core AgentSessions for distinct Threads. Runtime-native agents, child threads, sub-agents, or Provider sessions beneath one governed AgentSession remain private runtime activity unless Core independently schedules another Thread and AgentSession; private multiplicity creates no Core identity, capacity grant, transport authority, or product status by itself.

Sandbox Integration is one long-lived supervisor, not one AgentSession or one native Agent instance. It establishes the private Harness-control pull path before any AgentSession opens, retains only bounded current-operation state, and may start a distinct native Agent process for each active AgentSession. No AgentSession, Turn, route token, native conversation handle, or native child exists merely because Integration and the Harness are ready.

### Shared-Sandbox Harness Topology

The shared-runtime target has this exact private topology:

```text
Runtime Epoch
└── SandboxRuntimeRecord
    ├── HarnessInstanceRecord A (one runtime and static configuration)
    │   ├── AgentSessionRuntimeBinding 1
    │   └── AgentSessionRuntimeBinding 2..N
    └── HarnessInstanceRecord B..N
        └── AgentSessionRuntimeBinding 1..N

Turn
└── ExecutionLease + AEP snapshot + Context Package + route lineage
```

The `SandboxRuntimeRecord` identifies the opaque NanoHost Sandbox binding, `SandboxCompatibilityKey`, static environment class, declared Harness set, `maxHarnesses`, aggregate capacity, lifecycle and health state, drain state, and cleanup evidence. The `HarnessInstanceRecord` identifies the owning Sandbox binding, exact `HarnessCompatibilityKey`, runtime and adapter family and version, protocol, bounded product-safe capabilities, `maxOpenSessions`, `maxActiveTurns`, occupancy, liveness, and drain state. The `AgentSessionRuntimeBinding` maps one exact current Core AgentSession to that Harness, its exact Thread, one restricted native conversation handle, one `AgentSessionCompatibilityKey`, and current lifecycle proof. The scheduler execution lease remains the unique active-Turn capacity grant; Harness and Sandbox counts are occupancy projections only.

One Harness may supervise one independent native Agent process per active AgentSession, and later Turns may start new process instances that resume their exact restricted conversation handles. Process identity is neither stored in Core nor part of a compatibility key. An adapter that creates its native conversation only with the first prompt may hold one open binding with `nativeHandleState=pending`; its first successful Turn must establish the handle digest before that binding returns to reusable idle. Sibling AgentSessions belong to distinct Threads and always have distinct state roots, handles, children, Turn slots, route credentials, and cleanup proofs even when they select the same Agent, runtime, model, or provider. A historical predecessor for one Thread has no resident binding after its successor becomes current.

These are private runtime projections, not product records or new durable workflow owners. Backend-native Sandbox and conversation identifiers remain restricted and MUST NOT become App API identities, authorization inputs, Workspace truth, or ordinary diagnostics. Idle AgentSessions consume open-session capacity but hold no execution lease or effect authority.

A Sandbox may retain more than one Harness Instance while its declared Harness set and `maxHarnesses` bound admit them. A Harness may execute more than one active Turn only when its fixed `maxActiveTurns` is greater than one and its adapter proves independent multiplexing, routing, interruption, context, output, credential binding, and cleanup. Each AgentSession and Thread still has at most one active Turn. A Harness does not choose work, grant capacity, extend deadlines, select logical models, broaden authority, apply Workspace changes, or infer terminal state.

Shared-Sandbox co-residency makes exactly two bounded isolation claims. It provides **conversation-context isolation** only when the adapter proves that native context, prompt and tool state, sequence, interruption, transcript, and route targeting remain AgentSession-specific. It provides **Workspace-write isolation** through separately addressable AgentSession mutable slots and conflict-checked apply. It does not provide **security and adjudication isolation** by default: the Sandbox and Harness are one compromise domain, logical namespacing is not a security boundary, and stronger OS isolation or separate Sandboxes are required when one execution must be unable to inspect or influence another.

The co-residency envelope is one Workspace and one responsible-user trust class. Different Harnesses or AgentSessions may receive different per-Turn configuration and credentials inside that Sandbox, but logical separation is not stronger isolation. Independent adjudication, adversarial work, incompatible user trust, incompatible credential visibility, authorization-sensitive work, and strict-risk work select a separate Sandbox whenever shared process memory, writable state, credentials, context, or model state could undermine the required isolation.

### Compatibility Decisions

`SandboxCompatibilityKey` answers whether AgentSessions may occupy the same Sandbox. It includes Workspace, responsible-user trust class, Sandbox image, Sandbox Integration version, declared Harness set, OS user and group posture, filesystem and mount envelope, network policy, provider attachment visibility, Vault injection visibility class, static credential exposure class, resource class, backend capability summary, sensitivity class, and containment policy.

`SandboxCompatibilityKey` excludes Turn payloads, Thread history, native conversation handles, raw secrets, temporary upload handles, output contents, worker-private caches, and short-lived effect authority. A missing, stale, conflicting, or unequal required input rejects co-residency; no partial match, idle-process fallback, or capacity-only placement is permitted.

`AgentSessionCompatibilityKey` answers whether a later Turn may reuse one exact existing native conversation continuity. It includes Agent and profile identity, Thread affinity, native conversation protocol, AgentSession workspace layout, context and transcript posture, static policy envelope, provider-session posture, and required features. Ordinary Turn input revisions do not invalidate it when current inputs can be materialized into the declared slots; a changed static path, process environment, OS user, provider attachment posture, network envelope, credential visibility class, or required Harness feature requires replacement or a different Sandbox.

`HarnessCompatibilityKey` answers whether an AgentSession may use one existing Harness Instance rather than another Harness in the same Sandbox. It includes runtime family, adapter and native-runtime version, Harness protocol, runtime binary and state-root layout, fixed plugin, extension, hook and runtime-config digests, fixed process-environment posture, declared product-safe capabilities, and Harness resource class. It excludes Workspace, AgentSession, Thread, Turn, logical-model choice, transient Context Package, raw secrets, per-Turn route tokens, native conversation handle, and active process identity.

The key is created with the Harness record from one fully resolved static Harness descriptor and remains immutable for that Harness lifetime. An equal current descriptor may reuse the Harness within capacity; a different descriptor creates or selects another admitted Harness. A static configuration change produces a new key, drains the predecessor for new AgentSessions, and deletes it after its current bindings close. Restart adopts only an exact surviving key and descriptor; missing, stale, contradictory, duplicate, unsupported-adapter, over-capacity, or dependency-failed evidence blocks placement and drains or fences the narrowest provable boundary. A failed first creation produces no reusable Harness; an uncertain accepted creation follows the existing Harness, Sandbox, and Runtime Epoch cleanup widening rules rather than hidden retry.

Compatibility evidence is created with the Sandbox or AgentSession binding, remains immutable for that effective setup, and is re-evaluated for every new placement or reuse decision. A static-envelope update drains the old Sandbox for new AgentSessions; an AgentSession compatibility change closes or replaces only that binding when exact local cleanup is proved. Restart recomputes desired inputs from current owners and adopts only an exact surviving match; missing proof yields fresh placement without compatible substitution.

Observable conformance requires identical Sandbox inputs to select one shared Sandbox, different admitted Harness descriptors to select distinct Harnesses in that Sandbox, equal Harness descriptors to reuse one Harness within capacity, an incompatible AgentSession input to reject continuity reuse, and restart to adopt only exact surviving keys without approximate fallback.

### Turn Authority Boundary

Every `turn.start` receives one fresh immutable AEP snapshot, Context Package, route credentials, execution lease, deadline, and sequence scope bound to its exact Workspace, Thread, Turn, AgentSession, actor, request, Agent, profile, runtime, preferred and allowed logical-model contract, policy, Vault grants, resource limits, observability, backend requirements, and package digest. The existing AgentSession supplies continuity only.

No Sandbox-wide AEP, worker-control credential, inference credential, capability credential, provider credential, Vault credential, permission credential, or authorization package exists. Static Sandbox and Harness descriptors are placement evidence rather than authorization. A missing, stale, revoked, conflicting, or dependency-failed Turn package blocks `turn.start`; it cannot borrow a sibling package, refresh an old immutable snapshot, or fall back to Sandbox-wide authority.

Restart may continue one active Turn only through exact lineage, lease, package, process-key, route-token, binding, and sequence proof. Otherwise the prior outcome stays `interrupted`, `failed`, or `unknown` under existing owners, and any later Turn requires fresh admission. Observable conformance requires resident AgentSessions from two distinct Threads to reject each other's route credentials, rejects two current resident bindings for one Thread, and requires every sequential Turn to carry a newly admitted package and Context Package even when the native conversation is reused.

### Effect-Capable Member

An effect-capable member is any process or service in the epoch that can accept, retain, forward, complete, or materialize an OpenShell or container-backend effect. The NanoHost service, the Gateway, every member of the configured container backend with its helpers and proxies, and sandbox execution descendants are effect-capable members. Under the V1 Docker backend those backend members are the dedicated `dockerd`, its dedicated `containerd`, and their helpers and proxies.

Monitoring, logging, or read-only diagnostic processes may remain outside the failure group only when they cannot signal, forward, mutate, authenticate to, or complete a runtime effect.

### Configured Container Backend

A container backend is the concrete sandbox-hosting mechanism that stock OpenShell drives on behalf of the NanoHost. Stock OpenShell supports more than one; this specification authorizes exactly one **configured** backend per NanoHost deployment and requires the Runtime Epoch to contain only that backend's members.

A NanoHost MUST NOT instantiate, start, provision private roots for, prove empty, or rebuild a backend it is not configured to use. Supporting additional backends is a selection concern at configuration time, never a per-epoch instantiation cost. An epoch that starts an unconfigured backend is invalid.

Backend selection is deployment configuration and is part of epoch identity: changing the configured backend replaces the epoch through full invalidation and fresh creation, and no epoch ever hosts two backends or migrates between them.

The V1 configured backend is Docker, realized as one dedicated `dockerd` and its dedicated `containerd` with NanoHost-private roots, sockets, and networks, launched as foreground members of the NanoHost service cgroup. Podman is a candidate second backend and is not authorized until its own accepted realization contract defines its process shape, private-root layout, rootless posture, image-import path, and fail-stop proof.

### Backend Effect Domain Classification

Every candidate backend MUST be classified before it may be configured, because the epoch fence is complete cgroup termination and that fence only reaches effects the NanoHost's own process tree can complete.

| Class | Meaning | Fence | V1 status |
| --- | --- | --- | --- |
| Host-local effect domain | Every process able to accept, retain, forward, complete, or materialize an accepted sandbox effect is a descendant member of the NanoHost service cgroup on the execution host. | Complete control-group termination proves the prior effect domain impossible. | Docker authorized; Podman requires its own realization contract. |
| External effect domain | An accepted effect can be completed by a control plane, scheduler, kubelet, or node agent outside the NanoHost's process tree and outside its cgroup. | Cgroup termination is **not** a fence. A generation-scoped external fencing contract is required. | Kubernetes and every other remote orchestrator are **not authorized**. |

A backend with an external effect domain MUST NOT be configured under this specification. Whole-epoch invalidation is not a sufficient causal fence for it, because killing the NanoHost group leaves a remote scheduler able to complete a previously accepted create. Authorizing such a backend requires a separate accepted specification that defines its own fencing primitive, its generation identity, its admission block, and its proof that no prior-generation object can mutate the new generation. This specification's readiness, uncertainty, and recovery contracts MUST NOT be reinterpreted as covering it.

Naming a future backend here creates no current schema, configuration key, abstraction layer, driver interface, or capability negotiation. The NanoHost holds one concrete backend integration until a second accepted realization contract exists.

### NanoHost Image Store

The store boundary below is a host-to-Sandbox security and adjudication isolation claim. It does not provide security and adjudication isolation between co-resident AgentSessions.

The NanoHost Image Store is one durable, epoch-external, digest-addressed content store of verified sandbox image content on the execution host. It exists so that epoch rebuild cost is bounded by local import rather than by network retrieval or image construction.

The store contains only inert content: image manifests, configs, and layer blobs addressed by their content digest, plus a bounded local index of digest, source lineage, verification result, acquisition time, and last-import time. It MUST NOT contain mutable runtime state, live sockets, process identity, Gateway data, container records, sandbox state, epoch authentication material, or any credential.

The store is not the epoch, not canonical OpenKit storage, not an image registry, not a published artifact, and not product truth. It publishes nothing, serves no network listener, and creates no product-visible record. Its entries are a cache with durable content: removing an entry is always safe and only costs a later re-acquisition.

The store is readable and writable only by the NanoHost service account. The configured container backend receives content from it through an explicit NanoHost-driven import, never by sharing a mutable root, mounting the store into the epoch, or exposing it to a sandbox.

The store is bounded at 200 GiB of content. When the bound is reached the NanoHost evicts the least-recently-imported entries first, and it MUST NOT evict a digest in the required deployment image set or one referenced by a live attempt. If eviction cannot free space without violating those exclusions, acquisition fails and the dependent attempt fails closed; a healthy epoch is unaffected.

Store corruption is never repaired. An entry whose recomputed digest does not match its address is discarded, the dependent operation fails closed, and re-acquisition uses fresh authority. A missing or discarded entry blocks the exact attempt that needs it; it never invalidates a healthy epoch.

### Deployment Image And Attempt Image

Two image classes exist and they have different owners.

A **deployment image** is one of the repository-published worker images required by the deployment profile. Its content, capability baseline, and published identity are owned by `docs/specs/20260721-worker_execution_environment_images.md` and `docs/specs/20260708-container_image_packaging.md`. The required deployment image set is bounded by the Epoch Rebuild Cost Budget and is proved present at readiness.

An **attempt image** is content acquired or built for a specific already-authorized attempt. Its publication boundary and content guarantees are owned by `docs/specs/20260721-worker_execution_environment_images.md`, and the authority it does not confer is owned by that specification and the Agent Environment Package owner. What this specification requires is narrower and local: an attempt image exists only in the NanoHost Image Store, and it is consumed only by an attempt whose authorization names its exact content digest.

Both adjacent surfaces are owned elsewhere and both owners have accepted them. `docs/specs/20260616-agent_environment_package.md` owns the two resolved image forms and the build definition's immutability, no-secret, no-widen, and resolution rules as package content. `docs/specs/20260721-worker_execution_environment_images.md` owns the boundary statement for a non-published attempt image and states exactly what it does and does not guarantee, including that an attempt image hosting a governed worker must still satisfy the shim, non-root, and writable-layout runtime contract. This specification owns only NanoHost-local acquisition, verification, storage, import, and the host-to-Sandbox and host-to-build security and adjudication isolation boundaries; it MUST NOT restate the adjacent owners' rules.

### Image Acquisition And Build

The acquisition and build access exclusions below are host-to-Sandbox and host-to-build security and adjudication isolation claims. They do not provide security and adjudication isolation between co-resident AgentSessions.

Image acquisition is the NanoHost-local, off-readiness-path production of verified content in the NanoHost Image Store. It is never a readiness step and never an implicit side effect of admission. Two forms are authorized, and both terminate in one exact content digest.

Acquisition has exactly two triggers and no other:

- An explicit `server-admin`-authorized installation or maintenance acquisition action for a deployment image, performed on the execution host outside the readiness path. A deployment image absent from the store keeps the NanoHost non-ready until such an action succeeds; readiness never repairs it.
- A bounded acquisition request for an attempt image, carried on the authoritative control session for one already-authorized attempt, naming the exact reference or build definition. Failure fails that attempt's admission through its existing lease and worker owners and never invalidates a healthy epoch.

No other actor may initiate acquisition. A sandbox, a worker, Sandbox Integration, the Gateway, and the container backend MUST NOT trigger, influence, or observe it.

**Registry retrieval.** The V1 declared acquisition registry identity set is fixed to exactly the anonymous public hosts `docker.io` and `ghcr.io`. The corresponding runtime-owned fixed OCI registry acquisition and build-bootstrap authority is exactly the HTTPS host-port pair set `{docker.io:443, ghcr.io:443}`; it grants no non-443 port. The NanoHost may retrieve image content from that closed set for an exact reference that resolves to a digest, MUST verify the retrieved digest, MUST NOT accept a mutable tag as the identity that a sandbox consumes, and MUST NOT retrieve from any other host. No configuration, effect command, build definition, sandbox, or worker may supply, narrow, widen, authenticate, or replace either fixed set. Registry egress is permitted only for the acquisition or OCI build-bootstrap operation and never from inside a sandbox or from the readiness path.

The two fixed registry pairs authorize only OCI Distribution and exact-digest image-source traffic selected by the registry protocol. Registry repository, manifest, blob, token, and other protocol paths remain protocol-owned and do not become authored endpoint grants or ordinary Dockerfile `RUN` HTTP(S) authority. A general build HTTP(S) request to either fixed registry host is denied unless the resolved AEP separately carries that exact `{host, port}` grant. An HTTP redirect is accepted only when its exact destination host-port is already authorized for that same operation; a redirect to any undeclared host-port fails the exact acquisition or build, and neither its target nor path inherits or creates authority. No path grant, redirect grant, default port, non-443 registry port, suffix, wildcard, or fallback is inferred.

**Authorized build.** NanoCore may supply, as part of an already-authorized Agent Environment Package resolution, one bounded build definition. Its shape, authored form, immutability, no-secret rule, sandbox no-widen rule, and declared build egress set are owned by `docs/specs/20260616-agent_environment_package.md`; the NanoHost consumes the resolved result and MUST NOT reinterpret or extend it. The NanoHost MAY build it into the store under the configured backend's build operation.

V1 accepts exactly the build-context reference `build-context://empty/v1` and content digest `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. That digest is SHA-256 over the singleton's zero-entry canonical byte sequence, which is empty bytes. The independently supplied Dockerfile remains nonempty inline immutable AEP content of 1 through 268,435,456 UTF-8 bytes with a lowercase SHA-256 over exactly those bytes; it is not a context entry or locator. Before creating a build root, writing the Dockerfile, opening network access, or invoking the backend, NanoHost MUST reject a missing or different context pair, an empty, oversized, non-UTF-8, or digest-mismatched Dockerfile, or any claim that those bytes are part of the context digest. The NanoHost creates the fresh private build root once, materializes its `context` as the exact empty directory represented by the singleton, writes the separately verified Dockerfile as the build input, and independently recomputes both lineage values before the build. V1 has no Dockerfile fetch, locator, upload, host path, alternate spelling, context fetch or transfer, configuration, dependency, compatibility form, or future context variant.

A build definition is **input to the backend build operation only**. It MUST NOT become a NanoHost service argument vector, a host shell command, a unit definition, a host path, a NanoHost binary path, or an OpenShell operation selector. This is the single bounded exception to the rule that the NanoHost accepts no NanoCore-supplied executable instruction, and it is bounded by these requirements:

- At the host-to-build security and adjudication isolation level, the build runs under the configured backend's containment with no host mount, no host network namespace, no access to the NanoHost Token sink, the Gateway credentials, the container-runtime socket, or any epoch authentication material.
- Build network egress is limited at enforcement to the union of the runtime-owned fixed OCI registry pair set `{docker.io:443, ghcr.io:443}` and the resolved build definition's exact AEP-authored `{host, port}` grants. The two branches remain distinct: NanoHost MUST NOT infer, add, remove, or replace a port in an AEP grant, the fixed registry branch grants no ordinary Dockerfile `RUN` HTTP(S) authority or non-443 port, and neither branch reaches the sandbox that runs the resulting image.
- The build is bounded by declared time, output size, and layer count. The V1 hard maximum for `layerLimit` is 128 manifest layers. A build definition MUST declare an integer from 1 through 128 inclusive; absence, zero, fractional or overflowing input, or a value above 128 fails before any build effect. The exported OCI image MUST contain no more layers than both the accepted declaration and 128; exceeding either bound fails the exact build and admits no image.
- The build result is identified by its content digest, recorded in the store with its build-definition lineage, and consumed only by attempts whose authorization names that digest. It is never tagged as a published image, never pushed, and never becomes a repository-owned image.
- Build cache MAY be retained in the store as inert content keyed by digest. An unverifiable cache entry is discarded, never repaired.
- A build failure fails the exact attempt through its existing lease and worker owners. It does not invalidate a healthy epoch, because it completes no sandbox effect.

Image content authority, the repository-published worker images, their capability baseline, and which image an authored manifest may select remain owned by `docs/specs/20260721-worker_execution_environment_images.md`, `docs/specs/20260708-container_image_packaging.md`, and the Agent Environment Package owner. This specification owns only the NanoHost-local acquisition, verification, storage, and import mechanism.

### Epoch Image Import

Epoch creation imports the exact image digests required by the current deployment from the NanoHost Image Store into the fresh backend state, verifies each digest after import, and only then may proceed to readiness.

Readiness MUST NOT depend on registry retrieval, build, or any network operation. A required digest absent from the store keeps the NanoHost non-ready and is repaired by an explicit acquisition action, not by a readiness-time pull.

Import at epoch creation is a fresh-state operation into the new epoch. It MUST NOT be satisfied by reusing a prior epoch's backend root, image-store daemon state, container records, or surviving layer cache inside the old epoch.

A healthy epoch may also import one attempt image digest mid-epoch. Mid-epoch import is an ordinary mutable-membership operation of the same class as sandbox create: it is bounded, digest-verified after import, and does not change epoch identity, backend identity, supervision membership, or the epoch-local authentication generation. An import that already holds the digest is a no-op. A failed or unverifiable mid-epoch import fails the exact attempt and leaves the healthy epoch intact, because no sandbox effect was completed.

Mid-epoch import is bounded at most 45 seconds, matching the hard per-digest import bound. An import that exceeds it fails the exact attempt rather than stalling it, and acquisition that precedes it is bounded separately by its own retrieval and build bounds.

Mid-epoch import is the only image operation permitted inside a healthy epoch. It MUST NOT install a deployment image, change the required deployment image set, or be used to repair a readiness failure.

## Authority And Projection Boundary

| Concern | Durable authority | NanoHost or Integration projection |
| --- | --- | --- |
| Work selection and admission | NanoCore scheduler and SessionLease owners | Claims only the exact authorized attempt. |
| AgentSession and Turn continuity | Core AgentSession, Turn, Item, and worker-control owners | Hosts and reports exact lineage without redefining it. |
| Runtime lifecycle and cleanup | This specification under the Core runtime and sandbox boundaries | NanoHost performs all OpenShell and container-runtime effects locally. |
| Worker control | Worker-control protocol owner | Relays exact route messages without reinterpretation. |
| Inference and capabilities | Agent capability, provider, policy, Vault, usage, and audit owners | Exposes separately authenticated local routes and forwards their governed calls. |
| Runtime package | Agent Environment Package and scheduler owners | Receives immutable references and materializes them locally. |
| Workspace and Artifact data | Storage, native data systems, Artifact, and Workspace synchronization owners | Transfers and stages bytes without becoming canonical truth. |
| Readiness | This specification | Reports ready only after identity, supervision, stock components, fresh roots, network, and empty-runtime proofs succeed. |

The table above is this specification's projection of the substrate doctrine owned by `docs/core/runtime-model.md`: the NanoHost collects execution facts while NanoCore accepts product facts, work descends but authority does not, bytes move but truth does not, and the NanoHost buffers what it produces without caching what it was granted. Those four rules are not restated here and MUST be read from their Core owner.

The one authority the NanoHost does hold is the Core doctrine's named exception: the truth about its own local effects. NanoCore MUST accept the NanoHost's proof that an accepted local effect reached a definite result because it has no other source, and the NanoHost MUST NOT extend that proof into product meaning, terminal status, or completion.

The NanoHost may retain bounded private runtime evidence needed to report the current epoch and exact operation result. It MUST NOT create a durable product authority or a durable operation journal capable of resuming an in-flight OpenShell operation after NanoHost death.

## NanoHost service Technical Architecture

### Technical Role Matrix

| Role | V1 realization | Owns | Excludes |
| --- | --- | --- | --- |
| NanoHost service | One Rust binary crate under `apps/nanohost` | Runtime Epoch coordination, one NanoCore session, one Gateway client channel, local OpenShell effects, sandbox bridges, readiness, and bounded evidence. | Product authority, scheduler policy, durable operation recovery, alternate language implementation, and arbitrary proxying. |
| OpenShell client boundary | Exact-tag `openshell-sdk` client surface when proved usable, otherwise a minimum Tonic client generated from the exact `v0.0.99` protobuf snapshot | Typed lifecycle and forwarding RPC access over one authenticated loopback gRPC/HTTP/2 channel. | Gateway server code, CLI output parsing, filesystem discovery, floating `main`, and OpenShell protocol extensions. |
| stock OpenShell Gateway | Official unmodified checksum-verified `v0.0.99` foreground executable | Stock Gateway state, authentication, sandbox lifecycle coordination, `ForwardTcp`, Supervisor pairing, and byte relay. | OpenKit route semantics, NanoCore connectivity, in-process linking, OpenKit patches, and independent restart. |
| configured container backend | One dedicated `dockerd` and its dedicated `containerd` with NanoHost-private roots, sockets, and networks, as foreground service-cgroup members | Container and sandbox execution state for the current epoch only. | Backend selection, image acquisition, product authority, membership in more than one epoch, independent restart, and any effect domain outside the NanoHost service cgroup. |
| NanoHost Image Store | One durable epoch-external digest-addressed content directory plus a bounded index, owned by the NanoHost service account | Verified inert image content and its local index. | Registry service behaviour, published artifacts, product records, canonical storage, mutable runtime state, credentials, listeners, and epoch membership. |
| OS supervisor | Linux service manager and cgroup boundary proved by this specification | Complete group kill, host-to-Sandbox security and adjudication isolation through process containment, restart of a fresh epoch, and proof that no effect-capable member survives NanoHost failure. | Member-local recovery, a repository-owned supervisor framework, and readiness adjudication. |
| Sandbox Integration | The existing TypeScript `packages/worker-shim` evolved in place | Sandbox-local standard HTTP/2 client, fixed local binding, governed runtime-context injection, and Worker Agent process supervision. | Gateway credentials, `ForwardTcp`, direct NanoCore connectivity, route authority, and a second shim package. |
| NanoCore | Existing TypeScript `apps/nanocore` application | Durable work, scheduler, identity, permission, route semantics, lineage, sequence, usage, audit, product state, and the authorized build definition it supplies as backend build input. | Gateway, container-backend, sandbox, process, image-store, or Runtime Epoch lifecycle effects, and any host instruction. |

The first NanoHost implementation has four logical internal roles: an epoch coordinator, a NanoCore-session owner, an OpenShell-client owner, and a per-sandbox bridge owner. These are responsibility boundaries inside one binary crate, not required public interfaces, separate crates, plugins, services, databases, or durable state machines. They MAY remain in one source module until real complexity requires a split.

The Rust implementation uses the smallest async stack that satisfies the accepted transports: Tokio for asynchronous process and I/O ownership, the exact-tag OpenShell SDK or Tonic and Prost for Gateway gRPC, Hyper/H2 for the server side of the nested sandbox HTTP/2 session, and Rustls for the non-loopback NanoCore TLS boundary. Exact dependency versions and the Rust toolchain are reproducibly pinned through the app-local Cargo lock and toolchain setup owned by `docs/toolchain.md`; no application Web framework is required merely to match three fixed route namespaces.

Existing `@openkit/protocol` and `@openkit/worker-protocol` authorities continue to own cross-language OpenKit records. The NanoHost may consume generated language-neutral schemas, fixtures, or Rust projections from those owners, but it MUST NOT copy their knowledge into a second authoritative Rust schema family or import NanoCore implementation modules.

### Implementation Language Decision

The NanoHost service is implemented in Rust. This subsection records the argument, the benefits, the risks, and the condition under which the decision reverts, because the decision is a deliberate exception to an otherwise TypeScript repository and must not rest on unstated preference.

The argument is deployment shape, not capability. The mechanisms this specification requires — bidirectional gRPC streaming, an HTTP/2 server bound to an adapted byte stream, explicit flow-control accounting, foreground child ownership, and signal handling — are available in more than one runtime, and the fail-stop guarantee itself comes from the OS service manager's control-group termination rather than from any language. A rationale that claims these mechanisms are unavailable elsewhere would be wrong and MUST NOT be asserted.

The decision rests on four properties of the execution host instead:

- **Deployment artifact.** The NanoHost is the one OpenKit component installed on a machine that otherwise runs only the stock Gateway and a container backend. One self-contained compiled binary with a pinned toolchain removes a language runtime from the execution-host attack surface, patch obligation, and version-skew surface.
- **Resident footprint and predictability.** The NanoHost sits beside a container backend that is expected to consume the host's memory and CPU headroom. A small resident footprint with no garbage-collector pause is a better neighbour for the process that must remain able to observe children, export evidence, and exit deterministically under host pressure.
- **Upstream client reuse.** The pinned OpenShell release publishes its client surface in Rust. Consuming the exact-tag client, or generating the minimum client from the exact protobuf snapshot, keeps the NanoHost on the upstream contract without a second binding layer.
- **Explicit transport control.** The transport envelope requires per-stream window management and per-family in-flight accounting rather than library defaults. The selected stack exposes that control directly.

The accepted risks are real and are accepted knowingly:

- The repository gains a second language, toolchain, dependency graph, and gate family that must be pinned, built, linted, tested, and released.
- The most safety-critical component in the system becomes the one written in the language with the least existing repository precedent, and its reviewers and verifiers must be competent in it. Under this repository's delegation regime that raises the semantic-drift risk precisely where drift is most expensive.
- Cross-language protocol consumption must stay a generated projection of the existing owners; an independently evolving Rust schema family would create a second protocol authority.

Those risks are bounded by keeping `apps/nanohost` one small binary crate with four internal roles, no durable store, no framework, and no second package, and by consuming existing protocol authorities only through generated projections and bounded transport parsing.

The decision reverts if the Rust implementation cannot satisfy the accepted contract or its cost proves higher than the benefit above. The recorded reversion condition is any of: the selected client boundary cannot invoke the required stock operations, the transport envelope cannot be met in this stack, or the NanoHost's implementation and review throughput under delegation proves materially worse than the equivalent TypeScript path on comparable work. Reverting means implementing the same accepted contract in TypeScript with the Gateway still a separate checksum-verified foreground process; it never means weakening the contract, forking OpenShell, or splitting the NanoHost across two languages. Until such evidence exists, Rust is the sole selectable NanoHost implementation.

### OpenShell Source And Client Selection

Before NanoHost production code opens, immutable official `v0.0.99` source evidence MUST determine whether that tag's Rust SDK exposes the required authenticated sandbox lifecycle methods and raw forwarding client. When it does, `apps/nanohost` MUST pin that client source to the resolved release commit and lockfile and use one shared logical channel for the current Gateway. When it does not, `apps/nanohost` MAY generate only the required Tonic client from the exact refreshed `v0.0.99` protobuf snapshot.

The generated-client option changes only how NanoHost compiles the stock client contract; it does not authorize a private protocol, an OpenShell fork, server code reuse, a different Gateway version, or a CLI adapter. If neither exact-tag client path can invoke the required stock operations and `ForwardTcp` semantics, the feasibility gate fails and implementation returns to this specification.

The stock Gateway executable, exact Supervisor OCI image, CLI used for installation or diagnostics, client source or protobuf snapshot, and every other consumed OpenShell artifact MUST resolve to the same exact `v0.0.99` boundary. Production builds MUST NOT depend on OpenShell `main`, a version range, or a locally modified checkout.

The published Supervisor release identity is exact multi-platform index `ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6`. NanoHost's private Gateway configuration fixes the existing `supervisor_image` field to the exact child manifest for its supported compile target: `ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9` on `linux/amd64`, or `ghcr.io/nvidia/openshell/supervisor:0.0.99@sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38` on `linux/arm64`. The published index is retained as release evidence and never substituted for the platform manifest that readiness imports and Docker resolves locally. The stock Docker driver therefore selects explicit-image Tier 2 before the Tier-3 sibling lookup and uses its existing image extraction and cache path for the selected image's static-musl `/openshell-sandbox`. NanoHost does not consume the GNU sibling executable, infer another image, accept an unsupported compile target, or expose this fixed private value through deployment schema, configuration input, command, package, or worker state; a missing, changed, unresolvable, or unextractable exact platform image keeps the epoch non-ready.

### Process And Failure-Group Integration

The Gateway is a separate long-lived Runtime Epoch process, not a library loaded into the NanoHost. On the V1 Linux execution host, the NanoHost starts the fixed stock Gateway and dedicated container-runtime executables once as foreground children inside its OS service cgroup, using direct argument vectors and fixed NanoHost-owned paths without a shell or Gateway-management helper script. The service manager MUST apply complete control-group termination semantics equivalent to systemd `KillMode=control-group`.

The NanoHost waits for every directly owned effect-capable child and never restarts one inside the current epoch. A Gateway, container-backend, helper, or other effect-capable child exit makes the epoch invalid; the NanoHost stops admission, exports one `member-exit` Epoch Invalidation Report, and exits, and the OS supervisor terminates the complete cgroup before starting a fresh NanoHost generation. If stock `v0.0.99` cannot run in the required foreground and failure-group shape, the feasibility gate fails rather than allowing daemon escape, a parallel service owner, or a wrapper supervisor.

One `EpochCoordinator` owns one member/fence event seam for the complete epoch. Its monitor worker owns the child handles, polls them at the existing cadence throughout every short or long local effect, emits one terminal member-failure event, and accepts the coordinator's exact fence request for an uncertain lifecycle result or ordinary shutdown. The coordinator retains its one private OpenShell client and calls the closed local effect owners directly; the client is never cloned, exposed, placed behind shared locking, or replaced by a second lifecycle owner. The NanoHost main path selects outer-session and reconnect work against the coordinator's member-failure event, while the monitor remains able to export before fencing and terminate the complete group during registry acquisition, build, image import, create/delete, bridge, or file/reference work. Normal coordinator drop signals and joins that same monitor so every child is killed and reaped exactly once. This seam is not another Runtime Epoch owner, actor, scheduler, runner, or framework.

The NanoHost may invoke the exact OpenShell CLI for installation-time version inspection or explicitly authorized diagnostics only. Sandbox create, inspect, readiness, delete, provider or policy setup, session authorization, and forwarding during normal execution MUST use the compiled client and the one current Gateway channel; a subprocess exit code or parsed CLI document is not lifecycle settlement evidence.

### Sandbox HTTP/2 Adapter

For each active sandbox, the NanoHost's bridge owner adapts stock `TcpForwardFrame` data and closure into one asynchronous byte stream and serves one standard HTTP/2 connection over it. The adapter may translate only bytes, closure, cancellation, and backpressure between the stock stream and the standard HTTP/2 implementation; it MUST NOT introduce an OpenKit frame, channel id, replay buffer, request retry, dynamic target, or second connection.

Sandbox Integration remains the HTTP/2 client even though the Supervisor dials its fixed loopback listener to establish the underlying byte path. The NanoHost remains the HTTP/2 server and projects accepted route streams onto its one NanoCore session under the authority and failure rules below.

## Identity And Credential Contract

This specification uniquely owns the NanoHost transport credential class and its complete lifecycle. It reuses the accepted opaque-token cryptographic and redaction primitives from `docs/specs/20260704-remote_auth_credential_bootstrap.md`; that specification continues to own human access tokens and MUST NOT be extended or interpreted as the NanoHost credential owner.

### Accepted V1 Security Choice

V1 uses one dedicated bearer NanoHost Token plus server-authenticated TLS. It does not reuse a `server-admin` token and does not require or define mutual TLS.

The NanoHost Token is a Core `Token` projection owned by the configured NanoHost `IntegrationIdentity`. It has token type and closed scope `nanohost-transport`, is bound to exactly one NanoHost identity and one declared deployment, and authenticates only the NanoCore-to-NanoHost transport.

The NanoHost Token is not a human access token. Product, server administration, worker-control, inference, capability, Gateway, provider, and Vault routes MUST reject it, and the NanoHost transport MUST reject every human, server-admin, worker-control, inference, capability, Gateway, provider, and Vault credential.

### Secret Format And Verification

The raw NanoHost Token uses the existing `okt_` opaque-secret primitive: the prefix is followed by at least 256 bits of cryptographically secure random entropy encoded as one URL-safe value. No NanoHost-specific secret prefix, signed format, or parallel secret-protocol framework is introduced. Durable hash-only Core Token metadata for this class is a required Core projection and MUST NOT reuse or extend the human `openkit_access_tokens` owner.

NanoCore stores only a strong one-way hash and non-secret Core `Token` metadata, including token id, owner NanoHost identity, `nanohost-transport` type and scope, deployment binding, issuance and expiry, status, rotation lineage, responsible server-admin actor, and redacted last-use summary. NanoCore MUST compare verification results in constant time and MUST NOT store, recover, return, or expose the raw secret after the issuance sink write.

Unknown, malformed, wrong-type, wrong-scope, wrong-NanoHost, wrong-deployment, expired, rotated, revoked, or stale-generation tokens produce the same non-echoing authentication failure. The response, audit, log, metric, trace, and diagnostic MUST NOT reveal the presented token, its hash, or which verification step failed.

Existing OpenKit secret scanners and redaction filters MUST treat every `okt_` value as credential material. The raw token and its hash MUST NOT appear in stdout, stderr, argv, environment-variable dumps, ordinary logs, documentation, diagnostics, artifacts, AEPs, product records, audit records, or generated examples.

### Enrollment And One-Time Delivery

NanoHost enrollment is an explicit `server-admin`-authorized installation operation. On first installation it atomically creates the configured NanoHost `IntegrationIdentity` and its first `nanohost-transport` Token record or fails without leaving an active NanoHost identity or usable token. When the exact configured identity and deployment already name one retained decommissioned identity, a later explicit enrollment reactivates that same durable identity and creates one fresh Token instead of inserting another identity or reactivating an old Token. Reactivation preserves the identity's original creation time and every redacted Token, actor, and audit-history reference, clears only its decommissioned status and time, and is permitted only for the exact existing identity/deployment pair. An active identity, an identity bound to another deployment, a deployment bound to another identity, duplicate durable identity rows, or any missing or conflicting lineage fails closed without changing the retained identity.

The enrollment request names which of the two declared execution-host slots receives the first token, and first issuance names slot `A`. Before the raw write, both declared paths for that slot MUST be proved absent, and the operation MUST create the secret and companion without overwriting an existing path so one concurrent or stale writer cannot replace another attempt's credential. The operation writes the raw token exactly once to that exclusively acquired slot, writes its non-secret companion metadata, and returns only redacted identity, token-reference, and slot-result metadata; the raw value MUST NOT appear in a general API result, stdout, stderr, argv, log, document, diagnostic, Artifact, or AEP.

Each permitted slot is a root- or service-owned OS credential facility entry or a service credential file created with mode `0600`, owned by the NanoHost service account, outside the mutable Runtime Epoch, and inside the configured NanoHost deployment boundary. A remote installer MAY deliver through operator-authorized installation-time SSH using stdin, or through a declared platform secret-provisioning facility, only when the delivery path proves the named sink write without exposing the token in argv or output. OpenKit-managed SSH remains installation transport and never becomes runtime control or a credential fallback; the only normal-runtime exception is the same pinned opaque stock-internal relay beneath the fixed single-file `ExecSandboxInteractive` use.

The raw token exists only during issuance and in its named execution-host slot after successful delivery. If NanoCore cannot prove the slot write, or if the subsequent identity-reactivation and Token-record transaction fails, it revokes or leaves unusable the token and may clear only files still proved to belong to that attempt's exact Token id; it MUST NOT delete a missing, malformed, replaced, or differently owned slot. A proved exact clear leaves the NanoHost identity absent or decommissioned and reports only a redacted enrollment failure. If exact absence after cleanup cannot be proved, the identity remains absent or decommissioned, the new Token remains nonexistent or unusable, that slot blocks later enrollment until an explicit operator action proves it empty, and the failure is reported without inference. A later attempt is a new explicit server-admin-authorized enrollment or issuance action; there is no implicit retry, rebootstrap, printed recovery secret, fallback sink, identity-row replacement, or old-Token reactivation.

### Execution-Host Storage And Loading

The credential-sink exclusions below are host-to-Sandbox security and adjudication isolation claims. They do not provide security and adjudication isolation between co-resident AgentSessions.

The execution host keeps the raw NanoHost Token outside every mutable Runtime Epoch so a fresh epoch can reconnect with the same configured NanoHost identity. The OS credential facility or `0600` service credential file remains inside the NanoHost deployment boundary and is readable only by the NanoHost service account and its explicitly declared startup mechanism.

The named sink is one **stable pair of slots**, `A` and `B`, at fixed deployment-configured locations. Both slot locations are stable configuration that is explicitly **not** part of epoch identity: which slot currently holds the active credential changes without a configuration change, and installing or removing a slot's contents MUST NOT invalidate a healthy Runtime Epoch or interrupt a hosted AgentSession.

Each slot has one non-secret companion metadata record written by the same enrollment or rotation operation that writes the slot, with the same ownership and mode requirements as the slot itself. It carries only the Token id, the issuance generation, the owning NanoHost identity, and the declared deployment. It contains no secret and no hash.

The NanoHost selects its credential by a fixed runtime rule and no other: read both slots and present only the usable slot whose companion metadata declares the higher issuance generation for the configured NanoHost identity and deployment. Selection is a runtime read at connection time, never a cached epoch property. The NanoHost MUST NOT search any location outside the two declared slots, and it MUST NOT infer a generation from file modification time, filename, or content length.

There is no fallback to the other slot on rejection. Authentication failures are deliberately indistinguishable, so a rejected credential cannot be read as `successor not yet cut over` rather than `this secret is revoked`, and presenting the second slot's material would be exactly the credential fallback this specification prohibits. A rejected presented credential keeps the NanoHost non-ready and requires an explicit server-admin issuance or rotation action.

This is safe because a rotation abort clears the successor slot as part of the abort action, so a usable higher generation never coexists with a valid lower generation. Exactly one slot holds usable material at steady state, and the higher generation is usable precisely when NanoCore has issued it.

Companion metadata is an ordering hint, never an authority. NanoCore's verification alone decides validity, so tampering with the metadata can only change which slot is tried first and costs at most one additional authentication attempt per connection attempt. A slot whose metadata is missing, malformed, wrong-identity, wrong-deployment, or generation-ambiguous is treated as empty. If both slots are empty or ambiguous, the NanoHost remains non-ready and MUST NOT retry in a loop that could become a credential-probing behaviour.

The stock Gateway, the container backend, sandboxes, Sandbox Integration, worker processes, diagnostic users, and normal operator commands MUST NOT read either NanoHost Token slot. NanoHost configuration and the Agent Environment Package carry only a non-secret credential reference or local binding, never raw material or its hash.

Missing, unreadable, wrong-owner, wrong-mode, wrong-reference, or deployment-mismatched NanoHost Token material in both slots keeps the NanoHost non-ready and prevents an authoritative session. The NanoHost MUST NOT search alternate files, environment variables, inherited process state, shell history, Gateway configuration, or legacy NanoCore token locations.

### Rotation

NanoHost Token rotation is an explicit `server-admin` action that records predecessor-successor lineage plus a bounded overlap deadline. The default overlap is 24 hours and MAY be configured down to zero; it is not an availability grace after expiry.

Rotation writes the successor to **the slot the predecessor does not occupy**, at its existing stable location. It MUST NOT overwrite the predecessor slot, and it MUST NOT introduce a new sink location, because either would make rotation either destructive or a configuration change. Rotation is therefore not an epoch-affecting event: a healthy epoch and its running AgentSessions survive a complete rotation, including a failed one.

NanoCore issues the successor once through the same safe-sink rules. The successor may authenticate a candidate NanoHost session only after the successor slot installation succeeds. That candidate becomes authoritative only after its winning connection generation fences the predecessor connection; only then does NanoCore mark the predecessor Token `rotated` or `revoked`, after which it cannot authenticate or re-establish a connection.

The predecessor remains the sole authoritative credential and connection during the declared overlap until the successor wins, and its raw material remains intact in its own slot for exactly that reason. If the successor never establishes, an explicit server-admin action may abort rotation by revoking the successor and clearing the successor slot while leaving the predecessor active and authoritative, or retry by revoking the failed successor and issuing another one-time successor into the same non-active slot. Abort is possible precisely because the predecessor secret was never destroyed.

After a successful cutover the superseded slot is cleared by the explicit operator or rotation-completion path so exactly one slot holds usable material at steady state. A slot holding a revoked, rotated, or expired secret is treated as empty by credential selection and never becomes a fallback.

When the overlap deadline or either credential's expiry arrives, verification fails closed. If no successor has won, NanoCore fences the predecessor session, the NanoHost becomes non-ready for new work, and recovery requires explicit server-admin issuance; the system does not extend the overlap, reactivate a rotated or expired token, or auto-bootstrap.

Token lineage, Core Token status, the overlap deadline, and the existing connection generation are the complete rotation state. V1 adds no credential recovery coordinator, settlement record, or second lifecycle state machine, and two sessions are never authoritative even while both token records may verify during a pre-cutover overlap.

### Revocation

Revocation takes effect immediately at the auth layer. NanoCore denies the revoked Token, fences the current authoritative NanoHost session, stops new admission through that NanoHost, and marks the NanoHost non-ready.

Already-running AgentSessions may continue only under the existing bounded NanoCore-disconnect and lease semantics when the local NanoHost remains healthy and the revoked credential cannot reauthorize or open another connection. Revocation grants no extended lease, route authority, output acceptance, inferred completion, or automatic retry.

A replacement credential requires an explicit server-admin issuance or rotation action and one successful safe-sink delivery. There is no automatic bootstrap, fallback to a human or route token, old-token reactivation, alternate endpoint, or OpenKit-managed, exposed, configured, or caller-selected SSH runtime connection.

### Audit

Enrollment, issuance, safe-sink success or failure, rotation request, successor cutover or abort, revocation, expiry fencing, and decommission emit redacted audit evidence containing the configured NanoHost identity id, Token id and lineage ids, responsible server-admin `ActorRef`, declared deployment, action, result, and time.

Audit evidence MUST NOT contain the raw token, token hash, sink contents, private filesystem path, TLS private material, or recoverable credential fragment.

### Route-Credential Separation

Worker-control, inference, and capability traffic use three token classes distinct from the NanoHost Token and from one another. A token accepted by one route family MUST be rejected by the other route families and by NanoHost transport authentication even when all traffic shares one HTTP/2 connection or process.

OpenShell Gateway authentication material is epoch-local, generated or loaded inside the NanoHost boundary, and discarded with the epoch. It MUST NOT be returned to NanoCore, written into an Agent Environment Package, reused across epochs, or accepted as a NanoHost or route credential.

Provider and Vault-derived credentials remain governed by their existing owners. Sandbox Integration may receive only the already-approved local binding or injected value required by the exact route, and secret material MUST remain outside prompts, product records, normal workspace files, logs, and transport diagnostics.

The Agent Environment Package carries non-secret credential references and sandbox-local route bindings. It MUST NOT carry the NanoHost Token, raw worker-control token, raw inference token, raw capability token, OpenShell signing material, provider secret, or Vault material.

The private `sandboxIntegrationBindingRef` is opaque non-secret routing metadata allocated by the NanoCore runtime owner and fixed for one Sandbox Integration lifetime. It is neither a bearer credential nor sufficient authority: it is accepted only when NanoHost supplies it from the exact current bridge context over the current authoritative outer connection and NanoCore matches the current private Sandbox and Integration record. Every delivered Harness operation additionally carries the exact private `harnessInstanceId` selected by NanoCore from that Integration's admitted declared set. Neither value enters a native Agent child, AEP, Context Package, product record, ordinary diagnostic, or public request, and Integration cannot invent or use an unlisted Harness identity.

## TLS And Server Trust

Every non-loopback NanoCore endpoint, including an endpoint reached over a container bridge or from a remote execution host, MUST use server-authenticated TLS. The NanoHost validates the NanoCore certificate through normal platform trust or an explicitly configured non-secret CA reference. Certificate pinning is not supported by the V1 execution-host projection.

The deployment MAY use an upstream TLS terminator only when the deployment declares that boundary and the NanoHost validates the external endpoint presented by that terminator. Trust termination MUST NOT silently move to an undeclared internal plaintext hop visible to the NanoHost.

Exact same-host loopback MAY use plaintext HTTP/2 under the existing local trust rules. Container bridge, host LAN, overlay, tunnel, and remote-host addresses are non-loopback even when privately routed and therefore require TLS.

Missing, invalid, expired, hostname-mismatched, or untrusted certificate or trust material prevents an authoritative session and keeps the NanoHost non-ready. A configured CA is the exclusive trust source for that connection, and failure under that source MUST NOT fall back to platform roots. The NanoHost MUST NOT use verification bypass, trust on first use, plaintext downgrade, SSH tunnel runtime fallback, alternate endpoints, or bearer-token-only acceptance to restore availability.

This contract is dedicated bearer NanoHost Token authentication over server-authenticated TLS. It does not define mTLS, client certificates, server-admin token reuse, or another authentication path.

## NanoCore-To-NanoHost Communication Boundary

### One Authoritative Transport Connection

The NanoHost initiates and owns the physical NanoCore network connection as the HTTP/2 client, and NanoCore accepts it on the dedicated native HTTP/2 listener selected by `nanohost.bind`. At steady state, NanoCore and the configured NanoHost MUST have exactly one authoritative authenticated physical transport connection.

The NanoHost listener uses a separate local TCP port from the ordinary App HTTP/1.1 and SSE listener selected by `server.bind`; sharing one port on different interface addresses is not supported. It accepts only `/api/nanohost/transport/*`; the App listener rejects that prefix, and the NanoHost listener rejects every public App API, authentication, Gateway, diagnostics, and SSE path. A reverse proxy, Caddy, browser, ordinary fetch client, HTTP/1 request, or synthetic application request cannot enter or stand in for this listener. The configured `rendezvousUrl` is the origin used by NanoHost, while `nanohost.bind` is the local server bind and may differ only through an explicitly owned deployment mapping.

The target projection is one NanoHost-initiated standard HTTP/2 connection protected by the deployment's accepted authenticated transport security. Its configured NanoHost identity, deployment identity, Token, and authority-assigned connection generation are authenticated and bound to that exact physical connection before it may carry work. Standard HTTP/2 stream multiplexing is transport only and creates no OpenKit envelope, generic transport framework, fallback connection, multiplex protocol, or new message authority, and it requires no new transport dependency.

Every declared control, claim, readiness, worker-control, inference, capability, and fixed NanoHost-effect route MUST reuse this authoritative connection through ordinary client-request/server-response HTTP/2 streams, including streaming request or response bodies where the owning route requires them. NanoHost opens the request streams and NanoCore sends responses; NanoCore passes each accepted stream to the authoritative session dispatcher, which calls the existing semantic route or NanoHost-effect owner without replacing its authority. The fixed file-data stream is bound by the same native physical connection context and current successor fence, but its directional bodies, authorization, limits, status, retry, and error semantics remain distinct from control and route traffic. NanoCore MUST NOT initiate a parallel management connection into the NanoHost network, and neither participant may select SSH, an operator-managed or externally exposed Gateway forward, a sandbox-direct endpoint, or a second route-specific connection as fallback.

Connection establishment validates the configured NanoHost identity, protocol and service compatibility, credential state, and deployment lineage against the exact accepted physical connection before the transport-session authority allocates and binds its connection generation. A successful admission response returns that authority-assigned generation; NanoHost never proposes or selects it.

The dedicated NanoCore native HTTP/2 server creates one opaque, unforgeable, non-serializable process-local identity for each accepted physical connection and supplies it through server connection context to admission, the transport-session authority, the authoritative dispatcher, and every carried transport route. The admission request body is exactly `{}`; no body field, header, query parameter, serialized value, NanoHost state, App-listener request, or proxy request may supply or select the physical connection identity. A direct `app.request` or other synthetic application request has no physical server connection context and therefore cannot stand in for admission of a physical connection.

### Fixed Transport Readiness Projection

The sole readiness report is `POST /api/nanohost/transport/session/readiness` on the same authoritative native HTTP/2 connection. Its request body is exactly `{}`, and its only successful response is `204` with an empty body. The fixed path is private transport carriage rather than a public App API or OpenAPI operation. It adds no generic control operation, route envelope, state owner, module, configuration input, dependency, second connection, acquisition path, compatibility path, or fallback.

NanoHost sends this request only after `EpochCoordinator::start` has returned success and that physical connection's admission has returned `role=authoritative` and `mayCarryWork=true`. It awaits the durable empty acknowledgement before issuing any effect command poll. A candidate sends no readiness report. A non-`204` response, nonempty or malformed response, cancellation, or connection loss is an outer-session failure and permits no effect poll or scheduler work on that connection.

The existing NanoCore native session dispatcher obtains the opaque physical connection only from accepted request context, requires it to be the exact current authoritative work-carrying connection, derives its bound generation from the transport-session authority, derives the configured target identity and deployment from the already-allocated RuntimeTarget and configured identity owners, derives `predecessorFenced=true` from current connection authority, and uses the NanoCore server clock for `observedAt`. It then calls the existing RuntimeTarget owner with that exact already-allocated generation and directly projects `ready=true` plus the coordinator's established fresh-empty proof; the RuntimeTarget durable update completes before NanoCore returns the empty `204`. The authenticated admission allocation transaction is the sole connection-generation writer. Readiness cannot create a target, allocate, reuse, or advance a generation, grant or release active-Turn capacity, or substitute its request for local epoch proof. RuntimeTarget stores no mutable lease or capacity owner.

A nonempty body, synthetic or non-native request, candidate, closed or fenced predecessor, unknown target, identity or deployment mismatch, stale or future generation, repeated request after close, or request on another physical connection is rejected without readiness projection, lease mutation, capacity mutation, or generation advance. Every newly admitted authoritative physical connection, including a successor after reconnect, must complete its own admission and readiness request before effect polling. A healthy reconnect re-reports the same still-live coordinator's established fresh-empty proof without rebuilding the epoch or relaunching work, but this report cannot clear a cleanup fence created before or during that coordinator's connection generation. Server-observed close, transport failure, or authentication loss immediately fences that exact generation and projects it non-ready.

For an accepted effect whose result may have been lost with the predecessor connection, the authoritative successor MUST deliver the retained result for the same `requestId` before issuing any effect poll. After NanoCore restart, the effect's existing durable owner may register result-only expectations only when it can re-derive the complete deterministic request identity from immutable existing lineage: the exact backend cleanup row for `bridge.close` or `sandbox.delete`, or the exact accepted-final-status and product-owner tuple for its authorized closeout effect. This registration stores no command, token, new durable stage, or replay authority and cannot dispatch an effect. Missing, partial, conflicting, or non-deterministic derivation registers nothing and remains cleanup-owned.

Same-result delivery settles the exact existing owner without replay and lets that owner advance its ordinary next step. NanoHost retains at most one result, so only its exact operation path and `requestId` may select one expectation; a different or ambiguous result is a terminal conflict. If an authoritative successor has no eligible retained result and starts its first effect poll, NanoCore has the narrow proof that retained-result continuity is absent: it marks the old accepted effect `unknown` exactly once, preserves its cleanup owner and capacity fence, rejects and fences that successor connection, and never redispatches the effect. From that poll start until NanoHost completely receives its response, cancellation, reset, timeout, or physical close is terminal rather than reconnectable because NanoCore may already have committed that transition. The NanoHost therefore treats either the received terminal lineage conflict or loss in this exact response window as Runtime Epoch invalidation and fail-stops the complete effect domain without reconnecting the same coordinator. Only readiness from a later strictly increasing connection created by the fresh coordinator after that fail-stop may clear the cleanup fence. A healthy reconnect, repeated readiness, or connection generation alone never clears it.

### Fixed NanoHost Effect Carriage

The private NanoHost effect vocabulary is exactly `sandbox.create`, `sandbox.delete`, `bridge.open`, `bridge.close`, `image.acquire`, `image.build`, `file.export`, and `reference.import`. `attempt-session.cleanup` is not a wire operation: the existing backend cleanup owner composes the exact `bridge.close` and `sandbox.delete` operations. No caller may supply another operation literal or select an operation through a generic body field.

Each operation has exactly two private ordinary HTTP/2 command/result paths on the authoritative connection: `POST /api/nanohost/transport/effects/<operation>` for its command poll and `POST /api/nanohost/transport/effects/<operation>/result` for its result, where `<operation>` is one of the eight literal strings above. A command poll body is exactly `{}`. The NanoCore native server authenticates and binds the poll through the physical connection context, returns `204` when that exact operation is not pending, or returns one operation-specific `200`. The sole additional sub-carriage is fixed `POST /api/nanohost/transport/effects/image.build/input` for bytes already owned by an accepted pending `image.build`; it is neither a ninth operation nor another command/result pair. The NanoHost cycles the closed command paths fairly and has at most one effect-control request open at a time. One of the existing two outer NanoHost reservations remains control/readiness-only and the other is the fixed file-data reservation; at most one file-data stream is active across the two file effects and image-build input. These paths are private transport carriage, not App API or App-schema operations.

Every non-import `200` command body is bounded JSON containing one required lowercase 64-hex `requestId` and only the existing lease, backend-session, package-snapshot, Sandbox, image/build, or bounded-reference fields required by that fixed operation. The `image.acquire` command names the exact image reference and never carries a registry set or credential. The `image.build` command carries its current metadata and lineage fields: `requestId`, exact `contextRef`, `contextDigest`, `dockerfileDigest`, `arguments`, `argumentsDigest`, exact egress grants, positive `timeLimitSeconds`, `outputLimitBytes`, and `layerLimit`, plus canonical decimal `dockerfileByteLength` from 1 through 268435456. It omits the Dockerfile and all other bulk bytes, a source locator, host path, build root, socket, capability snapshot, executable selector, physical identity, connection generation, and operation selector. The generic control ceiling remains 512 KiB and is not raised for this command. The `file.export` command carries only request id, current Sandbox, exact AgentSession and Turn lineage, declared slot, normalized relative output path, the fixed 256 MiB maximum, accepted terminal and local-quiescence proof, and closed `presence` literal `required` or `optional`; it carries no digest or byte length. NanoCore selects `optional` only for an output whose existing semantic owner accepts absence, currently the Workspace change manifest, and NanoHost treats it only as transport metadata rather than interpreting Workspace or Git semantics. `bridge.open` carries only the exact static non-secret `sandboxIntegrationBindingRef` and bounded declared Harness descriptors required before carriage. It carries no AgentSession, Turn, AEP, Context Package, worker-control, inference, capability, Provider, Vault, or permission credential; those are admitted only through the exact later Harness operation and route owner. No NanoHost effect command contains bulk bytes, executable host instruction, route credential, connection generation, native conversation handle, or operation selector. The existing attempt/effect lineage owner deterministically derives `requestId` from the durable backend transition and immutable canonical input identity including the exact Dockerfile bytes before wire projection removes those bytes; for export that identity includes AgentSession, Turn, declared output path, presence, and accepted barrier lineage. NanoHost never selects it, and derivation creates no durable request record, queue, or operation journal.

Except for the two directional file bodies below, the matching result path carries the same `requestId` and only that operation's existing bounded JSON result: exact Sandbox identity or definite absence, bridge state, resulting image digest, bounded reference evidence, or the fixed typed failure defined here. NanoHost validates the local request/result identity before sending. After complete local acceptance of `bridge.open`, NanoHost retains only request identity, the epoch-local live Harness monitor and bridge state, and the settled redacted result. NanoCore accepts a result only for the exact expected durable backend transition, exact `requestId`, matching fixed operation path, and current authoritative bound physical connection. An unknown or mismatched identity, a duplicate with a different result, or a candidate, fenced, stale-predecessor, or wrong-operation connection is rejected without mutation.

For an ordinary bounded-JSON result, the sole failure alternative is the exact two-member object `{"requestId":"<requestId>","failureCode":"effect_failed"}` with no additional member. `<requestId>` is the matching lowercase 64-hex identity already owned by the command; the complete `failureCode` grammar is the one lowercase ASCII literal `effect_failed`, not an extensible code vocabulary. It carries no id other than `requestId`, argument, path, endpoint, header, body, provider or runtime output, credential, arbitrary text, or nested error. NanoHost may send it only when the existing local owner has reached a definite failed result and the operation-specific lifecycle proves the failure leaves no unclassified effect. NanoCore requires the current authoritative physical connection, fixed operation path, accepted pending command, and exact `requestId`; on a match it returns empty `204`, removes and rejects that existing pending effect exactly once as a failure, records only the same bounded completed-result identity needed for exact duplicate recognition, and never passes the object to a success validator. An identical result-delivery uncertainty may use the existing successor-only correlated resend and idempotent acknowledgement without settling the pending effect twice; a conflicting duplicate or definitive non-`204` rejection is never replayed. The same physical session continues polling after an acknowledged definite per-request failure, and the healthy epoch remains live only when that operation's existing owner permits it. This alternative does not apply to physical or result-delivery uncertainty, an uncertain accepted create, delete, or `bridge.open`, `reference.import`, or present-file `file.export`; their existing unknown, cleanup, delete, fence, raw-body, and no-fallback rules remain controlling. The one non-failure JSON result on the `file.export` path is exact `{"requestId":"<requestId>","state":"absent"}` for an accepted pending command whose `presence` is `optional`; it is a proved transport fact, not a generic JSON fallback, file body, semantic result, failure code, or new effect.

Outer-session failure classification is closed and value-free. Its disposition is exactly `reconnect` or `terminal`; its stage is exactly `connect`, `admission`, `readiness`, `poll`, `execute`, or `result`; its operation is exactly one of the eight fixed effect literals when the stage is `poll`, `execute`, or `result`, and otherwise `none`; and its status is the received three-digit HTTP status from `100` through `599`, or `none` when no response status exists. Its bounded display is exactly `nanohost outer session failure: disposition=<disposition> stage=<stage> operation=<operation> status=<status>`. An observed physical connection close or uncertain delivery of an already-definite result is reconnectable only subject to the existing sensitive-bridge and file-effect uncertainty rules and the poll-response exception below; it fences that physical generation, preserves an eligible correlated result, and waits for a strictly increasing admitted and ready successor without logical replay. When an authoritative successor has no eligible retained result and has started its first effect poll, cancellation, reset, timeout, or physical close before the complete response is terminal and fail-stops the coordinator because NanoCore may already have committed poll-first `unknown`; that window never enters the reconnect loop. Admission or readiness rejection, malformed command, invalid identity or generation, stale or wrong-operation carriage, unexpected poll or result status, definitive result rejection, member failure, and every other protocol or session failure are terminal and are not relabeled or retried. The sole `main` exit path prints the display once only for a terminal failure and exits nonzero; reconnectable failures print nothing and remain inside the successor loop. Neither the display nor another diagnostic may include generation, request id, lease, sandbox id, image reference, filesystem path, endpoint, header value, body, raw error, provider or runtime output, or credential.

After accepting bounded `image.build` metadata, NanoHost sends fixed `POST /api/nanohost/transport/effects/image.build/input` with exact `content-type: application/json`, exact body `{}`, and `x-openkit-request-id` containing that accepted lowercase 64-hex identity on the same current authoritative and ready physical connection. NanoCore requires the accepted pending operation and exact physical/request binding, then returns `200 application/octet-stream` with exact `content-length`, `x-openkit-request-id`, `x-openkit-sha256`, and `x-openkit-byte-length`; the body is exactly the immutable Dockerfile UTF-8 bytes. On every fixed file-data request or response, each required OpenKit application header appears exactly once and its value is validated against the accepted request and effect identity plus the applicable slot, path, digest, declared length, observed length, and body facts. Every required HTTP representation header remains exact and single-valued; a missing or duplicate required header or an HTTP/2-invalid header block fails closed. Legal additional HTTP transport or representation headers carry no authority and are ignored. Both length headers are the same canonical decimal from `1` through `268435456`, equal the preceding metadata declaration and observed bytes, and the digest is exact lowercase `sha256:<64hex>`. The response contains no slot, relative path, file identity, AEP body, context or argument bytes, generic metadata envelope, or result semantics. NanoHost uses at most the existing single active file-data stream, consumes and releases capacity in chunks of at most 65,536 bytes, and verifies request identity, content type, both lengths, digest, complete body, and UTF-8 before creating a build root, writing a Dockerfile, opening build egress, or invoking Buildx. The current `BuildDefinition` and `execute_image_build` owner independently recompute the Dockerfile digest and preserve the exact empty-context pair; the unchanged JSON success or exact `effect_failed` result never echoes the input.

A malformed input request or response media type, request identity, digest, decimal length, UTF-8 body, forbidden field, or contradictory metadata fails closed before `BuildPlan`. Candidate, fenced, stale-predecessor, wrong-operation, unknown, unaccepted, mismatched-request, or repeated same-generation input fetch receives `409` and no bytes; an announced over-ceiling body receives `413`; a bounded private NanoCore source or stream failure receives redacted `500`. No error exposes Dockerfile bytes, host paths, endpoints, headers, package content, credentials, or backend-private state. NanoHost retains only bounded accepted metadata and request-private partial bytes until verification or failure. Reset, cancellation, timeout, or physical close before complete verification removes the partial body and proves that no build root or backend effect started; the command becomes a definite `effect_failed` result, and a lost connection retains only that bounded result plus request identity for successor submission. The Dockerfile body is never refetched, resumed, or replayed. After complete verification and local build admission, connection loss never restarts the build; the existing owner finishes once and only its unchanged result may cross a successor. NanoCore removes retained pending bytes on exact success or failure, explicit owner abort, or owning lifecycle cleanup; NanoHost removes partial input on every rejection and verified input through existing build-root cleanup. Neither side adds a Dockerfile record, journal, transfer handle, cursor, range, append state, or settlement record.

For each admitted Turn, `reference.import` first maps the AEP owner's exact canonical worker-consumed bytes into that Turn's AgentSession-private package slot, then maps the prepared Context Package's exact sorted regular-file inventory into AgentSession-private Turn slots. This order begins after exact `session.open` or reuse admission and completes before `turn.start`; it does not write a Sandbox-wide package or Context root. Its poll returns `200 application/octet-stream` with exact `content-length` and the five required canonical headers `x-openkit-request-id`, `x-openkit-slot`, `x-openkit-relative-path`, `x-openkit-sha256`, and `x-openkit-byte-length`; NanoHost fully stages and verifies those immutable source facts before the fixed Sandbox helper runs, then returns the existing bounded JSON result. A present `file.export` returns its complete body as `application/octet-stream` on its fixed result path with the same five headers, but its digest and byte length are actual facts computed by NanoHost after the accepted Turn terminal barrier rather than AEP declarations. An optional absent export returns only exact `application/json` `{"requestId":"<requestId>","state":"absent"}` on that same path and creates no file-data staging. NanoCore acknowledges an export result with `204` only after complete request-private staging, digest and length verification, fsync, and atomic placement or after exact optional absence validation; canonical collection remains with the existing transcript, Artifact, and Workspace owners. Exact path encoding, header grammar, statuses, helper bounds, and canonical handoff are owned by `docs/specs/20260801-nanohost_workspace_data_boundary.md`.

If the outer connection closes after NanoHost accepted a local effect, NanoHost neither abandons nor re-executes it. The existing local owner continues to a definite result, and NanoHost retains only that correlated result in the existing epoch-local produced-fact boundary until it may submit the same `requestId` on an authoritative successor. For export, this may include only one of two closed results: the complete verified body and its exact AgentSession, Turn, slot, path, actual digest, and actual length, or the exact proved optional-absence JSON `{"requestId":"<requestId>","state":"absent"}`; it never retains or resends a partial and never reruns the Sandbox export. For an accepted `bridge.open`, the same live Harness monitor and bridge survive, and the successor receives only the identical settled redacted result and restored route carriage; reconnect issues no Start, stdin, Sandbox create, Harness launch, or already-current bridge open. NanoCore removes incomplete export staging, may acknowledge only an identical already-complete present staging tuple or optional-absence result, and rejects an ambiguous or changed duplicate. A lost Turn import completion is never replayed: `turn.start` remains blocked and AgentSession-local cleanup widens to Harness drain, Sandbox deletion, or epoch invalidation when proof is uncertain. Loss before NanoHost completely accepts `bridge.open` is `unknown`; NanoCore does not re-poll or replay it, NanoHost does not infer Harness launch, and exact Sandbox deletion or epoch invalidation on uncertain deletion follows. NanoCore re-derives the expected identity from existing durable lineage; when it cannot prove the exact pending transition, existing owners preserve `interrupted`, `unknown`, or cleanup-required truth and never repeat or infer the effect. A later logical retry is a new request authorized by the existing attempt/effect owner with a newly derived identity. This carriage adds no generic envelope, durable queue, journal, second connection, transport framework, dependency, compatibility route, range, append, cursor, resume, compression, trailer, or second logical result.

### Replacement And Predecessor Fencing

The transport-session authority owns authentication, generation allocation, physical-connection binding, and fencing. After authentication, one checked SQLite transaction allocates generation `1` when no generation exists or exactly the durable high-water generation plus one, and persists that generation as non-ready and unfenced before process-local connection binding. The RuntimeTarget `connection_generation` is only the durable high-water and current-generation projection consumed by that authority; it does not allocate generations or create cross-domain atomicity with the physical connection.

A failure before that transaction commits does not advance the durable generation. An unauthenticated or stale request, a concurrent transaction loser, a repeated admission on the same physical connection, or an allocation overflow is rejected without advancing it. If process-local binding or session establishment fails after commit, the allocated generation is consumed and remains durably non-ready and fenced; the next connection must allocate its successor. No schema, recovery coordinator, transport framework, or dependency is added for this lifecycle.

Every new physical connection, including one after transient loss or NanoCore restart, receives a strictly increasing successor connection generation bound to the same configured NanoHost identity and deployment; a generation is never reused on another physical connection. NanoCore MUST reject or fence the predecessor connection before the successor may report readiness, and the successor remains durably non-ready and carries no work until its own fixed readiness request succeeds.

At no point may two sessions be authoritative for the same NanoHost identity. A late frame, replay, heartbeat, result, or readiness report from the predecessor MUST be rejected after fencing and MUST NOT mutate the successor's lease or route state.

If NanoCore cannot prove the predecessor fenced, the successor remains non-authoritative and carries no work. Availability MUST NOT be restored by allowing concurrent predecessor and successor sessions.

The native HTTP/2 server's observed close event for a bound physical connection immediately makes that exact connection generation unable to carry work and causes the transport-session authority to persist it fenced and non-ready while retaining it as the durable high-water generation. Transport failure, authentication failure, or server loss has the same exact-generation result. A reconnect never resumes authority on the closed connection or its generation.

Transport reconnect does not create a new NanoHost identity, Runtime Epoch, AgentSession, lease, sandbox, worker process, or Turn. It restores carriage only after the existing owners prove exact identity and lineage.

The sole App API observation of NanoHost authenticated readiness is parameter-free `GET /api/app/nanohost/runtime-target`. In server mode, an authenticated `server-admin` may read only the already configured `RuntimeTarget` selected by the configured NanoHost identity; no caller may select or supply a target. A successful response contains exactly `identityId`, `deploymentId`, positive-integer `connectionGeneration`, boolean `predecessorFenced`, boolean `ready`, boolean `freshEmpty`, and ISO-timestamp `observedAt`; absence of that configured target returns `404`, and every existing server-mode, storage, configuration, and authorization failure remains fail-closed. The response MUST NOT expose a token, hash, credential slot, lease, capacity, Sandbox, Runtime Epoch, endpoint, filesystem value, or private-connection identity, and this read creates no storage, configuration, UI, diagnostics owner, durable fact, or lifecycle. An H1 host observation may claim authenticated readiness only when `identityId` and `deploymentId` match the configured identity and deployment, all three booleans are `true`, and the observation was obtained after the H1 start from the current connection generation.

### Logical Route Separation

Shared carriage MUST preserve route-family boundaries. This is credential and semantic separation that supports conversation-context isolation; it is not security and adjudication isolation between co-resident AgentSessions and does not protect against a compromised shared Harness.

| Route family | Required separation |
| --- | --- |
| NanoHost control and readiness | NanoHost credential and configured-NanoHost scope; bounded control payloads; no worker or provider authority. |
| Fixed file data and build input | Native physical-connection authentication, current successor fence, exact effect/subpath and request correlation, one active directional body, and no control, route, review, publication, or result authority. |
| `/worker-control/harness/poll` and `/worker-control/harness/result` | No bearer token; exact current nested connection, NanoHost-injected Harness binding, current authoritative outer connection, one unsettled sequence, and the fixed Harness-operation semantics owned by worker control. |
| `/worker-control/*` | Worker-control token, exact lease and process lineage, exact ordering and sequence, worker-control retry and terminal semantics. |
| `/inference/*` | Inference token, model and provider scope, inference-specific request and response bounds, provider failure semantics, and usage attribution. |
| `/capabilities/*` | Capability token, declared capability and permission scope, capability-specific bounds, `CapabilityCall` failure semantics, usage, and audit. |

Each family owns its own payload size, timeout, retry budget, idempotency, terminal meaning, usage, and audit mapping. The outer session MUST enforce or delegate those rules without replacing them with one shared policy.

Every active Turn uses independently generated worker-control and inference raw tokens, not a shared value and not a value derived from or equal to the non-secret `sandboxBindingRef`. The existing scheduler lease/token-binding owner persists exactly two nullable lowercase SHA-256 projections per live lease, one per family, and never a raw token. Each family hashes a presented raw value and compares it to the exact current AgentSession, Turn, lease, package, and route lineage; worker control rejects the inference token, inference rejects the worker-control token, capability accepts neither, and both reject a sibling AgentSession's token. Raw tokens remain live-memory only in NanoCore, NanoHost while carrying the exact admitted Turn operation, and that Turn's AgentSession-local route boundary. They never enter Harness-global process environment, Sandbox-wide files, or another AgentSession.

NanoCore restart rebuilds each active Turn's two family bindings from its lease-owned hashes and current AEP and lineage while the surviving NanoHost and AgentSession-local route boundary retain the same raw values. Reconnect rebinds carriage without token reissuance, Start, Sandbox, Harness, or AgentSession recreation, or another bridge open. Terminal, stale, fenced, and releasing lineage revokes both bindings through the existing lease status owner, except that exact accepted `final_status` replay retains only its already-owned idempotency semantics. No credential service, token table, configuration, or durable raw-secret owner is added.

Worker-control traffic MUST remain able to deliver interrupts, heartbeats, exact sequence, and terminal evidence under permitted inference or capability load. Backpressure in one family MUST NOT authorize dropping, reordering, replaying, or interpreting traffic in another family. The transport envelope below is how that requirement becomes enforceable rather than aspirational.

### Data Exclusion

The authoritative session's control, readiness, worker-control, inference, and capability streams carry only their bounded semantic traffic. Native Git transfer, object-store transfer, Workspace trees, Artifact payloads, model files, image archives, and other large data MUST use the native system or bounded transfer mechanism selected by `docs/specs/20260801-nanohost_workspace_data_boundary.md`; the sole outer-connection exception is that owner's exact fixed file-data stream for the two single-file effects and one fixed Dockerfile response.

The control session may carry immutable references, digests, lengths, bounded manifests, acknowledgements, and small inline diagnostics. A native data path MUST NOT carry OpenKit control commands, route tokens, readiness, lease ownership, or terminal-status semantics merely because it is network-accessible.

## Transport Envelope And Worker-Control Liveness

Route separation on a shared HTTP/2 connection MUST NOT be implemented through HTTP/2 stream priority. The RFC 9113 priority scheme is deprecated and is not meaningfully implemented by the accepted server or client stacks, so a design that depends on it has no mechanism. This specification therefore names the mechanisms that do exist and the numbers they must satisfy.

### Nested Flow Control Is The Primary Hazard

Under the pinned realization, one inference response traverses at least three independent flow-control windows and one fixed intermediate buffer: the nested HTTP/2 session, the Supervisor-side relay stream, the Gateway pairing buffer, the NanoHost-side forward stream, and then the NanoHost-to-NanoCore HTTP/2 session. Each layer can be locally correct while the composition stalls, spikes latency, or buffers without bound.

This is the design's largest correctness-under-load risk. It MUST be measured, not assumed: the realization gate owns saturation measurement of end-to-end throughput, added latency, and peak intermediate buffering, and a realization that cannot bound intermediate buffering fails the gate.

### Envelope Measurement Boundary

The hazard above is compositional: what must be proved bounded is the total bytes held between the two application endpoints, not the private allocation of each hop. This subsection fixes what is observed, where, and what result the gate takes from it. It changes no value in the numeric envelope below.

**Named boundaries.** The closed byte-boundary vocabulary is exactly four boundaries, each a current and peak byte count carrying an explicit direction:

- `outer-session` — bytes admitted to the NanoHost-to-NanoCore HTTP/2 path and not yet released by application consumption;
- `relay-composite` — bytes held between accepted stock frames and nested-session consumption at the NanoHost stock `ForwardTcp`/`RelayStream` adapter boundary, in either direction;
- `worker-control` — in-flight DATA held by the worker-control route family;
- `inference` — in-flight DATA held by the inference route family.

No other byte-boundary name, byte aggregation, or derived byte-boundary key belongs to this vocabulary. A serialized object size, retained file size, process resident size, configured constant, or source constant is not one of these observations and MUST NOT be recorded as one.

**The stock interior is bounded by pinned constants, not by live sampling.** The Supervisor relay queue and the Gateway pairing buffer remain opaque pinned implementation details. Their contribution is already settled by `### Observed Upstream Constants`, which disposes of the forward and relay chunk sizes and the Gateway pairing-buffer size as values re-observed at the pin and recorded in the pin manifest, and which states that this envelope's explicit accounting complements rather than depends on stock adaptive HTTP/2 window behaviour. The gate therefore proves the composition bounded by the following argument, and MUST state that argument rather than assert that a composite observation is sufficient:

- the outer session's held bytes are ceiling-enforced and live-measured as `outer-session`;
- the nested session's held bytes are ceiling-enforced and live-measured as `worker-control` and `inference`;
- the NanoHost adapter's own holding is live-measured as `relay-composite`;
- the Gateway pairing buffer, the forward chunk, and the relay chunk are finite constants recorded in the pin manifest;
- the stock adaptive windows hold only bytes an OpenKit endpoint has already admitted under its per-family in-flight ceiling and its bounded per-inference-write size, so they contribute no term that is not already ceiling-enforced and measured at an OpenKit boundary.

Every term is therefore either live-measured at an OpenKit boundary or a finite pinned constant, and the composition is bounded. A live sample of the interior occupancy of a fixed pinned buffer adds nothing to that conclusion and is not required. If a re-pin observation ever finds a stock hop whose holding is neither fixed nor bounded by admitted bytes, this argument fails at that hop and the gate returns a mechanism failure under `### Calibration Disposition`.

The composed ceiling for a family is derived, not chosen: it is the sum of that family's in-flight ceiling on every session the observation spans, plus the pinned Gateway pairing-buffer size, pinned forward-chunk size, and pinned relay-chunk size. Changing an input recomputes it.

**Who may observe.** This specification names what MUST be observed and where; it does not name the implementing owner of the observation. An observation satisfies a boundary when it is taken at that boundary, is bound to exactly one attempt, and contains only the closed measurement values and the redacted attempt binding defined below. An endpoint occupying an OpenKit role at a boundary discharges the boundaries it occupies, whether that endpoint is production code or a verifier-owned fixture standing in for it. Where only the two application endpoints are observable, `outer-session` and `relay-composite` MAY be realized together as one direction-specific end-to-end outstanding count, equal to bytes released by the producing endpoint minus bytes consumed by the consuming endpoint. This count conservatively bounds the logical bytes outstanding across those two boundaries and is checked against the composed ceiling; it does not by itself prove either component ceiling, so the separately enforced per-session and per-family ceilings remain required. Introducing an observer inside production code is not authorized by this subsection. A verifier-owned fixture MAY discharge the observation without a production change; if that is impossible, the gate returns a missing-observability finding and any production seam requires a separately accepted amendment to the owning specification plus a separate implementation-mode package.

**Saturation.** `Saturating inference load` is defined below. A measurement is admitted only when the inference family is proved to have been held at both its stream ceiling and its in-flight DATA ceiling continuously for at least the required interval on each session the observation spans, with the observed stream count and in-flight byte total recorded. Elapsed time, a running worker, or an open stream count alone is not that proof.

**Liveness acceptance predicates.** Interrupt delivery is measured from the committed product interrupt authorization and mode-selected enqueue to shared-supervisor observation. For `bounded-turn`, NanoCore's durable worker-command enqueue and acknowledgement instants are an admissible conservative realization of that interval; for `session-continuity`, the private Harness-operation admission and successful result instants are an admissible conservative realization because success requires exact process-group absence. A server-side poll delivery instant alone is not admissible because it precedes supervisor observation. The heartbeat bound is accepted on the complete sequence of accepted heartbeats, which is the same gap quantity the numeric envelope already states: the worst observed gap between consecutive accepted heartbeats MUST satisfy the unconsumed-lease margin stated in that row and in `### Admissibility Ceilings`, and MUST NOT exceed the scheduled lease heartbeat interval owned by `docs/specs/20260703-runtime_scheduling_scale.md` plus the delivery-delay bound. The worker-side scheduled-emission instant is not observable without a worker-control protocol change, which this specification does not require and does not authorize. The accepted-gap condition therefore decides the admissibility ceiling exactly, and is a necessary condition on the delivery-delay target rather than a per-sample proof of it; this specification states that limitation rather than implying equivalence, and a violation of the condition falsifies the bound.

**Observation lifecycle and authority.** One measurement generation is created when a bridge attempt is accepted, belongs only to that attempt, and is never inherited. It is finalized exactly once at definite bridge close, attempt failure, epoch invalidation, or process termination; a successor or later gate attempt starts a new generation, and a failed or partial generation is never resumed, repaired, or reused. The finalized snapshot contains only the four byte-boundary rows and their current, peak, and direction fields; the saturation duration, stream count, and in-flight byte total required above; interrupt-delivery intervals; accepted-heartbeat gaps; one status of `complete`, `incomplete`, or `invalid`; and one evidence-local opaque attempt binding generated once for that attempt and never reused. The verifier retains the binding-to-lineage association privately and MUST NOT serialize raw epoch, lease, request, sandbox, Gateway channel, token, path, header, payload, transcript, provider output, or credential values. Arithmetic or correlation faults, including overflow, underflow, unmatched release, duplicate finalization, or conflicting attempt binding, yield `invalid`; a missing boundary, missing liveness observation, insufficient saturation interval, or loss before a complete snapshot yields `incomplete`; both fail the gate and neither may clamp a value, fail product traffic, or alter runtime state.

The measurement is private non-authoritative evidence. It MUST NOT enter a Core record, public API, protocol field, product diagnostic payload, audit payload, transcript, Artifact, `RuntimeTarget`, or Epoch Invalidation Report, and it MUST NOT inform a readiness, capacity, scheduling, recovery, lease, terminal, or retry decision. This subsection creates no durable record, retention rule, or pruning owner.

**Gate result.** A missing, invalid, incomplete, unbound, or out-of-bound measurement fails the realization gate. A measurement that is present, complete, attempt-bound, and within its composed ceiling satisfies the bounded-intermediate-buffering requirement stated above. A measured value that exceeds a calibratable target while staying inside its admissibility ceiling is a calibration under `### Calibration Disposition` and MUST NOT be recorded as a gate failure; a value beyond the ceiling, or an inability to bound the composition at any admissible configuration, is a mechanism failure.

### Required Mechanisms

- **Per-family stream reservation.** The NanoHost counts open streams per route namespace and admits a new stream only within that family's ceiling. Reserved worker-control slots MUST NOT be consumable by any other family under any load, and a family at its ceiling receives a typed refusal rather than a silent queue.
- **Explicit flow-control accounting.** The NanoHost MUST manage receive windows explicitly rather than accepting library defaults: it sets a bounded per-stream initial window, releases capacity as the application consumes bytes, and enforces a per-family ceiling on in-flight DATA so no family can occupy the connection-level window.
- **Bounded inference chunking.** The NanoHost MUST bound the DATA it forwards per inference stream write so no single burst monopolizes the shared connection window between two worker-control requests.
- **Sufficient worker-control reservation.** The worker-control owner caps a control envelope and a live event payload at two different sizes, and the larger of the two is what a reserved stream must be able to carry. The reserved connection-window floor is therefore derived, not chosen: it equals the reserved worker-control stream count multiplied by the per-stream initial receive window, so every reserved stream can carry one complete largest permitted request concurrently without waiting on another family. Changing either input changes the floor.

### Numeric Envelope

These are the V1 transport bounds. They are transport numbers owned here; payload semantics, retry budgets, and terminal meanings remain owned by each route family.

| Bound | V1 value | Applies to |
| --- | --- | --- |
| Connection-level receive window | 5 MiB | both sessions |
| Nested session maximum concurrent streams | 14, the exact sum of the family ceilings below | Sandbox Integration to NanoHost |
| Reserved `/worker-control/*` streams | 4, never reallocated | Sandbox Integration to NanoHost |
| `/inference/*` concurrent stream ceiling | 8 | Sandbox Integration to NanoHost |
| `/capabilities/*` concurrent stream ceiling | 2, and 0 while the namespace is reserved and non-callable | Sandbox Integration to NanoHost |
| Outer session maximum concurrent streams | 16, the exact sum of the family ceilings below | NanoHost to NanoCore |
| Reserved NanoHost control and readiness streams | 1, never reallocated | NanoHost to NanoCore |
| Reserved fixed file-data streams | 1, never reallocated and at most one active across file effects and build input | NanoHost to NanoCore |
| Reserved `/worker-control/*` streams on the outer session | 4, never reallocated | NanoHost to NanoCore |
| `/inference/*` concurrent stream ceiling on the outer session | 8 | NanoHost to NanoCore |
| `/capabilities/*` concurrent stream ceiling on the outer session | 2, and 0 while the namespace is reserved and non-callable | NanoHost to NanoCore |
| Per-stream initial receive window | 256 KiB | both sessions |
| Reserved connection-window floor for worker-control | 1 MiB, derived as 4 reserved streams multiplied by the 256 KiB per-stream window, never granted to another family | both sessions |
| Per-family in-flight DATA ceiling for `/worker-control/*` | 1 MiB, derived as 4 reserved streams multiplied by the 256 KiB per-stream window, equal to the reserved floor above because every reserved stream may be in flight at once | both sessions |
| Per-family in-flight DATA ceiling for `/inference/*` | 2 MiB, derived as 8 streams multiplied by the 256 KiB per-stream window | both sessions |
| Per-family in-flight DATA ceiling for `/capabilities/*` | 512 KiB, derived as 2 streams multiplied by the 256 KiB per-stream window | both sessions |
| In-flight DATA ceiling for the fixed file-data stream | 256 KiB, released only as the application consumes at most 64 KiB at a time | NanoHost to NanoCore |
| Per-family in-flight DATA ceiling for NanoHost control and readiness | 256 KiB, derived as 1 reserved stream multiplied by the 256 KiB per-stream window | NanoHost to NanoCore |
| Maximum forwarded DATA per inference stream write | 64 KiB | both sessions |
| Interrupt delivery, committed product authorization and selected enqueue to shared-supervisor observation, p99 under saturating inference load | at most 2000 ms | end to end |
| Heartbeat delivery delay under saturating inference load | at most 10 s after scheduled emission, so the worst-case gap between accepted heartbeats stays at two thirds of the lease heartbeat deadline owned by `docs/specs/20260703-runtime_scheduling_scale.md` and leaves at least one third unconsumed | end to end |
| Bridge re-establishment, route-loss observation to successor route-ready, including detection and predecessor-closure proof | target at most 30 s, hard bound at most 120 s | NanoHost |

Every family ceiling is derived from the per-stream window so the reservations compose: on the nested session the family in-flight ceilings sum to 3.5 MiB and on the outer session they sum to 4.0 MiB, both strictly inside the 5 MiB connection-level receive window, leaving 1.5 MiB and 1.0 MiB of headroom respectively that no family may claim. A stream count and an in-flight ceiling are never set independently; changing one changes the other.

The 5 MiB connection-level receive window is the smallest whole-MiB value that preserves this composition while leaving the accepted 256 KiB per-stream window and every family stream count unchanged, because at those inputs the outer session's ceilings already sum to 4.0 MiB and a 4 MiB window would leave the outer session no unclaimed headroom at all. It is an owner-preserving consistency correction, not a measured optimum, not derived from any saturation or throughput observation, and whole-MiB granularity is a convenience of this one correction rather than a general rule for this envelope.

`Saturating inference load` means the inference family held continuously at its stream and in-flight DATA ceilings for at least 60 seconds.

### Derived Values Versus Calibratable Targets

Every value above is one of two kinds, and they have different amendment rules. Confusing them is how a measured miss becomes either an unjustified relaxation or a false blocking failure.

**Derived values** are computed from another value and are never tuned independently: the reserved connection-window floor is the reserved worker-control stream count multiplied by the per-stream window, each family in-flight ceiling is that family's stream ceiling multiplied by the per-stream window, and each session's maximum concurrent streams is the exact sum of its family ceilings. Changing an input recomputes every dependent value in the same amendment.

**Calibratable targets** are the values chosen ahead of measurement: the per-stream window, the family stream ceilings, the connection-level receive window, the maximum forwarded DATA per inference write, the interrupt-delivery bound, the heartbeat-delay bound, the bridge re-establishment target and hard bound, and the epoch rebuild budgets. They were selected for internal consistency, not from observation, and the realization gate is the first time any of them meets a real system.

### Calibration Disposition

A measured miss on a calibratable target has exactly one of two dispositions, and the gate MUST classify which before anything else happens.

**Mechanism failure — blocking.** The mechanism cannot satisfy the owning requirement at any admissible configuration. Concretely: worker-control liveness cannot be maintained under saturating load at any permitted stream, window, or chunk setting; intermediate buffering across the nested layers cannot be bounded; predecessor closure cannot be made definite; or a measured value exceeds the admissibility ceiling below. This blocks implementation and returns the design to the Stock Realization Annex exactly as a missing stock mechanism does.

**Calibration — not blocking.** The mechanism satisfies the requirement at a different value. The gate records the measured value with its conditions, the number is amended here through an ordinary bounded amendment, every derived value is recomputed, and the acceptance predicate re-anchors to the amended value. This is not a gate failure and MUST NOT be recorded as one.

A calibration MUST NOT be applied by whoever measured it. The measurement is an artifact and its producer does not adjudicate it.

### Admissibility Ceilings

A calibratable target may move, but not without limit. Each ceiling below is derived from another owner's contract, and a measured value beyond it is a mechanism failure rather than a calibration, because past that point the transport no longer supports the behaviour its consumer is entitled to.

| Target | V1 value | Admissibility ceiling | Why the ceiling |
| --- | --- | --- | --- |
| Interrupt delivery p99 under saturation | 2000 ms | 5000 ms | Beyond this a cancel is not perceptibly a cancel, and each cancel burns provider work the user already asked to stop. |
| Heartbeat delivery delay under saturation | 10 s | must leave at least one full heartbeat interval of the lease deadline unconsumed | A smaller margin makes one delayed heartbeat a lost lease. |
| Bridge re-establishment hard bound | 120 s | must leave at least half the worker-control outage budget unconsumed | The worker must not exhaust a budget for a condition only the runtime can fix. |
| Epoch rebuild, fence to ready | 90 s target, 300 s hard | exceeding the hard bound falsifies the shared-epoch premise rather than merely missing a number | The premise, not the transport, is what a slow rebuild refutes. |
| Per-stream window, family ceilings, connection window, forwarded DATA per write | as stated | free within the derivation rule, provided the reserved worker-control floor stays derived and the family ceilings sum inside the connection window | These exist to make the reservations compose; only the composition is load-bearing. |

Any missed heartbeat deadline is a mechanism failure regardless of the measured delay, because a lost lease is not a tuning outcome.

The interrupt bound is measured from committed authorization and the mode-selected enqueue rather than from poll issue, because under pull-only delivery the dominant term is how long an interrupt waits for the next poll rather than transport time. Satisfying it therefore depends on the selected worker-command or private-Harness poll cadence, which is worker-control semantics stated as a protocol requirement by `docs/specs/20260703-worker_control_protocol.md` and bounded there against this bound. This specification MUST NOT state, derive, or restate that cadence, and it MUST NOT raise this bound without that owner restating its cadence against the new value.

### Bridge Re-Establishment Versus The Worker Outage Budget

Worker-control gives Sandbox Integration a bounded post-launch outage budget with fixed retry, owned by `docs/specs/20260703-worker_control_protocol.md`. Under this design Integration cannot restore its own byte path: only the NanoHost may establish a successor bridge, and only after proving predecessor closure. Integration therefore consumes its own budget for a condition it cannot influence.

The NanoHost MUST bound that exposure. The bounded interval starts when the NanoHost observes route loss, not when predecessor closure is proved, so detection latency is inside the bound rather than outside it. The hard bound MUST leave at least half of the worker-control outage budget unconsumed measured from the same route-loss instant the worker's own budget starts from. If the NanoHost cannot return the sandbox to route-ready within the hard bound, it MUST stop attempting silently and report the sandbox route failure through the existing lease, worker-control, and reliability owners so the attempt reaches a truthful `interrupted` or `unknown` outcome instead of expiring inside the worker.

Bridge re-establishment latency MUST NOT be improved by skipping predecessor-closure proof, replaying a logical request, adopting an unproved pair, or extending the worker's budget.

### Bounded Conditional Fallback

If saturation measurement proves that one byte stream per sandbox cannot satisfy the worker-control liveness bounds, the runtime MAY carry `/worker-control/*` on a second dedicated current byte stream for the same sandbox, established by the same mechanism, with its own predecessor fencing, its own credential, and no other change to route ownership.

This fallback is authorized only by recorded measurement evidence that the single-stream shape fails a named bound. It is not selectable by configuration, not a performance option, not a second execution route into the sandbox, and never carries inference or capability traffic. Choosing it MUST be recorded against the realization gate and MUST NOT be used to avoid implementing the required mechanisms above.

Absent that evidence, exactly one byte stream per active sandbox remains the contract.

## Sandbox Transport Requirement

This section states the durable requirement for sandbox-to-NanoHost carriage independently of the mechanism that satisfies it. The pinned stock mechanism is a realization of this requirement, marked as such below and enumerated in the Stock Realization Annex. A realization that fails its feasibility gate changes the realization, not this requirement.

For each active sandbox, the runtime MUST provide exactly one current authenticated bidirectional byte stream between Sandbox Integration and the NanoHost service with all of the following properties:

- It is established without exposing the Gateway, the container-runtime socket, the Supervisor interface, or any sandbox port beyond the execution host's loopback boundary, and without an operator-managed forward, public listener, or sandbox-to-NanoCore path.
- It is initiated from inside the runtime boundary toward a target the NanoHost fixes from the accepted Integration contract, never from caller input.
- It carries exactly one standard HTTP/2 session in which Sandbox Integration is the client and the NanoHost service is the server, with no OpenKit frame envelope, channel identifier, byte multiplexer, replay buffer, or private reconnect layer around it.
- It provides bidirectional streaming, definite closure, cancellation propagation, and end-to-end backpressure sufficient to satisfy the transport envelope stated above.
- Its predecessor can be proved closed or fenced before a successor carries route traffic.
- It exposes exactly the three declared route namespaces and no fourth.

Sandbox Integration is the HTTP/2 client because worker-control command delivery is pull-only under `docs/specs/20260703-worker_control_protocol.md`: NanoCore never initiates a request into the sandbox, so no inbound-request capability is required and none is granted. This is a load-bearing consequence, not an incidental choice. Adding backend command push would invert the role assignment and require a second inbound path; it therefore remains deferred and MUST return to this specification and the worker-control owner before any implementation, rather than being introduced as a transport optimization.

Reversing the HTTP/2 roles, adding a second byte stream per sandbox, or exposing an inbound sandbox listener to the NanoHost are all outside this requirement, with one bounded and explicitly gated exception stated under the transport envelope.

## NanoHost-Service-To-Gateway Communication Boundary

The subsections below are the pinned stock realization of the requirement above.

### One Epoch-Local Gateway Client

The NanoHost service is the only OpenKit process that may authenticate to the stock Gateway or invoke its management and forwarding APIs. At steady state it maintains one current epoch-local authenticated mTLS logical client channel to the loopback-only Gateway. Stock lifecycle RPCs, the `ForwardTcp` stream for each active sandbox, one fixed `ExecSandboxInteractive` single-file helper, and one fixed unary `ExecSandbox` worker bootstrap/monitor inside `bridge.open` reuse that channel; CLI listeners, operator-managed local forwards, public Gateway ports, NanoCore-to-Gateway connections, and a second data connection are prohibited.

The NanoHost invokes only the closed stock operations required by the accepted lifecycle, route bridge, and single-file effect. NanoCore supplies authorized work and immutable package inputs, but it cannot select a Gateway address, method, socket, target host, target port, service id, authorization token, arbitrary OpenShell operation, executable, environment, working directory, or timeout. The Sandbox Integration target is an image-owned fixed loopback binding resolved by the NanoHost from the accepted Integration contract rather than caller input.

The NanoHost obtains any stock `ForwardTcp` authorization material through the pinned Gateway API. That material is sandbox-bound, short-lived, epoch-local OpenShell authentication state; it is not SSH runtime transport even when the pinned upstream API names the issuing record as an SSH session. It MUST remain inside the NanoHost and Gateway boundary, MUST NOT enter the AEP or sandbox, and MUST be revoked or discarded when the bridge closes.

### Realization: Fixed Sandbox File Effect

For `reference.import` and `file.export`, the NanoHost invokes the pinned typed `ExecSandboxInteractive` RPC on that same retained mTLS client for the exact current ready Sandbox and one NanoHost-owned fixed helper command. The command, arguments, environment, working directory, timeout, SSH fields, and endpoint are fixed implementation details and never caller, package, worker, or configuration input. Every import or export is bound to an exact AgentSession and Turn slot selected by the existing data owner; no Sandbox-global package or Context destination is admitted. The exact one-regular-file envelope for imports and present exports, optional export's exact leaf-absence branch on the same result path, 256 MiB aggregate bound, 64 KiB chunk and event rule, admitted-identity-relative path, lowercase SHA-256 and length proof, import atomic placement, export terminal barrier and private staging, result non-authority, and no-replay semantics are owned by `docs/specs/20260801-nanohost_workspace_data_boundary.md`.

The one pinned opaque internal SSH relay beneath `ExecSandboxInteractive` is allowed solely as implementation closure of the fixed single-file helper. It uses the Gateway's authenticated ready-sandbox authorization and one stock single-use Gateway-internal loopback listener that is neither OpenKit-managed nor reachable from the sandbox or public network. All OpenKit-managed, exposed, configured, or caller-selected SSH; direct SSH credentials or endpoints; SSH tunnel, lifecycle, control, data-settlement, or fallback semantics; stock CLI upload/download; and any second connection remain prohibited.

After RPC admission, the helper completes from the exact declared request length under at-most-64-KiB frames and the 256-MiB aggregate bound. NanoHost keeps the request sender open through exactly one exit and clean response completion and drops it only after settlement; request EOF never precedes the response. Exit zero is the only present-file success. Exact exit `2` with empty stdout and stderr is the only optional-absence success. Every other nonzero, missing or duplicate exit, stderr, output accompanying exit `2`, oversized or extra data, digest or length mismatch, gRPC error, timeout, cancellation, relay loss, or unclean completion fails or leaves the effect `unknown`, never successful and never replayed. Import uncertainty prevents worker launch; export uncertainty admits no result; reachable partial staging is removed, exact sandbox deletion is required, and an uncertain delete invalidates the epoch under the existing fence.

### Realization: Fixed Worker Bootstrap And Monitor

The unary `ExecSandbox` request is a compiled internal phase of `bridge.open` for the exact current ready Sandbox. Its Start request uses one image-owned fixed Sandbox Integration entry command, fixed working directory, no TTY, zero columns and rows, `timeout_seconds=0`, no AEP or Context Package, and only non-secret Sandbox Integration and declared-Harness bootstrap lineage. No NanoCore command field, AEP field, caller, image label, AgentSession, Turn, or worker input may select or alter the executable, argument, working directory, TTY shape, timeout, environment keys, or target; only the resolved static declared Harness descriptor set is configuration input.

The unary request carries empty stdin and request EOF before long-lived Sandbox Integration execution. The request remains within the pinned decoded-message cap, and NanoHost retains the server response stream as the epoch-local Integration monitor. No worker-control, inference, capability, Provider, Vault, permission, AgentSession, or Turn credential enters `bridge.open`, Integration argv, Integration environment, disk, static configuration, diagnostics, stdout, stderr, transcript, evidence, or ordinary logs. The static non-secret `sandboxIntegrationBindingRef` remains in the NanoHost bridge context and is never delivered to Integration. Exact per-Turn route credentials arrive only through the fixed authenticated `turn.start` result and are bound to AgentSession-local descriptors or route handles; capability remains disabled unless separately admitted for that Turn.

Immediately before it enters the fixed Sandbox Integration and Harness service loop, the image-owned entry module writes exactly the ASCII bytes `OPENKIT_WORKER_SHIM_ENTRY_V1\n` to the unary response stdout exactly once. The retained marker spelling is a fixed implementation vocabulary item with no interpolation, path, identity, token, timestamp, or other runtime value. It proves only that the intended entry module loaded and reached its Harness handoff; it does not prove Integration listener readiness, Harness readiness, AgentSession open, Turn start, terminal status, or cleanup.

`exec_sandbox_worker_bootstrap` consumes stdout as a byte stream until that exact marker is complete, allowing the marker to be split at any byte boundary across any number of stdout events. Each non-empty stdout byte before completion must extend the exact marker prefix. Missing or incomplete marker bytes, Exit or stream completion before the complete marker, duplicate marker bytes, any other non-empty stdout before or after the marker, any non-empty stderr, or response failure is `EpochFault::MemberExited`. Empty stdout and stderr events carry no evidence and are ignored. Only after accepting the complete marker may the function hand the still-live retained response monitor to the bridge path; the marker is consumed only in NanoHost memory and MUST NOT enter a log, transcript, Artifact, AEP, product record, NanoCore request, audit payload, or public diagnostic.

After marker acceptance, the monitor and the one fixed `ForwardTcp` bridge coexist on the same authenticated Gateway client and current Sandbox. Request EOF, response cancellation or loss, monitor drop, bridge close, outer-connection close, or a Turn interrupt proves neither AgentSession-local execution termination nor Harness process-group absence. The response monitor remains live through the Sandbox Harness lifetime and must observe exactly one correlated Exit followed by clean completion when that Harness ends; missing or duplicate Exit, any non-empty stdout or stderr, relay or member loss, or ambiguous monitor cleanup is unresolved and follows exact Sandbox deletion plus epoch invalidation when deletion is not definite. One AgentSession close uses its fixed local proof and does not require or cause monitor completion.

### Realization: Stock Sandbox Bridge Establishment

For one active Sandbox, bridge establishment has this exact target sequence before any AgentSession opens or Turn package is imported:

1. The stock sandbox Supervisor establishes its authenticated `ConnectSupervisor` stream to the loopback Gateway and authenticates the current sandbox principal; the NanoHost correlates that current Supervisor session with the sandbox and Gateway state created inside the current epoch.
2. NanoHost sends the fixed unary `ExecSandbox` request with empty stdin and request EOF, accepts the exact value-free Integration-entry marker, and retains the still-live response monitor; only then may it attempt the bridge. Sandbox Integration loads the exact declared Harness set and binds at `127.0.0.1:17891` without opening an AgentSession or starting a Turn.
3. The NanoHost opens one stock `ForwardTcp` bidirectional stream naming the current sandbox, the fixed Integration loopback target, a bounded service identifier, and the stock target authorization material.
4. The Gateway validates the NanoHost-side request and sends one `RelayOpen` with a Gateway-allocated channel id and the fixed target on the current sandbox's `ConnectSupervisor` stream.
5. The stock Supervisor dials the Integration loopback target, initiates one `RelayStream` carrying the matching channel id on its existing authenticated Gateway connection, and reports definite open success or failure.
6. The Gateway pairs the pending `ForwardTcp` and `RelayStream` by channel id and thereafter bridges raw bytes in both directions without parsing OpenKit routes.
7. Sandbox Integration acts as the standard HTTP/2 client on the paired byte stream, and the NanoHost service acts as the standard HTTP/2 server. Integration sends the client preface and exposes only the three declared route namespaces.
8. Integration sends exact `POST /worker-control/harness/poll` with no body, `Authorization`, or Integration-binding header. NanoHost rejects either client-supplied header, injects the current bridge's exact `sandboxIntegrationBindingRef` only on the outer request, and NanoCore returns empty `204` only after matching the authoritative outer connection, current private Sandbox Integration record, and complete declared Harness set. A later operation response carries one NanoCore-selected `harnessInstanceId`; Integration cannot request a Harness through the poll.
9. That first exact `204` is the product-safe Integration-ready latch. It proves the private pull path, Sandbox, exact declared Harness descriptor set, adapter registry support, compatibility keys, and capacity declarations without opening an AgentSession, creating a native conversation, delivering a Turn credential, or releasing a native Agent child; capability remains fail-closed.
10. NanoHost settles `bridge.open` only after the Start, request EOF, bridge, nested H2, Integration-ready latch, and live response monitor are correlated to the same request, Sandbox, declared Harness set, and current static lineage.

Sandbox Integration also binds a distinct fixed loopback-only `127.0.0.1:17892` HTTP/1 listener for the native Agent's OpenAI-compatible projection. That listener is not another `ForwardTcp`, `RelayStream`, nested HTTP/2 session, NanoHost connection, route family, or egress path; `127.0.0.1:17891` remains exclusive to every initial or successor stock Supervisor bridge. The native listener accepts only `POST /inference/*` with the exact active Turn inference bearer, enforces the semantic owner's 16 MiB encoded request aggregate before carriage, and forwards the unchanged origin-form path, bytes, end-to-end headers, and content encoding through the already-ready nested HTTP/2 client session under the existing 2 MiB in-flight ceiling and 64 KiB write bound. Responses, including SSE and content encoding, stream back with bounded writes and backpressure; native cancellation cancels the one outer stream, and the local projection never retries or replays. Worker-control, capability, absolute-form, unauthenticated, and non-`POST` traffic is rejected before an outer stream opens. The adapter-owned fixed URL is `http://127.0.0.1:17892/inference/v1`; no AEP field or caller selects it. Both `NO_PROXY` and `no_proxy` in the native child must include exact `127.0.0.1` so inherited HTTP, HTTPS, or all-protocol proxy settings cannot capture this request.

Both fixed listeners are bound before the Integration-entry marker. Native HTTP/1 admission remains disabled until the nested HTTP/2 client is ready, which occurs before the first private Harness poll; the first credential-free poll `204` then proves the ready outer route, complete declared Harness set, and both bound listener roles before any native child may launch. Either bind failure, a non-HTTP/2 Supervisor bridge, unexpected listener or nested-session closure, protocol-role confusion, unsupported declared adapter, or inability to preserve the fixed loopback bypass fails the existing Integration and Sandbox lifecycle; an individual native socket failure cancels only its one request unless it also proves the native listener or nested session failed. Definite Integration close stops both listeners, aborts active native requests, closes the nested session, and follows the existing Harness and Sandbox cleanup owner.

Step 5 is deadline-bound by stock behavior: the Gateway reaps an unclaimed relay slot if the Supervisor does not initiate the matching `RelayStream` within the pinned release's pending-claim timeout, observed as ten seconds at the current evidence boundary. The NanoHost MUST treat an unclaimed or reaped slot as a definite bridge-establishment failure for that sandbox rather than waiting indefinitely, MUST NOT open a second overlapping `ForwardTcp` for the same sandbox while a slot is pending, and MUST confirm the exact pinned value through the realization gate before production use.

The Gateway-allocated channel id and stock frame boundaries are OpenShell transport internals, not an OpenKit session id or multiplexer. A strict-risk real-use verifier MAY produce one attempt-scoped external evidence record that correlates the exact NanoHost effect attempt with the stock Gateway channel id and observed relay lifecycle. That verifier evidence remains outside OpenKit durable state and product diagnostics; the channel id MUST NOT enter NanoCore, Sandbox Integration, the Worker Agent, a product record, an audit payload, or any public or operator diagnostic. No other exposure is authorized, and OpenKit MUST NOT add another envelope around the bridged bytes.

One active sandbox has exactly one current `ForwardTcp`/`RelayStream` pair and one nested HTTP/2 session at steady state, or exactly two when the bounded conditional worker-control fallback has been authorized by recorded measurement evidence. The pair is long-lived across route requests; worker-control, inference, and capability calls create standard HTTP/2 streams rather than new Gateway forwards or RelayStreams. The stock Supervisor control stream remains an OpenShell lifecycle mechanism and does not become a fourth OpenKit route family.

### NanoHost Route Projection

The NanoHost terminates the server side of the nested sandbox HTTP/2 session, acts as the client on the distinct authoritative NanoHost-to-NanoCore HTTP/2 connection, and projects each accepted logical stream through an ordinary client request on that connection. This is a bounded three-namespace bridge, not an arbitrary TCP or HTTP proxy. It accepts no CONNECT target, caller-selected origin, absolute URL, dynamic route registration, or fourth namespace.

The NanoHost may enforce the transport bounds owned by this specification and attach the already-resolved private sandbox binding needed to select the exact NanoCore route context. It MUST preserve the owning route's path, body, streaming, cancellation, credential, lineage, ordering, and failure semantics and MUST NOT authorize, synthesize, retry, reorder, reinterpret, or terminalize a worker-control, inference, or capability request. NanoCore remains the semantic and durable authority.

The only path-specific adaptation is closed to exact `POST /worker-control/harness/poll` and `POST /worker-control/harness/result`. NanoHost accepts each only from the exclusive current Integration-client nested H2 connection, rejects an `authorization` or `x-openkit-harness-binding` header supplied by that client, and projects the request with exactly one `x-openkit-harness-binding` value from the current bridge context. It accepts at most one such request at a time, enforces the 64 KiB control ceiling, and returns NanoCore's exact response without buffering, replaying, interpreting, or retaining a Harness command or result. Every other `/worker-control/*` request retains the unchanged worker-visible bearer and lineage contract. This adds no effect, fourth namespace, reverse connection, NanoHost queue, journal, credential, or semantic authority.

### Replacement, Failure, And Readiness

A lost or replaced `ForwardTcp`, `RelayStream`, Supervisor session, or nested HTTP/2 session makes that sandbox route bridge non-ready. The NanoHost may establish a successor bridge only after it proves the predecessor pair closed or fenced and proves the same current epoch, Gateway, sandbox principal and Supervisor session, Harness binding, and static route lineage. A successor bridge does not create a sandbox, worker, AgentSession, lease, or retry authority, and late predecessor bytes are rejected.

The bridge layer never replays an in-flight logical request. Each route owner alone decides whether the caller may retry the same immutable operation. If predecessor closure, current identity, or exact route lineage cannot be proved, the sandbox cannot return to route-ready; an effect-capable member identity change or unproved runtime safety invalidates the complete Runtime Epoch under the existing failure rules.

Sandbox Integration MUST NOT launch a native Agent child until the NanoHost proves the accepted worker-entry marker, current fixed monitor, Gateway client, `ConnectSupervisor`, `ForwardTcp`/`RelayStream` pair, nested HTTP/2 handshake, exact route table, client-header rejection, injected Harness binding, and the exact first Harness poll `204`. A native child launches only after one admitted `turn.start` supplies the exact AgentSession-local Turn package and two route tokens. A disabled capability plane still exposes only the required fail-closed `/capabilities/*` namespace and does not become callable merely because the bridge is ready.

This entire sequence is subject to the mandatory realization gate owned by the Stock Realization Annex, including its evidence-quality requirements and its blocking failure disposition. The pinned release is the immutable official OpenShell [`v0.0.99`](https://github.com/NVIDIA/OpenShell/releases/tag/v0.0.99); the current `0.0.80` vendor snapshot and any development source snapshot are not target evidence.

## Sandbox-To-Gateway Communication Boundary

This section realizes the Sandbox Transport Requirement through the pinned stock mechanism.

For each active sandbox, the stock Supervisor MUST establish exactly one current OpenShell `RelayStream` after the matching NanoHost-side `ForwardTcp` causes the Gateway to issue `RelayOpen`. The paired streams MUST carry exactly one standard HTTP/2 session used by Sandbox Integration and the NanoHost service.

The nested HTTP/2 session exposes exactly these OpenKit route namespaces for the current target:

```text
/worker-control/*
/inference/*
/capabilities/*
```

The route namespaces are ordinary HTTP/2 requests and streams. OpenKit MUST NOT add a frame envelope, channel identifier, byte multiplexer, session protocol, arbitrary TCP proxy, or proprietary reconnect layer around them.

At the host-to-Sandbox security and adjudication isolation level, the stock OpenShell Gateway remains bound to loopback on the execution host. The Gateway, container-runtime sockets, Supervisor interfaces, and OpenShell credentials MUST NOT be directly reachable from NanoCore, public networks, or the Sandbox except through the exact stock mechanisms accepted by policy.

`RelayStream` is the only sandbox-to-Gateway transport path for these routes. Sandbox Integration MUST NOT authenticate to the Gateway, call `ForwardTcp`, receive Gateway credentials, open direct NanoCore worker-control, inference, or capability connections, or use an operator-managed forward or host-network exception as fallback.

The three route families retain the credential and semantic separation defined above, which supports conversation-context isolation and does not provide security and adjudication isolation from a compromised shared Harness. RelayStream failure is a transport failure; it does not itself prove Turn cancellation, worker termination, sandbox deletion, provider failure, capability failure, or successful cleanup.

This bridge projection realizes the Sandbox Transport Requirement and is accepted subject to the mandatory realization gate in the Stock Realization Annex. A failed or indeterminate proof blocks implementation and returns the design to that annex and its owning requirement.

## Runtime Epoch Topology And Supervision

The NanoHost service, stock Gateway, every effect-capable member of the configured container backend, every Runtime Epoch network helper, every mutable runtime root and network, and every hosted sandbox MUST belong to one OS-supervised failure group. Under the V1 Docker backend the backend members are the dedicated `dockerd`, its dedicated `containerd`, and their helpers and proxies; one fixed host-namespace `slirp4netns` process is the epoch network helper under the same fail-stop owner.

The supervisor MUST provide a fail-stop boundary that terminates the complete effect-capable group when the NanoHost service exits abnormally, is killed, is independently restarted, loses its configured identity, or cannot continue to prove group ownership.

Abnormal exit, identity change, or independent restart of the Gateway, any container-backend member, or another effect-capable member MUST invalidate the complete epoch. The supervisor MUST terminate all effect-capable siblings and MUST NOT restore readiness through member-local restart.

A service-manager restart of the NanoHost is a complete group stop followed by creation of a new Runtime Epoch. Restart policy MUST NOT allow the NanoHost service, Gateway, container runtime, or sandbox descendants to cross the epoch boundary.

Every process capable of completing a previously accepted create or delete MUST be in the terminated group. A process-local lock, resource delete, empty-list probe, stable delay, PID check, Gateway reconnect, or member-local restart is not an epoch fence.

The implementation may use the native OS supervisor and cgroup or equivalent primitives. This specification does not authorize an OpenKit supervisor framework when the platform already supplies the required fail-stop behavior.

### Epoch-Private Network Namespace

The V1 Docker backend's dedicated `containerd`, dedicated `dockerd`, and stock Gateway share exactly one fresh Linux network namespace owned by the current Runtime Epoch. Its namespace device and inode MUST differ from the NanoHost service's host namespace and from every still-observable prior-epoch namespace; no durable historical inode registry exists, and a kernel reuse after complete prior destruction is not identity adoption. The NanoHost parent and slirp helper remain in the host namespace so the NanoCore transport and the helper's outbound side retain their configured host routes; no container-backend member or Gateway process may share that namespace or mutate the system Docker daemon's links, routes, nftables tables, default bridge record, or container attachments.

Epoch creation starts `containerd` as a direct child in a new network namespace, opens one close-on-exec descriptor for that exact namespace, and proves the descriptor's device and inode before starting another member. One exact `/usr/bin/slirp4netns` artifact admitted by the execution-host manifest runs as a direct foreground member of the same service cgroup and configures only that retained namespace through an explicit inherited duplicate at fixed descriptor `4`, fixed `--netns-type=path`, and target `/proc/self/fd/4`; it MUST NOT resolve the namespace through a PID. Its remaining fixed behavior is `--configure`, `--disable-host-loopback`, `--disable-dns`, `--enable-sandbox`, `--enable-seccomp`, `--ready-fd=3`, and fixed `tap0`. The systemd service uses `PrivateMounts=yes` so the helper's sandbox mount operations cannot propagate to the host and makes `/run/docker.sock` inaccessible inside that service mount namespace so no epoch member can address the system Docker API. Readiness of this member is the bounded exact ready-fd signal plus the expected namespace inode, TAP interface, and default route; process existence is not readiness. Containerd exit before or during helper setup cannot redirect the inherited descriptor, and produces zero network effect outside the retained namespace before complete epoch invalidation.

Before creating the namespace or starting a member, NanoHost reads `/run/systemd/resolve/resolv.conf` exactly once for that epoch and extracts one through three unique plain IPv4 `nameserver` literals in file order. Each admitted resolver MUST be unicast and MUST NOT be unspecified, loopback, multicast, or limited broadcast; a duplicate is rejected rather than deduplicated. A missing file, zero or more than three resolvers, malformed nameserver line, duplicate, or disallowed address fails before effects. Search domains, options, host aliases, environment proxies, and alternate resolver files confer no authority. NanoHost passes the exact accepted set to the dedicated `dockerd` as repeated fixed DNS arguments while slirp DNS remains disabled, so Sandbox name resolution cannot fall back to the host loopback resolver or slirp's DNS proxy. A later source-file change does not mutate a live epoch and is adopted only by a fresh epoch.

The stock Gateway binds its fixed loopback endpoint inside that same epoch-private namespace. The NanoHost owns one fixed connector for the initial Gateway channel and every permitted physical reconnect: one short-lived thread enters the retained namespace descriptor, connects the fixed loopback endpoint, returns only the connected socket to the existing Tonic channel owner, and exits. The connector creates no proxy, listener, second logical channel, reconnect authority, or alternate endpoint. A reconnect uses the same live namespace and existing reconnect rules; it never creates a namespace, relaunches a member, or bypasses predecessor closure.

The namespace descriptor and slirp child are Runtime Epoch members. Resolver rejection, namespace identity mismatch, slirp readiness timeout, slirp exit, member namespace mismatch, missing private route, Gateway bind failure, or any partial start invalidates the complete epoch. Controlled teardown terminates and reaps slirp and every namespace member before releasing the retained descriptor. NanoHost `SIGKILL` closes its descriptor immediately; systemd then terminates every other holder in the service cgroup, and recovery must prove no holder or prior namespace remains before readiness. No member has an independent restart path, and every fresh service start creates and proves one fresh namespace.

Observable conformance requires `containerd`, `dockerd`, and Gateway to report the same non-host namespace inode while the NanoHost and slirp report the host inode, plus the fixed slirp artifact and ready-fd proof, private loopback Gateway health, an empty backend, and policy-governed public Git DNS and HTTPS egress. A namespace probe MUST NOT reach the host NanoCore listener or a host-loopback sentinel, no epoch member may open the system Docker API path, and a Sandbox MUST NOT reach or authenticate to the Gateway except through the exact stock Supervisor and relay mechanisms. Before and after normal stop, member failure, and NanoHost `SIGKILL`, the system Docker default bridge database record, kernel `docker0` identity/address/state, canonical Docker-owned nftables structure, running business-container identities and network attachments, and a bounded system-Docker build-network smoke MUST remain unchanged; the epoch namespace and its links MUST disappear after teardown. The nftables comparison includes family, table, chain type, hook, priority, policy, rule expressions, comments, sets, and maps while excluding dynamic packet and byte counters, object handles, and formatting.

## Lifecycle

### Configuration And Installation

The deployment configures one non-secret NanoHost identity reference, one deployment identity, one NanoCore rendezvous endpoint, two NanoHost Token slots with separate non-secret secret-file and companion-file references, an optional non-secret TLS CA reference, one container-backend selection, one NanoHost Image Store location, one evidence location, and the required deployment image digest set. The V1 anonymous public acquisition registry set is the fixed runtime constant `{docker.io, ghcr.io}` and has no configuration input. The execution target requires the NanoHost service, stock OpenShell Gateway, pinned container-runtime components, Sandbox Integration image content, OS-supervision unit, and exact host-manifest-owned `/usr/bin/slirp4netns` artifact. The operator installs that OS package before repository host provisioning; `host:provision` never installs or upgrades it, and `host:assert` accepts only its exact path, version, and SHA-256.

The NanoHost execution-host projection has exactly one source, the existing `/etc/openkit/nanohost.env` service environment file, and exactly these session inputs: required non-empty `OPENKIT_NANOHOST_IDENTITY_ID`, required non-empty `OPENKIT_NANOHOST_DEPLOYMENT_ID`, required `OPENKIT_NANOHOST_NANOCORE_RENDEZVOUS_URL`, required absolute and pairwise-distinct `OPENKIT_NANOHOST_TOKEN_SLOT_A_SECRET_FILE`, `OPENKIT_NANOHOST_TOKEN_SLOT_A_COMPANION_FILE`, `OPENKIT_NANOHOST_TOKEN_SLOT_B_SECRET_FILE`, and `OPENKIT_NANOHOST_TOKEN_SLOT_B_COMPANION_FILE`, plus optional absolute `OPENKIT_NANOHOST_NANOCORE_CA_FILE`. The rendezvous value is one exact HTTP or HTTPS origin: plaintext HTTP is valid only for exact same-host loopback, while every other origin requires HTTPS and server-authenticated TLS. Absence of the CA input selects platform roots; presence selects only that CA with no platform-root fallback after validation failure.

The raw `okt_` Token exists only in the two mode-`0600` secret files and MUST NOT appear in `/etc/openkit/nanohost.env`. The eight session inputs and the existing required `OPENKIT_NANOHOST_REQUIRED_IMAGE_DIGESTS` input are parsed and validated before evidence, recovery, Image Store, Runtime Epoch, backend, Gateway, or network-session effects. A missing or empty required input, a non-absolute or duplicate slot reference, an invalid origin, non-loopback plaintext, or an invalid configured CA fails closed and starts no epoch. NanoHost MUST NOT read these inputs from an alternate source, apply a default or compatibility alias, hard-code a value, or add endpoint or trust fallback.

The explicit server-admin-authorized enrollment ceremony above MUST complete identity creation, first Token issuance, and proved safe-sink delivery before the NanoHost may start. Configuration, installer state, and service units MUST NOT contain the raw NanoHost Token or its hash.

Configuration MUST NOT include a Cell owner, Cell epoch, Cell helper, NanoCore-to-SSH lifecycle target, NanoCore-to-Gateway URL, operator-managed Gateway forward, direct sandbox-to-NanoCore endpoint, custom OpenShell binary, or TLS-verification bypass.

SSH MAY be available for installation-time stdin delivery to the named secret sink, diagnostics, evidence collection, or human-authorized break-glass response. Except for the pinned opaque Gateway-internal relay permitted solely beneath the fixed single-file `ExecSandboxInteractive` use, SSH MUST NOT prepare, create, delete, recycle, forward, claim, launch, control, transfer, settle, reauthorize, rotate, or recover normal execution and MUST NOT be visible, configured, caller-selected, or required for NanoCore-to-NanoHost or sandbox-to-Gateway communication.

### Epoch Creation

On first start or recovery, the supervisor establishes a new group and the NanoHost creates fresh private roots, sockets, networks, namespace state, authentication material, container-runtime state, and Gateway state for one new epoch.

The NanoHost validates the configured identity, pinned stock component identities, required image identities, Supervisor ownership, private root ownership, loopback-only Gateway binding, host-to-Sandbox security and adjudication isolation at the container-runtime boundary, and absence of stale effect-capable processes before it starts accepting work.

An epoch creation failure keeps the NanoHost non-ready, exports one `epoch-creation-failure` Epoch Invalidation Report, terminates the partial group, and retries only through a fresh epoch creation attempt. It MUST NOT adopt the partial epoch or release capacity based on a partial cleanup claim.

### Epoch Update

The current epoch's NanoHost identity, component identities, configured container backend, mutable roots, sockets, networks, namespaces, supervision membership, and epoch-local authentication generation are immutable. An accepted configuration, binary, backend-selection, required-deployment-image-set, epoch-local credential generation, topology, or effect-capable membership change replaces the epoch through full invalidation and fresh creation rather than mutating those properties in place.

NanoHost Token slot contents are explicitly outside epoch identity: installing, rotating, aborting, or clearing a slot MUST NOT invalidate a healthy epoch.

Ordinary Sandbox create, proved Sandbox delete, admitted Harness create and delete within an existing Sandbox, and mid-epoch attempt-image import are the only mutable epoch-membership operations inside a healthy epoch. AgentSession open and close mutate Harness occupancy without changing epoch or Sandbox identity, and the scheduling owner may admit bounded concurrent Turns across distinct AgentSessions while preserving one active Turn per AgentSession and Thread.

### Readiness

The NanoHost may report `ready` only after all of the following are proved for the same current epoch:

- The configured NanoHost identity and authoritative NanoCore transport session are current.
- The configured `nanohost-transport` Token is active, both declared execution-host slots and their companion metadata are readable only by the NanoHost service account, exactly one slot holds usable material, and the presented NanoCore TLS trust is valid for the selected endpoint.
- The installed `apps/nanohost` Rust binary, its compiled OpenShell client or generated protobuf provenance, and the stock Gateway executable resolve to the accepted build and exact `v0.0.99` release boundary.
- The NanoHost service, stock Gateway, configured container backend, and required helpers are inside the one supervised failure group.
- The configured backend and Gateway share the one fresh non-host network namespace, the retained namespace identity and slirp ready-fd proof are current, the exact fixed resolvers are installed in the private backend, and the system Docker and host-network projections remain unchanged.
- The configured container backend is exactly the one the deployment declares, its effect domain is host-local, and no unconfigured backend has been started.
- The stock Gateway and backend processes are foreground members of that group, none has daemonized or escaped it, and the NanoHost has observed no member-local restart.
- The Gateway, container backend, roots, sockets, networks, namespaces, and authentication state belong to the new epoch.
- The stock Gateway is healthy and loopback-only.
- The configured container backend reports no containers or stale sandbox state.
- Every image digest required by the current deployment was imported into the fresh backend from the NanoHost Image Store and re-verified after import, with no readiness-time registry retrieval or build.
- The NanoHost Image Store is readable only by the NanoHost service account, is not mounted into the epoch, and exposes no listener.
- Stock OpenShell reports no sandboxes against the new Gateway.
- No old process, cgroup, network, root, socket, credential, or accepted operation can mutate the new epoch.
- `EpochCoordinator::start` proved the current epoch's one slot fresh and unoccupied before any effect. A healthy transport reconnect reuses that same still-live epoch proof, while the RuntimeTarget owner independently preserves an occupied or cleanup-held slot and does not release it merely because the successor reports readiness.

A point-in-time empty list is necessary but insufficient. Readiness requires prior-epoch fencing plus fresh ownership and absence-of-prior-state proof.

If the NanoCore transport is unavailable after local fresh-empty proof, the NanoHost remains locally healthy but does not advertise capacity or accept new work until one authoritative session is established and the fixed readiness request receives its durable empty `204`. The initial order is successful `EpochCoordinator::start`, physical admission, readiness acknowledgement, then the first effect poll. Every healthy successor repeats admission and readiness before restoring effect carriage, without rebuilding or relaunching the still-live epoch.

### Admission And Sandbox Create

NanoCore persists admission and exact lease authority through the existing scheduler before the NanoHost receives work. The NanoHost accepts only the exact authorized package, identity, lineage, capability requirements, route bindings, and deadline.

Receipt of one bounded `200` body on a fixed effect command path is the only transport admission for that local operation. NanoHost validates its operation-specific identity and bounds, calls the existing local owner directly, preserves that owner's cancellation and definite-result rules, and returns only the correlated operation-specific result. A `204` response admits nothing, and polling creates no local command queue or authority cache.

For a request with no compatible ready Sandbox and declared Harness set, the NanoHost performs stock OpenShell Provider setup, Sandbox creation, static materialization, Sandbox Integration launch with the bounded Harness descriptors, bridge establishment, and the exact first private Harness poll before settling `bridge.open`. For a later compatible AgentSession, NanoCore grants open-session capacity and delivers the fixed `session.open` operation with the exact selected `harnessInstanceId` through the existing Integration pull path; no Sandbox, bridge, Integration, Harness, or transport authority is recreated. NanoCore has no direct OpenShell, Gateway, container-runtime, filesystem, process, or Sandbox handle.

Once the local runtime accepts a create, the NanoHost waits until that operation reaches a definite success or definite failure even if NanoCore disconnects. Loss of the NanoCore transport MUST NOT cancel, abandon, or time-bound the local OpenShell operation merely to restore control-plane availability.

If definite create failure proves that no sandbox or pending effect remains, the NanoHost reports the failure through the existing lease and worker owners and may remain in the same epoch. If the create outcome or absence of a late effect cannot be proved, the entire epoch is invalid.

### Running AgentSession

A running shared Sandbox uses Sandbox Integration and the one current `ForwardTcp`/`RelayStream` HTTP/2 bridge for every resident AgentSession. AgentSession and Turn lineage demultiplexes semantic streams inside the standard HTTP/2 session; transport sharing creates no shared credential, sequence, authority, or outcome. The NanoHost maintains already-authorized local execution while NanoCore is temporarily unavailable, and it holds only the bounded produced-fact buffer defined below.

Each resident AgentSession has one private adapter state root and restricted native conversation handle. One admitted Turn may start a new native Agent process for its AgentSession; the first Turn establishes that handle when the adapter requires a prompt to create it, and a later Turn may start another process instance only by resuming the exact retained handle. A sibling AgentSession uses a different root, handle, process, package slots, route credentials, and cleanup proof. Distinct AgentSessions may execute concurrently only through separate scheduler leases and within the selected Harness and Sandbox bounds; native process multiplicity never creates capacity or Turn authority.

The fixed unary `ExecSandbox` response monitor is an epoch-local attempt member for the full Sandbox Integration lifetime. Ordinary Turn interrupt remains exact worker-control; closing or cancelling the monitor, the bridge, or either H2 connection is not a kill operation and cannot prove AgentSession-local child, Harness, Integration, or process-group absence.

What survives a NanoCore outage is precisely stated by the two separate guarantees owned by `docs/specs/20260703-worker_control_protocol.md`: the worker's process, lease, sequence, and local runtime state survive an outage shorter than the bounded control-plane budget, while inference availability during the outage is zero because inference is routed through NanoCore. This specification MUST NOT be read, summarized, or projected as making a running agent continue to make progress during a NanoCore outage. It makes the runtime survive one, which is a smaller and different claim.

NanoCore transport loss does not authorize new work, broaden deadlines, change permissions, retry provider effects, or infer completion. The NanoHost MUST NOT open a direct provider path, substitute a provider, or serve an inference response from local state to restore progress; an unattributed provider effect is worse than a stalled worker. The NanoHost and worker continue only the already-authorized execution under their existing lease and route contracts.

### Produced-Fact Buffer

The NanoHost MAY hold facts it has already collected but not yet delivered, so that a short NanoCore outage does not consume the worker's own outage budget while the NanoHost waits. This is the only load the NanoHost is permitted to absorb on NanoCore's behalf, and it is bounded because an unbounded buffer becomes a durable journal by accident.

| Bound | V1 value |
| --- | --- |
| Total buffered produced facts per active sandbox | at most 8 MiB |
| Maximum buffer age | at most the bounded worker-control outage budget owned by its protocol owner |

Reaching either bound is a truthful failure through the owning record's contract, never a silent drop, never a summarized substitute, and never a reordering. The buffer holds only facts the NanoHost or the worker produced; it is disposable epoch-local state, it does not survive its epoch, it is not authority, it is not durable history, and no recovery, readiness, or capacity decision may read it.

The NanoHost MUST NOT cache authority it received. A cached Agent Environment Package, policy decision, capability grant, permission decision, or lease state would turn every stale read into a decision made on old truth. The AEP is already the correct instrument for acting without asking again: an immutable resolved authorization bounded by a lease deadline. It is a grant, not a cache, and it MUST NOT acquire invalidation, refresh, revalidation, or fallback semantics.

The NanoHost MUST NOT cache inference responses, capability results, or provider outputs, because usage attribution, metering, and audit for those effects are NanoCore-owned and a locally served response is an unattributed effect.

### Normal AgentSession End

When an AgentSession reaches its existing terminal and output barriers, Sandbox Integration invokes the fixed `session.close` operation, revokes that AgentSession's route bindings and native conversation handle, removes its private mutable slots after required collection, and releases open-session capacity only after exact local cleanup proof. A proved ordinary close leaves the shared Harness, bridge, Sandbox, and compatible sibling AgentSessions running.

The Turn export barrier requires NanoCore to accept the exact `final_status` and the selected Harness to prove the exact AgentSession-local execution absent or quiescent with no further output writer. The Sandbox-wide retained bootstrap monitor remains an Integration-lifetime proof and is not required to exit for one local AgentSession or Harness close. A nonzero AgentSession-local exit without proved local absence, response loss, child survival, relay loss, member loss, or ambiguous cleanup blocks that Turn's export and drains the affected Harness; if the Harness or Integration cannot prove the remaining effect domain safe, cleanup widens to Sandbox deletion and then epoch invalidation when deletion is not definite.

An exact local close never sends `bridge.close`, `sandbox.delete`, or `attempt-session.cleanup`. AgentSession-close uncertainty stops new admission and widens to the Harness, Sandbox, or Runtime Epoch boundary whose complete effect domain can be fenced; it does not release open-session capacity, substitute a sibling outcome, or fabricate aggregate cleanup success.

### Normal Sandbox Drain And End

Sandbox termination begins by issuing `harness.drain` for every declared Harness, refuses new AgentSessions and Turns across the Integration, lets admitted non-security-sensitive work settle or truthfully interrupts it through existing owners, closes every resident AgentSession, revokes every route, collects required output and evidence, and proves every Harness plus the Integration process group absent. Only then does the backend cleanup owner request `bridge.close` and `sandbox.delete` with separately derived request identities and operation-specific results.

The NanoHost does not recreate the Gateway, configured container backend, or Runtime Epoch after a proved ordinary Sandbox deletion, and it does not re-import image content the current epoch already holds. Normal deletion waits for a definite result even if NanoCore disconnects. A successful response is accepted only when the NanoHost proves the Sandbox and every accepted deletion effect reached the required absent state; uncertainty invalidates the epoch.

### Off-Peak Freshness Rebuild

Off-peak rebuild is a bounded freshness and latency optimization, not security and adjudication isolation, correctness, availability, credential-revocation proof, containment proof, or recovery. It remains disabled until measured residency traces establish fixed Sandbox-idleness and age thresholds.

When both thresholds are met and no resident AgentSession holds an active Turn, NanoCore MAY request the ordinary drain and close path, discard disposable Sandbox-local state, create and initialize a replacement from the current desired setup and materialization owners, prove it ready, and make it warm. An arriving request during rebuild starts or selects another freshly admitted compatible Sandbox instead of waiting for or reusing the retiring Sandbox. The mechanism never interrupts work; if any active Turn exists, rebuild is not admitted.

Failure to drain, close, initialize, materialize, or prove readiness leaves the old or partial Sandbox non-admitting and follows the ordinary cleanup boundary. The Workspace loses only warm latency: later work uses another fresh Sandbox or receives the existing typed unavailable or cleanup-required outcome. Rebuild MUST NOT replace the per-Turn freshness barrier, authorize a stale baseline, preserve disposable local material, justify snapshot or restore, widen warm-pool scope, or become required for correctness or recovery.

Observable conformance requires the fixed idleness-plus-age trigger, zero active Turns at drain, ordinary current-generation initialization, independent servicing of an arriving request, and zero advertised capacity when rebuild fails.

### Uncertain Create Or Delete

Any accepted sandbox create or delete whose completion cannot be proved invalidates the complete Runtime Epoch.

The NanoHost immediately stops new admission, marks the slot unavailable, exports the Epoch Invalidation Report defined below, and then asks the supervisor to terminate the complete effect-capable group. Evidence export is ordered before termination and is itself bounded: an export that cannot complete within its bound is truncated and marked incomplete rather than delaying the fence. Every AgentSession hosted by that epoch is interrupted or failed through its existing owner, and no individual sandbox cleanup or point-in-time empty probe may restore the epoch.

Capacity remains fenced until the old effect domain is impossible and a new epoch passes the full readiness contract. The original create or delete is not replayed into the new epoch; any later attempt requires fresh existing authority.

### NanoHost Or Member Failure

NanoHost service crash, SIGKILL, abnormal identity loss, or an effect-capable member failure invalidates the epoch and triggers fail-stop termination of the entire group.

These are two evidence classes, not one. An effect-capable member exit, identity change, or member-local restart that a live NanoHost observes is NanoHost-initiated: the NanoHost classifies it, exports one Epoch Invalidation Report, and then exits. NanoHost service crash, `SIGKILL`, and abnormal identity loss are NanoHost-absent: no report is possible, and the next recovery records the prior-epoch disposition note instead.

All AgentSessions in the epoch share this infrastructure failure domain and are interrupted or failed independently through their existing records. Their identities, sequences, outputs, and terminal meanings remain separate.

No member-local recovery, Gateway reconnect, container-runtime restart, sandbox adoption, or surviving-child adoption may restore the invalid epoch. Recovery always creates a new epoch.

### NanoCore Restart Or Short Outage

NanoCore restart, upgrade, or bounded network outage does not invalidate a healthy Runtime Epoch and does not recreate a sandbox.

The NanoHost Token remains in its execution-host sink outside the mutable Runtime Epoch, so a healthy NanoHost may reconnect after NanoCore restart without copying credential material into fresh epoch roots. Restart does not reactivate an expired, rotated, or revoked Token and does not relax certificate validation.

The NanoHost and already-authorized worker continue locally. When NanoCore returns, the NanoHost opens one new physical HTTP/2 connection; the transport-session authority retains and fences the failed predecessor as its durable high-water generation, transactionally allocates the next generation, returns it in the successful admission response, and binds it before reconnecting the same lease, AgentSession, backend session, package lineage, process key, and exact next worker sequence.

NanoCore MUST NOT duplicate sandbox creation, worker launch, output publication, inference or capability effects, or capacity claims during reconnect. If exact continuity cannot be proved, the existing continuity and reliability owners preserve `interrupted`, `unknown`, or cleanup-required evidence; they do not infer replacement or completion.

### Execution Server Restart Or Loss

Execution-server restart invalidates every Runtime Epoch that ran on that host and makes the NanoHost non-ready. NanoCore marks affected AgentSessions `interrupted` or `unknown` according to the existing evidence and MUST NOT infer cancellation, completion, rollback, or successful cleanup.

After restart, the NanoHost MUST NOT advertise ready while any old runtime effect could survive or while old roots, networks, processes, sockets, authentication state, or sandbox inventory remain unclassified. It creates a fresh epoch only after the prior effect domain is fenced or proved impossible by the trusted host boundary. A restart does not replace the NanoHost deployment.

Permanent server loss makes the configured NanoHost unavailable and has no automatic recovery or migration contract. Only that explicit permanent-loss case permits a replacement server, which is a newly configured NanoHost deployment whose new work uses fresh existing authority.

### Runtime Epoch Recovery

Recovery first terminates, fences, or discards the old epoch. It then creates fresh roots, authentication, networks, namespaces, container-runtime state, and Gateway state under a new supervised group.

During Runtime Epoch recovery, the NanoHost remains non-ready until it proves the Gateway and configured container backend healthy and empty, stock OpenShell sandbox inventory empty, every required deployment image digest imported from the NanoHost Image Store and re-verified, and all old effect-capable identities absent. When the prior invalidation was NanoHost-absent, recovery also records the prior-epoch disposition note defined below.

Recovery does not reconstruct an in-flight local OpenShell operation from a durable NanoHost journal. Because V1 has no such journal, any operation whose result did not become definite before NanoHost death makes the old epoch invalid and remains interrupted or unknown through existing owners.

The Epoch Invalidation Report is not that journal and MUST NOT be used as one. It is read-only forensic evidence for humans and audits; recovery MUST NOT read it to resume, adopt, settle, replay, or classify an operation's external effect, and no readiness or capacity decision may depend on its contents.

### Decommission

NanoHost decommission fences the authoritative connection, revokes every Token owned by the configured NanoHost identity, stops new admission, terminates or completes existing work only under the existing operator-approved lifecycle, invalidates the current epoch, and removes the complete supervised group before the target is considered absent.

The explicit operator or uninstall path removes raw NanoHost Token material from the execution-host sink after the service group is stopped. NanoCore retains redacted identity, Token status and lineage, responsible-admin attribution, and audit history; it disables rather than hard-deletes an identity or Token record while durable references require it.

Decommission is terminal for every credential, connection, and Runtime Epoch owned by that installation, but it does not forbid a later explicit reinstall of the same configured NanoHost. Such a reinstall uses the enrollment ceremony above to reactivate only the exact retained identity/deployment pair and issue a fresh first Token after a newly proved safe-sink write. It does not restore an old Token, connection generation, Runtime Epoch, Sandbox, Harness, AgentSession, capacity claim, or cleanup result, and it acquires no work authority until the ordinary fresh connection, predecessor fence, readiness, and fresh-empty gates pass again.

The explicit operator or uninstall path also removes the NanoHost Image Store content and index, and removes or archives the retained Epoch Invalidation Reports and prior-epoch disposition notes, because both are durable execution-host content that outlives every epoch. Anything in them required after decommission must first be imported into an existing durable owner.

Deleting configuration, losing a connection, revoking only one of several NanoHost Tokens, or stopping only the NanoHost service is not decommission proof. The Gateway, the container backend, sandboxes, mutable roots, networks, sockets, both raw credential slots and their companion metadata, every NanoHost Token, the NanoHost Image Store, and the retained evidence location must be gone, revoked, removed, or rendered incapable of effect.

## Epoch Invalidation Report

The name is deliberate. `docs/specs/20260703-audit_usage_evidence_records.md` already owns a durable product record named `EvidenceBundle`, and this artifact is its opposite in every respect that matters: NanoHost-private, non-product, non-durable-authority, and prohibited from informing any decision. It MUST NOT be named or implemented as an evidence bundle, and a redacted reference to it MUST NOT be confused with that owner's record.

Every epoch invalidation destroys the state that would explain why it happened. A design whose primary failure response is complete termination therefore needs an explicit forensic contract, or its most important failures become undiagnosable in exactly the deployments that need diagnosis.

Invalidation has two classes, and only one of them can produce a report.

**NanoHost-initiated invalidation.** The NanoHost service is alive and decides to invalidate. The complete trigger vocabulary is `uncertain-create`, `uncertain-delete`, `member-exit`, `member-identity-change`, `member-local-restart`, `containment-loss`, `epoch-creation-failure`, and `operator-action`. Every rule elsewhere in this specification that invalidates a healthy epoch while the NanoHost is alive MUST classify its cause with exactly one of these values. In this class the NanoHost MUST export one bounded Epoch Invalidation Report to a durable append-only evidence location outside every Runtime Epoch, owned by the NanoHost service account, before it asks the supervisor to terminate the group and before it exits.

**NanoHost-absent invalidation.** The NanoHost service is already gone or cannot act. The complete trigger vocabulary is `nanohost-crash`, `nanohost-killed`, `nanohost-identity-loss`, `execution-server-restart`, and `host-loss`. `nanohost-identity-loss` is the NanoHost losing its own configured identity, which is distinct from the NanoHost-initiated `member-identity-change` of another effect-capable member. No report is possible and none is required, because nothing survives to write one. Instead, the next epoch's recovery MUST record one bounded **prior-epoch disposition note** in the same evidence location from observable host state alone: the prior epoch identity and generation if recoverable, the classification `nanohost-absent`, the observed residual processes, roots, networks, sockets, and sandbox inventory, and the fencing outcome. The note is subject to the same bounds, redaction, retention, and prohibitions as a report.

An implementation MUST NOT delay, weaken, or skip the fence to obtain a report, and MUST NOT synthesize a report for a NanoHost-absent invalidation from inference.

The report contains only non-secret evidence:

- Epoch identity and generation, creation and invalidation timestamps, and the configured NanoHost identity id.
- The invalidation trigger, using exactly one value from the trigger vocabulary defined above.
- For an uncertain operation: the operation kind, the sandbox and attempt lineage identifiers, the exact point at which certainty was lost, and the elapsed time — never request or response payloads, never worker content, never prompts.
- The effect-capable member inventory with process identifiers, resolved binary identities and versions, cgroup membership, and exit status or signal for each member.
- The configured container backend identity and version, and the image digests imported into the epoch.
- The readiness proof results for the epoch, including which proof last succeeded.
- The current connection generation, the fencing outcome, and the bridge state per active sandbox.
- A bounded redacted tail of each effect-capable member's diagnostic output.

The report MUST NOT contain a raw or hashed NanoHost Token, sink contents, Gateway or backend authentication material, provider or Vault material, TLS private material, worker prompt or transcript content, Workspace or Artifact bytes, or any recoverable credential fragment. Existing secret-scanner and redaction behavior applies to the report exactly as it applies to logs.

The report is bounded and self-pruning: at most 8 MiB per report, at most 2 seconds of export time, and at most the 20 most recent reports or notes are retained, after which the oldest is removed. Export is best-effort in completeness but mandatory in ordering for a NanoHost-initiated invalidation; an export that reaches either bound is truncated, marked incomplete, and never delays the fence beyond its time bound.

Audit receives only a redacted reference to the report through the existing audit owner. The report itself is NanoHost-private execution evidence: it is not a product record, not a Core protocol field, not a scheduling input, and not user-visible. Anything required to outlive NanoHost decommission must first be imported into an existing durable owner.

## Epoch Rebuild Cost Budget

The shared-epoch decision buys one thing: Gateway and container-backend cold start moves from every AgentSession to epoch recovery. That benefit is a function of two numbers this specification MUST keep measurable, because if either is bad enough the decision inverts — a shared epoch would then pay a larger cold start than the per-AgentSession design it replaced while also widening the failure domain.

The two numbers are the epoch rebuild time and the rate at which accepted operations end uncertain.

| Budget | V1 target | Hard bound |
| --- | --- | --- |
| Fence proved to readiness advertised, total, with all required digests already in the NanoHost Image Store | at most 90 s | at most 300 s |
| Required deployment image set size | at most 4 digests | at most 4 digests |
| Image import per required digest from the store into the fresh backend, inside the total above | at most 15 s | at most 45 s |
| Fresh roots, backend start, Gateway health, and all remaining readiness proofs, inside the total above | at most 30 s | at most 120 s |
| Registry retrieval into the store, off the readiness path | not budgeted for readiness | at most 15 min per image, then fail the attempt |
| Authorized build into the store, off the readiness path | not budgeted for readiness | at most 30 min, at most 20 GiB OCI output, and at most 128 manifest layers, then fail the build |

Readiness MUST NOT be advertised early to satisfy a budget. Exceeding the hard rebuild bound is a NanoHost defect and keeps the NanoHost non-ready; it never converts into a weaker readiness proof.

### Falsifiable Premise

The premise under test is that epoch rebuild is rare enough and cheap enough for a shared epoch to be the better trade. It is falsified if, measured over at least 200 completed AgentSessions on the declared topology, either the uncertain-outcome rate exceeds one per hundred completed AgentSessions or the observed rebuild time exceeds the hard bound.

Sustained violation reopens the epoch-granularity decision in this specification rather than being absorbed as an operational limitation. The available responses are a smaller causal fence once pinned stock OpenShell exposes a proved operation identity and teardown contract, or multiple independently configured NanoHosts under the accepted scale owner — never a silent return to per-AgentSession runtimes and never a grace-based cleanup claim.

Bounded private runtime evidence dies with the epoch, and epoch invalidation is exactly the event being counted, so the premise cannot be measured from epoch-local state alone. Durable accumulation therefore requires the existing audit owners to record two boundaries: epoch invalidation and fence-to-ready completion, each carrying only the classification, the elapsed time, and non-secret lineage.

Producer obligations and record shape at those boundaries are owned by `docs/core/audit.md` and `docs/specs/20260703-audit_usage_evidence_records.md`, and both owners have accepted them: the Core audit model lists execution-substrate epoch invalidation and capacity-restoring readiness as producer boundaries, and the record specification carries them as `AuditEvent` records at diagnostics-only visibility with no new record family. This specification MUST NOT restate their fields, visibility, or retention.

Those audit boundaries plus completed-AgentSession counts from existing owners are the complete measurement substrate. This premise creates no durable NanoHost record, no product metric surface, and no scheduling input.

## Failure Matrix

| Failure | Required handling |
| --- | --- |
| NanoCore restart, upgrade, or short network outage | NanoHost and Agent continue running; the failed physical connection generation remains the fenced durable high-water value, and the transport-session authority transactionally allocates and returns its successor for one new physical HTTP/2 connection before transfer resumes from the exact durable lineage and sequence. |
| Outer connection closes after one local effect is accepted | The local owner continues to a definite result; NanoHost buffers only the bounded correlated result, submits that same `requestId` only on an authoritative successor, and never re-executes the command. NanoCore rejects it without mutation unless existing durable lineage proves the exact pending transition, otherwise retaining `interrupted`, `unknown`, or cleanup-required truth. |
| An ordinary local effect reaches a definite failed result with no unclassified effect | NanoHost submits only the exact two-member `requestId` plus `failureCode=effect_failed` result. NanoCore matches and rejects the existing pending effect exactly once, returns empty `204`, and the same physical session and healthy epoch continue only where the operation-specific owner permits it. |
| An outer-session response has an unexpected HTTP status or a fixed command, identity, generation, operation, or result is definitively invalid | The physical attempt is terminal, the rejected result is not replayed, and `main` prints exactly one bounded value-free disposition, stage, fixed operation or `none`, and three-digit status or `none` diagnostic before nonzero exit. Only physical close or eligible definite-result delivery uncertainty enters the silent successor loop. |
| One AgentSession ends with exact local cleanup proof | The Harness closes only that native conversation, removes its AgentSession-local state, releases open-session capacity, and preserves compatible siblings and the shared Sandbox. |
| AgentSession cleanup result is uncertain | New Harness admission stops and cleanup widens to the Harness, Sandbox, or complete Runtime Epoch boundary whose effect domain can be fenced; no capacity returns early. |
| An off-peak rebuild fails | The old or partial Sandbox remains non-admitting, ordinary cleanup runs, and later work uses another fresh Sandbox or receives the existing typed unavailable or cleanup-required outcome; no freshness, security, or capacity claim is inferred. |
| NanoHost service crashes | The OS supervisor kills the Gateway, every container-backend member, all Sandboxes, and every effect-capable descendant; all hosted AgentSessions are interrupted. |
| Execution Server restarts | Every Runtime Epoch on that host is invalid, the NanoHost remains non-ready, and NanoCore marks affected AgentSessions `interrupted` or `unknown` through existing owners. |
| Execution Server is permanently lost | The configured NanoHost is unavailable; replacement requires a newly configured NanoHost deployment and fresh existing authority. |
| Runtime Epoch recovers | The NanoHost first cleans or fences the old epoch, creates a fresh runtime, proves it ready and empty, and only then accepts new work. |
| Both NanoHost Token slots are missing, unreadable, wrong-owner, ambiguous, or unproved | The NanoHost remains non-ready without looping; NanoCore exposes no secret and enrollment or issuance requires a new explicit server-admin action. |
| NanoHost Token expires or is revoked | NanoCore immediately denies authentication, fences the current NanoHost session, stops admission, and requires explicit server-admin issuance for reconnection. |
| Rotation successor fails to install or connect | The predecessor remains the sole authority only until its declared overlap deadline; an administrator explicitly aborts or retries, and expiry fails closed. |
| NanoCore TLS certificate or configured trust is invalid | No authoritative session is established, the NanoHost remains non-ready, and no downgrade, bypass, SSH tunnel, or alternate endpoint is attempted. |
| Fixed readiness request is malformed, synthetic, stale, future, candidate, fenced, on the wrong connection, rejected, or receives a nonempty or non-`204` response | No readiness projection, generation advance, scheduler work, or effect poll occurs. The exact physical attempt is terminal and is not retried or relabeled as transport uncertainty. A cancellation or loss caused by observed physical close instead uses the closed reconnect disposition and requires a strictly increasing admitted successor plus that successor's own successful readiness request; this does not override the terminal first-poll response window below. |
| An authoritative successor has no eligible retained result, starts its first effect poll, and is cancelled, reset, times out, or loses the physical connection before receiving the complete response | NanoHost classifies the exact poll-stage failure as terminal, fail-stops the coordinator and complete Runtime Epoch, and never reconnects that coordinator; NanoCore preserves the once-committed unknown, cleanup owner, and capacity fence until a later fresh coordinator proves readiness. |
| NanoHost-to-Gateway client channel is lost | New admission and affected route readiness stop; the NanoHost reconnects only to the same proved Gateway and epoch and restores no sandbox bridge until predecessor closure and exact identity are proved. |
| `ForwardTcp`, `RelayStream`, Supervisor session, or nested sandbox HTTP/2 fails | The affected sandbox bridge becomes non-ready; the bridge layer replays nothing, and a successor is admitted only after predecessor fencing and exact Sandbox, Harness binding, and static route-lineage proof. |
| Private Harness poll or result delivery is interrupted | Integration retries only the same immutable request inside the existing route-outage budget. A successor bridge may carry a retained exact result only for the same current Harness binding; a dispatched command is never redelivered, and missing delivery or result proof widens to `unknown`, stops admission, and invokes the existing cleanup fence. |
| A private Harness request supplies Authorization or a Harness-binding header, arrives on another connection, or names stale or sibling state | NanoHost or NanoCore rejects it before a Harness effect. There is no credential fallback, header override, direct route, operation replay, or alternate binding search. |
| `bridge.open` delivery becomes uncertain before complete local acceptance | NanoCore does not re-poll or replay the command, NanoHost infers neither Harness bootstrap nor readiness, no AgentSession or Turn is admitted, and the attempt proceeds to exact Sandbox deletion or complete epoch invalidation when deletion is uncertain. |
| Outer connection closes after `bridge.open` local acceptance | NanoHost retains the same live Harness monitor and bridge, completes to one settled redacted result, and submits only that identical result on an authoritative successor; reconnect performs zero Start, Sandbox-create, Harness-launch, or already-current bridge-open calls. |
| AgentSession-local termination or Harness-lifetime monitor proof is unproved | Closing or cancelling transport is not termination; absent accepted `final_status` or unproved local quiescence blocks the affected Turn's export and drains the Harness, while missing or duplicate Harness Exit, unclean monitor completion, group survival, relay loss, or member loss requires exact Sandbox deletion, with epoch invalidation when deletion is uncertain. |
| A Turn's canonical AEP or Context Package body, lineage, slot, path, digest, length, or admission is missing or invalid | `turn.start` does not begin; adjacent AgentSession, Turn, identity, path, destination, export, or mutable bytes have no fallback. Accepted uncertainty drains the Harness and follows exact local cleanup, Sandbox delete, and epoch invalidation as proof requires. |
| Fixed `image.build/input` request or response is malformed, mismatched, oversized, incomplete, non-UTF-8, reset, cancelled, timed out, or interrupted | Before complete verification, remove partial input and start no build root or backend effect; return exact `409`, `413`, or redacted `500` when an HTTP response remains possible, otherwise retain only the definite correlated `effect_failed` result for a successor. Never refetch, resume, replay, or disclose the Dockerfile. After complete verification and build admission, finish the one local build and carry only its unchanged result on a successor. |
| `ExecSandboxInteractive` file effect fails or becomes uncertain after admission | No worker launches from an uncertain import and no uncertain export result is admitted; reachable partial staging is removed, exact sandbox deletion is required, and an uncertain delete invalidates the complete epoch. An already-complete verified export result may be delivered with the identical tuple on an authoritative successor without rerunning the sandbox effect. |
| Fixed outer file-data body is malformed, oversized, incomplete, mismatched, reset, cancelled, timed out, or interrupted by connection close | Apply the exact `400`, `413`, `409`, or bounded redacted `500` contract owned by the data-boundary specification when an HTTP response remains possible; otherwise fail or preserve `unknown` with no JSON fallback, partial admission, or inferred completion. |
| Bridge re-establishment exceeds its hard bound | The NanoHost stops attempting, reports sandbox route failure through the existing lease, worker-control, and reliability owners, and does not let the worker's outage budget expire on an unreported condition. |
| Worker-control liveness bound is missed under saturating inference load | The realization gate fails; implementation repairs the required mechanisms or records the measured evidence that authorizes the bounded second worker-control byte stream. No route is dropped, reordered, or reinterpreted to recover latency. |
| Required image digest is absent from the NanoHost Image Store at epoch creation | The NanoHost remains non-ready; repair is an explicit acquisition action, never a readiness-time registry retrieval or build. |
| NanoHost Image Store entry fails digest re-verification | The entry is discarded and the dependent attempt fails closed; a healthy epoch is not invalidated and no repair is attempted. |
| Registry retrieval or authorized build fails | The exact attempt fails through its existing lease and worker owners; the healthy epoch survives because no sandbox effect was completed. |
| An unconfigured container backend is present or started in the epoch | The epoch is invalid and cannot report ready. |
| NanoHost Token slot install, rotation, abort, or clear occurs | A healthy epoch and its running AgentSessions are unaffected; credential selection is re-read at the next connection attempt only. |
| Epoch Invalidation Report export cannot complete within its size or time bound | The report is truncated and marked incomplete; the fence proceeds without further delay and no recovery decision depends on the report. |
| Invalidation occurs with no live NanoHost service | No report is possible or required; the next recovery records a bounded prior-epoch disposition note from observable host state and never synthesizes a report by inference. |
| Mid-epoch attempt-image import fails or cannot be verified | The exact attempt fails through its existing owners; the healthy epoch, its identity, and its other AgentSessions are unaffected. |
| Produced-fact buffer reaches its size or age bound | The affected records fail truthfully through their owning contract; nothing is dropped, summarized, reordered, or promoted to authority. |
| A worker needs inference while NanoCore is unreachable | The call fails through the inference owner and the worker stalls; the NanoHost opens no provider path and serves no cached response. |
| Both NanoHost Token slot metadata records are ambiguous | The NanoHost stays non-ready without a retry loop, and no credential probing behaviour is permitted. |

## Missing, Stale, Conflict, Retry, And Dependency Failure Semantics

- Missing configured NanoHost identity, NanoHost Token metadata, execution-host secret material, named sink, sink ownership or mode, TLS certificate or trust reference, stock component, required image, supervision proof, route binding, token reference, package lineage, native data reference, or readiness evidence fails before work admission.
- A failed or unproved enrollment sink write or identity-reactivation transaction leaves the Token unusable or revoked and a retained identity decommissioned; cleanup removes only an exact still-owned attempted Token, and missing, malformed, replaced, differently owned, partially cleared, or otherwise unproved slot state blocks later enrollment until an explicit operator action proves that slot empty. Retry never replaces the identity row or recovers, prints, or reactivates an old secret or Token.
- Re-enrollment after decommission succeeds only for the exact retained configured identity/deployment pair, preserves its original creation time and redacted history, clears its decommissioned status and time, creates one fresh Token, and leaves every prior Token revoked; missing, duplicate, active, cross-identity, or cross-deployment state fails closed without mutation.
- An expired, rotated, or revoked NanoHost Token, an expired rotation overlap, or invalid TLS trust fences any current session, prevents a new authoritative session, and leaves the NanoHost non-ready without fallback.
- Physical NanoCore connection closure, failure, or authentication loss persists that exact connection generation fenced and non-ready while retaining the durable high-water value; retry opens one new physical connection whose generation the transport-session authority transactionally allocates and returns, and never reuses the failed generation.
- Stale NanoHost identity, predecessor connection, lease, worker sequence, package digest, route token, epoch observation, readiness report, or cleanup report is rejected and cannot mutate current authority.
- Conflicting identity, lineage, sequence, route, package, or cleanup evidence fails closed. The NanoHost does not pick a winner, repair durable state, or start replacement work.
- A transport reconnect never repeats an accepted NanoHost effect command. It may carry only the same correlated result under the same re-derived `requestId`; for export this is either the one complete verified body and its exact metadata tuple or the exact proved optional-absence JSON, never a partial or a rerun, and for accepted `bridge.open` it is the settled redacted result while the same Harness monitor and bridge continue. Only an authoritative successor may deliver it, and an ambiguous or changed duplicate fails closed. A later logical retry requires a new request authorized and identified by the existing attempt/effect owner. Shared HTTP/2 carriage creates no retry authority.
- A nested bridge reconnect never redelivers a dispatched Harness operation. The same surviving Integration may replay only its retained exact result for the same `sandboxIntegrationBindingRef`, `harnessInstanceId`, operation id, and per-Harness sequence; missing command-delivery or result proof becomes `unknown` and widens cleanup, while a restarted Integration or changed binding cannot adopt the predecessor's operation state.
- A `bridge.open` delivery lost before complete NanoHost acceptance remains `unknown` and is never polled or delivered again. A loss after acceptance never reissues Start. Missing or conflicting Turn-family token hashes, sibling or wrong-family authentication, stale or fenced lineage, Harness-monitor ambiguity, group survival, or an incomplete terminal barrier fails closed without alternate credential, relaunch, or transport cancellation as cleanup proof.
- An accepted local create or delete is never abandoned because the NanoCore connection disappears. The live NanoHost waits for a definite result; NanoHost death invalidates the epoch instead of replaying the operation.
- Dependency failure before admission keeps the NanoHost non-ready or rejects the exact package. Dependency failure after admission follows the owning route's failure semantics and invalidates the epoch whenever runtime-effect completion or host-to-Sandbox security and adjudication isolation cannot be proved.
- OpenShell Gateway or container-runtime unavailability is not repaired by independently restarting that member. It invalidates the epoch and requires complete fresh recovery.
- A NanoHost-to-Gateway channel or sandbox bridge retry may replace transport only after predecessor closure and current epoch identity are proved; it never retries a logical route request or converts a transport observation into sandbox cleanup evidence.
- NanoCore unavailability does not invalidate a healthy epoch, but it prevents new claims and product-state mutation until the one authoritative transport session is restored.
- A missing, corrupt, or digest-mismatched NanoHost Image Store entry fails the exact attempt that needs it and never invalidates a healthy epoch, because content-store state cannot complete a sandbox effect.
- A missing, unreadable, or generation-ambiguous NanoHost Token slot prevents an authoritative session and keeps the NanoHost non-ready; it never causes epoch invalidation, alternate-location search, or credential fallback.
- A build definition that lacks exact `build-context://empty/v1` and `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, supplies an empty, non-UTF-8, over-268,435,456-byte, or digest-mismatched inline Dockerfile, mixes that independent Dockerfile into the empty-context digest, lacks exact `{host, port}` egress or required positive `timeLimitSeconds`, `outputLimitBytes`, or `layerLimit`, declares `layerLimit` outside 1 through 128, exceeds another runtime maximum, or requests broader network authority than the sandbox it targets is rejected before the build root or any other build effect. An exported image above the accepted layer declaration or 128 layers fails without Image Store admission.
- The fixed OCI registry pair set does not authorize ordinary Dockerfile `RUN` HTTP(S). A missing exact AEP grant, a non-443 fixed-registry request, an inferred port or path, or a redirect whose exact destination host-port is not already authorized for that same operation fails the exact build or acquisition without widening or fallback.
- An external non-host-local backend appearing in configuration fails closed before epoch creation, because this specification's fence does not reach its effect domain.

## Security And Containment Rules

The containment rules in this section make security and adjudication isolation claims between the execution host and its Sandboxes. They do not claim security and adjudication isolation among AgentSessions co-resident in one shared Sandbox; those AgentSessions remain one compromise domain, while their proved route and context boundaries provide conversation-context isolation and their private mutable slots provide Workspace-write isolation.

- The stock Gateway MUST remain loopback-only and MUST NOT be directly exposed to NanoCore, the public network, or operator-managed forwarding for normal execution. The stock single-use loopback listener inside the opaque `ExecSandboxInteractive` closure is Gateway-internal, not OpenKit-managed, configured, externally reachable, or caller-selectable, and disappears after that call.
- The stock Gateway and configured Docker backend MUST remain in the one epoch-private network namespace. Only the fixed short-lived connector may enter it from NanoHost, only to create the existing loopback Gateway channel; no host-network fallback, proxy, listener, system Docker socket, host loopback route, or independently restarted network helper is permitted.
- The NanoHost service is the sole OpenKit holder of epoch-local Gateway client and `ForwardTcp` authorization material; Sandbox Integration, workers, NanoCore, operators, and public diagnostics MUST NOT receive it.
- The NanoHost transport MUST use the dedicated `nanohost-transport` bearer Token and the TLS rules above; a `server-admin` token, mTLS assumption, verification bypass, TOFU, plaintext non-loopback transport, SSH tunnel, or alternate endpoint is not a fallback.
- At the host-to-Sandbox security and adjudication isolation level, the raw NanoHost Token MUST remain only in its one-time issuance path and named execution-host sink outside the Runtime Epoch, inaccessible to Gateway, container runtime, Sandboxes, Sandbox Integration, and workers.
- Container-runtime sockets, Supervisor interfaces, cgroups, host roots, process identifiers, and epoch credentials remain NanoHost-private and MUST NOT enter product records, AEPs, worker payloads, or public diagnostics.
- NanoHost, worker-control, inference, capability, OpenShell, provider, and Vault credentials MUST remain distinctly bound and fail closed at their exact boundaries. For co-resident AgentSessions this supports conversation-context isolation but does not claim security and adjudication isolation from shared-process compromise.
- Loss or uncertainty at the host-to-Sandbox security and adjudication isolation boundary invalidates the entire epoch, revokes route access, interrupts all affected AgentSessions, exports one `containment-loss` Epoch Invalidation Report before the fence, and invokes existing Vault revocation or rotation ownership without claiming recall of already exposed material.
- Sandbox Integration MUST NOT receive host lifecycle authority, the NanoHost credential, Gateway signing keys, container-runtime access, arbitrary network proxying, or permission to open a second execution route.
- The NanoHost service accepts no NanoCore-supplied shell command, unit name, root path, port, socket, binary path, environment, working directory, timeout, SSH field, or arbitrary OpenShell operation. The build definition is consumed only as data by the configured backend's build operation, and the file effects select only the fixed NanoHost-owned helper; neither becomes a caller-selected NanoHost command, unit, path, or RPC field.
- At the host-to-build security and adjudication isolation level, an authorized build runs under the configured backend's containment with no host mount, no host network namespace, and no access to the NanoHost Token slots, Gateway credentials, container-runtime socket, epoch authentication material, or NanoHost Image Store write path beyond its own result.
- Registry egress is permitted only for a NanoHost acquisition or OCI build-bootstrap operation, only through the exact fixed pair set `{docker.io:443, ghcr.io:443}`, and never from a sandbox, the readiness path, a caller-supplied registry, a non-443 port, or an ordinary Dockerfile `RUN` request without a separately resolved exact AEP `{host, port}` grant. Registry protocol paths and redirects create no general endpoint authority.
- The NanoHost Image Store holds only inert digest-addressed content and its bounded index; it holds no credential, exposes no listener, is never mounted into an epoch or sandbox, and is readable and writable only by the NanoHost service account.
- The Epoch Invalidation Report contains no raw or hashed credential, sink content, private key material, worker transcript, prompt, or Workspace or Artifact bytes, and it is subject to the same secret-scanner and redaction behavior as logs.
- Apart from the one pinned opaque internal relay beneath the fixed single-file `ExecSandboxInteractive` use, SSH is installation, diagnostics, and break-glass tooling only; normal execution exposes, configures, and selects no SSH credential, endpoint, tunnel, lifecycle, control, transfer, settlement, fallback, or CLI upload/download path.
- External OpenShell artifacts MUST remain pinned, checksum-verified, stock, and replaceable through the existing vendor and image owners.
- The CLI, Gateway, exact Tier-2 Supervisor OCI image, provider and policy surfaces, and every other consumed OpenShell component MUST resolve to the exact verified `0.0.99` boundary; the private Gateway configuration selects only the digest-pinned image and its stock static-musl extraction/cache path, while a mixed, floating, relabeled, fallback-tier, or version-range deployment remains non-ready.

## Current Implementation Projection

The current production path is NanoHost-only. The `apps/nanohost` Rust application owns one configured backend and Runtime Epoch, foreground member supervision, TLS plus dedicated Token admission, exact transport-assigned connection generation, same-connection readiness, fixed effect dispatch, image acquisition and build, and the bounded file-data carriages. NanoCore retains scheduler, package, lease, AgentSession, product-record, and canonical-handoff authority and no longer selects a Cell, SSH lifecycle, Gateway forward, or direct Sandbox endpoint. The epoch-private namespace, fixed slirp helper, resolver boundary, namespace-scoped Gateway connector, service mount isolation, and exact host-manifest identity defined above are implemented and pass their local Rust and host regressions. The corrected instrument retains raw F1 pre/post digests and adjudicates a separate digest that normalizes only the unique exact configured NanoCore container's unique `host` network endpoint ID; every bridge, `docker0`, nftables, identity, image, other network field, and other container attachment remains exact, while F2 and F4 require complete raw equality. One independently audited retained no-reboot A1 result from those exact bytes records F1, F2, F4, network conformance, ordinary lifecycle, terminal cleanup, and Aggregate all `PASS`, completing Roadmap R001 and closing the original system-Docker namespace mutation and F1 baseline-truthfulness findings.

The current worker shim is Sandbox Integration for worker-control and inference over one stock `ForwardTcp`/`RelayStream` pair and nested standard HTTP/2 session. Capability remains disabled. The fixed unary `ExecSandbox` bootstrap supplies no arguments, environment values, or stdin bytes; the Node supervisor installs its Supervisor-only `127.0.0.1:17891` listener and separate native HTTP/1 `127.0.0.1:17892` listener, emits exact `OPENKIT_WORKER_SHIM_ENTRY_V1\n`, and NanoHost accepts the marker exactly once across arbitrary stdout event splitting while retaining the same response monitor for the Sandbox Integration lifetime. The current `sandboxIntegrationBindingRef`, two credential-free private Harness paths, first-poll empty-`204` readiness latch, fixed six-operation protocol with an independent sequence per NanoCore-selected `harnessInstanceId`, multiple adapter-selected Harness Instances, multiple independent AgentSessions, one active Turn per Harness, private runtime-record decomposition, three compatibility keys, separate open-session occupancy, per-Turn route-token binding, package-config before generated Context imports, required present exports, the one exact optional Workspace-manifest absence result, fixed `image.build/input` carriage, authenticated native inference projection through the existing H2 session, and exact Codex native-handle resume across per-Turn child processes are implemented and locally tested. Retained A1 real-provider and reconnect evidence covers the accepted fault scenarios. Multiple Harness records per Sandbox, compatibility-keyed placement, and one Integration supervisor routing the declared private Harness identities are implemented; bounded concurrent active Turns and the real two-runtime acceptance remain divergent from the accepted target.

NanoCore product admission now derives the exact static SessionCompatibilityKey before a scheduler lease, requires the sole configured RuntimeTarget readiness projection, reuses only the Thread's exact compatible idle AgentSession with clean durable NanoHost continuity, and otherwise completes exact local `session.close` or uncertainty fencing before terminalizing the predecessor and selecting one fresh internal identity. Store and Harness projections enforce one current AgentSession per Thread, ordinary App API read models expose no AgentSession identity or action, and the unowned generic snapshot or recovery-selector path has been deleted. RuntimeTarget no longer contains mutable lease or capacity fields; scheduler leases remain the active-Turn authority while Harness occupancy is only its runtime projection.

Boot Phase 8 is effect-free and registers only deterministic cleanup result expectations; the existing post-listener single-flight service owns effectful cleanup and fail-closed accepted-final-status handling. A retained exact result settles the original owner without replay, a successor poll-first observation marks the old request unknown and fences that connection, and NanoHost fail-stops a successor that loses the first poll response before completion while retaining reconnect behavior for the initial connection, a delivered retained result, and later polls. Every authoritative readiness report still projects the same coordinator-established `freshEmpty` proof, while Sandbox cleanup state and retained scheduler capacity prevent a healthy reconnect from clearing an uncertainty fence. The current clone retains one independently audited no-reboot A1 artifact that accepted F1 with its exact NanoCore-restart-invariant baseline, F2 and F4 with raw baseline equality, network conformance, normal lifecycle, and terminal cleanup, completing the R001 acceptance owner. Scenario 3 restart truthfulness remains unresolved under its explicit no-reboot effect boundary and is deferred to R005.

The application-local pin manifest and retained source evidence freeze stock OpenShell `0.0.99`, its exact eleven consumed RPC roots, per-RPC authorization and secret marking, the `ForwardTcp`/`RelayOpen`/`ConnectSupervisor`/`RelayStream` bridge, nested standard HTTP/2 feasibility, the fixed single-file Interactive helper, and the unary bootstrap/monitor. The separate fault-acceptance matrix passed before the retired Cell helper, controller, direct CLI backend, SSH lifecycle runner, selectors, and obsolete tests were deleted without replacement.

The upstream project has published releases beyond the pin, and a newer published release does not move the target. The pin remains `0.0.99` until the realization gate is re-run under the re-pin obligation in the Stock Realization Annex.

The configured-backend boundary, NanoHost Image Store, epoch image import, acquisition and bounded build paths, stable NanoHost Token slot pair, transport envelope, bridge re-establishment bound, and Epoch Invalidation Report are implemented under their current owners.

No implementation may report this specification as partial or implemented until the stock-feasibility precondition succeeds and the target path becomes selectable without the legacy Cell, SSH lifecycle, Gateway-forward, or sandbox-direct route configuration. The current implementation satisfies both preconditions.

## Rollout / Migration Plan

1. Completed: establish the pinned stock OpenShell client and prove its bridge, transport envelope, and complete OS failure group.
2. Completed: implement the app-local NanoHost binary and its foreground epoch members inside the private execution boundary.
3. Completed: implement the NanoHost-owned Runtime Epoch, fail-stop group, readiness, one NanoCore session, and one shared Gateway client channel.
4. Completed: implement the NanoHost Image Store, image import and build, invalidation report, and rebuild-budget evidence.
5. Completed: implement Sandbox Integration, the initial multi-AgentSession Harness, fixed operation carriage, continuity adapter, route separation, and first-slice compatibility and capacity bounds.
6. Completed: implement enrollment, stable credential slots, transport authentication, rotation and revocation, TLS, predecessor fencing, reconnect, and the NanoHost-only configuration projection.
7. Completed: make NanoHost the sole selectable runtime path.
8. Partial: the current R001 runner admits F1, F2, and F4 with exact raw and NanoCore-restart-invariant baseline ownership, and an independently audited retained Aggregate from those corrected bytes completes the R001 gate. Required Scenario 3 execution-server restart evidence remains deferred to R005 under the explicit no-reboot boundary and keeps this specification Partial.
9. Completed: delete the retired Cell, SSH lifecycle, Gateway-forward, direct-endpoint, runner, test, and current-support paths.
10. Completed: implement the existing `HarnessCompatibilityKey` seam, multiple Harness records per Sandbox, and Integration supervision of NanoCore-selected private Harness identities without changing the six-operation protocol.
11. Implement bounded concurrent Turns across distinct AgentSessions under proved Harness and Sandbox capacity.
12. Run focused scheduler, worker-shim, NanoHost transport, restart, cleanup-width, and real two-runtime acceptance before reporting the complete concurrency target implemented.
13. The deprecated Cell specification is terminal and remains at the specification root only until the documentation-governance auditor archives it.

There is no compatibility mode after cutover. A failed stock-feasibility gate or failed fail-stop proof blocks migration and returns the design to its owners.

## Testing Strategy / Acceptance Criteria

### Contract And Security Checks

- One Sandbox retains at least two compatibility-distinct Harnesses, each Harness retains admitted AgentSession bindings within `maxOpenSessions`, bounded Turns run concurrently only across distinct Threads and AgentSessions within Harness and Sandbox `maxActiveTurns`, and a second current binding or active Turn for one Thread or AgentSession is refused without closing valid siblings.
- `SandboxCompatibilityKey`, `HarnessCompatibilityKey`, and `AgentSessionCompatibilityKey` accept only exact current inputs; a changed static Sandbox, static Harness, or continuity input selects the appropriately narrow replacement rather than approximate reuse.
- The six fixed Harness operations admit no arbitrary command, executable, `argv`, `cwd`, environment, shell text, host path, endpoint, credential, working directory, or unknown operation, and exact local interrupt and close do not disturb a compatible sibling.
- A `session-continuity` Turn uses only private Harness `turn.interrupt`, while `bounded-turn` uses only the existing worker command row; the immutable adapter mode, existing Turn and lease terminal compare-and-set, and one shared process-group supervisor prevent dual delivery, duplicate signals, direct product terminalization, and cross-channel retry.
- The two exact private Harness paths accept no bearer or client-supplied binding header, bind only through the current nested connection plus NanoHost-injected `sandboxIntegrationBindingRef` and current authoritative outer connection, carry one independent operation sequence per NanoCore-selected `harnessInstanceId` under the worker-control owner, and create no ninth NanoHost effect, fourth namespace, reverse connection, worker command, NanoHost queue, or journal.
- One Harness opens Codex AgentSessions for two distinct Threads with distinct private `CODEX_HOME` roots and native handles, settles each first start as pending while interrupt remains deliverable, establishes each handle through terminal collection and exact inspection, starts a later Codex process instance with exact UUID resume for that AgentSession, rejects sibling or ambient selection, and closes one AgentSession without changing the other.
- Each sequential Turn receives a fresh per-Turn AEP, Context Package, lease, route credentials, deadline, and sequence; cross-AgentSession and stale credential use is rejected and no Sandbox-wide authorization package exists.
- Co-residency checks separately prove conversation-context isolation and Workspace-write isolation and explicitly reject any claim that namespacing supplies security and adjudication isolation; cleanup uncertainty drains and fences the wider proved boundary.
- Off-peak rebuild checks prove measured idleness and age, zero active Turns, ordinary drain and current-generation re-initialization, independent handling of an arriving request, and no admitted capacity or correctness claim after failure.
- Exactly one configured NanoHost identity and one authoritative NanoHost-initiated physical HTTP/2 client connection to the NanoCore HTTP/2 server exist at steady state; identity, deployment, Token, and connection generation are bound to that exact connection.
- The NanoCore native HTTP/2 server creates the opaque unforgeable physical-connection identity and supplies it only through server connection context; the admit body remains `{}`, synthetic application requests cannot stand in for physical admission, and the server-observed close event fences the exact bound generation.
- After successful `EpochCoordinator::start` and authoritative admission, NanoHost sends exact `{}` to the fixed private `POST /api/nanohost/transport/session/readiness` path and receives an empty `204` before any effect poll. NanoCore derives identity, deployment, exact allocated generation, predecessor fence, and server `observedAt` from existing native owners, projects current readiness without granting capacity, and rejects every malformed, synthetic, candidate, stale, future, fenced, closed, or wrong-connection request without projection or generation advance. A cleanup fence clears only after its recorded predecessor connection is fenced and a later fresh coordinator proves readiness; healthy reconnect readiness cannot clear it.
- Every control, readiness, worker-control, inference, capability, NanoHost-effect, and fixed file-data stream uses ordinary client-request/server-response HTTP/2 carriage on that connection and reaches the authoritative session dispatcher without a generic envelope, second physical connection, fallback, transport framework, or new dependency.
- The eight fixed NanoHost effect operations use only their exact command and result paths plus the sole fixed `image.build/input` subpath; one exact `{}` poll at a time returns `204` or one operation-specific command with the deterministic existing-lineage `requestId`, and only its matching result from the current authoritative physical connection may mutate the expected transition. All commands and non-export results remain bounded JSON under the unchanged 512 KiB control ceiling except the exact `reference.import` command body, `image.build/input` response body, and `file.export` result body on the one file-data reservation.
- Accepted-effect reconnect tests prove that the authoritative successor delivers the retained same-`requestId` result before any poll; same-result delivery settles without replay, while successor-poll-first marks the old effect unknown exactly once, fences that connection and affected capacity, causes NanoHost epoch fail-stop, and permits release only after a later fresh-coordinator readiness report. They also prove that cancellation, reset, timeout, or physical close after that first poll starts but before its complete response is terminal and cannot re-enter the same coordinator's reconnect loop even when NanoCore committed unknown before response delivery.
- An ordinary definite local-owner failure uses only exact `{"requestId":"<64-lowercase-hex>","failureCode":"effect_failed"}` on its fixed result path; NanoCore matches the current operation and pending request, acknowledges and rejects it exactly once without success validation, and the same session continues only where the existing operation lifecycle permits. Physical or result-delivery uncertainty, uncertain `bridge.open`, create, or delete, `reference.import`, and present-file `file.export` retain their special rules and gain no fallback; the sole non-failure JSON export result is exact optional absence on the same fixed path.
- Outer-session failure output contains only the closed reconnect-or-terminal disposition, closed stage, fixed operation or `none`, and three-digit HTTP status or `none`; physical close or eligible definite-result delivery uncertainty reconnects silently except in the terminal successor first-poll response window, while every terminal failure is printed exactly once by `main` and is never replayed.
- The one coordinator-owned member/fence event seam continuously monitors child exit during every local effect, keeps the sole OpenShell client private, exports before the one complete-group fence, and kills and reaps every child exactly once on failure or drop.
- The dedicated `containerd`, dedicated `dockerd`, and stock Gateway share one fresh non-host network namespace while the NanoHost parent and exact manifest-owned slirp helper remain in the host namespace. The helper reaches bounded ready-fd, remains a monitored foreground group member, exposes no host-loopback or proxy-DNS fallback, and supplies only the accepted fixed resolvers to the private backend. Initial Gateway connection and every permitted reconnect use the sole namespace-entering connector without a proxy, listener, second logical channel, member relaunch, or endpoint fallback.
- Real-host start, stop, member failure, and NanoHost `SIGKILL` checks prove identical system Docker default-bridge metadata, kernel `docker0`, canonical Docker-owned nftables structure excluding dynamic counters and handles, business-container identities and network attachments, and bounded system-Docker build egress, while the private namespace, TAP, routes, sockets, and members disappear. A private-network-namespace probe proves policy-governed public Git DNS and HTTPS egress and cannot reach the host NanoCore listener or a host-loopback sentinel; a service-mount-boundary epoch member cannot open the system Docker API path; and a Sandbox receives no direct Gateway route or credential outside the exact stock Supervisor and relay mechanisms.
- The private current mTLS client and current ready sandbox use one fixed `ExecSandboxInteractive` single-file helper and one fixed unary `ExecSandbox` `bridge.open` bootstrap/response monitor. Neither exposes an executable, argument, environment, working-directory, timeout, TTY, or target selector.
- The fixed `reference.import` and `file.export` paths use the Interactive helper. One fixed outer file-data stream carries one regular file at a time under the exact content type, content length, five canonical metadata headers, path encoding, 256 MiB body ceiling, 64 KiB application/helper write and release ceiling, declared-length completion without early request EOF, status mapping, current-successor correlation, import inventory proof, export actual-fact proof, terminal barrier, atomic placement, clean-zero-exit, no-logical-replay, and delete-to-epoch-fence rules; an optional export may instead return only the exact secure leaf-absence result with no file-data staging, while every required or contradictory absence retains the failure rules.
- The same outer file-data reservation carries at most one fixed `image.build/input` response at a time after bounded metadata acceptance: exact request `{}`, each required OpenKit application header exactly once with value/body correlation, strict required representation headers, ignored non-authoritative legal transport and representation headers, exact UTF-8 body, 1-through-268,435,456-byte declared and observed length, lowercase SHA-256, at-most-64-KiB releases, complete pre-build verification, `409`/`413`/redacted-`500` failure mapping, successor-only definite-result carriage, and no refetch, resume, replay, slot, path, locator, context transfer, or generic envelope.
- For each Turn, the first private import is its exact canonical AEP body under exact AgentSession and Turn lineage, then every generated Context Package import completes before `turn.start`. No import writes a Sandbox-global authorization path; adjacent identity, path, destination, export, missing or changed bytes, failed admission, and any source or selector outside the accepted private slots fail before that Turn starts.
- The fixed `bridge.open` disposition carries only its static non-secret Sandbox Integration descriptor, `sandboxIntegrationBindingRef`, and bounded declared Harness descriptors, starts exactly one retained Integration monitor with the fixed Start fields, empty stdin and EOF, accepts exactly one `OPENKIT_WORKER_SHIM_ENTRY_V1\n` byte-stream marker before any bridge attempt, opens the one bridge, receives exact `204` from the first header-free private Harness poll after the complete descriptor set loads, and only then permits fixed `session.open` with a NanoCore-selected `harnessInstanceId`. Missing, incomplete, duplicate, unsupported, or adjacent non-empty stdout, any non-empty stderr, a credential-bearing or client-bound poll, or a non-`204` response fails stop; reconnect performs no relaunch. A Turn export requires accepted `final_status` and exact AgentSession-local quiescence; correlated monitor Exit and clean completion are required only when the Integration ends.
- The distinct fixed `127.0.0.1:17892` native listener and Supervisor-only `127.0.0.1:17891` bridge listener bind before the marker; native admission stays disabled until the nested H2 client is ready, and the first Harness poll `204` proves both listener roles before child launch. Initial and successor bridges continue to use only `17891`. Native requests use only exact authenticated `POST /inference/*`, preserve end-to-end bytes, headers, content encoding, SSE, backpressure, and cancellation under the semantic 16 MiB aggregate plus transport 2 MiB in-flight and 64 KiB write bounds, and create no outer stream for a wrong token, family, method, absolute-form target, or proxy capture. Closing Integration rejects both listeners, cancels active local requests, closes the one nested session, and uses existing Harness and Sandbox cleanup without local retry or replay.
- The transport-session authority authenticates and owns checked transactional generation allocation, physical-connection binding, and fencing; successful admission returns the allocated generation, and RuntimeTarget `connection_generation` remains only its durable high-water/current projection.
- Allocation is `1` or durable high-water plus one: pre-commit failure and rejected unauthenticated, stale, concurrent-loser, same-connection-replay, or overflow input do not advance it, while post-commit bind/session failure consumes and fences the allocated generation before a later successor.
- Every physical reconnect, including transient loss and NanoCore restart, receives a strictly increasing successor generation; connection closure or failure fences the failed generation while retaining its high-water value before a successor carries work.
- A successor session cannot carry work until its predecessor is fenced, and every late predecessor message is rejected.
- The NanoHost Token uses `okt_` with at least 256 bits of CSPRNG entropy, hash-only NanoCore storage, constant-time verification, non-echoing failures, and existing secret-scanner and redaction behavior.
- Enrollment atomically creates a first-install NanoHost IntegrationIdentity or reactivates the exact retained decommissioned identity/deployment pair and creates one fresh Token only after one empty named slot is acquired without overwrite and its safe-sink write succeeds; every sink or transaction failure leaves no active identity or usable new Token and leaks no raw secret, exact-owned cleanup cannot delete a winner or adjacent credential, and every old Token remains non-usable.
- At the host-to-Sandbox security and adjudication isolation level, the execution-host sink is root- or service-owned, mode `0600` when file-backed, outside the Runtime Epoch, inaccessible to Gateway, container runtime, Sandboxes, and workers, and represented in config only by a non-secret reference.
- `/etc/openkit/nanohost.env` is the sole NanoHost session-input projection, contains only the exact identity, deployment, rendezvous, four slot-reference, optional CA-reference, and required-image keys, and is fully validated before any effect without a raw Token, alternate source, default, alias, hard-coded value, or fallback.
- User, server-admin, worker, route-family, OpenShell, wrong-nanohost, wrong-deployment, stale, rotated, revoked, expired, and malformed credentials are rejected at the NanoHost boundary.
- Product, administration, worker-control, inference, capability, Gateway, provider, and Vault routes reject a valid `nanohost-transport` Token.
- Rotation proves successor sink installation, fences the predecessor connection before successor authority, then rejects predecessor reauthentication; failed successor installation and explicit abort or retry preserve at most one authoritative session without a new coordinator.
- Revocation immediately fences the NanoHost session, stops admission, leaves healthy already-running work only under existing disconnect semantics, and requires explicit server-admin issuance for recovery.
- Decommission revokes every NanoHost Token, stops the supervised group, removes the execution-host raw secret through the explicit operator path, and retains only redacted identity, Token, actor, and audit history.
- The dedicated NanoHost bind and advertised rendezvous are startup-required, restart-only, and distinct from `server.bind`; bind collision, missing configuration, or a public path on the private listener fails closed without falling back to the App listener.
- Non-loopback, container-bridge, and remote connections require a valid server-authenticated TLS endpoint; exact same-host loopback on both the dedicated bind and rendezvous is the only plaintext HTTP/2 exception, and verification bypass, TOFU, plaintext downgrade, mTLS assumption, and any SSH runtime path beyond the pinned opaque `ExecSandboxInteractive` implementation closure are rejected.
- Credential lifecycle audit names only non-secret NanoHost identity, Token ids and lineage, responsible server-admin actor, deployment, action, result, and time.
- Worker-control and inference use distinct independently generated 32-byte tokens whose exact current scheduler lease owns two separate lowercase SHA-256 binding projections; neither raw value is durable or derived from `sandboxBindingRef`, cross-family use is rejected, and capability remains disabled without a token.
- Route payload, concurrency, flow control, timeout, retry, failure, usage, and audit semantics remain owned and enforced independently.
- `apps/nanohost` builds as one Rust binary crate with no Go or TypeScript NanoHost implementation, no second NanoHost package, no durable store, and no plugin, driver, or actor framework.
- The NanoHost compiles either the proved exact-tag OpenShell Rust client or the minimum client generated from the exact refreshed `v0.0.99` protobuf snapshot; no Gateway server crate, floating source, OpenShell source fork, or normal-operation CLI adapter enters the NanoHost build or runtime path.
- The stock Gateway remains a separate checksum-verified foreground process inside the complete service cgroup, and any effect-capable child exit causes NanoHost exit and whole-group termination rather than child restart.
- The NanoHost uses one current epoch-local authenticated mTLS Gateway client channel for lifecycle, each current `ForwardTcp`/`RelayStream` pair, the fixed single-file `ExecSandboxInteractive` helper, and the fixed unary `ExecSandbox` worker bootstrap/monitor — or exactly two forwarding pairs when the measurement-gated worker-control fallback is authorized — with no OpenKit-managed or exposed listener, operator forward, public Gateway port, second data connection, or NanoHost-held Gateway credential or stock channel id reaching NanoCore, Sandbox Integration, or the Worker Agent.
- Sandbox Integration is the nested HTTP/2 client, the NanoHost is its server, the Gateway and Supervisor remain byte-transparent, and a successor pair carries no route traffic before predecessor closure and exact route lineage are proved.
- Large data uses native or bounded transfer paths and cannot smuggle control, token, readiness, lease, or terminal semantics; the exact fixed file-data path for the two single-file effects and one Dockerfile response may share the authoritative outer physical connection but remains one distinct one-stream data carriage.
- NanoCore source and configuration expose no Cell, SSH lifecycle, Gateway-forward, direct Gateway, container-runtime, or sandbox-direct worker endpoint after cutover.
- The selected OS supervisor makes independent restart or abnormal exit of every effect-capable member invalidate and terminate the complete epoch.
- Harness launch and termination are observed through the retained fixed monitor rather than inferred from CLI or transport lifetime; one correlated Exit plus clean completion is necessary at Harness end but never substitutes for proved process-group absence, and AgentSession-local close requires its own exact proof.
- The epoch contains exactly the configured backend's members; starting an unconfigured backend, or configuring a backend with an external effect domain, keeps the NanoHost non-ready.
- Readiness imports every required image digest from the NanoHost Image Store, re-verifies it after import, and performs no registry retrieval or build; a missing digest keeps the NanoHost non-ready.
- The NanoHost Image Store holds only inert digest-addressed content, exposes no listener, is never mounted into an epoch or sandbox, and a digest mismatch discards the entry and fails the dependent attempt without invalidating a healthy epoch.
- A build definition is rejected before effects unless it preserves exact `build-context://empty/v1` and `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, keeps 1 through 268,435,456 inline UTF-8 Dockerfile bytes under their independent exact lowercase SHA-256 and outside that empty-context digest, preserves exact `{host, port}` egress grants and positive `timeLimitSeconds` and `outputLimitBytes` within runtime maxima, and declares integer `layerLimit` from 1 through 128; the exported OCI image must also remain within both its accepted layer declaration and 128. An accepted build runs without a caller-supplied capability, Dockerfile locator, host path, build root, socket, host mount, host network, credential access, context transfer or variant, or published-image tag.
- The fixed OCI registry build-bootstrap projection remains exactly `{docker.io:443, ghcr.io:443}`, stays distinct from AEP-authored ordinary build HTTP(S) grants, authorizes only registry-protocol exact-digest traffic, grants no non-443 or path authority, and rejects every redirect whose exact destination host-port is not already authorized for the same operation.
- Rotation writes the successor to the non-active stable slot, leaves the predecessor slot intact until cutover, does not invalidate a healthy epoch, and permits abort with the predecessor still authoritative.
- Credential selection reads only the two declared slots and resolves generation from non-secret companion metadata, never from filename, modification time, or content length.
- Route-family stream reservation, per-stream window sizing, per-family in-flight DATA ceilings, and bounded inference chunking are enforced; HTTP/2 stream priority is not relied on anywhere.
- Interrupt delivery p99 and heartbeat margin satisfy the transport envelope under saturating inference load, and peak intermediate buffering across the nested flow-control layers is bounded and observed.
- Successor bridge establishment satisfies its hard bound, and exceeding it produces a reported route failure through existing owners rather than silent consumption of the worker outage budget.
- A NanoHost-initiated invalidation exports a bounded redacted Epoch Invalidation Report before the fence within its size and time bounds; a NanoHost-absent invalidation produces a prior-epoch disposition note at the next recovery instead; neither contains a credential or worker content, retention is self-pruning, and no recovery, readiness, or capacity decision reads either.
- Mid-epoch attempt-image import is digest-verified, does not change epoch identity, cannot install a deployment image or repair a readiness failure, and its failure leaves a healthy epoch intact.
- Acquisition has exactly the two declared triggers and the exact fixed anonymous public registry set `{docker.io, ghcr.io}`; a command cannot supply a registry, and a sandbox, worker, Sandbox Integration, Gateway, or backend cannot initiate, influence, or observe acquisition.
- An attempt image is never published, tagged, or selectable as a deployment image, and confers no capability beyond its owning AEP grants.
- Slot companion metadata is non-secret, is written only by enrollment or rotation, and tampering with it changes only which slot is tried first while NanoCore verification remains the sole authority.
- Decommission removes both credential slots and their metadata, the NanoHost Image Store, and the retained evidence location.
- Observed epoch rebuild time and uncertain-outcome rate are recorded against the falsifiable premise, and a hard-bound violation keeps the NanoHost non-ready rather than advertising early.
- The produced-fact buffer respects its size and age bounds, holds only produced facts, dies with its epoch, and its overflow is a truthful failure rather than a drop, summary, or reorder.
- No received authority is cached: an AEP, policy decision, capability grant, permission decision, or lease state is never revalidated, refreshed, or served from NanoHost-local state, and no inference, capability, or provider response is served locally.
- A NanoCore outage produces a stalled worker rather than a locally satisfied inference call, and no diagnostic or projection claims that a running agent makes progress during one.

### Required Scenario 1: NanoCore Restart During Active Work

1. Start one real AgentSession and observe a post-launch durable worker sequence.
2. Restart only NanoCore while the NanoHost, Runtime Epoch, sandbox, Sandbox Integration, and worker continue.
3. Re-establish one successor NanoHost transport session after fencing its predecessor.
4. Prove the same lease, AgentSession, backend session, package snapshot, process key, and exact next sequence continue without Sandbox recreation.
5. Complete through one accepted final status with no duplicate sandbox create, worker launch, output publication, inference or capability replay, or capacity claim.

### Required Scenario 2: NanoHost SIGKILL During Blocked Sandbox Create

1. Hold one already accepted sandbox create below the NanoHost operation boundary before it can reach a definite result.
   The verification-only observation channel is the value-free NanoHost journal record emitted after one fixed effect poll is accepted and immediately before dispatch to the OpenShell lifecycle owner. It carries only the closed operation name and no request, sandbox, credential, or provider value.
2. Deliver SIGKILL to the NanoHost service without manually cleaning the runtime.
3. Prove the OS supervisor terminates the Gateway, every configured container-backend member, sandboxes, cgroups, proxy or helper processes, and every process capable of completing the held create.
4. Release the fault and prove no late container, sandbox, network, process, mutable root, socket, or authentication state appears.
5. Recover through a fresh epoch and prove fresh-empty readiness before capacity is advertised.

### Required Scenario 3: Execution Server Restart

1. Restart the execution server with a live or in-flight NanoHost operation.
2. Prove NanoCore marks affected AgentSessions `interrupted` or `unknown` through existing owners and infers neither cancellation nor completion.
3. Prove the NanoHost remains non-ready during Runtime Epoch recovery while an old effect, root, process, network, socket, credential, or sandbox remains possible or unclassified.
4. Prove the fresh Gateway and configured container backend are healthy and empty, and that required image digests were imported from the NanoHost Image Store and re-verified, before new work is accepted.

### Required Scenario 4: Effect-Capable Member Failure

1. Kill the stock Gateway or a configured container-backend member during one accepted sandbox operation without first killing the NanoHost service.
2. Prove the supervisor invalidates the entire epoch, terminates every effect-capable sibling, and prevents member-local restart from restoring readiness.
3. Prove every hosted AgentSession is interrupted independently and no route or capacity remains usable.
4. Recover only through a fresh empty epoch and prove the failed member identity, roots, network, processes, and in-flight operation cannot re-enter the active NanoHost.

### Acceptance Predicates

The specification is implemented only when all of the following are observed:

1. The deployment uses exact stock OpenShell `0.0.99`, one configured NanoHost, one stock Gateway, and exactly one configured host-local container backend per Runtime Epoch with no unconfigured backend started, inside the small-deployment profile stated by `docs/specs/20260703-runtime_scheduling_scale.md`.
2. NanoCore and the NanoHost have exactly one authoritative NanoHost-initiated physical HTTP/2 client connection on the dedicated `nanohost.bind` listener, whose local TCP port is distinct from `server.bind`; the connection is bound to the exact identity, deployment, Token, and transport-authority-assigned generation through the NanoCore native HTTP/2 server's opaque connection context; the App listener and every non-private path on the NanoHost listener are rejected; the admit body is `{}`; a synthetic, HTTP/1, App-listener, or proxy request cannot supply that context; checked SQLite allocation returns `1` or durable high-water plus one in the admission response; every rejected or pre-commit attempt leaves that value unchanged; every post-commit bind/session failure consumes and fences it; the server-observed close or failure retains it as fenced high-water; and only a strictly increasing successor may carry work through the authoritative dispatcher.
3. Each active sandbox has exactly one current stock `ForwardTcp`/`RelayStream` pair carrying one standard HTTP/2 session from Integration client to NanoHost service — or exactly two pairs when the bounded conditional worker-control fallback is authorized by recorded measurement evidence — with no OpenKit multiplexer, operator listener, or public Gateway forward.
4. Normal AgentSession end closes only its exact native conversation and AgentSession-local state, releases open-session capacity after proof, and preserves compatible siblings, the shared Sandbox, and the healthy epoch.
5. Every uncertain accepted create or delete invalidates the epoch and keeps capacity fenced until fresh-empty recovery.
6. Every effect-capable member failure is observed by the one coordinator-owned member/fence event seam even during a long local effect, invalidates and terminates the complete supervised group, and cannot report effect success after the fence.
7. NanoCore restart preserves exact session lineage and sequence without recreating the sandbox while requiring one new physical connection and one transactionally allocated strictly increasing successor connection generation.
8. Execution-server restart cannot produce premature readiness or inferred terminal state.
9. Route credentials and semantics remain distinct on both shared transport boundaries.
10. OpenKit-managed, exposed, configured, or caller-selected SSH; direct SSH credentials or endpoints; SSH tunnels, lifecycle, control, data-settlement, fallback, and CLI upload/download; direct Gateway exposure; operator-managed or externally exposed Gateway forwarding; direct sandbox-to-NanoCore routes; OpenShell forks; and custom multiplexing are absent from the selectable execution path. The only SSH use inside normal execution is the pinned opaque Gateway-internal relay beneath the fixed single-file `ExecSandboxInteractive` use, with no OpenKit-managed or externally reachable listener and no selectable SSH surface.
11. NanoHost enrollment, exact retained-identity re-enrollment after decommission, safe-sink storage, hash-only verification, rotation, revocation, audit, and decommission satisfy the complete dedicated `nanohost-transport` Token lifecycle without reusing a human or server-admin credential; re-enrollment preserves the stable identity and redacted history, issues only a fresh Token through an empty no-overwrite slot, rejects every mismatched or ambiguous identity/deployment lineage, and cannot let a losing or failed attempt clear another attempt's credential.
12. `/etc/openkit/nanohost.env` provides the exact non-secret NanoHost identity, deployment, rendezvous, four credential-slot references, optional CA reference, and required image digests before any effect; every non-loopback NanoHost connection validates server-authenticated TLS through declared platform or exclusive configured-CA trust, while exact same-host loopback is the only permitted plaintext HTTP/2 shape, and no raw Token, alternate source, default, alias, hard-coded value, or fallback exists.
13. No credential transition permits two authoritative NanoHost sessions, automatic bootstrap, token fallback, secret echo, or credential recovery from NanoCore storage.
14. `apps/nanohost` is the sole NanoHost implementation, builds as one Rust binary crate, and consumes existing OpenKit protocol authorities only through generated projections or bounded transport parsing rather than a duplicate schema owner.
15. The NanoHost links only the exact-tag OpenShell client SDK or the minimum exact-protobuf Tonic client, while the official checksum-verified `v0.0.99` Gateway runs as a separate foreground process and no ordinary lifecycle operation invokes the CLI.
16. NanoHost SIGKILL and any Gateway or container-backend child exit terminate the complete service cgroup, and recovery creates a fresh epoch without independently restarting a member or adopting an escaped process.
17. Exactly one container backend is configured and instantiated, its effect domain is host-local, and no backend abstraction layer, driver framework, or unconfigured backend exists in the selectable path. Its `containerd`, `dockerd`, and stock Gateway share one fresh non-host network namespace reached by the host-namespace manifest-owned slirp helper, exact non-loopback resolvers, and one namespace-scoped Gateway connector; every lifecycle and failure check leaves the system Docker bridge, canonical nftables structure excluding counters and handles, business-container attachments, and build egress unchanged and removes every epoch-private network object.
18. Epoch readiness imports required image digests from the epoch-external NanoHost Image Store and re-verifies them, with no registry retrieval or build on the readiness path.
19. Registry retrieval and authorized build have exactly the two declared triggers and produce verified digest-addressed store content under their bounds; acquisition identity remains the fixed anonymous public `{docker.io, ghcr.io}` set, OCI acquisition/build bootstrap uses exactly `{docker.io:443, ghcr.io:443}`, and neither is command or configuration input. A build accepts only explicit `build-context://empty/v1` plus `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, materializes exactly the zero-entry empty context, verifies 1 through 268,435,456 inline UTF-8 Dockerfile bytes against their independent lowercase SHA-256 before effects, preserves separate exact AEP `{host, port}` grants, accepts `layerLimit` only from 1 through 128, admits no OCI image above the declaration or 128 layers, grants fixed registry pairs no ordinary `RUN` or non-443 authority, rejects undeclared redirect destinations, and leaks no build egress to the resulting sandbox.
20. NanoHost Token slots are a stable pair outside epoch identity, rotation and abort leave a healthy epoch and its running AgentSessions untouched, and exactly one slot holds usable material at steady state.
21. The transport envelope holds under saturating inference load, with reserved worker-control streams, enforced in-flight ceilings, bounded chunking, no reliance on HTTP/2 priority, and interrupt and heartbeat bounds met end to end.
22. Bridge re-establishment satisfies its hard bound and leaves at least half of the worker-control outage budget unconsumed, or the failure is reported through existing owners.
23. Every NanoHost-initiated epoch invalidation produces a bounded redacted Epoch Invalidation Report before the fence, every NanoHost-absent invalidation produces a bounded prior-epoch disposition note at the next recovery, and neither informs a recovery, readiness, or capacity decision.
24. Observed epoch rebuild time and uncertain-outcome rate are recorded against the falsifiable premise on the declared topology.
25. The NanoHost collects, normalizes nothing, accepts nothing, and stores no canonical product truth; the only authority it holds is proof about its own local effects.
26. Each `reference.import` or present `file.export` moves exactly one admitted regular file no larger than 256 MiB through one fixed outer file-data stream and the current authenticated Gateway client and ready Sandbox, with exact AgentSession and Turn lineage, canonical headers and path encoding, at-most-64-KiB application/helper writes or consumption releases, rejection of oversized output or stderr events, imported source digest and length or NanoHost-produced export digest and length, import atomic visibility before `turn.start`, export only after the Turn terminal barrier through verified NanoCore-private staging into an existing canonical owner, exactly one zero exit plus clean completion, successor-only correlated result delivery, no logical replay after admission, and local-cleanup-to-Sandbox-delete-to-epoch-invalidation widening. An explicitly optional export may instead settle only the exact secure leaf-absence result with no staging or canonical output; every required or contradictory absence fails. The exact canonical per-Turn AEP import is first in that Turn's private slots and precedes all Context imports.
27. The produced-fact buffer is bounded in size and age, fails truthfully at either bound, and no received authority or provider response is cached anywhere in the NanoHost.
28. A NanoCore outage leaves the worker's process, lease, and sequence intact and its inference unavailable, and no document, diagnostic, or projection states a stronger guarantee.
29. Each of the eight fixed NanoHost effect operations polls and returns results only on its two exact private command/result paths over the one authoritative physical connection, with the sole additional fixed `image.build/input` subpath carrying no new operation or result. Each carries one deterministic existing-lineage `requestId` and operation-specific bounded metadata without a generic operation selector, has at most one effect-control request open, and never replays an accepted effect. An authoritative successor delivers a retained same-`requestId` result before any poll; successor-poll-first makes the old accepted effect `unknown` exactly once, fences that connection and affected capacity, and requires NanoHost fail-stop plus later fresh-coordinator readiness. Cancellation, reset, timeout, or physical close between that first poll's start and complete response is terminal and never reconnects the same coordinator.
30. `bridge.open` carries only its static non-secret Sandbox Integration descriptor and declared Harness set and no AgentSession, Turn, package, Context, or route credential; NanoHost runs one fixed timeout-zero Integration Start with empty stdin and EOF, accepts exactly one fixed value-free `OPENKIT_WORKER_SHIM_ENTRY_V1\n` marker as an arbitrarily split stdout byte stream before any bridge attempt, keeps the response monitor live for the Integration lifetime, establishes the one bridge, receives exact empty `204` readiness for every declared Harness binding, and permits fixed `session.open` only on a ready matching Harness. Missing, incomplete, duplicate, or adjacent non-empty stdout, any non-empty stderr, premature Exit, response loss, malformed or credential-bearing first poll, non-`204`, or stream completion fails stop; reconnect causes zero extra Start, marker, Sandbox, Integration, Harness, or already-current bridge effects.
31. Worker-control and inference authenticate through distinct lease-owned lowercase SHA-256 projections per active Turn with no durable raw token or `sandboxBindingRef` derivation, reject sibling and cross-family use, and survive NanoCore restart only with exact live lineage; every Turn export remains blocked until accepted `final_status` and proved AgentSession-local quiescence, while uncertain local cleanup drains the Harness and widens to Sandbox deletion and epoch fencing as required.
32. Every initial or successor authoritative physical connection completes exact-body fixed-path readiness and its durable empty `204` before any effect poll. Admission allocation remains the sole generation writer; readiness updates only identity, exact current generation, predecessor fence, and readiness evidence, grants no scheduler capacity, preserves cleanup fences created at or after the predecessor generation, and close or failure fences that exact generation non-ready. A RuntimeTarget has no mutable lease or capacity owner, and no public API, generic route, new owner, module, configuration, dependency, second connection, or fallback is added.
33. One definite ordinary local-owner failure settles and rejects exactly its matched pending effect through the exact `requestId` plus `failureCode=effect_failed` result while the permitted healthy session continues; physical close or eligible definite-result delivery uncertainty reconnects only outside the terminal successor first-poll response window, and every other outer-session failure produces exactly one value-free closed-disposition, stage, fixed-operation, and status diagnostic with no replay or secret/runtime value.
34. Sandbox Integration keeps `127.0.0.1:17891` exclusive to every initial and successor stock Supervisor bridge and binds one separate native HTTP/1 listener at `127.0.0.1:17892` before Harness readiness. After the nested H2 client becomes ready, exact inference bearer requests alone may cross from authenticated native `POST /inference/*` to the one existing H2 session with the semantic 16 MiB request aggregate, transport in-flight and write bounds, byte- and header-preserving SSE or compressed response streaming, backpressure, cancellation, and no local retry; exact loopback proxy bypass, local rejection before outer stream creation, both-listener closure, and existing cleanup are observed.
35. The fixed `image.build/input` response alone carries the accepted pending build's exact inline Dockerfile through the existing one-stream file-data reservation with matching current physical connection, request identity, declared and observed 1-through-268,435,456-byte length, lowercase SHA-256, UTF-8, and at-most-64-KiB releases before any build effect; the bounded command and unchanged JSON result carry no bytes, and failure or reconnect creates no refetch, replay, locator, second record, stream reservation, connection, service, or envelope.
36. One compatible Sandbox retains at least two compatibility-distinct Harnesses and at least two open AgentSessions for distinct Threads, each with an exact Core binding and either an adapter-authorized pending handle before its first Turn or one restricted exact native conversation handle afterward; bounded Turns run concurrently across distinct AgentSessions while each Thread and AgentSession retains at most one active Turn.
37. `SandboxRuntimeRecord`, `HarnessInstanceRecord`, `AgentSessionRuntimeBinding`, and the scheduler Turn execution lease remain distinct private projections; the scheduler lease plus scheduler capacity row are the unique active-Turn grant, Harness active-Turn count is occupancy only, RuntimeTarget has no mutable lease or capacity owner, and idle AgentSessions consume open-session capacity without an active-Turn lease or effect authority.
38. `SandboxCompatibilityKey` rejects incompatible Workspace, responsible-user trust, static filesystem or mount, network, Provider, Vault, credential visibility, aggregate resource, sensitivity, or containment input; `HarnessCompatibilityKey` separates runtime family, adapter, native version, protocol, binary and state layout, plugin, extension, hook, config, environment, capability, or resource-class differences inside an admitted Sandbox; `AgentSessionCompatibilityKey` rejects incompatible continuity.
39. Shared-Sandbox diagnostics claim only the conversation-context and Workspace-write isolation actually proved. They state that logical namespacing is not a security boundary and never claim security and adjudication isolation from co-residency; stronger-risk work selects a separate Sandbox.
40. The Harness accepts only `session.open`, `session.inspect`, `turn.start`, `turn.interrupt`, `session.close`, and `harness.drain`; an unknown operation or caller-supplied command, executable, `argv`, `cwd`, environment, shell text, host path, provider endpoint, raw credential, or working directory produces zero Harness effect. Private `turn.interrupt` is admitted only for `session-continuity`, while `bounded-turn` uses only its existing worker command row; immutable mode and the existing terminal compare-and-set permit exactly one delivery owner and one shared-supervisor signal with no mirroring, fallback, or operation-owned product terminal.
41. Every `turn.start` carries a fresh immutable per-Turn AEP snapshot, Context Package, route credentials, lease, deadline, and sequence; no Sandbox-wide authorization package or credential exists, and sibling or stale credentials fail closed.
42. Exact AgentSession-local interrupt or close preserves a compatible sibling, while unprovable local cleanup stops admission and fences the wider Harness, Sandbox, or Runtime Epoch boundary before capacity returns; restart adopts only exact surviving bindings and otherwise preserves independent truthful outcomes.
43. Off-peak rebuild remains disabled without measured idleness and age thresholds, begins only with zero active Turns, uses ordinary drain and current-generation initialization, services an arriving request through another fresh Sandbox, and on failure advertises no capacity and claims no freshness, security, correctness, or recovery result.
44. Exact `POST /worker-control/harness/poll` and `POST /worker-control/harness/result` run only from the exclusive current Integration nested H2 connection, accept no bearer or client-supplied `x-openkit-harness-binding`, receive exactly one NanoHost-injected current binding on authoritative outer carriage, and add no NanoHost effect, fourth namespace, reverse or second connection, worker command, NanoHost queue, journal, or durable raw credential.
45. In one Harness, Codex AgentSessions for two distinct Threads have distinct private state roots, native handles, children, Turn slots, credentials, and cleanup proofs; a second current binding for either Thread is rejected, each first start settles with a pending handle while interrupt remains deliverable, successful terminal collection plus exact inspection establishes its native thread UUID before reuse, each later Turn may start a new process only with exact UUID resume in that AgentSession root, and closing one AgentSession removes only its state while preserving the sibling.
46. Harness operations use one exact monotonically sequenced unsettled command, deterministic redacted operation identity, atomic Turn-token hash binding at dispatch, dispatched-command non-redelivery, exact result idempotency, changed replay rejection, and same-Harness successor carriage; incomplete delivery, missing result, lost Integration memory, or changed Harness binding becomes `unknown`, stops admission, and widens cleanup without replay. A Harness interrupt never creates or falls back to a durable worker-command row, and a bounded-turn worker interrupt never creates or falls back to a Harness operation.

## Stock Realization Annex

This annex enumerates the pinned stock realization of the Sandbox Transport Requirement and the container-backend boundary. It is deliberately separated so that a realization failure or an upstream change is repaired here, in the realization sections it names, and in the vendor snapshot, without reopening the durable requirements above.

### Pinned Surface

| Consumed surface | Pinned realization |
| --- | --- |
| Release boundary | Official unmodified OpenShell `v0.0.99` for the Gateway executable, exact Tier-2 Supervisor OCI image, CLI, client SDK or protobuf snapshot, provider and policy surfaces, and every other consumed artifact |
| Sandbox lifecycle | Stock unary `CreateSandbox`, `GetSandbox`, `ListSandboxes`, and `DeleteSandbox` operations over one epoch-local authenticated Gateway channel |
| NanoHost-side forward | One `ForwardTcp` bidirectional stream carrying `TcpForwardFrame`, opened with the current sandbox, the fixed Integration loopback target, a bounded service identifier, and the stock target authorization material, which is Gateway-issued SSH-session material obtained through `CreateSshSession` and revoked or discarded through `RevokeSshSession` on bridge closure, remaining inside the NanoHost/Gateway boundary at all times |
| Fixed single-file effects | One `ExecSandboxInteractive` bidirectional RPC use over the authenticated mTLS client and current ready sandbox; the helper completes from declared length while NanoHost retains the request sender through exact Exit and clean response, and its pinned opaque internal SSH relay exposes no OpenKit SSH surface |
| Fixed Sandbox Integration bootstrap | One unary-request/server-streaming `ExecSandbox` use over the same client and Sandbox carries empty stdin plus request EOF before execution and retains the response as the Integration-lifetime monitor |
| Gateway pairing | One `RelayOpen` on the current sandbox's `ConnectSupervisor` stream, paired by Gateway-allocated channel id |
| Supervisor-side stream | One `RelayStream` carrying `RelayFrame`, initiated by the stock Supervisor after `RelayOpen` |
| Target restriction | Loopback-only forward target, matching the pinned release's documented target restriction |
| Container backend | Dedicated `dockerd` and its dedicated `containerd` with NanoHost-private roots, sockets, and networks, as foreground service-cgroup members |

The consumed RPC root set for pin completeness resolves to exactly eleven machine-resolvable names: `CreateSandbox`, `GetSandbox`, `ListSandboxes`, `DeleteSandbox`, `ForwardTcp`, `ExecSandbox`, `ExecSandboxInteractive`, `ConnectSupervisor`, `RelayStream`, `CreateSshSession`, and `RevokeSshSession`. The first seven are NanoHost-called lifecycle, forwarding, bootstrap, and fixed-interactive-effect roots; `ConnectSupervisor` and `RelayStream` realize the pinned pairing and relay surfaces. `CreateSshSession` and `RevokeSshSession` are included because `ForwardTcp`'s stock target-authorization material is Gateway-issued SSH-session material that remains inside the NanoHost/Gateway boundary and is revoked or discarded on bridge closure. `ExecSandbox` owns only the unary worker bootstrap/response monitor, and `ExecSandboxInteractive` owns only the single-file helper; their existing transitive closure adds no root. This root set states which protocol roots are consumed for pin completeness; it does not enumerate, and MUST NOT be read as enumerating, an exhaustive consumed implementation-file boundary.

### Pin Manifest Location

The OpenShell pin is recorded in one manifest inside `apps/nanohost`, beside the only code that consumes it, not in a vendored snapshot package. A separate TypeScript workspace package holding a pin for a Rust application would be a cross-language indirection with no consumer once the legacy CLI path is deleted.

The manifest records the exact tag and resolved commit, the consumed machine-readable interface definitions themselves with an individual checksum for each one, the checksum identity of every consumed artifact — Gateway executable, published Supervisor OCI index and both supported platform manifests, and the CLI retained for installation and diagnostics — and the observed upstream constants below. Everything else about the boundary is expressed as code: the pinned client source and `Cargo.lock` make a signature change a build failure, and the readiness contract makes an artifact-digest mismatch a non-ready condition. Those two are the primary freeze; the manifest exists for what neither can express. The declared dedicated-`dockerd` deployment preserves published Supervisor index `sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6` as release evidence and selects only its exact `linux/amd64` child `sha256:4adea8392a81ef34b3cc3284e693ac3cc6c13362fad84a492d95b53b3eb403b9` or `linux/arm64` child `sha256:b548fd939331d830cd9197f20fca9a5d95383c5e67f64929d632a37403115f38` through the private Gateway's existing `supervisor_image` field at Tier 2. The stock Docker driver extracts and caches the selected image's static-musl `/openshell-sandbox`; the multi-platform index is not used as a local image alias, and the release-archive GNU sibling and every later fallback tier are outside the consumed boundary and MUST NOT be selected.

The candidate resolved commit for the lightweight `v0.0.99` tag is `8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032`, obtained from the upstream ref listing rather than observed as evidence at the pin. Before production use, the tag-to-commit resolution MUST be re-confirmed from a complete non-shallow clone of the immutable tag and recorded in the manifest in the same way as the upstream constants below.

The following asset set is a candidate observation read from the upstream release surface rather than evidence observed at the pin, and it MUST be re-confirmed under `### Pinned-Boundary Evidence Quality` before production use on the same terms as the resolved commit above. The official non-draft, non-prerelease GitHub Release published on 2026-08-05 carries `openshell-gateway-aarch64-unknown-linux-gnu.tar.gz`, `openshell-gateway-x86_64-unknown-linux-gnu.tar.gz`, `openshell-sandbox-aarch64-unknown-linux-gnu.tar.gz`, `openshell-sandbox-x86_64-unknown-linux-gnu.tar.gz`, `openshell-aarch64-unknown-linux-musl.tar.gz`, and the three corresponding `*-checksums-sha256.txt` files needed to verify the consumed release artifacts.

The standing re-pin obligation from `docs/specs/20260522-vendor_snapshot_packages.md` follows the pin into this manifest.

Both client paths preserve the consumed interface definitions inside the `apps/nanohost` pin manifest with an individual checksum for each one; that content rule at `:1146` and the realization gate at `:1167` apply unconditionally and do not vary by client path, so neither path leaves an in-repository consumed surface missing. The difference that remains between the two paths is build enforcement, not consumed surface: on the generated-client path the vendored definitions are codegen inputs, so upstream interface drift breaks the NanoHost build; on the SDK path the definitions remain checksummed re-pin evidence that the NanoHost build does not consume, while the pinned SDK source and `Cargo.lock` enforce the client boundary at build time instead. That build-enforcement difference MAY be weighed in the client-selection record; it MUST NOT be stated as a missing in-repository consumed surface, and this annex does not delegate weighing it as a mandatory selection input.

### Observed Upstream Constants

These values are upstream implementation behavior rather than protocol contract. Each MUST be re-observed at the pin and recorded in the pin manifest before production use, and an implementation MUST NOT assume a value this annex has not confirmed at the pin.

- The pending-claim timeout after which the Gateway reaps an unclaimed relay slot, observed as ten seconds at the current evidence boundary.
- The forward and relay chunk sizes and the Gateway pairing-buffer size.
- Adaptive HTTP/2 window behavior on the Gateway and client sides, which the transport envelope's explicit accounting must complement rather than depend on.
- The presence or absence of per-RPC authorization annotations and secret marking on the forward-target authorization field.
- For `ExecSandboxInteractive`: the exact handler authentication and current-ready-sandbox authorization, 1 MiB decoded inbound cap, `open_relay(Target::Ssh)`, single-use Gateway-internal loopback proxy, unchecked internal server key, `authenticate_none("sandbox")`, Supervisor Unix-socket and peer-PID behavior, data/extended-data/exit event mapping, keepalive and timeout, response-drop behavior, and missing-exit classification.

### Realization Gate

The realization gate is mandatory and blocking. Before production implementation opens, immutable official `v0.0.99` source, preservation of the consumed machine-readable interface definitions inside the `apps/nanohost` pin manifest with an individual checksum for each definition, and real local and remote observations MUST prove the named APIs, authentication, channel reuse, target restriction, role direction, one-pair steady state, bidirectional HTTP/2 behavior, the fixed no-early-EOF `ExecSandboxInteractive` single-file helper and its opaque internal-relay closure, the timeout-zero unary `ExecSandbox` Sandbox Integration bootstrap with empty stdin, request EOF, and retained Integration-lifetime response monitoring concurrent with `ForwardTcp`, event and terminal semantics, cancellation-not-kill, flow control, bounded intermediate buffering, predecessor closure, failure propagation, the transport envelope under saturation, and complete failure-group termination.

Which document owns this interface-integrity rule is settled by a separate accepted change that is a blocking implementation precondition; this gate states only the existing proof requirement.

A missing, different, indeterminate, or weaker stock mechanism blocks implementation and returns the design to this annex and its owning specification. It MUST NOT be substituted with an OpenKit protocol, an OpenShell fork or patch, a private Supervisor, an arbitrary tunnel or proxy, direct Gateway exposure, a CLI settlement path, visible or configurable SSH, or a weaker transport. The exact pinned opaque internal SSH relay beneath the fixed single-file `ExecSandboxInteractive` use is the sole exception and does not authorize another SSH use.

### Candidate Alternative Realizations

The realization gate has a blocking failure disposition and, until now, no identified alternative. That combination makes a gate failure open-ended: nobody could tell in advance whether a failure means a bounded detour or a redesign. This subsection prices the failure.

Everything here is **non-authorizing**. These are candidates for reconsideration if the gate fails, not approved options, and none may be implemented, prepared for, or assumed by any work package. Listing them creates no schema, configuration, dependency, or compatibility obligation, and selecting one requires the ordinary amendment and acceptance path.

Ordered by how little each disturbs the accepted requirement:

1. **One stock pair per route family instead of one nested session.** If the relay works as a byte pipe but a nested HTTP/2 session over it does not, give each route family its own `ForwardTcp`/`RelayStream` pair and run the simplest sufficient protocol on each. Worker-control is pull-only and unary, so it does not need HTTP/2 at all. Keeps stock mechanism and adds no OpenKit protocol; loses one-pair-per-sandbox and requires a revised envelope. Cheapest candidate, and the one the bounded conditional worker-control fallback already partially anticipates.
2. **Stock interactive exec as the nested route byte path.** Carry the long-lived route session over the pinned release's bidirectional sandbox exec RPC instead of `ForwardTcp`. This remains non-authorizing and weaker for route transport because exec was not designed for a long-lived session; it is distinct from the accepted short bounded single-file effect above.
3. **A NanoHost listener reachable only from the epoch's private network.** Let Sandbox Integration dial the NanoHost over an epoch-private network path rather than through the Gateway relay. This is adjacent to the rejected direct-endpoint topology and MUST NOT be confused with it: the rejection was of NanoCore-reachable Sandbox endpoints and operator-managed forwards, whereas this is a host-local listener inside one epoch's own network boundary. It reopens a host-to-Sandbox security and adjudication isolation question that the accepted design closed, so it requires proof at that level plus policy proof before it could be considered.
4. **Decouple the transport decision from the shared-epoch decision.** The accepted design bundles two independent choices: where OpenShell lifecycle authority lives, and how the sandbox reaches the NanoHost. A gate failure on the second does not invalidate the first, so a candidate keeps the NanoHost-owned Runtime Epoch and reverts only the transport to a previously proved shape.
5. **Escalate the requirement upstream and pin a later release.** File the required behaviour with the upstream project and re-pin once it exists. The pin manifest and re-pin obligation make this absorbable; the cost is a schedule dependency on an external project.

The unconditional prohibition stated by the realization gate above governs every candidate here and is not narrowed by the restatement that follows: the restatement is subordinate to that prohibition, adds nothing to it, and removes nothing from it, so a mechanism the gate bars stays barred even if it is absent below. These remain rejected and stay rejected in every candidate: an OpenShell fork or patch, a private Supervisor, an OpenKit frame multiplexer or private reconnect protocol, an arbitrary tunnel or proxy, direct Gateway exposure to NanoCore or a public network, and every OpenKit-managed, exposed, configured, or caller-selected SSH runtime path. The one pinned opaque internal relay beneath the already-selected single-file Interactive use is not a candidate and creates no further exception.

### Re-Pin Obligation

Changing the pinned release is not a version bump. Any change to the pinned OpenShell release MUST re-run the realization gate for every item in this annex before the new pin becomes selectable.

This documentation re-pin does not discharge the standing re-pin obligation: the realization gate has never run at any pin, so there is no prior gate result to invalidate, preserve, or carry forward.

The snapshot refresh procedure, evidence quality, consumed-interface-definition content, recorded implementation values, and the standing obligation that a pin change re-runs its consumer's gate are owned by `docs/specs/20260522-vendor_snapshot_packages.md`. This annex defines only which gate must be re-run and what it must prove; it MUST NOT restate the snapshot procedure.

A deployment whose consumed artifacts do not all resolve to one exact pinned release remains non-ready.

## Alternatives Considered

### Keep One Disposable Cell Per AgentSession

Rejected for the target because moving lifecycle authority onto the execution host lets local OpenShell operations survive NanoCore outage and makes per-session Gateway and container-runtime cold start unnecessary. The retained late-create and fresh-empty safety properties move to the Runtime Epoch.

### Rebuild Only The Failed Sandbox

Rejected when create or delete completion is uncertain because an older accepted operation may still reach the shared container runtime after resource-local cleanup. The complete epoch is the smallest proved causal fence available under the accepted stock boundary.

### Restart Only The Failed Gateway Or Container Runtime

Rejected because independent member recovery breaks the one-generation ownership proof and may leave sibling processes or requests capable of completing old effects.

### Develop An OpenKit Multiplex Protocol

Rejected because stock RelayStream plus standard HTTP/2 is the accepted target. If stock feasibility fails, the design returns for reconsideration rather than adding a private frame layer.

### Use SSH And Gateway Forwarding As The Remote Protocol

Rejected because it creates parallel control paths, requires NanoCore-initiated management reachability, and leaves lifecycle logic split across NanoCore, operator tunnels, and the execution host.

### Add A Durable NanoHost Operation Journal

Rejected for V1 because whole-epoch invalidation is smaller and safer than reconstructing an uncertain local OpenShell effect. Measured recovery cost and an accepted causal-operation contract are required before reconsideration.

### Implement The NanoHost In TypeScript

Not selected for V1. TypeScript can express every required mechanism — bidirectional gRPC streaming, an HTTP/2 server over an arbitrary duplex stream, foreground child ownership — and the fail-stop guarantee comes from the OS service manager rather than the language, so this alternative is rejected on deployment shape rather than on capability. The reasons are recorded under Implementation Language Decision: a self-contained execution-host binary, resident footprint beside a container backend, direct reuse of the upstream Rust client surface, and explicit flow-control control. TypeScript remains the recorded reversion target under the condition stated there, and it remains the owner of NanoCore and Sandbox Integration.

### Implement The NanoHost In Go

Rejected because Go removes no required mechanism and cannot reuse the upstream Rust client surface. It would still require exact protobuf generation while adding a second optional toolchain with no advantage over the selected stack for this boundary, and it is not the recorded reversion target.

### Instantiate Every Supported Container Backend Per Epoch

Rejected because stock OpenShell can drive more than one backend but a NanoHost needs exactly one. Starting private roots for backends the deployment does not use would multiply epoch creation cost, daemon-escape surface, empty-state proofs, and image-import work for no capability, and would make the rebuild budget unachievable. Backend breadth is a configuration-time selection, not a per-epoch instantiation.

### Configure An External Orchestrator Backend Now

Rejected for V1 because complete control-group termination is this specification's causal fence, and it does not reach an effect domain owned by a remote scheduler or node agent. A previously accepted create could still be completed after the NanoHost group is killed, which is exactly the failure the fence exists to prevent. Such a backend requires its own accepted fencing, generation identity, and admission-block contract before it may be configured.

### Retrieve Or Build Images During Readiness

Rejected because it would put network retrieval and image construction on the readiness path, make the rebuild budget depend on a registry and a build, and give a slow or unavailable registry the power to hold capacity fenced. Acquisition writes to the epoch-external store; readiness only imports by digest.

### Rely On HTTP/2 Stream Priority For Route Separation

Rejected because the RFC 9113 priority scheme is deprecated and is not meaningfully implemented by the accepted server or client stacks. Naming it as the route-separation mechanism would leave the worker-control liveness requirement without any mechanism at all. Stream reservation, explicit flow-control accounting, and bounded chunking are used instead, and they are measured rather than assumed. This supports conversation-context isolation and makes no security and adjudication isolation claim.

### Rotate The NanoHost Token Through One Sink Location

Rejected because a single sink forces a choice between destroying the predecessor secret, which makes rotation abort impossible, and introducing a new sink location, which is a configuration change and therefore an epoch replacement that interrupts running AgentSessions. A stable pair of slots outside epoch identity makes rotation non-disruptive and reversible.

### Keep A Durable Journal Instead Of A Forensic Report

Rejected because the two solve different problems. A durable operation journal would claim the ability to resume or settle an uncertain external effect, which V1 explicitly refuses. The Epoch Invalidation Report only explains a completed invalidation to humans and audits and is prohibited from informing any recovery, readiness, or capacity decision.

### Compile The Gateway Server Into The NanoHost

Rejected because it would replace the checksum-verifiable stock Gateway artifact with an OpenKit build, depend on upstream internal server crates, merge Gateway state and credentials into the NanoHost service process, and weaken independent process identity and upgrade evidence. Compiling the client contract into NanoHost is analogous to a database client; compiling the Gateway server would absorb the backend itself.

### Drive Normal Operations Through OpenShell CLI Subprocesses

Rejected because a per-operation subprocess cannot own the required one-channel steady state, long-lived `ForwardTcp` stream, cancellation and predecessor semantics, or typed operation result without parsing a presentation surface. The CLI remains installation and diagnostics tooling only.

## Consequences

### Benefits

- NanoCore restart no longer tears down healthy local execution or cancels local OpenShell operations.
- Gateway and container-runtime cold start moves from every AgentSession to epoch recovery.
- External network configuration contracts to one NanoCore-to-NanoHost session; the NanoHost internally owns one loopback Gateway client channel and one stock `ForwardTcp`/`RelayStream` pair per active sandbox without operator-managed forwarding.
- Cell-specific ownership, SSH lifecycle, operator-managed Gateway forwarding, and direct sandbox endpoints are deleted after cutover.
- NanoCore sheds its execution-effect workload: no OpenShell lifecycle, no container-runtime calls, no file materialization, no SSH, and no execution-host filesystem effects.
- Late-create fencing and fresh-empty readiness remain explicit and testable.
- The official Gateway remains independently installable and checksum-verifiable while NanoHost reuses only its exact client contract.

### Costs

- Every AgentSession in one Runtime Epoch shares that infrastructure failure domain.
- Any unprovable create or delete interrupts all AgentSessions in the epoch and rebuilds the full runtime.
- The OS supervisor becomes strict-risk infrastructure and must prove complete group termination.
- The repository gains one app-local Rust toolchain and Cargo dependency graph that must be pinned, built, linted, tested, and included in release verification.
- Route separation, flow control, and backpressure must remain correct on shared HTTP/2 connections; this supports conversation-context isolation and makes no security and adjudication isolation claim.
- The accepted stock `ForwardTcp`/`RelayStream` bridge projection may prove infeasible and block implementation.
- Nested flow control across the relay and both HTTP/2 sessions is the design's hardest correctness-under-load property and requires measurement rather than reasoning.
- The NanoHost Image Store adds durable execution-host disk whose size is a function of retained image digests and build cache.
- An authorized build path puts a bounded build capability on the execution host, which must preserve host-to-build security and adjudication isolation and stay inside its target Sandbox's network authority.
- Supporting a future non-host-local backend requires a new fencing contract, not a configuration value.

This design sheds NanoCore's effect workload and deliberately sheds none of its decision workload. Admission, policy, permission, provider selection, review, acceptance, and terminal meaning stay where they are, and the produced-fact buffer defers delivery without deferring any decision. If NanoCore becomes decision-bound, the accepted responses are fewer decisions per Turn or more capacity for NanoCore; moving a decision to the NanoHost is not among them, because that is the authority descent the Core doctrine prohibits.

For the current dogfood profile of one NanoHost, multiple compatibility-keyed Harnesses, multiple open AgentSessions, and bounded concurrent Turns inside a Sandbox, the shared blast radius is an intentional simplification. Future smaller blast radius is obtained by multiple independent NanoHosts or separate Sandboxes, not by reintroducing one Cell or Runtime Epoch per AgentSession.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| A late create completes after cleanup | Put every effect-capable process in one fail-stop group; invalidate on uncertainty; prove old effects impossible before fresh readiness. |
| Supervisor restarts one member in place | Treat independent restart or identity change as whole-epoch invalidation and prohibit member-local readiness recovery. |
| Two NanoHost connections both act | Fence or reject the predecessor before the successor carries any work and reject all late predecessor traffic. |
| Shared transport merges authority | Use distinct token classes, scopes, bounds, retries, failure meanings, usage, and audit owners for each route family. |
| Inference load blocks worker control | Reserve per-family streams, enforce per-family in-flight ceilings, and bound chunking without inventing cross-route semantics. |
| Bulk data overwhelms control transport | Keep bytes on native or bounded data-transfer mechanisms and carry only exact references and bounded manifests. |
| NanoHost credential leaks into worker context | Keep it NanoHost-local, exclude it from AEP and sandbox bindings, redact diagnostics, and revoke the dedicated NanoHost Token through the lifecycle owned here. |
| NanoHost-to-Gateway bridge becomes another configurable tunnel | Fix the Integration target and route table, keep Gateway and target authorization epoch-local, expose no listener, accept no caller-selected origin, and permit exactly one current pair per sandbox unless the measurement-gated worker-control fallback is authorized. |
| Exact `v0.0.99` SDK lacks the required raw forwarding surface | Generate only the minimum Tonic client from the exact refreshed protobuf snapshot; block if the stock protocol itself is absent or weaker. |
| Gateway or runtime daemonizes outside the epoch cgroup | Require foreground execution and observed cgroup membership; fail the stock-feasibility gate if any effect-capable process can escape group termination. |
| Rust transport types become a second protocol owner | Consume committed projections and conformance fixtures from existing protocol owners and reject independent Rust schema evolution. |
| Stock `ForwardTcp`/`RelayStream` bridge cannot carry the target | Block implementation at the mandatory feasibility gate; do not fork, patch, tunnel, or add a custom mux. |
| NanoHost becomes a second Core | Restrict it to local execution effects and projections of already-authorized work; keep all durable product and policy authority in existing owners. |
| Load shedding becomes authority shedding | Shed effect workload only; buffer produced facts, cache no received authority, and treat a decision-bound NanoCore as a capacity or decision-count problem rather than a placement problem. |
| A buffer becomes a journal | Bound it by size and age, keep it produced-facts-only, kill it with the epoch, and prohibit any recovery, readiness, or capacity decision from reading it. |
| Outage tolerance is oversold | State the two guarantees separately, keep inference availability during an outage at zero, and forbid a local provider path or cached response as a remedy. |
| Nested flow control stalls or buffers without bound | Enforce explicit per-stream windows, per-family in-flight ceilings, and bounded chunking; measure throughput, added latency, and peak buffering at the realization gate and fail the gate if buffering is unbounded. |
| Worker control is starved by inference load | Reserve worker-control streams and connection-window headroom that no other family may consume, bound interrupt and heartbeat latency numerically under saturation, and authorize a second dedicated worker-control stream only on recorded measurement failure. |
| Epoch rebuild is more expensive than per-AgentSession cold start | Keep verified image content in an epoch-external digest-addressed store, import by digest only, budget rebuild time, and treat sustained violation as falsification of the shared-epoch premise rather than an operational note. |
| Credential rotation interrupts running work | Keep the two NanoHost Token slots stable and outside epoch identity, write the successor to the non-active slot, and prohibit rotation from invalidating a healthy epoch. |
| Bridge recovery silently consumes the worker outage budget | Bound successor establishment, require it to leave at least half the budget unconsumed, and report route failure through existing owners when the bound is exceeded. |
| An epoch invalidation becomes undiagnosable | Export a bounded redacted Epoch Invalidation Report before termination, and prohibit it from informing recovery, readiness, or capacity so it cannot become a journal. |
| A build definition becomes a host execution primitive | Consume it only as backend build input, deny host mounts, host network, and credential access, enforce 30 minutes, 20 GiB OCI output, declared `layerLimit`, and the 128-layer hard maximum, keep the fixed OCI pair branch separate from exact AEP `{host, port}` `RUN` grants, and reject undeclared redirect destinations. |
| Backend breadth becomes per-epoch cost or a driver framework | Configure exactly one backend, instantiate only that one, and require a separate accepted realization contract for each additional backend. |
| An external orchestrator backend escapes the fence | Classify every backend effect domain before configuration and refuse a non-host-local domain until its own generation-scoped fencing contract is accepted. |

## Open Questions

There are no open design questions in the accepted contract. Three items are measured preconditions with explicit blocking dispositions rather than unresolved design choices: pinned-stock bridge feasibility and its evidence quality under the Stock Realization Annex, the transport envelope under saturating inference load, and the epoch rebuild budget with its falsifiable premise. Each has a named owner, a numeric or evidentiary bound, and a defined response to failure.

## Deferred / Future Work

- Multiple independently configured NanoHosts after a measured capacity, security and adjudication isolation, compliance, or blast-radius need exists.
- Remote attestation, active-active execution, automatic failover, session migration, cross-Workspace warm pools, and fleet scheduling under separate accepted architecture.
- A smaller-than-epoch causal fence only after pinned stock OpenShell exposes a proved operation identity and cancellation or teardown contract.
- A durable NanoHost operation journal only after a concrete availability requirement justifies its identity, recovery, uncertainty, and audit model.
- A Podman container backend after its own accepted realization contract defines its process shape, private-root layout, rootless posture, image-import path, and fail-stop proof.
- A Kubernetes or other external-effect-domain backend only after a separate accepted specification defines its generation-scoped fencing primitive, admission block, and proof that no prior-generation object can mutate the new generation.
- Backend selection breadth beyond one configured backend per NanoHost, and any backend abstraction layer, only after a second accepted realization contract exists and a present need requires switching.
- Backend command push for worker control only after the worker-control owner and this specification jointly define its inbound path, role assignment, and fencing.

Deferred work is non-authorizing and creates no current schema, configuration, service, state, dependency, runner, harness, or compatibility obligation.

## Links

- `docs/core/communication.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/sandbox.md`
- `docs/specs/20260801-nanohost_workspace_data_boundary.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/toolchain.md`
- `docs/cookbooks/rust-setup.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260708-container_image_packaging.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
