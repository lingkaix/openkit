# Workspace Synchronization

Status: Accepted
Implementation: Partial

## Owns

This spec owns the backend-portable workspace synchronization contract for
worker-agent work:

- workspace input snapshotting
- worker workspace materialization
- turn-dynamic population of predeclared workspace slots
- backend transport boundaries
- worker output collection
- workspace change sets
- staged workspace review
- review-gated apply
- apply preflight
- restart recovery and reconciliation
- workspace synchronization evidence

It is the canonical active spec for `WorkspaceInputSnapshot`,
`WorkspaceMaterializationRecord`, `BackendWorkspaceHandle`,
`WorkerOutputManifest`, `WorkspaceChangeSet`, `StagedWorkspaceReview`,
`WorkspaceApplyPlan`, `WorkspaceApplyResult`,
and `WorkspaceReconciliationRecord`. Workspace synchronization evidence uses automatic general `EvidenceBundle` producers, product-safe refs and digests on lifecycle records, and recovery-required bundle ids on `WorkspaceReconciliationRecord` rather than a parallel synchronization-specific bundle record.

## Does Not Own

This spec does not own general worker runtime communication, the worker control
protocol, full Git hosting integration, external domain-system writeback,
general storage hierarchy, Action Center UI layout, vault credential storage,
agent capability routing, session-static workspace layout, session compatibility
keys, or backend-native file-transfer protocols.

Backend adapters may use OpenShell, Docker, remote VMs, managed sandboxes, Git,
tar streams, rsync, provider file APIs, object storage, or host-local staging
roots. Those mechanisms are transport projections. They do not define product
truth, and host-local staging is not a product Worker Agent runtime.

## Core References

- `docs/core/storage.md`
- `docs/core/sandbox.md`
- `docs/core/audit.md`
- `docs/core/agent-workflow.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/core/permissions.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`

## Summary

OpenKit needs a backend-portable way to materialize a workspace into a worker
runtime, collect worker changes back from that runtime, stage those changes for
review, apply approved changes, and recover safely after NanoCore or backend
restart.

The durable decision is that workspace synchronization is a NanoCore-owned
contract, not an OpenShell-only feature and not a backend-owned transport detail.

Worker writes never become workspace truth directly. Workers produce manifests,
patches, bundles, changed-file payloads, artifacts, logs, and evidence. NanoCore
verifies, stages, reviews, applies, and records results. If NanoCore or the
backend restarts, recovery resumes from NanoCore-owned records plus verified
collected evidence, not from backend runtime state alone.

A scheduler lease that is still inside its bounded `awaiting-reconnect` window is not yet a workspace-reconciliation trigger. Workspace collection, review staging, and teardown wait until exact process-key/lineage/sequence adoption continues the same worker or the scheduler selects the existing interrupted recovery path.

Git is the first optimized strategy because OpenKit's self-improvement loop uses
Git repositories. Git remains one strategy under the broader workspace
synchronization contract. Non-Git filesystem workspaces use content-addressed
snapshots, change manifests, staging, and conflict-checked apply.

## Background

The NemoClaw research loop showed that OpenShell can provide useful sandbox
lifecycle, provider, policy, gateway, upload, download, and exec primitives. It
also showed that product-level repo-writing work cannot depend on backend file
copy alone.

The missing product boundary is explicit:

- what workspace state was given to the worker
- how that state became visible inside the worker runtime
- what the worker changed
- what evidence proves the change
- where changes are staged
- who approved applying changes
- how NanoCore recovers if worker, backend, or NanoCore state is interrupted

NanoCore owns workspace materialization records, change-set records, staged
review records, apply decisions, recovery state, and product-visible evidence.
Backends own transport and isolation.

The design is OpenShell-first in implementation, but OpenKit-owned in semantics.
OpenShell can provide the first rich transport and enforcement path without
becoming the canonical source of workspace truth.

## Goals / Non-goals

### Goals

- Define the canonical lifecycle for workspace input snapshotting, worker materialization, change collection, staged review, approved apply, and restart recovery.
- Keep NanoCore as the source of truth for workspace state, worker lineage, evidence, review gates, accepted changes, and recovery decisions.
- Let backends use native transport primitives without exposing backend internals as product contracts.
- Support Git repositories as the first implementation path for the OpenKit self-improvement loop.
- Support non-Git workspaces through filesystem snapshots, change manifests, staged review, and conflict-checked apply.
- Keep direct NanoCore worker control focused on metadata and small events instead of large file synchronization.
- Make synchronization reviewable, auditable, resumable, and safe across local mode, server mode, OpenShell, Docker, remote VM, and future managed sandbox backends.

### Non-goals

- Do not let sandbox workers directly push, deploy, publish, tag, or mutate protected branches.
- Do not make OpenShell the only materialization backend.
- Do not treat backend logs, paths, process ids, sandbox ids, gateway ids, provider handles, or file-transfer handles as public product identity.
- Do not expose raw host paths, provider secrets, raw environment values, or temporary credential material through product APIs.
- Do not require every backend to support every synchronization strategy.
- Do not replace Goal Mode, Action Center, artifacts, or review decisions with Git commit state.
- Do not implement unattended recursive self-modification.

## Decision

OpenKit uses a backend-portable workspace synchronization lifecycle:

```text
workspace input snapshot
  -> materialization plan
  -> compatible session layout selection
  -> backend materialized workspace
  -> worker execution
  -> worker output manifest
  -> collected workspace change set
  -> staged workspace review
  -> human or policy approval
  -> apply preflight
  -> approved apply
  -> apply result
  -> recovery or reconciliation when interrupted
```

NanoCore owns every lifecycle record. Backends implement lifecycle effects.

Restart handling consults the exact scheduler and worker-control outcome before synchronization acts. `awaiting-reconnect` preserves the existing materialization and backend handle without collection or teardown, exact adoption keeps using those same records, and key, lineage, sequence, or deadline failure enters the existing reconciliation lifecycle.

The materialization plan binds turn inputs to predeclared workspace slots when a reusable session already exists.

If a turn cannot fit the existing session's static workspace layout, provider envelope, policy envelope, or backend capability envelope, NanoCore must ask the agent-session/AEP layer for a replacement session before materializing the turn.

For Git repositories, the first strategy uses clone or fetch into the worker
runtime and collects a patch back into NanoCore. Git bundles may be added when
commit metadata preservation is needed, but patch-first review is the default.

For non-Git workspaces, the first strategy uses a content-addressed filesystem
snapshot, changed-file manifest, staged files, and conflict-checked file apply.

An accepted final status already persisted before restart resumes normal output collection and terminal handoff without another worker heartbeat because the worker-control contract makes it the last durable-output barrier after runtime provenance and workspace-change publication. Restart recovery calls the existing `BackendWorkspaceHandle`, `WorkerOutputManifest`, `WorkspaceReconciliationRecord`, review, evidence, backend cleanup, turn, lease, and capacity owners directly. Same lineage plus the same canonical digest and stable accepted timestamp is exact replay; a conflict fails closed. No settlement coordinator or second closeout workflow exists.

Durable synchronization records and read models replay exactly. App-local turn events are an ephemeral projection and may be delivered at least once if NanoCore crashes again after the durable writes but before event projection completes; this compromise does not change workspace truth or justify another durable workflow.

Workspace synchronization is review-gated by default. Direct remote push, tag,
deploy, publish, or protected-branch mutation is a separate explicit
human-approved action outside this spec's first apply contract.

## WorkspaceMaterializer Boundary

NanoCore should expose a `WorkspaceMaterializer` boundary with these conceptual
operations:

- `prepareWorkspace(input, sessionLayout) -> materializationPlan`
- `materializeToWorker(plan, backendSession) -> materializationRecord`
- `collectChanges(materializationRecord) -> workspaceChangeSet`
- `stageChanges(changeSet) -> stagedReview`
- `applyApprovedChanges(stagedReview, decision) -> applyResult`
- `reconcileWorkspaceSync(interruptedRecord) -> reconciliationRecord`

The boundary is implemented by backend-specific adapters, but the records it
returns use OpenKit vocabulary.

## Session Slots And Turn Materialization

Workspace synchronization owns per-turn content movement, not the canonical session-static workspace skeleton.

The session-static skeleton is owned by `docs/specs/20260704-session_static_workspace_materialization.md` and is represented by `SessionWorkspaceLayout`, `WorkspaceSlot`, and `SessionCompatibilityKey`.

This spec owns the records that populate, collect, review, apply, and recover slot contents for one turn.

Rules:

- `WorkspaceInputSnapshot` records what the turn intends to expose and which slot each input targets.
- `WorkspaceMaterializationRecord` records how those inputs became visible inside the selected session's declared slots.
- `WorkerOutputManifest` records changed files, artifacts, transcripts, logs, and evidence under declared output, worktree, session, and artifact slots.
- `WorkspaceChangeSet` is produced only after NanoCore verifies output manifests against the baseline slot manifests and policy.
- Backends may use bind mounts, copies, uploads, downloads, tar streams, rsync, Git checkout, provider file APIs, object-store staging, or future FUSE mounts, but those are transport projections rather than product truth.
- Direct worker control may announce slot materialization and output readiness, but large file payloads must move through backend data transport.
- A new static slot, static mount path, provider placeholder, working directory, image, user, group, or control endpoint requirement must be handled by session replacement before this spec's materialization step proceeds.

## Current Implementation Projection

The current implementation realizes the accepted base V1 synchronization behavior below. The active restart slice adds bounded awaiting-reconnect preservation, read-only existing-handle restoration, and direct terminal handoff through these owners.

- `packages/app-api-schemas/src/workspace-sync.ts` defines schemas for input snapshots, materialization records, backend workspace handles, worker output manifests, change sets, staged reviews, review patch payloads, and apply results.
- `apps/nanocore/drizzle/0010_workspace_sync_records.sql` persists input snapshots, materialization records, change sets, and staged reviews.
- `apps/nanocore/drizzle/0009_workspace_apply_results.sql` persists review-gated apply results.
- `apps/nanocore/drizzle/0011_workspace_filesystem_staging.sql` persists internal filesystem staging roots for accepted filesystem reviews.
- `apps/nanocore/drizzle/0045_workspace_backend_handles.sql` persists redacted backend workspace handles derived from materialization records.
- `apps/nanocore/drizzle/0046_worker_output_manifests.sql` persists worker-declared output manifests before reviewed change-set readback.
- `apps/nanocore/drizzle/0047_workspace_apply_plans.sql` persists accepted workspace apply plans before Git patch or filesystem staging mutation.
- `apps/nanocore/drizzle/0048_workspace_reconciliation_records.sql` persists restart recovery reconciliation records.
- `apps/nanocore/src/runtime/workspace-sync-records.ts` records and lists durable workspace synchronization review lineage, redacted backend workspace handles, and worker output manifests.
- `apps/nanocore/src/runtime/workspace-apply-plans.ts` records and lists durable workspace apply plans.
- `apps/nanocore/src/runtime/workspace-reconciliation-records.ts` records and lists durable workspace reconciliation records.
- `apps/nanocore/src/runtime/workspace-sync-records.ts` records one compact `EvidenceBundle` index and one normalized `RuntimeEvidence` row when a workspace materialization record is first stored, carrying backend readiness evidence and policy digest without raw backend payloads. It also records one linked workspace audit event and one compact `EvidenceBundle` index when a staged workspace review is first stored, and skips duplicate audit and evidence rows on review upsert.
- `apps/nanocore/src/runtime/workspace-materializer.ts` builds input snapshot and materialization records, parses worker change-set manifests, and stages change sets into pending reviews.
- `apps/nanocore/src/runtime/filesystem-workspace-sync.ts` implements content-addressed filesystem manifests, filesystem change-set comparison, staged copy, and conflict-checked apply.
- `apps/nanocore/src/app.ts`, `@openkit/core-client`, and `@openkit/mcp` expose workspace-sync read APIs, including redacted backend workspace handle, worker output manifest, workspace apply plan, and workspace reconciliation record readback, and NanoCore applies accepted Git patch or filesystem staging reviews through artifact review decisions.
- `apps/nanocore/src/runtime/workspace-apply-results.ts` records one linked workspace audit event and one compact `EvidenceBundle` index when a new durable apply result is stored, and skips duplicate audit and evidence rows on idempotent apply-result replay.
- `apps/nanocore/src/runtime/worker-governance-turn-executor.ts` imports worker workspace changes into review artifacts and durable records.
- Worker governance tests cover local and remote disposable-Cell OpenShell evidence persistence. The remote materialization and Cell-lifecycle path is active; the full real-Codex remote Goal Mode acceptance story remains required before remote provenance is accepted as complete.
- Server tests cover review listing, Git patch apply, filesystem staging apply, filesystem permission-change apply, and persisted apply results after app restart.
- `WorkspaceSynchronizationBackendKindSchema` still includes `host` for host-local staging and deterministic harnesses. It must not be read as permission to reintroduce host execution as a product Worker Agent runtime.

The implementation now persists redacted `BackendWorkspaceHandle` rows at materialization time and carries them through workspace export/import. `WorkspaceMaterializationRecord` and `BackendWorkspaceHandle` bind the owning AEP `packageSnapshotId` separately from the backend `workerSessionId`; terminal events, teardown, stale-lease recovery, and import reminting correlate by package lineage, while review persistence rejects missing materialization records instead of fabricating them from change sets. It also persists `WorkerOutputManifest` rows derived from collected change sets before reviewed change-set readback, exposes them through App API/Core Client/MCP, and carries them through workspace export/import. It persists `WorkspaceApplyPlan` rows before accepted Git patch or filesystem staging apply mutations, exposes them through App API/Core Client/MCP, and carries them through workspace export/import. It persists `WorkspaceReconciliationRecord` rows for recovery transitions, exposes them through App API/Core Client/MCP, and carries them through workspace export/import. It persists `WorkspaceQuarantineRecord` rows for isolated invalid synchronization material, exposes them through App API/Core Client/MCP, and carries them through workspace export/import. It automatically promotes materialization readiness evidence, staged review evidence refs, patch digests, and apply-result lineage into the general `EvidenceBundle` ledger, and no `WorkspaceSyncEvidenceBundle` schema, table, API, client or MCP projection, recovery input, or workspace export/import family remains. `WorkspaceReconciliationRecord.evidenceBundleIds` retains recovery-required bundle ids, lifecycle records retain their product-safe refs and digests, and `resume_collection` combines the reconciliation record with matching durable output manifests without requiring live backend reachability. Recovery-specific Action Center rows project `WorkspaceReconciliationRecord` rows in `requires-human`; `resume_collection`, `stage_verified`, `quarantine`, and `abandon` recovery decisions are executable through App API/Core Client/MCP. Terminal recovery decisions set the record retention decision to `teardown-backend`. Filesystem synchronization detects POSIX permission-only changes as `mode_changed`, carries old and new permission summaries on changed paths, records them in apply plans, applies accepted permission changes through the same reviewed filesystem staging path, and reports target path type conflicts during apply preflight before mutating the workspace. Binary changed paths carry artifact-only review presentation with digest, media type, byte size, summary, and typed staged-review diagnostics; binary payloads over 1 MiB use the same artifact-only presentation with an explicit payload-size reason. Worker-control terminal events move matching `BackendWorkspaceHandle` rows from `pending` to `retained`, while governed worker teardown later moves matching handles to `cleaned` after successful backend teardown or `failed` after teardown failure. Scheduler lease maintenance records `WorkspaceReconciliationRecord` recovery triggers when a stale lease still has pending backend workspace handles. The active restart slice preserves pending handles during `awaiting-reconnect`, continues the same handle after adoption, and resumes accepted final status through the ordinary collection and cleanup path. Object-store synchronization and richer multi-backend recovery orchestration remain deferred future work.

## Record Contract

Workspace synchronization uses workspace-owned records. Every record carries
workspace, thread, turn, agent session, package snapshot, backend summary, and
digest references where applicable.

`WorkspaceInputSnapshot` records what NanoCore intended to expose:

- workspace roots
- source repository refs
- included files
- generated task files
- object-store references
- artifact inputs
- context package id
- excluded paths
- writable roots
- base commit or content digest
- backend capability summary

`WorkspaceMaterializationRecord` records how the snapshot became worker-visible:

- backend type
- backend capability summary
- transport method
- materialized root refs
- mount refs
- upload manifest
- sandbox path summary, redacted
- policy digest
- start and ready timestamps
- evidence bundle ids

`BackendWorkspaceHandle` records backend-native transport handles that NanoCore
may need for recovery. It is not public product identity. It may include sandbox
labels, gateway labels, upload/download references, object-store keys, retention
mode, and cleanup status after redaction.

`WorkerOutputManifest` is the worker-side declaration of changed workspace
state. It describes changed files, added files, deleted files, binary files,
permission changes, generated artifacts, logs, test output refs, ignored
outputs, and digests.

`WorkspaceChangeSet` is the canonical reviewable unit. It includes changed paths,
patch refs, binary refs, permission summaries, delete markers, conflict base
digests, generated-file classification, worker rationale when available, and
evidence ids.

`StagedWorkspaceReview` records where NanoCore staged a change set for review. It
includes staging strategy, staging reference, optional review branch, diff
summary, risk summary, validation results, and Action Center row id.

`WorkspaceApplyPlan` records a preflighted apply attempt before mutation. It
includes baseline checks, path conflicts, binary overwrite risks, permission
change handling, policy checks, approval state, and planned writes.

`WorkspaceApplyResult` records the final accepted application. It includes
applied paths, skipped paths, conflict records, verification evidence, commit ids
when applicable, final status, and reviewer decision linkage.

`WorkspaceReconciliationRecord` records restart recovery. It includes:

- reconciliation id
- trigger reason
- affected lifecycle record ids
- last known backend handle summary
- backend reachability result
- collected output manifest ids
- evidence bundle ids
- state before reconciliation
- state after reconciliation
- quarantine refs when validation fails
- required human decision when evidence is partial
- cleanup or retention decision
- start and finish timestamps

Workspace synchronization MUST write general `EvidenceBundle` rows automatically at the lifecycle boundaries that own evidence production. `WorkspaceReconciliationRecord` MAY retain the bundle ids required by recovery; other lifecycle records retain their existing product-safe refs and digests. Workspace synchronization MUST NOT introduce a parallel synchronization-specific evidence schema, table, API, or export record family. Backend-native evidence remains referenced through product-safe refs and digests on the owning materialization, output, review, reconciliation, quarantine, apply, or general evidence records.

## State Model

Materialization states:

- `planned`
- `prepared`
- `uploaded`
- `mounted`
- `ready`
- `failed`
- `abandoned`

Collection states:

- `pending`
- `collecting`
- `collected`
- `verified`
- `partial`
- `failed`
- `quarantined`

Review states:

- `not-required`
- `staged`
- `awaiting-review`
- `approved`
- `rejected`
- `superseded`

Apply states:

- `planned`
- `preflighted`
- `applying`
- `applied`
- `conflicted`
- `failed`
- `rolled-back`

Recovery states:

- `not-needed`
- `needs-reconcile`
- `reconciling`
- `recovered`
- `requires-human`
- `unrecoverable`

`awaiting-reconnect` and exact adoption are scheduler and worker-control outcomes, not additional workspace reconciliation states. They gate whether this spec preserves the current lifecycle or starts reconciliation.

## Git Strategy

The Git strategy is the default path for Git repository workspace resources.

The worker should receive a clean checkout at the requested base commit. The
worker may write and commit inside the worker runtime, but the first implemented
review path collects the result into NanoCore instead of allowing direct push.

The preferred first Git output format is:

- `workspace-changes.json`
- a patch generated from `base..HEAD` or equivalent
- a changed-file list
- verification command output refs
- a concise worker summary item
- optional `git bundle` when preserving commit metadata is needed

NanoCore validates patch digest and byte count, runs `git apply --check`, and
applies an accepted patch to the linked repository with fixed Git arguments.

The first implementation records an empty `commitIds` list. Commit creation,
remote push, tags, deploys, and protected-branch mutation remain separate
human-approved actions.

GitHub write access should not be given to workers in the default path. If a
future workflow needs write access, it should use explicit ephemeral branch or
fork policy and still preserve NanoCore review gates.

## Non-Git Filesystem Strategy

The filesystem strategy handles directories or file collections that are not Git
repositories.

NanoCore creates a content-addressed snapshot manifest before worker execution.
The manifest includes relative path, file kind, size, digest, permissions
summary, writable flag, and ignore reason when excluded.

The backend materializes the selected snapshot into the worker runtime. After
execution, NanoCore compares a second manifest against the baseline to produce a
`WorkspaceChangeSet`.

NanoCore downloads changed files into a staging area rather than overwriting the
original workspace. Approved apply copies staged changes into the target
workspace using path allowlists and conflict checks.

Permission-only and `mode_changed` changes are not silently applied. Filesystem
staging has explicit reviewed POSIX permission-apply support. Other unsupported
permission changes must be rejected, blocked, or quarantined with reviewable
evidence.

Binary files and large files require summary, digest, media type, and explicit
review affordances. The exact artifact-only size threshold remains policy.

## Control Channel And Data Transport

Direct NanoCore worker control is for small messages: heartbeat, turn events,
approval state, artifact notices, change-set ready notices, and final status.

Backend-native data transport moves large payloads: repositories, patches,
bundles, logs, generated artifacts, changed files, raw transcripts, and evidence
exports.

Examples:

- OpenShell: `openshell sandbox upload`, `openshell sandbox download`, sandbox exec, and future file primitives.
- Docker: bind mounts, `docker cp`, tar streams, or container diff.
- Host worktree: direct filesystem operations in a temporary worktree or staging root.
- Remote VM: Git, rsync, tar over SSH, or artifact upload.
- Managed sandbox: provider file APIs.

The control channel may announce that `/openkit/session/workspace-changes.json`
is ready, but it should not carry full patches or file payloads except for small
metadata previews allowed by policy.

## Backend Capability Selection

The materializer selects a strategy from declared backend capabilities.

Useful capabilities include:

- `file-upload-download`
- `git-materialization`
- `change-set-collection`
- `network-policy`
- `provider-attachments`
- `credential-placeholder`
- `transcript-sink`
- `audit-export`
- `backend-service-readiness`

If a required capability is missing, NanoCore should fail before launch with a
redacted diagnostic and a suggested fallback.

If a capability is optional, NanoCore may choose a degraded or alternate strategy
only when the resulting review and evidence guarantees remain explicit.

Backend-specific evidence may enrich OpenKit records, but it must not replace
OpenKit records.

## OpenShell Backend Shape

The OpenShell materializer should:

- prepare a Git clone or filesystem snapshot under the sandbox workspace
- pass workspace metadata through the Agent Environment Package
- restrict writes to declared workspace roots and output roots through policy
- keep provider and GitHub credential injection explicit and audited
- collect `/openkit/session/workspace-changes.json`, patch files, bundles, artifact notices, logs, and final status during teardown
- record every gateway, sandbox, policy, upload, download, and file-transfer step as backend evidence

The OpenShell adapter compiles OpenKit-owned materialization plans into OpenShell-native artifacts and normalizes OpenShell evidence back into OpenKit-owned records. Public App API, end-user CLI, Action Center, and reviewer surfaces must not need OpenShell-native ids or YAML.

## OpenShell Codex Runtime Configuration

OpenShell Codex workers need the same effective Codex home that works on the
host.

For ChatGPT-account based Codex subscriptions, `auth.json` is injected only
through the vault-backed runtime-file path created by
`POST /api/app/vault/bootstrap/codex-auth-json`. Uploading a host `auth.json`
path directly is not supported.

The OpenShell backend may still upload the non-secret Codex config file so the
container uses the same model defaults as the host Codex CLI:

- `OPENKIT_OPENSHELL_CODEX_CONFIG_TOML`, copied to `/sandbox/.codex/config.toml`

The config path is runtime configuration and must not be exposed through public
App API or MCP responses.

The backend may also accept `OPENKIT_OPENSHELL_CODEX_MODEL` for deployments that
intentionally override the host Codex model, but the safest default is to
preserve the host Codex config that already works with the logged-in
subscription.

The OpenShell network policy must explicitly allow the Codex binary to reach the
OpenAI or ChatGPT HTTPS endpoints required by the configured account. The first
verified dogfood configuration allowed `api.openai.com`, `chatgpt.com`,
`chat.openai.com`, and `auth.openai.com` for `/usr/local/bin/codex` and
`/usr/local/lib/codex/bin/codex`.

Future production packaging should replace this deployment-local allowlist with
a named Codex provider endpoint profile.

## Generated Files And Object Store Inputs

Generated files can be:

- runtime-only files
- workspace change candidates
- artifacts
- both artifact and workspace change candidates

The worker must classify generated files. NanoCore may override classification
during import. If a generated file is user-facing output, it should be an
artifact. If it is intended to change the workspace, it should be part of a
change set. It can be both when the artifact is also the reviewed file to apply.

Object-store inputs should first use OpenKit-managed staged files unless a
backend-specific mount is required.

The first object-store target should be generic S3-compatible storage so R2, S3,
and compatible endpoints can share one provider profile.

Mount strategy options:

- sync-on-start staged files
- sync-on-demand through Agent Capability gateway projection
- backend FUSE or native mount

The first implementation should prefer sync-on-start or gateway-mediated read
for predictable review and recovery.

## Review And Apply

A worker step that produces changes should normally end in a review phase.
Action Center should show a row for the staged change set.

The human may accept, reject, refine, retry, decompose, or block.

Before applying, NanoCore must:

- verify workspace baseline still matches expected digests
- detect path conflicts
- detect binary overwrite risks
- detect unsupported permission changes and record supported permission changes
- re-run policy checks
- confirm approval state
- create an apply plan

Conflicts create a review item or apply result and do not silently merge.

The first Git-backed apply slice uses the artifact review decision route for
workspace synchronization review artifacts. When the human accepts a workspace
review artifact, NanoCore validates the collected patch payload against the
`WorkspaceChangeSet.patch` digest and byte count, runs `git apply --check`, and
then applies the patch to the linked repository.

The first filesystem apply slice uses a NanoCore-owned opaque staging registry.
Public review payloads expose only `filesystem-staging://...` references, while
NanoCore stores the internal staging root, target root, and before manifest in
private storage. Accepted filesystem reviews apply through conflict preflight and
apply reviewed POSIX permission changes when the changed path carries a
`newPermissions` summary.

## Recovery And Reconciliation

After NanoCore restart:

1. Load active materialization, worker session, review, staging, apply, and backend handle records.
2. Read the exact owning lease and worker-control recovery outcome.
3. If the lease is `awaiting-reconnect`, preserve the existing materialization and `BackendWorkspaceHandle` in their current nonterminal state; do not collect, stage review, create reconciliation, or tear down while the original worker may continue.
4. If exact adoption succeeds, keep the same materialization and backend handle. When final status arrives, run the ordinary output-manifest collection, verification, review, and cleanup flow for that same turn.
5. If durable accepted `final_status` already placed the lease in `releasing`, resume the same terminal handoff and collection flow without requiring another heartbeat.
6. If reconnect key, lineage, sequence, or deadline verification fails, or the scheduler declares the lease stale, lost, or cleanup-fenced, use the latest durable materialization record, backend handle, output manifests, and general evidence bundle refs to enter the existing reconciliation flow.
7. Check backend reachability only after one of the collection or reconciliation branches above owns the session, then collect available output manifests and evidence.
8. Verify digests and lineage, create or update existing collection and reconciliation state, and stage a review when a valid change set exists.
9. Mark the session `requires-human` when evidence is partial or ambiguous, and quarantine invalid or mismatched output.
10. Tear down or retain backend state according to the reconciliation result.

Recovery must not apply changes automatically.

Recovery reuses the existing `BackendWorkspaceHandle`, `WorkerOutputManifest`, `WorkspaceReconciliationRecord`, staged review, quarantine, and general `EvidenceBundle` owners. It must not introduce a synchronization settlement table, copy domain state, duplicate product-turn closeout, or infer execution liveness independently of scheduler and worker-control authorization.

An `awaiting-reconnect` backend session is not yet in workspace recovery and must not be torn down. Backend sessions should be torn down after recovery only when NanoCore has persisted enough verified evidence to reach `recovered`, `unrecoverable`, or `quarantined`. If evidence is partial and a human decision is required, NanoCore should retain backend state when possible and record the retention decision in the `WorkspaceReconciliationRecord`.

## Recovery Records And Quarantine Contract

The recovery-facing records named in the Record Contract are first-class durable
records, not optional evidence enrichment. The persistence and lifecycle
requirements are:

- `BackendWorkspaceHandle` is now persisted in first-slice form at materialization time with redacted materialized-root transport refs, backend kind, worker session id, retention mode, and cleanup status. Worker-control terminal events now update matching handles to `retained` without downgrading `cleaned` or `failed` handles, and governed worker teardown updates matching handles to `cleaned` after successful backend teardown or `failed` after backend teardown failure.
- `WorkerOutputManifest` is now persisted in first-slice form from collected
  change-set declarations before reviewed change-set readback. Later backend
  transport collection should enrich log refs, test output refs, ignored
  outputs, and backend-native evidence while preserving this write-before-review
  discipline.
- `WorkspaceApplyPlan` is now persisted in first-slice form before accepted Git
  patch or filesystem staging apply mutations, carrying approval state, planned
  writes, baseline review validation, binary risks, permission-change paths, and
  a policy acceptance check. Filesystem apply preflight now reports existing
  target paths that are no longer files and added-file parents that are blocked
  by non-directory paths or parent escapes before any workspace mutation.
- `WorkspaceReconciliationRecord` is now persisted in first-slice form for
  recovery transitions, carrying trigger reason, affected lifecycle records,
  backend handle summary, reachability result, collected output manifests,
  evidence bundles, before/after state, quarantine refs, human-decision need,
  retention decision, and start/finish timestamps. Scheduler lease maintenance
  now records `requires-human` reconciliation triggers for stale leases tied to
  pending backend workspace handles. Human recovery decisions now produce
  terminal `recovered`, `quarantined`, or `unrecoverable` states and mark the
  backend retention decision as `teardown-backend`.
The accepted recovery contract does not persist a separate synchronization-specific evidence linkage record. `WorkspaceReconciliationRecord.evidenceBundleIds` plus `collectedOutputManifestIds` provide the required recovery linkage; owning lifecycle records provide domain refs and digests, while the general `EvidenceBundle` ledger owns cross-record evidence indexing, retention, sensitivity, promotion, and import status.

Quarantine is a record, not just a state. A `WorkspaceQuarantineRecord` MUST
carry: quarantine id, the lifecycle record ids it isolates, the validation
failure kind (digest mismatch, lineage mismatch, path violation, schema
failure), the quarantined material's storage reference, retention class,
required human decision, and resolution (released to review, discarded, or
retained). Quarantined material follows the restricted-evidence handling rules
in `docs/specs/20260703-audit_usage_evidence_records.md` and is never deleted
silently.

Recovery-specific Action Center rows are part of this contract: a
reconciliation entering `requires-human` MUST project one Action Center row
carrying the reconciliation id, the affected thread and turn, the available
evidence summary, and the closed set of safe recovery choices (resume
collection, stage what was verified, quarantine, abandon with evidence
retained). Rows resolve when the reconciliation reaches a terminal state.

Recovery triggering binds to the scheduler: `awaiting-reconnect` MUST preserve nonterminal synchronization lifecycle records and MUST NOT trigger collection, review staging, or teardown. Exact adoption keeps using the same records. A session lease reaching `stale`, `lost`, or a fenced takeover per `docs/specs/20260703-durable_scheduler_design.md` MUST trigger reconciliation evaluation for any non-terminal synchronization lifecycle records tied to that lease's agent session, while a `releasing` lease with accepted final status resumes existing terminal handoff. Workspace synchronization owns what recovery does; the scheduler owns whether execution remains live.

## Action Center Projection

Action Center should project pending staged workspace reviews even when the
original artifact row is not available in the current store projection.

When recovery evidence is partial or ambiguous, Action Center should project
`requires-human` with links to the materialization record, collection state,
available evidence, and next safe recovery choices.

The current implementation surfaces workspace reviews, artifact review
decisions, durable workspace review decisions for staged reviews whose artifact
row is no longer available in the current store projection, first-slice
workspace recovery rows for `requires-human` reconciliation records, and
executable recovery decisions for resume collection, stage verified, quarantine,
and abandon. Resume collection recovers records when matching durable worker
output manifests already exist and fails closed when no durable output manifest
matches the recovery record.

## Alternatives Considered

### Sandbox Direct Push

Sandbox direct push is simple for GitHub repositories, but it bypasses NanoCore
review gates, creates weak evidence, and makes failed or partial worker turns
hard to reconcile.

It is rejected as the default path.

### Always Use Git

Always using Git would simplify the first OpenKit self-improvement loop, but it
would make OpenKit unusable for non-Git workspaces and would conflate version
control with workspace synchronization.

Git is a strategy, not the abstraction.

### Stream All Files Through Worker Control

Streaming all file data through the direct worker-control connection would simplify one code path but
would overload the control plane, create large-message and retry problems, and
duplicate backend file APIs.

The control plane announces and indexes data; backend transport moves bulk data.

### Backend-Owned Synchronization

Letting each backend define its own synchronization semantics would move product
state out of NanoCore and make Action Center, review, evidence, and recovery
inconsistent.

Backends implement transport, not product truth.

## Consequences

NanoCore has durable storage for workspace input snapshots, materialization
records, change sets, staged reviews, filesystem staging roots, and apply
results.

The first write path stores workspace input snapshots before backend
materialization, stores materialization records after backend materialization,
and stores artifact-backed workspace review payloads into durable records before
public reads and accepted apply.

The first deterministic non-Git harness can create content-addressed filesystem
manifests, compare before and after manifests into a `WorkspaceChangeSet`, stage
added and modified files into a host staging root, and apply approved staged
changes back to a target root after conflict preflight.

The Action Center can project pending durable staged workspace reviews even when
the original artifact row is not available in the current store projection, and
those rows can now resolve accepted, refinement, rejected, and blocked outcomes
through the durable workspace synchronization review decision route.

The active restart slice adds bounded awaiting-reconnect gating, same-handle continuation after exact adoption, and direct terminal handoff through the existing reconciliation and review owners.

## Rollout / Migration Plan

No legacy preservation is required for internal development data shapes.

Phase 1: Git strategy for OpenKit self-improvement. Support clone or fetch in
the worker runtime, patch collection, host-side staging, and review evidence.

Phase 2: Filesystem snapshot, change manifest, staging, conflict preflight, and
apply. This is partially implemented for host-dir roots and opaque filesystem
staging.

Phase 3: First-class recovery records: backend handles, output manifests,
reconciliation records, evidence bundles, quarantine records, and
recovery-specific Action Center rows.

Phase 4: Richer backend strategies such as Docker diff, rsync, managed sandbox
file APIs, object-store transfer, and optional ephemeral Git branch workflows.

## Testing Strategy / Acceptance Criteria

- Schema tests for workspace synchronization records, path safety, and raw-secret rejection.
- Migration tests for synchronization, staging, and apply-result tables.
- Runtime tests for input snapshot construction, materialization record construction, manifest parsing, path allowlists, and staged review creation.
- Git apply tests that validate digest, byte count, `git apply --check`, durable apply result persistence, and restart-readable apply result records.
- Filesystem apply tests that validate content-addressed manifests, staged copy, conflict preflight, delete handling, and durable apply result persistence.
- Worker governance tests for local disposable-Cell OpenShell materialization, evidence persistence, change-set import, review artifact creation, and whole-Cell recycle.
- Restart recovery tests for awaiting-reconnect with no collection or teardown, exact adoption with the same materialization and backend handle, accepted final status resuming collection without another heartbeat, reconnect timeout entering existing reconciliation, reachable and unreachable backend sessions, partial collection, digest mismatch, quarantine, and `requires-human`.
- Binary, permission-change, generated-file, and object-store staged file tests before those paths are marked implemented.

## Risks & Mitigations

- Risk: Backend state is treated as truth after restart. Mitigation: recover only through NanoCore records plus verified collected evidence.
- Risk: Restart collection races a worker that is still running during bounded reconnect. Mitigation: scheduler and worker-control recovery outcome gates synchronization; `awaiting-reconnect` preserves the existing handle and forbids collection, review staging, and teardown.
- Risk: Git tokens in sandbox can bypass review by pushing directly. Mitigation: default to no worker write access to protected remotes and keep push out of the apply contract.
- Risk: Binary changes bypass review quality. Mitigation: require binary summaries, digests, media type, and explicit review state.
- Risk: Non-Git file comparison can miss permission or binary changes. Mitigation: use content-addressed manifests and block unsupported permission apply.
- Risk: Generated files are duplicated as artifacts and changes without linkage. Mitigation: allow both, but require cross references.
- Risk: Object-store mounts hide changes from review. Mitigation: prefer staged files and gateway reads first.
- Risk: Path traversal or symlink attacks escape staging. Mitigation: reject absolute paths and traversal, resolve real paths, and stage before apply.
- Risk: OpenShell becomes the hidden product control plane because it is the first rich backend. Mitigation: keep NanoCore-owned records canonical and require public surfaces to use OpenKit ids and redacted summaries.

## Resolved Decisions

- This spec supersedes `docs/specs/superseded/20260627-workspace_materialization_sync.md` as the active workspace synchronization contract.
- Phase 1 standardizes on patch-first Git review. Git bundles are optional future support for preserving commit metadata.
- The first implementation does not create Git commits during apply. It applies an accepted patch to the linked repository and records an empty `commitIds` list.
- Commit creation, push, tag, deploy, and protected-branch mutation are separate human-approved actions.
- Workers do not receive GitHub write access in the default path.
- Filesystem snapshot support is part of the first contract and is already partially implemented for host-dir roots.
- Partial or ambiguous recovery evidence surfaces as `requires-human`.
- Exact same-worker reconnect preserves the current materialization and backend handle; only adoption, accepted terminal handoff, or the scheduler's existing interrupted outcome lets synchronization collect or reconcile. Restart adds no settlement coordinator or copied domain state.
- Permission-only changes use the reviewed filesystem staging path when the staged review records `mode_changed` summaries and apply preflight succeeds; unsupported permission mutations are blocked or quarantined with diagnostics.
- Long-lived host Codex sessions do not define the product materialization model because host execution is not a product Worker Agent runtime. Governed worker work uses this workspace synchronization model; direct human-driven local work remains outside it unless it needs review-gated workspace synchronization.
- Previously open questions are resolved by accepted V1 defaults: binary files become artifact-only when they are not safely text-decodable or when a binary payload exceeds 1 MiB. Artifact-only handling carries summaries, digests, media type, byte size, explicit review affordances through staged-review readback, and typed diagnostics when a worker attempts to present binary content as a normal text patch.

## Deferred / Future Work

- Git commit, branch, push, and protected-branch workflows are now owned by `docs/specs/20260704-git_write_workflow.md`.
- Define object-store-backed large workspace inputs and outputs.

Recovery records, quarantine records, and recovery-specific Action Center rows
were promoted from deferred work into the Recovery Records And Quarantine
Contract above; their build-out is implementation work tracked through the
`Implementation` field, not deferred design.

## Links

- `docs/specs/superseded/20260627-workspace_materialization_sync.md`
- `docs/specs/20260704-git_write_workflow.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/core/storage.md`
- `docs/core/sandbox.md`
- `docs/core/audit.md`
- `docs/core/agent-workflow.md`
- `docs/product-vision.md`
- [Evidence Surface Simplification](../changes/202607111848520001-evidence_surface_simplification.md)
- [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw)
- [NVIDIA OpenShell documentation](https://docs.nvidia.com/openshell/)
