---
status: Accepted
implementation: Not Started
date: 2026-08-01
updated: 2026-09-06
---
# NanoHost Workspace Data Boundary

## Owns

- The separation between NanoCore durable product authority and one independently deployed NanoHost that performs already-authorized worker execution.
- The logical boundary between canonical OpenKit storage, NanoHost-local disposable materialization, native data-system authority, and non-authoritative byte transfer.
- The use of exact remote Git commits, Artifact versions, and external object versions or digests as cross-boundary inputs and outputs.
- The direction of input materialization, output collection, Artifact review, Workspace synchronization review, and later-Turn handoff.
- The import-only non-workspace `package-config` identity, its AgentSession-private destination, and its order before Context Package imports and `turn.start` after exact session admission.
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

NanoCore remains the only durable authority for Workspace, Thread, Turn, Item, AgentSession, scheduler, permission, Vault, audit, review, and canonical OpenKit storage. One configured NanoHost performs already-authorized runtime effects and holds only disposable materializations, caches, scratch state, transient transcripts, and backend-private evidence.

The separation is logical first. It does not require a third storage service, shared writable filesystem, general file-synchronization engine, or new universal data record. Native systems retain their own authority: Git owns commits and repository merge behavior; a specifically accepted object-store contract owns its object bytes and version preconditions; OpenKit Artifact, Material, and Workspace synchronization owners retain product review and apply authority.

Data crosses the boundary through exact immutable references and bounded owner-specific transfer. A later Turn receives an exact reviewed Artifact version, remote Git commit, or external object version through a fresh materialization. Running sandboxes do not synchronize directly with each other and do not write canonical Workspace state.

Large bytes remain outside NanoCore-to-NanoHost control, readiness, and semantic-route streams. Native transfer paths carry their own bytes, while the exact V1 single-file effects and fixed Dockerfile input use one distinct fixed file-data stream on the same authoritative physical HTTP/2 connection; sharing that connection grants the data stream no control semantics or authority.

The current release runs the small-deployment profile whose canonical counts are stated by `docs/specs/20260703-runtime_scheduling_scale.md`, together with the single-backend boundary owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`. This specification depends on both boundaries rather than restating either, because they are what prevents a data-separation design from silently becoming a fleet, collaboration, or multi-writer platform.

## Goals / Non-goals

### Goals

- Let NanoCore and execution infrastructure be placed, sized, replaced, and operated independently without changing product authority.
- Keep one durable attempt identity across authorization, execution, output collection, review, and terminal projection through existing owners.
- Materialize immutable inputs into a disposable NanoHost-local environment and return exact reviewable output.
- Reuse Git for repository history and merge behavior rather than duplicating it in OpenKit.
- Reuse existing Artifact versions and reviews for inspectable product-level handoff between Turns.
- Reuse existing Material and Workspace synchronization owners when output may mutate canonical Workspace state.
- Require external object storage when static source data exceeds the accepted bounded NanoCore record, upload, Artifact, evidence, or handoff owner instead of expanding NanoCore into bulk storage.
- Keep transfer tools as byte movers with no product, version, review, merge, or publication authority.
- Preserve truthful missing, stale, conflict, interruption, and unknown outcomes without automatic merge or replay.

### Non-goals

- Do not build a shared writable Workspace filesystem, distributed filesystem, CRDT, operational transformation layer, or general collaboration substrate.
- Do not implement bidirectional synchronization between running sandboxes and canonical storage.
- Do not let NanoHost execute Git or hosting operations. A worker may push or create a pull request only through the Git source, permission, approval, Vault, and network-policy owners; that action never gains authority from this data boundary.
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

The NanoHost is trusted to materialize exact bounded owner-declared files and collect exact outputs, but it is not a product Agent, scheduler, permission owner, Workspace owner, review owner, storage authority, workflow engine, or general job runner. Git and hosting clients run inside the Sandbox; NanoHost only enforces the resolved network policy and MUST NOT parse Git data, select repository revisions, execute Git commands, hold Git credentials, or interpret clone, fetch, push, branch, or pull-request semantics. It also does not normalize collected output into product records and does not accept them; those are separate jobs with separate owners under `docs/specs/20260629-worker_runtime_communication_model.md`.

### Canonical OpenKit Storage

Canonical OpenKit storage contains durable Workspace, Thread, Turn, Item, Artifact, Material, review, policy, audit, scheduler, and related product truth under their existing owners.

Only an existing owner may create or mutate those records. A NanoHost report, transfer completion, local path, backend handle, or native source observation does not become canonical merely because NanoCore receives it.

### NanoHost-Local Runtime Storage

NanoHost-local runtime storage contains disposable materializations, caches, scratch files, temporary bundles, transcripts awaiting accepted transfer, backend state, and process-local evidence. The caches it may hold are caches of content it retrieved or produced, never of authority it was granted.

It is not canonical Workspace, Artifact, Material, knowledge, review, or work history. It may be discarded at AgentSession or Runtime Epoch cleanup according to the runtime owner. Any evidence required after cleanup must first be imported into an existing durable owner.

### Native Data Systems

Native data systems include Git repositories, specifically accepted object stores, uploads, provider file systems, and other sources selected by an existing Workspace data-source contract.

Git remains authoritative for commits, refs, ancestry, patches, merge behavior, and repository conflicts. An object store remains authoritative only for the byte, version, checksum, retention, and conditional behavior explicitly guaranteed by its accepted source contract.

OpenKit records the exact reference and lineage used by one attempt, but it does not duplicate the native system's internal semantics.

### Excluded: Sandbox Image Content

Sandbox image content is not Workspace data, not a Workspace data source, not Material, not an Artifact, and not a cross-boundary product input under this specification. Retrieving image content from a declared registry, building it from an authorized build definition, storing it, and importing it into an epoch are NanoHost-local runtime concerns owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`, and image content authority remains with the image owners.

The only property this specification requires of image content is the one it requires of every cross-boundary input: by the time a worker consumes the bytes, they are identified by an exact immutable digest. How an authored reference reaches that digest, and which reference forms an author may use, belong to the image and manifest owners; resolution to a digest happens at the runtime owner's acquisition boundary.

### Transfer Mechanisms

Transfer mechanisms include bounded HTTP upload or download, OpenShell file transfer, tar, Git native transfer, rsync, and a narrowly accepted deployment-managed Mutagen session.

They own byte movement only. A transfer session, local path, watcher history, endpoint precedence, retry cursor, archive, temporary URL, or backend handle MUST NOT become product identity, version authority, Workspace truth, review evidence by itself, or conflict winner.

### V1 Single-File Effect Transfer

V1 `reference.import` moves exactly one regular file of at most 256 MiB, and `file.export` either moves exactly one such file or returns the one exact optional-absence result defined below. Both directions bind one deterministic existing-attempt/effect-lineage `requestId`, one admitted package identity, and one normalized UTF-8 path relative to that identity. Workspace inputs and outputs use an exact declared package slot; the sole exception is the import-only non-workspace identity `package-config` defined below. An import additionally predeclares the exact byte length and lowercase SHA-256 from its immutable source; an export command declares only the output slot, relative path, fixed maximum, accepted terminal/process-group barrier proof, and closed `presence` literal `required` or `optional`, while NanoHost computes the actual byte length and lowercase SHA-256 from a produced file. NanoCore selects `optional` only when the existing semantic owner defines absence as a valid no-output outcome; the current selection is solely `/openkit/session/workspace-changes.json`, whose producer writes it only when changes exist. Every other export is `required`. An absolute, empty, traversing, non-normalized, adjacent, undeclared, symlink, hard-link, directory, archive, device, FIFO, socket, or oversized input or output is rejected before private admission.

The third fixed use of that outer reservation is not a workspace file effect: it carries the exact inline AEP Dockerfile for the already-pending `image.build` operation before any build root or backend effect. Its nonempty UTF-8 bytes, lowercase SHA-256, and length from 1 through 268,435,456 remain the AEP owner's immutable package lineage; this boundary creates no slot, path, file identity, context entry, locator, transfer handle, or second Dockerfile record. The exact empty-context singleton and its independent digest remain unchanged.

The selected byte mechanism is the pinned stock `ExecSandboxInteractive` typed RPC on the existing NanoHost-to-Gateway authenticated mTLS channel and current ready sandbox. NanoHost selects one fixed image-owned helper and fixed arguments for the operation; NanoCore, the package, configuration, and worker cannot select an executable, environment, working directory, timeout, SSH field, endpoint, or alternate command. The mechanism relies on the governed worker-image launch/helper prerequisite referenced by `docs/specs/20260721-worker_execution_environment_images.md`; a selected image that cannot satisfy that fixed prerequisite fails before worker launch, without a helper selector, uploaded fallback executable, shell fallback, CLI path, or image-specific command.

After the runtime owner proves `session.open` or exact reuse inspection, the first Turn import is NanoCore-owned canonical AEP bytes under `package-config`, relative path `<agent-session-id>/config/package.json`, and destination `/openkit/sessions/<agent-session-id>/config/package.json`. NanoCore derives the path from the admitted AEP AgentSession identity; the installed helper accepts only one nonempty `[A-Za-z0-9_-]+` identity segment and that exact suffix beneath its fixed `/openkit/sessions` root. The body, lowercase SHA-256, byte length, and deterministic request identity follow the AEP owner's canonical byte algorithm. This identity is import-only and is not a declared workspace slot, Context Package entry, output, Artifact, snapshot, configuration selector, or general file destination. Adjacent paths, export, caller-selected roots, and an existing destination are rejected. NanoHost validates canonical carriage and local placement without acquiring a second AgentSession authority.

The remaining Context imports come from the prepared immutable root named `context_<turnId>`. `WorkerContextPackageFiles` supplies exact bytes and a sorted `fileInventory` of package-relative path, byte length, and digest; the package-root digest binds that inventory. The backend matches the generated AEP input to NanoCore-private `workspaceRoots`, accepts only regular files, recomputes the inventory and root digest, and imports each file after the AEP and before `turn.start`. The `context` slot uses the same fixed `/openkit/sessions` effect root with the disjoint relative shape `<agent-session-id>/context/<inventory-relative-path>`, reaching only that AgentSession's Context root. The runtime owner clears the complete prior Turn input slots before reuse; per-file replacement cannot preserve omitted files. Host source paths, archives, mutable locators, and other source kinds never cross the wire.

NanoHost completely receives each import into request-private staging and verifies its declared length and digest before invoking `ExecSandboxInteractive`. It then sends stdin chunks of at most 64 KiB, and the fixed helper completes its request from the exact declared length without waiting for request EOF. The helper creates a request-scoped temporary regular file in the final declared directory without following symlinks, accepts at most 256 MiB, writes in chunks of at most 64 KiB, recomputes the declared length and lowercase SHA-256, fsyncs the temporary file, and atomically renames it to the final path; a partial or mismatched body never reaches the sandbox, and the worker cannot launch or observe the final path before that rename. NanoHost keeps the interactive request sender open through exactly one Exit and clean response completion and drops it only after settlement; it never sends request EOF before the response settles.

For `file.export`, the AEP output declaration owns only the output id, normalized path, registration posture, and retention; it contains no expected digest or length. Transfer starts only after the existing owning worker terminal and process-group barrier. The helper opens exactly one declared regular file without following symlinks and emits writes of at most 64 KiB; NanoHost rejects any stdout or stderr event larger than 64 KiB, any nonempty stderr, or aggregate stdout beyond 256 MiB, computes the actual lowercase SHA-256 and byte length, and atomically admits the complete file into request-private NanoHost staging. NanoCore then receives the result into request-private staging, verifies those actual facts, fsyncs and atomically places it, and only then hands the bytes to an existing canonical owner. For an `optional` export only, the helper may instead report absence when the slot root and every parent have passed the same no-follow directory checks and the final leaf lookup alone returns exact `ENOENT`; the unique signal is exit status `2` with empty stdout, empty stderr, exactly one exit, and clean response completion, creates no staging file or digest, and does not delete or fence the Sandbox. Exit status `0` means present, including a zero-byte file. A missing parent, `ENOTDIR`, symlink, directory, hard link, permission or I/O failure, inode drift, oversized file, helper contradiction, `required` missing leaf, any other nonzero exit, any output accompanying exit `2`, or unclean completion remains a failed or uncertain export. The existing transcript or output manifest supplies classification: verified bytes may enter `WorkerTranscriptPayload.artifactFiles` through `importWorkerTranscript`, or the existing Workspace output-manifest and change-set path, while exact optional absence yields no candidate Workspace change record. A missing or contradictory declaration is rejected, and the AEP path envelope creates no Artifact, media, review, Workspace, or publication authority.

### Fixed Outer File-Data Carriage

The same authoritative NanoHost-client-to-NanoCore-server physical HTTP/2 connection carries one distinct fixed logical file-data stream. At most one file-data stream is active across `reference.import`, `file.export`, and `image.build/input`; of the two existing outer NanoHost control/readiness reservations, one remains control/readiness-only and one is the file-data reservation. The existing outer maximum of 16 streams, 256 KiB per-stream receive window, 5 MiB connection receive window, 1 MiB worker-control headroom, and 512 KiB control ceiling remain unchanged. Each application send and each consumption release is at most 64 KiB; HTTP/2 frame splitting or coalescing changes none of these limits.

On every fixed file-data request or response, each required OpenKit application header appears exactly once and its value is validated against the accepted request and effect identity plus the applicable slot, path, digest, declared length, observed length, and body facts. Every required HTTP representation header remains exact and single-valued; a missing or duplicate required header or an HTTP/2-invalid header block fails closed. Legal additional HTTP transport or representation headers carry no authority and are ignored.

The import command poll remains `POST /api/nanohost/transport/effects/reference.import` with exact body `{}`. It returns `204` when no import is pending or `200 application/octet-stream` with an exact `content-length` and the required metadata headers `x-openkit-request-id`, `x-openkit-slot`, `x-openkit-relative-path`, `x-openkit-sha256`, and `x-openkit-byte-length`. The request id is lowercase 64-hex; slot is either the exact literal `package-config` for its one import or an exact declared workspace package slot; relative path is normalized UTF-8 identity-relative text encoded per segment with uppercase `%HH`, literal `/`, and at most 4096 encoded bytes; digest is lowercase `sha256:<64hex>`; byte length is canonical decimal from `0` through `268435456` and equals both `content-length` and observed bytes. Decoding rejects absolute, empty, backslash, dot, dot-dot, empty-segment, NUL/control, non-UTF-8, and noncanonical encoding. After sandbox atomic placement, NanoHost submits the existing bounded JSON result to `/api/nanohost/transport/effects/reference.import/result`; it never echoes file bytes there.

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

For every worker attempt, NanoCore resolves exact existing authority into immutable references and bounded descriptors. The NanoHost materializes those inputs into disposable local storage, runs the worker under the separate runtime specification, collects bounded output, and returns exact digests, manifests, and transfer results to the existing Artifact, Material, Workspace synchronization, Item, and audit owners.

The target flow is:

```text
canonical OpenKit records and native source authority
  -> exact Git commit, Artifact version, object version, or bounded bundle descriptor
  -> one-way NanoHost-local materialization
  -> bounded worker execution
  -> staged native output plus exact digest and lineage
  -> Artifact Review, Material revision, or Workspace Sync Review
  -> optional apply by the existing owner
  -> later Turn receives the accepted exact version
```

No running sandbox receives a hot update from another sandbox. No sandbox publishes directly to canonical storage. No transfer success implies review acceptance, Workspace apply, Turn completion, or runtime cleanup.

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

Repository packs, Workspace trees, Artifact bodies, object payloads, media, model assets, image archives, and other large bytes MUST NOT travel through NanoHost control, readiness, worker-control, inference, or capability streams. The exact V1 file effects and fixed Dockerfile input are the sole exceptions at the physical-connection level: one fixed file-data stream on the same authoritative outer HTTP/2 connection carries only the directional bodies and metadata defined above.

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

After NanoHost has produced a complete verified export result, uncertain delivery may resubmit on an authoritative successor only one of two closed results without rerunning sandbox export: the exact present request id, slot, path, actual length, digest, complete body, attempt lineage, and destination precondition, or the exact proved optional-absence JSON `{"requestId":"<requestId>","state":"absent"}`. NanoCore may acknowledge the identical already-complete present staging tuple or optional-absence result with `204`; a changed duplicate fails with `409`. No same-generation automatic retry is permitted. This is result delivery, not logical-effect replay, and it neither creates a second output nor silently overwrites the first.

## Cross-Turn And Cross-Agent Handoff

A later worker Turn consumes an exact accepted Artifact version, Git commit, object version, Material revision, or Workspace snapshot through a new input descriptor and fresh NanoHost-local materialization.

The handoff remains mediated by durable OpenKit and native source authority. Sandboxes do not synchronize directly, share a writable directory, exchange backend handles, or treat a previous sandbox's residual filesystem as input truth.

Multiple agents may collaborate by producing and reviewing exact durable outputs under existing product records. This specification does not add a collaboration state machine, shared memory, multi-writer filesystem, or universal resource layer.

## Lifecycle And Failure Semantics

### Create

NanoCore records the existing work and lease authority, resolves exact input references, and creates any required existing Artifact, Material, Context Package, or Workspace synchronization records before effectful transfer or execution.

The NanoHost creates only disposable materialization and transfer state. A transfer mechanism may create temporary native artifacts only when its owner defines their expiry and cleanup; those artifacts do not become product authority.

For the build form, fixed `image.build` metadata, exact `image.build/input` verification, local build, and the unchanged JSON result settle before `sandbox.create`; this input sub-carriage creates no independent lifecycle step. The runtime owner orders Sandbox creation and bridge readiness before exact `session.open` or reuse inspection, then canonical AEP import, every Context inventory import, and `turn.start`. The accepted terminal/process-group and Turn-input cleanup barriers settle before reuse; required exports and canonical collection retain their existing owners. Exact session close preserves compatible siblings, while uncertain cleanup follows the existing wider fence. Sandbox teardown remains `bridge.close` then `sandbox.delete` when that wider lifecycle is required. No later step may be reported complete while an earlier applicable barrier remains unknown.

### Update

Input authority is immutable for one attempt. A changed branch, object, Artifact, Material, or Workspace version requires a new authorized descriptor and, when execution is required, a new Turn or attempt under its existing owner.

Output updates create new versions or change-set evidence through the existing owner. The NanoHost does not mutate an already accepted immutable version.

### Terminate And Retain

After accepted output disposition and runtime cleanup, NanoHost-local materialization and temporary transfer state are removed according to their existing owners.

Every completed, failed, cancelled, timed-out, or uncertain single-file effect removes its request-private partial staging when locally reachable. NanoHost also removes every partial Dockerfile input on rejection and removes verified request-private input through existing build-root cleanup; NanoCore removes retained pending Dockerfile bytes when exact success or failure settles, the existing owner explicitly aborts the attempt, or lifecycle cleanup destroys it. An import does not permit worker launch until atomic admission succeeds; an export admits no canonical result until the terminal barrier and complete local proof succeeds.

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
- A stale Git commit expectation, object precondition, Artifact expected version, Material base, or Workspace apply base returns the existing native or owner-local stale or conflict outcome.
- Digest, length, path, version, origin, lineage, or destination disagreement fails closed and preserves any candidate only as non-authoritative evidence.
- Transfer interruption does not prove absence, completion, review, apply, runtime cleanup, or Turn completion.
- An unavailable native system or transfer mechanism blocks or interrupts the exact attempt; the NanoHost does not substitute a weaker authority form or copy from unverified local residue.
- Missing fixed helper support, a non-regular or symlinked source or destination, an invalid package identity or relative path, an adjacent or export use of `package-config`, an oversized file or event, a nonzero terminal result other than exact optional absence, an ambiguous terminal result, stderr, digest or length disagreement, or unclean RPC completion fails the exact effect without fallback or replay.
- A retry never changes the immutable source, destination precondition, attempt identity, import digest, or already-produced export digest merely to obtain success.
- No conflict creates a NanoHost-owned merge, winner, settlement, or repair record.

## Security And Privacy

- Transfer authorization MUST be exact-attempt, exact-source, exact-destination, bounded, expiring where applicable, and independently revocable under the owning identity, permission, and Vault contracts.
- Secret values MUST NOT appear in input descriptors, Artifact payload metadata, transfer manifests, normal Workspace files, logs, or product diagnostics.
- Short-lived retrieval credentials remain outside the Agent Environment Package and worker prompt and are exposed only at the governed transfer boundary.
- NanoHost-local paths, raw host paths, mount handles, object-store temporary URLs, transfer session ids, container ids, and backend-private locators MUST NOT become public product fields.
- A transfer mechanism MUST NOT broaden the source or destination path envelope, follow path traversal, or grant the worker write access to canonical NanoCore storage.
- Data locality MUST be stated per selected native source, transfer path, model provider, and output destination; remote execution alone does not imply that all bytes remain in one private network.

## Current Implementation Projection

The separated NanoHost topology is implemented for the current NanoHost-only production path while this specification remains Partial for its broader declared data-source and reuse target.

Current OpenKit already has substantial receiver mechanisms: durable NanoCore product records, immutable Agent Environment Package snapshots, Artifact versions and reviews, Workspace synchronization records, session-static materialization, worker output manifests, Git-native workflows, and bounded OpenShell upload and download paths.

NanoCore retains product-record and canonical handoff authority but no longer performs execution-host lifecycle or data-materialization effects through Cell. NanoHost owns the current Runtime Epoch effects, fixed package-config and Context imports, path-only output exports, and verified byte movement.

The V1 single-file `ExecSandboxInteractive` mechanism is implemented and admitted by the eleven-root pin with the fixed helper, mTLS authorization, bounds, no-early-EOF terminal classification, cleanup, opaque internal-relay closure, closed required-or-optional `presence`, exact helper exit-`2` absence proof, same-path JSON result, and Workspace no-change projection. Every other missing export still fails. The fixed same-connection `image.build/input` outer carriage is implemented with byte-free control metadata, exact identity, digest, length and UTF-8 verification, and no refetch or replay.

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

- Every input binds one exact Git commit, Artifact version, object version or accepted digest, Material revision, Workspace snapshot, or bounded immutable bundle.
- Wrong identity, version, digest, length, path, origin, lineage, permission, or destination precondition fails before consumption or publication.
- Large data never traverses control, readiness, worker-control, inference, or capability streams; only the one fixed directional file-data stream may carry V1 file-effect bytes and the exact `image.build/input` Dockerfile response on the same authoritative physical connection.
- Each V1 file effect moves exactly one admitted regular file no larger than 256 MiB through the outer fixed file-data stream, except that an explicitly optional export may return only the exact no-follow leaf-`ENOENT` absence result, with the exact package-config identity or a declared workspace slot, a normalized identity-relative path, imported source digest and length or NanoHost-produced export digest and length, at-most-64-KiB application chunks or helper writes, and no caller-selectable executable or SSH surface.
- The fixed `image.build/input` subpath carries exactly the accepted pending operation's 1-through-268,435,456-byte inline UTF-8 Dockerfile with matching request identity, declared and observed lengths, and lowercase SHA-256 in at-most-64-KiB consumption releases; it carries no slot, path, locator, context, arguments, result, second record, or generic envelope and is completely verified before any build effect.
- After exact session admission, the canonical AEP is the first Turn import into `/openkit/sessions/<agent-session-id>/config/package.json`, followed by the complete private Context inventory and only then `turn.start`. Adjacent paths, exports, pre-existing destinations, changed bytes, or uncertain admission block launch without replay; cleanup and fencing remain with the runtime owner.
- A data-transfer credential cannot authenticate NanoHost control, worker control, inference, capability, readiness, review, or terminal-status traffic.
- Import is never replayed after sandbox admission; an identical complete verified export result may be redelivered only on an authoritative successor where the owner permits it, and a conflicting duplicate changes nothing.
- Native and owner-local stale or conflict outcomes create no NanoHost merge, retry, winner, or settlement state.

### Integration Checks

- One NanoCore and one NanoHost complete one bounded worker attempt from exact input reference through accepted Artifact or Workspace change evidence.
- One accepted Artifact version is materialized into a later Turn with the exact id, version, digest, origin, and Item or Review lineage.
- One Git-backed attempt clones or fetches an authorized network-addressable repository inside the Sandbox, proves the exact base commit and clean initial `HEAD`, and returns through the existing patch or Workspace review path without NanoHost interpreting Git.
- Interrupted upload, download, output submission, or acknowledgement does not duplicate output or infer review, apply, cleanup, or completion.
- Import becomes visible only through temp-file fsync and atomic rename before worker launch; a present export begins only after the worker terminal/process-group barrier, enters NanoHost-private staging after exact produced digest and length proof, one zero exit, and clean stream end, and reaches NanoCore-private staging only through verified fsync and atomic placement, while an optional absent export proves the exact secure leaf-absence predicate and creates no staging.
- Oversized output or stderr events, any nonempty stderr, every nonzero helper outcome except the one closed optional-absence signal, missing or duplicate exit, timeout, cancellation, mismatch, relay loss, and unclean completion fail or remain `unknown`, trigger bounded partial cleanup and the existing sandbox-delete-to-epoch-invalidation rule, and never replay the accepted effect.
- NanoHost-local paths, transfer sessions, sandbox handles, and residual files never become canonical storage or later-Turn authority.
- NanoCore performs no direct OpenShell, Gateway, container-runtime, sandbox, or execution-host filesystem effect in the target topology.

### V1 Acceptance Predicates

1. The deployment satisfies the small-deployment profile stated by `docs/specs/20260703-runtime_scheduling_scale.md` and the single configured container backend owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.
2. NanoCore remains the sole durable product, scheduling, permission, review, audit, and Workspace authority.
3. Every consumed input and accepted output has exact immutable identity, lineage, version or precondition, length, and digest proof appropriate to its owner.
4. NanoHost cannot execute or interpret publish, apply, merge, rebase, push, or pull-request operations. A worker can invoke Git or hosting operations only under their separate source, permission, approval, Vault, and network-policy contracts and cannot use them to bypass canonical Workspace review or apply authority.
5. Large data uses native or bounded transfer outside control and semantic-route streams; only the exact fixed V1 file-data stream may carry file-effect bytes and the fixed Dockerfile input response on the authoritative outer physical connection, and it carries no control semantics.
6. A later Turn receives an exact durable version through fresh materialization rather than sandbox-to-sandbox synchronization or residual runtime state.
7. Missing, stale, conflicting, interrupted, and unknown outcomes remain truthful and produce no automatic merge, replay, replacement, or winner.
8. No schema, service, state, test, or documentation implies a second NanoHost, second active slot, fleet, generic synchronization layer, shared writable filesystem, or universal Artifact abstraction.
9. One distinct fixed file-data stream on the authoritative outer physical HTTP/2 connection carries the V1 single-file effects and the exact `image.build/input` response with at most one active stream. The file effects retain the current authenticated Gateway client, ready sandbox, directional import inventory proof, output path-only declaration, NanoHost-produced export facts, successor-only correlation, and canonical NanoCore handoff; the Dockerfile carriage retains inline AEP/package lineage, empty-context independence, pre-build verification, failure-result-only successor recovery, and no refetch. Neither adds a control payload, slot or path for Dockerfile input, listener, credential, SSH or CLI surface, second connection, queue, journal, service, framework, or generic envelope.
10. Exact session admission precedes the canonical AEP import under `package-config` at `<agent-session-id>/config/package.json` and then all `context` imports at `<agent-session-id>/context/<inventory-relative-path>` beneath `/openkit/sessions`. The next `turn.start` binds those exact private references, the AEP Turn/snapshot, and the manifest `ctxpkg_<turnId>` identity. Two AgentSessions cannot receive the same input namespace; a successor Turn cannot inherit omitted prior files; failed import or cleanup cannot permit launch or automatic replay.

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
| Native source changes during work | Bind exact commit, version, ETag, expected base, or digest and return the owner-local stale outcome. |
| Transfer tool becomes a collaboration owner | Persist only existing record identities, digests, and outcomes; discard transfer-session state. |
| Bulk data overloads control | Keep bytes outside control and semantic-route streams, reserve only the exact one-stream V1 file-data exception for the two file effects and fixed Dockerfile input on the outer physical connection, and keep the unchanged 512 KiB control ceiling plus bounded references and metadata. |
| Artifact replaces Workspace apply | Require Workspace synchronization for canonical mutations even when an Artifact presents the candidate. |
| Secret leaks through transfer metadata | Use non-secret references, governed retrieval, redaction, and exact path scopes. |
| Scope grows into fleet or storage infrastructure | Keep one NanoHost and one slot; require measured need and a separate accepted owner for expansion. |

## Open Questions

There are no blocking design questions in this accepted boundary. Each optional native source or transfer mechanism must have its own accepted contract before use and is not implied by this specification.

## Deferred / Future Work

- A second independent NanoHost after a measured capacity, network, compliance, locality, or blast-radius need exists.
- Explicit manual target selection before any dynamic placement or fleet policy.
- External Artifact payload storage after the Artifact owner defines locator, digest, permission, retention, export, deletion, and recovery semantics.
- An object-store adapter after a measured payload exceeds the bounded Git or bundle path and the exact provider semantics are accepted.
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
