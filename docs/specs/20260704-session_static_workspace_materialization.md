---
status: Accepted
implementation: Partial
kind: concept
aspect: agent-session
---

# AgentSession Static Workspace Materialization

This specification owns the session-static workspace layout, the Turn materialization slots, and the Session compatibility key.

## Scope

Owns:

- The session-static layout, slot hygiene, source admission for the current Git path, and the Session compatibility key.

Does not own:

- Storage layout. [Storage Layout And Record Ownership](20260703-storage_layout_record_ownership.md) owns it.
- Review, apply, and recovery records. [Workspace Synchronization](20260703-workspace_synchronization.md) owns them.
- The AEP envelope. [Agent Environment Package](20260616-agent_environment_package.md) owns it.
- Vault, Git hosting, and object-store APIs. Their owners keep them.
- Runtime Epoch lifecycle and route credentials. [NanoHost Runtime](20260802-nanohost_runtime_and_transport.md) owns them.

Core: [AgentSession](../core/agent-session.md), [Sandbox](../core/sandbox.md), [Agent Supply](../core/agent-supply.md).

## Git Fetch Refusal Observation

The terminal remote fetch attempt reports bounded private subprocess facts through the [durable Git fetch explanation](20260531-worker_turn_reliability_envelope.md#durable-git-fetch-failure-explanation). Git's completed HTTP 401/403 refusal is `git_fetch_http_refused`; its source remains unattributed without separately trusted enforcement evidence. Earlier direct-fetch observations do not override the terminal advertised-ref attempt. Local object-type checks keep their existing classification. Fixed safe explanations never publish private stderr, alter credential-free Git environment rules, clean an incomplete slot or prove cleanup/storage reuse. Host-local repository diagnostics do not establish sandbox remote access.

## Persistent Working Volumes

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) separates generic retained volumes from the existing per-Turn generated input/control slots. Persistence is whole-volume and does not enumerate file kinds. Existing slot examples with `retention: session` describe execution-local materialization; writable working data is retained under its storageRef across session/Sandbox replacement. A successor never inherits old route credentials, authority, a claimed successful outcome or an unproved native handle, but may use the same authorized working bytes after predecessor fencing.

Current materialization must not recursively remove a populated retained target, run `git clean`, replace arbitrary user configuration or delete ignored files as a freshness step. New source imports use no-overwrite staging and exact lineage; a source change conflicting with retained work is surfaced before launch. Generated AEP, context, instructions, transcripts used for protocol carriage, credentials and control slots remain separate and refreshed under their existing owners. Runtime-owned files within a persistent volume are not transport spools merely because their names contain log, session or transcript.

Existing current-runtime/session records continue to own active bindings. Stable Thread-addressed data subdirectories may live within one admitted sharing group's opaque volume without changing the whole-volume retention or purge unit. Independent Threads retain separate mutable working and native-state locations; a new AgentSession id must not accidentally select an empty unrelated data root.

## Decision

Use a two-level workspace model for worker sessions.

`SessionWorkspaceLayout` is session-static. It is resolved into the AEP before worker launch and describes the stable worker-visible directory skeleton and static access envelope.

`TurnWorkspaceMaterialization` is turn-dynamic. It describes how one turn populates declared slots, what baseline was exposed, what changed, and what should be collected after the worker finishes.

`WorkspaceSlot` is the bridge. A slot is a predeclared path inside the worker environment with access, retention, allowed source kinds, allowed sync modes, lineage rules, and review behavior. Inputs do not create arbitrary new roots at turn time; they bind to slots selected by the materializer.

`SessionCompatibilityKey` decides reuse. A session may be reused for a Turn only when the session's static layout, logical-model and credential envelope, policy envelope, runtime image, working-directory posture, control endpoints, and backend capabilities cover the Turn's resolved needs and have not been revoked, drifted, or marked stale.

## Contract / Expected Behavior

### Static Versus Dynamic Fields

AgentSession-static fields include:

- runtime image, image digest, command shape, user, group, umask, base working directory, worker-shim identity, and direct control endpoint shape
- workspace root path, slot path set, slot access envelope, static filesystem policy, mount declarations, and output root declarations
- logical-model admission envelope, credential visibility and placeholder envelope, network policy envelope, Vault injection path class, and Sandbox policy artifact shape
- transcript root, audit sink setup, backend service readiness checks, and backend capability summary

Turn-dynamic fields include:

- generated task files, context package files, instruction material, helper files, user-uploaded files, and small synthetic inputs
- Git checkout, fetch, branch creation, worktree population, patch collection, and optional bundle collection inside declared worktree slots
- workspace file and directory snapshots copied, bound, uploaded, downloaded, or rsynced into declared slots
- S3, R2, GCS, Azure Blob, Box, S3 file-manifest, HTTP archive, and artifact inputs synced into declared data or input slots
- output files, artifact candidates, worker transcripts, logs, evidence bundles, `WorkerOutputManifest`, and `WorkspaceChangeSet`
- refreshed credentials and backend-private credential-materialization changes only to the extent the selected backend can make them visible to future process launches or Gateway-mediated traffic without mutating already-running process environments

### Current Source Materialization Admission

In this release, configuration operations MUST refuse unsupported Workspace roots or Agent input selections for work-slot materialization before storage with `workspace_data_source_blocked` and the message "Only credential-free remote Git sources can be materialized into a work slot in this release. Folder and other source kinds are not supported yet. Work without a source input still runs." Authored configuration remains loadable, its use retains the same late refusal, unselected catalog registration remains available, and an empty input list remains valid.

An Agent write MUST check only its own selections against current authored catalogs; a catalog write MUST check every Agent's selections against prospective catalogs after replacing the current file with the candidate: a reference with matches is refused only when none is Git with no `vaultGrantRef` and a valid credential-free HTTPS locator; a reference with no matches keeps its late resolution refusal, and an inline input without `sourceRef` is refused only on an Agent write.

### Leased Storage Projection

[File Storage And Knowledge Packages](20261018-file_storage_and_knowledge_packages.md) owns later Storage adoption and reference formats. The existing Workspace/Artifact planes admit NanoCore-mediated MCP access or a leased read-only backend subpath mounted host-side by NanoHost. Writes stage for NanoCore commit; no sandbox FUSE or direct retrieval-engine route is introduced.
Policy owns grant scope/expiry; runtime removes or fences revoked exposure without deleting retained work. Disposable running-Turn snapshots preserve current readiness proof, not historical retention copies. Context source entries now select bounded delivered projections plus exact owner/version and digest references under the shared retention owner. This rule does not change cleanup for a separately admitted full read-only input snapshot.

### Read-Only Turn Source Snapshot

For each Turn, eagerly materialize only the exact selected, currently authorized input bytes. A Context digest reference retains its bounded delivered body, excerpt or descriptor and metadata. Explicit Artifact, Material and receiving-Turn file selections also admit the complete original as a disposable running-Turn input; [Context Package](20260703-worker_context_package.md) derives the combined live inventory from existing source digests and sizes, and streams originals through the existing verified per-file transfer without retaining another Core copy. A complete derived representation is not transferred merely because its excerpt was selected. Verify current original identity and selected ranges before first acceptance under the Context owner. A separately admitted full Artifact, upload, Material or other source snapshot uses existing input slots and data-plane transfers and verifies its source revision, size and digest before readiness. Record every byte actually delivered in the exact immutable inventory through the existing Workspace Input Snapshot, Materialization Record and Context Package proof. Model-visible inventories and their pagination remain bounded under [Context Package](20260703-worker_context_package.md#bounded-model-projection). The [large-file decision](../decisions/20261015-large_files_and_model_context.md) adds no lazy hydration, host-checkout reader, or source registry.

The view is read-only and separate from retained writable work slots, scratch, and output roots. The Git-only work-slot admission above still applies; selected product files enter declared read-only input slots, not a new work-slot source kind. A running Turn retains its admitted local snapshot of the bytes actually selected. Omitted originals remain references: current on-demand reads and processing resolve the exact owner/version and captured digest, or return unavailable. Later OpenKit search, reads, downloads, history and exports recheck current access and destination disclosure. Snapshot admission does not freeze those permissions or promise retention of omitted source bytes.

Before a later Turn starts, remove or fence old input exposure and resolve current authority. A revoked snapshot cannot pass through an old mount or retained home. Preserve canonical originals and retained working bytes; cleanup owns disposable input copies only. Missing bytes, digest mismatch, stale revision, denied access, capacity exhaustion, or transfer failure prevents affected readiness without substituting current content. Restart and exact replay verify the pinned inventory and existing handoff proof; they never reconstruct an old snapshot from today's source.

Acceptance must observe bounded projection retention, usable complete live any-file delivery, exact digests, read-only isolation, unchanged delivered snapshot bytes after source change, unavailable current retrieval of a missing or changed referenced original, current-access denial on later operations and no revoked mount inheritance. A separately admitted full snapshot keeps its running-Turn invariant; this reference transition removes no bytes from that live snapshot. Names, digests, previews, snippets, counts, and diagnostics obey disclosure checks before generation access or ranking. Personal Memory never enters a Worker view.

### Git Source Materialization Boundary

A Git input for a remote Agent Runtime MUST resolve to a network-addressable repository locator and an exact accepted commit. For the first initialization of a new empty slot, the Sandbox Git client fetches that repository and checks out the commit the data source pins, reports its HEAD and tree, and NanoCore compares the reported commit id with that pin. NanoCore reads no host repository for that check. For an existing retained slot, it validates source identity and current authority, preserves tracked, untracked and ignored working bytes, and does not reset or clean the directory. A requested incompatible source/baseline requires an explicit reconciliation, not destructive reinitialization. A NanoCore host path, unpublished local commit, implicit host checkout, tar copy, or Git-bundle fallback is not an alternate source form. The decision and its reason are recorded in [a decision record](../decisions/20261002-hosting_through_gateway_mcp.md).

The first initialization of a new empty work slot completes during `session.open`, before the native runtime of that AgentSession starts. After successful `session.open` returns, NanoCore requests baseline collection and completes its acceptance before that AgentSession's first `turn.start`. [Workspace Synchronization](20260703-workspace_synchronization.md) owns that acceptance. A retained slot is never re-baselined and continues from its chain head. The expected identity comes from the materialized source. For a Git source it is the commit id the data source pins. The Sandbox Git client fetches and checks out that commit, reports its HEAD and tree, and NanoCore compares the reported commit id with the pin. NanoCore reads no host repository and does not take the expected commit id from worker-derived bytes. For another source it is the tree NanoCore derives from the bytes it materialized, using the baseline inclusion [Workspace Synchronization](20260703-workspace_synchronization.md) defines. A newly admitted work slot with no source-bound input is initialized as an empty directory, and its expected tree is the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`; the ordinary baseline acceptance of [Workspace Synchronization](20260703-workspace_synchronization.md) then applies before the first Turn. This does not baseline a retained slot that lacks an accepted pair. A capture from such a slot has an apply destination only where an existing resource owner names one; otherwise it is retained without one. For a Git source, a missing fetch or checkout, a missing reported HEAD, or a reported commit id that differs from the pin fails closed as `baseline_source_unavailable` or `baseline_mismatch` under [Workspace Synchronization](20260703-workspace_synchronization.md). Baseline initialization does not introduce object-format conversion, read a host repository, or substitute an unpinned worktree as the expected identity. A source whose expected identity cannot be derived fails closed. Baseline timing and the scan's reason are recorded in [a decision record](../decisions/20260930-first_accepted_base_by_baseline_scan.md). The Git commit-id check replaces that record's host-repository tree clause, and its reason is recorded in [a decision record](../decisions/20261002-hosting_through_gateway_mcp.md).

Workers use installed Git freely for local work inside the admitted Sandbox. Platform-managed external hosting calls use an explicitly selected vendor MCP server through NanoCore's Gateway, with gateway-held credentials and the MCP owner's authentication, current authorization, configured per-tool approval, and audit. Native Git push is optional user-space configuration requiring a user-injected credential and admitted git-receive-pack egress; OpenKit supplies no additional native-push mechanism. Separately, NanoHost's one admitted Git use is the read-only private-store scan in [NanoHost Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md), which may parse Git objects for that diff. That scan does not select repository revisions as product truth, hold Git credentials, or interpret clone, fetch, push, branch, or pull-request semantics.

Missing or unreachable repository locators, missing commits, denied egress, absent or stale grants, checkout mismatch, or a dirty state presented as a fresh initial checkout fail before Agent start without falling back to NanoCore-hosted repository bytes. Retry is a fresh materialization from the current catalog, grant, policy, and remote repository state. A partial first checkout remains visibly incomplete and cannot satisfy launch readiness. In a retained volume its bytes are preserved for explicit reconciliation rather than automatically deleted; they never become accepted source or product authority.

If a requested change touches a session-static field and the backend cannot apply it safely in place, NanoCore MUST mark the session stale for that turn and launch a replacement session.

### SessionWorkspaceLayout

`SessionWorkspaceLayout` is the admitted layout artifact in `packages/config-schema/src/session-workspace.ts`. That schema owns the slot fields, slot kinds, and write-back modes.

Rules:

- Slot paths MUST be absolute inside the worker environment or relative to the declared workspace root before backend materialization.
- Slot paths MUST NOT overlap in a way that lets a writable slot mutate a read-only slot.
- Slots MUST declare access, retention, allowed source kinds, allowed materialization modes, and write-back behavior.
- A turn input MUST bind to an existing compatible slot, or the materializer MUST fail before launch or choose a replacement session with a compatible layout.
- Slot declarations MUST NOT contain raw host paths, raw provider handles, raw object-store credentials, container IDs, VM IDs, OpenShell sandbox IDs, or backend upload handles.
- Slot IDs are OpenKit IDs for product lineage. Backend-native mount names, upload handles, gateway paths, and file-transfer handles belong only in backend-private materialization records and redacted evidence.

### Default Directory Skeleton

The fixed OpenShell Worker layout follows the work-slot and retained-volume owners below. A reusable layout uses one shared base with workspace-policy overlays. An agent-family variant exists only when static requirements diverge.

```text
/workspace/                                   whole retained volume
  worktrees/
    <workSlotRef>/                            admitted retained working slot
  threads/
    <thread-id>/data/                         private declared data slot
  shared-working/                             optional retained non-canonical work
/sandbox/                                     whole retained home volume
/openkit/                                     disposable control root
  sessions/
    <agent-session-id>/
      inputs/
      outputs/
      scratch/
      context/
      instructions/
      control/
  threads/                                    separate retained volume
    <thread-id>/<runtime>/
      native/                                 retained native state
      capture/<turn-id>/                       retained Turn transcript capture
```

The fixed image's worker working directory is its admitted `/workspace/worktrees/<workSlotRef>` slot under [NanoHost Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md).

Agents should receive the active root for the current turn as context, such as `/workspace/worktrees/<workSlotRef>`, instead of baking a repository path into the session's base working directory.

Backends MAY use different concrete paths when required, but the AEP and materialization records MUST expose a stable OpenKit path summary and preserve slot identity. The fixed OpenShell Worker image uses such paths: [NanoHost Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md) places `main-worktree` at `/workspace/worktrees/<workSlotRef>` and uses that path as the runtime working directory, and [Persistent Worker Volumes](20260910-persistent_worker_volumes.md) retains `/openkit/threads`, which holds Turn transcript capture; those later owners decide that realization.

### AgentSession Namespaces And Turn Slots

One shared Sandbox may contain multiple open AgentSessions, with separately addressed mutable working slots and exact disposable input/control namespaces. This is Workspace-write isolation, not security and adjudication isolation. A disposable namespace remains bound to its exact AgentSession and is never inherited. Retained working/native data is separately addressed by stable Thread identity; an authorized successor may reuse it after predecessor fencing. A new related Thread may explicitly select a prior idle working slot through whole-volume reuse admission, but compatible placement alone cannot transfer it and concurrent Threads cannot own the same writable slot.

The shared immutable baseline and proved immutable or content-addressed read-only caches may be projected into more than one AgentSession namespace. No shared writable canonical Workspace tree is permitted. Filesystem namespacing under one OS identity proves Workspace-write isolation only; it is not security and adjudication isolation, and work requiring that stronger boundary uses proved OS isolation or a separate Sandbox.

AgentSession-persistent slots may retain a proved private worktree baseline and verified large-input views across sequential Turns in the same AgentSession. Turn-scoped slots include generated instructions, Context Package files, request inputs, output staging, route bindings, temporary credentials, transcript spools, and other request-specific material. Each new Turn replaces or clears those slots before `turn.start`, even when the same native conversation is reused. The temporary-credentials example in that list is not a per-Turn route token placed in the resident environment. Session credential lifetime stays with the runtime and continuity owners.

After Sandbox and Harness readiness and exact Core AgentSession admission, the existing fixed import helper prepares the AgentSession-private initial input namespace. `session.open` preserves those verified inputs, initializes a new empty work slot from the admitted initial AEP before starting its native runtime, and creates the private adapter binding. Missing or unproved initial inputs refuse open before native runtime start; they do not defer initialization to `turn.start`. Slot contents update only through the owning materializer. Exact `session.close` removes only its disposable input/control namespace after output, transcript, evidence, route-revocation, and local-cleanup barriers settle; retained data volumes and native-data directories survive; cleanup uncertainty drains admission and widens the fence to the Harness, Sandbox, or Runtime Epoch boundary whose complete effects can be proved. Restart may adopt only the exact surviving AgentSession binding and namespace under current proof; otherwise later work receives a fresh control namespace through admission while its authorized retained volume remains available as working data.

Missing, overlapping, stale, cross-boundary, access-widening, or dependency-failed slot declarations block materialization. Sequential reuse by the same binding requires completed snapshot-chain collection, exact lineage, safe Turn-slot hygiene, current authority, and a proved non-destructive input transition. A surviving background writer and an `unstable` link do not by themselves require private-worktree or AgentSession replacement. Writer fencing remains required before a successor attaches the volume, and before any materialization mutation that would otherwise race a writer. The materializer never resets or overwrites retained work to satisfy freshness. A retained baseline whose identity, output collection, Turn-slot clearing, delta safety, or current authorization cannot be proved still makes the AgentSession stale and requires private-worktree replacement or AgentSession replacement. The materializer never reports an unproved dirty tree as a verified clean source baseline. It preserves such bytes for inspection or explicit continued work under the persistent-volume contract, without automatically accepting prior output or replaying an uncertain effect.

Observable acceptance requires two open AgentSessions in one Sandbox to expose distinct mutable, context, transcript, control, and output namespaces; two sequential Turns in one AgentSession to reuse permitted persistent content while receiving empty or replaced Turn slots; an exact local close to preserve a compatible sibling; and an unprovable local cleanup to fence the wider boundary before reuse or capacity return. A background writer that continues across two sequential Turns on the same binding does not force worktree or binding replacement. Collection still runs at the Turn boundary and is flagged `unstable` when the two scans differ, and disposable Turn slots are still cleared or replaced before the next `turn.start`.

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

When any output is a workspace change candidate, [Workspace Synchronization](20260703-workspace_synchronization.md) produces the `WorkspaceChangeSet` from its accepted scan and classifies the `WorkerOutputManifest` from that result. This specification does not keep an in-Sandbox capture.

For a NanoHost file export, an AEP output declaration supplies only the output id, slot-relative path, registration posture, and retention. NanoHost computes the actual digest and length while collecting the exact regular file, and NanoCore verifies and atomically stages those bytes before a canonical owner classifies them. A `WorkspaceChangeSet` is not born from that export. It is born from the read-only snapshot chain in [Workspace Synchronization](20260703-workspace_synchronization.md), which [Runtime](../core/runtime-model.md) places outside the Sandbox at Turn end, at AgentSession release, and before a successor uses the same work volume, without stopping the worker and without a terminal process-group barrier. A `file.export` that remains keeps its own barrier under [NanoHost Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md), and that barrier is accepted `final_status`, not process-group absence. Collection completion is the next-Turn gate.

The control plane MAY announce materialization and collection readiness, but large file payloads, patches, bundles, logs, and artifacts MUST move through backend data transport. The NanoHost V1 projection uses one distinct fixed file-data stream on the same authoritative outer physical HTTP/2 connection, never a control, readiness, worker-control, inference, or capability stream.

### Source Kind Mapping

Endpoint-bearing sources in this table are resolved through workspace data source catalog references per `docs/specs/20260704-workspace_data_source_catalog.md`; the manifest carries a `sourceRef` plus narrowing, and the catalog entry supplies the locator, access class, sensitivity, and vault grant reference. Source ids flow into materialization lineage.

| Authored input | Source kind | Default slot | First strategy |
| --- | --- | --- | --- |
| Small synthetic file | `generated` | `context`, `instructions`, or `input` | Write generated content into the slot before turn start. |
| Helper directory | `generated` or `workspace-dir` | `input` | Copy or upload into a read-only input slot. |
| Local file | `workspace-file` | `input` | Validate workspace-relative ref, then bind, copy, upload, or rsync. |
| Local directory | `workspace-dir` | `input`, `data`, or `worktree` | Validate workspace-relative ref, then bind locally or upload/rsync remotely. |
| Git repository | `git` | `worktree` | Clone or fetch the requested ref. The patch or bundle is the outside scan's result, reviewed before apply. |
| S3 prefix | `s3` | `data` | S3-compatible staged sync into a data slot. |
| R2 prefix | `r2` | `data` | S3-compatible staged sync with R2 endpoint and provider profile. |
| GCS prefix | `gcs` | `data` | Provider-specific sync into a data slot. |
| Azure Blob prefix | `azure-blob` | `data` | Provider-specific sync into a data slot. |
| Box folder or file | `box` | `data` or `input` | Provider file sync or gateway read; do not present Box as POSIX unless a backend capability proves it. |
| S3 file manifest | `s3-files` | `data` | Sync exactly the listed objects and record object digests. |
| Prior OpenKit artifact | `openkit-artifact` | `artifact-input` | Copy or upload artifact bytes with artifact lineage. |
| Prior turn upload | `openkit-upload` | `input` | Copy or upload the attachment bytes by file id with digest verification and turn lineage; no knowledge governance required. |
| Output directory | `generated` | `output` | Create empty before turn start, collect on turn end. |

### Dedicated Context Package Binding

The [Context Package](20260703-worker_context_package.md) accepted worker-Turn trace reuses the existing `generated` source kind and the existing `context` slot. Its one dedicated AEP workspace input is the exact tuple: `kind=generated`, `source.kind=generated`, `target` equal to `SessionWorkspaceLayout.control.contextRoot`, `access=read-only`, and `materialization.slotId=context`. The selected slot MUST have `id=context`, `kind=context`, `path` equal to that control root and input target, `access=read-only`, `allowedSourceKinds` containing `generated`, `writeBack=discard`, and a local `copy` or remote `upload` mode supported by the selected backend.

The session workspace planner MUST bind this exact input to the `context` slot before applying the general generated-input default; it MUST NOT route it to `turn-inputs`, infer a new slot from its path, or create a context-specific source adapter. Every other generated input continues through the existing authored mapping. The WIS, WMR, package-root digest, backend handoff, and ready predicate remain owned by [Context Package](20260703-worker_context_package.md) and reuse the existing Turn materialization records without a new status or lifecycle.

For a NanoHost on another host, the prepared immutable package root is named `context_<turnId>` and `WorkerContextPackageFiles` supplies the exact bytes plus the sorted `fileInventory` of package-relative path, byte length, and content digest. The backend matches that generated AEP input to NanoCore-private `workspaceRoots`, recomputes the sorted regular-file inventory and package-root digest, and issues exactly one `reference.import` per inventory entry after exact session admission and canonical AEP import, and before `turn.start`. A source path, host path, archive, adjacent or mutable locator, and every other source kind remain private and never cross the wire.

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

OpenShell upload, download, exec, policy, provider, and log outputs are backend evidence and transport effects. For the NanoHost V1 projection, each Context Package inventory entry is imported after bridge readiness, exact AgentSession admission, and canonical AEP import, but before `turn.start`, each declared output is exported only after accepted `final_status`, and verified bytes enter an existing canonical collection owner before bridge close and sandbox delete. None is product truth until NanoCore performs that canonical handoff.

### SessionCompatibilityKey

`SessionCompatibilityKey` is a deterministic digest over the session-static envelope that matters for safe reuse.

The decision and its reason are recorded in [a decision record](../decisions/20260930-native_environment_managed_outside_the_sandbox.md).

The static key includes the canonical resolved public native environment and its verified image/default identity, but never raw Vault values; equivalent maps with different authoring order have the same environment contribution. Metadata planning and final launch use the same already verified inputs, and stale image/configuration evidence fails revalidation rather than changing the key after admission.

The base digest inputs are the agent, the backend, session-static control, the complete layout, policy, runtime, and vault. An absent top-level optional component is null. Network policy, credential visibility, and the permission digest enter through policy, vault, or layout when those owners supply them. They are not separate members of the base tuple. [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md) owns canonical JSON and SHA-256. This base digest is a named exception. It is `sha256:` plus the SHA-256 hex of a local stable JSON encoding. Object keys are sorted by UTF-16 code unit. Undefined object members are dropped. Array order is kept. An undefined or null scalar becomes null. The Session key that admission uses wraps that base digest with the sorted admitted logical-model ids. That wrapper is a second named exception. It is `sha256:` plus the SHA-256 hex of JSON text whose keys are `sessionWorkspaceKey` and then `allowedLogicalModelIds`, in that order. Canonical JSON would sort those keys the other way. This specification does not recompute either value. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns the physical Sandbox key and the [#735](https://github.com/lingkaix/openkit/issues/735) member gap. The key MUST NOT include raw secret values, raw host paths, backend-native handles, upload IDs, sandbox IDs, object-store credentials, or current turn payload digests. Cross-session dependency cache reuse is not admitted ([#397](https://github.com/lingkaix/openkit/issues/397)).

A session can be reused when:

- the requested Turn's V1 `SessionCompatibilityKey` exactly equals the AgentSession's recorded key
- the session's provider, vault, permission, and policy grants are still active
- the session has not been marked stale by config reload, provider revocation, backend drift, failed conformance, or unsupported required feature
- the requested turn can bind all inputs to declared slots without path overlap or access escalation
- the AgentSession is idle

If reuse fails because the session is incompatible, NanoCore SHOULD create a replacement AgentSession with a compatible layout rather than widening the existing AgentSession silently. Superset-compatible reuse remains deferred and is not inferred from a broader envelope.

### Concurrency And Slot Hygiene

Each AgentSession supports exactly one active Turn. Turn-scoped slots (`input`, `output`, and any slot with `retention: turn`) are single-occupant by design, and the [durable scheduler](20260703-durable_scheduler_design.md#attempt-reconnect-and-cleanup) permits at most one non-closed execution attempt per AgentSession. Concurrent Turns in one AgentSession are not authorized.

Separately, one Harness may hold multiple open AgentSessions for distinct Threads and may execute one Turn in each such AgentSession concurrently up to its declared capacity. Runtime-native child agents remain inside one outer AgentSession and do not create additional slots or Core AgentSession identities. Several compatibility-keyed Harness Instances may share one Sandbox under the runtime and Sandbox owners; this specification neither selects a Harness nor grants capacity beyond those owners.

Every automatically cleared input, output, transcript, evidence or scratch slot MUST be physically outside retained volumes, under the disposable `/openkit` root in this realization. Reject a layout that assigns automatic cleanup beneath a retained mount. Immutable Turn-input slots, including the canonical AEP and Context Package, MUST be cleared before reuse by the next Turn, including while the same AgentSession binding remains. That clear does not wait for process-group absence and is not the workspace-collection gate. Output, transcript, and evidence slots with `retention: turn` MUST be cleared only after their contents are collected. Collecting those contents does not wait for process exit or process-group absence. If clearing fails, the AgentSession MUST be marked stale for reuse so prior-Turn contents cannot leak into the next Turn; a stale-for-hygiene AgentSession is replaced, not silently reused. Cleanup uncertainty follows the wider-fence rule in AgentSession Namespaces And Turn Slots. `retention: session` contents persist across Turns within that AgentSession; `retention: policy` contents follow Workspace policy.

### Non-canonical Shared Working Material

The Sandbox may expose one non-canonical shared working area for research notes, cloned references, intermediate datasets and unfinished work. Under `/workspace/shared-working` it belongs to the whole retained volume and survives Sandbox replacement under the persistent-volume owner. Its internal organization and unknown file formats remain unspecified; it creates no separate Core record family, retention class or evidence store.

The area is intentionally cross-readable by admitted co-residents. New related work receives it only through current whole-volume audience admission; it is not a private slot or independent-adjudication environment. Workers may modify it through ordinary granted access. Its content confers no authority, completion proof or verified evidence. Publication into Core-owned canonical Workspace data uses the ordinary staged, reviewed, conflict-checked apply path; platform-managed external Git hosting uses the selected Gateway MCP owner.

Creation, attachment, retry, recovery and purge follow the containing storageRef. Missing retained bytes are reported without automatic empty replacement; stale content must be inspected as working data rather than assumed current. Observable acceptance requires rebuild to preserve unknown bytes without changing product truth, cross-AgentSession reads to confer no authority, and every canonical exit to pass through the owning review/apply boundary. A separately declared disposable scratch area may be discarded, but it must be outside the retained mount and cannot be substituted for this area.

### Write-Back Policy

Workers do not directly write Core-owned source-of-truth data. Platform-managed external Git hosting effects use selected Gateway MCP authority. Native Git push remains optional user-space configuration requiring a user-injected credential and admitted git-receive-pack egress; OpenKit adds no native-push mechanism.

`packages/config-schema/src/session-workspace.ts` owns the write-back modes. `discard` ignores slot changes after the Turn except for restricted evidence when policy retains it. `artifact-only` collects outputs as artifacts and does not mutate workspace sources. `reviewed-change-set` stages a workspace review and requires approval before apply. `artifact-or-reviewed-change-set` classifies outputs as artifacts, workspace changes, or both during import. `external-writeback` requires its own required feature, permission decision, audit, and review policy. Selected Gateway MCP hosting is already governed by [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) and is not slot external-writeback.

### Provider And Credential Rules

Provider access should be included in the session-static envelope when the long-running worker process needs process-visible placeholders or provider-derived network policy.

The currently admitted MCP plane uses `capability.local` through `/capabilities/*` with authority distinct from inference and control. Worker-local `inference.local` remains turn-dynamic through `/inference/*` with its own inference credential. Selected MCP supply enables the managed capability routes that [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) owns. That path is not a host-side mount. Host mounts and unsupported data strategies stay with their source and materialization owners. The accepted stock `ForwardTcp`/`RelayStream` pair and nested standard HTTP/2 target remain the current worker-control and inference bindings.

If a provider is attached after sandbox start, NanoCore MUST distinguish future policy availability from live process environment availability.

If a credential or grant is revoked, expires, or loses permission while a session is idle or running, NanoCore MUST block further use and the NanoHost MUST terminate the affected sandbox. If deletion cannot be proved, the complete Runtime Epoch is invalidated and capacity remains fenced until fresh-empty readiness; cleanup does not prove recall.

### Record Ownership

`SessionWorkspaceLayout` and `SessionCompatibilityKey` belong to the AEP snapshot and AgentSession runtime metadata.

`TurnWorkspaceMaterialization`, input snapshots, materialization records, backend handles, output manifests, change sets, staged reviews, apply plans, apply results, and reconciliation records belong to workspace synchronization storage.

Backend-native file-transfer handles, upload IDs, sandbox IDs, container paths outside the worker-visible summary, object-store temporary keys, provider-native request IDs, and gateway state are evidence or backend-private runtime metadata, not public product identity.

## Decision Completeness

The definition and exclusions for AgentSession-static layout, per-AgentSession namespaces, Turn-scoped hygiene, and non-canonical shared working material are stated above. The AEP snapshot owns the durable layout and compatibility projection, workspace synchronization owns Turn materialization and canonical handoff records, and the runtime owns only physical namespaces, bytes, and cleanup effects; no backend path or shared material becomes Workspace truth.

Creation, update, termination, retry, recovery, conflict, missing, stale, restart, and dependency-failure behavior is stated in the namespace, hygiene, write-back, credential, and shared-working-material sections. Retry after replacement is fresh admission rather than reuse of a failed materialization effect. Observable acceptance is the conjunction of namespace isolation, Turn-slot clearing, exact compatible reuse or replacement, staged apply, sibling-preserving local cleanup, and fail-closed wider fencing. The retained shared area delegates its durable lifecycle to its containing storageRef; disposable control has no independent durable lifecycle.

## Accepted Design

The planner in `packages/config-schema/src/session-workspace.ts` takes resolved AEP workspace input declarations and backend capability declarations and returns `SessionWorkspaceMaterializationPlan`. That admitted artifact contains the compatibility key, the reuse or replacement decision, the layout, and the materialization that binds each input to a slot.

The planner is backend-portable.

Backend adapters implement only transport and enforcement effects:

- local container adapter: bind, copy, local checkout, local staging, and direct output collection
- OpenShell adapter: Sandbox create, credential injection, policy materialization, upload, download, exec, log collection, and evidence import
- remote container adapter: tar, rsync, remote checkout, object-store staging, backend upload, output download, and recovery handle persistence
- managed sandbox adapter: provider file APIs and provider workspace manifest APIs when supported

Source adapters normalize source-specific listing and digest behavior:

- Git adapter resolves refs and base commits
- S3-compatible adapter covers AWS S3, R2, and compatible endpoints
- GCS and Azure adapters normalize object metadata and digest evidence
- Box adapter normalizes folder and file listings without claiming POSIX mount behavior
- generated adapter writes task and helper files from NanoCore records
- artifact adapter resolves prior artifact bytes with lineage

## Acceptance

A long-lived session runs at least two Turns with different input contents in the same slot without remounting.
A Turn that needs a new static provider or path envelope creates a replacement session.
The replacement states that reason.

## Implementation

- `packages/config-schema/src/`
- `apps/nanocore/src/runtime/`
- `apps/nanocore/src/config/`

## Implementation Gaps

- A collection plan for outputs, transcripts, evidence, and workspace changes is returned with the materialization plan - the admitted SessionWorkspaceMaterializationPlan has no collection member - #777
- A captured candidate is staged as a change set - On main, the staging helper has no production caller - #495
- Local and remote container materialization bind, copy, tar, or rsync into declared slots - On main, product execution is NanoHost and OpenShell only and those adapters are not selectable - #777
- A leased read-only backend subpath is mounted host-side - On main, that mount is not implemented - #272
- A managed-sandbox adapter uses the provider file and workspace manifest APIs - On main, product execution admits OpenShell metadata planning only - #777
- S3, R2, GCS, Azure, and Box source adapters normalize listing and digest evidence - On main, a work slot admits credential-free Git only - #777

## Decisions

- [Native environment managed outside the Sandbox](../decisions/20260930-native_environment_managed_outside_the_sandbox.md)
