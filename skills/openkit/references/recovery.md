# Recovery

Load this reference for interrupted or unknown work, retries, checkpoints, restarts, stale state, `recovery_required`, or a locally aborted wait.

## Reconstruct from durable state

1. Run `doctor` and restore connection, authentication, readiness, and contract compatibility first.
2. Re-read the workspace, thread, active mode, turn or task, Action Center, artifacts, evidence, and any exposed checkpoint state.
3. Compare the durable records with the last successful CLI envelope and identify which outcome is confirmed, unknown, stale, or contradictory.
4. Present the smallest safe next choice to the user before invoking another mutation.

Treat NanoCore records as authority after a CLI restart, agent-host restart, NanoCore restart, timeout, SIGINT, or transport loss. Never reconstruct workflow truth from local logs or assume that a stopped local wait cancelled remote work.

For a failed Worker inference stream, inspect the Turn and its attributed calls through `usage.read`. A recorded `provider_stream_truncated` identifies a stream that ended without the required completion; `provider_stream_failed` identifies a stream failure. Both remain failures, and neither alone identifies the upstream cause. A generic stream error from an older record cannot be retrospectively classified. Preserve the exact Turn and call evidence before deciding whether to submit a new bounded request.

A completed Turn proves execution closeout, not that its visible answer satisfies the task. If Web and `thread.items` contain only an intermediate update, keep the result review pending and preserve the Turn and runtime evidence. A final answer present only in raw evidence does not authorize rewriting canonical messages or accepting the review. Diagnose the shared inference/output path before a new authorized verification task; do not retry merely to hide the missing result.

For an owner-requested permanent Workspace deletion, use `workspace.delete` and preserve its exact `requestId`, confirmation, and returned phase. A fenced response is not deletion success; retry the same request only after runtime quiescence is proven. A failed lease may retain `needs-evidence` when its exact matching backend records completed physical cleanup; NanoCore verifies that proof without clearing the unknown historical result. Missing cleanup proof and other unresolved leases continue to fence deletion. Use local-mode `workspace.deleted-recover` only when the retained deletion export and closure verify successfully; recovery always remints the Workspace identity.

A current usable server-admin bearer owned by the original deleting Workspace owner can resume that exact deletion request after the registry becomes `deleting` or `deleted`. This grants no ordinary Workspace content access and no foreign-owner deletion authority. An administrator without ownership must use the existing explicit access-recovery path before starting deletion; Quick Chat remains owner-only.

A Worker may finish its commands while transcript or Workspace-change handoff fails. Its Turn is still failed; assistant text alone does not prove a durable review exists. Inspect `sync.review-list` and `sync.change-set-list` before retrying or applying anything. A handoff failure before backend cleanup uses the normal verified AgentSession close path instead of retaining a native session that Core marked failed. A separately authorized new Task can retire a leftover native binding for its terminal predecessor after fresh scheduler admission and verified cleanup, without reopening or replaying the failed Turn. If cleanup is unknown or a current-session conflict remains, preserve the exact failure and use the exposed recovery or operator path; do not delete binding rows or treat an empty interrupted-worker list as proof of recoverability.

For `git_repository_missing` during handoff, the collected change names an exact repository resource that has no linked host apply target. A different repository id or a working Worker clone does not satisfy that identity. Verify and repair the intended link through `repository.diagnostics` and `repository.set-default` under existing authorization; describe their current inputs first. Linking the target does not replay the failed handoff. This failure can leave no staged review, output manifest, or reconciliation record, so an empty Recovery page is not a retry route. If the original retained environment is still available, use **Recover a retained checkout** below to start a new authorized Task, inspect the original changes, and collect a new review. Keep the original Turn failed, verify the new review and patch, and obtain its required human decision before apply. Do not fabricate a quarantine reason, reopen the old Turn, or equate recovered files with applied changes.

A storage validation error naming `evidence/backend/` while the raw output merely quotes the Data Root path is an implementation defect, not evidence of a path escape. Preserve the failed Turn and original bytes. If the App still answers, create and verify a deployment backup through `backup.create` and `backup.verify` before maintenance; a successful configuration file update does not prove `runtime.reload` succeeded. An affected image may fail to reopen the same bytes after restart. Repair requires an authorized operator with a verified fixed image; do not delete or rewrite the evidence, fabricate recovery records, or retry the Worker to hide the failure. After replacement, verify readiness and the intended loaded configuration through the same public operations used by Web.

A failed persistence write can leave a Product Turn recorded as running and its AgentSession busy even after the exact backend session is cleaned and the checkpoint is failed. Those recorded labels do not establish a live process. `recovery.worker-list` lists authoritatively interrupted attempts, not every failed or inconsistent checkpoint; an empty list does not establish healthy closeout. `turn.interrupt` requires an exact live Worker control session and cannot settle this historical persistence failure. Preserve the original failure and request identity, inspect available public evidence, and use separately authorized operator diagnosis when the public projection lacks the required lineage. Do not rewrite records, manufacture interrupted status, or repeatedly send interrupts to make the display clear.

## Handle retries conservatively

Reuse the same request only when the public operation contract and returned state make replay safe. Treat changed input under the same idempotency identity as a conflict.

When NanoCore returns `recovery_required`, assume that safe exact replay cannot be proven. Do not blindly repeat the mutation. Re-read the owning durable records, explain the uncertainty, and use an explicit retry, new request, interruption, cancellation, or operator decision only when CLI discovery exposes it and the user authorizes it.

A failed Goal step may retain its running Goal Task when Worker startup stops before a runtime is launched. After inspecting the failed Turn, describe `goal.step` and retain the original Workspace, Thread and `requestId`; never invent a new request to bypass that reservation. Exact replay and restart use the same Goal closeout classifier. Only a complete server-verified never-launched tuple can close the Goal Task as failed, publish the missing receipt and clear the checkpoint without starting a Worker. User input remains history, not Worker output. An anchored runtime, conflicting lineage or missing proof remains `recovery_required`; an original attempt awaiting reconnection remains busy. A successful replay response confirms recorded failure closeout, not successful work. This path grants no database-editing or automatic rerun authority.

`scheduler_admission_denied` reports that the exact submitted queue entry was rejected by scheduler admission; preserve its returned reason instead of interpreting it as waiting for capacity. Inspect current Workspace authority and scheduler state before retry. A synchronous Task may cancel its unstarted queue entry during cleanup, so an empty admission list does not prove it ran. A denial belonging to another queue entry is not evidence that this request was denied.

For an interrupted worker or checkpoint, inspect the exposed durable lineage and status before requesting retry. Let NanoCore validate ownership, sequence, lease, scheduler, and checkpoint eligibility; do not synthesize or repair those records in the Skill or CLI.

## Diagnose stalled package downloads

An allowed network policy decision does not prove that TLS or a package download succeeded. Preserve the exact Turn before stopping a stalled install with `turn.interrupt`, then wait for durable terminal status. A bounded diagnostic Task can run a package metadata request with a short process timeout, disabled retries, and unbuffered output; inspect its actual exit code and error before repeating an install.

`SELF_SIGNED_CERT_IN_CHAIN` from Node-based package tools can indicate missing trust for the sandbox proxy certificate. The Worker shim derives Node's additional CA file from the backend-provided `SSL_CERT_FILE`; ambient or runtime-credential `NODE_EXTRA_CA_CERTS` is not a supported repair. Do not disable certificate verification or widen network grants to bypass this failure. An authorized operator must update an affected Worker image through the existing environment preparation and activation workflow, then verify the same bounded download in a new Turn. A directory-only certificate setting does not supply Node's required CA file. Host image building and installation remain separate operator tools; see [administration.md](administration.md).

## Continue administrator Tasks with the presented credential

The Task remains bound to the credential presented when it was submitted. After the work waits in queue or NanoCore restarts, NanoCore rechecks that bound Token before the next governed effect. Reads may use another authorized credential. An expired, revoked, rebound, or unusable Token denies that next effect; it is not queued capacity. Inspect exposed Task and Turn metadata and current authority. Ask the user only if the credential must be replaced, then submit a new authorized request after correction. Do not grant membership, invent a replacement Token, or repair scheduler, lease, or admission records.

A denied storage reservation before Sandbox creation completes local cleanup after rolling back the reservation. It does not require a NanoHost restart. Retained storage still requires the same responsible user and current access to every contributing Thread; administrator Workspace authority does not expose another user's private conversation or retained bytes.

## Recover a retained checkout

Use this sequence when the user wants a new Task on an authorized idle association that still holds a predecessor checkout. Web Advanced settings can select the retained environment for new Task Worker work, and public `conversation.submit` forwards `workerStorageChoice` on warm/new Task Worker targets. Recovering one exact predecessor checkout also requires the existing explicit `reuseWorkSlotRef`; use public Skill `task.start` or `conversation.submit` with that exact choice, rather than assuming environment selection resumes a particular checkout.

1. Describe `worker-environment.list`, `worker-environment.status`, `worker-environment.select`, `environment.snapshot-list`, and `task.start` before calling them.
2. List retained environments for the Workspace and copy the intended `storageRef`, current `revision`, `layoutDigest`, occupancy, and contributor Thread lineage. Do not reuse a `revision` remembered from an earlier call.
3. Read `worker-environment.status` for that `storageRef`. Continue only when the association is idle, host storage is available, and there is no current attachment.
4. Call `worker-environment.select` with the current `expectedRevision`, `layoutDigest`, target `threadId`, `purpose`, and `taskId`. Successful select is an eligibility check, not attachment.
5. List `environment.snapshot-list` for the Workspace. Match the exact predecessor Thread and Turn, then copy `snapshot.extensions.openkit.workerStorage.workSlotRef`. A missing field is not a reason to invent a slot or treat the volume as the checkout.
6. Start the Task with a new `requestId` and `workerStorageChoice` `{ "kind": "selected", "storageRef": "<storageRef>", "expectedRevision": <current revision>, "purpose": "work", "reuseWorkSlotRef": "<workSlotRef>" }` only when the intent is that predecessor checkout. Selected `storageRef` without `reuseWorkSlotRef` can attach the same volume while placing a distinct Thread slot, so it does not recover the same checkout.
7. Re-read `worker-environment.status` and the Task Turn. Claim recovery only after the selected association is attached for this work and a read-only Worker inspection of that checkout matches the predecessor files. A clean unrelated worktree, a successful select, or command acceptance alone is not recovery.

Preserve stale, unknown, audience, layout, or competing-writer refusals. Do not weaken the reuse check or drop the selected storage or work-slot choice when changing submission surfaces.

## Recover a fenced NanoHost cleanup

If a failed Task reports that backend cleanup requires a different fresh physical Epoch, inspect the exact Turn and `nanohost.runtime-target` before submitting more work. This is physical execution-host recovery, not a reason to rewrite scheduler records or remove storage. The public interface can inspect the failure and readiness; it does not expose a generic host-service restart. An authorized deployment operator can restart the affected NanoHost after checking other active work. Once NanoHost reports a different fenced, ready, fresh-empty physical Epoch, existing NanoCore maintenance retries the exact cleanup. Confirm the original failure is terminal and cleanup has settled before submitting a new request; restarting NanoCore is not required solely to trigger that maintenance.

A terminal failed Task can also leave an idle failed Sandbox with an unknown Harness operation, while `recovery.worker-list` is empty because its leases are already terminal. After the existing authenticated replacement-host procedure proves a different fenced, ready, fresh-empty physical Epoch, a new authorized Task can retire those absent runtime handles through normal admission. Active Turns, nonterminal leases, Goal pins, storage checks and authorization still block unsafe replacement. The old Task remains failed or unknown; this neither retries its operation nor deletes retained storage. Same-Epoch reconnect or an increased connection generation alone is insufficient.

## Preserve fail-closed outcomes

Keep contradictory, incomplete, or stale recovery evidence visible. Do not convert it to success, invent a receipt, close a workflow locally, or create an ad hoc settlement process.

Escalate to administration only when the durable result identifies an operator-owned action. Otherwise prefer a truthful interrupted or unknown outcome and a new explicit request over hidden automatic repair.

## Diagnose canonical Artifact reference boot failures

A boot failure stating that an Artifact reference does not use its deterministic identity indicates invalid persisted reference metadata, not missing Artifact content. Preserve the exact error and affected identity; do not delete the Artifact, mark its reference declined, or bypass canonical validation. When NanoCore cannot start, Web and public API operations cannot repair it. An authorized deployment operator must stop the affected App, preserve the touched files outside its data root, inspect every referrer, and correct only the proven malformed identity using the canonical Artifact/Turn identity function. Historical boot audit failures remain unchanged. Deploy the producer correction before submitting more attachments, then verify readiness and exact Artifact content through the public interface.
