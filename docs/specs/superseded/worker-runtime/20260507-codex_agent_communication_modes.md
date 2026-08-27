---
status: Superseded
implementation: N/A
status-changed: 2026-07-03
current-guidance: "`docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260703-worker_control_protocol.md`, `docs/specs/20260703-worker_agent_capability.md`, `docs/specs/20260703-workspace_synchronization.md`"
decision-evidence: "`docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260703-worker_control_protocol.md`, `docs/specs/20260703-worker_agent_capability.md`, `docs/specs/20260703-workspace_synchronization.md`"
date: 2026-05-07
---
# Codex Agent Communication Modes


## Lifecycle Reason

The current runtime communication, worker control, capability, and workspace synchronization contracts divided and absorbed the four communication planes under explicit owners. This Codex-centered mode matrix lost authority because runtime placement and transport translation now follow those cross-runtime contracts rather than one adapter-specific design.

## Retention Reason

This document preserves the original four-plane analysis, deployment comparison, and Codex app-server integration constraints so adapter maintainers can audit earlier transport decisions without treating Codex-specific modes as the current Worker Agent contract.

This document is an implementation-layer spec for Codex-style agent communication modes.

The stable core and deployment guidance lives in `docs/core/communication.md`, `docs/deployment.md`, `docs/core/runtime-model.md`, and `docs/specs/20260629-worker_runtime_communication_model.md`.

## Summary

This spec originally defined how the Core server communicates with a Codex-based agent across host, local-container, and remote-container shapes. The current product runtime removes host execution and uses governed containers for real Worker Agents. Codex remains a useful reference agent because its `app-server` JSON-RPC surface is a well-documented integration target; runtime-native details now belong behind worker-side adapters.

The central design principle is a **four-plane separation** of communication concerns, mapped onto the cleanest available transport per plane in each deployment mode. Agents see a uniform interface regardless of where they run, and the `apps/nanocore` adapter layer absorbs all transport variation.

## Goals

- Define a single, opinionated communication architecture for Codex agents in local and remote container deployments.
- Keep the agent process unaware of its own deployment mode wherever possible.
- Separate four kinds of traffic with very different shapes (control, workspace, artifact, capability) so that no single transport carries them all.
- Specify the role and boundary of a sidecar `openkit-bridge` process used in container deployments.
- Historical alignment referenced the [Agent Setup And Runtime Supply Contract](../20260628-agent_setup_runtime_supply_contract.md), `docs/core/architecture.md`, `docs/core/protocol.md`, and `docs/core/communication.md`.
- Codex-specific decisions (transport choice, schema source, auth) should be reusable lessons for future agents, not Codex-only quirks.

## Non-goals

- Define the internal `Core <-> Agent` adapter API surface in detail. That belongs to the host agent adapter spec; this spec only defines what travels under it.
- Standardise on ACP, A2A, or MCP as a wire format between Core and agent runtimes.
- Specify the `openkit-bridge` wire format with full schema. This spec defines its responsibilities and structural shape; a follow-up spec will define the bridge protocol.
- Solve multi-tenant scheduling, persistence, or production authentication. The historical v0.0.1 constraints still apply.
- Implement remote container support in the first iteration. The mode is fully designed here so it does not require redesign later.

## Background

The architecture establishes that Core orchestrates and agents execute, with adapters bridging the two. Codex exposes an official JSON-RPC server (`codex app-server`) over `stdio`, `unix://`, or `ws://`, plus a TypeScript SDK and a Python SDK. We have decided in design discussion that:

1. The control transport between Core and a Codex agent is **always `codex app-server` JSON-RPC**, not the Codex SDK or any ACP shim. The SDK is rejected because it adds a wrapper without removing work; ACP via `zed-industries/codex-acp` is rejected because it is a community-maintained second-order shim and adds an extra translation layer.
2. The single transport stack (one `CodexAppServerClient`, multiple `Transport` implementations) covers stdio for local processes, `docker exec`/`ssh exec` stdio for containers, and ws as a fallback when exec is unavailable.
3. Workspace files and generated artifacts must not travel through JSON-RPC. They are large, bursty, and well served by file-sync tools such as bind mounts, rsync, or object storage.
4. Agent access to LLM providers, MCP servers, third-party APIs, vault credentials, and the knowledge base must not travel through SSH tunnels. It belongs on its own plane via a sidecar bridge process inside the container, exposing standard localhost endpoints to the agent and connecting to Core over HTTPS+mTLS.

This spec consolidates those decisions into one reference architecture across all three deployment modes.

## Proposed Design

### 1. The Four Planes

Agent traffic falls into four categories with distinct shapes. They must not share a transport.

```
╭──────────────────┬──────────────────┬──────────────────┬──────────────────╮
│ Control          │ Workspace        │ Artifact         │ Capability       │
├──────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ JSON-RPC         │ user files       │ generated        │ LLM, MCP, vault, │
│ approvals        │ (source, data,   │ outputs          │ KB, external API,│
│ events, deltas   │  attachments)    │ (reports, diffs, │ network proxy    │
│                  │                  │  bundles)        │                  │
├──────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ small streaming  │ bulk, bursty     │ bulk, bursty     │ varied,          │
│ continuous       │ at turn boundary │ at turn end      │ multi-stream     │
│ latency-sensitive│ throughput-bound │ throughput-bound │ concurrent       │
├──────────────────┼──────────────────┼──────────────────┼──────────────────┤
│ stdio JSON-RPC   │ direct fs / bind │ direct fs / bind │ direct in-proc / │
│ (over SSH or     │ mount / rsync /  │ mount / rsync /  │ HTTPS+mTLS via   │
│  docker exec)    │ object store     │ object store     │ sidecar bridge   │
╰──────────────────┴──────────────────┴──────────────────┴──────────────────╯
```

The adapter is responsible for choosing the transport per plane based on the deployment mode declared in the agent manifest and for coordinating cross-plane timing at turn boundaries.

### 2. Codex As The Reference Agent

Codex is selected as the canonical reference because:

- `codex app-server` exposes a stable JSON-RPC 2.0 surface with three transport options (stdio, unix, ws).
- Schema is generated from source via `codex app-server generate-ts` and `codex app-server generate-json-schema`, giving us a single typed source of truth that we can pin per Codex version and diff in CI.
- Its primitives (`Thread`, `Turn`, `Item`, approvals) are nearly isomorphic to the `UI <-> Core` protocol primitives. Translation cost in the adapter is small.
- It supports server-initiated approval requests, mid-turn `turn/interrupt`, and `thread/resume`. These are protocol features we want to exercise in phase 1.
- It is a real product binary that can be packaged into a container image for the `local` and `remote` modes without modification.

We do not use `@openai/codex-sdk` inside the adapter. We do not use the Zed `codex-acp` shim. We talk to `app-server` directly with our own JSON-RPC client and our own transport implementations.

### 3. Mode A: `host`

Codex runs as a child process directly on the same OS user as Core. There is no container, no remote host, and no sidecar bridge. This is the default phase-1 mode and the path covered by [20260416-host_agent_adapter.md](../../superseded/worker-runtime/20260416-host_agent_adapter.md).

```
╭────────────────────────── host machine ──────────────────────────╮
│                                                                  │
│  ╭────────────────────────────────────────────────────────────╮  │
│  │ Core process                                               │  │
│  │                                                            │  │
│  │  CodexAppServerClient ◀──╮                                 │  │
│  │                          │ stdio JSON-RPC                  │  │
│  │  LLM proxy / MCP proxy   │                                 │  │
│  │  Vault / KB / Audit      │ in-process function calls       │  │
│  │  Workspace store         │ via openkit-bridge module       │  │
│  │  Artifact store          │                                 │  │
│  ╰────────────┬─────────────┴─────────────────────────────────╯  │
│               │ spawn child process                              │
│               ▼                                                  │
│  ╭────────────────────────────────────────────────────────────╮  │
│  │ codex app-server --listen stdio://                         │  │
│  │                                                            │  │
│  │  cwd: user workspace directory (direct fs access)          │  │
│  │  env: OPENAI_BASE_URL=http://localhost:<port>              │  │
│  │       MCP_GATEWAY=http://localhost:<port>                  │  │
│  │       HTTPS_PROXY=http://localhost:<port>                  │  │
│  │       (bridge endpoints served by Core over loopback)      │  │
│  ╰────────────────────────────────────────────────────────────╯  │
╰──────────────────────────────────────────────────────────────────╯
```

Per-plane mapping in `host` mode:

| plane       | mechanism                                                                 |
| ----------- | ------------------------------------------------------------------------- |
| Control     | `stdio` JSONL, parent/child pipes (`StdioTransport({ command: ["codex", "app-server", "--listen", "stdio://"] })`) |
| Workspace   | direct filesystem access; Codex reads and writes the user's workspace directory under its `cwd` |
| Artifact    | direct filesystem access; agent writes to `<workspace>/.artifacts/`, Core registers and exposes by path |
| Capability  | Core exposes loopback HTTP endpoints (LLM-compat, MCP-compat, forward proxy) implemented as in-process modules; `openkit-bridge` is **not** a separate process in `host` mode but the same logical surface served by Core's own HTTP listener |

Notes:

- Even in `host` mode, the agent accesses LLM and MCP through localhost endpoints, not by direct provider calls. This keeps vault, audit, rate-limiting, and provider routing centralised. The endpoints in `host` mode are served directly by Core; in container modes the same endpoints are served by the sidecar bridge.
- Approvals and interrupts ride the same control stream as in container modes. There is no platform-specific path.
- Process supervision, sticky thread binding, and the agent session state machine all follow [20260416-host_agent_adapter.md](../../superseded/worker-runtime/20260416-host_agent_adapter.md).

### 4. Mode B: `local` (container on same machine)

Codex runs inside a container on the same machine as Core. The `openkit-bridge` becomes a real sidecar process colocated with Codex. Volumes mount the workspace and artifact directories into the container. SSH is **not** used in this mode.

```
╭──────────────────────── host machine ────────────────────────────────╮
│                                                                      │
│  ╭──────────────────────────────────────╮                            │
│  │ Core process                         │                            │
│  │                                      │                            │
│  │  CodexAppServerClient ─────╮         │                            │
│  │  LLM proxy / MCP proxy     │         │                            │
│  │  Vault / KB / Audit        │         │                            │
│  │  Workspace store            │         │                            │
│  │  Artifact store            │         │                            │
│  │  Bridge server (HTTPS)     │         │                            │
│  ╰─────────┬──────┬───────────┴─────────╯                            │
│            │      │                                                  │
│            │      │ HTTPS+mTLS over loopback                         │
│            │      │ (capability plane)                               │
│            │      │                                                  │
│            │      ╰────────────────────────────╮                     │
│            │ docker exec -i (control)          │                     │
│            │ bind mount (workspace + artifact) │                     │
│            ▼                                   ▼                     │
│  ╭────────────────────────────────────────────────────────────────╮  │
│  │ container                                                      │  │
│  │                                                                │  │
│  │  ╭───────────────────────────╮     ╭─────────────────────────╮ │  │
│  │  │ codex app-server          │     │ openkit-bridge          │ │  │
│  │  │   --listen stdio://       │     │  :9001 LLM endpoint     │ │  │
│  │  │   cwd=/workspace          │     │  :9002 MCP endpoint     │ │  │
│  │  │   OPENAI_BASE_URL=        │◀───▶│  :9003 KB endpoint      │ │  │
│  │  │     http://127.0.0.1:9001 │  loopback only                │ │  │
│  │  │   MCP_GATEWAY=...         │     │  :9004 forward proxy    │ │  │
│  │  │   HTTPS_PROXY=...         │     │                         │ │  │
│  │  ╰───────────────────────────╯     ╰─────────────────────────╯ │  │
│  │                                                                │  │
│  │  /workspace          ◀── bind mount from <user-cwd>            │  │
│  │  /workspace/.artifacts ◀── bind mount from core artifact store │  │
│  ╰────────────────────────────────────────────────────────────────╯  │
╰──────────────────────────────────────────────────────────────────────╯
```

Per-plane mapping in `local` mode:

| plane       | mechanism                                                                 |
| ----------- | ------------------------------------------------------------------------- |
| Control     | `docker exec -i <container> codex app-server --listen stdio://`; same `StdioTransport` as `host`, only the spawn command changes |
| Workspace   | bind mount of the user's workspace directory into `/workspace` in the container; zero copy, lazy fs access |
| Artifact    | bind mount of an artifact output directory; Core sees writes immediately, no transfer step |
| Capability  | sidecar `openkit-bridge` process inside the container; bridge connects to Core's HTTPS+mTLS bridge endpoint over loopback; agent reaches bridge over container loopback only |

Notes:

- The container image bundles two binaries: `codex` and `openkit-bridge`. The container entrypoint launches the bridge first (so the agent's outbound endpoints are reachable before Codex starts), then waits for Core to attach via `docker exec`.
- The bridge in `local` mode still uses HTTPS+mTLS even though the connection stays on loopback. This keeps the bridge protocol identical to `remote` mode and avoids a special insecure path.
- Vault credentials never enter the container. The bridge requests credentials from Core for each outgoing call and injects them into the upstream request after the agent's request leaves the container.
- The container is started by Core (or by an external orchestrator) before any thread is bound to the agent. Container lifecycle is workspace-scoped; one long-lived `codex app-server` process serves many turns within one workspace, matching the host-adapter sticky-binding model.
- No SSH is involved. `docker exec` runs over the docker daemon socket and avoids SSH key management.

### 5. Mode C: `remote` (container on different host)

Codex runs in a container on a different machine, reachable over the network. This mode reuses every component from `local` mode but swaps `docker exec` for `ssh exec`, replaces bind mounts with rsync over SSH or object storage, and routes the bridge over public network with mTLS.

```
╭──── core host ──────────╮              ╭──── agent host ──────────────╮
│                         │              │                               │
│ ╭─────────────────────╮ │              │ ╭───────────────────────────╮ │
│ │ Core process        │ │              │ │ container                 │ │
│ │                     │ │              │ │                           │ │
│ │ CodexAppServerClient│─┼──ssh────────▶│─│▶ codex app-server         │ │
│ │                     │ │  exec stdio  │ │  --listen stdio://         │ │
│ │ Workspace store     │─┼──rsync──────▶│─│▶ /workspace                │ │
│ │ Artifact store      │◀┼──rsync───────│◀│  /workspace/.artifacts    │ │
│ │                     │ │  (turn       │ │                           │ │
│ │                     │ │   boundary)  │ │                           │ │
│ │                     │ │              │ │                           │ │
│ │ Bridge endpoint     │◀┼──HTTPS/mTLS──│◀│  openkit-bridge (sidecar) │ │
│ │ (LLM/MCP/vault/KB)  │ │  HTTP/2      │ │  loopback to codex        │ │
│ ╰─────────────────────╯ │              │ ╰───────────────────────────╯ │
╰─────────────────────────╯              ╰───────────────────────────────╯
        │                                       │
        │ optional: object store as shared substrate for workspace
        │ and artifact when WAN bandwidth makes rsync impractical
        ▼                                       ▼
              ╭──────────────────────────────────╮
              │ S3 / R2 / GCS / Azure Blob       │
              ╰──────────────────────────────────╯
```

Per-plane mapping in `remote` mode:

| plane       | mechanism                                                                 |
| ----------- | ------------------------------------------------------------------------- |
| Control     | `ssh -o ControlMaster=auto -o ControlPath=... user@agent-host codex app-server --listen stdio://`; long-lived process per workspace; still the same `StdioTransport` |
| Workspace   | LAN: `rsync -e ssh` push at turn start, reusing the SSH ControlMaster; WAN: object store as source of truth, container pulls at turn start |
| Artifact    | LAN: `rsync -e ssh` pull when an `artifact-reference` Item appears; WAN: container writes to object store, Core reads by reference |
| Capability  | sidecar `openkit-bridge` connects to Core's public bridge endpoint over HTTPS+mTLS; HTTP/2 multiplexes per-service streams; bridge endpoint URL injected into the container at start time |

Notes:

- The control transport is SSH stdio, not WebSocket. The Codex `ws://` listener is currently marked experimental and unsupported. WebSocket is described in "Alternatives Considered" as a fallback.
- `ssh exec` uses ControlMaster multiplexing so the SSH handshake cost (100–300 ms) is paid once per workspace lifecycle, not per exec or per turn.
- For WAN deployments, rsync at turn boundaries can take seconds for large workspaces. This is acceptable because turn end-to-end latency is dominated by model inference. For latency-critical or very-large workspaces, the object-store substitute eliminates per-turn copy overhead.
- The bridge connection is independent of SSH. A failure in one plane does not necessarily kill the others, simplifying recovery semantics.
- Auth between bridge and Core uses mTLS by default. Short-lived signed bearer tokens are an acceptable alternative when mTLS is impractical (for example, behind a managed ingress that terminates TLS).

### 6. The `openkit-bridge` Sidecar

The bridge is a small process bundled in the agent container image. It is **not** part of the agent runtime and **not** part of Core; it is a transport adapter for the capability plane.

Responsibilities:

- Expose standard local API surfaces inside the container so the agent uses normal SDKs and standard env vars: OpenAI-compatible endpoint for LLM, MCP-compatible endpoint for tool gateway, HTTP forward proxy for arbitrary outbound, REST endpoint for KB queries.
- Connect to Core over HTTPS+mTLS using long-lived HTTP/2 connections, multiplexing per-service streams.
- Inject vault credentials at outbound time. The bridge requests the right credential from Core per call and adds it to the upstream request after the agent's request body is otherwise complete. The credential never enters the agent process or the agent container's persistent state.
- Surface failures as standard HTTP errors (5xx for upstream issues, 401/403 for vault/permission denial). The agent handles these like any API failure.
- Forward audit metadata. Every call carries `agentSessionId`, `threadId`, `turnId`, and `requestId` in headers; Core's proxy layer logs the full event without bridge-side state.

Non-responsibilities:

- The bridge does not implement business logic. It does not decide which LLM model to use, how to fall back between providers, what rate limits apply, or which MCP tools are visible. All of that belongs to Core's Agent Capability layer and its gateway projection (see `docs/core/architecture.md`).
- The bridge does not cache sensitive content. Schema metadata may be cached; LLM responses, KB rows, and vault responses must not be.
- The bridge does not persist state. Crashes are recoverable by restart with no data loss.
- The bridge is not packaged per agent runtime. The same `openkit-bridge` binary serves Codex, future Codex-like agents, and any agent built on the OpenAI Agents SDK template.

The bridge wire protocol is intentionally not defined here in detail; it is the subject of a follow-up spec.

### 7. Agent Manifest Extensions For Deployment

The then-current [Agent Setup And Runtime Supply Contract](../20260628-agent_setup_runtime_supply_contract.md) defined the runtime supply entry point. This spec adds historical deployment and data-plane sections for Codex communication modes. They are runtime-time concerns and do not appear in the `UI <-> Core` protocol.

```toml
[deployment]
mode = "container"
placement = "local"          # "local" | "remote"
backend = "openshell"

# local mode:
#   image = "openkit/codex-agent:1.2.3"
#   container_name_template = "openkit-codex-${workspaceId}"
# remote mode:
#   ssh_target = "agent@agent-host.example.com"
#   image = "openkit/codex-agent:1.2.3"
#   bridge_endpoint = "https://core.example.com/bridge"

[workspace]
source = { type = "bind", from = "${USER_CWD}", to = "/workspace" }
# Alternatives:
#   { type = "rsync", from = "${USER_CWD}", to = "/workspace", via = "ssh" }
#   { type = "object_store", bucket = "openkit-workspaces", prefix = "${workspaceId}/" }

[artifacts]
sink = { type = "bind", from = "${CORE_ARTIFACT_DIR}", to = "/workspace/.artifacts" }
# Alternatives:
#   { type = "rsync_back", from = "/workspace/.artifacts", to = "${CORE_ARTIFACT_DIR}", via = "ssh" }
#   { type = "object_store", bucket = "openkit-artifacts", prefix = "${workspaceId}/" }

[capability]
# Bridge connection details tell the container-local bridge how to reach Core
# and how to authenticate.
bridge_url = "https://core.local/bridge"
auth = { kind = "mtls", client_cert = "${CORE_BRIDGE_CERT}", client_key = "${CORE_BRIDGE_KEY}" }
# auth = { kind = "bearer", token_env = "OPENKIT_BRIDGE_TOKEN" }
```

The resolver (defined in the unified manifest spec) merges deployment and plane configuration into the `ResolvedAgentSetup`. The materialiser per-mode produces the right adapter launch payload: spawn args for `host`, container spec for `local`, container spec plus SSH config for `remote`.

### 8. Turn Lifecycle Across Modes

A turn passes through six stages, all coordinated by the adapter. The stages are identical in every deployment mode; only the underlying transport changes.

```
                     ┌─ host ─┐  ┌─ local ─┐  ┌─ remote ─┐
1. startTurn         │ direct │  │ docker  │  │ ssh exec │
   on control        │ stdio  │  │ exec    │  │ stdio    │
                     └────────┘  └─────────┘  └──────────┘

2. workspace ingress │  none   │  │ bind    │  │ rsync    │
   (if not bound)    │ (direct)│  │ mount   │  │ push or  │
                     │         │  │ (already│  │ object   │
                     │         │  │ live)   │  │ pull     │
                     └────────┘  └─────────┘  └──────────┘

3. control: turn/start ──────── JSON-RPC ──────────►  agent

4. streaming items, deltas, approvals via control stream
   capability calls (LLM/MCP/vault/KB) via bridge in parallel

5. turn/completed received on control stream

6. artifact egress   │  none   │  │ bind    │  │ rsync    │
                     │ (direct)│  │ mount   │  │ pull or  │
                     │         │  │ (already│  │ object   │
                     │         │  │ live)   │  │ list     │
                     └────────┘  └─────────┘  └──────────┘
   adapter emits artifact-reference Items based on what
   the agent wrote during the turn.
```

Steps 2 and 6 are the new boundary hooks added by this spec; everything else exists in the host adapter and communication-flow specs already. The hooks are implemented in the adapter's `MaterializedAgentSetup` runner and are mode-specific; the rest of the lifecycle is mode-independent.

### 9. Cross-Cutting Properties

These hold in every deployment mode by construction:

- **Agent process is mode-agnostic.** Codex sees `cwd=/workspace`, `OPENAI_BASE_URL=http://localhost:<port>`, and stdio JSON-RPC. It cannot tell whether it is on the host, in a local container, or in a remote container.
- **Vault never crosses into agent memory.** Credentials are injected at the bridge after the agent's request body is otherwise complete.
- **One transport stack.** `CodexAppServerClient` is one implementation. Only the `Transport` instance differs across modes (`StdioTransport` with three different spawn commands, or `WebSocketTransport` as fallback).
- **One bridge protocol.** The bridge speaks the same HTTPS+mTLS to Core in `local` and `remote` modes; in `host` mode the bridge surface is served directly by Core in-process and the same internal handlers run.
- **Audit is uniform.** Every capability call, every approval, every turn boundary is observable in Core regardless of mode.
- **Failure modes are bounded per plane.** A control stream drop does not corrupt workspace state; a workspace sync error does not interrupt a running turn until the adapter decides; a bridge outage produces standard HTTP errors that the agent treats as upstream failures.

## Alternatives Considered

### Alternative A: Tunnel All Traffic Through One SSH Connection

Use SSH `-R` reverse port forwards plus stdio multiplexing to carry control, workspace, artifact, and capability traffic in one connection.

Why not:

- All traffic shares one TCP connection, so head-of-line blocking is unavoidable. LLM streaming, workspace rsync, and control deltas would compete on the same pipe.
- SSH port forwarding requires sshd configuration and is commonly blocked by k8s NetworkPolicy or cloud security groups; HTTPS to a known endpoint is far more portable.
- Agent configuration would need to be SSH-aware (port-forward target hosts, custom DNS) instead of using standard `OPENAI_BASE_URL` and similar env vars.
- Vault credential injection has no clean place in the SSH model. Either credentials live in the agent container (bad) or Core has to inspect tunneled bytes (worse).
- Audit and per-call observability vanish behind opaque SSH framing.

### Alternative B: Use The Codex `ws://` Listener As Primary Control Transport

Run `codex app-server --listen ws://0.0.0.0:PORT` in containers and connect via WebSocket from Core.

Why not (today):

- The Codex documentation labels the WebSocket transport "experimental and unsupported". Building production paths on an experimental surface is unacceptable.
- It introduces a new auth surface (capability-token or signed-bearer) that we would need to operate alongside the existing SSH/docker-exec auth model.
- It requires per-container TLS termination or an ingress in front. SSH and docker exec do not.
- WebSocket carries no measurable performance benefit over stdio-over-SSH in steady state for our message sizes.

It remains a fallback for environments that block both `docker exec` and SSH. The transport abstraction in `CodexAppServerClient` already supports it; we simply do not select it by default.

### Alternative C: Build On Top Of `@openai/codex-sdk`

Use the official TypeScript SDK as the control client and wrap it with our own adapter.

Why not:

- The SDK is essentially a subprocess + JSONL-framing wrapper. We need to handle the JSON-RPC protocol either way (especially for server-initiated approval requests), so the SDK saves no significant code while introducing a versioned dependency.
- The SDK assumes local stdio. For `local` and `remote` modes we would need a parallel JSON-RPC client anyway, splitting our implementation in two.
- The SDK does not expose schema generation; the official source of truth is `codex app-server generate-ts`, which is not the SDK package.
- Removing a dependency from the supply chain is a net positive in a security-sensitive context where we are deliberately keeping vault credentials out of agent memory.

### Alternative D: Use The Zed `codex-acp` ACP Shim

Speak ACP to Codex via the Zed-maintained adapter so that Core uses one ACP client across multiple agent products.

Why not:

- The shim is community-maintained and lags behind Codex schema changes.
- ACP semantics are designed around editor integration, not orchestration; mapping our `Item` types via ACP and back is a second-order translation we control on neither end.
- ACP becomes useful when we want to talk to ACP-native runtimes (Gemini CLI, OpenCode). For those, we will build a Core-side ACP client and use ACP as the direct control transport, not as an indirection over Codex.

### Alternative E: Tunnel A Filesystem Into The Container (`sshfs`, NFS, 9p)

Mount the user's workspace into the container via a network filesystem so file changes are lazy and on-demand.

Why not:

- Per-`open()` round-trip latency over WAN is poor and degrades the agent's interactive feel.
- These filesystems have brittle failure semantics under interruption that are difficult for an agent runtime to reason about.
- rsync at turn boundaries gives predictable, bounded sync windows that match how turns actually work.

For local container mode, bind mounts are not a network filesystem and do not have these problems.

## Rollout / Migration Plan

1. Land the `host` mode end-to-end. This is the work already covered by [20260416-host_agent_adapter.md](../../superseded/worker-runtime/20260416-host_agent_adapter.md). Replace the deterministic simulator with the real `CodexAppServerClient` over `StdioTransport`.
2. Implement the in-process bridge surface in Core (LLM-compat endpoint, MCP-compat endpoint, forward proxy, KB endpoint, vault injection). Wire the Codex agent in `host` mode to consume them via env vars even though the bridge is not a separate process.
3. Define the bridge wire protocol in a follow-up spec (`YYYYMMDD-openkit_bridge_protocol.md`). Implement the `openkit-bridge` binary against that spec.
4. Build the first `local` mode agent container image bundling `codex` and `openkit-bridge`. Validate end-to-end with bind mounts and `docker exec` stdio.
5. Add the manifest deployment sections defined in §7. Extend the resolver and materialiser described by the then-current [Agent Setup And Runtime Supply Contract](../20260628-agent_setup_runtime_supply_contract.md) to handle the new fields per mode.
6. Add `remote` mode by introducing the SSH stdio transport variant and the rsync-over-SSH and object-store workspace/artifact strategies. Re-validate end-to-end.
7. Ship a WebSocket transport variant as a tested-but-not-default option for environments that block `docker exec` and SSH.

The order is sequential. Modes are validated in increasing complexity, and each mode's correctness depends on the bridge model being right.

## Testing Strategy

- Unit tests for `CodexAppServerClient` against a mock transport that drives synthetic JSON-RPC traffic, including server-initiated approval requests and `turn/interrupt` mid-stream.
- Unit tests for each `Transport` implementation (`stdio`, `docker exec`, `ssh exec`, `websocket`) against fakes that simulate spawn behaviour and pipe semantics.
- Per-mode integration tests that drive a real Codex binary through one full turn including approval, file change, and artifact reference. The same scenario script runs against `host`, `local`, and `remote` and must produce the same protocol-level event sequence.
- Schema-diff CI: each pinned Codex version is checked with `codex app-server generate-json-schema` and diffed against the committed schema. Drift fails the build.
- Bridge integration tests that confirm vault credentials never appear in the agent container's process memory or filesystem (snapshot inspection after a turn).
- Turn-boundary tests that confirm workspace ingress and artifact egress complete before and after the JSON-RPC `turn/start`/`turn/completed` events respectively.
- WAN-simulation tests using `tc` or equivalent network shaping to confirm `remote` mode behaves correctly with 50–200 ms RTT and 10–100 Mbps link.

## Risks & Mitigations

### Risk: Codex schema churn

Codex is actively developed. JSON-RPC method names, fields, or notification shapes may change between versions.

Mitigation: pin Codex versions in container images; commit the generated schema; diff in CI; treat any drift as a versioned compatibility task rather than a silent breakage.

### Risk: WebSocket transport remains experimental indefinitely

If we ever need it as primary, we are blocked.

Mitigation: keep the transport abstraction so we can switch with no client changes; track the upstream stability signal; do not rely on it in production paths.

### Risk: Sidecar bridge becomes a second control plane

The bridge could grow features that belong in Core (provider routing, model selection, rate limiting) and become hard to reason about.

Mitigation: enforce the non-responsibilities in §6 by review; keep the bridge under a strict size/scope budget; route every non-trivial decision to Core.

### Risk: WAN bandwidth makes rsync at turn boundaries painful

Large workspaces cross-continent could add tens of seconds per turn.

Mitigation: object-store substrate is already designed for this case; make it the default for any deployment with a declared latency budget over a threshold; document the trade-off in the manifest.

### Risk: `docker exec` and `ssh exec` lifecycle drift

`docker exec` retains slightly different signalling and cleanup semantics from `ssh exec`. Adapter code that assumes one may break the other.

Mitigation: keep the `Transport` interface narrow (`send`, `onMessage`, `close`); test both transports against the same conformance suite; never let mode-specific code leak above the transport boundary.

### Risk: Bridge mTLS rotation operational burden

Cert rotation in long-lived containers is a known operational pain.

Mitigation: short-lived certs with automatic rotation by Core at container start; if rotation is needed mid-life, define it as a bridge-restart event rather than in-place reload.

## Open Questions

- Should the `openkit-bridge` and Codex run as one supervised process inside the container (with bridge as PID 1), or as two processes managed by a small init? The choice affects crash propagation and restart semantics.
- For `remote` WAN deployments, should artifact references support inline previews (small thumbnails, summary text) over the bridge so the UI can show partial data without a full artifact fetch?
- Should the bridge expose a single MCP gateway endpoint that internally fans out to multiple MCP servers, or one endpoint per MCP server? Resolved by D2 below.
- How does workspace `rsync` reconcile with agent-side file edits when the user also edits files locally during a long turn? This is partly a UX question and partly a manifest-policy question (read-only vs read-write workspace).
- Should we support a hybrid mode where the workspace lives on object storage but artifacts are bind-mounted, for users who want fast local artifact access with WAN-resilient workspace state?
- Should the bridge endpoints support OpenAPI/AsyncAPI publication so non-Codex agents can validate compatibility statically against the same surface? Locked-in: yes. See D5 below.

## Decisions Locked In (2026-05-13)

These constraints are fixed in design discussion and informed by the external adapter and manifest source review across emdash, t3code, multica, cc-connect, tday, OpenAI sandbox agents, and OpenFang. Update this section, not the prose above, when revising; treat the diagrams in §3-§5 as superseded by D3 + D4 below where they conflict.

### D1. Bridge transformer pipeline (capability plane is composable)

§6 ("The `openkit-bridge` Sidecar") is generalised: bridge requests do not just have credentials injected — they pass through an ordered, named **transformer pipeline** owned by Core. Vault injection is transformer #0; per-provider rewrites and audit injection are sibling transformers. The pipeline is configured per `(provider × runtime × plane)` in the model registry, not hardcoded.

```
agent request → bridge route (provider × runtime → transformer set)
                  ↓
              [vault-credential-inject]
                  ↓
              [audit-header-inject]              (agentSessionId, threadId, turnId, requestId)
                  ↓
              [provider-quirk-rewrite]           (e.g. claude-thinking-rewrite: adaptive→disabled)
                  ↓
              [tool-namespace]                   (multi-agent tool isolation)
                  ↓
              upstream provider
                  ↓
              transformers in reverse (audit-emit, etc.)
                  ↓
              agent response
```

Each transformer is a typed unit (`onRequest`, `onResponseChunk`, `onResponseComplete`). v1 ships compiled-in: no plugin runtime. The audit record carries `transformers_applied: [...]` so consumers can see which rewrites ran. Cross-references: cc-connect's `core/providerproxy.go` is the prior art for the per-provider rewrite, tday's Codex tool-namespacing proxy is the prior art for the namespace transformer. Follow-up spec covers the full transformer registry and protocol — see "Follow-up specs" below.

### D2. Three MCP modes; bridge gateway is one service exposing two shapes

The MCP plane supported three historical modes under the then-current [Agent Setup And Runtime Supply Contract](../20260628-agent_setup_runtime_supply_contract.md):

- `bridge.spawned` — bridge spawns the MCP server process (or uses a workspace-shared one); multiplexed across agent sessions; vault credentials available.
- `bridge.remote` — bridge proxies to an external MCP HTTP/WS endpoint; vault credentials available.
- `agent.local` — MCP server runs **inside the agent execution domain** via a local CLI (Playwright, chromium-mcp, filesystem-mcp, anything that needs the agent's `cwd` / browser session / display). Bypasses the bridge entirely. Cannot declare vault credentials.

Bridge gateway is **one service exposing two shapes** (resolves the open question above):

```
http://127.0.0.1:9002/mcp                ← aggregated endpoint (network-style agents)
http://127.0.0.1:9002/mcp/<server-id>    ← per-server subpaths (file-config-style agents)
```

Materializer chooses which shape to wire into the agent based on the runtime's preferred MCP integration. For Claude Code: writes a `--mcp-config <temp.json>` file pointing each server entry at `http://127.0.0.1:9002/mcp/<id>` (multica's pattern). For Codex: writes the equivalent `[mcp_servers.<id>]` entries in the materialized `.codex/config.toml`. For SDK-based agents that consume MCP over the network: env var `MCP_GATEWAY=http://127.0.0.1:9002/mcp`. `agent.local` MCPs are written into the same config file as `command`/`stdio` MCPs, **not** as a bridge URL.

### D3. nanocore has two deployment shapes; remote agents always use a bridging sidecar

Nano-core itself runs in two shapes:

- **Server-side**: nanocore deployed on a server with a public bridge endpoint (mTLS-terminated).
- **Desktop-embedded**: nanocore embedded as a background service inside a desktop app (loopback bridge endpoint), modelled on `codex app-server`.

For both shapes, the **`remote` deployment mode** uses a bridging sidecar process inside the agent container that **dials out** to nanocore wherever it lives. The agent container image is identical across both nanocore shapes; only the sidecar's connection target differs.

```diagram
nanocore shape A: server-side                nanocore shape B: desktop-embedded
╭─ cloud nanocore ────────╮                  ╭─ desktop app ───────────╮
│ bridge endpoint (mTLS)   │                  │ embedded nanocore      │
│      ▲                   │                  │ bridge endpoint (loop)  │
│      │                   │                  │      ▲                  │
╰──────┼───────────────────╯                  ╰──────┼──────────────────╯
       │                                              │
       │ outbound TCP/mTLS (single multiplexed conn)  │
       │                                              │
       │  (desktop case may need a reverse tunnel /   │
       │   tailnet / LAN-reachable IP if container    │
       │   is on a different host)                    │
       │                                              │
╭──────┴───────────────────────────────────────────────┴──────╮
│ remote agent container                                      │
│   ╭─ bridging sidecar ──────────────────────────────────╮   │
│   │ - dials nanocore (knows endpoint at startup)       │   │
│   │ - establishes 1 mTLS conn, multiplexes 4 planes:    │   │
│   │     control (agent stdio bridged)                  │   │
│   │     workspace events                                │   │
│   │     artifact pointers                               │   │
│   │     capability requests (LLM/MCP/KB/proxy)          │   │
│   │ - exposes loopback endpoints to agent:             │   │
│   │     127.0.0.1:9001 LLM, :9002 MCP, :9003 KB, :9004  │   │
│   │ - reconnects on transient failure (agent unaware)  │   │
│   ╰─────────────────────────────────────────────────────╯   │
│   ╭─ agent (codex / future runtimes) ──────────────────╮   │
│   │ JSON-RPC stdio ↔ sidecar's control channel          │   │
│   │ HTTP → 127.0.0.1:900x (capability plane)            │   │
│   ╰─────────────────────────────────────────────────────╯   │
╰──────────────────────────────────────────────────────────────╯
```

This **supersedes the §5 diagram and the per-plane mapping table for `remote` mode** where they conflict. Concrete differences from §5:

| concern              | §5 (original)                                     | D3 (locked in)                                                       |
| -------------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| Control transport    | laptop `ssh exec` into remote container           | sidecar bridges agent stdio over the same multiplexed TCP           |
| Workspace plane      | `rsync` from laptop at turn boundary              | bind mount from remote disk (default); workspace events over sidecar |
| Artifact plane       | `rsync` back from container to laptop              | container writes to bind mount; sidecar streams pointers to nanocore |
| Capability plane     | bridge in container connects to public Core       | sidecar's existing TCP carries capability requests too                |
| Network surfaces     | three (ssh, rsync, public mTLS)                    | one (sidecar's outbound mTLS)                                         |
| nanocore location   | implicitly server-side                             | works for both server-side and desktop-embedded                      |
| Container image      | depends on which laptop is connecting             | identical across both nanocore shapes                                |

The simplified `remote` manifest:

```toml
[deployment]
mode = "remote"
nano_core_endpoint = "${NANO_CORE_BRIDGE_URL}"   # mTLS-terminated; desktop case uses a tunnel/tailnet URL
sidecar_image = "openkit/bridge-sidecar:1.0.0"
agent_image = "openkit/codex-agent:1.2.3"

[deployment.remote.workspace]
source = { type = "bind", from = "${REMOTE_PROJECT_ROOT}", to = "/workspace" }
```

Open question rolled in: NAT traversal for the desktop-embedded case (when container is not on the same host as the desktop nanocore) is delegated to user-installed tooling (cloudflared, tailscale, frp, SSH `-R`) — not built into the sidecar. The sidecar only consumes a URL. A `same-host` shortcut is supported via `host.docker.internal:<port>`.

### D4. usage source recorded; keystroke injection rejected (deferred)

Each adapter's `AgentResult` carries `usageSource ∈ {bridge_proxy, agent_otel, pty_scrape, none}` so audit consumers know the fidelity (see [20260416-host_agent_adapter.md](../../superseded/worker-runtime/20260416-host_agent_adapter.md) §D2). Codex always reports `bridge_proxy`. Keystroke-injection adapters are explicitly rejected; manifest validation refuses runtimes without a structured prompt channel (see [20260416-host_agent_adapter.md](../../superseded/worker-runtime/20260416-host_agent_adapter.md) §D1). Both items are deferred until non-Codex agents ship; recorded here so future work does not relitigate them.

### D5. Bridge protocol gets an OpenAPI/AsyncAPI publication

Open question above resolved: yes. The follow-up bridge protocol spec (see "Follow-up specs" below) ships with an OpenAPI 3 description of the synchronous endpoints (`/llm`, `/mcp`, `/kb`, `/proxy`) and an AsyncAPI description of the multiplexed control / workspace events / artifact pointers / capability stream channels. Third-party agent authors can validate against this surface without reading Codex source.

### Follow-up specs (to be written)

- `<date>-bridge_sidecar_protocol.md` — multiplexed mTLS connection between sidecar and nanocore, four logical channels, transformer pipeline, per-provider transformer config, OpenAPI/AsyncAPI publication.
- `<date>-agent_lifecycle.md` — `Running → Suspended → Terminated` state machine, suspend-to-disk format, snapshot policy, recovery on host restart. Required before laptop-sleep / desktop-quit / sidecar-reconnect resume can land.
