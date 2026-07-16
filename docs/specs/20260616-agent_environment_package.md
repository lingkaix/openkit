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

Runtime backend details are refined by `docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260703-runtime_scheduling_scale.md`, and `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`. Host-local staging and harness behavior are implementation projections; real Worker Agent product paths use governed container or sandbox placements.

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
- supervisor, proxy, or relay processes
- backend-native logs and enforcement evidence

OpenShell is valuable because its Providers v2, sandbox policy, inference routing, compute driver, and observability designs already cover many of the fields OpenKit needs.

OpenKit should adopt an OpenShell-inspired provider/profile/policy vocabulary, and an OpenAI-sandbox-inspired workspace manifest vocabulary, without making either third-party schema the canonical OpenKit product contract.

## Current Implementation Projection

The current NanoCore implementation uses the Agent Environment Package as the concrete V1 contract for worker governance execution. Current code resolves package metadata for local and remote disposable OpenShell Cell paths, including runtime placement, worker-visible workspace roots, generated task context, control endpoint metadata, transcript paths, policy snapshot binding, session workspace layout, workspace synchronization expectations, supply projections, capability projections, vault-backed runtime files, and backend capability requirements. NanoCore also persists redacted workspace-owned package snapshots and exposes them through App API, Core Client, OpenAPI, and MCP readback surfaces for diagnostics, evidence, export/import, and restart investigation.

The current scope schema still carries `userId`, optional `automationId`, and optional `organizationId`. The accepted shared-Workspace target replaces those fields with `triggerActor: ActorRef`; `responsibleUserId` is accountability context and no longer doubles as a physical Workspace-store owner. Removing the unused organization placeholder and updating every producer, consumer, persisted snapshot, and policy adapter remains part of the multi-user implementation plan.

The OpenShell-backed path uses `openkit-codex-shim` as the sandbox entrypoint. The shim supervises Codex and calls the AEP-resolved NanoCore worker-control endpoint directly; the worker image contains no separate control sidecar.

The accepted V1 boundary is implemented for NanoCore-owned AEP resolution and OpenShell-backed materialization. Authored setup can project required backend capabilities into AEP backend requirements, backend materialization validates missing required capabilities before launch, grant-backed provider and runtime-file attachments flow through vault records without storing secret material in the package, and redacted package snapshots can be listed and read without exposing backend-private fields, raw credentials, or host-local runtime references.

Provider attachments in an AEP are declarations, not implicit OpenShell CLI arguments. Runtime-file and runtime-environment materialization does not automatically become `openshell sandbox create --provider`; the backend attaches only provider credentials that were resolved through the provider/vault materialization path or explicit transient provider inputs owned by the launch request.

Current read-write workspace roots are Git-backed: NanoCore resolves and records the full immutable `HEAD` object id before materialization and rejects a writable root without a valid commit. That independent host-side base must match the worker change-set and materialization base before review can become actionable.

Current packages always emit `capabilities: { protocol: "openkit-worker-capability-v1", mode: "disabled", routes: [] }`. The removed worker capability client, NanoCore `/api/worker-capabilities/*` routes, worker MCP gateway, and capability smoke are not part of the current implementation. Skill and MCP supply records may still be resolved as static package inputs, but they do not grant a callable worker capability route. The accepted future capability and MCP contracts remain in `docs/specs/20260703-worker_agent_capability.md` and `docs/specs/20260704-worker_mcp_tool_supply.md` and are sequenced in `docs/roadmap.md`.

The worker-runtime provenance and trusted worker-inference extension remains governed by `docs/specs/20260711-worker_runtime_subagent_provenance.md`; production advertisement is implemented and its real OpenShell `0.0.80` and Codex `0.144.1` proof passed on A1. Rich Web readiness views, broader provider profiles, object-store mounts, worker capabilities, multiple Cell targets, and target selection remain future extensions over the same AEP boundary.

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

The backend owns concrete policy artifacts such as OpenShell policy YAML, container network rules, Kubernetes network policies, proxy config, or firewall rules.

NanoCore audit must record both the abstract decision and the backend enforcement result.

### Prefer Stable Worker Endpoints

Agents should see stable local endpoints or environment variables managed by OpenKit or the backend.

They should not need to know whether routing goes through NanoCore, OpenShell `inference.local`, a network proxy, a Kubernetes service, or a managed sandbox endpoint.

### Separate Control From Inference

OpenKit worker control traffic and LLM inference traffic use separate channels.

The inference channel gives agent runtimes an AEP-resolved OpenAI-compatible endpoint without exposing provider credentials. Non-attributed packages may use `https://inference.local`; provenance-required packages receive an exact authenticated NanoCore worker-inference base URL.

The control channel is mandatory for governed workers. `openkit-codex-shim` calls the AEP-resolved NanoCore `/api/worker-control` base URL directly over HTTP or HTTPS, authenticates with the package-bound sandbox token, emits heartbeats and bounded worker records, polls commands, and reports terminal results.

No sandbox-local control alias, sidecar, backend relay, or transcript-only control mode is part of the accepted contract. OpenShell network policy allows only the shim binaries to reach the declared NanoCore control endpoint. The transcript files under `/openkit/session/` remain required evidence collected at turn end; they are not an alternate control path.

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
- managed proxy endpoint
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
    "triggerActor": {
      "kind": "user",
      "id": "user_...",
      "responsibleUserId": "user_..."
    },
    "requestId": "req_..."
  }
}
```

Rules:

- `workspaceId`, `threadId`, `turnId`, and `agentSessionId` are required for worker turns.
- `triggerActor` is required and uses the shared `ActorRef` contract so policy can evaluate the initiating actor and responsible user independently from Workspace storage ownership.
- `responsibleUserId` equals the user id for a human trigger. Agent, automation, and integration triggers carry their own stable actor id plus the current responsible user when one exists; an explicit system trigger may use `null`.
- `tenantId`, `organizationId`, physical Workspace owner id, and user-nested Workspace paths are not AEP scope fields.
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

## Worker Transcript And Direct Control

`control` describes the mandatory direct NanoCore worker-control connection and the required transcript evidence collected at turn end. This contract is separate from LLM inference, future worker capabilities, and backend security telemetry.

```jsonc
{
  "control": {
    "protocol": "openkit-worker-control-v1",
    "mode": "direct-nanocore",
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
      "kind": "direct-url",
      "baseUrl": "https://nanocore.example.com/api/worker-control",
      "required": true,
      "implementation": "direct-nanocore"
    },
    "auth": {
      "kind": "sandbox-session-token",
      "tokenRef": "runtime://openkit/control-token",
      "credentialVisibility": "environment"
    },
    "channels": {
      "commands": true,
      "events": "batch",
      "artifacts": "batch",
      "heartbeats": true,
      "logs": "summary-only"
    },
    "commands": [
      "interrupt",
      "terminal-command"
    ],
    "events": [
      "worker.ready",
      "item.created",
      "artifact.created",
      "turn.completed",
      "turn.failed",
      "worker.heartbeat"
    ],
    "adapter": {
      "kind": "openkit-worker-shim",
      "targetRuntime": "codex",
      "targetTransport": "outbound-https"
    }
  }
}
```

Rules:

- `control.protocol` is an OpenKit protocol owned by NanoCore, not an OpenShell protocol.
- `control.mode` must be exactly `direct-nanocore`.
- `transcript.root` should be mounted writable by the worker or shim and readable by NanoCore during artifact collection.
- `eventsPath`, `itemsPath`, and `artifactsPath` are worker-visible paths.
- Transcript records must bind to workspace, thread, turn, agent session, package snapshot, and request IDs.
- `endpoint.baseUrl` must be a credential-free HTTP(S) URL whose path is exactly `/api/worker-control` after trailing-slash normalization.
- `endpoint.required` must be `true`, and `endpoint.implementation` must be `direct-nanocore`.
- `auth.tokenRef` must be `runtime://openkit/control-token`; the image launcher transfers the material to the shim through an inherited anonymous file descriptor and removes it from the child environment.
- The only declared NanoCore-to-worker command families are `interrupt` and `terminal-command`.
- The adapter transport must match the endpoint scheme: `outbound-http` or `outbound-https`.
- Direct control must preserve event ordering before events reach client-facing streams.
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

### Direct NanoCore Control Endpoint

The AEP-resolved LLM endpoint and worker-control endpoint are separate. The LLM endpoint carries inference requests, provider routing, credential isolation, and usage attribution. The control endpoint carries worker lifecycle updates, bounded records, heartbeats, interrupt commands, terminal commands, and terminal results.

The current OpenShell path is direct:

```text
Worker runtime
  -> openkit-codex-shim
  -> authenticated HTTP(S)
  -> NanoCore /api/worker-control
  -> NanoCore worker session state
```

The shim receives the exact worker-reachable NanoCore base URL from the AEP. OpenShell network policy permits only the approved shim binaries to reach that endpoint. The package-bound token authenticates the package snapshot, worker session, lease, and request lineage; the request body does not grant authority.

Transcript files remain durable turn evidence and artifact inputs. They do not replace the direct control connection, and a control failure does not authorize the worker to continue under an ungoverned transcript-only mode. OpenShell service forwarding, sandbox-local aliases, backend relays, and capability gateways are not worker-control implementations.

### OpenKit Worker Shim

Many agent runtimes expose native protocols that do not match OpenKit `Turn` and `Item` semantics.

OpenKit should use a worker shim inside the sandbox when the worker runtime does not natively speak the OpenKit worker control protocol.

The shim is responsible for:

- starting the worker runtime
- translating native runtime events into OpenKit transcript records
- writing `events.jsonl`, `items.jsonl`, and `artifacts.jsonl`
- receiving NanoCore `interrupt` and `terminal-command` commands
- translating interrupt and terminal-command requests into runtime-native actions
- publishing artifact candidates through the transcript sink
- sending heartbeats through direct NanoCore control
- reporting terminal outcomes

The shim is not the policy engine.

The backend supervisor remains the local enforcement boundary for filesystem, process, network, credential, and inference controls.

The shim is the semantic adapter that makes worker activity visible as OpenKit turns and items.

### NanoCore Full Thread Control

NanoCore retains full control of a thread by owning the authoritative turn and item state machine, even when worker transcript import is non-real-time.

The worker backend launches, enforces, and collects evidence, but it must not decide canonical OpenKit turn status. The control flow is:

```text
NanoCore creates turn
  -> NanoCore resolves AgentEnvironmentPackage
  -> Backend launches governed worker session
  -> Shim authenticates directly to NanoCore /api/worker-control
  -> Shim reports heartbeats and bounded worker records
  -> NanoCore may issue interrupt or terminal-command
  -> Shim translates runtime-native events into item candidate events
  -> NanoCore persists canonical worker state and selected item events
  -> Shim reports terminal worker outcome
  -> NanoCore collects transcript files, artifacts, and backend evidence
  -> NanoCore decides final turn status and artifact registration
```

This rule prevents OpenShell, Docker, Kubernetes, or any other backend from becoming the source of truth for product history.

Backend lifecycle events may explain why a worker failed or was blocked, but they do not replace NanoCore turn closeout.

The Web UI should subscribe to NanoCore, not to a sandbox, OpenShell Gateway, OpenShell service URL, or worker process.

The UI-facing status stream should be compact and operational rather than a token-level chat replay.

Useful status fields include phase, last progress event, last heartbeat, blocked reason, pending approval count, policy denial summary, artifact count, elapsed time, estimated cost, backend health, and available user actions.

NanoCore may project this into worker, thread, goal, and agent-network panels.

The UI may send user actions such as interrupt, priority change, approval response, or policy adjustment request to NanoCore.

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

The recommended attributed OpenShell-backed path is that the AEP configures the worker with an exact NanoCore worker-inference base URL and one sandbox-wide per-package OpenShell placeholder credential, while a default-deny policy leaves only the exact Codex binaries, NanoCore host, POST methods, and paths reachable. NanoCore then authenticates the active AEP and lease before selecting the real provider, model, credential source, usage attribution, prompt cache metadata, and audit linkage.

In that arrangement, NanoCore is the canonical inference gateway and stock `inference.local` is not in the attributed path. A package that selects backend-local inference must report attribution as incomplete when that backend cannot preserve the same lineage.

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
          "workerBaseUrl": "https://nanocore.internal/api/worker-inference/v1",
          "upstream": {
            "kind": "nanocore-gateway",
            "baseUrlRef": "runtime://nanocore/worker-inference/v1"
          }
        },
        "credentialVisibility": "placeholder",
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

For OpenShell-backed workers that require complete attribution, preferred `gateway` mode uses the exact AEP-bound NanoCore worker-inference base URL plus the per-package OpenShell placeholder and REST policy. Legacy `inference.local` remains outside that trusted binding.

`backend-local` is acceptable only when the backend can preserve OpenKit provider IDs, usage, prompt cache metadata, and audit linkage.

`direct-external` should require explicit policy because the worker may see provider API shapes and because credential isolation depends on backend enforcement.

Rules:

- Workers should not receive real LLM provider API keys.
- Sandbox-supplied `Authorization` headers should be stripped before upstream inference.
- NanoCore should authenticate the sandbox token, active AEP, and lease before honoring requests on the internal worker-inference routes.
- NanoCore should map forwarded inference calls to workspace, thread, turn, agent session, provider instance, and request IDs.
- NanoCore should record capability calls, usage, and audit events for forwarded inference.
- A backend-level `inference.local` implementation that cannot preserve NanoCore lineage, provider IDs, usage, and audit is a non-attributed backend-local route; complete attribution requires the OpenKit-owned authenticated worker-inference path.
- Worker authority-bearing lineage must come from an authenticated AEP and lease binding, not request-body `metadata.openkit` or runtime-supplied headers.
- Runtime-native causal origin and runtime cache lineage must follow `docs/specs/20260711-worker_runtime_subagent_provenance.md`; the shared outer OpenKit thread, turn, or agent session must not become the cache key for every runtime-internal child.
- An AEP that requires complete worker-inference attribution must configure the root runtime and every runtime-internal child to use the authenticated worker-inference base URL, withhold direct provider credentials, deny direct provider API egress, and fail capability negotiation when the backend cannot prove that coverage; `backend-local` and `direct-external` modes must report attribution as incomplete unless they satisfy the same authenticated path contract.

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
- managed proxy config

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
      "worker-control",
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
| `worker-control` | Can let the approved worker shim reach NanoCore's authenticated direct worker-control endpoint. |
| `sandbox-local-endpoint` | Can expose a stable sandbox-local inference endpoint when selected by the LLM projection. |
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

Official, unmodified OpenShell `0.0.80` is the first-class backend for governed local and remote container execution inside one single-slot disposable Cell.

It is also the reference implementation for policy rendering, provider attachments, gateway-mediated inference, sandbox lifecycle evidence, and backend-native file transfer.

That does not make OpenShell the canonical OpenKit control plane.

The canonical design rule is OpenShell-first, OpenKit-owned semantics, capability-based portability.

OpenKit should intentionally use OpenShell's strongest mechanisms where they reduce product risk or implementation cost:

- Sandbox materialization through stock OpenShell inside the Cell; OpenKit's fixed Cell helper owns whole-runtime prepare and recycle.
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
- public App API, end-user Agent Skill Interface, Web UI, and protocol response shapes
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

For OpenShell, successful teardown means recycling the complete owning Cell into a fresh verified empty epoch. Sandbox or provider deletion is neither cleanup proof nor a fallback success path.

## OpenShell Backend Mapping

An OpenShell backend should map OpenKit package fields as follows.

| OpenKit field | OpenShell materialization |
| --- | --- |
| `runtime.image` | Sandbox image or compute driver image setting. |
| `runtime.command.argv` | Sandbox command after supervisor starts. |
| `workspace.inputs` | Bind mounts, staged files, repository checkout, or backend-supported mounts. |
| `workspace.outputs` | Output directories plus artifact collection. |
| `control.transcript` | Writable `/openkit/session/*.jsonl` directory collected at turn end. |
| `control.endpoint` with `implementation: "direct-nanocore"` | OpenShell network policy lets the approved worker shim call the exact worker-reachable NanoCore `/api/worker-control` URL. |
| `providerProfiles` | Built-in or custom OpenShell provider profiles. |
| `providerInstances` | OpenShell providers created or referenced through gateway state. |
| `providers.attachments` | Sandbox `--provider` attachments or runtime attach commands. |
| `policy.filesystem` | `filesystem_policy` and Landlock settings. |
| `policy.process` | OpenShell `process` and binary policy where supported. |
| `policy.network` | `network_policies` plus provider-derived layers. |
| `llm.mode: gateway` with an exact NanoCore `workerInferenceBaseUrl` | Per-package generic provider placeholder plus exact OpenShell Codex REST policy forwarding to NanoCore's authenticated internal worker-inference routes. |
| `llm.mode: backend-local` | OpenShell `inference.local` owns final provider routing when explicitly selected. |
| `observability.formats.preferred: ocsf-json` | OpenShell OCSF JSON export setting. |
| `resources.cpu` and `resources.memory` | Sandbox create `--cpu` and `--memory` where driver supports them. |

OpenShell-specific constraints:

- OpenShell is the first-class container backend and reference implementation, but OpenKit product semantics remain NanoCore-owned.
- Provider-derived policy layers are derived materialization output and must not become canonical NanoCore policy records.
- Provider attach or detach affects future effective policy reads and future process launches, but already-running processes may keep their original environment.
- Filesystem policy is static and requires sandbox recreation when changed.
- Network policy may be dynamic when OpenShell supports policy update for the selected session.
- Relay-required packages should route the exact AEP-bound worker-inference base URL to NanoCore so it keeps authenticated package lineage, provider, model, usage, prompt cache, and audit ownership.
- If OpenShell itself owns final `inference.local` provider routing, NanoCore must treat that as `backend-local` mode and require explicit audit and usage preservation checks.
- The OpenShell materializer must provide the worker-reachable NanoCore control URL directly and allow only approved shim binaries to reach it.
- OpenShell service forwarding, `inference.local`, and future capability mediation are not worker-control paths.
- The stock OpenShell Gateway must run inside the same disposable Cell as its container runtime and sandboxes. Local placement invokes the fixed helper through non-interactive sudo; remote placement invokes the same helper through the fixed SSH lifecycle command and reaches the loopback Gateway through a separate operator-managed local forward.
- A reachable external or shared Gateway without the matching whole-Cell lifecycle target is not a valid backend target, and the integration must not use insecure Gateway mode, a custom binary path, or an embedded, forked, patched, replacement, or private OpenShell artifact.
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

This example is intentionally compact and shows direct worker control with a separate backend-local inference projection.

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
    "mode": "direct-nanocore",
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
      "kind": "direct-url",
      "baseUrl": "https://nanocore.example.com/api/worker-control",
      "required": true,
      "implementation": "direct-nanocore"
    },
    "auth": {
      "kind": "sandbox-session-token",
      "tokenRef": "runtime://openkit/control-token",
      "credentialVisibility": "environment"
    },
    "channels": {
      "commands": true,
      "events": "batch",
      "artifacts": "batch",
      "heartbeats": true,
      "logs": "summary-only"
    },
    "commands": ["interrupt", "terminal-command"],
    "adapter": {
      "kind": "openkit-worker-shim",
      "targetRuntime": "codex",
      "targetTransport": "outbound-https"
    }
  },
  "capabilities": {
    "protocol": "openkit-worker-capability-v1",
    "mode": "disabled",
    "routes": []
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
      "worker-control",
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

The LLM gateway remains NanoCore-owned unless a backend-local inference route is explicitly selected and can preserve OpenKit usage and audit linkage. A backend-local route cannot claim complete worker-inference attribution unless it also satisfies the authenticated path and direct-egress blocking contract.

## Alternatives Considered

### Make OpenShell YAML the canonical OpenKit config

Rejected.

OpenShell's schema is strong, but it is backend-specific.

Making it canonical would couple OpenKit product concepts to one enforcement backend and would make future Docker-only, Kubernetes-only, hosted sandbox, or custom backend support harder.

OpenKit needs stable IDs, product lineage, user and workspace ownership, vault grant references, permission decisions, and audit record linkage that are not native OpenShell concepts.

OpenShell should remain the reference backend and may strongly influence field vocabulary, but OpenKit records must stay canonical.

The acceptable form of dependency is an adapter that compiles OpenKit-owned records into OpenShell-native artifacts and then normalizes OpenShell evidence back into OpenKit-owned records.

The unacceptable form of dependency is public App API, end-user CLI, Web UI, Action Center, or storage records that require consumers to understand OpenShell-native ids, YAML, gateway state, provider payloads, or supervisor logs.

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

That requires a backend supervisor, container runtime, VM boundary, hosted sandbox provider, or OS-level controls.

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
3. Package `openkit-codex-shim` as the worker entrypoint and supply the exact NanoCore `/api/worker-control` base URL.
4. Allow only the approved shim binaries to reach NanoCore's direct worker-control endpoint.
5. Expose only the exact AEP-bound NanoCore worker-inference route for attributed model traffic, using a per-package OpenShell placeholder and Codex-only REST policy.
6. Exercise any GitHub read-only provider attachment in a separate non-attributed sandbox fixture; do not combine it with the attributed inference package.
7. Record policy application and sandbox lifecycle evidence.
8. Collect declared output artifacts.
9. Fail launch if required audit export, transcript sink, provider policy composition, or direct worker-control readiness is unavailable.

### Phase 5: Product Integration

1. Surface backend readiness and sandbox summaries in the agent catalog.
2. Surface provider attachments and policy summary in worker diagnostics.
3. Surface policy denials and blocked capabilities through Action Center rows.
4. Normalize backend evidence into OpenKit audit records.
5. Add worker and agent-network status panels backed by NanoCore worker session state, not direct sandbox connections.
6. Add compact live progress stream support for phase, heartbeat, blocked reason, policy denial summary, artifact count, elapsed time, estimated cost, and available actions.
7. Add user actions for interrupt, approval response, and policy adjustment request through NanoCore.
8. Add artifact review flow for collected outputs.

## Testing Strategy

### Schema Tests

- Accept valid package fixtures for local and remote disposable OpenShell Cells, plain Docker, Kubernetes, VM, and hosted sandbox intents.
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
- Compile mandatory direct NanoCore worker-control routing without exposing raw package tokens.
- Allow only approved shim binaries to reach the resolved worker-control URL.
- Reject package materialization that maps worker control through `inference.local`, service forwarding, a sandbox-local alias, or a capability route.
- Reject package materialization that uses OpenShell service forwarding as the canonical OpenKit worker control channel.
- Compile attributed `llm.mode: gateway` routing to the exact NanoCore worker-inference base URL with the per-package placeholder and POST-only OpenShell policy.
- Generate OpenShell-style policy with provider-derived network rules where supported.
- Generate redacted materialization records.
- Do not persist derived provider rules as canonical NanoCore policy.
- Keep backend-private handles out of App API diagnostics.
- Round-trip package snapshots without secret values.

### Runtime Tests

- Launch a fake worker through a fake backend and stream lifecycle evidence.
- Launch a fake worker shim that writes `events.jsonl`, `items.jsonl`, and `artifacts.jsonl`, then verify NanoCore imports canonical items and artifacts at turn end.
- Verify NanoCore rejects transcript records with mismatched workspace, thread, turn, agent session, or package snapshot IDs.
- Launch a fake worker shim that authenticates to the direct NanoCore worker-control endpoint and relays compact progress.
- Verify live progress updates worker phase, heartbeat, blocked reason, policy denial summary, artifact count, elapsed time, and available actions without creating canonical item records unless NanoCore explicitly imports or promotes them.
- Verify direct control failure stops or cancels the worker while preserving transcript evidence already written.
- Verify `interrupt` and `terminal-command` delivery, acknowledgement, terminal-result reporting, and idempotency.
- Launch a fake OpenShell backend that reports policy apply success, network deny, credential placeholder resolution, and teardown.
- Verify OpenShell OCSF evidence can produce audit records without becoming canonical item deltas.
- Verify authenticated worker-inference requests map to workspace, thread, turn, agent session, package snapshot, provider instance, usage, and audit records.
- Verify dynamic provider attach reports that already-running processes may need restart.
- Verify artifact collection registers output artifacts with thread, turn, and input lineage.
- Verify failed backend audit setup blocks launch when audit is required.

### Product Tests

- Agent catalog shows backend, sandbox, provider, and readiness summaries without backend-private internals.
- Action Center shows approval or blocked-state rows for policy-required decisions.
- Turn review surfaces show imported transcript items and artifacts without requiring live worker streaming.
- Agent network panels show compact NanoCore worker session status without connecting directly to sandbox services.
- Interrupt, approval response, and policy adjustment actions are submitted to NanoCore and reflected as command or review state.
- Thread item history is driven by NanoCore canonical item imports, not backend supervisor logs.
- Audit view can query by workspace, thread, turn, agent session, provider instance, vault grant, and permission decision.

## Risks & Mitigations

### Risk: OpenShell Schema Drift

OpenShell is still evolving.

Mitigation: keep OpenKit canonical schemas independent, pin the current adapter and tests to exact stock OpenShell `0.0.80`, and require a freshly reviewed mapping and acceptance proof for any future version instead of carrying an OpenShell compatibility layer.

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

### Risk: Direct Worker Control Becomes Unreachable

Remote container placement can fail if the resolved NanoCore URL is not worker-reachable or OpenShell policy does not allow the approved shim binaries to connect.

Mitigation: materialization preflight must verify the exact URL, scheme-derived transport, binary allowlist, and authenticated readiness before launch. Runtime control failure stops or cancels the worker instead of silently degrading into transcript-only execution.

### Risk: Gateway Embedding Creates An Unsupported Coupling

Treating OpenShell Gateway as an in-process NanoCore library could couple NanoCore to unstable internal OpenShell APIs and make upgrades difficult.

Mitigation: keep the official OpenShell Gateway out of process inside the disposable Cell and control only the fixed whole-Cell lifecycle. OpenKit must not embed, fork, patch, replace, or publish a private OpenShell artifact.

## Resolved Decisions

- OpenKit-authored provider profile and AEP config fields use OpenKit-style camelCase. OpenShell-compatible snake_case belongs only in backend extensions or generated OpenShell materialization artifacts.
- Provider profiles are server-owned by default. Workspace-defined custom profiles require policy-reviewed setup proposals and must not grant authority beyond server and workspace policy.
- Runtime files and runtime environment values do not imply backend provider attachment. Only a resolved backend provider credential or an explicit transient launch provider may become an OpenShell `--provider` argument.
- The first provider profile baseline is GitHub/source-control, OpenAI-compatible inference, and OpenAI Codex account slot. PyPI, generic REST API, and object-store profiles are deferred until a concrete worker task requires them.
- The current OpenShell backend is pinned to exact stock version `0.0.80` and must prove required feature flags during preflight. A future version change requires fresh whole-Cell and worker-runtime acceptance rather than a compatibility path; NanoCore must fail closed when lineage, usage, or audit preservation cannot be proven.
- The first object-store target should be a generic S3-compatible contract that can project to S3 and R2 before adding provider-specific GCS, Azure Blob, or Box contracts.
- Object-store materialization should start with OpenKit-managed staged files or gateway-mediated reads. Backend FUSE, sync-on-demand, and backend-native mounts require separate backend capability declarations and recovery tests.
- Generated files are runtime files by default. They become artifacts only when they are user-visible outputs, review inputs, or evidence that must survive beyond the worker session.
- Public App API readiness projections should expose only redacted package, backend, provider, vault, policy, and capability summaries. Full unredacted AEP snapshots remain internal runtime records and must not become public product records.
- Package snapshots are diagnostics-only by default. NanoCore exposes only redacted durable package snapshots through `/api/app/workspaces/:workspaceId/agent-environment/snapshots`, Core Client, OpenAPI, and MCP; a redacted snapshot or snapshot reference may become a restricted evidence artifact when needed for review, replay, or audit.
- Backend version negotiation uses backend capability declarations, feature probes, selected backend version, and required feature flags recorded in materialization evidence. Missing required capabilities fail before launch.
- OpenShell Gateway placement follows the disposable Cell contract. Local placement uses the Gateway inside the co-located Cell; remote placement binds one fixed SSH lifecycle target to one operator-managed loopback HTTP Gateway origin and one explicit credential-free HTTP(S) `/api/worker-control` URL reachable from the sandbox. A naked or shared external Gateway is invalid.
- The smallest worker control protocol is owned by `docs/specs/20260703-worker_control_protocol.md`. AEP supplies the direct endpoint, authentication, transcript, channels, commands, and backend capability projection without redefining operation schemas.
- Governed workers use only the authenticated direct NanoCore worker-control connection. A sandbox-local alias, sidecar, backend relay, capability gateway, or transcript sink must not become a second control path.

## Deferred / Future Work

- Provider profile specs for PyPI, generic REST APIs, and object-store providers beyond the first S3-compatible baseline.
- Backend-native object-store mounts after staged-file and gateway-mediated paths are proven.
- Rich Web UI package readiness views over redacted App API summaries.
- Multiple independent disposable Cell targets and scheduler-owned target selection.

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
