# Recovery

Load this reference for interrupted or unknown work, retries, checkpoints, restarts, stale state, `recovery_required`, or a locally aborted wait.

## Reconstruct from durable state

1. Run `doctor` and restore connection, authentication, readiness, and contract compatibility first.
2. Re-read the workspace, thread, active mode, turn or task, Action Center, artifacts, evidence, and any exposed checkpoint state.
3. Compare the durable records with the last successful CLI envelope and identify which outcome is confirmed, unknown, stale, or contradictory.
4. Present the smallest safe next choice to the user before invoking another mutation.

Treat NanoCore records as authority after a CLI restart, agent-host restart, NanoCore restart, timeout, SIGINT, or transport loss. Never reconstruct workflow truth from local logs or assume that a stopped local wait cancelled remote work.

For a failed Worker inference stream, inspect the Turn and its attributed calls through `usage.read`. A recorded `provider_stream_truncated` identifies a stream that ended without the required completion; `provider_stream_failed` identifies a stream failure. Both remain failures, and neither alone identifies the upstream cause. A generic stream error from an older record cannot be retrospectively classified. Preserve the exact Turn and call evidence before deciding whether to submit a new bounded request.

For an owner-requested permanent Workspace deletion, use `workspace.delete` and preserve its exact `requestId`, confirmation, and returned phase. A fenced response is not deletion success; retry the same request only after runtime quiescence is proven. A failed lease may retain `needs-evidence` when its exact matching backend records completed physical cleanup; NanoCore verifies that proof without clearing the unknown historical result. Missing cleanup proof and other unresolved leases continue to fence deletion. Use local-mode `workspace.deleted-recover` only when the retained deletion export and closure verify successfully; recovery always remints the Workspace identity.

A current usable server-admin bearer owned by the original deleting Workspace owner can resume that exact deletion request after the registry becomes `deleting` or `deleted`. This grants no ordinary Workspace content access and no foreign-owner deletion authority. An administrator without ownership must use the existing explicit access-recovery path before starting deletion; Quick Chat remains owner-only.

A Worker may finish its commands while transcript or Workspace-change handoff fails. Its Turn is still failed; assistant text alone does not prove a durable review exists. Inspect `sync.review-list` and `sync.change-set-list` before retrying or applying anything. A handoff failure before backend cleanup uses the normal verified AgentSession close path instead of retaining a native session that Core marked failed. A separately authorized new Task can retire a leftover native binding for its terminal predecessor after fresh scheduler admission and verified cleanup, without reopening or replaying the failed Turn. If cleanup is unknown or a current-session conflict remains, preserve the exact failure and use the exposed recovery or operator path; do not delete binding rows or treat an empty interrupted-worker list as proof of recoverability.

## Handle retries conservatively

Reuse the same request only when the public operation contract and returned state make replay safe. Treat changed input under the same idempotency identity as a conflict.

When NanoCore returns `recovery_required`, assume that safe exact replay cannot be proven. Do not blindly repeat the mutation. Re-read the owning durable records, explain the uncertainty, and use an explicit retry, new request, interruption, cancellation, or operator decision only when CLI discovery exposes it and the user authorizes it.

`scheduler_admission_denied` reports that the exact submitted queue entry was rejected by scheduler admission; preserve its returned reason instead of interpreting it as waiting for capacity. Inspect current Workspace authority and scheduler state before retry. A synchronous Task may cancel its unstarted queue entry during cleanup, so an empty admission list does not prove it ran. A denial belonging to another queue entry is not evidence that this request was denied.

For an interrupted worker or checkpoint, inspect the exposed durable lineage and status before requesting retry. Let NanoCore validate ownership, sequence, lease, scheduler, and checkpoint eligibility; do not synthesize or repair those records in the Skill or CLI.

## Diagnose stalled package downloads

An allowed network policy decision does not prove that TLS or a package download succeeded. Preserve the exact Turn before stopping a stalled install with `turn.interrupt`, then wait for durable terminal status. A bounded diagnostic Task can run a package metadata request with a short process timeout, disabled retries, and unbuffered output; inspect its actual exit code and error before repeating an install.

`SELF_SIGNED_CERT_IN_CHAIN` from Node-based package tools can indicate missing trust for the sandbox proxy certificate. The Worker shim derives Node's additional CA file from the backend-provided `SSL_CERT_FILE`; ambient or runtime-credential `NODE_EXTRA_CA_CERTS` is not a supported repair. Do not disable certificate verification or widen network grants to bypass this failure. An authorized operator must update an affected Worker image through the existing environment preparation and activation workflow, then verify the same bounded download in a new Turn. A directory-only certificate setting does not supply Node's required CA file. Host image building and installation remain separate operator tools; see [administration.md](administration.md).

## Continue administrator Tasks with the presented credential

The Task remains bound to the credential presented when it was submitted. After the work waits in queue or NanoCore restarts, NanoCore rechecks that bound Token before the next governed effect. Reads may use another authorized credential. An expired, revoked, rebound, or unusable Token denies that next effect; it is not queued capacity. Inspect exposed Task and Turn metadata and current authority. Ask the user only if the credential must be replaced, then submit a new authorized request after correction. Do not grant membership, invent a replacement Token, or repair scheduler, lease, or admission records.

A denied storage reservation before Sandbox creation completes local cleanup after rolling back the reservation. It does not require a NanoHost restart. Retained storage still requires the same responsible user and current access to every contributing Thread; administrator Workspace authority does not expose another user's private conversation or retained bytes.

## Recover a fenced NanoHost cleanup

If a failed Task reports that backend cleanup requires a different fresh physical Epoch, inspect the exact Turn and `nanohost.runtime-target` before submitting more work. This is physical execution-host recovery, not a reason to rewrite scheduler records or remove storage. The public interface can inspect the failure and readiness; it does not expose a generic host-service restart. An authorized deployment operator can restart the affected NanoHost after checking other active work. Once NanoHost reports a different fenced, ready, fresh-empty physical Epoch, existing NanoCore maintenance retries the exact cleanup. Confirm the original failure is terminal and cleanup has settled before submitting a new request; restarting NanoCore is not required solely to trigger that maintenance.

## Preserve fail-closed outcomes

Keep contradictory, incomplete, or stale recovery evidence visible. Do not convert it to success, invent a receipt, close a workflow locally, or create an ad hoc settlement process.

Escalate to administration only when the durable result identifies an operator-owned action. Otherwise prefer a truthful interrupted or unknown outcome and a new explicit request over hidden automatic repair.
