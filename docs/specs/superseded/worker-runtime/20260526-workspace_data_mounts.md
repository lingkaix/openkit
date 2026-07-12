# Workspace Data Mount Materialization

Status: Superseded
Implementation: N/A
Status Changed: 2026-07-03
Current Guidance: `docs/specs/20260703-workspace_synchronization.md`, `docs/specs/20260703-agent_manifest_aep_resolution.md`, `docs/specs/20260703-storage_layout_record_ownership.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

Workspace Synchronization, Agent Manifest/AEP Resolution, and Storage Layout absorbed workspace input declarations, materialization, output collection, review, apply, and ownership. The host-local mount slice lost authority because those responsibilities now form one governed cross-backend contract rather than a host-only path.

## Retention Reason

This document preserves the first host-directory materialization boundary, source-kind exploration, and rejected remote assumptions so maintainers can trace the starting point of the active workspace contract without reintroducing host-only ownership.

## Summary

OpenKit workspace config needs a way to describe the files and directories that a worker agent should receive as its working material.

The first implementation should support only the simplest materialization path: a host-local directory that NanoCore validates and passes to a host worker as a concrete accessible directory. Remote buckets, container mounts, snapshots, and adapter-specific materialization need a separate design before implementation.

This spec lists expected data source kinds, defines the V1 host-local directory boundary, and records the decisions that must hold until richer mount adapters get their own materialization design.

## Goals / Non-goals

### Goals

1. Define the workspace data mount problem separately from layered config precedence.
2. List the data source kinds OpenKit is likely to support over time.
3. Specify that V1 supports only host-local directories.
4. Keep remote storage credentials out of workspace config source text.
5. Make worker session materialization explicit instead of relying on prompt-only instructions.
6. Leave adapter-specific mount semantics as open design work.

### Non-goals

- Do not implement materialization in this spec.
- Do not define sandbox or permission profiles.
- Do not define S3, R2, GCS, Azure Blob, Box, Git, HTTP archive, or snapshot materialization details yet.
- Do not allow raw cloud credentials in workspace config.
- Do not mutate already-running worker sessions when workspace mount config changes.
- Do not require every worker adapter to support every source kind.

## Background

OpenKit workers may run on the host, in a local container, or in a remote container. The worker needs a concrete filesystem view before it starts work.

For coding tasks, the workspace material may be a repository directory. For data analysis tasks, the workspace material may be a host directory containing CSV, Parquet, JSONL, images, or other input files. In future deployments, the same logical workspace may need data from S3, R2, GCS, Azure Blob, Box, Git repositories, HTTP archives, OpenKit artifacts, snapshots, or other external stores.

The layered config spec keeps V1 intentionally narrow. Workspace config can describe host-local directories, and NanoCore can pass validated directories to host workers. More complex data mounting is adapter-specific and should not be hidden inside the generic config resolver.

## Decision

V1 supports one source kind:

```text
host-dir
```

`host-dir` points to a directory that exists on the NanoCore host and can be made directly available to a host worker.

Future source kinds are reserved but not implemented:

| Source kind | Example | V1 status |
| --- | --- | --- |
| `host-dir` | workspace-owned `files/data` | Supported first |
| `host-file` | `/data/project-a/input.csv` | Deferred |
| `git-repo` | `https://github.com/org/repo.git` at a ref | Deferred |
| `s3` | `s3://bucket/prefix` | Deferred |
| `r2` | `r2://bucket/prefix` or S3-compatible endpoint | Deferred |
| `gcs` | `gs://bucket/prefix` | Deferred |
| `azure-blob` | Azure container and prefix | Deferred |
| `box` | Box folder ID or path | Deferred |
| `http-archive` | HTTPS zip or tarball | Deferred |
| `openkit-artifacts` | prior artifacts from this workspace | Deferred |
| `snapshot` | previously captured worker workspace state | Deferred |
| `network-filesystem` | NFS, SMB, or enterprise-mounted volume | Deferred |

Adding a deferred source kind requires a follow-up materialization spec and adapter-specific tests.

## Proposed Design

### V1 config shape

The V1 authored workspace config should use a narrow `workspace.roots` array.

Example:

```jsonc
{
  "schemaVersion": 1,
  "workspace": {
    "roots": [
      {
        "id": "repo",
        "kind": "host-dir",
        "path": "files/repo",
        "access": "read-write"
      },
      {
        "id": "data",
        "kind": "host-dir",
        "path": "files/data",
        "access": "read-only"
      },
      {
        "id": "outputs",
        "kind": "host-dir",
        "path": "artifacts",
        "access": "read-write",
        "createIfMissing": true
      }
    ]
  }
}
```

`id` is a stable workspace-root identifier.

`kind` is `host-dir` in V1.

`path` is the directory source to expose. V1 paths must be relative paths resolved inside the workspace-owned data root. Absolute host paths are not allowed in V1.

`access` is a declarative intent used by NanoCore and worker adapters. Host-worker V1 records and forwards this value for diagnostics and future adapter enforcement, but it does not promise OS-level read-only enforcement.

`createIfMissing` defaults to `false`. It is allowed only for `read-write` roots and is intended for output directories owned by the workspace.

### Materialized view

NanoCore should convert authored roots into a materialized worker input before starting a worker session.

Conceptual shape:

```ts
interface MaterializedWorkspaceRoot {
  id: string;
  sourceKind: 'host-dir';
  sourcePath: string;
  workerPath: string;
  access: 'read-only' | 'read-write';
}
```

For a host worker, `workerPath` may be the same concrete directory as `sourcePath`.

For future local-container and remote-container workers, `workerPath` may be a container path, staged path, mounted path, or adapter-native path.

### Validation rules

V1 validation should require:

- `id` is unique within the workspace config.
- `kind` is exactly `host-dir`.
- `path` is a relative path that stays inside the workspace-owned data root.
- absolute host paths are rejected.
- `..`, symlink escapes, unsupported path separators, and data-root escapes are rejected.
- `access` is either `read-only` or `read-write`.
- `createIfMissing` is optional, defaults to `false`, and is valid only with `access: "read-write"`.
- non-creatable roots must resolve to an existing directory before worker start.

### Worker adapter responsibilities

Each worker adapter should receive materialized roots, not raw workspace config.

Host adapter V1 responsibilities:

- verify the directory still exists when the worker session starts
- pass the validated host path to the worker launch layer
- preserve the root `id` so diagnostics and artifacts can explain source identity
- avoid granting broader host access than the resolved root set
- forward `access` as declared intent without claiming host-level read-only enforcement

Future container or remote adapters may need:

- bind mounts
- staged upload or download
- object-store FUSE mounts
- read-only snapshots
- copy-on-write overlays
- output sync back to OpenKit artifact storage
- adapter-specific cleanup and retention policy

Those behaviors are out of scope for V1.

### Reload behavior

Workspace mount changes apply only to new worker sessions.

An active worker session keeps the materialized roots it captured when it started. If workspace config changes while a session is active, diagnostics should mark the session stale rather than attempting to remount or rewrite its filesystem view.

### Credentials

V1 `host-dir` roots do not need mount credentials.

Future remote source kinds must use `secretRef` or vault grants. Workspace config must not store raw object-storage keys, cloud tokens, connection strings, or service-account JSON.

## Alternatives Considered

### Support cloud bucket mounts in V1

Rejected.

S3, R2, GCS, Azure Blob, and Box all need adapter-specific materialization, credential injection, path mapping, read/write enforcement, and cleanup semantics. Implementing them without a dedicated spec would blur the worker adapter boundary.

### Treat data locations as prompt instructions

Rejected.

Prompt-only data locations are hard to validate, hard to audit, and easy for workers to misinterpret. Worker sessions should receive a concrete materialized filesystem view.

### Put sandbox and permission profiles in workspace mounts

Rejected.

OpenKit V1 assumes each worker already runs in an isolated controlled environment. Sandbox and permission controls are separate runtime defaults, not user-editable workspace mount configuration.

## Consequences

- V1 can support useful host-based data analysis work without designing every mount backend.
- The schema can stay compatible with future source kinds.
- Adapter-specific work remains isolated to a future materialization design.
- Active worker sessions remain stable across config reloads.
- Remote source support will require additional design before implementation.

## Rollout / Migration Plan

1. Add `workspace.roots` with only `host-dir` support to the config contract package.
2. Add NanoCore validation that resolves host-local directories safely.
3. Pass a generic `workspaceRoots` array to host worker session creation.
4. Surface root IDs and stale-session state in diagnostics.
5. Write a separate materialization spec before adding any remote source kind.

## Testing Strategy

Required V1 tests:

- Schema accepts valid `host-dir` roots.
- Schema rejects unsupported source kinds in V1.
- Duplicate root IDs are rejected.
- Relative paths cannot escape the workspace-owned data root.
- Symlink escapes are rejected.
- Absolute paths are rejected.
- `createIfMissing` is rejected for `read-only` roots and accepted for `read-write` roots.
- Missing non-creatable directories block worker session startup.
- Materialized worker launch payloads use a generic `workspaceRoots` array.
- Active worker sessions keep captured materialized roots after workspace config reload.
- Diagnostics identify stale sessions when root definitions change.

## Resolved V1 Questions

1. V1 allows only workspace-relative paths. Absolute host paths are rejected.
2. V1 supports `createIfMissing` only for `read-write` roots.
3. V1 host adapters record and forward `access` but do not claim OS-level read-only enforcement.
4. Worker launch uses a generic `workspaceRoots` array.
5. Output collection into artifacts is deferred.
6. Data mount templates are deferred. V1 uses per-workspace declarations.
7. Future remote source work should design S3/R2 object storage first unless a later product decision changes the priority.

## Links

- [Layered User and Workspace Configuration](../../20260628-nanocore_config_identity_contract.md)
- [Runtime Config Reload](../../20260628-nanocore_config_identity_contract.md)
- [Runtime Config UI Management](../../20260628-nanocore_config_identity_contract.md)
- [Core Storage](../../../core/storage.md)
- [Core Architecture](../../../core/architecture.md)
