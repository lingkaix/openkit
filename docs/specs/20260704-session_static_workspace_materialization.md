# Session Static Workspace Materialization

Status: Accepted
Implementation: Implemented

## Owns

- The contract that separates agent-session static sandbox layout from per-turn dynamic workspace materialization.
- The `SessionWorkspaceLayout`, `WorkspaceSlot`, `TurnWorkspaceMaterialization`, and `SessionCompatibilityKey` concepts used by AEP resolution and workspace synchronization.
- Reuse rules for long-lived local-container, remote-container, OpenShell, Docker, VM, Kubernetes, and managed-sandbox worker sessions when filesystem mounts, provider attachments, working directories, and process environments may be static after sandbox start.
- The OpenShell-inspired implementation posture for fixed directory skeletons plus dynamic file population through upload, checkout, rsync, object-store sync, provider file APIs, gateway reads, and output collection.
- The default mapping from authored workspace input kinds such as file, directory, local file, Git repository, S3, R2, GCS, Azure Blob, Box, S3 file manifests, generated files, artifacts, and outputs into stable workspace slots.

## Does Not Own

- Canonical storage ownership and record layout, which belongs to `docs/specs/20260703-storage_layout_record_ownership.md`.
- General workspace synchronization lifecycle records, staged review, apply, and recovery, which belong to `docs/specs/20260703-workspace_synchronization.md`.
- The complete Agent Environment Package schema, which belongs to `docs/specs/20260616-agent_environment_package.md`.
- Authored agent manifest resolution and schema evolution, which belong to `docs/specs/20260703-agent_manifest_aep_resolution.md` and `docs/specs/20260703-schema_evolution_record_envelope.md`.
- OpenShell credential injection, provider profile derivation, and policy-layer internalization, which belong to `docs/specs/20260703-openshell_mechanism_internalization.md`.
- Vault, permission, audit, provider, Git hosting, object-store API, Box API, or backend-native file-transfer implementation details.
- OpenShell CLI behavior, OpenShell upstream roadmap, Docker volume semantics, Kubernetes volume semantics, or managed-sandbox provider schemas.

## Core References

- `docs/core/agent-session.md`
- `docs/core/sandbox.md`
- `docs/core/storage.md`
- `docs/core/agent-supply.md`
- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/contract-evolution.md`

## Summary

OpenKit should optimize for long-lived reusable agent sessions without pretending that sandbox filesystem mounts, working directories, process environments, and provider-provided environment placeholders can always be changed in place after a sandbox starts.

The accepted model is: session layout is static, slot contents are dynamic.

NanoCore resolves an agent setup into a session-static sandbox substrate before launch. That substrate defines the worker-visible directory skeleton, writable and read-only path envelope, provider attachment envelope, network envelope, control endpoints, transcript sinks, output roots, and working-directory posture. Each turn then materializes files, repositories, object-store prefixes, generated context, artifacts, and outputs into predeclared slots inside that substrate.

This improves reuse for OpenShell-backed sessions because the sandbox starts with a broad but policy-approved workspace structure, while each turn can still receive fresh task data and produce reviewable change sets without requiring a new sandbox for every input change.

## Goals / Non-goals

### Goals

- Make reusable agent sessions safe and predictable when backend mounts are session-static.
- Avoid frequent sandbox recreation by predeclaring stable workspace slots and filling their contents dynamically.
- Keep NanoCore-owned records as product truth while allowing backends to use bind mounts, uploads, downloads, rsync, checkout, object-store sync, FUSE, or provider file APIs as transport projections.
- Support both local containers and remote containers with one materialization contract.
- Keep worker writes review-gated by default through `WorkspaceChangeSet` and staged apply.
- Make session reuse explainable through a deterministic `SessionCompatibilityKey`.
- Record OpenShell Providers v2 limitations honestly: provider attachment can change future effective policy and future process environments, but it does not mutate already-running process environments.

### Non-goals

- Do not make every workspace input a filesystem mount.
- Do not require every backend to support every source kind or sync strategy.
- Do not grant a broad static sandbox envelope unless server, workspace, user, vault, provider, and permission policy allow it.
- Do not use a long-lived sandbox as hidden knowledge, hidden storage, or a bypass around workspace synchronization records.
- Do not let workers directly write back to Git, S3, R2, GCS, Azure Blob, Box, or other external systems by default.
- Do not expose raw host paths, backend handles, upload handles, provider credentials, mount internals, or OpenShell-native IDs through product APIs.

## Background

OpenKit's existing AEP and workspace synchronization specs already separate authored manifests from resolved launch snapshots and already require worker writes to become reviewable change sets before workspace truth changes.

The missing refinement is session reuse under backends whose mounts and process environment are static or effectively static after sandbox start.

OpenShell is the immediate forcing function. OpenShell Providers v2 treats providers as profile-backed access bundles with credentials, endpoints, binaries, policy rules, and refresh behavior. Providers can be attached at sandbox creation, and current OpenShell documentation says runtime attach and detach update persisted provider lists and future effective policy reads, while credential environment changes apply only to new process launches after the sandbox observes the update. Already-running processes keep the environment they started with, so a long-running agent process that needs a newly attached provider placeholder must be restarted or replaced.

This constraint is not a problem if OpenKit treats the sandbox as a reusable substrate. The sandbox starts with a stable directory layout and an approved static capability envelope. Later turns populate and collect content inside that envelope through data-plane operations rather than through dynamic remounting.

## Decision

Use a two-level workspace model for worker sessions.

`SessionWorkspaceLayout` is session-static. It is resolved into the AEP before worker launch and describes the stable worker-visible directory skeleton and static access envelope.

`TurnWorkspaceMaterialization` is turn-dynamic. It describes how one turn populates declared slots, what baseline was exposed, what changed, and what should be collected after the worker finishes.

`WorkspaceSlot` is the bridge. A slot is a predeclared path inside the worker environment with access, retention, allowed source kinds, allowed sync modes, lineage rules, and review behavior. Inputs do not create arbitrary new roots at turn time; they bind to slots selected by the materializer.

`SessionCompatibilityKey` decides reuse. A session may be reused for a turn only when the session's static layout, provider envelope, policy envelope, runtime image, working-directory posture, control endpoints, and backend capabilities cover the turn's resolved needs and have not been revoked, drifted, or marked stale.

## Contract / Expected Behavior

### Static Versus Dynamic Fields

Session-static fields include:

- runtime image, image digest, command shape, user, group, umask, base working directory, sidecar presence, and control endpoint shape
- workspace root path, slot path set, slot access envelope, static filesystem policy, mount declarations, and output root declarations
- provider attachment envelope, provider environment placeholder envelope, network policy envelope, vault injection path class, and sandbox policy artifact shape
- transcript root, audit sink setup, backend service readiness checks, and backend capability summary

Turn-dynamic fields include:

- generated task files, context package files, instruction material, helper files, user-uploaded files, and small synthetic inputs
- Git checkout, fetch, branch creation, worktree population, patch collection, and optional bundle collection inside declared worktree slots
- workspace file and directory snapshots copied, bound, uploaded, downloaded, or rsynced into declared slots
- S3, R2, GCS, Azure Blob, Box, S3 file-manifest, HTTP archive, and artifact inputs synced into declared data or input slots
- output files, artifact candidates, worker transcripts, logs, evidence bundles, `WorkerOutputManifest`, and `WorkspaceChangeSet`
- refreshed credentials and provider attachment changes only to the extent the selected backend can make them visible to future process launches or gateway-mediated traffic without mutating already-running process environments

If a requested change touches a session-static field and the backend cannot apply it safely in place, NanoCore MUST mark the session stale for that turn and launch a replacement session.

### SessionWorkspaceLayout

The conceptual shape is:

```jsonc
{
  "schemaVersion": 1,
  "layoutId": "swl_01jz...",
  "root": "/workspace",
  "workingDirectory": "/workspace",
  "slots": [
    {
      "id": "main-worktree",
      "kind": "worktree",
      "path": "/workspace/worktrees/main",
      "access": "read-write",
      "allowedSourceKinds": ["git", "workspace-dir"],
      "allowedMaterializationModes": ["checkout", "fetch", "bind", "copy", "upload", "rsync"],
      "writeBack": "reviewed-change-set",
      "retention": "session",
      "lineageRequired": true
    },
    {
      "id": "turn-inputs",
      "kind": "input",
      "path": "/workspace/inputs",
      "access": "read-only",
      "allowedSourceKinds": ["workspace-file", "workspace-dir", "generated", "openkit-artifact", "http-archive"],
      "allowedMaterializationModes": ["copy", "upload", "rsync"],
      "writeBack": "discard",
      "retention": "turn"
    },
    {
      "id": "external-data",
      "kind": "data",
      "path": "/workspace/data",
      "access": "read-only",
      "allowedSourceKinds": ["s3", "r2", "gcs", "azure-blob", "box", "s3-files"],
      "allowedMaterializationModes": ["object-store-sync", "provider-file-sync", "gateway-read", "fuse-mount"],
      "writeBack": "artifact-only",
      "retention": "policy"
    },
    {
      "id": "turn-output",
      "kind": "output",
      "path": "/workspace/outputs",
      "access": "read-write",
      "allowedSourceKinds": ["generated"],
      "allowedMaterializationModes": ["create-empty"],
      "writeBack": "artifact-or-reviewed-change-set",
      "retention": "turn"
    }
  ],
  "control": {
    "transcriptRoot": "/openkit/session",
    "contextRoot": "/openkit/context",
    "instructionsRoot": "/openkit/instructions"
  }
}
```

Slot kinds are:

| Kind | Purpose |
| --- | --- |
| `worktree` | A repository checkout or mutable project tree that can produce reviewed workspace changes. |
| `input` | Turn-specific files, directories, generated helpers, attachments, and prior artifacts that should not be written back. |
| `data` | Larger external data from object stores, provider file APIs, file manifests, archives, or read-only workspace data. |
| `artifact-input` | Prior OpenKit artifacts materialized as context. |
| `output` | Declared output roots collected into artifacts and optional change sets. |
| `scratch` | Ephemeral worker scratch space that is not product truth. |
| `session` | OpenKit transcript, worker events, evidence manifests, and control files. |
| `context` | Generated task context and context package material. |
| `instructions` | Resolved static and generated instruction material. |
| `cache` | Runtime or dependency cache allowed by policy and not treated as canonical workspace state. |

Rules:

- Slot paths MUST be absolute inside the worker environment or relative to the declared workspace root before backend materialization.
- Slot paths MUST NOT overlap in a way that lets a writable slot mutate a read-only slot.
- Slots MUST declare access, retention, allowed source kinds, allowed materialization modes, and write-back behavior.
- A turn input MUST bind to an existing compatible slot, or the materializer MUST fail before launch or choose a replacement session with a compatible layout.
- Slot declarations MUST NOT contain raw host paths, raw provider handles, raw object-store credentials, container IDs, VM IDs, OpenShell sandbox IDs, or backend upload handles.
- Slot IDs are OpenKit IDs for product lineage. Backend-native mount names, upload handles, gateway paths, and file-transfer handles belong only in backend-private materialization records and redacted evidence.

### Default Directory Skeleton

The default reusable worker filesystem skeleton should be:

```text
/workspace/
  worktrees/
    main/
  inputs/
  data/
  artifacts/
    in/
    out/
  outputs/
  scratch/
  .openkit/
    materializations/
    manifests/
/openkit/
  context/
  instructions/
  session/
```

The default worker working directory SHOULD be `/workspace` rather than one specific repository path.

Agents should receive the active root for the current turn as context, such as `/workspace/worktrees/main`, instead of baking a repository path into the session's base working directory.

Backends MAY use different concrete paths when required, but the AEP and materialization records MUST expose a stable OpenKit path summary and preserve slot identity.

### TurnWorkspaceMaterialization

One turn materialization records:

- the target session and layout id
- the selected slots
- the workspace input snapshot id
- source refs, source digests, object-store locators, repository refs, generated content refs, and artifact refs
- selected materialization strategy per input
- upload, checkout, sync, or mount summary
- baseline manifest per mutable slot
- excluded paths and path policy decisions
- output collection roots
- evidence bundle ids

Materialization MUST occur before the worker receives the turn as ready.

Collection MUST produce a `WorkerOutputManifest` and then a `WorkspaceChangeSet` when any output is a workspace change candidate.

The control plane MAY announce materialization and collection readiness, but large file payloads, patches, bundles, logs, and artifacts MUST move through backend data transport.

### Source Kind Mapping

Endpoint-bearing sources in this table are resolved through workspace data source catalog references per `docs/specs/20260704-workspace_data_source_catalog.md`; the manifest carries a `sourceRef` plus narrowing, and the catalog entry supplies the locator, access class, sensitivity, and vault grant reference. Source ids flow into materialization lineage.

| Authored input | Source kind | Default slot | First strategy |
| --- | --- | --- | --- |
| Small synthetic file | `generated` | `context`, `instructions`, or `input` | Write generated content into the slot before turn start. |
| Helper directory | `generated` or `workspace-dir` | `input` | Copy or upload into a read-only input slot. |
| Local file | `workspace-file` | `input` | Validate workspace-relative ref, then bind, copy, upload, or rsync. |
| Local directory | `workspace-dir` | `input`, `data`, or `worktree` | Validate workspace-relative ref, then bind locally or upload/rsync remotely. |
| Git repository | `git` | `worktree` | Clone or fetch the requested ref, collect patch or bundle, and review before apply. |
| S3 prefix | `s3` | `data` | S3-compatible staged sync into a data slot. |
| R2 prefix | `r2` | `data` | S3-compatible staged sync with R2 endpoint and provider profile. |
| GCS prefix | `gcs` | `data` | Provider-specific sync into a data slot. |
| Azure Blob prefix | `azure-blob` | `data` | Provider-specific sync into a data slot. |
| Box folder or file | `box` | `data` or `input` | Provider file sync or gateway read; do not present Box as POSIX unless a backend capability proves it. |
| S3 file manifest | `s3-files` | `data` | Sync exactly the listed objects and record object digests. |
| Prior OpenKit artifact | `openkit-artifact` | `artifact-input` | Copy or upload artifact bytes with artifact lineage. |
| Prior turn upload | `openkit-upload` | `input` | Copy or upload the attachment bytes by file id with digest verification and turn lineage; no knowledge governance required. |
| Output directory | `generated` | `output` | Create empty before turn start, collect on turn end. |

Object-store mounts SHOULD start with staged sync or gateway-mediated read.

FUSE or native mount MAY be added later only when the backend declares the capability and recovery, read-only enforcement, digest evidence, and audit behavior are explicit.

### Local Container Projection

For local containers, the materializer SHOULD prefer direct filesystem projections when they satisfy policy:

- bind mount workspace-owned directories into declared slots when the source is local and the slot allows `bind`
- use read-only bind mounts for read-only slots when the backend can enforce it
- copy small generated files and helper directories into a session staging volume before turn start
- clone or fetch Git repositories into a slot-local worktree or a staging worktree mounted into the slot
- collect outputs from declared output slots and session transcript slots at turn end

Raw host paths remain backend-private.

Product records expose slot refs, workspace refs, digests, and redacted summaries.

### Remote Container Projection

For remote containers, the materializer MUST assume local host paths are not visible.

The preferred projection is:

```text
prepare snapshot or source plan
  -> create or select compatible session layout
  -> upload, rsync, remote checkout, provider sync, or gateway read into declared slots
  -> verify slot manifests and digests
  -> execute the turn
  -> collect output manifest, patches, bundles, artifacts, transcripts, logs, and evidence
  -> verify and stage results in NanoCore
```

Remote materialization MAY use tar streams, rsync, Git clone or fetch, object-store staging, OpenShell sandbox upload and download primitives, provider file APIs, or managed-sandbox file APIs.

Remote materialization MUST preserve digests, byte counts, path lists, source refs, backend capability summary, and redacted backend handle summaries for recovery.

Recovery MUST resume from NanoCore-owned materialization, backend handle, output manifest, and evidence records, not from remote runtime state alone.

### OpenShell Projection

OpenShell-backed sessions should be treated as long-lived sandbox substrates.

At sandbox creation, NanoCore should attach the provider set and static policy envelope needed by the planned session class, create or verify the default workspace skeleton, and prepare transcript and output roots.

OpenShell provider profiles and provider instances remain derived artifacts under `docs/specs/20260703-openshell_mechanism_internalization.md`.

Runtime provider attach and detach MAY be used when it is safe, but OpenKit MUST preserve the current limitation that already-running processes keep their original environment.

If the main long-running worker process needs a provider placeholder, network endpoint, static mount, or working-directory change that was not present at process start, NanoCore MUST start a replacement process or replacement session instead of claiming live mutation succeeded.

OpenShell upload, download, exec, policy, provider, and log outputs are backend evidence and transport effects. They are not product truth until NanoCore normalizes them into OpenKit records.

### SessionCompatibilityKey

`SessionCompatibilityKey` is a deterministic digest over the session-static envelope that matters for safe reuse.

The key should cover:

- agent id, profile id, runtime family, runtime image digest, command shape, process user and group, base working directory, sidecar shape, and control mode
- workspace root, slot ids, slot paths, slot kinds, slot access envelope, allowed materialization modes, output roots, transcript roots, and static filesystem policy digest
- provider attachment envelope, vault injection visibility classes, provider profile mapping version, and provider credential placeholder names when process-visible
- network policy envelope, permission policy digest, sandbox policy digest, resource class, and backend capability summary
- AEP schema version, required features, mapping versions, and backend family

The key MUST NOT include raw secret values, raw host paths, backend-native handles, upload IDs, sandbox IDs, object-store credentials, or current turn payload digests.

A session can be reused when:

- the requested turn's static requirements are a subset of or equal to the session envelope
- the session's provider, vault, permission, and policy grants are still active
- the session has not been marked stale by config reload, provider revocation, backend drift, failed conformance, or unsupported required feature
- the requested turn can bind all inputs to declared slots without path overlap or access escalation
- the session is idle or the scheduler explicitly allows the requested concurrency

If reuse fails because the session is too narrow, NanoCore SHOULD create a replacement session with a compatible layout rather than widening the existing session silently.

### Concurrency And Slot Hygiene

The first implementation supports exactly one active turn per session. Turn-scoped slots (`input`, `output`, and any slot with `retention: turn`) are single-occupant by design, and the durable scheduler's session lease model assumes one lease per session. Concurrent turns in one session are gated behind a `session.concurrent-turns` required feature and explicit scheduler support, and MUST NOT be enabled implicitly.

At collection time the materializer MUST clear all `retention: turn` slot contents after outputs, transcripts, and evidence are collected. If clearing fails, the session MUST be marked stale for reuse so prior-turn contents cannot leak into the next turn; a stale-for-hygiene session is replaced, not silently reused. `retention: session` contents persist across turns within the session; `retention: policy` contents follow workspace policy.

### Write-Back Policy

Workers do not write source-of-truth data directly.

Slot write-back modes are:

| Mode | Meaning |
| --- | --- |
| `discard` | Changes in the slot are ignored after the turn except for restricted evidence when policy retains it. |
| `artifact-only` | Collected outputs become artifacts but do not mutate workspace sources. |
| `reviewed-change-set` | Changes are staged as a workspace review and require approval before apply. |
| `artifact-or-reviewed-change-set` | NanoCore classifies outputs as artifacts, workspace changes, or both during import. |
| `external-writeback` | Future explicit external system mutation path that requires its own required feature, permission decision, audit, and review policy. |

`external-writeback` is not part of the first implementation.

### Provider And Credential Rules

Provider access should be included in the session-static envelope when the long-running worker process needs process-visible placeholders or provider-derived network policy.

Gateway-mediated capabilities can remain turn-dynamic when the worker reaches providers only through `capability.local` or `inference.local` and does not need direct provider credentials.

If a provider is attached after sandbox start, NanoCore MUST distinguish future policy availability from live process environment availability.

If a credential is revoked, expires, or loses permission while a session is idle or running, NanoCore MUST mark the session stale or degraded according to the owning vault and permission specs and MUST block further turns that require the revoked capability.

### Record Ownership

`SessionWorkspaceLayout` and `SessionCompatibilityKey` belong to the AEP snapshot and agent-session runtime metadata.

`TurnWorkspaceMaterialization`, input snapshots, materialization records, backend handles, output manifests, change sets, staged reviews, apply plans, apply results, and reconciliation records belong to workspace synchronization storage.

Backend-native file-transfer handles, upload IDs, sandbox IDs, container paths outside the worker-visible summary, object-store temporary keys, provider-native request IDs, and gateway state are evidence or backend-private runtime metadata, not public product identity.

## Accepted Design

The first implementation should add a planner in NanoCore that takes resolved AEP workspace input declarations and backend capability declarations and returns:

- a desired `SessionWorkspaceLayout`
- a `SessionCompatibilityKey`
- a decision to reuse an existing session or create a replacement session
- a `TurnWorkspaceMaterialization` plan that binds each input to a slot
- a collection plan for outputs, transcripts, evidence, and workspace changes

The planner should be backend-portable.

Backend adapters should implement only transport and enforcement effects:

- local container adapter: bind, copy, local checkout, local staging, and direct output collection
- OpenShell adapter: sandbox create, provider attachment, policy materialization, upload, download, exec, log collection, and evidence import
- remote container adapter: tar, rsync, remote checkout, object-store staging, sidecar upload, output download, and recovery handle persistence
- managed sandbox adapter: provider file APIs and provider workspace manifest APIs when supported

Source adapters should normalize source-specific listing and digest behavior:

- Git adapter resolves refs and base commits
- S3-compatible adapter covers AWS S3, R2, and compatible endpoints
- GCS and Azure adapters normalize object metadata and digest evidence
- Box adapter normalizes folder and file listings without claiming POSIX mount behavior
- generated adapter writes task and helper files from NanoCore records
- artifact adapter resolves prior artifact bytes with lineage

## Current Implementation Projection

The current implementation has a first shared schema and planner slice in `@openkit/config-schema`. `packages/config-schema/src/session-workspace.ts` defines `SessionWorkspaceLayout`, `WorkspaceSlot`, `TurnWorkspaceMaterialization`, and `SessionCompatibilityKey` schemas; creates the default reusable `/workspace` and `/openkit` slot skeleton; computes a strict SHA-256 `SessionCompatibilityKey` from the session-static envelope without package lineage ids; maps first-slice workspace inputs into declared slots; and returns strict V1 reuse, replacement, or create decisions. The schema rejects duplicate slots, unsafe worker paths outside the public worker envelope, and writable slots that contain read-only slots. NanoCore AEP resolution now projects this planner output into `extensions.openkit.sessionWorkspace` on resolved OpenShell packages so backend materializers can read the layout, compatibility key, turn materialization, and first-slice decision from the same package snapshot. The live Codex/OpenShell host adapter compares this compatibility key before reusing an existing thread-bound session and replaces the session when the key is missing or mismatched. The OpenShell backend workspace upload path now reads the planned input-to-slot mapping and extracts backend-private read-write host-dir, read-only host-dir, and NanoCore-prepared `materialized-dir` workspace bundles into the selected session workspace slot path instead of the legacy raw workspace input target. The OpenShell Codex command projection now uses the planned worktree slot as the task active directory while leaving the session base working directory as the layout root. Workspace materialization records persisted by the governance turn executor now preserve the backend-reported slot path as `materializedRootRef`, so diagnostics and review records describe the real worker-visible location. NanoCore App API exposes these records through `workspace-sync/materialization-records`, and the MCP facade exposes them through the read-only `openkit.read_workspace_sync_records` tool and `openkit://workspaces/{workspaceId}/workspace-sync/records` resource.

Current AEP docs classify image, base command, initial process environment, static filesystem mounts, user/group identity, and working directory as static fields, and the session workspace planner now makes the strict compatibility key the center of V1 reuse. The durable scheduler dispatch loop uses the strict V1 continuity selector from the agent-session continuity spec when callers provide live, resume, or snapshot candidates; without valid candidates it intentionally selects a fresh session.

The current workspace synchronization implementation can stage Git patches and filesystem changes, persists first-slice `BackendWorkspaceHandle`, `WorkerOutputManifest`, `WorkspaceApplyPlan`, `WorkspaceReconciliationRecord`, and `WorkspaceQuarantineRecord` rows as first-class records, and promotes product-safe evidence through the general `EvidenceBundle` ledger. The accepted workspace synchronization contract removes the redundant `WorkspaceSyncEvidenceBundle` record family under the [Evidence Surface Simplification](../changes/202607111848520001-evidence_surface_simplification.md) change plan; this does not change session-static layout or materialization semantics owned by this spec. Non-host-dir read-only coverage currently supports NanoCore-prepared `materialized-dir` directory inputs for OpenShell. Local-container materialization, remote-container materialization, external provider/object-store/gateway read-source adapters, superset-compatible reuse, and broader backend-native mount support remain deferred future work rather than V1 blockers.

## Alternatives Considered

### Treat Every Input As A Dynamic Mount

Rejected.

This sounds uniform, but it fights backends whose mount set is static after sandbox start and makes reusable sessions fragile. It also turns source differences into backend differences, causing every backend to understand every source kind.

### Restart A Sandbox For Every Turn

Rejected as the default.

It is simple and maximally least-privilege, but it loses warm runtime value, increases latency and resource churn, and does not match the product goal of reusable agent sessions. It remains the safe fallback when compatibility fails.

### Give Every Session A Very Broad Static Envelope

Rejected.

A broad envelope would maximize reuse but weaken least privilege and blur audit. The static envelope must be policy-approved, explainable, and bounded by workspace, user, provider, vault, permission, and sandbox policy.

### Make OpenShell The Canonical Layout Model

Rejected.

OpenShell is the first serious backend and should influence the design, but OpenKit records must remain canonical and backend-portable. OpenShell paths, provider records, sandbox IDs, upload handles, and policy YAML stay as derived materialization output or evidence.

## Consequences

- Session reuse becomes a deliberate compatibility decision instead of an accidental reuse of a warm runtime.
- Long-lived sessions can handle many turns by filling stable slots instead of remounting filesystems.
- Backends with static filesystem and process-environment constraints become first-class rather than special cases.
- Object-store and provider-file inputs can start with staged sync and later add native mounts without changing manifest semantics.
- The AEP must carry more explicit session-static layout information, and workspace synchronization must carry more explicit turn-dynamic materialization records.
- Users may see more honest diagnostics: "new session required because provider placeholder was not present at process start" or "new session required because requested input cannot bind to any declared slot."

## Rollout / Migration Plan

1. Add schema definitions for `SessionWorkspaceLayout`, `WorkspaceSlot`, `TurnWorkspaceMaterialization`, and `SessionCompatibilityKey` in the package that owns AEP and workspace synchronization schemas.
2. Update AEP resolution to produce a default reusable layout for container workers.
3. Update session selection to compute compatibility keys and choose reuse, replacement, or blocked diagnostics before launch.
4. Update local container materialization to bind or copy into declared slots.
5. Update OpenShell materialization to create or verify the directory skeleton, then upload, checkout, sync, and collect through declared slots.
6. Update remote container materialization to use tar or rsync into declared slots with digest verification.
7. Add S3-compatible staged sync for AWS S3 and R2, then add exact object-list support for `s3-files`.
8. Add GCS, Azure Blob, and Box provider-file sync after the S3-compatible path is stable.
9. Add native FUSE or backend mount support only after recovery, digest evidence, read-only enforcement, and audit behavior are explicit.

No legacy preservation is required for existing internal materialization shapes.

## Testing Strategy / Acceptance Criteria

- Schema tests accept valid layouts, slots, compatibility keys, and turn materialization records.
- Schema tests reject overlapping slots, writable parents of read-only children, path traversal, raw host paths in public records, unsupported source kinds, unsupported materialization modes, and unsupported required features.
- Planner tests prove that a compatible turn reuses a session and an incompatible turn selects replacement or fails closed.
- Planner tests prove that turn payload digests do not affect `SessionCompatibilityKey`, while static layout, provider envelope, working directory, runtime image, and policy digest do affect it.
- Local container tests prove workspace-relative files and directories bind or copy into slots and that collected outputs become artifacts or staged change sets.
- Remote container tests prove tar or rsync materialization preserves digests and recovers from interrupted upload or download using NanoCore records.
- Git tests prove clone or fetch into a worktree slot, patch collection, `git apply --check`, staged review, and approved apply.
- S3-compatible tests prove S3 and R2 use one adapter path with provider-specific endpoints and no raw credentials in records.
- OpenShell tests prove provider attach limitations are represented honestly: a new provider needed by the already-running main process requires process replacement or session replacement.
- Redaction tests prove backend handles, upload IDs, object-store temporary keys, and provider credentials do not leak into App API, MCP, Web UI, audit summaries, or diagnostics.

Acceptance requires that a long-lived session can run at least two turns with different input contents in the same slot without remounting, and that a turn requiring a new static provider or path envelope creates a replacement session with clear diagnostics.

## Risks & Mitigations

- Risk: static slot envelopes become too broad. Mitigation: require policy approval, access classification, and compatibility-key audit for the envelope.
- Risk: slot contents become hidden workspace truth. Mitigation: all source-of-truth writes go through output manifests, change sets, staged review, and apply results.
- Risk: OpenShell limitations are hidden behind optimistic reuse. Mitigation: explicit static-versus-dynamic classification and fail-closed session replacement when a live process cannot receive a change.
- Risk: object-store sync becomes expensive for large datasets. Mitigation: support exact object manifests, digest caching, rsync-like deltas where available, and future gateway-read or FUSE only after evidence and recovery are designed.
- Risk: remote recovery is ambiguous. Mitigation: persist backend handles, upload/download manifests, content digests, and evidence bundle ids before and after every transport phase.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: `SessionCompatibilityKey` matching is strict equality in V1, with superset-compatible reuse deferred and owned by `docs/specs/20260704-agent_session_continuity.md`; default reusable layouts use a shared base layout with workspace-policy overlays and agent-family-specific variants only when static requirements diverge; object-store inputs above 256 MiB or 10,000 objects switch to future gateway-read or native mount strategies once those modes exist; dependency cache reuse is disabled until cache poisoning policy, invalidation, and audit semantics are explicit.

## Deferred / Future Work

- Native FUSE or backend object-store mounts for S3, R2, GCS, Azure Blob, and Box after read-only enforcement, cache invalidation, recovery, and audit are designed.
- External writeback to Git hosting, S3, R2, GCS, Azure Blob, Box, and other domain systems under explicit required features and approval policy.
- Snapshot, fork, clone, and rollback record contracts are now owned by `docs/specs/20260704-agent_session_continuity.md`; layout- and slot-level snapshot mechanics remain future work here.
- Cross-session cache reuse and cache poisoning controls.
- A UI or MCP diagnostic surface that explains why a session was reused, replaced, stale, degraded, or blocked.

## Links

- [Evidence Surface Simplification](../changes/202607111848520001-evidence_surface_simplification.md)

- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/core/agent-session.md`
- `docs/core/sandbox.md`
- `docs/core/storage.md`
- External reference: NVIDIA OpenShell Providers v2, `https://docs.nvidia.com/openshell/latest/sandboxes/providers-v2`.
