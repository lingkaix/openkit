# Workspace Materialization And Synchronization

Status: Superseded
Implementation: N/A
Status Changed: 2026-07-03
Current Guidance: `docs/specs/20260703-workspace_synchronization.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The unified Workspace Synchronization specification absorbed this document's materialization, collection, staging, review, and application contract. This earlier slice lost authority because keeping its rollout assumptions and open questions active beside the consolidated contract would create competing ownership.

## Retention Reason

This document preserves the original backend-portable materialization design and rollout reasoning so maintainers can trace how the consolidated synchronization contract was formed without treating unresolved historical questions as current requirements.

## Summary

OpenKit needs a backend-portable way to materialize a workspace into a worker runtime, collect worker changes back from that runtime, stage those changes for review, and apply approved changes without bypassing NanoCore's product state, evidence model, or human review gates.

The durable decision is that workspace synchronization is a NanoCore-owned contract, not an OpenShell-only feature.

OpenShell, Docker, remote VMs, managed sandboxes, and future worker backends can each implement the same materialization and collection contract with different transport primitives.

Git is the first optimized strategy because OpenKit's self-improvement loop uses GitHub repositories, but Git must remain one strategy under a broader `WorkspaceMaterializer` abstraction.

## Current Implementation Mapping

The 0.0.1 kernel already has durable NanoCore records and public schema coverage for workspace materialization records, workspace change sets, staged workspace reviews, and workspace apply results.

The current App API, Action Center, MCP resources, and worker governance tests expose the first review/apply foundation. Worker Governance-backed local and remote container review paths are implemented enough for developer-preview dogfooding and regression tests.

The remaining 0.x work is deeper restart recovery, backend portability, richer Git bundle/commit behavior, production-grade remote artifact storage, permission and audit hardening, and broader non-Git backend coverage.

## Goals / Non-goals

### Goals

- Define the canonical lifecycle for workspace input snapshotting, worker materialization, change collection, staged review, and approved apply.
- Keep NanoCore as the source of truth for workspace state, worker lineage, evidence, review gates, and accepted changes.
- Let backends use their native transport primitives without exposing backend internals as product contracts.
- Support Git repositories as the first implementation path for the OpenKit self-improvement loop.
- Support non-Git workspaces through filesystem snapshots, change manifests, and staged apply.
- Keep `control.local` focused on worker control metadata and small events instead of large file synchronization.
- Make synchronization reviewable, auditable, resumable, and safe across local mode, server mode, OpenShell, Docker, remote VM, and future managed sandbox backends.

### Non-goals

- Do not let sandbox workers directly push, deploy, publish, tag, or mutate protected branches as part of the first implementation.
- Do not make OpenShell the only materialization backend.
- Do not treat backend logs as canonical workspace changes.
- Do not expose raw host paths, process ids, container ids, OpenShell private payloads, provider secrets, raw environment values, or temporary credential material through product APIs.
- Do not require every backend to support every strategy in the first implementation.
- Do not replace Goal Mode, Action Center, artifacts, or review decisions with Git commit state.
- Do not implement unattended recursive self-modification.

## Background

The NemoClaw research loop showed that OpenShell can provide useful sandbox lifecycle, provider, policy, gateway, upload, download, and exec primitives, but it also showed that OpenKit's current OpenShell worker path cannot yet complete repo-writing work.

The missing piece is not only file copy.

The missing piece is a product boundary that says which workspace state was given to the worker, what the worker changed, what evidence proves the change, where those changes are staged, and who approved applying them.

NemoClaw's strongest lesson is that the product layer should retain registry, onboarding state, recovery decisions, and readiness evidence while OpenShell remains the backend for lifecycle and enforcement.

OpenKit should apply the same principle to workspace synchronization.

NanoCore owns workspace materialization records, change-set records, staged review records, and apply decisions.

The backend owns transport and isolation.

OpenShell is expected to be the first implementation for local and remote container execution, but the workspace synchronization contract must remain NanoCore-owned.

The design is OpenShell-first, OpenKit-owned semantics, capability-based portability.

OpenShell can provide the first transport and enforcement path without becoming the canonical source of workspace truth.

## Decision

OpenKit will introduce a backend-portable workspace materialization and synchronization model.

The canonical lifecycle is:

```text
workspace input snapshot
  -> materialization plan
  -> backend materialized workspace
  -> worker execution
  -> collected workspace change set
  -> staged review workspace
  -> human or policy approval
  -> approved apply
```

NanoCore owns every lifecycle record.

Backends implement lifecycle effects.

For Git repositories, the first materialization strategy should use clone or fetch into the worker runtime and collect a patch or commit bundle back into NanoCore.

For non-Git workspaces, the first materialization strategy should use a content-addressed filesystem snapshot, a change manifest, and staged file application.

## Proposed Design

### WorkspaceMaterializer Interface

NanoCore should define a `WorkspaceMaterializer` boundary with these conceptual operations:

- `prepareWorkspace(input) -> materializationPlan`
- `materializeToWorker(plan, backendSession) -> materializationRecord`
- `collectChanges(materializationRecord) -> workspaceChangeSet`
- `stageChanges(changeSet) -> stagedReview`
- `applyApprovedChanges(stagedReview, decision) -> applyResult`

The interface should be implemented by backend-specific adapters, but the records returned by the interface should use OpenKit vocabulary.

### Core Records

`WorkspaceInputSnapshot` describes what NanoCore intended to expose.

It includes workspace id, repository or filesystem resource id, selected path scope, base commit or content digest, writable path policy, ignored paths, generated task files, and redacted backend summary.

`WorkspaceMaterializationRecord` describes how a backend materialized that input.

It includes backend kind, worker session id, sandbox or runtime label, strategy, materialized root reference, base commit or snapshot digest, policy digest, and readiness evidence.

`WorkspaceChangeSet` describes what the worker produced.

It includes changed paths, additions, modifications, deletions, mode changes, binary summaries, patch digest, optional Git commit ids, optional bundle refs, test evidence refs, artifact ids, and redaction status.

`StagedWorkspaceReview` describes where NanoCore staged those changes for review.

It includes staging strategy, host staging reference, review branch or temp worktree label when applicable, diff summary, risk summary, validation results, and Action Center row id.

`WorkspaceApplyResult` describes the final accepted application.

It includes applied paths, commit ids when applicable, skipped paths, conflict records, verification evidence, and final reviewer decision.

### Git Strategy

The Git strategy is the default path for Git repository workspace resources.

The worker should receive a clean checkout at the requested base commit.

The worker may write and commit inside the worker runtime, but the first implementation should collect the result into NanoCore instead of allowing direct protected-repository push.

The preferred first Git output format is:

- a `workspace-changes.json` manifest
- a patch file generated from `base..HEAD`
- optional `git bundle` when preserving commit metadata is needed
- a changed-file list
- verification command output refs
- a concise worker summary item

NanoCore then applies the patch or bundle to a host-side staging worktree or branch.

The human reviews staged changes through Goal Mode and Action Center before accept, refine, reject, or retry.

Direct push from the sandbox should remain out of scope for the first implementation.

If GitHub token injection is available through OpenShell provider or integration mechanisms, it may be used for read access and for explicit ephemeral branch or fork workflows, but it must not bypass NanoCore review gates.

### Non-Git Filesystem Strategy

The filesystem strategy handles directories or file collections that are not Git repositories.

NanoCore creates a content-addressed snapshot manifest before worker execution.

The manifest includes relative path, file kind, size, digest, permissions summary, writable flag, and ignore reason when excluded.

The backend materializes the selected snapshot into the worker runtime.

After execution, the backend collects a second manifest and produces a change set by comparing digests and paths.

NanoCore downloads changed files into a staging area rather than overwriting the original workspace.

Binary files, large files, deleted files, and permission changes must be explicitly summarized for review.

Approved apply copies staged changes into the target workspace using path allowlists and conflict checks.

### Control Channel Versus Data Transport

OpenKit should keep two separate concepts.

`control.local` is for small worker control messages such as heartbeat, turn events, approval state, artifact notices, change-set ready notices, and final status.

Backend-native data transport is for large payloads such as repositories, patches, bundles, logs, generated artifacts, and changed files.

For OpenShell, data transport can use `openshell sandbox upload`, `openshell sandbox download`, `openshell sandbox exec`, and future OpenShell file primitives.

For Docker, data transport can use bind mounts, `docker cp`, tar streams, or container diff.

For host Codex, data transport can be direct filesystem operations in a temporary worktree.

For remote VMs, data transport can be Git, rsync, tar over SSH, or artifact upload.

For managed sandbox backends, data transport can use the provider file API.

The control channel may announce that `/openkit/session/workspace-changes.json` is ready, but it should not carry the full patch unless the patch is small enough for product metadata limits.

### Product Records Versus Backend Transport

Workspace synchronization must distinguish product records from backend transport.

Product records are NanoCore-owned and backend-portable.

They include `WorkspaceInputSnapshot`, `WorkspaceMaterializationRecord`, `WorkspaceChangeSet`, `StagedWorkspaceReview`, and `WorkspaceApplyResult`.

Backend transport is implementation-specific.

It may include OpenShell upload and download, `openshell sandbox exec`, Git clone and fetch inside a sandbox, `docker cp`, bind mounts, Kubernetes volumes, SSH and rsync, tar streams, hosted sandbox file APIs, or object-store transfers.

Backend transport may be the only practical way to move large payloads, but it must not define the review model.

All reviewable state should be summarized in NanoCore records, Action Center rows, artifacts, and evidence references.

OpenShell-specific file-transfer handles, sandbox ids, gateway labels, provider handles, and raw logs may be retained as restricted backend evidence, but public App API and MCP responses should expose only redacted summaries and OpenKit-issued references.

Small reviewable patch payloads may be copied from backend transport into a public `WorkspaceSyncReview` item when they are already represented by a `WorkspaceChangeSet.patch` reference and pass product redaction validation.

The public payload should include media type, text, digest, and byte count, and it should remain tied to the review item rather than becoming a generic backend file-read API.

### Backend Capability Selection

The materializer should select a strategy from declared backend capabilities.

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

If a required capability is missing, NanoCore should fail before launch with a redacted diagnostic and a suggested fallback.

If a capability is optional, NanoCore may choose a degraded or alternate strategy only when the resulting review and evidence guarantees remain explicit.

OpenShell may provide richer network, provider, file-transfer, and audit evidence, but the extra evidence should enrich OpenKit records rather than replace them.

### OpenShell Backend Shape

The OpenShell materializer should:

- prepare a Git clone or filesystem snapshot under the sandbox workspace
- pass workspace metadata through the Agent Environment Package
- restrict writes to declared workspace roots and output roots through policy
- keep provider and GitHub credential injection explicit and audited
- collect `/openkit/session/workspace-changes.json`, patch files, bundles, artifact notices, logs, and final status during teardown
- record every OpenShell gateway, sandbox, policy, and file-transfer step as backend evidence

OpenShell should not become the canonical source of workspace truth.

NanoCore should be able to recover or inspect materialization state after restart using persisted records and backend labels.

The OpenShell adapter should compile OpenKit-owned materialization plans into OpenShell-native artifacts and normalize OpenShell evidence back into OpenKit-owned records.

It should not require App API, MCP, Web UI, Action Center, or reviewer surfaces to understand OpenShell-native ids or YAML.

### OpenShell Codex Runtime Configuration

OpenShell Codex workers need the same effective Codex home that works on the host.

For ChatGPT-account based Codex subscriptions, uploading only `auth.json` is not sufficient because the container may fall back to a CLI default model that the account does not support.

NanoCore's OpenShell backend must therefore support explicit upload of both:

- `OPENKIT_OPENSHELL_CODEX_AUTH_JSON`, copied to `/sandbox/.codex/auth.json`
- `OPENKIT_OPENSHELL_CODEX_CONFIG_TOML`, copied to `/sandbox/.codex/config.toml`

These paths are runtime configuration and must not be exposed through public App API or MCP responses.

The backend may also accept `OPENKIT_OPENSHELL_CODEX_MODEL` for deployments that intentionally override the host Codex model, but the safest default is to preserve the host Codex config that already works with the logged-in subscription.

The OpenShell network policy must explicitly allow the Codex binary to reach the OpenAI or ChatGPT HTTPS endpoints required by the configured account.

The first verified dogfood configuration allowed `api.openai.com`, `chatgpt.com`, `chat.openai.com`, and `auth.openai.com` for `/usr/local/bin/codex` and `/usr/local/lib/codex/codex/codex`.

Future production packaging should replace this deployment-local allowlist with a named, documented Codex provider endpoint profile.

### Review And Apply

A worker step that produces changes should normally end in Goal Mode `reviewing`.

Action Center should show a review row for the staged change set.

The human may accept, reject, refine, retry, decompose, or block.

Accepting a staged change set applies the changes to the target workspace and may create a host-side commit if the workspace is Git-backed and the user approves commit creation.

Pushing to remotes remains a separate explicit human-approved action.

The first Git-backed apply slice uses the existing artifact review decision route for workspace synchronization review artifacts.

When the human accepts a workspace review artifact, NanoCore validates the collected patch payload against the `WorkspaceChangeSet.patch` digest and byte count, runs `git apply --check`, and then applies the patch to the linked repository with fixed Git arguments.

NanoCore persists the resulting `WorkspaceApplyResult` as a durable product record and exposes it through public App API and MCP read surfaces.

This first slice intentionally applies workspace files only; commit creation, push, tag, deploy, and other external side effects remain separate future human-approved actions.

## Alternatives Considered

### Sandbox Direct Push

Sandbox direct push is simple for GitHub repositories, but it bypasses NanoCore review gates, creates weak evidence, and makes failed or partial worker turns hard to reconcile.

It should not be the default.

### Always Use Git

Always using Git would simplify the first OpenKit self-improvement loop, but it would make OpenKit unusable for non-Git workspaces and would conflate version control with workspace synchronization.

Git should be a strategy, not the abstraction.

### Stream All Files Through control.local

Streaming all file data through `control.local` would simplify one code path but overload the control plane, create large-message and retry problems, and duplicate backend file APIs.

The control plane should announce and index data, while backend transport moves bulk data.

### Backend-Owned Synchronization

Letting each backend define its own synchronization semantics would move product state out of NanoCore and make Action Center, review, evidence, and recovery inconsistent.

Backends should implement transport, not product truth.

## Consequences

NanoCore has durable storage for workspace input snapshots, materialization records, change sets, staged reviews, and apply results.

The first write path stores workspace input snapshots before backend materialization, stores materialization records after the backend returns a product-safe materialization summary, and stores existing artifact-backed workspace review payloads into durable records before public reads and accepted apply.

The first deterministic non-Git harness can create content-addressed filesystem manifests, compare before and after manifests into a `WorkspaceChangeSet`, stage added and modified files into a host staging root, and apply approved staged changes back to a target root after conflict preflight.

The host backend now connects that filesystem harness to a real backend collection path for read-write `host-dir` workspace roots. Host materialization captures a before manifest, collection captures an after manifest from the worker-visible root, stages changed files into a host review root, and returns a filesystem `WorkspaceChangeSet` plus staged review record.

Accepted filesystem reviews now use a NanoCore-owned opaque staging registry. Public review payloads expose only `filesystem-staging://...` references, while NanoCore stores the internal staging root, target root, and before manifest in private storage and applies approved filesystem changes through conflict preflight.

The Action Center now projects pending durable staged workspace reviews even when the original artifact row is not available in the current store projection. This gives recovered workspace reviews a product-level attention row and a durable review read action without requiring live backend sessions.

Goal Mode worker outcomes will need to include workspace change evidence, not only artifacts and items.

The next required step is to complete deeper restart recovery and reconciliation for workspace synchronization records across all backend paths.

OpenShell worker implementation will need a real workspace setup and teardown collection path.

The Agent Environment Package should gain enough workspace metadata to describe base commits, snapshot digests, writable roots, output roots, and strategy choices.

Existing host-mode paths should be adapted to produce the same records over time.

## Rollout / Migration Plan

Phase 1 should implement the Git strategy for OpenKit self-improvement.

Phase 1 should support clone or fetch in the worker runtime, patch or bundle collection, host-side staging, and review evidence.

The first dogfood implementation uses backend-private tar materialization of the linked repository into an OpenShell worker, persists pre-worker input and materialization records, collects a `workspace-changes.json` manifest plus review artifact, and materializes that public review payload into durable NanoCore-owned synchronization records.

Phase 2 has a deterministic filesystem snapshot, change manifest, staging, conflict preflight, and apply harness.

Phase 2 now connects that harness to the host backend collection path for non-Git read-write `host-dir` roots.

Phase 2 also connects accepted filesystem reviews to an opaque NanoCore staging registry and filesystem apply route.

Phase 3 should add recovery and reconciliation after NanoCore restarts.

Phase 4 should add richer backend strategies such as Docker diff, rsync, managed sandbox file APIs, and optional ephemeral GitHub branch workflows.

No backward compatibility is required for internal pre-release data shapes.

## Testing Strategy

L1 tests should cover materialization planning, path allowlists, ignore rules, change-set parsing, patch metadata, redaction, and review-state transitions.

L2 contract tests should cover App API schemas for materialization records, change sets, staged reviews, and apply results.

L3 NanoCore black-box tests should cover a Git repository worker flow and a filesystem snapshot flow without real provider quota.

OpenShell tests should verify real or harnessed upload, clone, patch collection, manifest collection, and teardown.

Story tests should cover a bounded self-improvement loop that produces a staged change set and requires human approval before apply.

Real provider or GitHub-token tests must remain opt-in.

## Risks & Mitigations

- Risk: Git tokens in sandbox can bypass review by pushing directly. Mitigation: default to read-only or ephemeral branch access and keep protected push out of the first implementation.
- Risk: Non-Git file comparison can miss permission or binary changes. Mitigation: use content-addressed manifests with explicit binary and permission summaries.
- Risk: Large workspaces are expensive to snapshot. Mitigation: require scoped workspace inputs, ignore rules, and backend-specific incremental strategies later.
- Risk: Path traversal or symlink attacks can escape staging. Mitigation: normalize paths, reject absolute paths, reject traversal, and stage before apply.
- Risk: NanoCore restart can lose sandbox state. Mitigation: persist materialization records and backend labels before worker launch.
- Risk: Control and data transport boundaries blur. Mitigation: keep `control.local` for metadata and use backend file transport for bulk data.
- Risk: OpenShell becomes the hidden product control plane because its implementation is the first and richest backend. Mitigation: make OpenShell first-class but adapter-bound, keep NanoCore-owned records canonical, require public surfaces to use OpenKit ids and redacted summaries, and select behavior through declared backend capabilities.

## Open Questions

- Should Git commit metadata be preserved through `git bundle` in Phase 1, or should Phase 1 standardize on patches and let NanoCore create the reviewed host commit?
- Should the first apply action create a commit automatically after human approval, or should commit remain a separate explicit host action?
- Should OpenShell workers receive GitHub write access only through ephemeral forks or never in the first implementation?
- How much of filesystem snapshot support should be implemented before the first OpenShell Git strategy ships?
- Should long-lived host Codex sessions share the same materialization record model even when they run directly in a host worktree?

## Links

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/sandbox.md`
- `docs/product-vision.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260627-openkit_development_loop_protocol.md`
- `docs/specs/20260617-openkit_ai_interface.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- [NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw)
- [NVIDIA OpenShell documentation](https://docs.nvidia.com/openshell/)
