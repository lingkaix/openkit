---
status: Accepted
implementation: Partial
---
# Git Write Workflow

## Owns

- The commit-on-apply contract: creating commits in linked repositories from accepted workspace reviews.
- The ephemeral review branch staging strategy.
- The `workspace.git.push` action: its approval gate, policy binding, execution locus, and the durable `GitPushRecord`.
- The GitHub-only V1 provider adapter for host-side push execution.
- Protected branch policy configuration per linked repository.
- Worker-side Git read-access token rules for private repositories.
- Push and commit failure semantics.

## Does Not Own

- Patch collection, staging, review, apply preflight, and apply mechanics. `docs/specs/20260703-workspace_synchronization.md` owns those; this spec extends what happens at and after an accepted apply.
- Credential storage and resolution (`docs/specs/20260704-vault_backend_implementation.md`) or injection mechanics into sandboxes (`docs/specs/20260703-openshell_mechanism_internalization.md`).
- Approval gate and Action Center semantics (`docs/specs/20260531-human_attention_intervention_model.md`).
- Pull-request / merge-request creation and code-host API integration — deferred; it needs the third-party resource proxy plane, which remains roadmap-deferred.
- GitLab, Gitea, and generic Git server provider adapters — deferred; V1 supports GitHub only.
- Tags, releases, deploys, and publishing — deferred.
- Git hosting configuration, repository provisioning, or CI integration.

## Core References

- `docs/core/audit.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/work-model.md`

## Summary

The workspace synchronization base deliberately stopped at review-gated patch apply with empty `WorkspaceApplyResult.commitIds`. This specification now owns the implemented optional commit-on-apply and separately approved push path, without giving workers write credentials or making publication a side effect of accepting a change.

This spec adds three layers, each with its own blast radius: commit-on-apply (an accepted apply may create one local commit with product lineage trailers), ephemeral review branches (an optional staging strategy inside the linked repository), and push as a distinct approval-gated action executed from NanoCore host with vault-resolved credentials and a durable `GitPushRecord` for every normally closed attempt. A process interruption after the push `CapabilityCall` starts may leave only that approval-Item-bound call. Workers keep zero write access in every path; protected branches are refused by default.

The first implementation supports GitHub as the only Git service provider. GitHub credentials may be injected through the OpenShell provider path and used by the NanoCore host-side Git provider adapter, including a `gh` CLI based implementation projection when it keeps credential handling inside the approved host boundary. GitLab, Gitea, and generic Git server adapters are future provider slices over the same commit, approval, policy, and record contracts.

## Goals / Non-goals

### Goals

- Let accepted work land as real commits with traceable lineage back to reviews, turns, and approvals.
- Make publishing (push) a separately approved, separately audited act, never an apply side effect.
- Keep write credentials exclusively on the NanoCore host path, resolved at execution time from the vault.
- Give private-repo clones inside sandboxes a scoped, short-lived, read-only credential path.
- Support GitHub as the only V1 Git service provider while keeping provider-specific mechanics behind a Git provider adapter boundary.
- Refuse protected-branch mutation by default and make exceptions explicit configuration plus approval.

### Non-goals

- Do not create pull requests or interact with code-host APIs in this slice.
- Do not support GitLab, Gitea, or generic Git server push adapters in V1.
- Do not implement tags, releases, deploys, or package publishing.
- Do not allow force-push under any circumstance in this contract.
- Do not preserve any compatibility path for the empty-`commitIds` behavior; `commitOnApply` repositories fill it in the same change.

## Background

`docs/specs/20260703-workspace_synchronization.md` fixed the safety posture: patch-first review, workers never push, and protected-branch publication remains a separate explicitly authorized action, with the configurable push approval mode defined below. This specification extends that base with optional host-side commit-on-apply and an independently approved push while preserving the empty `commitIds` result when commit-on-apply is disabled.

## Decision

- Commit-on-apply: a linked repository MAY enable `commitOnApply`; accepted applies then create exactly one commit containing exactly the applied change set, with lineage trailers, as one process-local serialized unit with preflight and best-effort worktree rollback on synchronous failure.
- Review branches: an optional staging strategy materializes staged reviews as ephemeral `openkit/review/<review-id>` branches in the linked repository, never pushed automatically.
- Push is a distinct action: `workspace.git.push` requires its own target-bound grant (human by default, automatic only under the deployment policy below) and a `repo.push` policy decision, executes from NanoCore host with vault-resolved credentials, and produces a durable `GitPushRecord` on every normal close; an interrupted attempt may stop after its `CapabilityCall` is durable and before that record exists.
- V1 push execution is GitHub-only. The provider adapter MAY use `gh` CLI with OpenShell-injected GitHub token material, provided the token stays in the NanoCore host execution boundary and never reaches worker sandboxes, AEP snapshots, task files, logs, or durable records.
- Protected branches: per-repository configuration with safe defaults; pushes to protected targets are refused unless configuration explicitly allows the target and approval names it.
- Workers receive at most short-lived read-only tokens for private clones, injected through the OpenShell provider path; no path in this spec ever supplies workers a write-capable credential.

## Contract / Expected Behavior

### Linked repository Git configuration

Each linked repository record gains a Git write configuration owned by workspace configuration:

- `commitOnApply`: boolean, default false.
- workspace Git identity: the author name/email used for commits created by NanoCore on behalf of approving humans.
- staging strategy: `staging-root` (the sync spec's existing default) or `review-branch`.
- protected branch patterns: default `main`, `master`, and common release patterns (`release/*`, `v*` when branch-shaped).
- allowed push targets: an explicit list or pattern set of branches pushes may target; empty by default (no pushes possible until configured).
- review linkage requirement for pushes: default true.

Configuration changes are workspace configuration changes: governed, audited, and never writable by workers.

### Commit-on-apply

- When `commitOnApply` is enabled, an accepted workspace review's apply MUST create exactly one commit in the linked repository containing exactly the applied change set — no more, no less. If commit creation fails synchronously, NanoCore attempts to restore the pre-apply worktree and records no successful apply; if rollback cannot prove restoration, it fails closed for operator inspection rather than claiming filesystem/Git/SQLite atomicity. A silent successful apply-without-commit is prohibited.
- Commit message: the review title and summary, followed by trailers binding product lineage: `OpenKit-Review-Id`, `OpenKit-Turn-Id`, and `OpenKit-Workspace-Id`. Trailers are stable contract; message body format above them is presentation.
- Authorship: author is the configured workspace Git identity representing the approving human; the worker agent is attributed with a `Co-Authored-By:` trailer carrying the agent's display identity. Commits MUST NOT impersonate the worker as author.
- The resulting commit id MUST be recorded in `WorkspaceApplyResult.commitIds`, finally filling the list the sync spec reserved.
- Without `commitOnApply`, Phase-1 behavior from the sync spec is unchanged: patch applied, empty `commitIds`.
- Commit creation happens on the NanoCore host against the linked repository; it never happens inside worker sandboxes.

### Review branches

- The `review-branch` staging strategy materializes a staged review as an ephemeral branch `openkit/review/<review-id>` in the linked repository, created from the review's base commit and carrying the staged changes as one commit (same message/trailer rules, authored by the workspace Git identity with a `Staged-By: OpenKit` marker distinguishing staged from applied commits).
- Review branches are NanoCore-owned: created, updated, and deleted by NanoCore only. They MUST NOT be pushed to any remote automatically.
- When the Workspace Review reaches a terminal state (`accepted` and applied, `rejected`, or `blocked`), the review branch MUST be deleted, or archived under `openkit/archive/` when workspace configuration requests retention. `needs_refinement` is not translated into another verdict vocabulary.
- The `openkit/` branch namespace in a linked repository is reserved for NanoCore; NanoCore MUST NOT touch branches outside its namespace except through the explicit apply and push contracts, and MUST treat foreign branches under `openkit/` as a drift diagnostic.

### Push as a distinct action

- `workspace.git.push` is a first-class action, never a side effect. Requesting its authority creates an approval record and Item naming: repository, remote (redacted summary), source ref, target branch, the commits to be published (ids and review linkage), and the policy decision context.
- Execution requires both a granted target-issued Approval and an `allow` `PermissionDecision` for `repo.push` scoped to the exact repository and target. In `require_human_approval` mode, only an explicit human decision grants that Approval; in `auto_allow` mode the deployment policy grants it as described below. Neither mode bypasses any other effect authority.
- The push `CapabilityCall` MUST set `itemId` to the exact granted target-issued `approval-request` Item that authorizes execution and MUST use `capabilityId: "workspace.git.push"`, `family: "network"`, and `operation: "git.push"`.
- Before repository or remote inspection, push preflight, Vault resolution, or any Git command, NanoCore MUST check for any existing Workspace `CapabilityCall` whose `itemId` equals that approval Item id and whose `capabilityId`, `family`, and `operation` equal `workspace.git.push`, `network`, and `git.push`. If a matching call exists but no terminal `GitPushRecord` has that approval Item as its `approvalRowId`, execution MUST return the existing `409 recovery_required` response regardless of the call's status.
- This recovery barrier MUST NOT inspect the remote, retry Git, reconcile or repair either record, mutate the existing call, create another call or status, or start a recovery, settlement, or other workflow. After operator inspection, a new attempt requires a freshly requested and granted target-issued push Approval and its new approval Item; the old approval Item is never retried.
- The authenticated actor of each fresh push-execution command is the current `repo.push` authority. Immediately before Vault resolution or the Git runner, NanoCore applies the shared current-authority predicate to that actor, the exact Workspace and repository target, and the existing target-issued Approval plus matching allow PermissionDecision. The worker or review actor that produced the commits remains immutable lineage only; its later removal does not prevent a different currently authorized actor from executing a new command against still-valid target authority. A failed current-authority check invokes neither Vault nor Git and may record only the existing `refused-policy` outcome; it does not rewrite the Approval, PermissionDecision, or source lineage and adds no reapproval, recovery, or settlement state.
- Both authorities MUST be issued on the current deployment. Portable import preserves granted Approval and `allow` `PermissionDecision` rows as readable history under the reserved, non-authorizing `apr_imported_<targetWorkspaceId>_*` Approval identity, but the push executor MUST treat that identity as non-authorizing even after repository and Vault re-binding. A `repo.push` allow decision without one linked Approval id also fails closed. The operator must request and grant a fresh target-issued push Approval; refusal happens before the Git runner or credential backend is invoked.
- Push executes FROM THE NANOCORE HOST. Credentials are resolved at execution time from vault references bound to the repository remote, with visibility `gateway-only`; they exist in memory for the duration of the push operation and are never materialized into worker sandboxes, AEP snapshots, or task files.
- V1 push execution supports GitHub remotes only. A linked repository whose configured provider is not GitHub MUST refuse push with a typed unsupported-provider diagnostic until a future provider adapter is accepted.
- Fast-forward and normal merge pushes only: NanoCore MUST prove that the observed existing target head, or the verified remote base for a missing target, is an ancestor of the approved source commit before publication. It MAY use only an exact `--force-with-lease=<target-ref>:<observed-head-or-empty>` as a compare-and-swap guard after that ancestry proof; this lease is concurrency control and MUST NOT authorize a non-fast-forward update. NanoCore MUST NOT use `--force`, an implicit lease, a force refspec, or any other force-push path, and MUST NOT delete remote branches in this contract.
- A missing target branch MAY be created under the same exact approval, current Vault grant, allowed-target policy, protected-target exact-match rule, and review linkage as an update. NanoCore MUST verify the remote's advertised symbolic default HEAD and its object id as the base, prove that base is an ancestor of the approved source, and match the exact outgoing commit set against approved linkage. If that base is absent, malformed, or not an ancestor, publication MUST be refused. Creation MUST use an exact lease expecting the target ref to be absent; a concurrently created target MUST fail without mutation. The observed target head in `GitPushRecord` is null for creation. No branch deletion or general GitHub API mutation is authorized.
- When the review linkage requirement is on (default), every commit in a Worker-originated push MUST be reachable from commits recorded in `WorkspaceApplyResult` rows or review-branch staging records; a push containing unlinked commits is refused with a typed diagnostic. Host App API / operations pushes whose stored permission-decision context has no Worker binding are exempt from that linkage refusal, as accepted in [issue #85](https://github.com/lingkaix/openkit/issues/85). The exemption does not change approval, current Vault authority, allowed targets, protected-target exact matching or compare-and-swap checks. Known review ids MUST still be retained in push records when linkage enforcement is disabled or exempt; absent linkage is not invented.

The `git_push.approval.request` command uses the existing command ledger before policy or Gate mutation. Its policy Gate identity is deterministic from the command name, authenticated actor, exact Workspace, Thread, Turn, and repository scope, and `requestId`; mutable push details do not enter that identity. A matching receipt and canonical input replay the existing Gate, changed input returns `409 idempotency_key_conflict`, and a deterministic Gate owner without its receipt returns `409 recovery_required` without creating another Gate or reconstructing the receipt. The policy Gate helper accepts only the named `repo.push` family for this workflow; `mcp.call` and a generic action fallback are not authorized. On the host App API path, when that named source Turn is already terminal, NanoCore admits one deterministic running approval-owning Turn `tu_repo_push_<digest>` from the same command-scope digest, attaches the Gate and current execution context to that publication Turn, records the immutable command-scope source Turn in the permission-decision context, and leaves the source Turn immutable in the command identity; exact replay reuses that Turn, and grant or deny terminalizes only it. Automatic `repo.push` execution looks up the request receipt with that recorded source Turn, not the publication Turn. A live host or Worker Turn remains the Gate owner without that admission. Resolving the approval writes the exact decision Item, changes the original gated Turn to `completed` for `granted` or `interrupted` for `denied`, carries `stopReason=aborted` on the denied Turn's terminal envelope, clears its Gate, and publishes the response receipt without invoking a worker or runtime continuation; the approval-decision Item preserves the denial cause, and an approved caller starts the separately authorized push command afterward.

### GitHub Provider Adapter

- The GitHub provider adapter is the only provider adapter required for V1.
- The adapter MAY shell out to `gh` CLI or use fixed-argument `git` commands with a GitHub token injected through the OpenShell path. In either case, command construction MUST use fixed argument arrays, a scrubbed environment, and redacted diagnostics.
- The adapter MUST treat GitHub token material as gateway-only host credential material. It MUST NOT write the token into remotes, config files, task files, AEP snapshots, worker environments, logs, item payloads, audit rows, usage rows, or push records.
- The provider abstraction MUST keep the durable `GitPushRecord`, permission action, approval row, lineage trailers, and protected-branch policy provider-neutral enough for future GitLab, Gitea, and generic Git server adapters.
- Provider-native GitHub errors MAY be retained only in restricted evidence after redaction. Worker-visible and product-visible surfaces receive stable OpenKit typed outcomes.

### GitPushRecord

Every normally closed push attempt — successful, refused, or failed — produces a durable terminal `GitPushRecord` carrying:

- push record id and full product lineage (workspace, repository record, approval-request Item id as `approvalRowId`, policy decision id, actor context)
- remote summary (redacted; no credential material, no raw URLs with embedded auth)
- source ref and target branch
- commit ids pushed and their review linkage
- remote head digest before and after (as observed)
- outcome: `pushed`, `rejected-non-fast-forward`, `rejected-protected`, `auth-failed`, `remote-unreachable`, `refused-policy`, `refused-linkage`, `unsupported-provider`
- timestamps and error summary on failure

`GitPushRecord` rows are workspace-scoped, homed per the storage layout spec, and emit audit events per the audit spec.

A process interruption after the matching `CapabilityCall` is durable may leave that call without a `GitPushRecord`. This absence is the uncertainty signal; it does not add an `interrupted` push outcome, capability-call status, recovery record, or workflow.

### Configurable push approval mode

The deployment-owned `config/server.jsonc` field `policy.workspaceApprovalModes` maps exact Workspace IDs to action modes, initially only `{ "repo.push": "require_human_approval" | "auto_allow" }`. An omitted policy, Workspace, or action resolves to `require_human_approval`. Unknown actions, modes, and policy fields are invalid configuration. There is no wildcard, inherited grant, request override, Workspace-authored override, or worker-side auto-allow. This setting controls only the human gate for host push; it grants neither Workspace access nor Vault use, repository target permission, review acceptance, or force-push authority.

Deployment administration owns creation, replacement, and deletion through the existing server configuration boundary; edits require App restart. Removing an entry restores the default for new requests after restart. The active startup configuration decides each new request once. Existing pending approvals stay pending, existing grants keep their exact target-bound authority, and exact request replay returns the original records regardless of later mode changes. Revocation of underlying membership or Vault authority and current repository policy are still checked during execution. Configuration validation and restart failure do not publish a partial policy. Workspace export/import cannot transfer this deployment configuration, and imported approval or permission history never becomes fresh target-issued authority.

In human mode, a request records `require_approval`, a pending Approval and approval-request Item, and an awaiting-human Turn with an Action Center row. The existing `approval.respond` path records the human allow/deny decision. In automatic mode, the same request records one immutable `allow` decision with reason `repo_push_auto_allowed`, policy snapshot `repo_push:auto_allow:v1`, exact subject/target/context, and a linked permission audit, plus a granted Approval and approval-request Item. It completes the request Turn without a human Gate; no human response, human actor attribution, or `require_approval` decision is fabricated. The existing response fields identify the Approval, Item, and policy decision in either mode. A granted record in this mode means policy-granted, not human-reviewed.

Both modes publish the existing request command receipt and perform no remote effect during the request. A decision without its receipt fails closed as `recovery_required`; automatic execution also requires that exact request receipt before repository inspection. A retry never repairs or recreates missing authority. An operator inspects incomplete evidence and uses a fresh running Turn and request for a new attempt. `repository.push-execute` remains separate, requires a granted target-issued Approval and matching `allow`, and preserves the interrupted-call barrier, current Vault grant, host-only injection, allowed targets, protected-branch exact-target rule, review linkage, and compare-and-swap checks. The automatic grant names the exact protected target; it cannot turn a wildcard allowed-target pattern into the explicit protected-target permission required below.

Acceptance is observable through both modes: omitted or explicit human mode exposes decidable IDs in CLI and Web attention; automatic mode returns `granted` with one auditable allow and receipt, no pending attention, and a completed Turn. Replays preserve IDs and reject changed input. Mode selection is isolated to the named Workspace. Invalid targets, stale authority, imported history, missing receipts, and invalid Vault grants remain refusals. No new durable record type, lifecycle runner, or cross-domain recovery is introduced.

### Worker-initiated repository push

An explicitly selected built-in `openkit-repository` worker MCP target offers `repository_push_request_approval` and `repository_push_execute` over the existing authenticated capability relay. The public `repository.push-request-approval` and `repository.push-execute` Skill operations remain App API operations for an external coordinator. Setting a worker-local URL or possessing `GITHUB_TOKEN` does not supply the worker capability or App API authority. This worker projection initiates the existing host publication commands; it does not allow worker Git publication, a general App API tunnel, arbitrary host access, or worker-visible host-push credentials.

NanoCore derives the requesting actor and current Workspace, Thread, Turn and AgentSession from the authenticated package. It validates selected supply and current live worker admission, rejects conflicting scope, and rechecks current Workspace and repository authority before effects. Worker initiation reuses the repository owner's shared command implementation and strict payload schemas rather than recursively invoking an HTTP handler or copying its policy logic. The MCP invocation has its own ordinary capability evidence; only the exact repository Approval, linked `repo.push` decision and Git publication records authorize and prove the remote effect.

The requested source commits must already exist in the linked NanoCore checkout and satisfy the existing review-linkage and target checks. Commits present only in the sandbox are not publication candidates; the caller receives a bounded typed prerequisite refusal directing it through the existing review/apply flow. Repository command refusals use an MCP tool result with `isError: true`, `structuredContent: { ok: false, error: { code, message } }` and matching JSON text content. An unavailable host source uses `git_push_source_unavailable` with fixed guidance to complete review/apply and verify the host-linked commit. Other repository domain failures preserve their bounded typed code without raw Git output, local paths or credential material. Authentication, selection and MCP argument failures retain the MCP owner's closed protocol error vocabulary. No live worker-to-host synchronization, automatic patch acceptance, commit transfer, new repository state or source-lineage rewriting is part of this capability.

In human mode, the request creates the same exact target-issued pending Approval, approval-request Item, permission decision and command receipt. It places the worker Turn behind the existing human Gate and requests coordinated worker stop and cleanup through the existing worker Gate owner. The initial projection supports only the delivered Codex session-continuity path; unsupported adapters fail before Gate creation. The stop enqueue, asynchronous settlement, exact Gate-owned `blocked/ask_user` outcome, backend cleanup and Workspace handoff predicates in [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md#policy-binding) apply to the repository Gate. Only proved cleanup and handoff make it acknowledged, actionable and eligible for the `waiting_for_user` checkpoint. Unproved enqueue, a competing terminal outcome, process interruption or missing cleanup evidence retain actual records and non-waiting checkpoint, project inspect-only `recovery_required`, and use existing runtime cleanup/restart owners without stop reconstruction, synthetic settlement, cross-store atomicity or automatic repair. The MCP owner's separate `tool.use` expiry and one-shot claim rules do not replace Git's exact approval and receipt rules. Approval resolution retains the existing terminal closeout and does not automatically resume a native worker or publish. A later explicitly started worker may execute that granted request under current authority, retaining the original approval and commit lineage.

In automatic mode, the request creates the same target-issued granted Approval, immutable allow decision, audit and receipt as host initiation. The worker projection also records the actual policy grant in an existing `approval-decision` Item authored by the exact system actor `nanocore-repo-push-policy` and linked to the request Item, so reloading either a running or completed worker Turn preserves the granted Approval without reconstructing a human Gate or terminal denial. This actor permits grants only; boot reconciliation retains its separate denial-only actor. Policy-grant Items are excluded from human-Gate closeout classification, including when the same Turn later awaits a real human decision. This is policy attribution, not a fabricated human response. The worker projection leaves its currently running Turn running without a human Gate, so it can issue the separate execute tool. This is an explicit projection distinction: the App API holder-Turn request still completes its Turn as specified above. Automatic mode does not grant selection, repository access, Vault use, review acceptance or protected-target permission.

Request replay preserves the original target, decision and receipt, rejects changed input, and never recreates missing authority. Execute binds the exact originating request and Approval while rechecking the fresh caller's current authority. A stopped, stale or unselected worker cannot initiate an effect. Restart, lost response, missing receipt, interrupted CapabilityCall, Vault failure, policy revocation and remote failure retain the existing truthful refusal or recovery-required semantics; no retry silently repairs or republishes an uncertain attempt. No new durable record or background lifecycle is required.

Acceptance is observable through the selected worker route: discovery exposes only selected tools; human mode creates a real decidable target-bound Gate and coordinates worker cleanup; automatic mode preserves the running worker and permits its separate authorized execute call; later authorized workers can execute an earlier grant; unselected supply, conflicting lineage, stale admission, missing host commits, revoked authority and interrupted publication fail before unauthorized Git or Vault effects. Verification must distinguish a real Gate or push record from MCP transport success alone.

### Protected branch policy

- Pushes targeting a branch matching a protected pattern MUST be refused with outcome `rejected-protected` unless the target is explicitly present in `allowed push targets` AND the approval row explicitly named that protected target. Silent pattern-overlap acceptance is prohibited.
- Protected-pattern configuration guards the OpenKit-side gate; remote-side protection (code-host branch rules) remains the outer defense and its rejections surface as `rejected-non-fast-forward` or `auth-failed` with redacted remote detail.
- The default configuration (empty allowed targets) means a freshly linked repository can accept commits locally but publish nothing until a human configures push targets — publishing requires configured targets and a per-push grant under the selected approval mode.

### Worker-side Git read access

- Workers cloning private repositories receive short-lived, read-only credentials: scoped to fetch/clone for the specific repository, injected through the OpenShell provider path per `docs/specs/20260703-openshell_mechanism_internalization.md`, covered by their own `VaultGrant`, `VaultInjectionPlan`, and policy decision.
- No path defined by this spec supplies a worker with a write-capable Git credential. This restates and strengthens the sync spec's rule: it holds for review branches and commit-on-apply too, because both execute on the NanoCore host.
- Read-token lifetime SHOULD be bounded by the session lease duration; expiry follows the vault backend's version-expiry mechanics.

### Failure semantics

- A normally closed push rejection (non-fast-forward, remote protection, auth failure, unreachable remote) records the typed outcome on the `GitPushRecord`. NanoCore never resolves push conflicts autonomously and never force-pushes.
- A matching approval-Item-bound `CapabilityCall` without a terminal `GitPushRecord` returns `409 recovery_required` before inspection, Vault, or Git without remote inspection, retry, reconciliation, repair, new status, or new workflow. The operator inspects the existing evidence, then requests and grants a fresh target-issued push Approval for any new attempt.
- Commit-on-apply failure fails the apply as a unit (see above); the staged review returns to `awaiting-review` state with the failure diagnostics attached, per the sync spec's conflict handling.
- Credential failures mark the vault reference's health in diagnostics and follow the vault specs' audit rules; the error surfaced to product surfaces is typed and redacted.

## Accepted Design

Commit-on-apply extends the existing Git apply path in the workspace materializer: after `git apply` succeeds against the linked repository, the same process-local serialized operation stages exactly the applied paths and commits with the constructed message. A synchronous failure triggers best-effort restoration and never records success; unproven restoration fails closed for inspection because the filesystem, Git, and SQLite are not one atomic authority domain. Review branches are a second staging adapter beside the opaque staging root, sharing the staging interface from the sync spec. Approval resolution records the immutable `repo.push` decision and closes its Gate but performs no remote effect. The later explicit push mutation resolves the exact target-issued approval Item, runs the existing-call recovery barrier before any repository or remote inspection, revalidates the granted decision, and invokes the small NanoCore push service. When that service starts the existing `workspace.git.push` capability call, it binds `itemId` to the approval Item; it then resolves credentials, selects the GitHub provider adapter in V1, executes fixed-argument `git` or `gh` operations with no shell interpolation, observes before/after heads, writes the terminal record on normal close, and emits audit. Process interruption may leave only the call; the next use of that approval returns `recovery_required` rather than inspecting, retrying, or reconciling. Remote interaction uses fixed argument lists and a scrubbed environment so credential material never reaches logs.

## Current Implementation Projection

The first commit-on-apply slice exists for linked local Git repositories. `packages/app-api-schemas/src/repository.ts` exposes the repository Git write settings `git.commitOnApply`, `git.authorName`, and `git.authorEmail`; the Workspace migrations under `apps/nanocore/drizzle/workspace/` store the safe default `commitOnApply: false` and the OpenKit-controlled author identity. When an accepted Git workspace review targets a repository with `commitOnApply: true`, `apps/nanocore/src/app.ts` applies the validated patch, stages exactly the changed paths, creates one local commit using the configured OpenKit author identity plus `OpenKit-Review-Id`, `OpenKit-Turn-Id`, `OpenKit-Workspace-Id`, and `Co-Authored-By` trailers, records the new commit id in `WorkspaceApplyResult.commitIds`, and restores the worktree if commit creation fails before the commit is written. The worker co-author trailer is resolved from the worker turn's selected agent and uses the product display name plus the stable product-local address `<agentId>@agents.openkit.invalid`, so the worker is attributed without impersonating an external email identity. Route-level coverage now induces the missing-identity commit failure path and verifies that the patch is reversed, the worktree is clean, and no extra commit is written.

The durable `GitPushRecord` base also exists. `packages/app-api-schemas/src/repository.ts` defines the redacted push record and list/read response schemas; the Workspace migrations under `apps/nanocore/drizzle/workspace/` store workspace-scoped records without credential-shaped columns; `apps/nanocore/src/runtime/git-push-records.ts` records, lists, and reads push records while emitting one redacted workspace audit event per inserted record; and NanoCore exposes read-only App API routes at `/api/app/workspaces/:workspaceId/repositories/git-push-records` and `/api/app/workspaces/:workspaceId/repositories/git-push-records/:pushRecordId`. This initial slice created the read model and audit base; the later sections below describe the now-implemented push execution path.

Linked repository Git policy configuration now also exists on the same repository `git` config object: `stagingStrategy`, `protectedBranchPatterns`, `allowedPushTargets`, and `requireReviewLinkage`, with safe defaults of staging-root staging, common protected branch patterns, no allowed push targets, and review linkage required. The Workspace migrations under `apps/nanocore/drizzle/workspace/` store these fields in the workspace repository resource row, so later review-branch and push-enforcement slices do not need a parallel policy entity.

The first review-branch staging path also exists for linked local Git repositories. When a repository uses `git.stagingStrategy: "review-branch"`, NanoCore materializes pending Git workspace reviews as local `openkit/review/<review-id>` branches from the review base commit, applies the reviewed patch, creates a staged commit with the standard lineage trailers plus `Staged-By: OpenKit`, writes the staged commit id to the durable change-set head for linkage, restores the original checkout, and deletes the review branch after a successful accepted apply. The App API route-level coverage proves branch materialization through the workspace review read path and terminal deletion after acceptance.

OpenKit-side push target policy evaluation also exists as a pure NanoCore runtime helper. `apps/nanocore/src/runtime/git-push-policy.ts` evaluates `allowedPushTargets`, `protectedBranchPatterns`, and whether the approval row explicitly named a protected target before any remote mutation is attempted, returning `rejected-protected` for protected-target refusals and `refused-policy` for non-protected target policy refusals. The push producer preflight now runs this helper before any remote mutation.

Git push commit linkage evaluation also exists as a pure NanoCore runtime helper. `apps/nanocore/src/runtime/git-push-linkage.ts` checks requested commit ids against workspace-scoped `WorkspaceApplyResult.commitIds` and staged review branch `changeSet.head.commit` values, then returns linked review ids or a `refused-linkage` decision before any remote mutation is attempted.

The first push producer preflight also exists. `apps/nanocore/src/runtime/git-push-records.ts` exposes `prepareGitPushAttempt`, which wires the stored repository push policy, accepted apply-result linkage, and staged review branch linkage before any remote mutation. Policy and linkage refusals now become durable `GitPushRecord` rows with redacted summaries and audit events; successful preflight returns linked review ids for the later provider executor without writing a terminal push record early.

The first fixed-command push helper also exists. `apps/nanocore/src/runtime/git-push-command.ts` builds a `git push --porcelain --no-verify --force-with-lease=<target-ref>:<observed-head-or-empty> -- <remote> <source>:refs/heads/<target>` argument vector, rejects option-like, delete, compound-refspec, and invalid exact-lease shapes, and returns a scrubbed environment that converts a caller-supplied V1 GitHub token into command-scoped HTTPS authorization while disabling interactive Git prompts. It does not read GitHub credentials implicitly from NanoCore's global `process.env`; the executor permits this exact lease only after proving that the observed head or remote base is an ancestor of the approved source, so the resulting publication remains fast-forward-only.

The first runner-injected push executor also exists. `apps/nanocore/src/runtime/git-push-executor.ts` composes preflight, immutable `repo.push` permission-decision validation, the V1 GitHub-only provider gate, fixed command construction, a host-side `spawn` runner, terminal outcome classification, `GitPushRecord` persistence, and shared capability usage recording. It reads the repository object format during inspection, creates an isolated bare view with the same SHA-1 or SHA-256 format, verifies the symbolic default HEAD as the base for missing target branches, proves the verified base or observed existing target head is an ancestor of the approved source, compares the exact outgoing commit set with approved linkage, and binds publication to the observed target state with an exact compare-and-swap lease. It writes one `workspace.git.push` capability call plus one `category: "network"`, `unit: "requests"` usage row and records terminal outcomes on normal close. The current gap is that the call does not yet carry the exact approval-request Item, so it cannot guard the interrupted call-without-record boundary; closing only that gap requires setting `itemId` and adds no status or recovery owner. Local bare-remote tests prove that a matching workspace-scoped `repo.push` `allow` decision can advance an existing remote branch and that a concurrent remote-head change is rejected without mutation.

The public `workspace.git.push` approval path also exists. `packages/app-api-schemas/src/repository.ts` defines redacted Git push approval request and response schemas; NanoCore exposes `POST /api/app/workspaces/:workspaceId/repositories/:resourceId/git-push/approval`; `@openkit/core-client` exposes the route through `client.repositories.requestGitPushApproval`; and the unified Skill/CLI exposes it as `repository.push-request-approval`. The NanoCore route binds the request to an existing thread and turn, validates the linked repository resource, derives one deterministic policy Gate from command, actor, exact scope, and request identity, and records the matching workspace-scoped `repo.push` decision under the configured mode above. Receipt lookup precedes policy mutation: exact replay returns that Gate, changed input conflicts, and an existing Gate without its command receipt fails closed as `recovery_required` rather than creating or repairing authority. The helper has no `mcp.call` or generic action fallback. The approval response route resolves the policy-originated Git push Gate locally even when the active worker runtime does not support runtime approvals, writes an immutable `repo.push` `allow` or `deny` decision, creates the `approval-decision` Item that removes the Action Center row and preserves the denial cause, changes the original Turn to `completed` for a grant or `interrupted` for a denial without worker or runtime continuation, carries `stopReason=aborted` on the denied Turn's terminal envelope, and publishes the response receipt. Push execution remains the separate mutation below.

The public push mutation route also exists. `packages/app-api-schemas/src/repository.ts` defines the approved Git push execution request and response schemas; NanoCore exposes `POST /api/app/workspaces/:workspaceId/repositories/:resourceId/git-push`; `@openkit/core-client` exposes it through `client.repositories.executeGitPush`; and the unified Skill/CLI exposes it as `repository.push-execute`. The route requires a granted target-issued push approval, resolves its approval-request Item, rejects portable-import authority, applies policy and preflight, resolves the optional Vault grant, invokes the executor, and records the terminal `GitPushRecord` on normal close. It already rejects an existing terminal push record before a repeated effect, but it does not yet detect the approval-linked call-without-record window. Closing that gap requires the exact pre-inspection `CapabilityCall` lookup and `409 recovery_required` outcome defined above. Existing route coverage proves an approved push can advance a local bare remote, imported granted authority remains historical after re-binding, credential canaries do not enter the public response, and the workspace-scoped `VaultUse` row links the push to its grant.

Worker read-token resolution produces one backend-private OpenShell credential-materialization path. Workspace data-source roots that carry `vaultGrantRef: "grant_github_read"` cause Agent Environment Package resolution to derive the durable GitHub read credential requirement even when the worker did not request the GitHub MCP server. Durable resolution requires an active Turn-scoped `VaultGrant` targeted to the current AgentSession, a non-empty policy decision id, backend-handle injection permission, an active Vault reference, a pre-effect `VaultInjectionPlan`, a redacted `VaultUse` row for resolution, and a `VaultInjectionReceipt` only after backend-private materialization succeeds. The token value is not serialized into the AEP, Vault projection, Workspace source projection, logs, or product records. Current OpenShell materialization rejects that credential before effects because the AEP does not carry the exact Providers v2 network policy, so private worker-side GitHub reads remain unavailable and no successful receipt is semantically valid through this path while host-side approved push remains implemented.

The approved host-side push path is complete. Policy-equivalent worker read-token materialization remains incomplete; pull requests, GitLab, Gitea, generic Git servers, tags, releases, deploys, and broader code-host APIs remain deferred non-goals.

## Alternatives Considered

- Push-on-apply as one combined action. Rejected: accepting a change into the workspace and publishing it to a shared remote are different blast radii with different reviewers and different reversibility; collapsing them recreates the direct-push risk the sync spec rejected.
- Worker-side push with scoped deploy keys. Rejected: it bypasses NanoCore review evidence, puts write credentials within sandbox reach, and makes push outcomes invisible to product records.
- Auto-creating pull requests instead of pushing branches. Deferred, not dismissed: PR creation is the natural collaboration surface, but it requires broader authenticated code-host API access. The V1 GitHub-only push adapter is intentionally narrower and does not become a general GitHub API proxy. The push contract here is what a future PR flow would build on.
- Designing all Git hosting providers now. Rejected: GitHub is the current dogfooding provider and can be implemented through the OpenShell/`gh` path without introducing a premature provider matrix. GitLab, Gitea, and generic Git server adapters should reuse the provider-neutral records and gates when they are needed.
- Committing inside the worker sandbox and collecting commits via bundles. Rejected for the default path: it moves authorship and message construction outside the approval boundary; bundles stay an optional collection format per the sync spec.

## Consequences

- The self-improvement loop closes: accepted patches become commits with lineage, and publishing is possible without leaving OpenKit — at the cost of two new configuration surfaces (Git identity, push targets).
- Every published commit is traceable to a review, a turn, an approval, and a policy decision through trailers and records.
- Normally closed push failures become typed, recorded, inspectable outcomes instead of unstructured shell errors; an interrupted attempt may be evidenced only by its approval-Item-bound `CapabilityCall`.
- NanoCore host executes Git write operations, concentrating credential handling in one audited locus.

## Rollout / Migration Plan

New machinery over the stable apply contract, no compatibility path. Order: (1) `commitOnApply` and lineage trailers, filling `commitIds`; (2) the `GitPushRecord` schema/table/App API read base; (3) the GitHub-only push service, protected-branch refusal, and the approval + policy gate, with the OpenKit repository itself as the first dogfooding target; (4) review-branch staging strategy; (5) worker read-token provisioning for private GitHub clones. PR creation, GitLab, Gitea, generic Git server adapters, tags, and deploys remain deferred.

## Testing Strategy / Acceptance Criteria

Mapped to `docs/specs/20260529-test_strategy.md`, using local bare repositories as remotes in tests:

- L0: schema-drift checks for `GitPushRecord` and the repository Git configuration shape; lint that no credential-bearing URL shape appears in schemas or fixtures.
- L1: unit tests for commit message and trailer construction, protected-pattern matching, allowed-target validation, provider selection, unsupported-provider refusal, linkage reachability computation, and push argument construction (fixed args, scrubbed env).
- L2: contract tests: induced commit failure attempts worktree restoration and never records successful apply, while unproven restoration fails closed; `commitIds` recorded and linked; deterministic `repo.push`-only Gate replay, changed-input conflict, owner-without-receipt `recovery_required`, and exact granted/completed or denied/interrupted-with-`aborted`-stop-reason closeout without runtime continuation; imported granted Approval and `allow` decision remain readable but cannot authorize a rebound target until fresh target approval; one push-route case pre-seeds a matching approval-Item-bound `workspace.git.push`/`network`/`git.push` `CapabilityCall` without a terminal push record and proves `409 recovery_required`, zero `GitPushRecord` rows, zero `VaultUse` rows, and zero remote effect; push refusals for each typed outcome; review-branch lifecycle (create, terminal-state deletion, foreign-branch drift diagnostic); canary credential values never appear in records, logs, or diagnostics.
- L3: NanoCore black-box tests against local bare remotes plus a GitHub-adapter harness: full flow — accepted review → commit → approved push → remote head advanced and `GitPushRecord` `pushed`; non-fast-forward rejection with its terminal record; protected-target refusal without explicit config+approval; unsupported non-GitHub provider refused typed; push with unlinked commits refused; worker clone of a private GitHub repo with a read-only token that cannot push.
- L5: smoke: packaged build commits and pushes one accepted change to a local bare remote.
- L6: story acceptance: one OpenKit self-improvement loop iteration lands as a pushed commit with full lineage, entirely through OpenKit surfaces.

Acceptance: no force-push path exists; apply-and-commit never claims success after a synchronous failure or unproven rollback; every normally closed push attempt leaves one terminal `GitPushRecord`; an interrupted attempt may leave only its approval-Item-bound `CapabilityCall`, and reuse of that approval Item returns `409 recovery_required` before inspection, preflight, Vault, or Git until the operator inspects and obtains fresh target-issued approval; workers can never write to any remote; protected defaults refuse until configured and approved.

## Risks & Mitigations

- Risk: workspace Git identity misattributes authorship in shared repositories. Mitigation: author is always the configured identity representing the approving human, with agent attribution in trailers; configuration is workspace-governed and audited.
- Risk: review branches clutter linked repositories. Mitigation: reserved namespace, terminal-state deletion, optional archive namespace.
- Risk: the push service becomes a shell-injection surface. Mitigation: fixed argument lists, no shell interpolation, scrubbed environment, L1 tests on argument construction.
- Risk: linkage checking blocks legitimate manual commits mixed into the branch. Mitigation: linkage requirement is per-repository configuration; disabling it is an explicit, audited choice.
- Risk: OpenKit-side protected patterns drift from remote-side rules. Mitigation: both gates operate independently; remote rejections surface typed, and configuration docs treat remote rules as the outer defense.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: commit-on-apply creates one OpenKit-owned commit per accepted apply, with squash semantics deferred until worker commit bundles ship; `GitPushRecord` stores the remote's advertised protection error only in restricted evidence for debugging, while public surfaces expose a typed outcome plus redacted summary.

## Deferred / Future Work

- Pull-request / merge-request creation once the third-party resource proxy plane exists.
- GitLab, Gitea, and generic Git server provider adapters.
- Tags, releases, deploys, and package publishing as further distinct approved actions.
- Git bundle collection with commit-metadata preservation (sync spec deferred item) and its interaction with commit-on-apply.
- Multi-remote push policies and mirror workflows.

## Links

- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`
