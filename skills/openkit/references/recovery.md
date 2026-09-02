# Recovery

Load this reference for interrupted or unknown work, retries, checkpoints, restarts, stale state, `recovery_required`, or a locally aborted wait.

## Reconstruct from durable state

1. Run `doctor` and restore connection, authentication, readiness, and contract compatibility first.
2. Re-read the workspace, thread, active mode, turn or task, Action Center, artifacts, evidence, and any exposed checkpoint state.
3. Compare the durable records with the last successful CLI envelope and identify which outcome is confirmed, unknown, stale, or contradictory.
4. Present the smallest safe next choice to the user before invoking another mutation.

Treat NanoCore records as authority after a CLI restart, agent-host restart, NanoCore restart, timeout, SIGINT, or transport loss. Never reconstruct workflow truth from local logs or assume that a stopped local wait cancelled remote work.

For an owner-requested permanent Workspace deletion, use `workspace.delete` and preserve its exact `requestId`, confirmation, and returned phase. A fenced response is not deletion success; retry the same request only after the returned runtime blockers become terminal. Use local-mode `workspace.deleted-recover` only when the retained deletion export and closure verify successfully; recovery always remints the Workspace identity.

## Handle retries conservatively

Reuse the same request only when the public operation contract and returned state make replay safe. Treat changed input under the same idempotency identity as a conflict.

When NanoCore returns `recovery_required`, assume that safe exact replay cannot be proven. Do not blindly repeat the mutation. Re-read the owning durable records, explain the uncertainty, and use an explicit retry, new request, interruption, cancellation, or operator decision only when CLI discovery exposes it and the user authorizes it.

For an interrupted worker or checkpoint, inspect the exposed durable lineage and status before requesting retry. Let NanoCore validate ownership, sequence, lease, scheduler, and checkpoint eligibility; do not synthesize or repair those records in the Skill or CLI.

## Preserve fail-closed outcomes

Keep contradictory, incomplete, or stale recovery evidence visible. Do not convert it to success, invent a receipt, close a workflow locally, or create an ad hoc settlement process.

Escalate to administration only when the durable result identifies an operator-owned action. Otherwise prefer a truthful interrupted or unknown outcome and a new explicit request over hidden automatic repair.
