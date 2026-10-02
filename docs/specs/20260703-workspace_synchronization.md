---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-09-30
---
# Workspace Synchronization

## Owns

This spec owns the backend-portable workspace synchronization contract for
worker-agent work:

- workspace input snapshotting
- worker workspace materialization
- turn-dynamic population of predeclared workspace slots
- independent per-AgentSession materialization, output collection, conflict handling, review, and apply for workers that share a Sandbox, with the collection scan taken from outside the Sandbox
- backend transport boundaries
- collected workspace output records, which the worker does not publish
- workspace change sets
- durable workspace synchronization review authority
- review-gated apply owned only by an accepted Workspace Sync Review
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
keys, Runtime Epoch lifecycle, shared control transport, or backend-native file-transfer protocols.

This spec does not own generic Artifact Review decisions. An Artifact may present one staged workspace change set, but that presentation never owns the Workspace Sync Review decision or workspace apply.

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
- `docs/core/runtime-model.md`

## Related Docs

- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260801-nanohost_workspace_data_boundary.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`

## Summary

OpenKit needs a backend-portable way to materialize a workspace into a worker runtime, collect worker changes by a NanoHost read-only scan of the work volume from outside the Sandbox and hand that scan to NanoCore, stage those changes for review, apply accepted changes, and recover safely after NanoCore or backend restart.

The durable decision is that workspace synchronization is a NanoCore-owned
contract, not an OpenShell-only feature and not a backend-owned transport detail.

Worker writes never become workspace truth directly. Workers write the work volume. They do not write the canonical `workspace-changes.json` or the review patch. They still produce artifacts, logs, and evidence. NanoCore verifies, stages, reviews, applies, and records results. If NanoCore or the backend restarts, recovery resumes from NanoCore-owned records plus verified collected evidence, not from backend runtime state alone. The private scan store is not that evidence and is not product truth.

A scheduler lease that is still inside its bounded `awaiting-reconnect` window is not yet a workspace-reconciliation trigger. Workspace collection, review staging, and teardown wait until exact process-key/lineage/sequence adoption continues the same worker or the scheduler selects the existing interrupted recovery path. Turn-end collection, AgentSession-release collection, and the scan before a successor starts on the same work volume are collection points of a Turn that has ended or of a session that is releasing or being succeeded. They are not an `awaiting-reconnect` trigger. While the lease is `awaiting-reconnect`, collection, review staging, and teardown still wait, because the original worker may continue.

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
- who accepted the Workspace Sync Review that authorized apply
- how NanoCore recovers if worker, backend, or NanoCore state is interrupted

NanoCore owns workspace materialization records, change-set records, staged
review records, apply decisions, recovery state, and product-visible evidence.
Backends own transport and isolation.

The design is OpenShell-first in implementation, but OpenKit-owned in semantics.
OpenShell can provide the first rich transport and enforcement path without
becoming the canonical source of workspace truth.

## Goals / Non-goals

### Goals

- Define the canonical lifecycle for workspace input snapshotting, worker materialization, change collection, staged review, accepted apply, and restart recovery.
- Keep NanoCore as the source of truth for workspace state, worker lineage, evidence, review gates, accepted changes, and recovery decisions.
- Let backends use native transport primitives without exposing backend internals as product contracts.
- Support Git repositories as the first implementation path for the OpenKit self-improvement loop.
- Support non-Git workspaces through filesystem snapshots, change manifests, staged review, and conflict-checked apply.
- Keep the bounded `/worker-control/*` route focused on metadata and small events instead of large file synchronization.
- Make synchronization reviewable, auditable, resumable, and safe across local mode, server mode, OpenShell, Docker, remote VM, and future managed sandbox backends.

### Non-goals

- Synchronization does not authorize external hosting effects. Default Git hosting writes use selected Gateway MCP authority; native Git push is separately admitted user-space configuration. Deploy, publish, tag and other external effects remain with their respective effect owners.
- Do not make OpenShell the only materialization backend.
- Do not treat backend logs, paths, process ids, sandbox ids, gateway ids, provider handles, or file-transfer handles as public product identity.
- Do not expose raw host paths, provider secrets, raw environment values, or temporary credential material through synchronization product APIs. The restricted native-environment administration view belongs to [Agent Manifest And AEP Resolution — User Administration Of Native Environment](20260703-agent_manifest_aep_resolution.md#user-administration-of-native-environment); it exposes admitted public defaults and overrides, never credential values, host environment, or raw unclassified image environment.
- Do not require every backend to support every synchronization strategy.
- Do not replace Goal Mode, Action Center, artifacts, or review decisions with Git commit state.
- Do not implement unattended recursive self-modification.
- Do not define large-data lazy access or unversioned object manifests in this slice.

## Decision

OpenKit uses a backend-portable workspace synchronization lifecycle:

```text
workspace input snapshot
  -> materialization plan
  -> compatible session layout selection
  -> backend materialized workspace
  -> worker execution
  -> accepted read-only scan from outside the Sandbox
  -> collected workspace change set
  -> NanoCore output-manifest classification of that result
  -> staged workspace review
  -> Workspace Sync Review decision
     -> accepted: apply preflight -> workspace mutation -> apply result
     -> needs_refinement, rejected, or blocked: terminal without apply
  -> recovery or reconciliation when interrupted
```

NanoCore owns every lifecycle record. Backends implement lifecycle effects.

Restart handling consults the exact scheduler and worker-control outcome before synchronization acts. `awaiting-reconnect` preserves the existing materialization and backend handle without collection or teardown, exact adoption keeps using those same records, and key, lineage, sequence, or deadline failure enters the existing reconciliation lifecycle. That collection prohibition is the `awaiting-reconnect` window. Turn-end, release, and pre-successor scans remain collection points outside that window.

The materialization plan binds turn inputs to predeclared workspace slots when a reusable session already exists.

If a turn cannot fit the existing session's static workspace layout, provider envelope, policy envelope, or backend capability envelope, NanoCore must ask the AgentSession/AEP layer for a replacement session before materializing the turn.

Git sources are cloned or fetched inside the worker runtime. Their default hosted result is a vendor branch or pull request produced through selected Gateway MCP supply, without host checkout apply. The outside scan may supply inspection evidence under its own owner; it does not authorize the hosting effect.

For non-Git workspaces, the first strategy uses a content-addressed filesystem
snapshot, changed-file manifest, staged files, and conflict-checked file apply.

An accepted final status already persisted before restart resumes normal output collection and terminal handoff without another worker heartbeat. A collection whose head is already committed is exact replay of that link and is not started again as a second link merely because final status is accepted. Restart recovery calls the existing `BackendWorkspaceHandle`, `WorkerOutputManifest`, `WorkspaceReconciliationRecord`, review, evidence, backend cleanup, turn, lease, and capacity owners directly. Same lineage plus the same canonical digest and stable accepted timestamp is exact replay; a conflict fails closed. No settlement coordinator or second closeout workflow exists.

Durable synchronization records and read models replay exactly. App-local turn events are an ephemeral projection and may be delivered at least once if NanoCore crashes again after the durable writes but before event projection completes; this compromise does not change workspace truth or justify another durable workflow.

Publication into Core-owned canonical Workspace data remains review-gated by default. External Git hosting is a separate selected Gateway MCP effect with configured per-tool approval and current authority; native Git push is optional user-space configuration. Other domain effects retain their own authorization contracts.

## WorkspaceMaterializer Boundary

NanoCore should expose a `WorkspaceMaterializer` boundary with these conceptual
operations:

- `prepareWorkspace(input, sessionLayout) -> materializationPlan`
- `materializeToWorker(plan, backendSession) -> materializationRecord`
- `collectChanges(materializationRecord, previousHead) -> workspaceChangeSet`
- `stageChanges(changeSet) -> stagedReview`
- `applyApprovedChanges(stagedReview, decision) -> applyResult`
- `reconcileWorkspaceSync(interruptedRecord) -> reconciliationRecord`

The boundary is implemented by backend-specific adapters, but the records it returns use OpenKit vocabulary. `collectChanges` also needs the previous head of that work volume. It does not read a worker-written manifest as the change set.

## AgentSession Slots And Turn Materialization

Workspace synchronization owns per-turn content movement, not the canonical session-static workspace skeleton.

The session-static skeleton is owned by `docs/specs/20260704-session_static_workspace_materialization.md` and is represented by `SessionWorkspaceLayout`, `WorkspaceSlot`, and `SessionCompatibilityKey`.

This spec owns the records that populate, collect, review, apply, and recover slot contents for one turn.

Rules:

- `WorkspaceInputSnapshot` records what the turn intends to expose and which slot each input targets.
- `WorkspaceMaterializationRecord` records how those inputs became visible inside the selected session's declared slots.
- `WorkerOutputManifest` records changed files, artifacts, transcripts, logs, and evidence under declared output, worktree, session, and artifact slots.
- A nonempty candidate's `WorkspaceChangeSet` is produced only after NanoCore accepts a scan whose `base` equals the previous `head` of that work volume and the policy checks pass. NanoHost returns the scan and does not produce the record. A scan whose `base` differs is the chain `recovery_required` result in Snapshot Chain below.
- Backends may use bind mounts, copies, uploads, downloads, tar streams, rsync, Git checkout, provider file APIs, object-store staging, or future FUSE mounts, but those are transport projections rather than product truth.
- `/worker-control/*` may announce slot materialization and output readiness, but large Workspace and Artifact payloads must move through an existing native or bounded data-transfer owner outside every control or semantic-route stream; the exact NanoHost single-file carriage may share the authoritative outer physical HTTP/2 connection as one distinct fixed data stream.
- A new static slot, static mount path, provider placeholder, working directory, image, user, group, or control endpoint requirement must be handled by session replacement before this spec's materialization step proceeds.

## Per-AgentSession Materialization And Canonical Handoff

Each active Turn owns one logical `WorkspaceInputSnapshot` and one materialization lineage bound to its exact Workspace, Thread, Turn, AgentSession, AEP package snapshot, selected slots, sources, and baselines. Two AgentSessions in one shared Sandbox never share a mutable materialization record, writable worktree, output staging root, transcript root, backend handle, change set, review, or apply attempt. They may reference the same proved immutable baseline or unchanged source revision without making that physical reuse a shared record owner.

Before `turn.start`, NanoCore captures the selected canonical Workspace and supported declared-source revisions, compares them with the exact AgentSession-private proved baseline, and materializes the bounded delta into that AgentSession's declared slots. A new snapshot may reuse unchanged verified bytes or read-only references while preserving distinct Turn and delivery lineage. On a retained volume that already holds a chain head, the next Turn continues from that head. It does not check the original source commit back over the volume and does not reset it. This freshness barrier does not authorize the large-data lazy-access policy or unversioned object-manifest design deferred by this specification.

An active Turn stays pinned to the snapshot it received. A later canonical Workspace revision does not mutate its slots. A changed capture records a link whose `base` is the previous captured snapshot on that work volume and produces its `WorkerOutputManifest` from the accepted scan. A nonempty candidate also produces its `WorkspaceChangeSet` and stages the result under the existing durable Workspace Sync Review owner. An empty candidate records that link and advances the cursor without a `WorkspaceChangeSet` or a review. A stable unchanged capture records no additional link. An unstable `no_new_head` records its observation through that same link owner with `base` and `head` both equal to `previousHead` and does not advance the cursor. Comparison to current canonical truth stays with review and apply, and is a different fact from this chain cursor. Output from a sibling AgentSession is never treated as this Turn's baseline, evidence, or accepted input merely because both ran in one Sandbox.

Two AgentSessions changing the same path produce two preserved candidate change sets. Completion order never selects a winner, merges bytes, overwrites the earlier candidate, or authorizes apply. The existing serialized apply owner checks each accepted review against current canonical baselines; overlap, path conflict, stale source identity, digest mismatch, binary risk, unsupported permission change, or changed authority produces the existing conflicted, blocked, quarantined, failed, or refinement outcome without mutation. Contiguity of chain links is about captured bytes on one work volume. It does not merge those candidates and does not authorize apply.

Per-AgentSession materialization is created from one accepted input snapshot, updated only through verified transport and collection transitions, and terminates after required outputs and evidence are collected or truthfully marked partial, quarantined, failed, or abandoned. Turn-end collection does not terminate a resident AgentSession. AgentSession release and the scan before a successor starts on the same volume are collection points, not reasons to mark the volume partial. A retry creates a new Turn snapshot and materialization lineage from current truth; it does not reuse a failed transfer identity or blindly replay an apply. A transport loss and a NanoCore restart both may adopt the exact surviving binding under the existing proof contract: exact adoption retains the same AgentSession materialization and handle, while a binding that cannot be proved exactly is closed or fenced and a successor resumes the native conversation, entering the existing reconciliation path without substituting a sibling or claiming cross-domain atomicity.

Missing, stale, inaccessible, contradictory, cross-AgentSession, or dependency-failed inputs block readiness or enter reconciliation according to the existing state owner. A `base` that differs from the previous `head` is the chain `recovery_required` result: it writes no review, writes no apply plan, and does not advance the cursor. It is not repaired by adopting the submitted base. Unprovable output or cleanup remains inspectable and may require human action; it never becomes canonical by inference. Core storage and the external runtime remain separate effect domains, so accepted review and apply use the existing preflight and result boundary rather than a settlement or automatic repair protocol.

Observable acceptance requires two resident AgentSessions to carry distinct snapshots, slots, backend handles, output manifests, change sets, and review lineage; unchanged supported inputs to avoid unnecessary byte movement while retaining new Turn lineage; two overlapping candidates to remain preserved and conflict-checked; only the exact accepted durable Workspace Sync Review to authorize apply; and a transport loss or a NanoCore restart to retain the exact original materialization when exact adoption succeeds, or, when the binding cannot be proved exactly, to close or fence it so a successor resumes the native conversation and to expose reconciliation, interruption, or uncertainty without sibling substitution. Successive links on one volume have `base` equal to the previous `head`. A mismatch is the chain `recovery_required` result with no cursor advance. An `unstable` link still has one head, and the next link starts there. The next Turn is not dispatched until Turn-end collection completes. No decision class is not applicable. The chain rules fill the classes in Snapshot Chain below.

## Snapshot Chain

[Runtime](../core/runtime-model.md) states that workspace changes are collected by a read-only scan from outside the Sandbox, at Turn end, at AgentSession release, and before a successor uses the same work volume, without stopping the running worker. This section states the link, the cursor, and the handoff to review. The decision and its reason are recorded in [a decision record](../decisions/20260930-workspace_collection_is_a_snapshot_chain.md). The admitted Git use is the narrow amendment in [NanoHost Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md).

### Definition And Exclusions

A changed-capture link records one captured transition; a nonempty immutable candidate against Core's accepted base produces the reviewable `WorkspaceChangeSet`. That link's `base` is the previous captured snapshot on that work volume and its `head` is the new scan, so successive changed-capture links telescope with no duplicate and no omission of captured bytes. The guarantee holds for captured states. Bytes that exist only between the two scans are not a captured head. An unstable `no_new_head` observation uses the same collection-link owner with `base` and `head` both equal to `previousHead` and does not advance the cursor. A stable unchanged capture needs no additional link.

The scan is read-only, runs outside the Sandbox, and uses the private host-side Git index and object store named by the data-boundary amendment. That store is not the worker repository and not canonical Workspace truth. The in-Sandbox publisher of `workspace-changes.json` and `workspace.patch` is removed. It is not retained beside the scan.

A work volume's first link starts from Core's accepted base for that work slot, the materialized or last applied state. The capture cursor before any link is that accepted base's snapshot pair. When that base is unknown, ordinary collection returns the chain `recovery_required` result with cause `accepted_base_unknown`. First collection never adopts the current worktree as an inferred accepted base. An absent or unverifiable accepted pair yields `recovery_required` with cause `accepted_base_unknown`.

Baseline collection is the only collection that names no accepted pair, and NanoCore authorizes it only to initialize a new empty slot. [Session Static Workspace Materialization](20260704-session_static_workspace_materialization.md) owns when that initialization completes and which source identity the materialized source supplies: the pinned commit for a Git source and the expected tree for a non-Git source. NanoHost scans the slot twice through the private store, runs the credential check on every blob, and returns the snapshot pair only when the two pairs are equal. Unequal scans are not an `unstable` capture. Null `acceptedBase` and `previousHead` on that command are the required form, not an absent pair, and they do not yield `accepted_base_unknown`. Baseline collection uses the shared path admission below, including its repository-metadata exclusion. Its only ignore-rule difference is that it does not apply ignore exclusions: with null `previousHead`, there is no previous tracked set, and a contained `.gitignore` must not omit a source-tree path. For a Git source, the Sandbox client fetches and checks out the data source's pinned commit and reports HEAD and tree; NanoCore accepts the returned pair only when the reported commit id equals that pin, without reading a host repository. For a non-Git source, Core accepts the returned pair only when its tree equals the expected tree. After the applicable source check succeeds, Core records that pair as the slot's accepted base and capture cursor in one durable write, with no review and no collection link. Until that write is durable, the slot has no accepted pair and the first Turn is not dispatched. The manifest's permission bits are accepted as scanned. Observed permission bits establish that baseline and grant no permission-application authority. A retained slot is never re-baselined, as that materialization owner defines, and ordinary collection continues from its chain head. Ordinary collection keeps `accepted_base_unknown`. The decision and its reason are recorded in [a decision record](../decisions/20260930-first_accepted_base_by_baseline_scan.md).

A captured snapshot reference is the pair of the Git tree object of the second scan and the Git blob object, in the same private store, of that snapshot's canonical full-permission manifest. The worktree `HEAD` commit is not part of the snapshot pair and remains context only for ordinary capture, whether or not the tree is dirty. Initial Git-source baseline admission separately compares the Sandbox-reported commit id with the data source's pinned commit as required above. The manifest is a concatenation of length-framed UTF-8 records, not LF-delimited lines. Enumerate every admitted entry recursively beneath the snapshot root exactly once, including directory entries and their descendants and represented symbolic links, using its complete root-relative path; do not emit a record for the root. An empty directory is not an entry of either the tree or the manifest, so both enumerate the same paths. Neither `baseline` nor `capture` admits a root-relative path containing a component equal to `.git` under ASCII case folding, or any descendant of that entry. The exclusion applies at every depth and to every entry kind, independently of ignore patterns and the tracked set. The collector skips that entry before opening or traversing it. Apply the exclusion to both the tree and the permission manifest; directories with no remaining admitted descendants remain absent from both. Exclusion never deletes or changes retained working bytes. This rule does not exclude `.gitignore`, `.gitattributes`, or `.gitmodules`. Before constructing both objects, exclude untracked ignored paths for capture. For capture, tracked paths are the paths in Core's supplied `previousHead` tree, so a path in that tree stays in the snapshot even when a contained `.gitignore` pattern matches it. Untracked exclusion uses contained worktree `.gitignore` files only. Contained `.gitignore` files use the pinned Git's ignore-pattern semantics, including escaping, bracket classes, double-star matching, trailing-space handling, directory exclusion, and nested precedence. Selecting contained sources changes neither that pattern language nor the rule that paths in `previousHead` remain tracked. Ignored untracked entries are excluded before their contents or children are opened. Worker index state, repository `info/exclude`, configured external exclude files, and ambient configuration do not determine inclusion. The exclusion does not delete a path from a retained volume. Sort records by unsigned comparison of the complete path bytes, with no Unicode normalization. A record is the entry's own POSIX permission bits, `st_mode & 07777`, encoded as exactly four zero-padded octal digits, one U+0020, the positive canonical decimal byte length of the path with no leading zero, one U+0020, exactly that many raw UTF-8 path bytes, and one U+000A terminator. The permission bits include set-user-ID, set-group-ID, and sticky bits and exclude file-type bits; the tree supplies entry kind. Obtain metadata without following symbolic links, and never traverse a symlink as a directory or substitute its target's mode. Decode by the declared byte length, not by splitting on spaces or line feeds. Invalid UTF-8, unsafe root-relative paths, malformed framing, unsorted or duplicate records, an empty-directory record, missing metadata, or a tree/manifest entry mismatch returns `recovery_required` without review or cursor advance. Unsupported permission application remains rejected, blocked, or quarantined; recording a mode does not authorize applying it. `head`, `previousHead`, `acceptedBase`, and the returned scan reference each carry that pair. Scan equality, `unstable`, contiguity, `no_new_head`, candidate construction, retention, pruning, and restart replay use the whole pair, and the manifest blob is retained and pruned with its tree. An `unstable` changed-capture link has the second scan's pair with `unstable` set. `unstable` means the two scans did not settle and writers persisted, including when the scans differ only in full mode. When the second pair differs from `previousHead`, the recorded snapshot is the second scan's pair, so a mode-only difference records the second mode, and restart replay of the committed link does not change an earlier snapshot's mode. The recorded head is still that link's head, and the next link starts there so those bytes are not dropped. When the second pair equals `previousHead`, `unstable` does not record the second scan as a new head and does not overwrite an earlier snapshot's mode. `unstable` is not a review state and not a failed collection by itself. It does not skip review and does not by itself accept the bytes.

Both collection modes scan exactly twice. Baseline uses the equality-or-failure rule above. For capture, unequal snapshot pairs set `unstable` to true. When capture's second scan pair also differs from `previousHead`, the last scan is recorded as that link's head with `unstable` set. For capture, `no_new_head` means the second scan's snapshot pair equals `previousHead`; it does not imply that the two scans agreed. Its JSON result carries exactly `requestId`, `outcome`, and `unstable`, where `outcome` is `no_new_head` and `unstable` is the boolean result of comparing the two scan pairs. The exact two-member result remains only for `credential_hit` and `effect_failed`. A `no_new_head` result creates no `WorkspaceChangeSet`, review, or apply effect and does not advance the snapshot-pair cursor. When `unstable` is true, Core records the observation through the existing collection-link owner, with `base` and `head` both equal to `previousHead`, and retains its instability for exact replay under that collection identity. It does not overwrite an earlier link's stability. A stable unchanged capture needs no additional link. Exact replay is keyed to the collection/link identity, not merely to equality of snapshot pairs. There are no further retries. The scan does not freeze or pause the Sandbox.

Capture emptiness and review-candidate emptiness are independent. A capture is unchanged only when the second scan's snapshot pair equals the previous captured snapshot pair, and that equality does not imply that the two scans agreed. A changed captured snapshot records a link and advances the capture cursor even when its candidate against Core's accepted base is empty. An empty review candidate has no content, path, file-kind, deletion, or supported permission delta against that accepted base. It creates no staged review, no apply effect, and no `WorkspaceChangeSet`. A return to the accepted base is a captured transition, not `no_new_head`. A failed, partial, contradictory, or non-contiguous scan is not an empty candidate. A byte-identical change from mode `0644` to `0600` is a supported permission delta even when the Git tree object id is unchanged, because the manifest blob differs. Untracked ignored paths stay out of the diff, and that exclusion does not delete them from a retained volume. One scan covers Git and non-Git trees on the volume under these same rules. There is no separate filesystem collector and no second in-Sandbox publisher.

Mid-way checkpoints exist in the design and stay disabled until a consumer exists. This specification does not define a checkpoint trigger and does not require an implementation.

The literal credential-value check runs in the NanoHost scan over the exact source bytes selected below. The collection command carries the session-static Vault-resolved runtime-env values and the SHA-256 digests of the two loopback credentials, not the raw loopback values. NanoCore holds the runtime-env values in memory for the binding's life, and those values are never persisted. NanoCore persists only the SHA-256 digests of the two loopback credentials with the binding and retains no raw loopback value after the `session.open` dispatch. [Worker Agent Capability](20260703-worker_agent_capability.md) owns their mint, attribution, drain, and destruction. The scan compares each runtime-env value as a literal and detects a loopback credential by computing the SHA-256 of every window of 43 consecutive bytes in each selected source byte sequence whose bytes are all in the unpadded base64url alphabet (`A`–`Z`, `a`–`z`, `0`–`9`, `-`, and `_`) in which each credential is encoded, and comparing it with those digests; a window inside a longer run of that alphabet is compared too. A match fails the collection exactly as a literal hit does. This is exact byte equality for fixed-length random values, and it keeps the literal-check criterion across a restart. The check uses the current collection's check values for both scans and for every source blob contributing bytes to the cumulative review candidate, including old-side patch context and deletion content. Capture checks the union of every added or changed blob from either scan relative to `previousHead` and every source blob contributing bytes to that candidate. A blob present or changed only in the first scan remains subject to the check even when the second scan omits or restores it. The selected byte set includes symlink target blobs and contributing path and permission-manifest bytes from both scans and from the candidate's accepted-base and head snapshots, even when the metadata's blob id is unchanged. Baseline collection checks every blob, path, and permission-manifest byte in each of its two scans, because it has no previous head. A previous collection's check does not exempt bytes from a later binding's check. Deleting an entry contributes no new snapshot blob, but any bytes included in its review representation remain subject to the check. The check runs on exact source bytes before publication, not only on their binary-patch encoding. On a hit, the collection fails with a typed rejection, withholds candidate publication, creates no review, and does not advance Core's cursor. Cleanup removes the scan's unaccepted private objects only when they are not required by a Core-selected retained pair; it never destroys a Core-required retained pair. A credential discovered in retained content is routed to that content's existing owner for disposition under the existing recovery and quarantine contract, not deleted as attempt cleanup. After a NanoCore restart, runtime-env values are re-resolved at the exact Vault material version recorded by the binding's injection evidence. When that version cannot be resolved, collection returns `recovery_required` with cause `check_values_unavailable`, stages no review, and does not advance the cursor. Collection never substitutes a current value, skips a value, or persists a runtime-env value. The persisted loopback digests remain required check values after a restart. This check is not the raw-secret shape validation in the Record Contract, and it does not change that validation's hunk exemption. The Harness keeps its assistant-text and diagnostic checks under [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md).

These collection rules add no Goal execution behavior. The unavailable-result rule for Goal entry stays in the Goal owners.

### Durable Authority And Projection Boundary

NanoCore owns the change set, the previous-head cursor, the chain `recovery_required` result, review, and apply. NanoHost returns the scan and does not create the `WorkspaceChangeSet`, choose a conflict winner, or accept bytes as Workspace truth. The cursor is its own durable record. It survives review staging, and it is not the review-branch commit.

This version starts from a new data root and does not read earlier-version data ([decision](../decisions/20260930-earlier_version_data_not_carried.md)). The private object store is scan machinery. It is not a second Git authority, not product identity, and not an external repository publication authority or the canonical Workspace data that apply updates.

A link records its `base`, the previous `head`, and its `head`, each as the snapshot pair defined above, plus `unstable` and its credential-check result. It is capture provenance and carries no patch Core applies. The review candidate is one immutable patch from Core's accepted base for the work slot, as recorded when the candidate is staged, to that link's `head`. The byte encoding of that patch is owned by [NanoHost Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md). Review display, digest and length verification, conflict preflight, and apply all bind to that candidate and its recorded base. A rejected candidate does not advance the accepted base. Several reviews may be pending on one work slot, and each is decided on its own. A review shows the pending earlier links on the same volume. Accepting one does not change another's decision. Applying a later candidate after an earlier one moved the accepted base conflicts under the existing conflict result. Contiguity remains the captured snapshot-pair cursor only. An unstable `no_new_head` observation records `base` and `head` both equal to `previousHead` through this same link owner, creates no review candidate, and does not advance the cursor. A stable unchanged capture records no additional link.

### Lifecycle

Baseline collection occurs after successful first initialization during `session.open` and before the first `turn.start`. Capture occurs at Turn end, after which the next Turn waits for collection completion; at AgentSession release; and before a successor uses the same work volume. Release and the pre-successor point use this same scan owner. They are not a second collector. The scan does not require native-process exit or process-group absence. The collection command carries the work slot.

`awaiting-reconnect` still forbids collection, review staging, and teardown. Restart of a committed link replays that link exactly, and the next collection scans from its head. Unfinished collection after accepted final status still resumes without another heartbeat when the check values required above are available. When they are not, collection returns `recovery_required` with cause `check_values_unavailable`, stages no review, and does not advance the cursor. A committed head is not minted again as a second link because final status is accepted.

### Conflict, Missing, Stale, Restart, And Dependency Failure

NanoCore rejects a change set whose `base` differs from the previous `head`, and rejects an ordinary collection whose accepted base is unknown, as one `recovery_required` code distinguished by a cause field. The closed cause set is `accepted_base_unknown`, `previous_head_mismatch`, `snapshot_unavailable`, `malformed_manifest`, `unsafe_path`, `metadata_unavailable`, `tree_manifest_disagreement`, `check_values_unavailable`, `command_too_large`, `baseline_unstable`, `baseline_mismatch`, and `baseline_source_unavailable`. `accepted_base_unknown` is the unknown or unverifiable accepted-base cause, and `previous_head_mismatch` is the cause when `base` differs from the previous `head`. Unavailable check values use the cause `check_values_unavailable`. A command that cannot be represented within the collection command ceiling owned by [NanoHost Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md) uses the cause `command_too_large`. NanoCore produces `accepted_base_unknown` when an ordinary collection has no accepted pair to name, `previous_head_mismatch` when the collection's base is not its previous head, and `check_values_unavailable` or `command_too_large` before dispatch when it cannot construct an admissible command. It does not send a truncated check set. NanoHost produces `accepted_base_unknown` when the command's accepted pair is absent or unverifiable, including when another named snapshot is also unreadable, and `snapshot_unavailable` when a named retained snapshot other than that accepted pair cannot be read from the private store, and `malformed_manifest`, `unsafe_path`, `metadata_unavailable`, or `tree_manifest_disagreement` for the corresponding validated snapshot, path, or metadata failure. NanoHost does not produce `previous_head_mismatch` from a private cursor. NanoHost produces `baseline_unstable` when a baseline command's two scan pairs differ, and it does not produce `baseline_mismatch` or `baseline_source_unavailable`. For a non-Git source, NanoCore produces `baseline_source_unavailable` when the materialization owner cannot supply an expected tree comparable in the private store's object format, and `baseline_mismatch` when a returned baseline tree differs from that available expected tree. For a Git source, NanoCore produces `baseline_source_unavailable` when the Sandbox Git client cannot fetch, check out, or report HEAD, and `baseline_mismatch` when the reported commit id differs from the commit id the data source pins. NanoCore reads no host repository for that check. NanoCore does not produce `baseline_unstable`. The decision and its reason are recorded in [a decision record](../decisions/20261002-hosting_through_gateway_mcp.md). A baseline failure, including those three causes and an existing credential, path, metadata, check-value, size, or effect failure on a baseline command, records no accepted base, no cursor, no review, and no collection link, and the AgentSession does not receive its first Turn. Attachment-proof and scan-resource-limit failures follow [NanoHost Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md#read-only-private-store-scan), including its preservation, cleanup, and new-request rules. Other definite effect failures remain `effect_failed`. That result writes no review, no apply plan, and no cursor advance, and it does not infer a repaired base. The conflicting generic Artifact Review result keeps its meaning. The chain result is also distinct from an apply-time mismatch against canonical Workspace data and from the Turn input-snapshot check. The reconciliation record's recovery-required bundle ids are a different field.

Apply of a contiguous link still uses the existing preflight against current canonical baselines and can still conflict, block, quarantine, or fail with no mutation. Terminal review decisions still create no implicit follow-up Turn. No settlement protocol is added. A literal credential match, including a loopback digest match on a 43-byte window of the credential alphabet, fails closed, creates no review, and does not advance the head.

### Acceptance

Successive links on one volume satisfy `base` equal to the previous `head`. A mismatch returns the chain `recovery_required` result and leaves the cursor unchanged. A background writer during collection yields `unstable`, and when the second pair differs from `previousHead` a following link starts at that head. The next Turn, release completion, and a same-volume successor wait until the applicable collection completes. An empty review candidate, one with no content, path, file-kind, deletion, or supported permission delta against Core's accepted base, creates no candidate, staging, review, or apply effect, and a changed capture still records its link and advances the cursor. A failed scan is not reported as an empty candidate. A NanoCore crash after accepted final status and before the scan, when the recorded Vault material version cannot be resolved, returns `recovery_required` with cause `check_values_unavailable`, stages no review, and does not advance the cursor. A committed link still replays without another scan. Let the accepted base hold files `a` and `b` at content 0. A link that captures `a` at content 1 and is rejected does not move that base. A later link that captures `a` at content 1 and `b` at content 1 stages one candidate from the still-accepted base to that later head, so the reviewed patch changes both files, and accepting that later review does not change the earlier rejection. A byte-identical permission change from mode `0644` to `0600` yields a `mode_changed` candidate, is not an empty review candidate, and is not applied automatically. The same byte-identical captures `0644`, then `0600`, then `0644` keep one Git tree id and distinct snapshot pairs, because the manifest blob changes with the mode and the return to `0644` restores the first manifest blob. Two scans that differ only in full mode, and whose second pair differs from `previousHead`, are `unstable`, record the second mode, and restart replay does not change the earlier snapshot's mode. Previous captured mode `0644`, first scan `0600`, and second scan `0644`, with identical content, return `no_new_head` with `unstable` true, record an observation link through the existing collection-link owner with `base` and `head` both equal to `previousHead`, replay that observation on restart without a cursor change and without changing an earlier link's stability, and stage no review. Let the accepted base be content 0, the previous capture be content 1, and both scans capture content 0. The cumulative candidate is empty, so the result is `empty` and not `no_new_head`. The link is recorded, the cursor advances to that captured snapshot, no review is staged, restart replays that link, and the next link starts at 0. A root containing `dir/file` emits a record for that directory entry and a record for `dir/file`, and emits no record for the root. An empty directory is not an entry of either the tree or the manifest, so both enumerate the same paths. A path containing an embedded U+000A round-trips by the declared byte length and is not split on that line feed. Two AgentSessions still carry distinct change sets, and completion order still does not merge them or authorize apply. Only an accepted durable Workspace Sync Review authorizes apply. A stable or `unstable` head is not canonical Workspace truth. A blob that contains a loopback credential embedded in a longer run of the credential alphabet is caught by the 43-byte window digest comparison and fails as a literal hit. A collection after a NanoCore restart still checks the loopback credentials.

Credential acceptance uses synthetic check values and observes rejection before candidate publication, with no review and no Core cursor advance. Let accepted base B contain `a=0` and previous capture H1 contain `a=S`, where S was not a check value for that earlier binding. A successor binding supplies S as a current check value, leaves `a` unchanged, and changes only `b`; collection rejects because the cumulative B-to-head candidate contributes S from `a`. A current check value appearing only in an accepted-base blob included as old-side deletion content or patch context also rejects, even when neither scan adds or changes that blob. A value present only in the first scan, in a symlink target blob, or in contributing path or permission-manifest bytes rejects under the same rule. A current check value in a represented candidate path or permission metadata rejects even when that metadata's blob id is unchanged and only file content changed. Binary source bytes containing a check value reject even when the encoded binary patch does not contain that literal value. Each hit preserves every Core-required retained pair; a hit in retained content exposes its existing owner's required disposition without deleting that pair as attempt cleanup.

## Current Implementation Projection

The current implementation realizes the accepted base V1 synchronization behavior below. The accepted design replaces in-Sandbox capture and the worker-written change-set publisher with the snapshot chain above. The source paths below include the retained V1 behavior and do not establish completion of the accepted snapshot-chain contract. The active restart slice adds bounded awaiting-reconnect preservation, read-only existing-handle restoration, and direct terminal handoff through these owners. The current Turn input-snapshot checks reported as `input_base_mismatch` or `materialization_base_mismatch`, and the conflicting generic Artifact Review result, are not the chain `recovery_required` result. Review staging overwrites `changeSet.head.commit` with the review-branch commit, so that commit is not the chain cursor. The production first-Turn path compares the Sandbox-reported Git HEAD to the pinned commit, then atomically records the accepted base and cursor without a host repository read. Git-source captures remain retained work evidence and do not create a host apply prerequisite. The non-Git expected-tree check remains in place; this baseline slice does not establish complete non-Git collection-to-apply behavior.

- `packages/app-api-schemas/src/workspace-sync.ts` defines schemas for input snapshots, materialization records, backend workspace handles, worker output manifests, change sets, staged reviews, review patch payloads, and apply results.
- The Workspace migrations under `apps/nanocore/drizzle/workspace/` persist input snapshots, materialization records, change sets, staged reviews, review-gated apply results, internal filesystem staging roots, redacted backend workspace handles, worker output manifests, accepted workspace apply plans, and restart recovery reconciliation records.
- `apps/nanocore/src/runtime/workspace-sync-records.ts` records and lists durable workspace synchronization review lineage, redacted backend workspace handles, and worker output manifests.
- `apps/nanocore/src/runtime/workspace-apply-plans.ts` records and lists durable workspace apply plans.
- `apps/nanocore/src/runtime/workspace-reconciliation-records.ts` records and lists durable workspace reconciliation records.
- `apps/nanocore/src/runtime/workspace-sync-records.ts` records one compact `EvidenceBundle` index and one normalized `RuntimeEvidence` row when a workspace materialization record is first stored, carrying backend readiness evidence and policy digest without raw backend payloads. It also records one linked workspace audit event and one compact `EvidenceBundle` index when a staged workspace review is first stored, and skips duplicate audit and evidence rows on review upsert.
- `apps/nanocore/src/runtime/workspace-materializer.ts` builds input snapshot and materialization records, rejects present semantically empty worker change-set manifests, parses nonempty manifests, and stages change sets into pending reviews.
- `apps/nanocore/src/runtime/filesystem-workspace-sync.ts` implements content-addressed filesystem manifests, filesystem change-set comparison, staged copy, and conflict-checked apply.
- `apps/nanocore/src/app.ts` and `@openkit/core-client` expose workspace-sync read APIs, and the unified `openkit` Skill projects the same operations through its bundled CLI, including redacted backend workspace handle, worker output manifest, workspace apply plan, and workspace reconciliation record readback. The durable Workspace Sync Review decision schema and route accept exactly `accepted`, `needs_refinement`, `rejected`, or `blocked`, pass the selected value through unchanged, and permit apply only for `accepted`. The generic unversioned Artifact Review route, artifact-to-durable decision fallback, identifier-prefix inference, and verdict translation are absent. A backing Artifact can still supply a read-only legacy review projection when no durable row exists, but that projection performs no write and cannot be decided or applied; durable authority takes precedence whenever present.
- `apps/nanocore/src/runtime/workspace-apply-results.ts` records one linked workspace audit event and one compact `EvidenceBundle` index when a new durable apply result is stored, and skips duplicate audit and evidence rows on idempotent apply-result replay.
- `apps/nanocore/src/runtime/worker-governance-turn-executor.ts` imports worker workspace changes into review artifacts and durable records.
- Worker governance tests cover the current NanoHost package import and workspace evidence path, while the retained A1 Unit F gate proves the NanoHost transport and fault scenarios. No Cell, SSH, Gateway-forward, or direct worker route remains selectable.
- Server tests cover review listing, Git patch apply, filesystem staging apply, filesystem permission-change apply, and persisted apply results after app restart.
- `WorkspaceSynchronizationBackendKindSchema` still includes `host` for host-local staging and deterministic harnesses. It must not be read as permission to reintroduce host execution as a product Worker Agent runtime.

The implementation now persists redacted `BackendWorkspaceHandle` rows at materialization time and carries them through workspace export/import. `WorkspaceMaterializationRecord` and `BackendWorkspaceHandle` bind the owning AEP `packageSnapshotId` separately from the backend `workerSessionId`; terminal events, teardown, stale-lease recovery, and import reminting correlate by package lineage, while review persistence rejects missing materialization records instead of fabricating them from change sets. It also persists `WorkerOutputManifest` rows derived from collected change sets before reviewed change-set readback, exposes them through App API, Core Client, and unified Skill operations, and carries them through workspace export/import. Portable import remints worker-Turn evidence refs consistently across output manifests, change sets, and general review bundles. It persists `WorkspaceApplyPlan` rows before accepted Git patch or filesystem staging apply mutations, exposes them through App API, Core Client, and unified Skill operations, and carries them through workspace export/import. It persists `WorkspaceReconciliationRecord` rows for recovery transitions, exposes them through App API, Core Client, and unified Skill operations, and carries them through workspace export/import. It persists `WorkspaceQuarantineRecord` rows for isolated invalid synchronization material, exposes them through App API, Core Client, and unified Skill operations, and carries them through workspace export/import. It automatically promotes materialization readiness evidence, staged review evidence refs, patch digests, and apply-result lineage into the general `EvidenceBundle` ledger, and no `WorkspaceSyncEvidenceBundle` schema, table, API, client or Skill operation projection, recovery input, or workspace export/import family remains. `WorkspaceReconciliationRecord.evidenceBundleIds` retains recovery-required bundle ids, lifecycle records retain their product-safe refs and digests, and `resume_collection` combines the reconciliation record with matching durable output manifests without requiring live backend reachability. Recovery-specific Action Center rows project `WorkspaceReconciliationRecord` rows in `requires-human`; `resume_collection`, `stage_verified`, `quarantine`, and `abandon` recovery decisions are executable through App API, Core Client, and the unified Skill's bundled CLI. Terminal recovery decisions set the record retention decision to `teardown-backend`. Filesystem synchronization detects POSIX permission-only changes as `mode_changed`, carries old and new permission summaries on changed paths, records them in apply plans, applies accepted permission changes through the same reviewed filesystem staging path, and reports target path type conflicts during apply preflight before mutating the workspace. Binary changed paths carry artifact-only review presentation with digest, media type, byte size, summary, and typed staged-review diagnostics; binary payloads over 1 MiB use the same artifact-only presentation with an explicit payload-size reason. Worker-control terminal events move matching `BackendWorkspaceHandle` rows from `pending` to `retained`, while governed worker teardown later moves matching handles to `cleaned` after successful backend teardown or `failed` after backend teardown failure. Scheduler lease maintenance records `WorkspaceReconciliationRecord` recovery triggers when a stale lease still has pending backend workspace handles. The active restart slice preserves pending handles during `awaiting-reconnect`, continues the same handle after adoption, and resumes accepted final status through the ordinary collection and cleanup path. Object-store synchronization and richer multi-backend recovery orchestration remain deferred future work.

## Record Contract

Workspace synchronization uses workspace-owned records. The named synchronization graph is authoritative in `workspace.sqlite`; any inspectable or portable file form is a non-authoritative projection or manifest. Every record carries workspace, thread, turn, AgentSession, package snapshot, backend summary, and digest references where applicable.

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

`WorkerOutputManifest` records changed workspace state. NanoCore classifies the accepted scan into this record. The worker does not write it. It describes changed files, added files, deleted files, binary files, permission changes, generated artifacts, logs, test output refs, ignored outputs, and digests.

`WorkspaceChangeSet` is the canonical reviewable unit. It includes changed paths, patch refs, binary refs, permission summaries, delete markers, conflict base digests, generated-file classification, worker rationale when available, and evidence ids. On a snapshot-chain changed-capture link, the link record holds `base` as the previous captured snapshot pair on that work volume, or Core's accepted base pair when the link is the first, `head` as the second scan's snapshot pair with the worktree `HEAD` commit as context only, `unstable` when the scan says so, and the credential-check result. That link is capture provenance and carries no patch Core applies. A nonempty immutable candidate against Core's accepted base produces this reviewable `WorkspaceChangeSet`. An empty candidate records the same link and advances the capture cursor without a `WorkspaceChangeSet` and without a review. An unstable `no_new_head` observation uses this same collection-link owner with `base` and `head` both equal to `previousHead`, creates no `WorkspaceChangeSet` and no review, and does not advance the cursor. A stable unchanged capture needs no additional link. The patch refs on a reviewable change set name the immutable review candidate from the accepted base recorded when the candidate is staged to that `head`.

The change-set review patch payload has an optional closed `encoding` member: absent means UTF-8 text; `base64` means exact bytes carried as canonical base64.

`StagedWorkspaceReview` records where NanoCore staged a change set for review. It
includes staging strategy, staging reference, optional review branch, diff
summary, risk summary, validation results, and Action Center row id.

The durable `StagedWorkspaceReview` row is the sole Workspace Sync Review decision authority. Its status is initially `pending` and may terminate only as `accepted`, `needs_refinement`, `rejected`, or `blocked`; `approved`, `accept`, `refinement`, `reject`, `defer`, `deferred`, and `redo` are not aliases.

Each durable staged-review row stores exactly one immutable `artifactId`, exposed as `WorkspaceSyncReviewItem.artifactId`, that names the backing Artifact presentation for the same Workspace Sync Review and `WorkspaceChangeSet`. The Artifact preserves the staged payload and evidence snapshot; it does not mirror later review status and it remains non-authoritative if its row is unavailable. The stored `artifactId` relationship, not an identifier prefix or parsed Artifact content, classifies the Artifact as Workspace Sync Review presentation. An Artifact named by that relationship is internal review evidence, not a submitted user deliverable. Product Artifact inventory, output counts, Artifact search and new conversation attachment selection and acceptance MUST exclude it in every review state. Historical references, authorized direct content inspection, export and Workspace Changes inspection retain it. Missing relationships MUST NOT be inferred from a title, kind, id prefix or parsed payload; unrelated explicitly submitted outputs remain eligible. An Artifact named by that relationship MUST be excluded from generic Artifact Review decisions, and neither its absence nor a generic Artifact Review record may replace, resolve, or apply the durable Workspace Sync Review.

The literal credential-value check in Snapshot Chain is a different check from the heuristic below. Workspace Sync Review raw-secret shape validation scans all non-patch fields and ordinary patch content. To avoid incidental token-shaped substrings in the generated CLI, complete Git unified-diff hunk bodies for the exact repository-relative path `skills/openkit/scripts/openkit` are exempt from this heuristic. Both Git header paths and the old/new file headers must identify that artifact (with `/dev/null` permitted for addition or deletion); renames across this boundary, unsupported formats, ambiguous headers, and malformed hunks retain full scanning. Patch metadata and other files in the same payload remain scanned, including through review-item and list-response validation. This exception changes no credential injection, redaction, review authority, storage, or lifecycle contract and does not certify generated artifact contents as secret-free.

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

Durable Workspace Sync Review states:

- `pending`
- `accepted`
- `needs_refinement`
- `rejected`
- `blocked`

Staging and collection progress remain in their existing owners and are not additional review states. `unstable` is a recorded fact on one collected link, not a new review state and not a failed collection by itself.

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

The Git strategy is the default path for a Git data source.

A new empty working target receives a clean checkout at the requested base commit. An admitted retained target follows `docs/specs/20260910-persistent_worker_volumes.md`: preserve dirty, untracked and ignored work, validate source identity, and report a baseline conflict for explicit reconciliation instead of reset or clone-over-existing. A later chain head on the same source is the next `base`, not a baseline conflict that blocks the next Turn. A different source identity remains a conflict under that persistent-volume owner. Preserving ignored work does not put untracked ignored paths into the collected diff. The worker may write and commit inside the worker runtime, and default hosting writes use selected Gateway MCP; native Git push requires separately admitted user-space credentials and receive-pack egress. The outside scan collects inspection evidence; non-Git Workspace publication still uses the staged review/apply path.

Inspection evidence for a Git source may include a changed-file list, verification command output refs, and a concise summary. That evidence does not authorize publication. External Git hosting is a vendor branch or pull request through selected Gateway MCP supply, without host checkout apply. Commit bundles are not part of this output.

The worker-written `workspace-changes.json` and `workspace.patch` are not the birth of this change set. They are removed, not retained as a fallback.

Non-Git Workspace apply records an empty commitIds list. Local worker commit creation uses Sandbox Git; external Git hosting uses Gateway MCP. Tags, deploys and other effects stay with their respective owners.

Default platform-managed GitHub write credentials stay at the Gateway. Workers create branches, write file changes and create or update pull requests through the selected vendor MCP under its current authorization and per-tool approval rules.

## Non-Git Filesystem Strategy

The filesystem strategy handles directories or file collections that are not Git
repositories.

NanoCore creates a content-addressed snapshot manifest before worker execution.
The manifest includes relative path, file kind, size, digest, permissions
summary, writable flag, and ignore reason when excluded.

The backend materializes the selected snapshot into the worker runtime. After execution, the same outside scan that covers Git trees covers non-Git trees on the volume and, when the candidate is nonempty, produces the `WorkspaceChangeSet` under the snapshot-chain rules. The snapshot reference is the tree and full-permission manifest pair Snapshot Chain defines. This specification does not add a second in-Sandbox collector.

NanoCore downloads changed files into a staging area rather than overwriting the
original workspace. Accepted apply copies staged changes into the target
workspace using path allowlists and conflict checks.

Permission-only and `mode_changed` changes are not silently applied. Filesystem
staging has explicit reviewed POSIX permission-apply support. Other unsupported
permission changes must be rejected, blocked, or quarantined with reviewable
evidence.

Binary files and large files require summary, digest, media type, and explicit
review affordances. The exact artifact-only size threshold remains policy.

## Control Channel And Data Transport

The shared control HTTP/2 session carries bounded metadata. Its `/worker-control/*` family may carry heartbeat, turn events, approval state, Artifact notices, and final status under the worker-control credential and semantics. It does not carry a ready notice for `/openkit/session/workspace-changes.json`, because that publisher is removed. Bounded metadata on this channel stays.

Existing native or bounded data-transfer owners move large payloads: repositories, patches, bundles, logs, generated Artifacts, changed files, raw transcripts, and evidence exports. `/worker-control/*`, `/inference/*`, and `/capabilities/*` MUST NOT carry these bulk bytes merely because they share one HTTP/2 connection.

Examples:

- OpenShell: one NanoHost-owned fixed single-file data stream on the authoritative outer physical connection plus the fixed sandbox helper, without using a control stream or exposing the loopback Gateway or lifecycle handles to NanoCore.
- Docker: bind mounts, `docker cp`, tar streams, or container diff.
- Host worktree: direct filesystem operations in a temporary worktree or staging root.
- Remote VM: native Git, rsync, or bounded Artifact upload under its existing data owner.
- Managed sandbox: provider file APIs.

The control channel may carry small metadata previews allowed by policy, and it does not carry full patches or file payloads. The worker-written `/openkit/session/workspace-changes.json`, the control-channel announcement that the file is ready, and the terminal-barrier export of that file are removed and are not how a change set is created. A completed scan whose review candidate is empty, with no content, path, file-kind, deletion, or supported permission delta against Core's accepted base, produces zero change-set candidates, staging files, staging digests, reviews, and apply effects. A changed capture still records its link and advances the cursor. A failed, partial, contradictory, or non-contiguous scan is not reclassified as that empty result. The review-candidate bytes travel on `workspace.collect` as [NanoHost Workspace Data Boundary](20260801-nanohost_workspace_data_boundary.md) defines, not on this channel and not as `file.export`. Any `file.export` that remains keeps a slot-relative declaration, digest and length after NanoCore accepts that Turn's `final_status`, which [Worker Control Protocol](20260703-worker_control_protocol.md) defines as sealing the Turn's transcript, provenance, and artifact output, and not after process-group absence. NanoCore verifies and atomically stages those bytes, and classification stays with the existing owner. Collection completion is the next-Turn gate, not that export barrier.

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
- collect the outside scan's change set at Turn end, at AgentSession release, and before a successor on the same volume, while the worker may still be running, plus artifact notices, logs, and final status; teardown is not the collection gate
- record every gateway, sandbox, policy, upload, download, and file-transfer step as backend evidence

The OpenShell adapter compiles OpenKit-owned materialization plans into OpenShell-native artifacts and normalizes OpenShell evidence back into OpenKit-owned records. Public App API, end-user CLI, Action Center, and reviewer surfaces must not need OpenShell-native ids or YAML.

## Generated Files And Object Store Inputs

Generated files can be:

- runtime-only files
- workspace change candidates
- artifacts
- both artifact and workspace change candidates

The worker must classify generated files. NanoCore may override classification
during import. If a generated file is user-facing output, it should be an
artifact. If it is intended to change the workspace, it should be part of a
change set. It can be both when the Artifact presents the same file under review, but the durable Workspace Sync Review still owns every decision and apply effect.

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

A worker step that produces changes should normally end in a review phase. Each collected link whose candidate contains a content, path, file-kind, deletion, or supported permission delta stages one Workspace Sync Review of that immutable candidate. An empty candidate does not stage a review, and a changed capture still records the link and advances the cursor. `unstable` does not skip review and does not by itself accept the bytes. An unstable `no_new_head` stages no review because it creates no candidate. Action Center should show a row for the staged change set.

A Workspace Sync Review decision is exactly one of `accepted`, `needs_refinement`, `rejected`, or `blocked`. The workspace-sync decision command accepts those values verbatim; `accept`, `reject`, `defer`, `deferred`, and `redo` are invalid rather than aliases. Presentation labels may be human-readable, but clients and Action Center actions MUST submit the canonical value without translation.

The durable Workspace Sync Review is the only decision and apply owner for its change set. Its command is addressed by `reviewId` through the workspace-sync review decision route. The backing `artifactId` is inspection and evidence linkage only: the generic Artifact Review route MUST NOT decide or apply it, no Artifact id prefix may select the Workspace Sync Review path, and no generic Artifact Review verdict may be translated into this vocabulary.

Only a command decision of `accepted` authorizes creation or continuation of the exact `WorkspaceApplyPlan`, strategy-specific mutation, and `WorkspaceApplyResult`. Before handoff the durable Review remains `pending`; the existing apply owner persists the terminal `accepted` Review and successful apply result together. `needs_refinement`, `rejected`, and `blocked` are terminal review decisions with no workspace mutation and no implicit retry, follow-up Turn, or generic Artifact Review effect; any later work must use its separately documented owner and produce a new review when appropriate.

The authenticated actor of the fresh Workspace Sync Review/apply command is the current `review.apply` authority. After validating the exact pending Review, requested `accepted` decision, change set, target, and existing policy or Approval preconditions, NanoCore applies the shared current-authority predicate immediately before handing the accepted command to the existing serialized filesystem apply owner. That handoff is the V1 governed-effect boundary. The owner may finish its existing queue, apply preflight, staging, and target mutation if membership changes after handoff; revocation applies at the next owner boundary. The worker Turn's `triggerActor` remains immutable source lineage and does not authorize apply; a removed or disabled worker origin does not prevent a different currently authorized owner or editor from applying the reviewed output through their own new command. A failed handoff check performs no strategy mutation and writes no successful `WorkspaceApplyResult`; it leaves the Review pending, does not promote stale output by inference, and creates no apply-recovery state. The existing plan and worker evidence remain non-authorizing inspection records, and a later fresh authorized command re-runs every normal precondition. V1 adds no inner authorization callback, cross-owner lock, rollback protocol, or settlement workflow for the bounded post-handoff race.

After a successful authority handoff, the existing apply owner must:

- verify workspace baseline still matches expected digests
- detect path conflicts
- detect binary overwrite risks
- detect unsupported permission changes and record supported permission changes
- create an apply plan

Conflicts create a review item or apply result and do not silently merge.

The first filesystem apply slice uses a NanoCore-owned opaque staging registry.
Public review payloads expose only `filesystem-staging://...` references, while
NanoCore stores the internal staging root, target root, and before manifest in
private storage. Accepted filesystem reviews apply through conflict preflight and
apply reviewed POSIX permission changes when the changed path carries a
`newPermissions` summary.

## Recovery And Reconciliation

A transport loss and a NanoCore process restart are the same adoption entry: either may adopt the exact surviving binding under the existing proof contract. [AgentSession Continuity](20260704-agent_session_continuity.md) owns whether a binding can be adopted. A binding that cannot be proved exactly after either event is closed or fenced, and a successor resumes the native conversation.

1. Load active materialization, worker session, review, staging, apply, and backend handle records.
2. Read the exact owning lease and worker-control recovery outcome.
3. After a transport loss or a NanoCore restart, if the lease is `awaiting-reconnect`, preserve the existing materialization and `BackendWorkspaceHandle` in their current nonterminal state; do not collect, stage review, create reconciliation, or tear down while the original worker may continue.
4. After a transport loss or a NanoCore restart, if exact adoption succeeds under the existing proof contract, with exact lineage, sequence, and lease and with no duplicate effect, keep the same materialization and backend handle. Turn-end collection does not wait for process exit. Release and pre-successor collection use the same scan owner. When final status arrives, run the ordinary verification, review, and cleanup flow for that same turn.
5. If durable accepted `final_status` already placed the lease in `releasing`, resume the same terminal handoff. Unfinished collection resumes without another heartbeat only when the check values Snapshot Chain requires are available. The persisted loopback digests remain available after a NanoCore restart. When a recorded Vault material version cannot be resolved, collection returns `recovery_required` with cause `check_values_unavailable`, stages no review, and does not advance the cursor. A link whose head is already committed is exact replay of that link, not a second scan that advances the chain again.
6. After a transport loss or a NanoCore restart, if reconnect key, lineage, sequence, or deadline verification fails, or the scheduler declares the lease stale, lost, or cleanup-fenced, the binding is not adopted. Use the latest durable materialization record, backend handle, output manifests, and general evidence bundle refs to enter the existing reconciliation flow. The predecessor is closed or fenced with its records kept, and only a newly admitted successor that resumes the native conversation continues.
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
- `WorkerOutputManifest` is now persisted in first-slice form from the accepted scan's change-set declarations before reviewed change-set readback. Later backend transport collection should enrich log refs, test output refs, ignored outputs, and backend-native evidence while preserving this write-before-review discipline.
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

Recovery triggering binds to the scheduler: `awaiting-reconnect` MUST preserve nonterminal synchronization lifecycle records and MUST NOT trigger collection, review staging, or teardown after a transport loss or a NanoCore restart. Exact adoption of the exact surviving binding, proved by exact lineage, sequence, and lease with no duplicate effect, keeps using the same records after either event. A binding that cannot be proved exactly after either event is not adopted: the predecessor is closed or fenced with its records kept, and only a newly admitted successor that resumes the native conversation continues. Unfinished collection follows the Snapshot Chain check-value rule. A session lease reaching `stale`, `lost`, or a fenced takeover per `docs/specs/20260703-durable_scheduler_design.md` MUST trigger reconciliation evaluation for any non-terminal synchronization lifecycle records tied to that lease's AgentSession, while a `releasing` lease with accepted final status resumes existing terminal handoff and does not mint a second link for a head that is already committed. Workspace synchronization owns what recovery does; the scheduler owns whether execution remains live.

## Action Center Projection

Action Center should project pending staged workspace reviews even when the
original artifact row is not available in the current store projection.

The row source is the durable Workspace Sync Review and exact `reviewId`; its required `artifactId` provides an inspection target when that Artifact is available, never a second decision source. The row exposes only actions that submit `accepted`, `needs_refinement`, `rejected`, or `blocked` directly to the workspace-sync review decision route.

When recovery evidence is partial or ambiguous, Action Center should project
`requires-human` with links to the materialization record, collection state,
available evidence, and next safe recovery choices.

The current implementation surfaces durable workspace review decisions for staged reviews whose artifact row is no longer available in the current store projection, first-slice workspace recovery rows for `requires-human` reconciliation records, and
executable recovery decisions for resume collection, stage verified, quarantine,
and abandon. Resume collection recovers records when matching durable worker
output manifests already exist and fails closed when no durable output manifest
matches the recovery record.

Workspace-linked backing Artifacts remain available for inspection and may supply the current read-only legacy projection when no durable review exists, but no generic Artifact Review decision or Artifact projection can select, resolve, or apply a Workspace Sync Review.

## Alternatives Considered

### Sandbox Direct Push

Direct native Git push is not the platform default. A user may separately inject a credential and admit git-receive-pack; OpenKit adds no mechanism for that path. Platform-managed hosting uses selected Gateway MCP.

### Always Use Git

Always using Git would simplify the first OpenKit self-improvement loop, but it
would make OpenKit unusable for non-Git workspaces and would conflate version
control with workspace synchronization.

Git is a strategy, not the abstraction.

### Stream All Files Through Worker Control

Streaming all file data through the `/worker-control/*` route would simplify one code path but
would overload the control plane, create large-message and retry problems, and
duplicate backend file APIs.

The control route announces and indexes bounded metadata; native or bounded data transport moves bulk data.

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
added and modified files into a host staging root, and apply accepted staged
changes back to a target root after conflict preflight.

The Action Center can project pending durable staged workspace reviews even when
the original artifact row is not available in the current store projection, and
those rows can now resolve `accepted`, `needs_refinement`, `rejected`, and `blocked` outcomes
through the durable workspace synchronization review decision route.

The active restart slice adds bounded awaiting-reconnect gating, same-handle continuation after exact adoption, and direct terminal handoff through the existing reconciliation and review owners.

## Rollout / Migration Plan

No legacy preservation is required for data shapes from before the storage baseline; later changes keep retained data usable under Retained Data Continuity in `docs/core/contract-evolution.md`.

Phase 1: remote Git source materialization in the worker runtime, and vendor branch or pull-request output through selected Gateway MCP. Retain independent inspection evidence and the separate non-Git staged apply path.

Phase 2: Filesystem snapshot, change manifest, staging, conflict preflight, and
apply. This is partially implemented for host-dir roots and opaque filesystem
staging.

Phase 3: First-class recovery records: backend handles, output manifests,
reconciliation records, evidence bundles, quarantine records, and
recovery-specific Action Center rows.

Phase 4: Richer backend strategies such as Docker diff, rsync, managed sandbox
file APIs, and object-store transfer.

## Testing Strategy / Acceptance Criteria

- Schema tests for workspace synchronization records, path safety, and raw-secret rejection.
- Migration tests for synchronization, staging, and apply-result tables.
- Runtime tests for input snapshot construction, materialization record construction, manifest parsing, path allowlists, and staged review creation.
- Workspace-change collection tests prove that a second snapshot pair equal to `previousHead` is `no_new_head` and does not advance the cursor, and when the two scans disagree that result carries `unstable` true and records the observation link with `base` and `head` both equal to `previousHead` without a review, and that an empty review candidate, one with no content, path, file-kind, deletion, or supported permission delta against Core's accepted base, yields no staged review or apply effect while a changed capture still records its link and advances the cursor. Accepted base content 0, previous capture 1, and scan 0 return `empty`, record the link, advance the cursor to that snapshot, stage no review, replay that link on restart, and start the next link at 0. Byte-identical captures `0644`, then `0600`, then `0644` keep one Git tree id, change the manifest blob with the mode, yield a `mode_changed` review for `0644` to `0600` with no automatic apply, and restore the first manifest blob on the return to `0644`. Two scans that differ only in full mode, and whose second pair differs from `previousHead`, are `unstable`, record the second mode, and survive restart without changing the earlier snapshot's mode. Previous captured mode `0644`, first scan `0600`, and second scan `0644` return `no_new_head` with `unstable` true, record that observation link, leave the cursor unchanged, stage no review, and replay the observation on restart without overwriting an earlier link's stability. A root containing `dir/file` emits records for the directory entry and for `dir/file` and emits no record for the root. A path containing an embedded U+000A round-trips by length-directed decoding. An empty directory is an entry of neither the tree nor the manifest. `.git/config`, `.GIT`, and `vendor/repo/.GiT/config` are absent from both the tree and permission manifest, while `vendor/repo/file` is admitted subject to ordinary path and ignore rules; `.gitignore` remains subject to those rules, and every excluded working entry remains on disk. A failed, partial, contradictory, or non-contiguous scan fails before change-set, review, or apply creation and is not reclassified as an empty candidate. First collection does not adopt the current worktree as an accepted base. An unknown, absent, or unverifiable accepted pair, a base that is not the previous head, an unreadable named snapshot, a malformed manifest, an unsafe path, unavailable metadata, or a tree and manifest disagreement returns `recovery_required` with the matching closed cause, writes no review, and does not advance the cursor. Among paths admitted by the shared path rules, capture excludes an untracked path only through contained worktree `.gitignore` rules, and a path in `previousHead` remains tracked. Both modes exclude repository-metadata components under the shared admission rule without changing retained bytes.
- Baseline collection of a new empty slot is the only collection without an accepted pair. It scans twice, checks every blob for credentials, and returns a pair only when the two pairs are equal. It uses the shared path admission, including repository-metadata exclusion at every depth, but does not apply ignore exclusions. Core records the pair as accepted base and cursor only when the returned identity matches the expected identity, writes no review and no collection link, and only then may the first Turn be dispatched. Unequal scans return `recovery_required` with cause `baseline_unstable`. For a non-Git source, a returned tree that is not the expected tree returns `baseline_mismatch`, and an underivable expected tree returns `baseline_source_unavailable`. For a Git source, `baseline_source_unavailable` is a Sandbox client that cannot fetch, check out, or report HEAD, and `baseline_mismatch` is a reported commit id that differs from the pinned commit id. NanoCore reads no host repository for that check. Each records no accepted base and admits no first Turn. A retained slot is not re-baselined. Ordinary collection with an unknown base still returns `accepted_base_unknown`.
- Rejected-predecessor tests prove that a rejected link which captured only file `a` does not move the accepted base, that the next link's review candidate from that base includes both `a` and a later file `b`, and that accepting the later review does not change the earlier rejection.
- Contract and route tests that accept only `accepted`, `needs_refinement`, `rejected`, or `blocked`, reject generic Artifact Review vocabulary without translation, and prove that only `accepted` may create an apply plan or mutate a workspace.
- Action Center and route tests that classify workspace-review Artifacts only through the exact durable `artifactId` relationship, never an id prefix, and reject the generic Artifact Review route for those Artifacts even when the backing Artifact remains readable.
- Git output tests prove a vendor branch or pull request through selected Gateway MCP supply, and prove that publication does not require host apply. Filesystem digest, base, conflict, apply result, and restart tests remain with the filesystem apply owner.
- Filesystem apply tests that validate content-addressed manifests, staged copy, conflict preflight, delete handling, and durable apply result persistence.
- Worker governance tests for target NanoHost-owned stock OpenShell materialization, evidence persistence, change-set import, review Artifact creation, sandbox-local normal cleanup, and epoch invalidation on unproved cleanup.
- Restart recovery tests prove that a transport loss and a NanoCore process restart both keep awaiting-reconnect with no collection or teardown and may adopt the exact surviving binding with the same materialization and backend handle under exact lineage, sequence, and lease with no duplicate effect. A binding that cannot be proved exactly after either event is not adopted: the predecessor is closed or fenced, its records are kept, and only a newly admitted successor that resumes the native conversation continues. They also prove accepted final status resumes an unfinished collection without another heartbeat only when the required check values are available, returns `recovery_required` with cause `check_values_unavailable` when the recorded Vault material version cannot be resolved after a crash before the scan, and does not require process-group absence or a second link after a committed head. A blob that contains a loopback credential embedded in a longer run of the credential alphabet is caught by the 43-byte window digest comparison, and a collection after a NanoCore restart still checks the loopback credentials. Reconnect timeout entering existing reconciliation, reachable and unreachable backend sessions, partial collection, digest mismatch, quarantine, and `requires-human` stay.
- Binary, permission-change, generated-file, and object-store staged file tests before those paths are marked implemented.

## Risks & Mitigations

- Risk: Backend state is treated as truth after restart. Mitigation: recover only through NanoCore records plus verified collected evidence.
- Risk: Restart collection races a worker that is still running during bounded reconnect. Mitigation: scheduler and worker-control recovery outcome gates synchronization; `awaiting-reconnect` preserves the existing handle and forbids collection, review staging, and teardown.
- Risk: A live worker writes during a Turn-end, release, or pre-successor scan. Mitigation: the two scans record `unstable` when they differ, the next link starts at that head, and the Sandbox is not frozen.
- Risk: a worker-held hosting credential can publish outside the Gateway. Mitigation: platform-managed GitHub write credentials stay at the Gateway, native Git push is only explicit user-space configuration, and synchronization never publishes to a hosting service as an apply side effect.
- Risk: Binary changes bypass review quality. Mitigation: require binary summaries, digests, media type, and explicit review state.
- Risk: Non-Git file comparison can miss permission or binary changes. Mitigation: use content-addressed manifests and block unsupported permission apply.
- Risk: Generated files are duplicated as artifacts and changes without linkage. Mitigation: allow both, but require cross references.
- Risk: Object-store mounts hide changes from review. Mitigation: prefer staged files and gateway reads first.
- Risk: Path traversal or symlink attacks escape staging. Mitigation: reject absolute paths and traversal, resolve real paths, and stage before apply.
- Risk: OpenShell becomes the hidden product control plane because it is the first rich backend. Mitigation: keep NanoCore-owned records canonical and require public surfaces to use OpenKit ids and redacted summaries.

## Resolved Decisions

- This spec supersedes `docs/specs/superseded/20260627-workspace_materialization_sync.md` as the active workspace synchronization contract.
- Default hosted Git results are Gateway-created vendor branches or pull requests; inspection capture does not authorize publication.
- Non-Git reviewed application updates canonical Workspace files and records its existing apply result with an empty commitIds list. Git repository output is not applied to a NanoCore checkout.
- Local Git commits are worker-local work. External Git hosting follows Worker MCP Tool Supply; synchronization never publishes to a hosting service as an apply side effect. Tags and deploys retain their separate owners.
- Workers do not receive platform-managed GitHub write credentials in the default path; the Gateway holds those credentials. Explicit user-space native push configuration remains outside that default.
- Filesystem snapshot support is part of the first contract and is already partially implemented for host-dir roots.
- Partial or ambiguous recovery evidence surfaces as `requires-human`.
- Exact adoption after a transport loss or a NanoCore restart preserves the current materialization and backend handle when the surviving binding is proved exactly, including exact lineage, sequence, and lease, with no duplicate effect. A binding that cannot be proved exactly after either event is not adopted: the predecessor is closed or fenced with its records kept, and only a newly admitted successor that resumes the native conversation continues. Synchronization also collects at Turn end while the AgentSession stays open, at AgentSession release, and before a successor on the same volume, and it still collects or reconciles on adoption, accepted terminal handoff, or the scheduler's existing interrupted outcome. Restart adds no settlement coordinator or copied domain state.
- Permission-only changes use the reviewed filesystem staging path when the staged review records `mode_changed` summaries and apply preflight succeeds; unsupported permission mutations are blocked or quarantined with diagnostics.
- Long-lived host Codex sessions do not define the product materialization model because host execution is not a product Worker Agent runtime. Governed worker work uses this workspace synchronization model; direct human-driven local work remains outside it unless it needs review-gated workspace synchronization.
- Previously open questions are resolved by accepted V1 defaults: binary files become artifact-only when they are not safely text-decodable or when a binary payload exceeds 1 MiB. Artifact-only handling carries summaries, digests, media type, byte size, explicit review affordances through staged-review readback, and typed diagnostics when a worker attempts to present binary content as a normal text patch.

## Deferred / Future Work

- Hosted Git effects are owned by [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md). Local Git and user-space native push are owned by [Worker Sandbox Freedom Policy](20260709-worker_sandbox_freedom_policy.md).
- Define object-store-backed large workspace inputs and outputs.

Recovery records, quarantine records, and recovery-specific Action Center rows
were promoted from deferred work into the Recovery Records And Quarantine
Contract above; their build-out is implementation work tracked through the
`Implementation` field, not deferred design.

## Links

- `docs/specs/superseded/20260627-workspace_materialization_sync.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260709-worker_sandbox_freedom_policy.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260801-nanohost_workspace_data_boundary.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/core/storage.md`
- `docs/core/sandbox.md`
- `docs/core/audit.md`
- `docs/core/agent-workflow.md`
- `docs/product-vision.md`
- [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw)
- [NVIDIA OpenShell documentation](https://docs.nvidia.com/openshell/)
