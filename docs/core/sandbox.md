# Sandbox Model

Status: Accepted

This document defines OpenKit sandbox semantics.

This document owns execution isolation, sandbox scope, environment constraints, workspace input rules, snapshot and persistence boundaries, resource limits, sandbox summaries, and backend containment projections.

This document does not own permission policy, technical capability declarations, runtime scheduling, agent supply declarations, vault secret storage, storage layout, deployment topology, or backend-native sandbox payloads.

Sandbox is execution isolation and runtime environment design. It answers where work runs and what the runtime can reach.

Sandbox is separate from permission and capability.

## Principles

- Sandbox constrains what execution can actually reach; permission decides whether an action is allowed.
- Product semantics must be owned by OpenKit records, not backend-native sandbox IDs, YAML, provider payloads, or supervisor logs.
- Workspace inputs should be portable and workspace-relative where applicable.
- Reusable sandboxes SHOULD separate session-static filesystem layout from turn-dynamic file contents.
- Secret values, temporary credentials, and ephemeral mounts must stay out of durable snapshot state.
- Stronger backends may provide stronger isolation, but backend feature differences must be summarized as capabilities or clear launch failures rather than leaking raw backend state.

## Backend Ownership Principle

The stable ownership rule is:

- NanoCore owns product state, user-visible workflow, review gates, artifacts, audit lineage, workspace change records, and public API semantics.
- Backend adapters own runtime effects such as sandbox lifecycle, process launch, filesystem enforcement, network enforcement, provider attachment, credential projection, file transfer, and teardown.
- Backend-native records are evidence and diagnostics, not canonical product records unless NanoCore explicitly normalizes them into OpenKit records.

This lets OpenKit depend on concrete runtime backends without turning backend-native policy files, gateway state, sandbox ids, provider payloads, supervisor logs, or file-transfer primitives into product contracts.

Backend portability does not mean every backend has identical features.

It means NanoCore can reason over stable OpenKit records and declared backend capabilities, then choose an implementation strategy or fail before launch when a required capability is missing.

## Purpose

Agents may execute code, inspect files, call tools, open browsers, use networks, and produce artifacts.

The sandbox model gives Core a stable way to describe and reason about isolation without committing to one backend.

Possible sandbox backend categories include containers, microVMs, remote agent services, managed sandbox providers, and custom controlled runtimes.

## Boundary

Sandbox owns runtime containment and environment constraints.

Permission owns authorization decisions.

Capability owns declared or discovered abilities.

Runtime owns lifecycle management for agent sessions.

Storage owns durable files and indexes.

Sandbox does not decide whether an action should be allowed. It limits what execution can actually access.

## Sandbox Scope

A sandbox may be scoped to:

- one agent session
- one workspace
- one thread
- one turn
- one remote provider session
- one reusable runtime pool

The default conceptual scope is agent session. Other scopes require explicit policy and lifecycle rules.

## Isolation Areas

Sandbox design may constrain:

- filesystem access
- process execution
- network access
- browser access
- display access
- environment variables
- secret injection
- CPU, memory, disk, and time usage
- device access
- mounted storage
- outbound capability endpoints

These constraints should be summarized for Core and product surfaces without exposing backend-private details as stable protocol fields.

## Workspace Contract

Sandbox workspace inputs should be portable and workspace-relative where applicable.

Workspace inputs may include:

- files
- directories
- repository checkout
- mounted local directory
- object-store mount
- generated task files
- attachments
- environment entries

Manifest workspace targets should not rely on absolute local paths or path traversal.

Workspace inputs and environment values may be durable or ephemeral. Secret values, short-lived credentials, and ephemeral mounts must stay out of durable snapshot state.

Agents must not receive writable access to Core-managed config or server-control areas unless the runtime is explicitly a trusted Core maintenance agent.

For reusable container and managed-sandbox sessions, the sandbox should expose a stable workspace root and a fixed set of declared slots before worker execution begins.

The slot paths and access envelope are sandbox constraints.

The files, repositories, generated context, object-store snapshots, artifacts, transcripts, and outputs placed inside those slots are workspace synchronization content.

When a backend cannot change mount paths, working directories, provider-visible process environment, or static filesystem policy after sandbox start, Core must choose a replacement sandbox rather than pretending the running sandbox changed.

The sandbox summary may describe stable slot refs and access classes, but it must not expose raw host paths, backend mount handles, upload handles, temporary object-store keys, or provider credential material.

## Snapshot And Persistence

Some sandboxes support snapshots, suspend, resume, rollback, or clone.

Snapshot semantics must distinguish:

- materialized files that should be preserved
- mounted external data that should not be copied into snapshots
- runtime cache that can be discarded
- secrets that must not be persisted
- artifacts that should be registered separately

Session resume may use sandbox snapshots, but knowledge is not sandbox state.

## Resource Limits

Sandbox may enforce resource limits.

Examples:

- CPU
- memory
- disk
- wall-clock time
- concurrent processes
- network egress
- token or model usage through agent capability gateways

Resource limits may also appear in agent setup config and runtime policy. Permission policy may require approval before using more expensive or risky limits.

## Deployment Modes

Sandbox semantics should work across:

- container mode (OpenShell, Docker, Kubernetes)
- microVM mode
- remote agent mode
- managed sandbox provider mode

Container, microVM, and managed-provider modes can provide stronger isolation, but each has different startup, filesystem, network, snapshot, and tool-compatibility trade-offs.

## Sandbox Summary

Core may expose a sandbox summary for product surfaces and audit.

A product-safe sandbox summary may carry:

- access (`none`, `read-only`, `read-write`)
- workspaceRootRefs (Core-relative workspace input references, not absolute local paths)
- summary (a short nullable label)

Backend type, health, and version should remain separate from the sandbox summary unless a future core model intentionally promotes them into sandbox semantics.

Future sandbox summary areas may include isolation level, filesystem scope, network policy summary, secret-injection path, snapshot support, resource limit summary, and known degraded constraints.

The summary should not expose sensitive paths, raw provider handles, secret values, or backend-private payloads.

## Must Not Expose

Sandbox summaries, protocol records, audit records, and product surfaces must not expose:

- absolute local paths
- raw provider handles
- container IDs
- VM IDs
- process IDs
- raw environment variables
- secret values
- temporary credential material
- private network topology
- backend-private sandbox payloads
- unrestricted mount details

Implementations may expose stable summaries, redacted labels, or Core-issued IDs when users need to understand where work ran.

## Invariants

- Sandbox MUST remain separate from permission and capability.
- Sandbox summaries MUST NOT expose absolute local paths, raw provider handles, container IDs, process IDs, environment variables, secret values, temporary credentials, private network topology, or backend-private payloads.
- Workspace inputs SHOULD be workspace-relative or Core-issued references rather than absolute local paths.
- Secret values MUST NOT be persisted in sandbox snapshots.
- Runtime backends MUST NOT become the source of truth for product workflow, artifact lineage, audit lineage, or public API semantics.
- Reusable sandboxes MUST NOT treat dynamic slot contents as canonical workspace truth until NanoCore imports and records them through the owning storage and workspace synchronization contracts.
- Static sandbox layout changes that the backend cannot apply safely MUST require a replacement sandbox or a blocked launch diagnostic.
