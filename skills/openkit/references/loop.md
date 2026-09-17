# Bounded Work Loop

Load this reference for normal workspace work, mode selection, plans, bounded execution, Action Center decisions, artifacts, evidence, reviews, or completion.

## Prepare the work context

Run `doctor`, select or create the intended workspace, and inspect its durable resources. Resolve repositories, data sources and effect scope from the user's current instructions; request only missing authorization before linking or changing them.

Use `workspace.resources` for the selected Workspace Agent inventory, or describe `agent.list` and `agent.read` for the authorized catalog. Server-supplied Agent manifests remain visible even when unavailable or not selected as a launch default. A null `kind` means an unspecified role: describe it as Worker, never guess from a runtime name. Health is a summary, not proof of a running session or sandbox; unknown health must remain unknown. Refresh rereads configured supply, and its response timestamp acknowledges that refresh rather than attesting a successful runtime probe.

Use `worker.list` with the selected `workspaceId` to read current Workers in that Workspace; it is distinct from configured `agent.list` supply and does not create or control work. Rows are keyed by Thread and report recorded state and update time, not current process liveness. `stale` means the recorded setup is outdated, not that the fetch failed. Private Thread audience still applies. Package model preference and last-used model are separate; last-used usage requires `audit.read` or is restricted. Missing or conflicting work attribution and absent package details remain explicit. Do not infer assignment, model identity, or AgentSession/native runtime identifiers.

Create or resume one thread for the work. Read the current thread, active mode state, Action Center, and relevant artifacts before mutating anything.

Workspace access and private conversation ownership are separate. A private Thread requires the exact authenticated owner, including when the credential has administrator authority. A currently usable presented `server-admin` bearer can start and run a Task in a Workspace without membership; a Web session that merely owns an administrator Token is not that bearer and still follows ordinary membership. Use `conversation.navigation` for the current actor's eligible conversation list. A missing or inaccessible Thread returns no private details; do not retry through another endpoint to bypass that result. Web and Skill credentials may belong to different users, so compare their access using their actual identities.

Read `thread.dashboard` for `taskInputs`: each `{ itemId, objective }` summarizes one structured Worker request identified by verified Context Package evidence. Match by exact Item id; the original message remains the source for full constraints and instructions. Missing summaries mean no readable projection is available, not that a Task did not exist or completed successfully. Do not infer a Task from arbitrary user JSON.

## Select the smallest suitable mode

- Use Chat Mode for a lightweight answer that does not need delegated execution or a negotiated plan.
- Use Task Mode for one bounded delegated task that needs worker execution but not plan negotiation.
- Use Goal Mode for tracked multi-step work that needs a plan, approval, bounded steps, and review.

Do not promote work to a heavier mode merely because that mode exists. Let NanoCore report when an accepted handoff or transition is required.

The initial deterministic Goal planner drafts one bounded Worker task from the objective; it does not perform model-generated decomposition. Review the actual task scope, assumptions, risks and verification before requesting approval. A generated plan is a proposal, not evidence that a complex objective has been decomposed or can be completed in one step.

Before approval, use `goal.revise` with the exact current Plan and the user's requested changes, then `goal.plan` to produce a revised draft. The existing Goal Orchestrator reads that recorded instruction and prior immutable Plan with only `goal.plan.propose`; it cannot approve, launch Workers, or access repositories, MCP or secrets. Read the new draft with `goal.plan-read` and obtain human approval again. Missing model configuration, an invalid or unchanged proposal, cancellation or model failure leaves the Goal recoverable in planning; do not present the old deterministic draft as a successful revision. Concurrent requests for the same Goal are rejected or coalesced rather than creating competing drafts.

Use `goal.plan-read` to inspect the current durable plan after reconnect or reload. Reading never creates, revises or approves a plan; do not call `goal.plan` as a read substitute. Present the exact returned plan and `planItemId` for the required human decision. An unavailable or contradictory plan remains an explicit error, not permission to use an older Thread Item or generate a replacement.

## Run bounded work

1. Search and describe the required operation when its contract is not already known.
2. For Goal Mode, draft a narrow objective and plan, then obtain required human approval.
3. Invoke one mutation through stdin.
4. Re-read the thread, mode state, Action Center, artifacts, and evidence.
5. Explain the durable result and any pending human decision.
6. Continue with one next operation only when the state and user direction permit it.

Treat Action Center as the authoritative projection of required human attention. Never approve a plan, answer a question, accept or reject a result, extend a budget, authorize spending, or resolve another decision without explicit user direction.

Workspace Review attention rows may include `threadId` and `turnId` for a visible originating conversation. Use those fields to identify the source; missing fields do not mean the Workspace review is unavailable. Inspect and decide through the exact Workspace review operation, preserving its Workspace scope.

A successful `conversation.submit` command or `outcome: accepted` confirms command acceptance, not Worker success. Inspect the returned Turn status and error, then re-read that exact Turn before reporting completion. If a submission connection fails, the Task may still be running; inspect durable state rather than creating a duplicate request.

Treat artifacts and evidence as review inputs, not automatic proof of correctness. Compare them with the objective, constraints, requested verification, and durable status before recommending acceptance.

Workspace review staging and application support linked Git checkouts owned by a different host user through exact, command-scoped trust. Do not repair a review failure by setting global `safe.directory=*` or changing repository ownership. Read the pending review and recorded apply result before retrying after a server correction; a failed acceptance is not proof that the patch was applied.

For a reusable document or report, discover `artifact.import`, `artifact.read`, and `artifact.introduce`. Import preserves one immutable content version and its origin. Introduction into an idle Thread adds a reference only; it does not ask an agent to read the file or start work. To request a bounded answer from its contents, submit `conversation.submit` with the exact `{ artifactId, artifactVersion }` in `artifactRefs` and the selected logical model. Compare the answer with the read-back content rather than inferring delivery from a title or reference Item. The Assistant must answer from the admitted attachment rather than substitute an unrelated Knowledge result. A local report query or a topic such as Web testing does not itself request external browsing; actual external search remains unavailable in Chat Mode. Likewise, mentioning Goal or roadmap as a topic does not request planning; explicit planning and actionable multi-step work retain the Goal handoff. Automatic inference uses bounded English phrases, so select the explicit Goal operation when planning intent is not recognized.

Use an accepted refine, redo, steering, pause, resume, interrupt, or stop operation only when CLI discovery exposes it and the durable state permits it. Never claim that an active-turn input was delivered merely because a local call completed; report the durable delivery outcome returned by NanoCore.

## Close or hand off

Call the loop complete only when the requested stop condition is met, relevant evidence has been reviewed, no blocking Action Center decision remains, and any acceptance explicitly reserved to the user has been received. Ordinary completion under existing authorization does not require a new approval.

For repository Tasks and Goals using a plan+patch handoff, missing GitHub credentials or TLS failures may prevent worker push or PR creation. Retain the plan and patch locally and report their exact locations, the repository and base revision, completed checks, and the publication failure without secrets. The closeout should state: "Plan+patch ready for handoff; PR publication pending. A human or local agent should retrieve the plan and patch, review/apply the patch in a local checkout, run the relevant checks, push a branch, and open the PR." Complete the agreed handoff once the conditions above are met; do not keep retrying worker publication. If the requested stop condition requires an opened PR, report that remaining step explicitly rather than claiming full completion or silently changing the objective.

If state is interrupted, unknown, stale, or contradictory, stop normal execution and load [recovery.md](recovery.md). If the user asks for operator-only changes, load [administration.md](administration.md).
