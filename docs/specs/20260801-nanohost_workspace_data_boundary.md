---
status: Accepted
implementation: Not Started
kind: boundary
date: 2026-08-01
updated: 2026-09-30
---
# NanoHost Workspace Data Boundary

## Retained Volume Boundary

[Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns opaque durable storage associations, inherited image mount layouts, generic whole-volume retention and replacement. This specification retains byte-transfer and product-acceptance ownership. Retained volumes are neither a source mirror nor an operation journal; NanoCore owns association/attachment authority and the execution host retains the bytes. The earlier disposable-only classification no longer applies to these declared volumes. Export of a candidate or required evidence still uses the existing bounded transfer owners; persistence does not expand those transport limits or turn NanoCore into bulk storage.

## Owns

- The separation between NanoCore durable product authority and one independently deployed NanoHost that performs already-authorized worker execution.
- The logical boundary between canonical OpenKit storage, NanoHost-local disposable materialization, native data-system authority, and non-authoritative byte transfer.
- The use of exact remote Git commits, Artifact versions, and external object versions or digests as cross-boundary inputs and outputs.
- The direction of input materialization, output collection, Artifact review, Workspace synchronization review, and later-Turn handoff.
- The import-only non-workspace `package-config` and `worker-supply` identities, their AgentSession-private destinations, and AEP-first ordering before resource files, Context Package imports, and `turn.start` after exact session admission.
- The byte, integrity, bound, one-stream, failure, and no-refetch contract for the exact inline Dockerfile carried through the existing fixed file-data reservation before one `image.build` effect.
- The data-boundary consequences of the current small-deployment profile, whose canonical statement of process, writer, target, and slot counts is owned by `docs/specs/20260703-runtime_scheduling_scale.md`.

## Does Not Own

- NanoHost identity, NanoHost credentials, claim authentication, NanoCore-to-NanoHost transport, reconnect, predecessor fencing, route namespaces, route tokens, or the transport envelope.
- The canonical process, writer, target, or slot counts of the deployment profile, the configured container backend, the NanoHost Image Store, image acquisition or build execution, or sandbox image content.
- Runtime Epoch composition, OpenShell lifecycle, Gateway or container-runtime management, OS supervision, readiness, sandbox create or delete, uncertain cleanup, restart, or recovery.
- Worker-control messages, inference routes, capability routes, Agent Environment Package contents, scheduler records, SessionLease lifecycle, or exact claim replay.
- Core Workspace, Thread, Turn, Item, AgentSession, Artifact, Material, Review, storage, permission, Vault, audit, capability, or sandbox semantics.
- Native Git merge behavior, object-store consistency, rsync or Mutagen algorithms, or transfer implementation details beyond the exact V1 fixed file-data carriages selected here.
- A shared writable filesystem, generic synchronization service, automatic merge or rebase engine, direct sandbox-to-sandbox data path, or universal Artifact abstraction.
- Dynamic NanoHost placement, fleet discovery, autoscaling, multiple active worker slots, multi-cloud routing, session migration, or high availability.

Runtime lifecycle and communication are owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`. This specification MUST NOT be used as authority for a Cell, general SSH transport, Gateway forward, direct worker endpoint, Runtime Epoch, readiness, cleanup, or transport implementation; it owns only the byte, path, integrity, admission, and non-authority contract of the exact V1 single-file effects carried by that runtime owner's selected stock RPC and the exact Dockerfile response carried by the same outer file-data reservation.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/storage.md`
- `docs/core/sandbox.md`
- `docs/core/permissions.md`
- `docs/core/agent-capability.md`
- `docs/core/vault.md`
- `docs/core/audit.md`
- `docs/core/communication.md`

## Related Specifications

- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260713-work_resource_interaction_model.md`
- `docs/specs/20260715-multi_user_workspace_system.md`

## Summary

OpenKit separates worker execution from the durable product and data authority required to authorize, observe, review, and publish that execution.

`Execution Host` is the generic deployment role; `NanoHost` is OpenKit's sole concrete product and current implementation of that role.

This specification is the data-boundary projection of the substrate doctrine owned by `docs/core/runtime-model.md`. `Move bytes, not truth` is the rule this document exists to realize, and `push work down, not authority` is why a NanoHost may hold every materialization without owning any of them. Those rules are read from their Core owner and MUST NOT be restated here.

NanoCore remains the only durable authority for Workspace, Thread, Turn, Item, AgentSession, scheduler, permission, Vault, audit, review, and canonical OpenKit storage. One configured NanoHost performs already-authorized runtime effects and holds generic retained working volumes under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md), separately from disposable materializations, caches, scratch state, transient transfer buffers and backend-private evidence.

The separation is logical first. It does not require a third storage service, shared writable filesystem, general file-synchronization engine, or new universal data record. Native systems retain their own authority: Git owns commits and repository merge behavior; a specifically accepted object-store contract owns its object bytes and version preconditions; OpenKit Artifact, Material, and Workspace synchronization owners retain product review and apply authority.

Data crosses the boundary through exact immutable references and bounded owner-specific transfer. A new imported source receives an exact reviewed Artifact version, remote Git commit or external object version through governed materialization. Continued work may reuse its authorized retained volume without resetting arbitrary working bytes; that reuse is not acceptance of those bytes as an imported source version. Running sandboxes do not synchronize directly with each other and do not write canonical Workspace state.

Large bytes remain outside NanoCore-to-NanoHost control, readiness, and semantic-route streams. Native transfer paths carry their own bytes, while the exact V1 single-file effects, the `workspace.collect` result, and the fixed Dockerfile input use one distinct fixed file-data stream on the same authoritative physical HTTP/2 connection; sharing that connection grants the data stream no control semantics or authority.

The current release runs the small-deployment profile whose canonical counts are stated by `docs/specs/20260703-runtime_scheduling_scale.md`, together with the single-backend boundary owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`. This specification depends on both boundaries rather than restating either, because they are what prevents a data-separation design from silently becoming a fleet, collaboration, or multi-writer platform.

## Goals / Non-goals

### Goals

- Let NanoCore and execution infrastructure be placed, sized, replaced, and operated independently without changing product authority.
- Keep one durable attempt identity across authorization, execution, output collection, review, and terminal projection through existing owners.
- Materialize immutable inputs into a disposable NanoHost-local environment and return exact reviewable output.
- Reuse Git for repository history and merge behavior rather than duplicating it in OpenKit. The private index and object store exist to diff the attached volume. They are not a second repository, not product history, and not a duplicate of Git merge authority.
- Reuse existing Artifact versions and reviews for inspectable product-level handoff between Turns.
- Reuse existing Material and Workspace synchronization owners when output may mutate canonical Workspace state.
- Require external object storage when static source data exceeds the accepted bounded NanoCore record, upload, Artifact, evidence, or handoff owner instead of expanding NanoCore into bulk storage.
- Keep transfer tools as byte movers with no product, version, review, merge, or publication authority. The snapshot-chain scan is not a transfer session. The byte-mover rule for transfer tools stays.
- Preserve truthful missing, stale, conflict, interruption, and unknown outcomes without automatic merge or replay.

### Non-goals

- Do not build a shared writable Workspace filesystem, distributed filesystem, CRDT, operational transformation layer, or general collaboration substrate.
- Do not implement bidirectional synchronization between running sandboxes and canonical storage.
- Do not let NanoHost execute Git or hosting operations except the one read-only private-store scan stated below. A worker may push or create a pull request only through the Git source, permission, approval, Vault, and network-policy owners; that action never gains authority from this data boundary.
- Do not make Artifact a universal file, repository, object-store, Material, or Workspace identity.
- Do not invent object-store consistency or conditional-write guarantees from the label `S3-compatible`.
- Do not move live process memory, provider sessions, tool state, hidden sandbox state, or agent-private memory between NanoHosts.
- Do not add a second NanoHost, second active slot, second backend, dynamic placement, automatic failover, or fleet-shaped schema.
- Do not place large data on control, readiness, or semantic-route streams or allow a data path to carry execution-control semantics.

## Definitions And Authority Classes

### NanoCore Durable Authority

The NanoCore Durable Authority is the existing set of durable owners for product state, work authorization, scheduling, permission, Vault grants, audit, review, Workspace truth, Artifact identity, and canonical storage.

NanoCore decides which exact attempt may run and records that authority before external execution effects. It does not become a byte store for every native source and does not gain authority over native Git or object-store semantics merely because it records a reference.

### NanoHost

The configured `RuntimeTarget` projects one NanoHost, which performs already-authorized execution as OpenKit's concrete Execution Host. NanoHost identity, Runtime Epoch, configured container backend, image store and acquisition, transport, transport envelope, lifecycle, evidence, and failure behavior belong to `docs/specs/20260802-nanohost_runtime_and_transport.md`.

The NanoHost is trusted to materialize exact bounded owner-declared files and collect exact outputs, but it is not a product Agent, scheduler, permission owner, Workspace owner, review owner, storage authority, workflow engine, or general job runner. Its one admitted Git use is the read-only private-store scan below. That use may parse Git objects for the diff. NanoHost still does not select repository revisions as product truth, hold Git credentials, or interpret clone, fetch, push, branch, or pull-request semantics. Hosting clients that push or open pull requests stay with the worker and the Git source owners. Collecting exact outputs includes returning the scan result to Workspace synchronization. It also does not normalize collected output into product records and does not accept them; those are separate jobs with separate owners under `docs/specs/20260629-worker_runtime_communication_model.md`.

### Canonical OpenKit Storage

Canonical OpenKit storage contains durable Workspace, Thread, Turn, Item, Artifact, Material, review, policy, audit, scheduler, and related product truth under their existing owners.

Only an existing owner may create or mutate those records. A NanoHost report, transfer completion, local path, backend handle, or native source observation does not become canonical merely because NanoCore receives it.

### NanoHost-Local Runtime Storage

NanoHost-local runtime storage contains disposable materializations, caches, scratch files, temporary bundles, transcripts awaiting accepted transfer, backend state, and process-local evidence. The caches it may hold are caches of content it retrieved or produced, never of authority it was granted.

It is not canonical Workspace, Artifact, Material, knowledge, review, or work history. Only explicitly disposable runtime storage may be discarded by AgentSession or Runtime Epoch cleanup. The separately owned retained volumes survive those events in full, including unknown and ignored contents, without becoming product truth. Required product evidence still crosses the existing accepted import boundary; persistence alone is not evidence acceptance.

### Native Data Systems

Native data systems include Git repositories, specifically accepted object stores, uploads, provider file systems, and other sources selected by an existing Workspace data-source contract.

Git remains authoritative for commits, refs, ancestry, patches, merge behavior, and repository conflicts. An object store remains authoritative only for the byte, version, checksum, retention, and conditional behavior explicitly guaranteed by its accepted source contract.

OpenKit records the exact reference and lineage used by one attempt, but it does not duplicate the native system's internal semantics.

### Excluded: Sandbox Image Content

Sandbox image content is not Workspace data, not a Workspace data source, not Material, not an Artifact, and not a cross-boundary product input under this specification. Retrieving image content from a declared registry, building it from an authorized build definition, storing it, and importing it into an epoch are NanoHost-local runtime concerns owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`, and image content authority remains with the image owners.

The only property this specification requires of image content is the one it requires of every cross-boundary input: by the time a worker consumes the bytes, they are identified by an exact immutable digest. How an authored reference reaches that digest, and which reference forms an author may use, belong to the image and manifest owners; resolution to a digest happens at the runtime owner's acquisition boundary.

### Transfer Mechanisms

Transfer mechanisms include bounded HTTP upload or download, OpenShell file transfer, tar, Git native transfer, rsync, and a narrowly accepted deployment-managed Mutagen session.

They own byte movement only. A transfer session, local path, watcher history, endpoint precedence, retry cursor, archive, temporary URL, backend handle, or the private scan store MUST NOT become product identity, version authority, Workspace truth, review evidence by itself, or conflict winner.

### Read-Only Private-Store Scan

NanoHost's one admitted Git use is a read-only scan of the attached work volume from outside the Sandbox. It runs a pinned Git with its own `GIT_DIR` and the retained volume as the work tree. That Git is the host command [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) pins. Every invocation uses the private store as its repository and never uses the worker repository as its discovered repository. No worker-controlled configuration, hooks, attributes, filters, or drivers apply, and blobs are hashed byte-exact without filters. The scan's snapshot reference is the pair [Workspace Synchronization](20260703-workspace_synchronization.md) defines, the Git tree object and the Git blob of the canonical full-permission manifest, and the worktree `HEAD` commit is context only. Both modes use the shared path admission owned by [Workspace Synchronization](20260703-workspace_synchronization.md); capture additionally applies that owner's untracked-ignore rule, while baseline does not apply ignore exclusions. The scan does not push, fetch in order to select a product revision, branch, merge, rebase, or open a pull request, and it does not hold Git credentials. Parsing Git objects for that diff is part of the admitted use. The decision and its reason are recorded in [a decision record](../decisions/20260930-workspace_collection_is_a_snapshot_chain.md).

The private store is not canonical storage, not a retained volume, not a transfer session, not product identity, not the rejected shared writable filesystem, and not the deferred external object-store adapter. It sits beside the persistent volume, outside the bind-mounted worktree and outside the worker `.git`, and it survives NanoHost restart and epoch replacement. NanoHost initializes it with object format SHA-1 rather than a host Git default. An object id in that store is exactly 40 lowercase hexadecimal characters. The transport SHA-256 digest of a candidate body is not an object id. It retains the tree and the manifest blob of Core's accepted base and of the current head until Core names a later head or base in a collection command. The manifest blob is retained and pruned with its tree. Snapshot protection is published durably as a complete selection before any superseded protection is removed. An interrupted or failed publication preserves the last complete protected tree-and-manifest pairs. A partially copied object is not an available object. Reopening never treats a partial protection selection as a new Core cursor or an accepted base. Cleanup and capacity failure preserve Core-required pairs and report failure rather than a successful retention transition. Objects of an unrecorded attempt, including that attempt's tree and manifest blob, are pruned by the next recorded link, and that pruning does not remove or overwrite a retained manifest. It is not placed in an epoch run root. The scan reads the work volume. The collection command carries the work slot. The scan does not read `/openkit/session`, and change-set birth does not move back onto that directory.

The scan is not `file.export`. A per-Turn `file.export` starts after NanoCore accepts that Turn's `final_status`, which [Worker Control Protocol](20260703-worker_control_protocol.md) defines as sealing the Turn's transcript, provenance, and artifact output, and it does not wait for process-group absence. Collection completion is the next-Turn gate, not that export barrier. Process and Harness termination proof stays on operations that end the Harness or the Sandbox. `workspace-changes.json` is removed and is not an export, so it is not a preselected `optional` path. The `optional` mechanism remains for an owner that defines absence as valid. NanoHost returns the `workspace.collect` result defined in Large-Data And Control-Transport Boundary to [Workspace Synchronization](20260703-workspace_synchronization.md). It does not write `WorkspaceChangeSet`, normalize the scan into a product record, or accept the bytes. A chain head that is not a commit does not become a ref in the worker repository or in the linked repository. Git remains authoritative for commits, refs, ancestry, patches, merge behavior, and repository conflicts.

NanoHost runs the credential comparison over the complete selected source byte set and follows the hit, retained-content disposition, and restart rules owned by [Workspace Synchronization, Snapshot Chain](20260703-workspace_synchronization.md#snapshot-chain), using the runtime-env values and the two loopback credential digests the collection command carries. NanoHost never persists or logs the runtime-env values. The carriage contract below references that same comparison and byte set. NanoHost does not substitute a current value or skip a value. Injected credential values are not otherwise an input to the scan.

The scan runs at the collection points Workspace synchronization states, including while the worker process remains. Volume reuse waits for the collection point that specification requires. That wait does not give NanoHost authority to dispatch or complete a Turn. For capture, disagreement across the two scans is recorded under the `unstable` rules owned by Workspace Synchronization; for baseline, disagreement returns `recovery_required` with cause `baseline_unstable` and no snapshot pair. It is not a failed export and not optional absence. A failed or unknown scan does not prove absence, review, apply, or Turn completion, and it is not export redelivery. Chain `recovery_required` stays on Workspace synchronization and is not a NanoHost merge, winner, or repair record.

### Collection Resource Limits

The fixed collection resource limits and their consequences are recorded in [a decision record](../decisions/20260930-workspace_collection_resource_limits.md).

Each collection has one absolute scan-duration limit of 120 seconds, measured from the start of attachment resolution through completed candidate staging; completion must occur within that duration. Each scan admits at most 100,000 entries, counting every name read from an opened directory except `.` and `..`. Names later excluded by ignore rules count. Entries beneath an excluded `.git` component do not count because that directory is never opened. The work-slot root is depth zero, and at most 64 descendant-directory levels are admitted below it.

A root-relative path admits at most 4096 UTF-8 bytes, inclusive; unsafe syntax retains its existing `unsafe_path` outcome. A symbolic-link target admits at most 4096 bytes, inclusive, and is read with overflow detection. Encoded metadata admits at most 32 MiB (33,554,432 bytes), inclusive, each for one scan's encoded path and permission metadata, one retained manifest read, and one tree listing. Contained ignore input admits at most 1 MiB (1,048,576 bytes), inclusive, per file and at most 8 MiB (8,388,608 bytes), inclusive, in aggregate per scan. An oversized ignore file is never treated as having no rules. Regular-file source content admits at most 256 MiB (268,435,456 bytes), inclusive, per scan, counting content bytes read, so at most 512 MiB (536,870,912 bytes) across the two scans; metadata is charged separately.

Physical private-store usage admits at most 2 GiB (2,147,483,648 bytes), inclusive, per scoped store, counting retained objects, attempts, candidate staging, and temporary packing. Growth is refused unless at least 64 MiB (67,108,864 bytes) and 1024 inodes remain free on the containing filesystem after that growth. Capacity is never recovered by evicting a Core-required snapshot pair or retained worker bytes.

HEAD and ref context reads admit at most 4096 bytes, inclusive, per HEAD or loose ref and at most 1 MiB (1,048,576 bytes), inclusive, for packed refs. Context resolution follows at most eight symbolic-ref hops. Exceeding a context bound yields unavailable context, without consulting another source or inventing a commit; it does not turn context into snapshot authority.

The collection resource limits apply before allocation, traversal, subprocess admission, or private-store growth would exceed them. Exceeding a scan resource limit returns the existing two-member `effect_failed` result, with no candidate, accepted-base initialization, or cursor advance. NanoHost removes reachable attempt-private objects and does not report successful cleanup when removal fails. It preserves every Core-required snapshot pair and all retained worker bytes. Limit failure never means an empty capture or permission to omit paths or check values. The limits are fixed collection bounds, not caller-selected command options. A failed attempt may be followed only by a new authorized request. Restart does not reset physical store accounting or authorize reuse of an unfinished result; retained-pair protection and lost-result handling remain governed by this specification and [Workspace Synchronization, Snapshot Chain](20260703-workspace_synchronization.md#snapshot-chain). Missing, stale, conflicting, or unreadable snapshot and metadata inputs retain their existing typed failure rules; a capacity measurement that cannot be proved refuses growth. These limits create no durable authority or separate lifecycle record; creation, termination, retry, and recovery use the existing collection attempt and private-store owners.

### V1 Single-File Effect Transfer

V1 `reference.import` moves exactly one regular file of at most 256 MiB, and `file.export` either moves exactly one such file or returns the one exact optional-absence result defined below. Both directions bind one deterministic existing-attempt/effect-lineage `requestId`, one admitted package identity, and one normalized UTF-8 path relative to that identity. Workspace inputs and outputs use an exact declared package slot; the two non-workspace identities are import-only `package-config` and `worker-supply` defined below. An import additionally predeclares the exact byte length and lowercase SHA-256 from its immutable source; an export command declares only the output slot, relative path, fixed maximum, accepted `final_status` proof, and closed `presence` literal `required` or `optional`, while NanoHost computes the actual byte length and lowercase SHA-256 from a produced file. NanoCore selects `optional` only when the existing semantic owner defines absence as a valid no-output outcome. `/openkit/session/workspace-changes.json` is not an export. Every other export is `required`. An absolute, empty, traversing, non-normalized, adjacent, undeclared, symlink, hard-link, directory, archive, device, FIFO, socket, or oversized input or output is rejected before private admission.

The third fixed use of that outer reservation is not a workspace file effect: it carries the exact inline AEP Dockerfile for the already-pending `image.build` operation before any build root or backend effect. Its nonempty UTF-8 bytes, lowercase SHA-256, and length from 1 through 268,435,456 remain the AEP owner's immutable package lineage; this boundary creates no slot, path, file identity, context entry, locator, transfer handle, or second Dockerfile record. The exact empty-context singleton and its independent digest remain unchanged.

The selected byte mechanism is the pinned stock `ExecSandboxInteractive` typed RPC on the existing NanoHost-to-Gateway authenticated mTLS channel and current ready sandbox. NanoHost selects one fixed image-owned helper and fixed arguments for the operation; NanoCore, the package, configuration, and worker cannot select an executable, environment, working directory, timeout, SSH field, endpoint, or alternate command. The mechanism relies on the governed worker-image launch/helper prerequisite referenced by `docs/specs/20260721-worker_execution_environment_images.md`; a selected image that cannot satisfy that fixed prerequisite fails before worker launch, without a helper selector, uploaded fallback executable, shell fallback, CLI path, or image-specific command.

After Sandbox and Harness readiness and exact Core AgentSession admission, NanoCore imports the initial immutable AEP through the existing `package-config` path before dispatching `session.open`. Its relative path is `<agent-session-id>/config/package.json` and its destination is `/openkit/sessions/<agent-session-id>/config/package.json`. Required session-static `worker-supply` imports follow that AEP and complete before native runtime start. Later Turn imports follow exact reuse admission. NanoCore derives the path from the admitted AEP AgentSession identity; the installed helper accepts only one nonempty `[A-Za-z0-9_-]+` identity segment and that exact suffix beneath its fixed `/openkit/sessions` root. The body, lowercase SHA-256, byte length, and deterministic request identity follow the AEP owner's canonical byte algorithm. This identity is import-only and is not a declared workspace slot, Context Package entry, output, Artifact, snapshot, configuration selector, or general file destination. Adjacent paths, export, caller-selected roots, and an existing destination are rejected. NanoHost validates canonical carriage and local placement without acquiring a second AgentSession authority.

After AEP admission, `worker-supply` imports only regular files named in its exact `supply` resource inventory. The identity-relative path is `<agent-session-id>/supply/inputs/<resource-key>/<inventory-relative-path>`, rooted beneath `/openkit/sessions`; AgentSession and resource-key segments each match nonempty `[A-Za-z0-9_-]+`, and the remaining path passes the catalog's stricter normalized tree rules and the existing encoded-path bound. NanoCore derives every path and digest/length from the admitted AEP and verified private snapshot; the backend rejects a different key, path, inventory, source kind, or package lineage. This is an import-only resource namespace, not a Workspace slot, Context entry, Artifact, output, host mount, arbitrary directory transfer, or caller-selected destination. Export, adjacent paths, replacement of existing destinations, and original plugin/MCP configuration are rejected. The same fixed single-file helper, transport, byte bounds, staging, and failure rules apply; an image/helper/backend lacking this admitted identity fails required-supply readiness before effects.

The Worker Shim creates declared empty directories and normalized executable flags from the immutable resource inventory inside that private input root and verifies each complete source Skill digest before adaptation. The selected adapter creates its separate read-only derived projection under `/openkit/sessions/<agent-session-id>/supply/resolved`; that location is not a transfer destination, and no package may select it. Existing session materialization and cleanup own both directories. Exact prior-input cleanup clears the complete source and derived supply roots before admitted reuse, and changed static supply follows the existing session replacement/compatibility owner. Missing or extra files, changed bytes, or uncertain cleanup blocks native launch. No generic directory effect, archive upload, additional route, or new lifecycle ledger is added.

The remaining Context imports come from the prepared immutable root named `context_<turnId>`. `WorkerContextPackageFiles` supplies exact bytes and a sorted `fileInventory` of package-relative path, byte length, and digest; the package-root digest binds that inventory. The backend matches the generated AEP input to NanoCore-private `workspaceRoots`, accepts only regular files, recomputes the inventory and root digest, and imports each file after the AEP and any declared worker-supply imports and before `turn.start`. The `context` slot uses the same fixed `/openkit/sessions` effect root with the disjoint relative shape `<agent-session-id>/context/<inventory-relative-path>`, reaching only that AgentSession's Context root. The runtime owner clears the complete prior Turn input slots before reuse; per-file replacement cannot preserve omitted files. Host source paths, archives, mutable locators, and other source kinds never cross the wire.

NanoHost completely receives each import into request-private staging and verifies its declared length and digest before invoking `ExecSandboxInteractive`. It then sends stdin chunks of at most 64 KiB, and the fixed helper completes its request from the exact declared length without waiting for request EOF. The helper creates a request-scoped temporary regular file in the final declared directory without following symlinks, accepts at most 256 MiB, writes in chunks of at most 64 KiB, recomputes the declared length and lowercase SHA-256, fsyncs the temporary file, and atomically renames it to the final path; a partial or mismatched body never reaches the sandbox, and the worker cannot launch or observe the final path before that rename. NanoHost keeps the interactive request sender open through exactly one Exit and clean response completion and drops it only after settlement; it never sends request EOF before the response settles.

For `file.export`, the AEP output declaration owns only the output id, normalized path, registration posture, and retention; it contains no expected digest or length. For `file.export`, transfer starts only after NanoCore accepts that Turn's `final_status` as [Worker Control Protocol](20260703-worker_control_protocol.md) defines it. That acceptance does not wait for process-group absence, does not gate the snapshot-chain scan, and a file that changes during export fails as drift. The helper opens exactly one declared regular file without following symlinks and emits writes of at most 64 KiB; NanoHost rejects any stdout or stderr event larger than 64 KiB, any nonempty stderr, or aggregate stdout beyond 256 MiB, computes the actual lowercase SHA-256 and byte length, and atomically admits the complete file into request-private NanoHost staging. NanoCore then receives the result into request-private staging, verifies those actual facts, fsyncs and atomically places it, and only then hands the bytes to an existing canonical owner. For an `optional` export only, the helper may instead report absence when the slot root and every parent have passed the same no-follow directory checks and the final leaf lookup alone returns exact `ENOENT`; the unique signal is exit status `2` with empty stdout, empty stderr, exactly one exit, and clean response completion, creates no staging file or digest, and does not delete or fence the Sandbox. Exit status `0` means present, including a zero-byte file. A missing parent, `ENOTDIR`, symlink, directory, hard link, permission or I/O failure, inode drift, oversized file, helper contradiction, `required` missing leaf, any other nonzero exit, any output accompanying exit `2`, or unclean completion remains a failed or uncertain export. The existing transcript or output manifest supplies classification: verified bytes may enter `WorkerTranscriptPayload.artifactFiles` through `importWorkerTranscript`, or the existing Workspace output-manifest and change-set path, while exact optional absence of an export that remains optional yields no staging for that export. An empty workspace-collection diff is defined by [Workspace Synchronization](20260703-workspace_synchronization.md) and is not this export absence. A missing or contradictory declaration is rejected, and the AEP path envelope creates no Artifact, media, review, Workspace, or publication authority.

For the fixed OpenShell Worker image, the package Workspace envelope MUST be `/workspace`; NanoCore constructs this invariant and rechecks it before main-worktree file-effect projection, and configured input identity remains separate from its materialized destination. The planner places `main-worktree` at `/workspace/worktrees/<workSlotRef>` and projects the same path into runtime working directory, writable output declarations and filesystem policy. Its closed file-effect namespace uses the fixed helper parent `/workspace/worktrees` and relative path `<workSlotRef>/<file-relative-path>`. The first segment is the exact admitted work-slot identity, one to 128 characters matching `[A-Za-z0-9][A-Za-z0-9._-]*`; dots are allowed within this work-slot segment, unlike the separate AgentSession identity grammar, and it is not a caller-selected root. NanoCore first proves the file belongs to the current package's declared writable slot and output envelope, then adds that exact namespace segment. The helper validates the segment and the existing no-follow relative-file constraints. A different slot, adjacent path, missing slot parent or rewritten package placement fails rather than producing optional absence. Other fixed slot roots retain their existing mapping. The helper does not derive authority from a Worker-writable copy of the AEP, and this projection adds no wire field or storage record.

### Fixed Outer File-Data Carriage

The same authoritative NanoHost-client-to-NanoCore-server physical HTTP/2 connection carries one distinct fixed logical file-data stream. At most one file-data stream is active across `reference.import`, `file.export`, `workspace.collect`, and `image.build/input`; of the two existing outer NanoHost control/readiness reservations, one remains control/readiness-only and one is the file-data reservation. The existing outer maximum of 16 streams, 256 KiB per-stream receive window, 5 MiB connection receive window, 1 MiB worker-control headroom, and 512 KiB control ceiling remain unchanged. Each application send and each consumption release is at most 64 KiB; HTTP/2 frame splitting or coalescing changes none of these limits.

On every fixed file-data request or response, each required OpenKit application header appears exactly once and its value is validated against the accepted request and effect identity plus the applicable slot, path, digest, declared length, observed length, and body facts. Every required HTTP representation header remains exact and single-valued; a missing or duplicate required header or an HTTP/2-invalid header block fails closed. Legal additional HTTP transport or representation headers carry no authority and are ignored.

The import command poll remains `POST /api/nanohost/transport/effects/reference.import` with exact body `{}`. It returns `204` when no import is pending or `200 application/octet-stream` with an exact `content-length` and the required metadata headers `x-openkit-request-id`, `x-openkit-slot`, `x-openkit-relative-path`, `x-openkit-sha256`, and `x-openkit-byte-length`. The request id is lowercase 64-hex; slot is exact `package-config` or `worker-supply` for its closed import path, or an exact declared workspace package slot; relative path is normalized UTF-8 identity-relative text encoded per segment with uppercase `%HH`, literal `/`, and at most 4096 encoded bytes; digest is lowercase `sha256:<64hex>`; byte length is canonical decimal from `0` through `268435456` and equals both `content-length` and observed bytes. Decoding rejects absolute, empty, backslash, dot, dot-dot, empty-segment, NUL/control, non-UTF-8, and noncanonical encoding. After sandbox atomic placement, NanoHost submits the existing bounded JSON result to `/api/nanohost/transport/effects/reference.import/result`; it never echoes file bytes there.

The `image.build` metadata poll remains `POST /api/nanohost/transport/effects/image.build` with exact body `{}` and returns `204` when absent or bounded `200 application/json` when pending. Only after accepting metadata that declares the matching lowercase 64-hex `requestId`, independent Dockerfile digest, and canonical decimal `dockerfileByteLength` may NanoHost send `POST /api/nanohost/transport/effects/image.build/input` on the same current authoritative and ready physical connection. That request has exact `content-type: application/json`, exact body `{}`, and the one required OpenKit application header `x-openkit-request-id`, containing the accepted request identity. NanoCore requires that exact physical connection, accepted pending `image.build`, and matching identity, then returns `200 application/octet-stream` with exact `content-length`, `x-openkit-request-id`, `x-openkit-sha256`, and `x-openkit-byte-length`; the body is exactly the inline Dockerfile UTF-8 bytes. It carries no slot, relative path, file identity, AEP body, context bytes, argument bytes, generic metadata envelope, or result semantics.

The Dockerfile response length is canonical decimal from `1` through `268435456`, equals both length headers, the preceding metadata declaration, and observed bytes, and its exact lowercase `sha256:<64hex>` equals the immutable AEP input digest. NanoHost consumes and releases capacity in chunks of at most 65,536 bytes and verifies request identity, media type, both lengths, digest, complete body, and UTF-8 before creating a build root, writing a Dockerfile, opening build egress, or invoking Buildx. Candidate, fenced, stale-predecessor, wrong-operation, unknown, unaccepted, mismatched-request, or repeated same-generation input fetch receives `409` and no bytes; an announced over-ceiling body receives `413`; and a bounded private NanoCore source or stream failure receives redacted `500`. A malformed media type, request identity, digest, decimal length, UTF-8 body, forbidden field, or contradictory metadata fails closed without `BuildPlan` and exposes no Dockerfile bytes, host path, endpoint, header, package content, credential, or backend-private state.

The export command poll remains exact `{}` on `POST /api/nanohost/transport/effects/file.export` and returns the existing bounded JSON command containing request id, slot, normalized relative path, fixed maximum, terminal proof, and closed `presence`, with no digest or byte length. NanoHost submits a complete present file on `POST /api/nanohost/transport/effects/file.export/result` as `application/octet-stream` with the same five canonical metadata headers and exact `content-length`. For exact optional absence only, NanoHost instead submits `application/json` body `{"requestId":"<requestId>","state":"absent"}` with no additional member or file metadata header on that same result path. NanoCore accepts it only for the exact pending command whose `presence` is `optional`; a required command, changed field, extra field, wrong request, path, operation, or connection is rejected. NanoCore returns `204` after it owns the complete verified request-private staging file or after it has accepted that exact absence fact; neither response is product acceptance.

Malformed or noncanonical content type, metadata, identity, slot, path, digest, decimal length, presence, or absence body fails with `400` before an effect. A declared or observed body over 256 MiB fails with `413` before private admission. A stale or fenced connection, wrong operation, request, slot, path, required missing source or output, invalid optional lookup, digest or length mismatch, incomplete body, or conflicting duplicate fails with `409`. NanoCore-private staging I/O failure returns bounded redacted `500` without a host or file path. Mid-body reset, cancellation, timeout, or connection close has no fallback and never becomes success. Delivery uncertainty for an already-proved optional absence retains and resubmits only the exact same absence result on an authoritative successor, follows the existing same-generation rejection and successor-poll-first unknown fence, and never reruns the helper.

The stock RPC reuses the existing Gateway mTLS authentication and ready-sandbox authorization, while outer file carriage reuses the existing authoritative connection's native physical context and successor fence. Neither creates a second NanoHost connection, OpenKit listener, credential, data service, queue, journal, generic transfer envelope, range, append, cursor, resume, compression, trailer, or second logical result. The pinned opaque internal SSH relay is transport implementation closure owned by the runtime specification, not SSH authority or a selectable data path under this document.

### Artifact Transport Projection

An Artifact transport projection carries one exact existing Artifact identity, version, content digest, immutable origin, and required Item or Review lineage into a later authorized Turn.

It does not create a new Artifact lifecycle, make Artifact a universal editable filesystem object, replace native Git or object authority, or let Artifact Review replace Workspace Sync Review or Material revision authority.

## Decision

Use one independently deployed NanoHost projected by the configured `RuntimeTarget` while preserving NanoCore as the sole durable product and scheduling authority.

For every worker attempt, NanoCore resolves exact existing authority into immutable references and bounded descriptors. The NanoHost refreshes disposable request inputs separately from retained work, initializes new working targets without overwrite or reuses an explicitly admitted existing target under current source checks, runs the worker under the separate runtime specification, collects bounded output, including the read-only scan result for Workspace synchronization, and returns exact digests, manifests, and transfer results to the existing Artifact, Material, Workspace synchronization, Item, and audit owners. NanoHost still does not create the product record.

The target flow is:

```text
canonical OpenKit records and native source authority
  -> exact Git commit, Artifact version, object version, or bounded bundle descriptor
  -> fresh request materialization plus first initialization or admitted retained-work reuse
  -> bounded worker execution
  -> staged native output plus exact digest and lineage
  -> Artifact Review, Material revision, or Workspace Sync Review
  -> optional apply by the existing owner
  -> later Turn receives the accepted exact version
```

A fresh imported input still binds an exact version. A chain head on a retained volume may be an uncommitted tree. The next Turn on that volume continues from the previous head. It does not require a fresh checkout of an accepted commit. No running sandbox receives a hot update from another sandbox. No sandbox publishes directly to canonical storage. No transfer success implies review acceptance, Workspace apply, Turn completion, or runtime cleanup. Scan completion is not apply and is not publication.

## Input Contract

Every input descriptor MUST bind the exact attempt and contain only the references and bounded metadata required by its existing owner.

Supported authority forms are:

- An exact Git repository identity and commit, with any required submodule, sparse-path, or bundle metadata governed by the existing source contract.
- An exact Artifact id, version, content digest, immutable origin, and required Item or Review lineage.
- An exact object identity plus the version id, ETag, digest, or other precondition guaranteed by the accepted object-source contract.
- A bounded immutable bundle descriptor with content digest, length, path envelope, source lineage, and expiry or retention behavior.
- Existing Context Package, Workspace data-source, or session-static materialization references that resolve to one of the authority forms above.

A mutable branch name, unversioned object locator, local absolute path, transfer-session id, raw host mount, temporary backend handle, or best-effort latest value is insufficient when it can change the bytes one attempt receives.

The NanoHost verifies identity, version, length, digest, path envelope, package lineage, and applicable source preconditions before the worker consumes the materialization. Missing or conflicting proof fails the attempt before the affected input is used.

## Large-Data And Control-Transport Boundary

Repository packs, Workspace trees, Artifact bodies, object payloads, media, model assets, image archives, and other large bytes MUST NOT travel through NanoHost control, readiness, worker-control, inference, or capability streams. The exact V1 file effects, the `workspace.collect` result, and the fixed Dockerfile input are the sole exceptions at the physical-connection level: one fixed file-data stream on the same authoritative outer HTTP/2 connection carries only the directional bodies and metadata defined here and above.

`workspace.collect` is a NanoHost effect pair beside the existing pairs, pinned by [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md). The command poll body is `{}`. The command NanoCore returns is bounded JSON under the existing 512 KiB control ceiling, Its required core members are `requestId`, `storageRef`, `scopeDigest`, `attachmentGeneration`, `sandboxId`, `workSlot`, `collectionId`, `mode`, `acceptedBase`, `previousHead`, and `checkValues`. Each core member of the command, and of a collection JSON result, occurs exactly once in its object. Duplicate decoded core member names, including equivalent escaped spellings, are rejected before admission. Readers validate every core value and ignore an unknown additive member of the command, at each object level, and of a collection JSON result, without persisting, forwarding, or displaying that content. Unknown required or authority-bearing semantics fail closed. A missing core member, a core value outside its closed set, a duplicate core member, or malformed control-message syntax is a protocol rejection before any scan. A collection command admits at most 128 nested JSON containers, inclusive, counting objects and arrays on the deepest nesting path over the whole command, including unknown additive members and the root container. Excess nesting is a protocol rejection before effects. `mode` is the required closed core member that selects the form. Its closed values are `capture` and `baseline`. Any other value is a core value outside that set. The baseline form and its reason are recorded in [a decision record](../decisions/20260930-first_accepted_base_by_baseline_scan.md). `requestId` is the existing lowercase 64-hex effect identity. `workSlot` is the work-slot identity this specification already defines. NanoCore supplies `storageRef`, `scopeDigest`, `attachmentGeneration`, and `sandboxId` from the exact currently admitted storage attachment for that work slot. Their identity and value grammars are owned by [NanoHost Runtime And Transport, Persistent Worker Storage Amendment](20260802-nanohost_runtime_and_transport.md#persistent-worker-storage-amendment) for `sandbox.create`. They grant no new attachment or initialization authority. NanoHost matches them against its host-owned retained-storage association and its current live Sandbox before opening the work slot. It selects only the initialized `/workspace` target of that attachment and descends to `worktrees/<workSlot>` without following symbolic links. A work-slot name or filesystem search cannot identify an attachment. Missing, detached, stale, conflicting, unsafe, incomplete, or unproved attachment identity returns the existing `effect_failed` result before scanning, without searching another association or changing retained bytes or snapshot protection. The private scan store is scoped to the retained association, its selected volume identity, and the work slot; a new attachment generation does not reset that store. `collectionId` is an opaque Core-issued identity of 1 through 128 characters matching that same work-slot character grammar. NanoHost does not derive or persist `collectionId`. Core keys exact link and observation replay to it. For `capture`, `acceptedBase` and `previousHead` are the snapshot pairs [Workspace Synchronization](20260703-workspace_synchronization.md) defines for Core's accepted base and the capture cursor. For `baseline`, both values are JSON null, and omitting either member remains a missing core member. A JSON null pair on `capture`, or a non-null pair on `baseline`, is a core value outside its closed set. Each snapshot pair has required core members `tree` and `manifest`. Canonical writers emit them in that order, and each value is that object's id in the private store. `checkValues` has required core members `runtimeEnv` and `loopbackDigests`. `runtimeEnv` is an array of every session-static runtime-env value string admitted for that binding by [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md), and this command adds no tighter count or per-value cap. A `runtimeEnv` element that the runtime-environment owner would not admit is a core value outside its closed set. `loopbackDigests` is an array of exactly two lowercase 64-hex SHA-256 digests of the encoded 43-byte credentials, with no prefix, and the two digests need not differ. Those are the values [Workspace Synchronization](20260703-workspace_synchronization.md) requires for that binding. The runtime-env values are the bounded exception, beside `runtimeEnvironment`, to the prohibition on raw credentials in NanoHost commands. NanoHost holds those runtime-env values in memory only for the scan and never persists or logs them. The digests are not raw credentials. The scan applies the literal and windowed SHA-256 comparisons to the complete selected source byte set owned by [Workspace Synchronization, Snapshot Chain](20260703-workspace_synchronization.md#snapshot-chain), including that owner's publication, retained-pair cleanup, and retained-content disposition rules. A match fails the collection exactly as a literal hit does. A command that cannot be represented within that ceiling is not dispatched, the values are not truncated or omitted, and collection returns the chain `recovery_required` result with cause `command_too_large`, with no review and no cursor advance.

The result uses the existing file-data stream reservation as its fourth user, beside `reference.import`, `file.export`, and `image.build/input`. At most one file-data stream is active. A candidate body is `application/octet-stream` with exact `content-length`, within the existing 256 MiB ceiling and 64 KiB application consumption, and with each of these metadata headers exactly once: `x-openkit-request-id`, `x-openkit-head`, `x-openkit-previous-head`, `x-openkit-accepted-base`, `x-openkit-unstable`, `x-openkit-sha256`, and `x-openkit-byte-length`. The snapshot-reference headers `x-openkit-head`, `x-openkit-previous-head`, and `x-openkit-accepted-base` each carry the snapshot pair as the tree id, one U+0020, and the manifest id, both lowercase hexadecimal Git object ids. Those headers bind the head, the previous head, the accepted base, `unstable`, the digest, and the length. They are required on a candidate body. A JSON collection result does not require `x-openkit-request-id` or a snapshot-pair header, and absence of either is not malformed metadata. Its body binds the request, and an extra legal header on that result carries no authority and is ignored. The body is the review candidate, one immutable patch from Core's accepted base, recorded when the candidate is staged, to the link's head. Its bytes are the exact stdout of `git diff --binary --full-index --no-renames --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/` from the accepted-base tree to the head tree, run in the private store. Exit 0 and exit 1 are both success. When any full-mode record exists, the body then appends the ASCII bytes `openkit-full-mode-delta`, one U+000A, and one record per such path sorted by unsigned path bytes. A record is emitted for an addition and for a path whose full mode differs from the accepted base. An addition uses old mode `----`, four bytes and not octal. Each record is the old mode or `----`, one U+0020, the new mode as the four zero-padded octal digits [Workspace Synchronization](20260703-workspace_synchronization.md) defines for `st_mode & 07777`, one U+0020, the positive canonical decimal byte length of the path with no leading zero, one U+0020, exactly that many raw path bytes, and one U+000A. Deletions appear only in the Git diff. The candidate is empty only when that diff is empty and there is no mode record, so a permission-only delta is a candidate body and not an empty result. A mode-only change of path `a` from `0644` to `0600` is exactly `openkit-full-mode-delta`, one U+000A, `0644 0600 1 a`, and one U+000A. Capture emptiness and review-candidate emptiness are independent. An `empty` result means the cumulative review candidate is empty. It carries exactly `requestId`, `outcome`, `head`, `previousHead`, `acceptedBase`, and `unstable`, with `outcome` equal to `empty` and the snapshot references bound to the command and the verified scan. Each of `head`, `previousHead`, and `acceptedBase` is the JSON object defined for the command, and `unstable` is the JSON boolean `true` or `false`. The body is exactly `{"requestId":"<requestId>","outcome":"empty","head":{"tree":"<tree>","manifest":"<manifest>"},"previousHead":{"tree":"<tree>","manifest":"<manifest>"},"acceptedBase":{"tree":"<tree>","manifest":"<manifest>"},"unstable":true}` or the same text with `false`. It carries no candidate bytes. `no_new_head` means the second scan's snapshot pair equals `previousHead`; it does not imply that the two scans agreed. Its JSON result carries exactly `requestId`, `outcome`, and `unstable`, where `outcome` is `no_new_head` and `unstable` is the boolean result of comparing the two scan pairs. The body is exactly `{"requestId":"<requestId>","outcome":"no_new_head","unstable":true}` or the same text with `false`. The exact two-member result `{"requestId":"<requestId>","outcome":"<outcome>"}` remains only for `credential_hit` and `effect_failed`. A collection failure that requires chain recovery is `application/json` with required core members `requestId`, `outcome`, and `cause`, where `outcome` is `recovery_required` and `cause` is one value of the closed set [Workspace Synchronization](20260703-workspace_synchronization.md) defines. Canonical writers emit those three members and no others. The result creates no review and no advancing link. A successful baseline result is `application/json` with required core members `requestId`, `outcome`, and `head`, where `outcome` is `baseline` and `head` is the snapshot-pair object defined for the command. Canonical writers emit those three members and no others. It carries no candidate bytes. NanoHost returns that result only when the two scan pairs are equal. [Workspace Synchronization](20260703-workspace_synchronization.md) owns acceptance of the pair. Other definite effect failures keep the two-member `effect_failed` result. A `no_new_head` result creates no `WorkspaceChangeSet`, review, or apply effect and does not advance the snapshot-pair cursor. When `unstable` is true, Core records the observation through the existing collection-link owner, with `base` and `head` both equal to `previousHead`, and retains its instability for exact replay under that collection identity. It does not overwrite an earlier link's stability. A stable unchanged capture needs no additional link. Exact replay is keyed to the collection/link identity, not merely to equality of snapshot pairs. A return to the accepted base is a captured transition, not `no_new_head`. That JSON result is not optional-absence and not a generic failure fallback.

NanoCore returns `204` once it owns verified request-private staging of a candidate body, or once it has verified a JSON result. It verifies an `empty` result's snapshot references against the command and the verified scan before that acknowledgement, and records any changed capture and its cursor through the same link-commit path as a nonempty candidate. An `empty` result creates no staged review or apply effect. `no_new_head` is acknowledged, creates no `WorkspaceChangeSet`, review, or apply effect, and does not advance the snapshot-pair cursor. When `unstable` is true, Core records the observation through the existing collection-link owner, with `base` and `head` both equal to `previousHead`, and retains its instability for exact replay under that collection identity. It does not overwrite an earlier link's stability. A stable `no_new_head` records no additional link. A credential hit or a typed failure is acknowledged and does not record an advancing link. A `recovery_required` result is acknowledged and does not record an advancing link. The scan is read-only on the volume, so a lost result leaves the effect unknown. A later attempt is a new request from the same previous head, not an implicit retry and not export redelivery. A lost baseline result stays unknown. The later attempt is a new baseline request, never adoption of the current worktree and never redelivery of the lost result. NanoCore may authorize a new baseline request only for the same still-authorized first initialization, while no accepted pair is durable and no first Turn has been dispatched, and only after the existing reconnect and binding proofs permit collection. A durable accepted pair is reused after restart, never replaced by another baseline; an unrelated retained slot without an accepted pair is not eligible for inferred initialization. NanoHost does not decide whether Core accepted an earlier result and does not create a separate baseline-acceptance record. Objects of an unrecorded attempt are pruned by the next recorded link, and that pruning does not remove or overwrite a manifest blob retained with its tree. This carriage adds no second connection, generic transfer service, or second logical result.

The control session may carry:

- Exact immutable references.
- Content digests and lengths.
- Bounded manifests and transfer instructions.
- Short-lived non-secret retrieval references under an existing owner.
- Transfer acknowledgements and typed failures.
- Small inline previews or diagnostics already permitted by the owning communication contract.

The selected native or bounded transfer path carries the bytes. It MUST be authenticated and authorized as required by its owner; the V1 file-data stream is bound by the authoritative connection's native physical context and current successor fence. Its fixed Dockerfile response is authorized only by the accepted pending `image.build` metadata and creates no work claim or result meaning. No data path accepts NanoHost readiness, worker-control, inference, capability, permission, review, or terminal-status messages.

Control and data paths may share physical network infrastructure, but they retain separate authority, credentials, bounds, retry, and failure semantics.

## Output And Review Contract

Worker output remains NanoHost-local until an existing durable owner accepts its exact manifest, content, digest, lineage, and transfer result.

Inspectable user-visible output SHOULD enter the existing Artifact lifecycle. The Artifact preserves exact version, immutable origin, content digest, Item-backed work lineage, and version-owned Review.

Repository or filesystem changes that may mutate canonical Workspace truth MUST also use the existing Workspace synchronization path. An Artifact may present the candidate for review, but it does not replace `WorkspaceChangeSet`, conflict preflight, apply authority, or protected-branch policy.

Material changes use the existing Material revision and expected-base contract. Object updates use only conditional semantics guaranteed by their accepted native source owner.

The NanoHost MUST NOT choose a conflict winner, merge, rebase, force-push, overwrite a stale object, advance an expected base, approve an Artifact, apply a Workspace change, or convert transfer completion into publication.

The snapshot-chain scan is not a sandbox export. A repeated scan is a new collection point with its own `base` and `head`, not export redelivery. After NanoHost has produced a complete verified export result, uncertain delivery may resubmit on an authoritative successor only one of two closed results without rerunning sandbox export: the exact present request id, slot, path, actual length, digest, complete body, attempt lineage, and destination precondition, or the exact proved optional-absence JSON `{"requestId":"<requestId>","state":"absent"}`. NanoCore may acknowledge the identical already-complete present staging tuple or optional-absence result with `204`; a changed duplicate fails with `409`. No same-generation automatic retry is permitted. This is result delivery, not logical-effect replay, and it neither creates a second output nor silently overwrites the first.

## Cross-Turn And Cross-Agent Handoff

A later worker Turn imports another owner's accepted Artifact version, Git commit, object version, Material revision or Workspace snapshot through a new input descriptor. Continuing its own retained working volume follows the persistent-volume owner's current scope, source, single-attachment and no-overwrite admission instead of fresh destructive materialization. On the same volume, the next chain `base` is the previous `head`, not a reset and not a fresh import of an accepted commit.

The handoff remains mediated by durable OpenKit and native source authority. Independent Sandboxes do not synchronize directly, share a writable directory, exchange backend handles or treat another sandbox's residual filesystem as accepted input truth. An explicitly authorized replacement may reattach its own retained storage only after the predecessor effect domain is fenced; this is sequential volume reuse, not peer synchronization.

Multiple agents may collaborate by producing and reviewing exact durable outputs under existing product records. The double scan tolerates concurrent writers by recording `unstable`. That tolerance is not a collaboration state machine, shared memory, or multi-writer product filesystem. This specification does not add a collaboration state machine, shared memory, multi-writer filesystem, or universal resource layer.

## Lifecycle And Failure Semantics

### Create

NanoCore records the existing work and lease authority, resolves exact input references, and creates any required existing Artifact, Material, Context Package, or Workspace synchronization records before effectful transfer or execution.

The NanoHost creates only disposable materialization and transfer state. A transfer mechanism may create temporary native artifacts only when its owner defines their expiry and cleanup; those artifacts do not become product authority.

For the build form, fixed `image.build` metadata, exact `image.build/input` verification, local build, and the unchanged JSON result settle before `sandbox.create`; this input sub-carriage creates no independent lifecycle step. The runtime owner orders Sandbox creation and bridge readiness before exact `session.open` or reuse inspection, then canonical AEP import, every declared worker-supply file, every Context inventory import, and `turn.start`. Turn-input cleanup barriers settle before reuse. Volume reuse for a next Turn or a successor waits until the collection point [Workspace Synchronization](20260703-workspace_synchronization.md) requires for that reuse has completed. Process-group absence is not that collection gate. Required `file.export` operations start after accepted `final_status` and do not wait for process-group absence. Collection completion remains the next-Turn gate. Exact session close preserves compatible siblings, while uncertain cleanup follows the existing wider fence. Sandbox teardown remains `bridge.close` then `sandbox.delete` when that wider lifecycle is required. No later step may be reported complete while an earlier applicable barrier remains unknown. An unknown scan is not reported as an empty change set.

### Update

Input authority is immutable for one attempt. A changed branch, object, Artifact, Material, or Workspace version requires a new authorized descriptor and, when execution is required, a new Turn or attempt under its existing owner.

Output updates create new versions or change-set evidence through the existing owner. The NanoHost does not mutate an already accepted immutable version.

### Terminate And Retain

After accepted output disposition and runtime cleanup, NanoHost-local materialization and temporary transfer state are removed according to their existing owners.

Every completed, failed, cancelled, timed-out, or uncertain single-file effect removes its request-private partial staging when locally reachable. NanoHost also removes every partial Dockerfile input on rejection and removes verified request-private input through existing build-root cleanup; NanoCore removes retained pending Dockerfile bytes when exact success or failure settles, the existing owner explicitly aborts the attempt, or lifecycle cleanup destroys it. An import does not permit worker launch until atomic admission succeeds; an export admits no canonical result until accepted `final_status` and complete local proof succeed. That export barrier does not gate the snapshot chain, and collection completion is the next-Turn gate. A proved scan result is still not canonical Workspace truth. The export clause stays for `file.export`.

Canonical records, accepted Artifact versions, Workspace change evidence, audit lineage, and native source history retain their existing lifecycles. This specification creates no independent retention record or garbage collector.

### Retry

Import retry is permitted only before sandbox effect admission and only when the existing owner defines idempotency and the exact source reference, destination precondition, digest, length, path envelope, and attempt lineage are unchanged. After sandbox admission, a lost import completion is not replayed: launch remains blocked, exact sandbox deletion is required, and an uncertain delete invalidates the epoch. Export result redelivery is limited to the closed already-complete present tuple or exact proved optional-absence JSON described above, uses the same `requestId` on an authoritative successor, and never reruns sandbox export; an ambiguous or changed duplicate fails closed. Dockerfile reset, cancellation, timeout, or physical close before complete verification discards the partial body, starts no build root or backend effect, settles that command as exact `effect_failed`, and never refetches, resumes, or replays the Dockerfile; connection loss may carry only that retained bounded result on an authoritative ready successor. After complete verification and local build admission, connection loss never restarts the build and may carry only its unchanged definite result on a successor.

An unknown transfer or apply effect is not automatically repeated. NanoCore removes incomplete export staging, and NanoHost removes reachable import partials; the owning native or OpenKit system must inspect, reconcile, or reject the outcome according to its existing contract, and any later logical effect uses a new request with fresh authority.

After `ExecSandboxInteractive` admission, a nonzero exit other than the exact optional-absence status `2`, missing or duplicate exit, any stderr, extra or oversized event or aggregate, digest or length mismatch, premature request EOF, gRPC error, timeout, cancellation, relay loss, or unclean stream end is failed or `unknown`, never successful. Present-file success requires exact declared-length helper completion, exactly one zero exit, and clean response completion after all byte, digest, fsync, and atomic-placement checks, followed only then by request-sender drop. Optional absence requires exact exit `2`, empty stdout and stderr, and the same one-exit clean completion. An uncertain effect is never replayed; a new retry is a new owning request with fresh authority.

### Recovery

NanoCore recovery reconstructs durable product and transfer lineage from existing records. It does not reconstruct canonical truth from NanoHost-local paths, transfer-tool state, or sandbox residue.

Runtime Epoch recovery and cleanup belong exclusively to `docs/specs/20260802-nanohost_runtime_and_transport.md`. Data recovery waits for that boundary when NanoHost-local effects are unavailable or uncertain.

An uncertain import prevents worker launch and requires exact sandbox deletion. An uncertain export produces no accepted result and requires removal of reachable private staging. For either direction, a proved sandbox delete may preserve the healthy epoch, while an uncertain delete invalidates the Runtime Epoch and keeps capacity fenced under the runtime owner.

## Missing, Stale, Conflict, And Dependency Failure Semantics

- A missing source, source version, canonical package-config body, import digest or length, output declaration, permission, review lineage, destination owner, or required transfer capability fails before the affected bytes are consumed or published.
- A stale Git commit expectation, object precondition, Artifact expected version, Material base, or Workspace apply base returns the existing native or owner-local stale or conflict outcome. Chain `recovery_required` stays the Workspace synchronization outcome beside these results and is not collapsed into this stale-Git outcome.
- Digest, length, path, version, origin, lineage, or destination disagreement fails closed and preserves any candidate only as non-authoritative evidence.
- Transfer interruption does not prove absence, completion, review, apply, runtime cleanup, or Turn completion.
- An unavailable native system or transfer mechanism blocks or interrupts the exact attempt; the NanoHost does not substitute a weaker authority form or copy from unverified local residue.
- Missing fixed helper support, a non-regular or symlinked source or destination, an invalid package identity or relative path, an adjacent or export use of `package-config` or `worker-supply`, an oversized file or event, a nonzero terminal result other than exact optional absence, an ambiguous terminal result, stderr, digest or length disagreement, or unclean RPC completion fails the exact effect without fallback or replay.
- A retry never changes the immutable source, destination precondition, attempt identity, import digest, or already-produced export digest merely to obtain success.
- No conflict creates a NanoHost-owned merge, winner, settlement, or repair record.

## Security And Privacy

- Transfer authorization MUST be exact-attempt, exact-source, exact-destination, bounded, expiring where applicable, and independently revocable under the owning identity, permission, and Vault contracts.
- Secret values MUST NOT appear in input descriptors, Artifact payload metadata, transfer manifests, normal Workspace files, logs, or product diagnostics.
- Short-lived retrieval credentials remain outside the Agent Environment Package and worker prompt and are exposed only at the governed transfer boundary. The credential comparison in the private-store scan uses the runtime-env values NanoCore supplies in memory on the collection command and the SHA-256 digests of the two loopback credentials that command carries, under the windowed comparison [Workspace Synchronization](20260703-workspace_synchronization.md) defines. It does not place those values in the Agent Environment Package or the worker prompt, and it does not change this retrieval-credential rule.
- NanoHost-local paths, raw host paths, mount handles, object-store temporary URLs, transfer session ids, container ids, and backend-private locators MUST NOT become public product fields. The private store path is one of those locators.
- A transfer mechanism MUST NOT broaden the source or destination path envelope, follow path traversal, or grant the worker write access to canonical NanoCore storage.
- Data locality MUST be stated per selected native source, transfer path, model provider, and output destination; remote execution alone does not imply that all bytes remain in one private network.

## Current Implementation Projection

The separated NanoHost topology is implemented for the current NanoHost-only production path while this specification remains Partial for its broader declared data-source and reuse target.

Current OpenKit already has substantial receiver mechanisms: durable NanoCore product records, immutable Agent Environment Package snapshots, Artifact versions and reviews, Workspace synchronization records, session-static materialization, worker output manifests, Git-native workflows, and bounded OpenShell upload and download paths.

NanoCore retains product-record and canonical handoff authority but no longer performs execution-host lifecycle or data-materialization effects through Cell. NanoHost owns the current Runtime Epoch effects, fixed package-config, worker-supply, and Context imports, path-only output exports, and verified byte movement. The accepted design adds a read-only scan of the host bind-mount of the retained volume, which is not path-only `file.export`. This projection does not claim that scan is already implemented. The command `mode` member, the baseline JSON result, and a new baseline request after a lost result are not implemented.

The V1 single-file `ExecSandboxInteractive` mechanism is implemented and admitted by the eleven-root pin with the fixed helper, mTLS authorization, bounds, no-early-EOF terminal classification, cleanup, opaque internal-relay closure, closed required-or-optional `presence`, exact helper exit-`2` absence proof, same-path JSON result, and, for `file.export`, that absence proof. Workspace collection no-change is `no_new_head` when the second scan's snapshot pair equals `previousHead`, and that equality does not imply that the two scans agreed. An empty review candidate under [Workspace Synchronization](20260703-workspace_synchronization.md), meaning no content, path, file-kind, deletion, or supported permission delta against Core's accepted base, is the `empty` result and not helper exit 2 on `workspace-changes.json`. The accepted design replaces that publisher. Every other missing export still fails. The fixed same-connection `image.build/input` outer carriage is implemented with byte-free control metadata, exact identity, digest, length and UTF-8 verification, and no refetch or replay.

The declared `worker-supply` identity imports verified Skill snapshot files after the canonical AEP and before Context, using identity-relative paths `<agent-session-id>/supply/inputs/<resource-key>/<inventory-relative-path>` under `/openkit/sessions`. Native Codex plugin loading is not advertised; the thin adapter projects those imported trees into `$CODEX_HOME/skills` by symlink. Host skill discovery and Codex `.system` skills remain residual runtime-owned surfaces until an image-level isolation proof is retained.

This specification becomes implemented only when the one NanoHost path uses exact native or bounded data transfer while NanoCore performs no execution-host lifecycle effect, large bytes remain outside every control or semantic-route stream, and the sole outer-connection file-byte exception is the fixed V1 stream defined above.

## Rollout / Migration Plan

1. Accept the Runtime Epoch and transport owner and reconcile the scheduler, AEP, worker-control, data-source, Artifact, Material, and Workspace synchronization receivers.
2. Implement one co-located NanoHost using the same authority and data-transfer boundaries intended for remote deployment.
3. Prove exact input materialization and output collection through existing Git, Artifact, Material, object-source, and Workspace owners without a shared writable filesystem.
4. Deploy the same one-NanoHost contract remotely with NanoHost-initiated control communication and separately governed native or bounded data transfer.
5. Completed: remove NanoCore-owned execution-host effects and legacy SSH, Gateway-forward, and direct endpoint configuration through the runtime specification's cutover plan.
6. Retain no compatibility selector, generic sync service, second NanoHost, second active slot, or alternate data authority.

The rollout does not require object storage for bounded NanoCore-owned records or Artifacts. Repository text and code use an external Git source, while static source data beyond those bounded owners requires an accepted external object-store source; neither service is hosted by NanoCore or NanoHost.

## Testing Strategy / Acceptance Criteria

### Contract Checks

- Every input binds one exact Git commit, Artifact version, object version or accepted digest, Material revision, Workspace snapshot, or bounded immutable bundle. A collected snapshot's tree may be the tree object of an uncommitted worktree, paired with its permission-manifest blob, and the worktree `HEAD` commit is context only. That fact does not weaken this input rule for a fresh import.
- Wrong identity, version, digest, length, path, origin, lineage, permission, or destination precondition fails before consumption or publication.
- Large data never traverses control, readiness, worker-control, inference, or capability streams; only the one fixed directional file-data stream may carry V1 file-effect bytes, the `workspace.collect` result, and the exact `image.build/input` Dockerfile response on the same authoritative physical connection.
- Each V1 file effect moves exactly one admitted regular file no larger than 256 MiB through the outer fixed file-data stream, except that an explicitly optional export may return only the exact no-follow leaf-`ENOENT` absence result, with the exact package-config or inventory-bound worker-supply identity, or a declared workspace slot, a normalized identity-relative path, imported source digest and length or NanoHost-produced export digest and length, at-most-64-KiB application chunks or helper writes, and no caller-selectable executable or SSH surface.
- The fixed `image.build/input` subpath carries exactly the accepted pending operation's 1-through-268,435,456-byte inline UTF-8 Dockerfile with matching request identity, declared and observed lengths, and lowercase SHA-256 in at-most-64-KiB consumption releases; it carries no slot, path, locator, context, arguments, result, second record, or generic envelope and is completely verified before any build effect.
- After exact session admission, the canonical AEP is the first Turn import into `/openkit/sessions/<agent-session-id>/config/package.json`, followed by its exact worker-supply file inventory, the complete private Context inventory, and only then `turn.start`. Adjacent paths, exports, pre-existing destinations, changed bytes, or uncertain admission block launch without replay; cleanup and fencing remain with the runtime owner.
- A data-transfer credential cannot authenticate NanoHost control, worker control, inference, capability, readiness, review, or terminal-status traffic.
- Import is never replayed after sandbox admission; an identical complete verified export result may be redelivered only on an authoritative successor where the owner permits it, and a conflicting duplicate changes nothing.
- Native and owner-local stale or conflict outcomes create no NanoHost merge, retry, winner, or settlement state.
- A blob that contains a loopback credential embedded in a longer run of the credential alphabet is caught by the windowed SHA-256 comparison against the two digests `checkValues` carries, and a collection after a NanoCore restart still checks those loopback credentials.
- An `empty` result carries exactly `requestId`, `outcome`, `head`, `previousHead`, `acceptedBase`, and `unstable`, and no candidate bytes. Accepted base content 0, previous capture 1, and scan 0 record the link and advance the cursor to 0 without a review. `no_new_head` carries exactly `requestId`, `outcome`, and `unstable`, and only when the second scan's snapshot pair equals `previousHead`. Previous mode `0644`, first scan `0600`, and second scan `0644` return `no_new_head` with `unstable` true, record the observation link with `base` and `head` both equal to `previousHead`, leave the cursor unchanged, stage no review, and replay that observation on restart. Byte-identical `0644` to `0600` to `0644` captures keep one tree id and follow the manifest blob, and two scans that differ only in full mode and whose second pair differs from `previousHead` are `unstable` and record the second mode. A root containing `dir/file`, a path containing an embedded line feed, and the empty-directory exclusion are the Snapshot Chain acceptance cases in [Workspace Synchronization](20260703-workspace_synchronization.md).
- A `recovery_required` collection result carries core members `requestId`, `outcome`, and `cause`, with `outcome` equal to `recovery_required`, creates no review, and does not advance the cursor. A JSON collection result does not require `x-openkit-request-id`. A candidate body is the private-store Git binary diff from the accepted base to the head, followed by the `openkit-full-mode-delta` section when a full mode is added or changed. An unknown additive command member is ignored, and a duplicate core member is rejected before a scan. A baseline command carries `mode` equal to `baseline` and null `acceptedBase` and `previousHead`. Its success result carries `requestId`, `outcome` equal to `baseline`, and `head`, and no candidate bytes. A lost baseline result is unknown, and the next attempt is a new request, not adoption and not redelivery. `capture` keeps the existing pair members.

### Integration Checks

- One NanoCore and one NanoHost complete one bounded worker attempt from exact input reference through accepted Artifact or Workspace change evidence.
- One accepted Artifact version is materialized into a later Turn with the exact id, version, digest, origin, and Item or Review lineage.
- One Git-backed attempt may still clone or fetch a new empty target inside the Sandbox at the requested base. A retained dirty volume and an uncommitted or later chain head do not have to prove a clean initial `HEAD`. The return through the Workspace review path stays. NanoHost's one admitted Git interpretation is the read-only private-store scan.
- Interrupted upload, download, output submission, or acknowledgement does not duplicate output or infer review, apply, cleanup, or completion.
- Import becomes visible only through temp-file fsync and atomic rename before worker launch; a present `file.export` begins only after accepted `final_status`, which does not wait for process-group absence and does not gate the snapshot-chain scan, enters NanoHost-private staging after exact produced digest and length proof, one zero exit, and clean stream end, and reaches NanoCore-private staging only through verified fsync and atomic placement, while an optional absent export proves the exact secure leaf-absence predicate and creates no staging.
- Oversized output or stderr events, any nonempty stderr, every nonzero helper outcome except the one closed optional-absence signal, missing or duplicate exit, timeout, cancellation, mismatch, relay loss, and unclean completion fail or remain `unknown`, trigger bounded partial cleanup and the existing sandbox-delete-to-epoch-invalidation rule, and never replay the accepted effect.
- NanoHost-local paths, transfer sessions, sandbox handles, and residual files never become canonical storage or later-Turn authority.
- NanoCore performs no direct OpenShell, Gateway, container-runtime, sandbox, or execution-host filesystem effect in the target topology.

### Collection Acceptance Predicates

Collection rejects a command exceeding the nesting bound before effects, including when excess nesting occurs only in unknown additive content. Boundary checks admit each inclusive scan limit exactly and refuse excess with the resource-limit result; the duration check covers attachment resolution and completed candidate staging. Entry counting includes ignored names read from opened directories, excludes `.` and `..`, and never opens excluded `.git` subtrees. An oversized ignore file fails rather than removing its rules. Context-limit excess returns unavailable context without an invented commit. Physical usage includes retained and temporary objects across restart, and growth that would cross either free-space minimum is refused without eviction. Every scan-limit failure preserves retained bytes and Core-required pairs, stages no candidate, initializes no accepted base, and advances no cursor; cleanup failure is never claimed as success. Interrupting or failing protection publication at any boundary, then reopening, preserves the last complete required tree-and-manifest selection, including distinct manifests sharing one tree; partial objects or selections do not become available snapshots or Core cursors.

### V1 Acceptance Predicates

1. The deployment satisfies the small-deployment profile stated by `docs/specs/20260703-runtime_scheduling_scale.md` and the single configured container backend owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.
2. NanoCore remains the sole durable product, scheduling, permission, review, audit, and Workspace authority.
3. Every consumed input and accepted output has exact immutable identity, lineage, version or precondition, length, and digest proof appropriate to its owner.
4. NanoHost's one admitted Git use is the read-only private-store scan, which is none of publish, apply, merge, rebase, push, or pull-request. NanoHost cannot execute or interpret those operations. A worker can invoke Git or hosting operations only under their separate source, permission, approval, Vault, and network-policy contracts and cannot use them to bypass canonical Workspace review or apply authority. A new empty target may still be cloned or fetched inside the Sandbox. A retained dirty volume does not have to prove a clean initial `HEAD`. `no_new_head` is the no-change result when the second scan's snapshot pair equals `previousHead`, and that equality does not imply that the two scans agreed. When `unstable` is true, the observation link does not advance the cursor. An empty review candidate, with no content, path, file-kind, deletion, or supported permission delta against Core's accepted base, still records a changed capture and is not by itself `no_new_head`.
5. Large data uses native or bounded transfer outside control and semantic-route streams; only the exact fixed V1 file-data stream may carry file-effect bytes, the `workspace.collect` result, and the fixed Dockerfile input response on the authoritative outer physical connection, and it carries no control semantics.
6. Imported source versions retain exact durable lineage; continued work may reuse its own admitted retained volume without peer synchronization, destructive reset or automatic product acceptance.
7. Missing, stale, conflicting, interrupted, and unknown outcomes remain truthful and produce no automatic merge, replay, replacement, or winner.
8. No schema, service, state, test, or documentation implies a second NanoHost, second active slot, fleet, generic synchronization layer, shared writable filesystem, or universal Artifact abstraction.
9. One distinct fixed file-data stream on the authoritative outer physical HTTP/2 connection carries the V1 single-file effects, the `workspace.collect` result, and the exact `image.build/input` response with at most one active stream. The file effects retain the current authenticated Gateway client, ready sandbox, directional import inventory proof, output path-only declaration, NanoHost-produced export facts, successor-only correlation, and canonical NanoCore handoff; the Dockerfile carriage retains inline AEP/package lineage, empty-context independence, pre-build verification, failure-result-only successor recovery, and no refetch. Neither adds a control payload, slot or path for Dockerfile input, listener, credential, SSH or CLI surface, second connection, queue, journal, service, framework, or generic envelope.
10. Exact session admission precedes the canonical AEP import under `package-config` at `<agent-session-id>/config/package.json` then declared `worker-supply` files at `<agent-session-id>/supply/inputs/<resource-key>/<inventory-relative-path>`, and then all `context` imports at `<agent-session-id>/context/<inventory-relative-path>` beneath `/openkit/sessions`. The next `turn.start` binds those exact private references, the AEP Turn/snapshot, and the manifest `ctxpkg_<turnId>` identity. Two AgentSessions cannot receive the same input namespace; a successor Turn cannot inherit omitted prior files; failed import or cleanup cannot permit launch or automatic replay.

## Alternatives Considered

### Shared Writable Workspace Filesystem

Rejected because it would make locks, disconnects, partial writes, stale caches, and concurrent mutation part of product correctness while bypassing snapshot, review, and apply boundaries.

### General Synchronization Or Merge Layer

Rejected because Git, accepted object-store preconditions, Artifact expected versions, Material revisions, and Workspace apply already produce bounded owner-local outcomes. OpenKit needs exact handoff, not another conflict state machine.

### Bidirectional Rsync Or Mutagen As Authority

Rejected because watcher state, endpoint precedence, ignore rules, and tool-local conflicts are deployment behavior rather than durable work history. A tool may move bytes in one bounded path but cannot decide truth.

### Artifact As Universal Storage

Rejected because Artifact is a product-visible candidate output and handoff envelope, not the identity for repositories, mutable Materials, Workspace change sets, external objects, or transfer sessions.

### NanoCore As General Source Storage

Rejected. Bounded product records and Artifacts remain with their existing owners, repository text and code use an external Git service, and large static source data uses an accepted external object-store source. NanoCore records references and lineage rather than hosting those storage services.

### Direct Sandbox-To-Sandbox Handoff

Rejected because it couples lifetimes, bypasses durable review and lineage, and turns residual runtime state into hidden authority.

## Consequences

### Benefits

- Worker compute and durable product storage can be operated independently without creating a new data platform.
- Existing Git, Artifact, Material, Workspace, review, and audit owners remain authoritative.
- Cross-Turn and cross-Agent handoff is exact, inspectable, and reproducible.
- Large-data growth does not overload worker-control or NanoHost control/readiness streams, and the fixed file-data stream remains within its one-stream and flow-control ceilings.
- A future second NanoHost can reuse immutable data references without changing product truth.

### Costs

- Every selected native source and transfer path needs explicit version, digest, authentication, retry, and failure behavior.
- Remote execution adds transfer latency and may produce more interrupted or unknown outcomes.
- Output is not canonical until its existing review and apply owner accepts it.
- Stronger locality or residency claims require separate evidence for every data and provider path.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| NanoHost-local state becomes canonical | Require exact import through existing owners and prohibit later-Turn use of residual paths or handles. |
| Native source changes during work | Bind exact commit, version, ETag, expected base, or digest and return the owner-local stale outcome. A worktree that changes during the two scans is `unstable` on the Workspace synchronization link, and the next link starts from that head. |
| Transfer tool becomes a collaboration owner | Persist only existing record identities, digests, and outcomes; discard transfer-session state. |
| Bulk data overloads control | Keep bytes outside control and semantic-route streams, reserve only the exact one-stream V1 file-data exception for the two file effects, the `workspace.collect` result, and fixed Dockerfile input on the outer physical connection, and keep the unchanged 512 KiB control ceiling plus bounded references and metadata. |
| Artifact replaces Workspace apply | Require Workspace synchronization for canonical mutations even when an Artifact presents the candidate. |
| Secret leaks through transfer metadata | Use non-secret references, governed retrieval, redaction, and exact path scopes. |
| Scope grows into fleet or storage infrastructure | Keep one NanoHost and one slot; require measured need and a separate accepted owner for expansion. |

## Open Questions

There are no blocking design questions in this accepted boundary. Each optional native source or transfer mechanism must have its own accepted contract before use and is not implied by this specification.

## Deferred / Future Work

- A second independent NanoHost after a measured capacity, network, compliance, locality, or blast-radius need exists.
- Explicit manual target selection before any dynamic placement or fleet policy.
- External Artifact payload storage after the Artifact owner defines locator, digest, permission, retention, export, deletion, and recovery semantics.
- An object-store adapter after a measured payload exceeds the bounded Git or bundle path and the exact provider semantics are accepted. The private Git object store used by the scan is not this adapter and is not the deferred external Artifact payload storage above.
- One-way rsync or deployment-managed Mutagen after measured transfer cost justifies its path, authentication, version, and cleanup contract.
- Automatic merge, rebase, live filesystem collaboration, CRDT, or operational transformation only under a separate accepted architecture with a concrete multi-writer requirement.
- Strong data-residency profiles and remote attestation when a deployment requires stronger proof than the configured-operator trust boundary.

Deferred work is non-authorizing and creates no current schema, service, state, dependency, runner, harness, configuration, or compatibility obligation.

## Links

- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/core/storage.md`
- `docs/core/communication.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260713-work_resource_interaction_model.md`
