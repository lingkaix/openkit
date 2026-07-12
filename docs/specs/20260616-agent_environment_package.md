# Agent Environment Package And Worker Governance Backends

Status: Accepted
Implementation: Partial

## Owns

This spec owns the implementation-facing `AgentEnvironmentPackage` contract and the boundary between NanoCore's worker-execution source of truth and worker governance backends.

It owns the resolved package shape for worker identity, runtime image and command inputs, workspace materialization inputs, provider and vault attachments, policy intent, backend materialization, audit expectations, and backend evidence.

## Does Not Own

This spec does not own stable core definitions, user-authored agent manifest resolution, worker-control commands, workspace synchronization records, runtime scheduling, policy evaluation, vault storage, capability gateway routing, backend-native OpenShell schemas, worker-runtime sub-agent provenance, worker-inference identity specialization, or UI readiness layouts.

Those contracts are owned by the relevant core documents and current active specs.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-capability.md`
- `docs/core/sandbox.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`
- `docs/core/storage.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`

## Summary

OpenKit needs a canonical way for NanoCore to define what a worker agent should see and what it is allowed to do before a backend materializes that request into a local container, remote container, VM, managed sandbox, or custom worker runtime.

Runtime backend details are refined by `docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260703-runtime_scheduling_scale.md`, and `docs/specs/20260627-remote_openshell_gateway.md`. Host-local staging and harness behavior are implementation projections; real Worker Agent product paths use governed container or sandbox placements.

The durable decision is that NanoCore owns the product and governance source of truth, while OpenShell or another worker governance backend owns backend-specific materialization and enforcement.

NanoCore defines:

- the agent identity and selected profile
- the worker image, tools, binaries, skills, and startup command
- the workspace files, repositories, data mounts, attachments, and output paths visible to the worker
- the provider profiles and provider instances available to the worker
- the vault references and grants that can satisfy those provider instances
- the policy intent for filesystem, network, process, inference, provider, secret, artifact, and resource access
- the audit expectations and lineage links back to workspace, thread, turn, item, and agent session records

The backend materializes:

- container or sandbox runtime state
- backend-native policy files
- backend-native provider attachments
- backend-native credential placeholders or gateway routes
- mounted files, repositories, object-store paths, and output directories
- supervisor, sidecar, proxy, or relay processes
- backend-native logs and enforcement evidence

OpenShell is valuable because its Providers v2, sandbox policy, inference routing, compute driver, and observability designs already cover many of the fields OpenKit needs.

OpenKit should adopt an OpenShell-inspired provider/profile/policy vocabulary, and an OpenAI-sandbox-inspired workspace manifest vocabulary, without making either third-party schema the canonical OpenKit product contract.

## Current Implementation Projection

The current NanoCore implementation uses the Agent Environment Package as the concrete V1 contract for worker governance execution. Current code resolves package metadata for local and remote OpenShell container worker paths, including runtime placement, worker-visible workspace roots, generated task context, control endpoint metadata, transcript paths, policy snapshot binding, session workspace layout, workspace synchronization expectations, supply projections, capability projections, vault-backed runtime files, and backend capability requirements. NanoCore also persists redacted workspace-owned package snapshots and exposes them through App API, Core Client, OpenAPI, and MCP readback surfaces for diagnostics, evidence, export/import, and restart investigation.

The first OpenShell-backed path uses an OpenKit-owned sidecar or worker shim shape for `control.local` rather than treating OpenShell service forwarding or backend logs as the product control plane.

The accepted V1 boundary is implemented for NanoCore-owned AEP resolution and OpenShell-backed materialization. Authored setup can project required backend capabilities into AEP backend requirements, backend materialization validates missing required capabilities before launch, grant-backed provider and runtime-file attachments flow through vault records without storing secret material in the package, worker Skill and MCP supply are resolved from approved catalog entries, worker-visible Knowledge and MCP capability projections are present, and redacted package snapshots can be listed and read without exposing backend-private fields, raw credentials, or host-local runtime references. The accepted worker-runtime provenance and trusted worker-inference binding extension in `docs/specs/20260711-worker_runtime_subagent_provenance.md` is not implemented, so overall AEP alignment is partial until package requirements, transcript paths, relay identity binding, and capability negotiation cover that contract. Rich Web readiness views, broader provider profiles, object-store mounts, and deployment-specific OpenShell service-management contracts remain future extensions over the same AEP boundary.

## Goals / Non-goals

### Goals

1. Define the `AgentEnvironmentPackage` as the canonical NanoCore contract for worker execution materialization.
2. Define the worker governance backend boundary used by OpenShell, Docker, Kubernetes, VM, future managed sandbox providers, and future custom infrastructure.
3. Borrow mature provider profile vocabulary from OpenShell Providers v2 for provider categories, credentials, endpoints, binaries, discovery, refresh, and policy contribution.
4. Borrow mature workspace manifest vocabulary from sandbox systems for files, repositories, mounts, users, groups, environment, outputs, and setup commands.
5. Keep NanoCore as the source of truth for users, workspaces, threads, turns, agent sessions, provider routing, vault references, grants, permission decisions, audit records, and item lineage.
6. Let OpenShell or another backend enforce NanoCore decisions in the runtime environment.
7. Keep the schema backend-portable so OpenKit can support OpenShell, plain Docker, Kubernetes, VM, remote runtime gateways, and hosted sandbox providers.
8. Define enough manifest fields for future implementation planning without requiring immediate implementation.
9. Define which fields are authored, resolved, materialized, derived, dynamic, static, secret-bearing, or audit-only.
10. Preserve the existing `Workspace -> Thread -> Turn -> Item[]` backbone.

### Non-goals

- Do not implement this design in this spec.
- Do not make OpenShell YAML the only accepted OpenKit authoring format.
- Do not expose backend-native policy files, container IDs, VM IDs, process IDs, raw environment variables, provider credentials, or host paths as stable protocol fields.
- Do not redefine `Agent`, `AgentProfile`, `AgentSession`, `Turn`, `Item`, `Artifact`, `VaultReference`, `PermissionDecision`, or `AuditEvent` core concepts.
- Do not move app-local gateway, provider, vault, policy, or backend internals into `packages/protocol` before the App API surface is stable.
- Do not require every backend to support every source kind, provider kind, refresh strategy, or policy primitive in the first implementation.
- Do not reintroduce host execution as a real Worker Agent runtime.
- Do not store raw secrets in agent packages, provider profiles, provider instances, workspace manifests, item payloads, Knowledge Store records, normal workspace files, audit records, or product logs.
- Do not mutate a running process environment after provider, policy, or credential changes.

## Background

OpenKit already has the long-term product boundary: App surfaces submit work, NanoCore coordinates that work, and agent runtimes execute heavy tasks.

The missing infrastructure contract is the package that says what a worker receives at execution time.

Earlier work in `docs/specs/superseded/worker-runtime/20260526-workspace_data_mounts.md` intentionally limited the first workspace-root slice to `host-dir`.

That was appropriate for the earliest trusted-local worker loop, but it leaves open questions for containers, remote sandboxes, object stores, repository checkout, generated setup files, skills, tools, vault-backed credentials, LLM routing, provider-aware policy, audit ingestion, and runtime enforcement.

OpenShell's Providers v2 design is useful because it treats a provider as a profile-backed access bundle rather than a credential record.

In that design, a provider profile can describe credentials, environment variable names, endpoints, binary allowlists, network policy rules, inference metadata, discovery behavior, and credential refresh metadata.

OpenShell's runtime model is also useful because a gateway owns control-plane state while a supervisor inside each sandbox enforces policy where filesystem, process, network, and credential visibility exist.

OpenAI's sandbox manifest model is useful because it treats worker workspace setup as an explicit fresh-session contract for files, directories, repositories, mounts, environment setup, users, groups, and output directories.

OpenKit should combine those ideas under a NanoCore-owned schema.

## Decision

OpenKit will introduce an `AgentEnvironmentPackage` design as the canonical input to worker execution materialization.

The package is a resolved NanoCore object, not necessarily a user-authored file.

It may be assembled from server config, workspace config, agent setup, selected profile, user grants, vault references, provider registry, policy engine decisions, turn requirements, and runtime backend capabilities.

The package is then passed to a `WorkerGovernanceBackend` adapter.

The first serious backend candidate is OpenShell.

OpenShell is not modeled as another agent runtime.

It is modeled as an enforcement backend that wraps a worker agent runtime such as Codex, OpenCode, Pi Agent, a custom worker process, or a future agent service.

The architecture is:

```text
OpenKit App
  -> NanoCore
      owns canonical workspace, thread, turn, agent, provider, vault, policy, and audit semantics
      -> AgentEnvironmentPackage resolver
          owns resolved package identity, lineage, policy intent, provider refs, vault refs, and backend requirements
          -> WorkerGovernanceBackend adapter
              -> OpenShell materializer
                  creates backend-native provider records, provider attachments, policy files, sandbox config, mounts, logs, and command
                  -> Sandbox supervisor / wrapper
                      launches and governs Codex, OpenCode, Pi Agent, or another worker
              -> Other backends
```

NanoCore remains the only canonical source for:

- user identity and workspace membership
- workspace, thread, turn, item, artifact, knowledge, and agent session lineage
- provider profiles accepted by OpenKit
- provider instances visible to an agent session
- vault references, grants, and injection contracts
- permission decisions and approval gates
- capability routing and LLM provider selection
- audit projections used by product surfaces and governance queries

Backends may attach evidence and enforcement metadata.

Backends do not replace NanoCore's canonical records.

## Design Principles

### NanoCore Defines, Backend Materializes

NanoCore defines the desired worker-visible environment and the allowed capability envelope.

The backend translates that definition into concrete runtime state.

This keeps product semantics portable across OpenShell, Docker, Kubernetes, VM, managed sandbox, and future hosted sandbox backends.

### Adopt Mature Vocabulary, Not Foreign Ownership

OpenKit should adopt OpenShell-style provider profile fields where they are useful.

Examples include category, credential declarations, environment variable aliases, auth style, endpoints, binary allowlists, GraphQL and REST rules, refresh strategy, and profile-derived policy layers.

OpenKit should not require users or product features to understand OpenShell-specific storage, CLI commands, runtime flags, or reserved rule naming.

### Separate Profile, Instance, Grant, And Injection

A provider profile describes a reusable provider type.

A provider instance binds one profile to concrete configuration and vault references.

A vault grant authorizes use in a specific context.

A backend injection materialization decides how the credential becomes usable by the worker without exposing the secret value to the prompt.

Those are separate records.

### Keep Policy Intent Separate From Enforcement Artifact

NanoCore owns abstract permission decisions and policy intent.

The backend owns concrete policy artifacts such as OpenShell policy YAML, container network rules, Kubernetes network policies, sidecar config, or firewall rules.

NanoCore audit must record both the abstract decision and the backend enforcement result.

### Prefer Stable Worker Endpoints

Agents should see stable local endpoints or environment variables managed by OpenKit or the backend.

They should not need to know whether routing goes through NanoCore, OpenShell `inference.local`, a sidecar proxy, a Kubernetes service, or a managed sandbox endpoint.

### Separate Control From Inference

OpenKit worker control traffic and LLM inference traffic should use separate conceptual channels.

The inference channel exists so SDKs and agent runtimes can call a stable OpenAI-compatible or provider-compatible endpoint without seeing real provider credentials.

The control channel exists only when the product needs live worker interaction such as active-turn input, interrupt, cancel, approval result delivery, live item streaming, live artifact notices, or worker heartbeats.

The default worker governance path does not require live conversation with the worker.

OpenKit is primarily a system for managing, scheduling, coordinating, and reviewing many worker agents that collaborate toward a goal.

For that product shape, a lightweight turn-end transcript and evidence sink can be enough.

The two channels may share a backend relay or supervisor session, but they are not the same protocol.

For OpenShell-backed workers, `https://inference.local` is the preferred sandbox-local LLM endpoint.

OpenKit should reserve a separate sandbox-local control endpoint such as `https://openkit.local` or `https://control.local` for OpenKit worker control traffic when the backend can expose it, but this endpoint is optional for the first worker governance backend.

The preferred name for this endpoint is `https://control.local`.

`control.local` should copy the operational shape of `inference.local`, not its exact implementation.

The worker sees a stable sandbox-local HTTPS endpoint.

The endpoint then reaches NanoCore through the simplest reliable backend-specific path.

For stock OpenShell, OpenKit must not assume that arbitrary sandbox-local domains can be registered into the OpenShell `inference.local` privacy router.

OpenShell `inference.local` is a specialized LLM routing path.

OpenShell service forwarding is also not the canonical control path because it exposes a sandbox loopback service through a gateway-managed URL for external callers, while OpenKit control requires a stable endpoint that worker code can call from inside the sandbox and that NanoCore can use for bounded commands.

The first OpenShell integration should therefore materialize `control.local` with an OpenKit-owned sandbox sidecar or worker shim inside the sandbox image.

That sidecar should connect outbound to NanoCore's Worker Control Gateway over an allowlisted HTTPS or WebSocket route.

This keeps stock OpenShell usable without patching its Gateway or Supervisor, while preserving the option to replace the sidecar transport with a native OpenShell generic relay later.

When live control is disabled, the worker or shim writes session transcript files under `/openkit/session/`, and NanoCore imports them at turn end.

### Do Not Derive Items From Backend Logs

Backend logs and supervisor events are enforcement evidence.

They are not the canonical source for OpenKit `Turn` and `Item` records.

NanoCore owns the event sequence shown to users.

Backends may produce security, lifecycle, policy, process, filesystem, network, inference, and credential evidence, but NanoCore decides whether that evidence becomes an audit record, a diagnostic row, a compact status item, or an artifact event.

The preferred lightweight split is:

```text
/openkit/session/items.jsonl      -> canonical OpenKit item candidates
/openkit/session/events.jsonl     -> worker lifecycle and progress events
/openkit/session/artifacts.jsonl  -> artifact candidate records
/var/log/openshell*.log           -> backend security, enforcement, and audit evidence
```

On turn end, NanoCore imports OpenKit session files as canonical thread, turn, item, and artifact records, and imports OpenShell OCSF JSONL or shorthand logs as audit and enforcement evidence.

Both streams should share `workspaceId`, `threadId`, `turnId`, `agentSessionId`, and `packageSnapshotId` correlation fields.

### Treat Backend Capability As Negotiated

The package can request capabilities that not every backend supports.

NanoCore must negotiate against backend capability declarations and either select a capable backend, degrade explicitly, request human approval, or fail before starting the worker.

### No Hidden Secret Flow

Every secret use must be traceable through a vault reference, grant, injection path, provider instance, capability call, and audit event.

The worker may receive placeholders, local endpoints, process environment variables, or short-lived handles only when the selected injection path permits that visibility.

## Conceptual Object Model

```text
AgentEnvironmentPackage
  package identity and lineage
  selected agent and profile
  worker runtime and image
  startup command
  workspace manifest
  tool, binary, MCP, and skill supply
  worker control channel
  provider attachments
  vault grants
  policy intent
  LLM routing
  resource limits
  observability and audit sinks
  backend requirements

WorkerGovernanceBackend
  capability declaration
  materializer
  session launcher
  dynamic updater
  evidence collector
  teardown handler
```

The package is resolved at worker session start.

The materialized backend session is captured in `AgentSession` runtime metadata and linked to the turn that requested execution.

## Package Lifecycle

The package lifecycle is:

```text
authored setup fragments
  -> NanoCore resolution
  -> policy and vault evaluation
  -> backend selection
  -> package snapshot
  -> backend materialization
  -> worker session start
  -> dynamic updates where supported
  -> evidence ingestion
  -> teardown and artifact collection
```

### Authored Setup Fragments

Authored fragments may include:

- server config
- provider profile files
- provider instance files
- agent setup files
- workspace roots
- workspace knowledge and context references
- user-selected turn requirements
- policy packs
- backend deployment config

Authored fragments are not the package.

They are inputs to package resolution.

### NanoCore Resolution

NanoCore resolves inputs into one package snapshot.

Resolution must:

- select the agent and profile
- resolve the backend target
- resolve the worker image and command
- resolve workspace inputs
- resolve tool and skill supply
- resolve provider attachments
- resolve vault grants
- request or reuse permission decisions
- compute policy intent
- select LLM routing
- compute audit expectations
- verify backend capability support

### Package Snapshot

NanoCore stores a redacted package snapshot for diagnostics, reproducibility, and audit.

The snapshot must not include raw secret values, backend-private handles, unrestricted host paths, or raw provider payloads.

The snapshot should include stable OpenKit IDs and redacted summaries.

### Backend Materialization

The backend materializes the package into runtime-native artifacts.

For OpenShell, this may include:

- provider profiles or profile references
- provider instances or provider attachments
- provider refresh state references
- sandbox policy YAML
- gateway settings
- inference routing configuration
- sandbox create flags
- compute driver config references
- workspace mounts
- supervisor configuration
- OCSF JSON export settings
- launch command

For a plain Docker backend, this may include:

- image name
- container command
- bind mounts
- network mode
- environment variable placeholders
- sidecar proxy endpoint
- resource limits
- log collection config

For a hosted sandbox backend, this may include:

- workspace manifest
- file uploads
- remote object-store mount declarations
- environment setup commands
- approved environment variables
- output directory declarations
- provider route handles

### Worker Session Start

The backend starts the worker only after:

- required package fields validate
- backend capability negotiation succeeds
- permission decisions are recorded
- required approvals are satisfied
- vault grants are active
- provider instances are usable
- workspace inputs are materializable
- policy artifacts are accepted by the backend
- audit sink setup succeeds or the selected policy allows degraded audit

### Dynamic Updates

Some fields may be dynamic after session start.

Examples:

- network policy updates when the backend supports hot reload
- provider attach and detach
- refreshed credentials for future process launches
- audit export enablement
- budget and stop-condition updates that NanoCore enforces
- turn-specific files, repositories, generated context, object-store snapshots, artifacts, transcripts, and output manifests that populate predeclared workspace slots

Other fields are static.

Examples:

- image
- base command
- initial process environment for an already-running process
- static filesystem mounts
- user and group identity
- working directory
- workspace root, slot path set, slot access envelope, output root declarations, provider placeholder envelope, and control endpoint shape

NanoCore must mark sessions stale when a package change cannot be applied dynamically.

### Session Static And Turn Dynamic Workspace

The package must distinguish session-static workspace layout from turn-dynamic workspace contents.

The session-static layout is the reusable sandbox substrate. It includes the worker-visible workspace root, declared workspace slots, slot access envelope, static filesystem policy, output roots, transcript roots, provider attachment envelope, network policy envelope, and base working directory.

The turn-dynamic materialization fills declared slots with task-specific files, repository checkouts, object-store snapshots, generated context, artifacts, helper files, transcripts, and outputs.

Worker sessions may be reused only when the session-static envelope covers the new turn's resolved requirements and remains valid under current policy, vault, provider, backend capability, and config state.

If a new turn requires a static mount path, provider placeholder, process environment, working directory, image, user, group, or control endpoint shape that the current session does not provide, NanoCore must create a replacement session or fail closed before launch.

This contract is owned by `docs/specs/20260704-session_static_workspace_materialization.md`.

### Evidence Ingestion

Backends produce evidence.

Evidence may include:

- sandbox lifecycle events
- policy accepted or rejected events
- network allow or deny events
- filesystem allow or deny events
- process launch events
- provider placeholder resolution events
- inference routing events
- credential refresh state changes
- resource limit events
- artifact sync events
- teardown events

NanoCore ingests evidence into audit records, diagnostics, item summaries, or artifact metadata according to product visibility rules.

## `AgentEnvironmentPackage` Top-level Shape

The conceptual shape is:

```jsonc
{
  "schemaVersion": 1,
  "packageId": "aepkg_01jz...",
  "snapshotId": "aepsnap_01jz...",
  "createdAt": "2026-06-16T00:00:00.000Z",
  "scope": {
    "workspaceId": "w_...",
    "threadId": "t_...",
    "turnId": "turn_...",
    "agentSessionId": "as_...",
    "userId": "user_...",
    "automationId": null
  },
  "agent": { "...": "..." },
  "runtime": { "...": "..." },
  "workspace": { "...": "..." },
  "supply": { "...": "..." },
  "control": { "...": "..." },
  "providers": { "...": "..." },
  "vault": { "...": "..." },
  "policy": { "...": "..." },
  "llm": { "...": "..." },
  "resources": { "...": "..." },
  "observability": { "...": "..." },
  "backend": { "...": "..." },
  "extensions": {}
}
```

All IDs are OpenKit IDs unless explicitly marked as backend-native.

Backend-native IDs belong only in materialization records and redacted diagnostics.

## Field Classes

Each field should declare one or more classes in schema documentation.

| Class | Meaning |
| --- | --- |
| `authored` | Can be authored in config or UI input. |
| `resolved` | Produced by NanoCore after merging inputs. |
| `materialized` | Produced by a backend adapter from the resolved package. |
| `derived` | Computed from other fields and not independently authored. |
| `secret` | Contains secret material and must never appear in the package snapshot. |
| `secret-ref` | References secret material without containing it. |
| `audit` | Must be linkable to audit records. |
| `static` | Requires session recreation if changed. |
| `dynamic` | May update a running session when the backend supports it. |
| `backend-private` | Must not become a stable OpenKit protocol or App API field. |

## Scope Fields

`scope` binds the package to OpenKit lineage.

```jsonc
{
  "scope": {
    "workspaceId": "w_...",
    "threadId": "t_...",
    "turnId": "turn_...",
    "itemId": "item_requesting_worker_start",
    "agentSessionId": "as_...",
    "userId": "user_...",
    "organizationId": null,
    "automationId": null,
    "requestId": "req_..."
  }
}
```

Rules:

- `workspaceId`, `threadId`, `turnId`, and `agentSessionId` are required for worker turns.
- `userId` or `automationId` is required so policy can evaluate responsible actor context.
- `itemId` is optional but should link to the user or system item that caused the worker start when available.
- `requestId` should be included for cross-boundary tracing.

## Agent Fields

`agent` describes the selected execution supply and behavior profile.

```jsonc
{
  "agent": {
    "agentId": "agent_codex_container",
    "profileId": "coder",
    "displayName": "Codex Worker",
    "runtimeKind": "codex",
    "profileKind": "coder",
    "instructions": [
      {
        "id": "repo-guidelines",
        "kind": "file",
        "sourceRef": "workspace://config/instructions/repo-guidelines.md",
        "workerPath": "/openkit/instructions/repo-guidelines.md",
        "integrity": {
          "sha256": "..."
        }
      }
    ],
    "capabilityRequests": [
      "llm",
      "shell",
      "filesystem",
      "network",
      "git",
      "artifacts"
    ]
  }
}
```

Rules:

- `agentId` and `profileId` come from the agent catalog and agent setup model.
- `runtimeKind` is a stable OpenKit summary, not a backend command.
- `instructions` may reference files or generated material, but generated instruction files must be materialized outside normal secret-bearing config.
- `capabilityRequests` summarize what the agent asks for; permission and sandbox fields decide what is actually allowed.

## Runtime Fields

`runtime` describes the worker process to launch.

```jsonc
{
  "runtime": {
    "image": {
      "kind": "container-image",
      "ref": "ghcr.io/openkit/codex-worker:2026-06-16",
      "digest": "sha256:...",
      "pullPolicy": "if-not-present"
    },
    "command": {
      "argv": ["codex", "app-server", "--listen", "stdio://"],
      "workingDirectory": "/workspace/repo",
      "stdin": "pipe",
      "stdout": "pipe",
      "stderr": "pipe"
    },
    "process": {
      "user": "openkit-worker",
      "group": "openkit-worker",
      "umask": "0022"
    },
    "session": {
      "reuse": "never",
      "resumeHandleRef": null,
      "staleWhenPackageChanges": true
    }
  }
}
```

Field notes:

- `image.kind` may be `container-image`, `vm-image`, `remote-template`, or `managed-sandbox-template`.
- `image.ref` is static for one session.
- `image.digest` should be present for reproducible container, VM, or remote image materialization.
- `command.argv` is the worker command, not a shell string.
- `workingDirectory` is worker-visible and should be relative to declared workspace roots or a known backend path.
- `process.user` and `process.group` are backend materialization hints and require backend support.
- Session reuse is conservative by default because provider, mount, and policy changes can make warm sessions unsafe.

## Workspace Manifest

`workspace` defines what files, repositories, data mounts, generated setup, and output locations the worker can see.

The shape deliberately extends the earlier `workspace.roots` design.

The workspace section should resolve into a `SessionWorkspaceLayout` plus per-turn `TurnWorkspaceMaterialization` records rather than treating every input as a fresh mount.

Long-lived container workers should normally use `/workspace` as the base working directory and receive the active turn root through context, because binding the session command to a single repository path makes session reuse unnecessarily fragile.

```jsonc
{
  "workspace": {
    "root": "/workspace",
    "inputs": [
      {
        "id": "repo",
        "kind": "repository",
        "source": {
          "kind": "git",
          "url": "https://github.com/example/project.git",
          "ref": "main",
          "commit": "..."
        },
        "target": "/workspace/repo",
        "access": "read-write",
        "materialization": {
          "mode": "checkout",
          "depth": 1
        }
      },
      {
        "id": "local-data",
        "kind": "directory",
        "source": {
          "kind": "workspace-dir",
          "pathRef": "workspace://files/data"
        },
        "target": "/workspace/data",
        "access": "read-only"
      },
      {
        "id": "customer-exports",
        "kind": "object-store",
        "source": {
          "kind": "s3",
          "bucket": "customer-exports",
          "prefix": "2026/q2/",
          "region": "us-east-1",
          "endpointRef": null,
          "providerInstanceId": "provider_aws_reports"
        },
        "target": "/workspace/customer-exports",
        "access": "read-only",
        "mount": {
          "mode": "ephemeral",
          "sync": "on-demand"
        }
      }
    ],
    "generatedFiles": [
      {
        "id": "task-context",
        "target": "/openkit/context/task.md",
        "contentRef": "generated://task-context",
        "access": "read-only"
      }
    ],
    "outputs": [
      {
        "id": "default-output",
        "path": "/workspace/output",
        "registerAsArtifacts": true,
        "retention": "sync-on-turn-end"
      }
    ]
  }
}
```

### Input Kinds

| Kind | Meaning | First implementation status |
| --- | --- | --- |
| `directory` | Directory materialized from workspace storage, artifact storage, repository checkout, staged local source, or remote source. | Partially existing through current workspace materialization paths. |
| `file` | Single file materialized into the worker workspace. | Deferred. |
| `repository` | Git or other repository checkout. | Needed for container workers. |
| `object-store` | S3, R2, GCS, Azure Blob, Box, or compatible object storage. | Deferred. |
| `artifact` | Prior OpenKit artifact materialized as worker input. | Deferred. |
| `snapshot` | Prior worker workspace snapshot or sandbox snapshot. | Deferred. |
| `generated` | NanoCore-generated instruction, context, task, or config file. | Needed for context packaging. |
| `attachment` | User-uploaded attachment. | Deferred. |

### Source Kinds

| Source kind | Example | Credential handling |
| --- | --- | --- |
| `workspace-dir` | Workspace-owned or workspace-linked directory. | No remote credential; path must be validated and materialized through workspace synchronization. |
| `workspace-file` | Workspace-owned or workspace-linked file. | No remote credential; path must be validated and materialized through workspace synchronization. |
| `git` | GitHub repository at a commit. | Provider instance or token grant. |
| `s3` | AWS S3 bucket and prefix. | Provider instance and vault grant. |
| `r2` | Cloudflare R2 bucket and prefix. | Provider instance and vault grant. |
| `gcs` | Google Cloud Storage bucket and prefix. | Provider instance and vault grant. |
| `azure-blob` | Azure container and prefix. | Provider instance and vault grant. |
| `box` | Box folder or file reference. | Provider instance and vault grant. |
| `http-archive` | HTTPS zip or tarball. | Optional provider instance. |
| `openkit-artifact` | Artifact ID. | OpenKit permission. |
| `generated` | Generated content reference. | No raw secret content. |

### Workspace Rules

- Worker-visible paths must be absolute inside the worker environment or relative to `workspace.root`.
- Authored source paths must avoid absolute local paths unless a workspace synchronization materializer or deployment policy explicitly permits that projection.
- Source paths must not contain `..` path escapes.
- Symlink escapes must be rejected during materialization.
- `access` must be `read-only` or `read-write`.
- Remote source credentials must be expressed through provider instances and vault grants.
- Output paths must be declared before session start if the backend needs static mounts.
- Output registration should create artifact records linked to the turn and materialized workspace input IDs.

## Supply Fields

`supply` describes tools, binaries, MCP servers, skills, package managers, and helper services available to the worker.

```jsonc
{
  "supply": {
    "binaries": [
      {
        "id": "git",
        "path": "/usr/bin/git",
        "required": true,
        "allowedProviderIds": ["provider_github_read"]
      },
      {
        "id": "gh",
        "path": "/usr/bin/gh",
        "required": false,
        "allowedProviderIds": ["provider_github_read"]
      }
    ],
    "skills": [
      {
        "id": "repo-guidelines",
        "sourceRef": "workspace://skills/repo-guidelines",
        "target": "/openkit/skills/repo-guidelines",
        "integrity": {
          "sha256": "..."
        }
      }
    ],
    "mcpServers": [
      {
        "id": "filesystem-tools",
        "transport": "stdio",
        "command": ["/usr/bin/node", "/openkit/mcp/filesystem.js"],
        "providerInstanceIds": [],
        "vaultGrantIds": []
      }
    ],
    "services": [
      {
        "id": "openkit-gateway",
        "kind": "http",
        "url": "https://openkit-gateway.local",
        "exposure": "worker-local"
      }
    ]
  }
}
```

Rules:

- `binaries.path` is worker-visible, not a host path.
- `allowedProviderIds` can scope which binaries may reach provider endpoints when the backend supports binary-scoped network enforcement.
- Skills are materialized files or directories; they are not implicit prompt text.
- MCP server config must not contain raw credentials.
- Service URLs should be stable worker-local names when possible.

## Worker Transcript And Optional Control

`control` describes how NanoCore receives worker transcript data and, when needed, how NanoCore controls the worker.

This contract is separate from LLM inference and separate from backend security telemetry.

The default mode is `transcript-sink`.

In that mode, the worker or shim writes OpenKit-native JSONL files inside the sandbox, and NanoCore imports them when the turn ends.

Live control is optional and can be added when the product needs active steering, live item streaming, or interruption.

```jsonc
{
  "control": {
    "protocol": "openkit-worker-control-v1",
    "mode": "transcript-sink",
    "transcript": {
      "root": "/openkit/session",
      "eventsPath": "/openkit/session/events.jsonl",
      "itemsPath": "/openkit/session/items.jsonl",
      "artifactsPath": "/openkit/session/artifacts.jsonl",
      "flush": "line",
      "import": "turn-end",
      "required": true
    },
    "endpoint": {
      "kind": "sandbox-local-https",
      "baseUrl": "https://control.local/v1/worker-control",
      "required": false,
      "implementation": "openkit-sidecar"
    },
    "relay": {
      "kind": "outbound-websocket",
      "upstream": "https://nanocore.local/api/worker-control",
      "reuseBackendSupervisorSession": "when-supported",
      "fallback": "transcript-sink"
    },
    "auth": {
      "kind": "sandbox-session-token",
      "tokenRef": "runtime://sandbox-session-token",
      "credentialVisibility": "placeholder"
    },
    "channels": {
      "commands": false,
      "events": "batch",
      "artifacts": "batch",
      "heartbeats": false,
      "logs": "summary-only"
    },
    "commands": [
      "start-turn",
      "active-input",
      "interrupt",
      "cancel",
      "approval-result",
      "config-refresh",
      "close"
    ],
    "events": [
      "worker.ready",
      "turn.started",
      "item.created",
      "item.delta",
      "item.completed",
      "artifact.proposed",
      "turn.completed",
      "turn.failed",
      "worker.heartbeat"
    ],
    "adapter": {
      "kind": "openkit-worker-shim",
      "targetRuntime": "codex",
      "targetTransport": "stdio"
    }
  }
}
```

`mode` values:

| Value | Meaning |
| --- | --- |
| `transcript-sink` | The worker or shim writes `/openkit/session/*.jsonl`, and NanoCore imports the files at turn end. |
| `backend-relay` | The backend relay or supervisor session carries control traffic between NanoCore and the sandbox. |
| `direct-nanocore` | The worker or shim calls a NanoCore endpoint directly through an allowed network route. |
| `sidecar` | A sandbox-local sidecar bridges worker traffic to NanoCore. |
| `stdio` | Development harness projection only; not a real Worker Agent product runtime. |
| `disabled` | The package does not support OpenKit-native worker control and can produce only backend evidence. |

Rules:

- `control.protocol` is an OpenKit protocol owned by NanoCore, not an OpenShell protocol.
- `transcript.root` should be mounted writable by the worker or shim and readable by NanoCore during artifact collection.
- `eventsPath`, `itemsPath`, and `artifactsPath` are worker-visible paths.
- Transcript records must bind to workspace, thread, turn, agent session, package snapshot, and request IDs.
- `endpoint.baseUrl` is worker-visible and should be sandbox-local when live control is enabled.
- `endpoint.implementation: "openkit-sidecar"` means OpenKit provides the sandbox-local control endpoint inside the sandbox image or worker shim.
- `relay.kind` describes how the endpoint reaches NanoCore after accepting sandbox-local worker traffic.
- `relay.reuseBackendSupervisorSession: "when-supported"` means the same OpenKit control protocol may later move onto a backend-native Gateway/Supervisor relay without changing worker-visible semantics.
- `relay.fallback: "transcript-sink"` means live control failure must not discard turn evidence when the worker can still write `/openkit/session/*.jsonl`.
- `auth.tokenRef` must refer to short-lived runtime material, not a durable secret, when live control is enabled.
- Live control must preserve event ordering before events reach client-facing SSE streams.
- The worker or shim may emit candidate events, but NanoCore assigns canonical sequence numbers and persists canonical items.
- `logs: "summary-only"` means backend or worker logs are summarized before becoming product-visible items.
- Raw backend security logs remain audit evidence, not chat transcript content.

### Transcript Sink Files

`events.jsonl` records worker lifecycle and progress events.

Each line is one JSON object.

Example:

```jsonc
{
  "schemaVersion": 1,
  "kind": "worker-event",
  "event": "turn.started",
  "workspaceId": "w_main",
  "threadId": "thread_123",
  "turnId": "turn_456",
  "agentSessionId": "as_789",
  "packageSnapshotId": "aepsnap_codex_github_001",
  "requestId": "req_def",
  "sequence": 1,
  "timestamp": "2026-06-16T00:00:00.000Z",
  "data": {}
}
```

`items.jsonl` records OpenKit item candidates.

Example:

```jsonc
{
  "schemaVersion": 1,
  "kind": "item",
  "workspaceId": "w_main",
  "threadId": "thread_123",
  "turnId": "turn_456",
  "agentSessionId": "as_789",
  "packageSnapshotId": "aepsnap_codex_github_001",
  "requestId": "req_def",
  "sequence": 12,
  "item": {
    "type": "assistant-message",
    "status": "completed",
    "parts": [
      {
        "type": "text",
        "text": "Implemented the requested change and ran focused tests."
      }
    ]
  }
}
```

`artifacts.jsonl` records artifact candidates.

Example:

```jsonc
{
  "schemaVersion": 1,
  "kind": "artifact",
  "workspaceId": "w_main",
  "threadId": "thread_123",
  "turnId": "turn_456",
  "agentSessionId": "as_789",
  "packageSnapshotId": "aepsnap_codex_github_001",
  "requestId": "req_def",
  "sequence": 3,
  "artifact": {
    "kind": "file",
    "title": "Patch Summary",
    "path": "/workspace/output/summary.md",
    "mediaType": "text/markdown"
  }
}
```

Import rules:

- NanoCore imports transcript files only after the worker reaches a terminal outcome unless live import is explicitly enabled.
- NanoCore validates every line before import.
- NanoCore rejects records whose lineage fields do not match the expected package and turn.
- NanoCore assigns canonical item IDs, event sequence numbers, and artifact IDs during import.
- Worker-supplied `sequence` values are source ordering hints, not canonical OpenKit sequence numbers.
- Malformed transcript records become diagnostics and audit evidence; they do not silently enter the canonical item log.
- Missing transcript files should fail the turn only when `control.transcript.required` is `true`.
- Imported items should be marked with source metadata that distinguishes `worker-transcript` from live client input and NanoCore-generated status items.

### Sandbox-Local Control Endpoint

`control.local` is the preferred worker-visible endpoint for OpenKit worker progress and optional control commands.

It is separate from `inference.local`.

`inference.local` carries LLM requests, provider routing, model rewriting, credential stripping, and usage attribution.

`control.local` carries OpenKit worker lifecycle events, compact progress updates, item candidates, artifact notices, heartbeats, and bounded commands.

The first implementation should be a no-fork OpenShell path:

```text
Worker runtime
  -> OpenKit shim
  -> https://control.local/v1/worker-control
  -> OpenKit control sidecar inside the sandbox
  -> outbound HTTPS or WebSocket
  -> NanoCore Worker Control Gateway
  -> NanoCore worker session state
  -> Web UI worker and agent-network status views
```

This implementation uses stock OpenShell for sandbox lifecycle, filesystem enforcement, process enforcement, network policy, credential enforcement, `inference.local`, logs, and evidence collection.

It uses an OpenKit-owned sidecar for OpenKit semantic control traffic.

The sidecar is part of the sandbox image or worker package, not part of the worker agent prompt.

OpenShell network policy must explicitly allow the sidecar binary to reach NanoCore's Worker Control Gateway.

The sidecar must use a short-lived sandbox session token and must bind every message to `workspaceId`, `threadId`, `turnId`, `agentSessionId`, `packageSnapshotId`, and `requestId`.

The sidecar should write every accepted worker-originated event to `/openkit/session/events.jsonl` before or at the same durable boundary as forwarding it live.

Item and artifact candidate records should also remain available through `/openkit/session/items.jsonl` and `/openkit/session/artifacts.jsonl`.

This makes live progress an optimization over the durable transcript sink instead of the only source of evidence.

If the live relay disconnects, the worker may continue when policy allows it, and NanoCore should import the transcript sink at turn end.

If a user sends `cancel`, `interrupt`, or an approval result while the relay is disconnected, NanoCore should persist the command as undelivered and either retry when the relay returns or mark the worker as requiring backend intervention.

Stock OpenShell service forwarding must not be used as the canonical OpenKit control channel.

It may be used for debugging, inspection, preview servers, notebooks, or future operator-only tools, but not for the worker-to-NanoCore turn and item protocol.

If a future OpenShell release exposes a generic sandbox-local endpoint relay that can map `control.local` onto the authenticated Gateway/Supervisor session, the OpenShell backend may switch `control.endpoint.implementation` from `openkit-sidecar` to `backend-relay`.

That switch must not change the OpenKit worker control protocol, NanoCore item state machine, transcript sink contract, or Web UI API.

### OpenKit Worker Shim

Many agent runtimes expose native protocols that do not match OpenKit `Turn` and `Item` semantics.

OpenKit should use a worker shim inside the sandbox when the worker runtime does not natively speak the OpenKit worker control protocol.

The shim is responsible for:

- starting the worker runtime
- translating native runtime events into OpenKit transcript records
- writing `events.jsonl`, `items.jsonl`, and `artifacts.jsonl`
- receiving NanoCore commands only when live control is enabled
- forwarding active-turn input at safe points when live control is enabled and supported
- translating interrupt and cancellation commands when live control is enabled
- publishing artifact candidates through the transcript sink
- sending heartbeats when live control is enabled
- reporting terminal outcomes

The shim is not the policy engine.

The backend supervisor remains the local enforcement boundary for filesystem, process, network, credential, and inference controls.

The shim is the semantic adapter that makes worker activity visible as OpenKit turns and items.

### NanoCore Full Thread Control

NanoCore retains full control of a thread by owning the authoritative turn and item state machine, even when worker transcript import is non-real-time.

The worker backend may relay commands and evidence, but it must not decide canonical OpenKit turn status.

The default transcript-sink control flow is:

```text
NanoCore creates turn
  -> NanoCore resolves AgentEnvironmentPackage
  -> Backend launches governed worker session
  -> Shim starts the worker runtime
  -> Shim writes /openkit/session/events.jsonl
  -> Shim writes /openkit/session/items.jsonl
  -> Shim writes /openkit/session/artifacts.jsonl
  -> Backend reports terminal worker outcome
  -> NanoCore collects transcript files and backend logs
  -> NanoCore imports valid item candidates as canonical OpenKit items
  -> NanoCore imports artifact candidates as OpenKit artifacts
  -> NanoCore imports OCSF JSONL or backend logs as audit and evidence
  -> NanoCore decides final turn status and review surface state
```

The optional live-control flow is:

```text
NanoCore creates turn
  -> NanoCore resolves AgentEnvironmentPackage
  -> Backend launches governed worker session
  -> Shim reports worker.ready through control.local
  -> Control sidecar relays worker.ready outbound to NanoCore
  -> NanoCore sends start-turn or active-input commands
  -> Shim translates runtime-native events into item candidate events
  -> NanoCore persists canonical worker state and selected item events
  -> NanoCore streams compact worker and agent-network status to clients
  -> NanoCore routes interrupt, cancel, or approval-result commands when needed
  -> Shim reports terminal worker outcome
  -> NanoCore decides final turn status and artifact registration
```

This rule prevents OpenShell, Docker, Kubernetes, or any other backend from becoming the source of truth for product history.

Backend lifecycle events may explain why a worker failed or was blocked, but they do not replace NanoCore turn closeout.

The Web UI should subscribe to NanoCore, not to a sandbox, OpenShell Gateway, OpenShell service URL, or worker process.

The UI-facing status stream should be compact and operational rather than a token-level chat replay.

Useful status fields include phase, last progress event, last heartbeat, blocked reason, pending approval count, policy denial summary, artifact count, elapsed time, estimated cost, backend health, and available user actions.

NanoCore may project this into worker, thread, goal, and agent-network panels.

The UI may send user actions such as cancel, interrupt, priority change, approval result, or policy adjustment request to NanoCore.

NanoCore decides whether those actions become worker commands, backend operations, human review rows, or denied requests.

## Provider Profile Model

Provider profiles describe provider types.

OpenKit should use OpenShell-inspired fields because they already cover provider-owned access policy.

```jsonc
{
  "providerProfiles": [
    {
      "id": "github",
      "displayName": "GitHub",
      "description": "Git hosting, REST, GraphQL, and git access.",
      "category": "source_control",
      "inferenceCapable": false,
      "credentials": [
        {
          "name": "api_token",
          "envVars": ["GITHUB_TOKEN", "GH_TOKEN"],
          "required": true,
          "authStyle": "bearer",
          "headerName": "authorization",
          "queryParam": null,
          "refresh": {
            "strategy": "static"
          }
        }
      ],
      "discovery": {
        "credentials": ["api_token"]
      },
      "endpoints": [
        {
          "host": "api.github.com",
          "port": 443,
          "path": "/**",
          "protocol": "rest",
          "access": "read-only",
          "enforcement": "enforce"
        },
        {
          "host": "api.github.com",
          "port": 443,
          "path": "/graphql",
          "protocol": "graphql",
          "access": "read-only",
          "enforcement": "enforce"
        },
        {
          "host": "github.com",
          "port": 443,
          "path": "/**",
          "protocol": "rest",
          "access": "read-only",
          "enforcement": "enforce"
        }
      ],
      "binaries": [
        "/usr/bin/git",
        "/usr/local/bin/git",
        "/usr/bin/gh",
        "/usr/local/bin/gh"
      ],
      "extensions": {}
    }
  ]
}
```

### Provider Categories

OpenKit should use these initial categories:

| Category | Meaning |
| --- | --- |
| `other` | Provider does not fit a more specific category. |
| `inference` | Model and inference API providers. |
| `agent` | Agent CLIs and coding tools. |
| `source_control` | Git hosting, repository, and source control providers. |
| `messaging` | Chat, email, notification, and messaging APIs. |
| `data` | Data storage, file, database, document, or object-store APIs. |
| `knowledge` | Search, retrieval, and knowledge-base providers. |

These values intentionally align with OpenShell Providers v2.

OpenKit may add categories only when existing categories are insufficient for product routing or UI grouping.

### Credential Declaration Fields

Each credential declaration may include:

| Field | Meaning |
| --- | --- |
| `name` | Profile-local credential name. |
| `description` | Human-readable purpose. |
| `envVars` | Accepted environment variable aliases for discovery or placeholder names. |
| `required` | Whether a provider instance must bind this credential. |
| `authStyle` | One of `basic`, `bearer`, `header`, or `query` for intended injection. |
| `headerName` | Header to inject when `authStyle` needs a header. |
| `queryParam` | Query parameter to inject when `authStyle` uses query credentials. |
| `refresh` | Credential refresh metadata. |

The declaration does not contain the credential value.

### Endpoint Fields

Endpoint objects should align with the backend network policy vocabulary:

| Field | Meaning |
| --- | --- |
| `host` | DNS host. |
| `port` | TCP port. |
| `path` | Optional path glob or protocol-specific path. |
| `protocol` | `rest`, `graphql`, `websocket`, `tcp`, or backend-supported value. |
| `tls` | TLS policy summary or backend-specific extension. |
| `access` | `read-only`, `read-write`, `custom`, or `deny`. |
| `enforcement` | `enforce`, `observe`, or `disabled`. |
| `allowedIps` | Optional SSRF or resolved-IP allowlist. |
| `rules` | Allow rules for REST, GraphQL, WebSocket, or provider-specific protocols. |
| `denyRules` | Explicit deny rules. |
| `persistedQueries` | GraphQL persisted-query handling. |
| `graphqlMaxBodyBytes` | GraphQL request body cap. |
| `requestBodyCredentialRewrite` | Whether body credential rewrite is permitted. |
| `websocketCredentialRewrite` | Whether WebSocket credential rewrite is permitted. |

### Refresh Strategies

OpenKit should reserve these strategy values:

| Strategy | Meaning |
| --- | --- |
| `static` | Credential is updated manually or by operator action. |
| `external` | External process updates the provider instance. |
| `oauth2_refresh_token` | Refresh token exchange mints an access token. |
| `oauth2_client_credentials` | Client credentials flow mints an access token. |
| `google_service_account_jwt` | Service account JWT flow mints an access token. |

OpenKit may initially implement only `static` and `external`.

The schema should keep the other strategies so provider profiles do not need a disruptive redesign later.

Refresh material must be represented as vault references or secure material records, not inline secrets.

## Provider Instance Model

A provider instance binds a provider profile to one concrete configuration and credential set.

```jsonc
{
  "providerInstances": [
    {
      "id": "provider_github_read",
      "profileId": "github",
      "displayName": "GitHub read access",
      "scope": {
        "owner": "workspace",
        "workspaceId": "w_..."
      },
      "credentials": {
        "api_token": {
          "vaultRef": "vault://workspace/w_.../github/read-token",
          "grantId": "grant_...",
          "expiresAt": null
        }
      },
      "config": {},
      "policyMode": "profile-default",
      "status": {
        "readiness": "ready",
        "lastVerifiedAt": null,
        "expiresAt": null
      }
    }
  ]
}
```

Rules:

- `profileId` must reference an accepted provider profile.
- `credentials.*.vaultRef` is a secret reference, not secret material.
- `grantId` links the provider use to a NanoCore vault grant.
- `policyMode` may be `profile-default`, `read-only`, `read-write`, `custom`, or `disabled`.
- Provider instances can be server-scoped, user-scoped, workspace-scoped, organization-scoped, or turn-scoped.
- Backend-native provider names are materialized aliases, not canonical OpenKit IDs.

## Provider Attachments

Provider attachments describe which provider instances the worker session receives.

```jsonc
{
  "providers": {
    "attachments": [
      {
        "id": "attach_github_read",
        "providerInstanceId": "provider_github_read",
        "purpose": "source-code-read",
        "credentialVisibility": "placeholder",
        "policyContribution": "profile-endpoints",
        "allowedBinaries": ["git", "gh"],
        "allowedWorkspaceInputs": ["repo"],
        "dynamic": true
      }
    ]
  }
}
```

`credentialVisibility` values:

| Value | Meaning |
| --- | --- |
| `none` | Credential is not visible to the worker; calls go through a gateway. |
| `placeholder` | Worker receives placeholders that the backend resolves outside prompt context. |
| `process-env` | Worker process receives environment variables. This needs explicit policy approval. |
| `file-handle` | Worker receives a mounted credential file or handle. This needs explicit policy approval. |
| `short-lived-token` | Worker receives a short-lived token. This needs expiry and audit. |
| `backend-private` | Backend uses the credential without exposing it to the process. |

Preferred values are `none`, `placeholder`, and `backend-private`.

`process-env`, `file-handle`, and `short-lived-token` should require stricter permission decisions.

## Vault Fields

`vault` lists the grants and injection contracts needed by the package.

```jsonc
{
  "vault": {
    "grants": [
      {
        "grantId": "grant_...",
        "vaultRef": "vault://workspace/w_.../github/read-token",
        "subject": {
          "agentId": "agent_codex_container",
          "agentSessionId": "as_...",
          "userId": "user_..."
        },
        "capability": "provider:github:api_token",
        "scope": "turn",
        "expiresAt": "2026-06-16T12:00:00.000Z",
        "injectionPaths": ["placeholder", "gateway-header"]
      }
    ],
    "injections": [
      {
        "id": "inj_github_token",
        "grantId": "grant_...",
        "providerAttachmentId": "attach_github_read",
        "path": "placeholder",
        "target": {
          "envVar": "GITHUB_TOKEN"
        },
        "auditRequired": true
      }
    ]
  }
}
```

Rules:

- A package may reference grants but must not embed secret values.
- Every injection must point to a grant.
- Injection paths must be allowed by both the grant and the selected backend.
- The backend can materialize only the injection paths it supports.
- NanoCore audit records must show that a vault reference was used, not the secret value.

## LLM Routing Fields

`llm` describes how the worker obtains model inference.

The recommended OpenShell-backed path is that the worker calls `https://inference.local/v1`, OpenShell strips sandbox-supplied credentials and forwards the request through an authenticated AEP-bound relay to NanoCore's internal worker-inference routes, and NanoCore then selects the real provider, model, credential source, usage attribution, prompt cache metadata, and audit linkage.

In that arrangement, `inference.local` is the sandbox-local endpoint, but NanoCore remains the canonical inference gateway.

```jsonc
{
  "llm": {
    "mode": "gateway",
    "routes": [
      {
        "id": "default",
        "providerInstanceId": "provider_openai_codex_slot_a",
        "model": "gpt-5",
        "endpoint": {
          "kind": "openai-compatible",
          "workerBaseUrl": "https://inference.local/v1",
          "upstream": {
            "kind": "nanocore-gateway",
            "baseUrlRef": "runtime://nanocore/v1"
          }
        },
        "credentialVisibility": "none",
        "promptCache": {
          "enabled": true,
          "keyScope": "runtime-cache-lineage"
        }
      }
    ],
    "headers": {
      "allow": [
        "openai-organization",
        "x-model-id",
        "anthropic-version",
        "anthropic-beta"
      ],
      "stripAuthorization": true
    }
  }
}
```

`mode` values:

| Value | Meaning |
| --- | --- |
| `gateway` | Worker traffic is routed to an OpenKit-managed gateway, either directly or through a backend-local alias such as `inference.local`. |
| `backend-local` | Worker traffic is routed through a backend-managed local inference endpoint whose upstream provider routing is owned by the backend. |
| `direct-external` | Worker calls external provider endpoints directly under network policy. |
| `disabled` | Worker does not receive LLM access from the package. |

Preferred mode is `gateway`.

For OpenShell-backed workers, preferred `gateway` mode still uses the sandbox-local `https://inference.local` endpoint when possible, but OpenShell should route that endpoint to NanoCore's authenticated worker-inference routes instead of the generic public `/v1` routes or a backend-owned final provider selection.

`backend-local` is acceptable only when the backend can preserve OpenKit provider IDs, usage, prompt cache metadata, and audit linkage.

`direct-external` should require explicit policy because the worker may see provider API shapes and because credential isolation depends on backend enforcement.

Rules:

- Workers should not receive real LLM provider API keys.
- Sandbox-supplied `Authorization` headers should be stripped before upstream inference.
- NanoCore should authenticate the sandbox or control session before honoring requests forwarded from `inference.local`.
- NanoCore should map forwarded inference calls to workspace, thread, turn, agent session, provider instance, and request IDs.
- NanoCore should record capability calls, usage, and audit events for forwarded inference.
- If a backend-level `inference.local` implementation cannot preserve NanoCore lineage, provider IDs, usage, and audit, NanoCore should use an OpenKit-owned authenticated relay to the internal worker-inference route instead.
- Worker authority-bearing lineage must come from an authenticated AEP and lease binding, not request-body `metadata.openkit` or runtime-supplied headers.
- Runtime-native causal origin and runtime cache lineage must follow `docs/specs/20260711-worker_runtime_subagent_provenance.md`; the shared outer OpenKit thread, turn, or agent session must not become the cache key for every runtime-internal child.
- An AEP that requires complete worker-inference attribution must configure the root runtime and every runtime-internal child to use `inference.local`, withhold direct provider credentials, deny direct provider API egress, and fail capability negotiation when the backend cannot prove that coverage; `backend-local` and `direct-external` modes must report attribution as incomplete unless they satisfy the same authenticated relay contract.

## Policy Intent

`policy` expresses the policy NanoCore wants enforced.

```jsonc
{
  "policy": {
    "decisions": [
      {
        "decisionId": "pd_...",
        "action": "use-provider",
        "resource": "provider_github_read",
        "decision": "allow",
        "enforcementPoint": "capability-gateway"
      }
    ],
    "filesystem": {
      "default": "deny",
      "readOnly": ["/usr", "/lib", "/openkit/instructions", "/workspace/data"],
      "readWrite": ["/workspace/repo", "/workspace/output", "/tmp"],
      "includeWorkingDirectory": true
    },
    "process": {
      "allowedUsers": ["openkit-worker"],
      "allowPrivilegeEscalation": false,
      "allowedBinaries": [
        "/usr/bin/git",
        "/usr/bin/gh",
        "/usr/bin/node",
        "/usr/local/bin/codex"
      ],
      "denyBinaries": []
    },
    "network": {
      "default": "deny",
      "providerDerived": true,
      "customEndpoints": [],
      "denyEndpoints": []
    },
    "secrets": {
      "defaultVisibility": "none",
      "allowedInjectionPaths": ["placeholder", "gateway-header"]
    },
    "humanApproval": {
      "requiredFor": [
        "external-side-effect",
        "credential-process-env",
        "write-source-control",
        "network-outside-provider-policy"
      ]
    }
  }
}
```

Policy intent maps to backend enforcement artifacts.

For OpenShell, it may compile into:

- `filesystem_policy`
- `landlock`
- `process`
- `network_policies`
- provider-derived `_provider_*` policy layers
- inference routing settings
- provider attachment commands

For Kubernetes, it may compile into:

- pod security context
- resource requests and limits
- network policy
- volume mounts
- secret projection rules
- sidecar proxy config

## Policy Static And Dynamic Fields

Policy fields should be marked static or dynamic.

Initial classification:

| Field area | Default classification | Notes |
| --- | --- | --- |
| Image | Static | Requires new session. |
| Command | Static | Requires new session. |
| User and group | Static | Requires new session. |
| Filesystem mounts | Static | Usually requires new session. |
| Read/write path access | Static unless backend supports live remount. | OpenShell-style filesystem policy is static. |
| Network endpoint policy | Dynamic when backend supports hot reload. | OpenShell-style network policies can be dynamic. |
| Provider attachments | Dynamic for future process launches when backend supports attach/detach. | Existing processes usually keep their original environment. |
| Credential refresh | Dynamic for backend-private or placeholder resolution. | Existing process env should not mutate. |
| LLM route | Dynamic only when gateway endpoint remains stable. | Otherwise requires new session. |
| Resource limits | Backend-specific. | Some runtime limits cannot change safely. |
| Audit export | Dynamic when backend supports it. | OpenShell OCSF JSON can be toggled without restart. |

## Resource Limits

`resources` defines resource intent and budget hooks.

```jsonc
{
  "resources": {
    "cpu": {
      "limit": "4"
    },
    "memory": {
      "limit": "8Gi"
    },
    "disk": {
      "limit": "50Gi"
    },
    "wallClock": {
      "maxSeconds": 7200
    },
    "processes": {
      "max": 256
    },
    "network": {
      "egressBytes": null
    },
    "llm": {
      "maxInputTokens": null,
      "maxOutputTokens": null,
      "maxCostUsd": null
    }
  }
}
```

NanoCore should enforce LLM budgets at the gateway when possible.

Backends may enforce CPU, memory, disk, and process limits.

## Observability And Audit

`observability` defines what evidence NanoCore expects.

```jsonc
{
  "observability": {
    "audit": {
      "required": true,
      "sink": "nanocore",
      "events": [
        "sandbox.lifecycle",
        "policy.applied",
        "network.decision",
        "filesystem.decision",
        "process.launch",
        "provider.credential_resolution",
        "llm.route",
        "artifact.sync"
      ]
    },
    "logs": {
      "workerStdout": "item-summary",
      "workerStderr": "diagnostic-summary",
      "backendSecurity": "audit",
      "backendDebug": "diagnostics"
    },
    "formats": {
      "accept": ["ocsf-json", "jsonl", "text-summary"],
      "preferred": "ocsf-json"
    },
    "redaction": {
      "required": true,
      "forbiddenPatterns": ["secret-values", "authorization-headers", "raw-provider-payloads"]
    }
  }
}
```

Rules:

- Product surfaces should not replay raw backend security logs as chat history.
- Backend security logs should become audit records or compact status items.
- Audit records must link to workspace, thread, turn, agent session, provider instance, vault grant, and permission decision IDs where possible.
- OCSF JSON is accepted as a backend evidence format but not the canonical OpenKit `AuditEvent` schema.
- NanoCore should store backend evidence references or normalized records, not unrestricted raw logs forever.

## Backend Requirements

`backend` declares materialization requirements and selection constraints.

```jsonc
{
  "backend": {
    "preferred": "openshell",
    "allowedKinds": ["openshell", "docker", "kubernetes", "vm", "managed-sandbox", "custom"],
    "requiredCapabilities": [
      "container",
      "transcript-sink",
      "network-policy",
      "provider-attachments",
      "credential-placeholder",
      "nanocore-inference-upstream",
      "audit-export"
    ],
    "degrade": {
      "allowHostMode": false,
      "allowMissingOcsf": false,
      "allowDirectExternalInference": false
    },
    "extensions": {
      "openshell": {
        "computeDriver": "docker",
        "providersV2Required": true,
        "ocsfJsonEnabled": true
      }
    }
  }
}
```

Backend capability names should include:

| Capability | Meaning |
| --- | --- |
| `container` | Can launch local containers. |
| `remote-container` | Can launch remote containerized workers. |
| `vm` | Can launch VM or microVM workers. |
| `filesystem-policy` | Can enforce filesystem read/write constraints. |
| `network-policy` | Can enforce network endpoint policy. |
| `process-policy` | Can enforce process user, binary, or child-process constraints. |
| `transcript-sink` | Can preserve worker-written `/openkit/session/*.jsonl` files for turn-end import. |
| `control-relay` | Can carry OpenKit worker control traffic between NanoCore and the sandbox. |
| `sandbox-local-endpoint` | Can expose stable sandbox-local endpoints such as `openkit.local` or `inference.local`. |
| `sidecar-control-endpoint` | Can run an OpenKit-owned sandbox-local sidecar such as `control.local` and route it outbound to NanoCore. |
| `generic-local-endpoint-relay` | Can map an arbitrary sandbox-local endpoint onto a backend-native authenticated relay session. |
| `service-forwarding` | Can expose sandbox loopback services through backend-managed URLs for debugging, previews, or operator inspection. |
| `provider-attachments` | Can attach provider instances to worker sessions. |
| `credential-placeholder` | Can expose placeholders and resolve credentials outside prompts. |
| `gateway-header-injection` | Can inject credentials at gateway boundary. |
| `backend-local-inference` | Can provide local inference route inside sandbox. |
| `nanocore-inference-upstream` | Can forward sandbox-local inference traffic to NanoCore's `/v1` gateway while preserving session identity. |
| `audit-export` | Can export structured security events. |
| `dynamic-network-policy` | Can update network policy while a session runs. |
| `dynamic-provider-attach` | Can attach or detach providers while a session runs. |
| `object-store-mount` | Can mount object-store sources. |
| `snapshot` | Can capture and resume workspace or runtime snapshots. |
| `file-upload-download` | Can move declared files or bundles into and out of the worker runtime through backend-native transport. |
| `git-materialization` | Can materialize a Git repository at a requested ref and collect Git-derived changes. |
| `change-set-collection` | Can collect declared workspace changes and return a manifest, patch, bundle, or file list to NanoCore. |
| `interactive-resume` | Can reconnect to a running or paused worker session without losing product lineage. |
| `backend-service-readiness` | Can prove gateway, supervisor, sandbox, provider, or file-transfer readiness before NanoCore treats a session as launchable. |

## OpenShell-First Backend Strategy

OpenShell is the first-class backend for governed local and remote container execution.

It is also the reference implementation for policy rendering, provider attachments, gateway-mediated inference, sandbox lifecycle evidence, and backend-native file transfer.

That does not make OpenShell the canonical OpenKit control plane.

The canonical design rule is OpenShell-first, OpenKit-owned semantics, capability-based portability.

OpenKit should intentionally use OpenShell's strongest mechanisms where they reduce product risk or implementation cost:

- Gateway and sandbox lifecycle management.
- Network, process, and filesystem policy enforcement where supported.
- Provider attachment and credential projection.
- `inference.local` or equivalent local endpoint projection when it can preserve NanoCore usage and audit lineage.
- `openshell sandbox upload`, `openshell sandbox download`, `openshell sandbox exec`, and future file primitives for backend-native transport.
- OpenShell OCSF and supervisor logs as enforcement evidence.

OpenKit must not expose these mechanisms as stable product semantics.

OpenKit-owned semantics include:

- workspace, thread, turn, item, artifact, approval, goal, worker turn, and Action Center lifecycle
- Agent Environment Package snapshots and materialization decisions
- permission decisions, vault grants, provider instance lineage, usage records, and audit linkage
- workspace input snapshots, materialization records, change sets, staged workspace reviews, and apply results
- public App API, MCP, Web UI, and protocol response shapes
- human review gates before accepting changes, committing, pushing, deploying, or triggering external side effects

Backend-owned implementation details include:

- OpenShell Gateway names, sandbox ids, provider handles, policy YAML, supervisor payloads, private process ids, and file-transfer commands
- Docker container ids, Kubernetes pod names, VM ids, hosted sandbox ids, and provider-private file handles
- backend retry state, private readiness probes, raw logs, temporary credentials, and raw environment values

OpenKit may preserve backend-private details in restricted runtime storage when recovery requires them, but public surfaces should receive only redacted summaries, OpenKit-issued ids, and normalized evidence references.

### Capability-Based Portability

Portable backend support should be capability-based, not lowest-common-denominator based.

NanoCore should select or reject a backend by matching the Agent Environment Package and workspace materialization plan against declared capabilities.

When a backend lacks a required capability, NanoCore should fail before launch with a redacted diagnostic instead of silently degrading product guarantees.

When a backend supports an optional capability, NanoCore may choose a richer strategy for that backend while preserving the same OpenKit records.

Examples:

- OpenShell may use provider attachments and network policies to expose GitHub read access, while another backend may report unavailable or degraded credential and network enforcement.
- OpenShell may use upload and download primitives for file transport, while Docker may use `docker cp`, Kubernetes may use an exec or volume strategy, and hosted sandboxes may use provider file APIs.
- OpenShell may expose structured OCSF evidence, while another backend may emit compact lifecycle summaries; both are backend evidence until NanoCore normalizes them.
- A backend with `git-materialization` may clone or fetch directly inside the worker runtime, while a backend without it must receive a prepared snapshot or fail if Git materialization is required.

Backend portability therefore increases implementation complexity in a controlled way.

The project should pay that cost only at product boundaries where backend lock-in would otherwise leak into durable records, review gates, public APIs, or recovery semantics.

It should not create abstract interfaces for hypothetical features until at least one product path needs the boundary.

## Worker Governance Backend Interface

Every backend adapter should implement the same conceptual interface.

```ts
interface WorkerGovernanceBackend {
  describeCapabilities(): BackendCapabilities;
  validatePackage(input: AgentEnvironmentPackage): BackendValidationResult;
  materialize(input: AgentEnvironmentPackage): Promise<MaterializedWorkerEnvironment>;
  launch(input: MaterializedWorkerEnvironment): Promise<WorkerSessionHandle>;
  update(handle: WorkerSessionHandle, update: WorkerEnvironmentUpdate): Promise<WorkerUpdateResult>;
  collectEvidence(handle: WorkerSessionHandle): AsyncIterable<WorkerEvidenceEvent>;
  collectArtifacts(handle: WorkerSessionHandle): Promise<ArtifactCollectionResult>;
  teardown(handle: WorkerSessionHandle): Promise<WorkerTeardownResult>;
}
```

### `describeCapabilities`

The backend declares static and dynamic capabilities.

NanoCore uses this to select a backend or reject a package before starting a worker.

### `validatePackage`

The backend checks backend-specific constraints.

Validation must be redacted and safe for diagnostics.

Examples:

- unsupported image type
- unsupported mount source
- unsupported credential injection path
- unsupported policy field
- backend driver unavailable
- missing provider profile support
- missing audit export support

### `materialize`

The backend converts the OpenKit package into backend-native artifacts.

The result must separate redacted diagnostic metadata from sensitive backend-private data.

### `launch`

The backend starts the worker session.

Launch must return a stable OpenKit-facing session handle.

The handle may include backend-private references in storage, but App API and protocol surfaces should receive only redacted summaries.

### `update`

The backend applies dynamic updates when possible.

If a requested update touches static material, the backend must report `requires_session_recreate`.

### `collectEvidence`

The backend streams security, lifecycle, and policy evidence back to NanoCore.

NanoCore decides which evidence becomes audit, item summaries, diagnostics, or artifacts.

### `collectArtifacts`

The backend collects declared outputs and registers artifacts through NanoCore.

Artifact collection must preserve source path summaries without exposing sensitive backend paths.

### `teardown`

The backend stops the worker session and releases temporary resources.

Teardown should emit final evidence and mark cleanup failures distinctly from worker task failures.

## OpenShell Backend Mapping

An OpenShell backend should map OpenKit package fields as follows.

| OpenKit field | OpenShell materialization |
| --- | --- |
| `runtime.image` | Sandbox image or compute driver image setting. |
| `runtime.command.argv` | Sandbox command after supervisor starts. |
| `workspace.inputs` | Bind mounts, staged files, repository checkout, or backend-supported mounts. |
| `workspace.outputs` | Output directories plus artifact collection. |
| `control.transcript` | Writable `/openkit/session/*.jsonl` directory collected at turn end. |
| `control.endpoint` with `implementation: "openkit-sidecar"` | OpenKit sidecar or shim inside the sandbox provides `https://control.local` and connects outbound to NanoCore. |
| `control.endpoint` with `implementation: "backend-relay"` | Future or custom OpenShell generic local endpoint relay over the authenticated Gateway/Supervisor session. |
| `providerProfiles` | Built-in or custom OpenShell provider profiles. |
| `providerInstances` | OpenShell providers created or referenced through gateway state. |
| `providers.attachments` | Sandbox `--provider` attachments or runtime attach commands. |
| `policy.filesystem` | `filesystem_policy` and Landlock settings. |
| `policy.process` | OpenShell `process` and binary policy where supported. |
| `policy.network` | `network_policies` plus provider-derived layers. |
| `llm.mode: gateway` with `workerBaseUrl: https://inference.local/v1` | OpenShell `inference.local` privacy router forwarding through an authenticated AEP-bound relay to NanoCore's internal worker-inference routes. |
| `llm.mode: backend-local` | OpenShell `inference.local` owns final provider routing when explicitly selected. |
| `observability.formats.preferred: ocsf-json` | OpenShell OCSF JSON export setting. |
| `resources.cpu` and `resources.memory` | Sandbox create `--cpu` and `--memory` where driver supports them. |

OpenShell-specific constraints:

- OpenShell is the first-class container backend and reference implementation, but OpenKit product semantics remain NanoCore-owned.
- Provider-derived policy layers are derived materialization output and must not become canonical NanoCore policy records.
- Provider attach or detach affects future effective policy reads and future process launches, but already-running processes may keep their original environment.
- Filesystem policy is static and requires sandbox recreation when changed.
- Network policy may be dynamic when OpenShell supports policy update for the selected session.
- `inference.local` should initially forward to NanoCore's internal worker-inference routes so NanoCore keeps authenticated package lineage, provider, model, usage, prompt cache, and audit ownership.
- If OpenShell itself owns final `inference.local` provider routing, NanoCore must treat that as `backend-local` mode and require explicit audit and usage preservation checks.
- Stock OpenShell must not be assumed to support arbitrary `control.local` routing through the `inference.local` privacy router.
- The no-fork OpenShell integration should provide `control.local` through an OpenKit sidecar or shim packaged into the sandbox image.
- The sidecar should use ordinary outbound connectivity allowed by OpenShell network policy to reach NanoCore's Worker Control Gateway.
- OpenShell service forwarding is not the canonical OpenKit worker control channel and should be reserved for debug, preview, notebook, or operator inspection use cases.
- If OpenShell later exposes a generic sandbox-local endpoint relay, the OpenShell Gateway/Supervisor session can carry the OpenKit worker control channel, but the OpenKit worker control protocol remains NanoCore-owned.
- OpenShell Gateway should be managed by NanoCore as a backend service, sidecar process, or deployment-selected external service; the first integration should not depend on embedding OpenShell Gateway as a stable in-process library.
- OpenShell file transfer, sandbox filesystem access, or declared output collection can collect `/openkit/session/*.jsonl` after turn completion.
- OpenShell supervisor and OCSF logs are enforcement evidence and must not be treated as canonical `Item` streams.
- OpenKit must not assume all Providers v2 roadmap items are implemented by a specific OpenShell version.

## OpenAI-style Hosted Sandbox Mapping

A hosted sandbox backend should map OpenKit package fields as follows.

| OpenKit field | Hosted sandbox materialization |
| --- | --- |
| `workspace.inputs` | Manifest files, directories, repositories, remote mounts, and setup commands. |
| `workspace.outputs` | Declared output directories synced back after turn completion. |
| `runtime.command` | Agent startup command or worker entrypoint. |
| `supply.skills` | Uploaded or generated files in the sandbox workspace. |
| `providers.attachments` | Backend-specific credential handles or gateway endpoints. |
| `llm.mode: gateway` | OpenKit gateway endpoint visible from hosted sandbox. |
| `policy.network` | Backend network policy or proxy restrictions. |
| `policy.filesystem` | Backend filesystem mount access settings. |

Hosted sandbox backends must still report NanoCore audit lineage.

## Canonical Package Snapshot Example

This example is intentionally compact but shows how the fields fit together.

```jsonc
{
  "schemaVersion": 1,
  "packageId": "aepkg_codex_github_001",
  "snapshotId": "aepsnap_codex_github_001",
  "scope": {
    "workspaceId": "w_main",
    "threadId": "thread_123",
    "turnId": "turn_456",
    "agentSessionId": "as_789",
    "userId": "user_abc",
    "requestId": "req_def"
  },
  "agent": {
    "agentId": "agent_codex_container",
    "profileId": "coder",
    "runtimeKind": "codex",
    "capabilityRequests": ["llm", "shell", "filesystem", "network", "git", "artifacts"]
  },
  "runtime": {
    "image": {
      "kind": "container-image",
      "ref": "ghcr.io/openkit/codex-worker:2026-06-16",
      "digest": "sha256:..."
    },
    "command": {
      "argv": ["codex", "app-server", "--listen", "stdio://"],
      "workingDirectory": "/workspace/repo"
    }
  },
  "workspace": {
    "root": "/workspace",
    "inputs": [
      {
        "id": "repo",
        "kind": "repository",
        "source": {
          "kind": "git",
          "url": "https://github.com/example/project.git",
          "ref": "main"
        },
        "target": "/workspace/repo",
        "access": "read-write"
      }
    ],
    "outputs": [
      {
        "id": "default-output",
        "path": "/workspace/output",
        "registerAsArtifacts": true
      }
    ]
  },
  "supply": {
    "binaries": [
      {
        "id": "git",
        "path": "/usr/bin/git",
        "required": true,
        "allowedProviderIds": ["provider_github_read"]
      }
    ],
    "skills": []
  },
  "control": {
    "protocol": "openkit-worker-control-v1",
    "mode": "transcript-sink",
    "transcript": {
      "root": "/openkit/session",
      "eventsPath": "/openkit/session/events.jsonl",
      "itemsPath": "/openkit/session/items.jsonl",
      "artifactsPath": "/openkit/session/artifacts.jsonl",
      "flush": "line",
      "import": "turn-end",
      "required": true
    },
    "adapter": {
      "kind": "openkit-worker-shim",
      "targetRuntime": "codex",
      "targetTransport": "stdio"
    }
  },
  "providers": {
    "providerInstances": [
      {
        "id": "provider_github_read",
        "profileId": "github",
        "credentials": {
          "api_token": {
            "vaultRef": "vault://workspace/w_main/github/read-token",
            "grantId": "grant_github_read"
          }
        },
        "policyMode": "read-only"
      }
    ],
    "attachments": [
      {
        "id": "attach_github_read",
        "providerInstanceId": "provider_github_read",
        "credentialVisibility": "placeholder",
        "policyContribution": "profile-endpoints",
        "allowedBinaries": ["git"]
      }
    ]
  },
  "llm": {
    "mode": "gateway",
    "routes": [
      {
        "id": "default",
        "providerInstanceId": "provider_openai_codex_slot_a",
        "model": "gpt-5",
        "endpoint": {
          "kind": "openai-compatible",
          "workerBaseUrl": "https://inference.local/v1",
          "upstream": {
            "kind": "nanocore-gateway",
            "baseUrlRef": "runtime://nanocore/v1"
          }
        },
        "credentialVisibility": "none"
      }
    ]
  },
  "policy": {
    "filesystem": {
      "default": "deny",
      "readOnly": ["/usr", "/lib"],
      "readWrite": ["/workspace/repo", "/workspace/output", "/tmp"]
    },
    "network": {
      "default": "deny",
      "providerDerived": true
    },
    "secrets": {
      "defaultVisibility": "none",
      "allowedInjectionPaths": ["placeholder", "gateway-header"]
    }
  },
  "observability": {
    "audit": {
      "required": true,
      "sink": "nanocore",
      "events": ["sandbox.lifecycle", "network.decision", "provider.credential_resolution", "llm.route"]
    },
    "formats": {
      "preferred": "ocsf-json"
    }
  },
  "backend": {
    "preferred": "openshell",
    "allowedKinds": ["openshell", "docker", "kubernetes"],
    "requiredCapabilities": [
      "container",
      "transcript-sink",
      "network-policy",
      "provider-attachments",
      "credential-placeholder",
      "nanocore-inference-upstream",
      "audit-export"
    ],
    "extensions": {
      "openshell": {
        "computeDriver": "docker",
        "providersV2Required": true,
        "ocsfJsonEnabled": true
      }
    }
  },
  "extensions": {}
}
```

## Storage And Data Ownership

Authored provider profiles may live under:

```text
DATA_ROOT/config/provider-profiles/*.provider-profile.jsonc
```

Provider instances may live under:

```text
DATA_ROOT/config/providers/*.provider.jsonc
DATA_ROOT/users/<user-id>/config/providers/*.provider.jsonc
DATA_ROOT/workspaces/<workspace-id>/config/providers/*.provider.jsonc
```

Agent environment package snapshots may live under:

```text
DATA_ROOT/workspaces/<workspace-id>/runtime/agent-environments/<agent-session-id>/<snapshot-id>.json
```

Backend materialization records may live under:

```text
DATA_ROOT/users/<user-id>/workspaces/<workspace-id>/runtime/agent-sessions/<agent-session-id>/backend/<materialization-id>.json
```

Backend-private files, credentials, tokens, container state, VM state, and sandbox working directories must not be stored in normal workspace config.

If they need persistence, they must live in server-owned runtime storage, backend-owned storage, or vault-owned storage with explicit retention policy.

## Relationship To Existing Specs

This spec extends the earlier supporting detail in `docs/specs/superseded/worker-runtime/20260526-workspace_data_mounts.md`.

Runtime-internal sub-agent provenance, trusted worker-inference identity, and runtime cache lineage are specialized by `docs/specs/20260711-worker_runtime_subagent_provenance.md`.

The earlier `host-dir` reference remains useful only as historical host-local mount material. The canonical target vocabulary is workspace-owned or workspace-linked materialization, not host ownership.

This spec defines the broader manifest and materialization contract needed for container, remote, object-store, hosted sandbox, and governed provider access.

This spec complements `docs/specs/20260628-agent_setup_runtime_supply_contract.md`.

It does not replace `Agent`, `AgentProfile`, or `AgentSession`.

It defines the environment package resolved for a concrete session.

This spec complements `docs/specs/20260628-nanocore_config_identity_contract.md`.

Server config remains the source for deployment-level providers and defaults.

The environment package is the per-session resolved snapshot.

This spec complements `docs/specs/20260526-llm_gateway_responses_api.md`.

The LLM gateway remains NanoCore-owned unless a backend-local inference route is explicitly selected and can preserve OpenKit usage and audit linkage. A backend-local route cannot claim complete worker-inference attribution unless it also satisfies the authenticated relay and direct-egress blocking contract.

## Alternatives Considered

### Make OpenShell YAML the canonical OpenKit config

Rejected.

OpenShell's schema is strong, but it is backend-specific.

Making it canonical would couple OpenKit product concepts to one enforcement backend and would make future Docker-only, Kubernetes-only, hosted sandbox, or custom backend support harder.

OpenKit needs stable IDs, product lineage, user and workspace ownership, vault grant references, permission decisions, and audit record linkage that are not native OpenShell concepts.

OpenShell should remain the reference backend and may strongly influence field vocabulary, but OpenKit records must stay canonical.

The acceptable form of dependency is an adapter that compiles OpenKit-owned records into OpenShell-native artifacts and then normalizes OpenShell evidence back into OpenKit-owned records.

The unacceptable form of dependency is public App API, MCP, Web UI, Action Center, or storage records that require consumers to understand OpenShell-native ids, YAML, gateway state, provider payloads, or supervisor logs.

### Design every field from scratch

Rejected.

OpenShell Providers v2 already has a mature field vocabulary for provider categories, credentials, discovery, endpoints, binary allowlists, policy contribution, and refresh metadata.

OpenAI-style sandbox manifests already show a useful workspace setup vocabulary.

OpenKit should not waste effort redesigning common fields when mature reference designs exist.

### Keep only host-local harnesses until later

Rejected as a long-term architecture.

Host-local harnesses are useful for local dogfooding, but they have weak isolation and cannot satisfy the product direction for governed worker agents, remote containers, provider-controlled credentials, and security audit.

### Put all enforcement in NanoCore

Rejected.

NanoCore should own policy decisions and audit, but filesystem, process, network, and credential enforcement must happen where the worker runs.

That requires a backend supervisor, sidecar, container runtime, VM boundary, hosted sandbox provider, or OS-level controls.

### Put all enforcement in backend policy and skip NanoCore policy

Rejected.

The backend cannot own OpenKit's product semantics.

NanoCore must know which user, workspace, thread, turn, agent session, provider instance, vault grant, and permission decision caused an action.

## Consequences

- OpenKit gains one portable contract for governed worker execution.
- OpenShell can be integrated as an enforcement backend without becoming the product control plane.
- Provider profile design work becomes much smaller because OpenKit can adopt the mature OpenShell vocabulary.
- Workspace materialization becomes explicit enough to support workspace-linked directories, repositories, generated files, object stores, prior artifacts, and hosted sandbox manifests.
- NanoCore can keep provider, vault, policy, and audit semantics canonical.
- Backends can evolve independently behind a materializer interface.
- Schema implementation will be non-trivial and should be staged.
- The first backend integration must be conservative about OpenShell features that are declared roadmap or partially implemented.

## Rollout / Migration Plan

### Phase 0: Reference And Schema Draft

1. Accept this spec as the design direction.
2. Use temp-only researcher evidence for OpenShell Providers v2, policy, inference routing, compute drivers, and observability; promote accepted conclusions into this spec or follow-up specs with stable source citations.
3. Use temp-only researcher evidence for OpenAI-style sandbox workspace manifests; promote accepted conclusions into this spec or follow-up specs with stable source citations.
4. Decide which field names should be exact OpenShell-compatible names and which should use OpenKit camelCase style.

### Phase 1: Schema-only Package Model

1. Add schema types in an app-local package or NanoCore-local module.
2. Add fixtures for one Codex container package with GitHub read-only provider and OpenKit LLM gateway.
3. Add fixtures for one data-analysis package with a read-only object-store mount.
4. Add validation for no raw secrets, no host path escapes, unique IDs, supported provider categories, and backend capability requirements.
5. Add redacted package snapshot generation.

### Phase 2: Provider Profile And Instance Registry

1. Add provider profile registry with OpenShell-inspired profiles.
2. Add provider instance records that use `secretRef` or `vaultRef`.
3. Add readiness checks for missing profiles, missing grants, missing required credentials, expired credentials, and disabled providers.
4. Add UI diagnostics that show provider profile, instance, readiness, category, and policy summary without secrets.

### Phase 3: OpenShell Materializer Spike

1. Implement a read-only materializer that compiles one package fixture into OpenShell provider profile references, provider attachments, policy YAML, and sandbox create options.
2. Do not start real workers in the first slice.
3. Add golden tests for generated backend artifacts.
4. Add tests that reject unsupported static-to-dynamic updates.
5. Add tests that keep backend-native generated material out of protocol and public app schemas.

### Phase 4: Local Container Worker Spike

1. Start a local OpenShell-backed sandbox for a Codex or OpenCode worker.
2. Materialize `/openkit/session/*.jsonl` as the durable transcript sink.
3. Package an OpenKit sidecar or shim that exposes `https://control.local/v1/worker-control` inside the sandbox.
4. Allow only the sidecar binary to reach NanoCore's Worker Control Gateway for live progress and bounded commands.
5. Expose only the OpenKit LLM gateway route by default for model traffic, preferably through `https://inference.local/v1` when OpenShell can forward through the authenticated AEP-bound relay to NanoCore's internal worker-inference routes.
6. Attach GitHub read-only provider.
7. Record policy application and sandbox lifecycle evidence.
8. Collect declared output artifacts.
9. Mark the session degraded if required audit export, transcript sink, provider policy composition, or control sidecar readiness is unavailable.

### Phase 5: Product Integration

1. Surface backend readiness and sandbox summaries in the agent catalog.
2. Surface provider attachments and policy summary in worker diagnostics.
3. Surface policy denials and blocked capabilities through Action Center rows.
4. Normalize backend evidence into OpenKit audit records.
5. Add worker and agent-network status panels backed by NanoCore worker session state, not direct sandbox connections.
6. Add compact live progress stream support for phase, heartbeat, blocked reason, policy denial summary, artifact count, elapsed time, estimated cost, and available actions.
7. Add user actions for cancel, interrupt, approval result, and policy adjustment request through NanoCore.
8. Add artifact review flow for collected outputs.

### Phase 6: Native Backend Relay Evaluation

1. Evaluate whether the selected OpenShell version exposes a generic sandbox-local endpoint relay suitable for `control.local`.
2. If it does, implement `control.endpoint.implementation: "backend-relay"` behind the same OpenKit worker control protocol.
3. If it does not, continue using `openkit-sidecar` and keep OpenShell unmodified.
4. Do not use OpenShell service forwarding as the product control channel.
5. Keep NanoCore's Web UI, item model, audit model, and transcript import independent from the selected relay implementation.

## Testing Strategy

### Schema Tests

- Accept valid package fixtures for OpenShell container, plain Docker, Kubernetes, VM, remote gateway, and hosted sandbox intents.
- Reject unknown top-level fields outside `extensions`.
- Reject raw secret-like fields in package snapshots.
- Reject control channel configs that lack workspace, thread, turn, agent session, or sandbox session identity binding.
- Reject provider instances with missing required credentials.
- Reject provider attachments without vault grants.
- Reject duplicate IDs inside package sections.
- Reject unsupported provider categories.
- Reject invalid credential visibility for a provider grant.
- Reject workspace paths with absolute host paths when deployment policy forbids them.
- Reject path traversal and symlink escapes.
- Reject output paths outside declared workspace root.

### Resolver Tests

- Resolve package from server config, agent setup, workspace roots, provider registry, and turn request.
- Prefer OpenKit LLM gateway mode by default.
- Mark sessions stale when static package fields change.
- Preserve dynamic policy updates only when backend capabilities declare support.
- Fail before launch when a required backend capability is missing.
- Require approval when policy says provider write access, external side effects, process-env credentials, or network outside provider policy need human authorization.

### Materializer Tests

- Compile provider profiles and attachments into backend-native artifacts.
- Compile `/openkit/session` transcript sink mounts and collection paths.
- Compile optional sandbox-local `control.local` routing without exposing raw session tokens.
- Compile no-fork OpenShell live progress mode to an OpenKit sidecar plus outbound NanoCore Worker Control Gateway route.
- Reject package materialization that assumes stock OpenShell `inference.local` can route arbitrary OpenKit control requests.
- Reject package materialization that uses OpenShell service forwarding as the canonical OpenKit worker control channel.
- Compile `inference.local` routing to NanoCore's authenticated internal worker-inference routes when `llm.mode` is `gateway`.
- Generate OpenShell-style policy with provider-derived network rules where supported.
- Generate redacted materialization records.
- Do not persist derived provider rules as canonical NanoCore policy.
- Keep backend-private handles out of App API diagnostics.
- Round-trip package snapshots without secret values.

### Runtime Tests

- Launch a fake worker through a fake backend and stream lifecycle evidence.
- Launch a fake worker shim that writes `events.jsonl`, `items.jsonl`, and `artifacts.jsonl`, then verify NanoCore imports canonical items and artifacts at turn end.
- Verify NanoCore rejects transcript records with mismatched workspace, thread, turn, agent session, or package snapshot IDs.
- Launch a fake OpenKit control sidecar that accepts `control.local` events and relays compact progress to NanoCore.
- Verify live progress updates worker phase, heartbeat, blocked reason, policy denial summary, artifact count, elapsed time, and available actions without creating canonical item records unless NanoCore explicitly imports or promotes them.
- Verify live relay disconnection does not lose turn evidence when transcript sink files are present.
- Verify undelivered cancel, interrupt, and approval-result commands are persisted with delivery status and request IDs.
- Verify optional live control can route active-turn input, interrupt, cancellation, and approval-result commands while preserving request IDs when enabled.
- Launch a fake OpenShell backend that reports policy apply success, network deny, credential placeholder resolution, and teardown.
- Verify OpenShell OCSF evidence can produce audit records without becoming canonical item deltas.
- Verify forwarded `inference.local` requests map to workspace, thread, turn, agent session, provider instance, usage, and audit records.
- Verify dynamic provider attach reports that already-running processes may need restart.
- Verify artifact collection registers output artifacts with thread, turn, and input lineage.
- Verify failed backend audit setup blocks launch when audit is required.

### Product Tests

- Agent catalog shows backend, sandbox, provider, and readiness summaries without backend-private internals.
- Action Center shows approval or blocked-state rows for policy-required decisions.
- Turn review surfaces show imported transcript items and artifacts without requiring live worker streaming.
- Agent network panels show compact NanoCore worker session status without connecting directly to sandbox services.
- Cancel, interrupt, approval result, and policy adjustment actions are submitted to NanoCore and reflected as command or review state.
- Thread item history is driven by NanoCore canonical item imports, not backend supervisor logs.
- Audit view can query by workspace, thread, turn, agent session, provider instance, vault grant, and permission decision.

## Risks & Mitigations

### Risk: OpenShell Schema Drift

OpenShell is still evolving.

Mitigation: keep OpenKit canonical schemas independent, store OpenShell compatibility under backend extensions, and pin adapter tests to selected OpenShell versions.

### Risk: Configuration Surface Becomes Too Large

The package can become intimidating.

Mitigation: users should author high-level agent, provider, and workspace config fragments; NanoCore should generate the resolved package snapshot.

### Risk: Backend Evidence Is Mistaken For Product Truth

Backend logs are enforcement evidence, not the primary product record.

Mitigation: normalize evidence into OpenKit audit records and item summaries with stable lineage.

### Risk: Secret Injection Semantics Become Ambiguous

Different backends expose secrets differently.

Mitigation: require every provider attachment to declare credential visibility and every injection to link to a vault grant.

### Risk: Host-Local Harnesses Look Safer Than They Are

Host-local staging and development harnesses may not enforce policy strongly.

Mitigation: host-local harness readiness must report degraded isolation and must not claim filesystem, network, or process enforcement that it cannot provide.

### Risk: Dynamic Updates Are Misunderstood

Provider attach, credential refresh, or policy update may not affect already-running processes.

Mitigation: classify fields as static or dynamic and mark sessions stale when changes need a process or sandbox restart.

### Risk: Control Sidecar Becomes A Shadow Control Plane

The OpenKit control sidecar could accidentally accumulate product logic, authorization rules, or item sequencing behavior.

Mitigation: keep the sidecar as a transport and runtime adapter only; NanoCore must own command authorization, worker state, item IDs, canonical sequence numbers, audit linkage, and Web UI projections.

### Risk: OpenShell Service Forwarding Is Misused As Worker Control

Service forwarding can make a sandbox loopback process reachable through backend-managed URLs, which is useful for debugging and previews but has the wrong direction and ownership for canonical OpenKit worker control.

Mitigation: tests must reject service forwarding as the canonical `control.endpoint` implementation, and docs must reserve it for debug, inspection, preview, notebook, and operator-only tools.

### Risk: Gateway Embedding Creates An Unsupported Coupling

Treating OpenShell Gateway as an in-process NanoCore library could couple NanoCore to unstable internal OpenShell APIs and make upgrades difficult.

Mitigation: run OpenShell Gateway as a NanoCore-managed backend service or deployment-selected external service first, and add in-process embedding only if OpenShell publishes a stable embedding API or OpenKit forks and owns that integration boundary.

## Resolved Decisions

- OpenKit-authored provider profile and AEP config fields use OpenKit-style camelCase. OpenShell-compatible snake_case belongs only in backend extensions or generated OpenShell materialization artifacts.
- Provider profiles are server-owned by default. Workspace-defined custom profiles require policy-reviewed setup proposals and must not grant authority beyond server and workspace policy.
- The first provider profile baseline is GitHub/source-control, OpenAI-compatible inference, and OpenAI Codex account slot. PyPI, generic REST API, and object-store profiles are deferred until a concrete worker task requires them.
- NanoCore should not hard-code an OpenShell version for `inference.local` behavior. The backend must declare or prove required feature flags during preflight, and NanoCore must fail closed or use an OpenKit-owned authenticated relay to the internal worker-inference route when lineage, usage, or audit preservation cannot be proven.
- The first object-store target should be a generic S3-compatible contract that can project to S3 and R2 before adding provider-specific GCS, Azure Blob, or Box contracts.
- Object-store materialization should start with OpenKit-managed staged files or gateway-mediated reads. Backend FUSE, sync-on-demand, and backend-native mounts require separate backend capability declarations and recovery tests.
- Generated files are runtime files by default. They become artifacts only when they are user-visible outputs, review inputs, or evidence that must survive beyond the worker session.
- Public App API readiness projections should expose only redacted package, backend, provider, vault, policy, and capability summaries. Full unredacted AEP snapshots remain internal runtime records and must not become public product records.
- Package snapshots are diagnostics-only by default. NanoCore exposes only redacted durable package snapshots through `/api/app/workspaces/:workspaceId/agent-environment/snapshots`, Core Client, OpenAPI, and MCP; a redacted snapshot or snapshot reference may become a restricted evidence artifact when needed for review, replay, or audit.
- Backend version negotiation uses backend capability declarations, feature probes, selected backend version, and required feature flags recorded in materialization evidence. Missing required capabilities fail before launch.
- OpenShell Gateway placement is deployment policy. Local development may use a NanoCore-managed local gateway process, while server, remote, team, and production deployments should use a deployment-managed external gateway unless a later service-management spec says otherwise.
- The smallest worker control protocol is owned by `docs/specs/20260703-worker_control_protocol.md`. AEP supplies the endpoint, auth, transcript, relay, and backend capability projection without redefining operation schemas.
- The no-fork OpenKit sidecar remains the first `control.local` path. Native OpenShell generic local endpoint relay should be adopted only when the backend declares `generic-local-endpoint-relay` and preserves the same NanoCore-owned worker-control protocol, lineage, audit, and transcript semantics.

## Deferred / Future Work

- Provider profile specs for PyPI, generic REST APIs, and object-store providers beyond the first S3-compatible baseline.
- Backend-native object-store mounts after staged-file and gateway-mediated paths are proven.
- Rich Web UI package readiness views over redacted App API summaries.
- Deployment-specific OpenShell Gateway service-management contracts.

## Links

- [Core Architecture](../core/architecture.md)
- [Agent Capability](../core/agent-capability.md)
- [Vault Model](../core/vault.md)
- [Permissions Model](../core/permissions.md)
- [Sandbox Model](../core/sandbox.md)
- [Audit Model](../core/audit.md)
- [Agent Supply](../core/agent-supply.md)
- [Runtime Model](../core/runtime-model.md)
- [Session Static Workspace Materialization](./20260704-session_static_workspace_materialization.md)
- [Workspace Data Mount Materialization](./superseded/worker-runtime/20260526-workspace_data_mounts.md)
- [Agent Setup And Runtime Supply Contract](./20260628-agent_setup_runtime_supply_contract.md)
- [Agent Profile Model](./superseded/agent-setup-runtime-supply/20260522-agent_profile_model.md)
- [Server Config and Data Layout](./superseded/nanocore-config-identity/20260519-server_config_data_layout.md)
- [LLM Gateway Responses API](./20260526-llm_gateway_responses_api.md)
- [NVIDIA OpenShell Providers v2](https://docs.nvidia.com/openshell/latest/sandboxes/providers-v2)
- [NVIDIA OpenShell How It Works](https://docs.nvidia.com/openshell/latest/about/how-it-works)
- [NVIDIA OpenShell Manage Sandboxes](https://docs.nvidia.com/openshell/latest/sandboxes/manage-sandboxes)
- [NVIDIA OpenShell Gateway Config](https://docs.nvidia.com/openshell/latest/reference/gateway-config)
- [NVIDIA OpenShell Policy Schema Reference](https://docs.nvidia.com/openshell/latest/reference/policy-schema)
- [NVIDIA OpenShell Inference Routing](https://docs.nvidia.com/openshell/latest/sandboxes/inference-routing)
- [NVIDIA OpenShell Sandbox Compute Drivers](https://docs.nvidia.com/openshell/latest/reference/sandbox-compute-drivers)
- [NVIDIA OpenShell OCSF JSON Export](https://docs.nvidia.com/openshell/latest/observability/ocsf-json-export)
- [OpenAI Sandbox Agents](https://developers.openai.com/api/docs/guides/agents/sandboxes)
