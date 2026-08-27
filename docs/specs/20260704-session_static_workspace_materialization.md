---
status: Accepted
implementation: Partial
updated: 2026-08-22
---
# AgentSession Static Workspace Materialization

## Owns

- The contract that separates AgentSession-static sandbox layout from per-turn dynamic workspace materialization.
- The `SessionWorkspaceLayout`, `WorkspaceSlot`, `TurnWorkspaceMaterialization`, and `SessionCompatibilityKey` concepts used by AEP resolution and workspace synchronization.
- Reuse rules for long-lived local-container, remote-container, OpenShell, Docker, VM, Kubernetes, and managed-sandbox worker sessions when filesystem mounts, provider attachments, working directories, and process environments may be static after sandbox start.
- The OpenShell-inspired implementation posture for fixed directory skeletons plus dynamic file population through upload, checkout, rsync, object-store sync, provider file APIs, gateway reads, and output collection.
- The default mapping from authored workspace input kinds such as file, directory, local file, Git repository, S3, R2, GCS, Azure Blob, Box, S3 file manifests, generated files, artifacts, and outputs into stable workspace slots.
- Per-AgentSession namespaces in a shared Sandbox, Turn-slot hygiene, and the bounded non-canonical shared working area.

## Does Not Own

- Canonical storage ownership and record layout, which belongs to `docs/specs/20260703-storage_layout_record_ownership.md`.
- General workspace synchronization lifecycle records, staged review, apply, and recovery, which belong to `docs/specs/20260703-workspace_synchronization.md`.
- The resolved AEP envelope and cross-boundary invariants belong to `docs/specs/20260616-agent_environment_package.md`; this specification owns the session-static and turn-dynamic workspace contract projected into that envelope.
- Authored agent manifest resolution and schema evolution, which belong to `docs/specs/20260703-agent_manifest_aep_resolution.md` and `docs/specs/20260703-schema_evolution_record_envelope.md`.
- OpenShell credential injection, provider profile derivation, and policy-layer internalization, which belong to `docs/specs/20260703-openshell_mechanism_internalization.md`.
- Vault, permission, audit, provider, Git hosting, object-store API, Box API, or backend-native file-transfer implementation details.
- OpenShell CLI behavior, OpenShell upstream roadmap, Docker volume semantics, Kubernetes volume semantics, or managed-sandbox provider schemas.
- Runtime Epoch lifecycle, RelayStream, Sandbox Integration, or route credentials, which belong to `docs/specs/20260802-nanohost_runtime_and_transport.md`.

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

OpenKit should optimize for long-lived reusable AgentSessions without pretending that sandbox filesystem mounts, working directories, process environments, and provider-provided environment placeholders can always be changed in place after a sandbox starts.

The accepted model is: AgentSession layout is static, slot contents are Turn-dynamic, and every mutable or conversation-bearing slot is separately addressable by AgentSession inside a shared Sandbox.

NanoCore resolves an agent setup into a session-static descriptor before launch, and the NanoHost materializes that descriptor into the sandbox through Sandbox Integration. The substrate defines the worker-visible directory skeleton, writable and read-only path envelope, provider attachment envelope, network envelope, distinct worker-control, inference, and capability bindings, transcript sinks, output roots, and working-directory posture. Each turn then materializes files, repositories, object-store prefixes, generated context, Artifacts, and outputs into predeclared slots inside that substrate through an existing native or bounded data path.

This improves reuse for OpenShell-backed sessions because the sandbox starts with a broad but policy-approved workspace structure, while each turn can still receive fresh task data and produce reviewable change sets without requiring a new sandbox for every input change.

## Goals / Non-goals

### Goals

- Make reusable AgentSessions safe and predictable when backend mounts are session-static.
- Avoid frequent sandbox recreation by predeclaring stable workspace slots and filling their contents dynamically.
- Keep NanoCore-owned records as product truth while allowing backends to use bind mounts, uploads, downloads, rsync, checkout, object-store sync, FUSE, or provider file APIs as transport projections.
- Support both local containers and remote containers with one materialization contract.
- Keep worker writes review-gated by default through `WorkspaceChangeSet` and staged apply.
- Make session reuse explainable through a deterministic `SessionCompatibilityKey`.
- Preserve conversation-context and Workspace-write isolation through per-AgentSession namespaces without claiming security and adjudication isolation.
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

AgentSession-static fields include:

- runtime image, image digest, command shape, user, group, umask, base working directory, worker-shim identity, and direct control endpoint shape
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

### Git Source Materialization Boundary

A Git input for a remote Agent Runtime MUST resolve to a network-addressable repository locator and an exact accepted commit. Before the Agent process starts, a Sandbox-side workspace materializer uses the worker image's Git client to clone or fetch that repository, check out the exact commit into the declared worktree slot, and prove the resulting clean `HEAD`. A NanoCore host path, unpublished local commit, implicit host checkout, tar copy, or Git-bundle fallback is not an alternate source form.

After launch, an Agent may use `git` and a hosting client such as `gh` inside the Sandbox when the source access class, permission, approval, Vault grant, and network policy authorize the operation. NanoHost owns only Sandbox lifecycle and network-policy enforcement for this traffic; it does not execute Git commands, parse Git objects, select commits, hold hosting credentials, or interpret clone, fetch, push, branch, or pull-request semantics.

Missing or unreachable repository locators, missing commits, denied egress, absent or stale grants, checkout mismatch, or dirty initial state fail before Agent start without falling back to NanoCore-hosted repository bytes. Retry is a fresh materialization from the current catalog, grant, policy, and remote repository state. Partial checkout remains disposable Sandbox-local state and follows the existing cleanup boundary; it never becomes NanoCore storage or later-Turn authority.

If a requested change touches a session-static field and the backend cannot apply it safely in place, NanoCore MUST mark the session stale for that turn and launch a replacement session.

### SessionWorkspaceLayout

The conceptual shape is:

```jsonc
{
  "schemaVersion": 1,
  "layoutId": "swl_01jz...",
  "root": "/workspace/sessions/<agent-session-id>",
  "workingDirectory": "/workspace/sessions/<agent-session-id>",
  "slots": [
    {
      "id": "main-worktree",
      "kind": "worktree",
      "path": "/workspace/sessions/<agent-session-id>/worktrees/main",
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
      "path": "/workspace/sessions/<agent-session-id>/inputs",
      "access": "read-only",
      "allowedSourceKinds": ["workspace-file", "workspace-dir", "generated", "openkit-artifact", "http-archive"],
      "allowedMaterializationModes": ["copy", "upload", "rsync"],
      "writeBack": "discard",
      "retention": "turn"
    },
    {
      "id": "external-data",
      "kind": "data",
      "path": "/workspace/sessions/<agent-session-id>/data",
      "access": "read-only",
      "allowedSourceKinds": ["s3", "r2", "gcs", "azure-blob", "box", "s3-files"],
      "allowedMaterializationModes": ["object-store-sync", "provider-file-sync", "gateway-read", "fuse-mount"],
      "writeBack": "artifact-only",
      "retention": "policy"
    },
    {
      "id": "turn-output",
      "kind": "output",
      "path": "/workspace/sessions/<agent-session-id>/outputs",
      "access": "read-write",
      "allowedSourceKinds": ["generated"],
      "allowedMaterializationModes": ["create-empty"],
      "writeBack": "artifact-or-reviewed-change-set",
      "retention": "turn"
    }
  ],
  "control": {
    "transcriptRoot": "/openkit/sessions/<agent-session-id>/transcript",
    "contextRoot": "/openkit/sessions/<agent-session-id>/context",
    "instructionsRoot": "/openkit/sessions/<agent-session-id>/instructions"
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
  base/                                      shared immutable baseline
  sessions/
    <agent-session-id>/
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
  shared-working/                            non-canonical and disposable
/openkit/
  sessions/
    <agent-session-id>/
      context/
      instructions/
      transcript/
      control/
```

The default worker working directory SHOULD be its `/workspace/sessions/<agent-session-id>` namespace rather than the Sandbox root or one specific repository path.

Agents should receive the active root for the current turn as context, such as `/workspace/sessions/<agent-session-id>/worktrees/main`, instead of baking a repository path into the session's base working directory.

Backends MAY use different concrete paths when required, but the AEP and materialization records MUST expose a stable OpenKit path summary and preserve slot identity.

### AgentSession Namespaces And Turn Slots

One shared Sandbox may contain multiple open AgentSessions, but each AgentSession has one separately addressable mutable namespace for its worktree, inputs, outputs, scratch, generated context, instructions, transcript, native conversation files, local route bindings, and writable caches. That namespace is Workspace-write isolation, not security and adjudication isolation. The namespace is part of the AgentSession-static layout and remains bound to that exact AgentSession until close. Another AgentSession never receives it as its own slot set, and a different Thread never inherits it through compatible placement.

The shared immutable baseline and proved immutable or content-addressed read-only caches may be projected into more than one AgentSession namespace. No shared writable canonical Workspace tree is permitted. Filesystem namespacing under one OS identity proves Workspace-write isolation only; it is not security and adjudication isolation, and work requiring that stronger boundary uses proved OS isolation or a separate Sandbox.

AgentSession-persistent slots may retain a proved private worktree baseline and verified large-input views across sequential Turns in the same AgentSession. Turn-scoped slots include generated instructions, Context Package files, request inputs, output staging, route bindings, temporary credentials, transcript spools, and other request-specific material. Each new Turn replaces or clears those slots before `turn.start`, even when the same native conversation is reused.

Namespace creation follows `session.open` after Sandbox and Harness readiness and before the first Turn materialization. Slot contents update only through the owning materializer. Exact `session.close` removes the namespace after output, transcript, evidence, route-revocation, and local-cleanup barriers settle; cleanup uncertainty drains admission and widens the fence to the Harness, Sandbox, or Runtime Epoch boundary whose complete effects can be proved. Restart may adopt only the exact surviving AgentSession binding and namespace under current proof; otherwise later work receives a new namespace through fresh admission.

Missing, overlapping, stale, cross-boundary, access-widening, or dependency-failed slot declarations block materialization. A retained baseline whose identity, writer quiescence, output collection, Turn-slot clearing, delta safety, or current authorization cannot be proved makes the AgentSession stale and requires private-worktree replacement or AgentSession replacement. The materializer never preserves an unproved dirty baseline for latency.

Observable acceptance requires two open AgentSessions in one Sandbox to expose distinct mutable, context, transcript, control, and output namespaces; two sequential Turns in one AgentSession to reuse permitted persistent content while receiving empty or replaced Turn slots; an exact local close to preserve a compatible sibling; and an unprovable local cleanup to fence the wider boundary before reuse or capacity return.

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

Materialization MUST occur before the worker receives the turn as ready.

Collection MUST produce a `WorkerOutputManifest` and then a `WorkspaceChangeSet` when any output is a workspace change candidate.

For NanoHost cross-host collection, an AEP output declaration supplies only the output id, slot-relative path, registration posture, and retention. After the terminal and process-group barrier, NanoHost computes the actual digest and length while collecting the exact regular file, and NanoCore verifies and atomically stages those bytes before the existing `WorkerOutputManifest`, transcript import, or `WorkspaceChangeSet` owner may classify or accept them.

The control plane MAY announce materialization and collection readiness, but large file payloads, patches, bundles, logs, and artifacts MUST move through backend data transport. The NanoHost V1 projection uses one distinct fixed file-data stream on the same authoritative outer physical HTTP/2 connection, never a control, readiness, worker-control, inference, or capability stream.

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

### S39 Dedicated Context Package Binding

The S39 accepted worker-Turn trace reuses the existing `generated` source kind and the existing `context` slot. Its one dedicated AEP workspace input is the exact S39 tuple: `kind=generated`, `source.kind=generated`, `target` equal to `SessionWorkspaceLayout.control.contextRoot`, `access=read-only`, and `materialization.slotId=context`. The selected slot MUST have `id=context`, `kind=context`, `path` equal to that control root and input target, `access=read-only`, `allowedSourceKinds` containing `generated`, `writeBack=discard`, and a local `copy` or remote `upload` mode supported by the selected backend.

The session workspace planner MUST bind this exact input to the `context` slot before applying the general generated-input default; it MUST NOT route it to `turn-inputs`, infer a new slot from its path, or create a context-specific source adapter. Every other generated input continues through the existing authored mapping. The WIS, WMR, package-root digest, backend handoff, and ready predicate remain owned by S39 and reuse the existing Turn materialization records without a new status or lifecycle.

For a NanoHost on another host, the prepared immutable package root is named `context_<turnId>` and `WorkerContextPackageFiles` supplies the exact bytes plus the sorted `fileInventory` of package-relative path, byte length, and content digest. The backend matches that generated AEP input to NanoCore-private `workspaceRoots`, recomputes the sorted regular-file inventory and package-root digest, and issues exactly one `reference.import` per inventory entry after `sandbox.create` and before `bridge.open`. A source path, host path, archive, adjacent or mutable locator, and every other source kind remain private and never cross the wire.

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

Remote materialization MAY use tar streams, rsync, Git clone or fetch, object-store staging, provider file APIs, or managed-sandbox file APIs under their existing owners. The NanoHost V1 Context Package and declared-output projection instead uses the exact per-file import and export carriage owned by `docs/specs/20260801-nanohost_workspace_data_boundary.md`; it adds no archive, host locator, transfer schema, or alternate data connection.

Remote materialization MUST preserve digests, byte counts, path lists, source refs, backend capability summary, and redacted backend handle summaries for recovery.

Recovery MUST resume from NanoCore-owned materialization, backend handle, output manifest, and evidence records, not from remote runtime state alone.

### OpenShell Projection

OpenShell-backed sessions should be treated as long-lived sandbox substrates.

At sandbox creation, NanoCore should attach the provider set and static policy envelope needed by the planned session class, create or verify the default workspace skeleton, and prepare transcript and output roots.

OpenShell provider profiles and provider instances remain derived artifacts under `docs/specs/20260703-openshell_mechanism_internalization.md`.

Runtime provider attach and detach MAY be used when it is safe, but OpenKit MUST preserve the current limitation that already-running processes keep their original environment.

If the main long-running worker process needs a provider placeholder, network endpoint, static mount, or working-directory change that was not present at process start, NanoCore MUST start a replacement process or replacement session instead of claiming live mutation succeeded.

OpenShell upload, download, exec, policy, provider, and log outputs are backend evidence and transport effects. For the NanoHost V1 projection, each Context Package inventory entry is imported before `bridge.open`, each declared output is exported only after the terminal barrier, and verified bytes enter an existing canonical collection owner before bridge close and sandbox delete. None is product truth until NanoCore performs that canonical handoff.

### SessionCompatibilityKey

`SessionCompatibilityKey` is a deterministic digest over the session-static envelope that matters for safe reuse.

The key should cover:

- agent id, profile id, runtime family, runtime image digest, command shape, process user and group, base working directory, worker-shim shape, and route-binding envelope
- workspace root, slot ids, slot paths, slot kinds, slot access envelope, allowed materialization modes, output roots, transcript roots, and static filesystem policy digest
- provider attachment envelope, vault injection visibility classes, provider profile mapping version, and provider credential placeholder names when process-visible
- network policy envelope, permission policy digest, sandbox policy digest, resource class, and backend capability summary
- AEP schema version, required features, mapping versions, and backend family

The key MUST NOT include raw secret values, raw host paths, backend-native handles, upload IDs, sandbox IDs, object-store credentials, or current turn payload digests.

A session can be reused when:

- the requested Turn's V1 `SessionCompatibilityKey` exactly equals the AgentSession's recorded key
- the session's provider, vault, permission, and policy grants are still active
- the session has not been marked stale by config reload, provider revocation, backend drift, failed conformance, or unsupported required feature
- the requested turn can bind all inputs to declared slots without path overlap or access escalation
- the AgentSession is idle

If reuse fails because the session is incompatible, NanoCore SHOULD create a replacement AgentSession with a compatible layout rather than widening the existing AgentSession silently. Superset-compatible reuse remains deferred and is not inferred from a broader envelope.

### Concurrency And Slot Hygiene

Each AgentSession supports exactly one active Turn. Turn-scoped slots (`input`, `output`, and any slot with `retention: turn`) are single-occupant by design, and the durable scheduler's session lease model assumes one lease per AgentSession. Concurrent Turns in one AgentSession are not authorized.

Separately, the accepted first shared-runtime profile permits multiple open AgentSessions in one declared Harness and fixes `maxActiveTurns = 1` across that Harness. Runtime-native child agents remain inside one outer AgentSession and do not create additional slots or Core AgentSession identities. Later concurrent active Turns across AgentSessions and multiple Harness Instances remain outside this specification's current authorization.

At collection time the materializer MUST clear all `retention: turn` slot contents after outputs, transcripts, and evidence are collected. If clearing fails, the AgentSession MUST be marked stale for reuse so prior-Turn contents cannot leak into the next Turn; a stale-for-hygiene AgentSession is replaced, not silently reused. `retention: session` contents persist across Turns within that AgentSession; `retention: policy` contents follow Workspace policy.

### Non-canonical Shared Working Material

The Sandbox may expose one non-canonical shared working area for uncommitted research notes, cloned references, intermediate datasets, comparison artifacts, and similar material whose value is temporary cross-AgentSession reuse. This is a Sandbox property, not a Core retention class, Workspace source, record family, durable lifecycle, canonical Workspace tree, evidence store, recovery input, or authorization surface. Its internal organization is deliberately unspecified.

The area has all four required edge constraints:

- It is Sandbox-scoped and may survive an AgentSession, but it becomes canonical only through the ordinary staged, reviewed, conflict-checked apply path.
- It carries no authority and cannot discharge a Review, verification, completion, audit, or evidence requirement.
- Its loss affects neither correctness nor recovery; no accepted operation, retry, rebuild, or recovery path may depend on its survival.
- It is openly cross-readable by co-resident AgentSessions, and containment remains at the apply boundary rather than pretending the area is private.

The area is created and discarded with its Sandbox, may be updated freely by admitted workers inside that Sandbox, is not retried or recovered, and is lost on drain, rebuild, cleanup, or failure without data-loss status. An arriving Turn may observe it only as non-authoritative working material and must use canonical sources and evidence for any governed claim. Missing or stale material causes no failure and no fallback; attempted publication outside staged apply is rejected, and any workflow that requires the material for correctness, recovery, or evidence is invalid.

Durable creation, update, termination, retry, and recovery lifecycle is explicitly not applicable because the area creates no durable record or state machine. Observable acceptance requires Sandbox rebuild to discard it without changing product truth or recovery, cross-AgentSession reads to confer no authority, and every canonical exit to pass through staged conflict-checked apply. Definition, authority boundary, failure semantics, and acceptance remain applicable and are stated above.

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

Gateway-mediated capabilities can remain turn-dynamic after a future AEP explicitly enables worker-local `capability.local`; Sandbox Integration projects them through `/capabilities/*` with a capability credential distinct from inference and worker control. Worker-local `inference.local` remains turn-dynamic through `/inference/*` with its own inference credential. Current AEP capability routes remain disabled; the accepted stock `ForwardTcp`/`RelayStream` pair and nested standard HTTP/2 target are implemented for the current worker-control and inference bindings without enabling capability.

If a provider is attached after sandbox start, NanoCore MUST distinguish future policy availability from live process environment availability.

If a credential or grant is revoked, expires, or loses permission while a session is idle or running, NanoCore MUST block further use and the NanoHost MUST terminate the affected sandbox. If deletion cannot be proved, the complete Runtime Epoch is invalidated and capacity remains fenced until fresh-empty readiness; cleanup does not prove recall.

### Record Ownership

`SessionWorkspaceLayout` and `SessionCompatibilityKey` belong to the AEP snapshot and AgentSession runtime metadata.

`TurnWorkspaceMaterialization`, input snapshots, materialization records, backend handles, output manifests, change sets, staged reviews, apply plans, apply results, and reconciliation records belong to workspace synchronization storage.

Backend-native file-transfer handles, upload IDs, sandbox IDs, container paths outside the worker-visible summary, object-store temporary keys, provider-native request IDs, and gateway state are evidence or backend-private runtime metadata, not public product identity.

## Decision Completeness

The definition and exclusions for AgentSession-static layout, per-AgentSession namespaces, Turn-scoped hygiene, and non-canonical shared working material are stated above. The AEP snapshot owns the durable layout and compatibility projection, workspace synchronization owns Turn materialization and canonical handoff records, and the runtime owns only physical namespaces, bytes, and cleanup effects; no backend path or shared material becomes Workspace truth.

Creation, update, termination, retry, recovery, conflict, missing, stale, restart, and dependency-failure behavior is stated in the namespace, hygiene, write-back, credential, and shared-working-material sections. Retry after replacement is fresh admission rather than reuse of a failed materialization effect. Observable acceptance is the conjunction of namespace isolation, Turn-slot clearing, exact compatible reuse or replacement, staged apply, sibling-preserving local cleanup, and fail-closed wider fencing. No decision class is not applicable except the shared area's durable lifecycle, for the reason stated in that section.

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
- remote container adapter: tar, rsync, remote checkout, object-store staging, backend upload, output download, and recovery handle persistence
- managed sandbox adapter: provider file APIs and provider workspace manifest APIs when supported

Source adapters should normalize source-specific listing and digest behavior:

- Git adapter resolves refs and base commits
- S3-compatible adapter covers AWS S3, R2, and compatible endpoints
- GCS and Azure adapters normalize object metadata and digest evidence
- Box adapter normalizes folder and file listings without claiming POSIX mount behavior
- generated adapter writes task and helper files from NanoCore records
- artifact adapter resolves prior artifact bytes with lineage

## Current Implementation Projection

The current implementation has a shared schema and planner slice in `@openkit/config-schema`. `packages/config-schema/src/session-workspace.ts` defines `SessionWorkspaceLayout`, `WorkspaceSlot`, `TurnWorkspaceMaterialization`, and `SessionCompatibilityKey` schemas; creates the default reusable `/workspace` and `/openkit` slot skeleton; computes a strict SHA-256 `SessionCompatibilityKey` from the session-static envelope without package lineage ids; maps workspace inputs into declared slots; and returns strict V1 reuse, replacement, or create decisions. The schema rejects duplicate slots, unsafe worker paths outside the public worker envelope, and writable slots that contain read-only slots. NanoCore AEP resolution projects this planner output into `extensions.openkit.sessionWorkspace` on resolved OpenShell packages so the NanoHost materializer reads the layout, compatibility key, turn materialization, and decision from the same package snapshot. Governed-worker session records persist this compatibility key so the scheduler rejects missing or mismatched reuse candidates before selecting a fresh session. The exact generated Context Package inventory maps to the `context` identity and one fixed import per regular file after package-config; workspace materialization records preserve the backend-reported slot path as `materializedRootRef`, and path-only outputs return through the fixed verified export handoff. NanoCore App API and the unified `openkit` Skill retain their read-only materialization-record projections. Broader source adapters and superset-compatible reuse remain outside this implemented slice and keep the specification Partial.

Current AEP docs classify image, base command, initial process environment, static filesystem mounts, user/group identity, and working directory as static fields, and the session workspace planner now makes the strict compatibility key the center of V1 reuse. The durable scheduler contains broader inactive candidate shapes, but the accepted product path uses only an exact live reconnect or a fresh authorized session; resume and snapshot candidates do not expand this contract.

The current workspace synchronization implementation can stage Git patches and filesystem changes, persists `BackendWorkspaceHandle`, `WorkerOutputManifest`, `WorkspaceApplyPlan`, `WorkspaceReconciliationRecord`, and `WorkspaceQuarantineRecord` rows as first-class records, and promotes product-safe evidence through automatic general `EvidenceBundle` producers. The redundant `WorkspaceSyncEvidenceBundle` record family has been removed without changing session-static layout or materialization semantics owned by this spec. The current production path is NanoHost-only: exact package-config and generated Context Package files use fixed imports, and declared path-only outputs use NanoHost-produced, NanoCore-verified exports. A Sandbox-side network Git materializer is not implemented, while the current repository path still projects a NanoCore host `localPath`; that path does not satisfy this contract. External provider and object-store adapters, superset-compatible reuse, and broader backend-native mount support remain unimplemented or deferred as stated by their owners.

## Alternatives Considered

### Treat Every Input As A Dynamic Mount

Rejected.

This sounds uniform, but it fights backends whose mount set is static after sandbox start and makes reusable sessions fragile. It also turns source differences into backend differences, causing every backend to understand every source kind.

### Restart A Sandbox For Every Turn

Rejected as the default.

It is simple and maximally least-privilege, but it loses warm runtime value, increases latency and resource churn, and does not match the product goal of reusable AgentSessions. It remains the safe fallback when compatibility fails.

### Give Every AgentSession A Very Broad Static Envelope

Rejected.

A broad envelope would maximize reuse but weaken least privilege and blur audit. The static envelope must be policy-approved, explainable, and bounded by workspace, user, provider, vault, permission, and sandbox policy.

### Make OpenShell The Canonical Layout Model

Rejected.

OpenShell is the first serious backend and should influence the design, but OpenKit records must remain canonical and backend-portable. OpenShell paths, provider records, sandbox IDs, upload handles, and policy YAML stay as derived materialization output or evidence.

## Consequences

- AgentSession reuse becomes a deliberate compatibility decision instead of an accidental reuse of a warm runtime.
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
- NanoHost cross-host tests prove the sorted Context Package inventory becomes one verified regular-file import per entry before bridge open, output declarations remain path-only, NanoHost supplies actual export digest and length after the terminal barrier, and NanoCore verifies and atomically stages each file before canonical collection.
- Git tests prove clone or fetch into a worktree slot, patch collection, `git apply --check`, staged review, and approved apply.
- S3-compatible tests prove S3 and R2 use one adapter path with provider-specific endpoints and no raw credentials in records.
- OpenShell tests prove provider attach limitations are represented honestly: a new provider needed by the already-running main process requires process replacement or session replacement.
- Redaction tests prove backend handles, upload IDs, object-store temporary keys, and provider credentials do not leak into App API, end-user CLI, Web UI, audit summaries, or diagnostics.

Acceptance requires that a long-lived session can run at least two turns with different input contents in the same slot without remounting, and that a turn requiring a new static provider or path envelope creates a replacement session with clear diagnostics.

## Risks & Mitigations

- Risk: static slot envelopes become too broad. Mitigation: require policy approval, access classification, and compatibility-key audit for the envelope.
- Risk: slot contents become hidden workspace truth. Mitigation: all source-of-truth writes go through output manifests, change sets, staged review, and apply results.
- Risk: OpenShell limitations are hidden behind optimistic reuse. Mitigation: explicit static-versus-dynamic classification and fail-closed session replacement when a live process cannot receive a change.
- Risk: object-store sync becomes expensive for large datasets. Mitigation: support exact object manifests, digest caching, rsync-like deltas where available, and future gateway-read or FUSE only after evidence and recovery are designed.
- Risk: remote recovery is ambiguous. Mitigation: persist backend handles, upload/download manifests, content digests, and evidence bundle ids before and after every transport phase.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: `SessionCompatibilityKey` matching is strict equality in V1, with superset-compatible reuse deferred and without a current owner; default reusable layouts use a shared base layout with workspace-policy overlays and agent-family-specific variants only when static requirements diverge; object-store inputs above 256 MiB or 10,000 objects switch to future gateway-read or native mount strategies once those modes exist; dependency cache reuse is disabled until cache poisoning policy, invalidation, and audit semantics are explicit.

## Deferred / Future Work

- Native FUSE or backend object-store mounts for S3, R2, GCS, Azure Blob, and Box after read-only enforcement, cache invalidation, recovery, and audit are designed.
- External writeback to Git hosting, S3, R2, GCS, Azure Blob, Box, and other domain systems under explicit required features and approval policy.
- Snapshot, restore, fork, clone, and rollback record contracts have no current owner and remain future and non-authorizing. This specification does not define their layout or slot mechanics.
- Cross-session cache reuse and cache poisoning controls.
- A UI or bundled-CLI diagnostic surface that explains why a session was reused, replaced, stale, degraded, or blocked.

## Links

- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260801-nanohost_workspace_data_boundary.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/core/agent-session.md`
- `docs/core/sandbox.md`
- `docs/core/storage.md`
- External reference: NVIDIA OpenShell Providers v2, `https://docs.nvidia.com/openshell/latest/sandboxes/providers-v2`.
