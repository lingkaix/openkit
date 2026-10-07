---
status: Accepted
---
# Using OpenKit

Use Web for ordinary conversation, delegated work, human decisions and outputs. An external Agent uses remote MCP guide, search, describe and call to discover and invoke supported operations; administrators can use this operations package's CLI. Both operate the same durable product records and current user authority.

Select the intended Workspace and inspect its configured repositories, Agent and model before a source task. Quick conversation is for short assistance; use a Worker task for bounded execution and Goal Mode for planned work requiring coordination. In the current Web composer, the Worker target may be presented as **New Shard + Worker**, which creates a linked execution Thread. Follow that receiving Thread rather than treating submission as completion.

State the outcome, constraints and independently checkable output. For repository engineering, the Worker should read that repository's `AGENTS.md` and accepted owners. Do not turn one repository's engineering workflow into a universal OpenKit rule. A separate review or verification needs an actually separate Agent context examining the relevant artifacts and evidence; an Agent's self-report or a stored verification label does not prove independence.

Inspect progress, human-attention requests and resulting artifacts. Supply reserved user decisions from actual user direction. Review the changed bytes and named check results before accepting work. Product records and source artifacts decide the outcome; telemetry and logs help explain failures but do not replace those records.

For dogfood repository Tasks and Goals, prefer a plan+patch handoff when the Worker cannot push or create a GitHub PR because of missing credentials or TLS failures. Have the Worker retain the plan and patch locally and report their exact locations, repository/base revision, check results, and the publication failure without secrets. A human or local agent retrieves and reviews the handoff, applies the patch in a local checkout, runs the relevant checks, pushes a branch, and opens the PR. The agreed plan+patch handoff can complete after required review and acceptance; PR publication remains pending and must not be reported as done. If an opened PR is the requested stop condition, report that remaining step explicitly. Do not provision broad worker GitHub write credentials without an explicit house decision. Linked-repository sync is separate work tracked in [#60](https://github.com/lingkaix/openkit/issues/60).

Use the remote guide and recovery guidance below for interrupted or unknown work. Re-read current state before retrying an external effect. For deployment maintenance, we recommend an external Agent with this `openkit-ops` Skill and your authorized host tools. Give it the selected host, exact release and maintenance scope; for NanoHost upgrades, ask it to follow [installed release replacement](nanocore-operations.en.md#replace-an-installed-nanohost-release) separately from App update. Use [operations](nanocore-operations.en.md) when the product itself is unavailable, and [container-dependent tests](sandbox-container-tests.en.md) when a check needs an effect outside the Worker sandbox.

The work, human-attention, Artifact, Knowledge and permission contracts are owned by `docs/core/` and their specifications in the selected source revision. This reference describes usable surfaces and does not declare unimplemented roadmap features complete.

## Loop Guidance

Load this reference for normal workspace work, mode selection, plans, bounded execution, Action Center decisions, artifacts, evidence, reviews, or completion.

## Prepare the work context

Check the connection and read guide, select or create the intended workspace, and inspect its durable resources. Resolve repositories, data sources and effect scope from the user's current instructions; request only missing authorization before linking or changing them.

Use `workspace.resources` for the selected Workspace Agent inventory, or describe `agent.list` and `agent.read` for the authorized catalog. Server-supplied Agent manifests remain visible even when unavailable or not selected as a launch default. A null `kind` means an unspecified role: describe it as Worker, never guess from a runtime name. Health is a summary, not proof of a running session or sandbox; unknown health must remain unknown. Refresh rereads configured supply, and its response timestamp acknowledges that refresh rather than attesting a successful runtime probe.

Use `worker.list` with the selected `workspaceId` to read current Workers in that Workspace; it is distinct from configured `agent.list` supply and does not create or control work. Rows are keyed by Thread and report recorded state and update time, not current process liveness. `stale` means the recorded setup is outdated, not that the fetch failed. Private Thread audience still applies, and a currently usable administrator credential is eligible under the administrator paragraph below. Package model preference and last-used model are separate; last-used usage requires `audit.read` or is restricted. Missing or conflicting work attribution and absent package details remain explicit. Do not infer assignment, model identity, or AgentSession/native runtime identifiers.

Create or resume one thread for the work. Read the current thread, active mode state, Action Center, and relevant artifacts before mutating anything.

Workspace access and private conversation ownership are separate. Private conversation ownership stays with the initiating user for attribution. A currently usable administrator credential, the administrator's Web session or an administrator bearer, may read another user's private Thread and act in a Workspace without membership under the administrator eligibility rule in [Core Permissions](https://github.com/lingkaix/openkit/blob/main/docs/core/permissions.md#administrator-eligibility). The administrator is the recorded actor and does not impersonate that user. Use `conversation.navigation` for the current actor's eligible conversation list. A missing or inaccessible Thread returns no private details; do not retry through another endpoint to bypass that result. Web and remote MCP credentials may belong to different users, so compare their access using their actual identities.

Read `thread.dashboard` for `taskInputs`: each `{ itemId, objective }` summarizes one structured Worker request identified by verified Context Package evidence. Match by exact Item id; the original message remains the source for full constraints and instructions. Missing summaries mean no readable projection is available, not that a Task did not exist or completed successfully. Do not infer a Task from arbitrary user JSON.

## Select the smallest suitable mode

- Use Chat Mode for a lightweight answer that does not need delegated execution or a negotiated plan.
- Use Task Mode for one bounded delegated task that needs worker execution but not plan negotiation.
- Goal work uses immutable Plan approval and completion acceptance through Pending Requests; the Coordinator dispatches ordinary Tasks within the approved version through the shared operations, and card edits do not steer a running worker.

Do not promote work to a heavier mode merely because that mode exists. Let NanoCore report when an accepted handoff or transition is required.

Use `goal.create` to capture current intent and `goal.read` to inspect intent, cards, separate proposed and active immutable Plans, exact Pending Requests, linked ordinary Tasks and disposition. `goal.intent.revise`, `goal.card.create`, `goal.card.edit` and `goal.card.cancel` change current desired work without steering a running worker. Human Plan and completion decisions use `goal.plan.approve` and `goal.completion.accept` with the captured Pending Request identity. A grant waits for the Goal owner to consume it; activation alone starts no worker. `goal.cancel` closes the Goal and invalidates unconsumed requests.

Use `usage.read` for durably recorded model usage; process-local diagnostics are not the Workspace ledger.

## Run bounded work

1. Search and describe the required operation when its contract is not already known.
2. Goal work uses immutable Plan approval and completion acceptance through Pending Requests; the Coordinator dispatches ordinary Tasks within the approved version through the shared operations, and card edits do not steer a running worker.
3. Invoke one operation with its described input.
4. Re-read the thread, mode state, Action Center, artifacts, and evidence.
5. Explain the durable result and any pending human decision.
6. Continue with one next operation only when the state and user direction permit it.

Treat Action Center as the authoritative projection of required human attention. Never approve a plan, answer a question, accept or reject a result, extend a budget, authorize spending, or resolve another decision without explicit user direction.

Workspace Review attention rows may include `threadId` and `turnId` for a visible originating conversation. Use those fields to identify the source; missing fields do not mean the Workspace review is unavailable. Inspect and decide through the exact Workspace review operation, preserving its Workspace scope.

For a new Task Worker submission, omitting `workerStorageChoice` creates a new retained environment. To reuse one explicitly, discover and describe `worker-environment.list` and `worker-environment.select`; these technical reads require a currently usable administrator credential under the administrator eligibility rule in [Core Permissions](https://github.com/lingkaix/openkit/blob/main/docs/core/permissions.md#administrator-eligibility), which includes the target Thread and retained source audiences. Preserve the selected storage reference and expected revision in `conversation.submit` only for a warm Worker or new Task Worker target. Selection is a read-only eligibility preview, not attachment permission; actual Task admission checks the receiving Thread, all contributors, layout and current revision again. A linked Task may have a different receiving Thread from the originating conversation. Do not drop a denied or stale choice, substitute fresh storage, or retry with a changed request body under the same request identity. Web exposes the same choice under the existing Composer `+` entry's Advanced settings.

A successful `conversation.submit` command or `outcome: accepted` confirms command acceptance, not Worker success. Selected-Worker submissions return after the durable Turn and result Item exist, while execution and cleanup continue. Inspect the returned Turn status and error, then re-read that exact Turn before reporting completion; keep the returned receiving Workspace and Thread ids when the command creates a linked Task. Replaying the same request identity reads that same work and never launches another Worker. If a submission connection fails, the Task may still be running; inspect durable state rather than creating a duplicate request.

Treat artifacts and evidence as review inputs, not automatic proof of correctness. Compare them with the objective, constraints, requested verification, and durable status before recommending acceptance.

Workspace review staging and application retain the non-Git filesystem path. Git work publishes through selected vendor MCP under its own approval and authority; Core no longer stages or applies a host Git checkout. Read the pending filesystem review and recorded apply result before retrying after a server correction; a failed acceptance is not proof that changes were applied.

For a reusable document or report, discover `artifact.import`, `artifact.read`, and `artifact.introduce`. Import preserves one immutable content version and its origin. Introduction into an idle Thread adds a reference only; it does not ask an agent to read the file or start work. To request a bounded answer from its contents, submit `conversation.submit` with the exact `{ artifactId, artifactVersion }` in `artifactRefs` and the selected logical model. Compare the answer with the read-back content rather than inferring delivery from a title or reference Item. The Assistant must answer from the admitted attachment rather than substitute an unrelated Knowledge result. A local report query or a topic such as Web testing does not itself request external browsing; actual external search remains unavailable in Chat Mode. Likewise, mentioning Goal or roadmap as a topic does not request planning; explicit planning and actionable multi-step work retain the Goal handoff. Automatic inference uses bounded English phrases, so select the explicit Goal operation when planning intent is not recognized.

Use an accepted refine, redo, interrupt, or stop operation only when operation discovery exposes it and the durable state permits it. Goal steering, pause, and resume belong only to the legacy implementation and are not operations of the new Goal contract. Never claim that an active-turn input was delivered merely because a local call completed; report the durable delivery outcome returned by NanoCore.

## Close or hand off

Call the loop complete only when the requested stop condition is met, relevant evidence has been reviewed, no blocking Action Center decision remains, and any acceptance explicitly reserved to the user has been received. Ordinary completion under existing authorization does not require a new approval.

For repository Tasks and Goals using a plan+patch handoff, missing GitHub credentials or TLS failures may prevent worker push or PR creation. Retain the plan and patch locally and report their exact locations, the repository and base revision, completed checks, and the publication failure without secrets. The closeout should state: "Plan+patch ready for handoff; PR publication pending. A human or local agent should retrieve the plan and patch, review/apply the patch in a local checkout, run the relevant checks, push a branch, and open the PR." Complete the agreed handoff once the conditions above are met; do not keep retrying worker publication. If the requested stop condition requires an opened PR, report that remaining step explicitly rather than claiming full completion or silently changing the objective.

If state is interrupted, unknown, stale, or contradictory, stop normal execution and load the recovery guidance below. If the user asks for operator-only changes, load [administrator operations](nanocore-operations.en.md).

A bounded Task may begin with an explicit implementation instruction and include later review or handoff constraints without becoming a review-only request. A request to review or retry previous work retains that intent. Keep the objective within the structured delegation limit of 2,000 characters; preserve required constraints when shortening it.

For selected-Worker `conversation.submit`, that limit applies to the assembled prompt, including attached Artifact text. Oversized input returns HTTP 400 `invalid_request` with the schema issue text before a receiving Thread, Turn, Worker admission, or executor start is created. NanoCore does not truncate the objective; shorten it without losing required constraints before submitting a corrected request under a new request identity.

## Knowledge Guidance

Load this reference for knowledge sources, observations, claims, conflicts, retrieval, bounded context preparation, proposals, repair, or knowledge health.

## Read before writing

Identify the workspace and thread context, then search the operation catalog with the user's intent, such as `knowledge source`, `retrieve`, `claim`, `conflict`, `context prepare`, `proposal`, `repair`, or `health`. Describe the selected operation before invoking it.

Read current knowledge state before recording a new observation, claim, decision, or proposal. Preserve the source, scope, provenance, and revision information required by the described schema; do not infer missing provenance or present a projection as its durable owner.

## Apply governed changes

Perform one knowledge mutation at a time and re-read its durable result. Treat conflicts, stale revisions, reviews, and promotion requirements as governed outcomes rather than local merge prompts.

Present knowledge proposals and conflicts to the user with their evidence and scope. Resolve or promote them only through an exposed operation and explicit user direction when that decision changes shared knowledge.

A retrieved page is not automatically a sufficient answer. The Knowledge Manager answer operation checks distinct query-term coverage and can return `insufficient-evidence` even when retrieval found a page. Assistant Chat then uses its selected model; explicit Knowledge Manager calls retain the insufficient-evidence result.

Use retrieval or bounded context preparation to obtain scoped knowledge evidence. Worker delivery is owned by Task Mode and its governed Context Package; do not create or materialize a second standalone Knowledge package. Do not bulk-load the knowledge store when a scoped query is sufficient, and do not treat retrieved context as authorization to mutate another record or external system.

Use repair or health operations only for the condition they describe. Re-read the affected durable records after repair and report any remaining conflict, missing dependency, or typed failure.

## Protect sensitive and derived material

Never store credentials, one-time secret material, raw private runtime state, or unredacted diagnostic output as knowledge. Preserve required citations and provenance when deriving a claim from an artifact, evidence record, source, or observation.

Do not duplicate an artifact into knowledge merely to make it discoverable. Record the supported reference or derived claim when the described public contract provides one.

## Recovery Guidance

Load this reference for interrupted or unknown work, retries, checkpoints, restarts, stale state, `recovery_required`, or a locally aborted wait.

## Reconstruct from durable state

1. Run `doctor` and restore connection, authentication, readiness, and contract compatibility first.
2. Re-read the workspace, thread, active mode, turn or task, Action Center, artifacts, evidence, and any exposed checkpoint state.
3. Compare the durable records with the last successful CLI envelope and identify which outcome is confirmed, unknown, stale, or contradictory.
4. Present the smallest safe next choice to the user before invoking another mutation.

Treat NanoCore records as authority after a CLI restart, agent-host restart, NanoCore restart, timeout, SIGINT, or transport loss. Never reconstruct workflow truth from local logs or assume that a stopped local wait cancelled remote work.

For `NanoHost Harness turn.start refused: dependency_failed (workspace_materialization: retained_baseline_conflict)`, Web and remote MCP/API expose the same Turn explanation: “The retained checkout and requested commit differ; choose a fresh work environment for the requested commit, or restore the source configuration to the retained checkout’s original commit before reusing it.” Preserve the failed Turn and retained bytes; do not reset, clean or automatically reconcile the checkout, and do not retry the same conflicting selection unchanged.

For `NanoHost Harness turn.start refused: dependency_failed (workspace_materialization: git_fetch_commit_unavailable)`, Web and remote MCP/API expose the same Turn explanation: “The configured Git remote does not serve the requested commit; publish that commit or select one the remote serves, then start a new Task. The incomplete slot stays in place.” A ready host checkout does not prove the sandbox fetch. Preserve the failed Turn and the incomplete slot; do not copy host bytes into the worker or retry the same missing commit unchanged.

For `workspace_materialization: git_fetch_http_refused`, read the failed Turn's structured `error.explanation`: Git observed HTTP 401 or 403, but the source of the refusal is not established. Ask an authorized operator to inspect sandbox network grants and upstream access separately. `enforcement: unavailable` forbids treating this alone as `sandbox_network_denied`, configuration drift or a Vault failure. `evidence.availability: partial` and `outputTruncated` describe the available observation; they do not authorize retry. Preserve the failed Turn and incomplete slot, and start a new Task only after current authorization and cleanup/storage admission permit it. Do not inject credentials into credential-free materialization, disable TLS or automatically widen grants. The first delivery exposes diagnosis, not delegated policy-apply Tools or service recovery.

For `NanoHost Harness turn.start refused: dependency_failed (workspace_materialization: git_fetch_tls_failed)`, Web and remote MCP/API expose the same Turn explanation: “The worker could not trust the configured Git remote during fetch. Repair the sandbox trust bundle, then start a new Task. The incomplete slot stays in place.” Preserve the failed Turn and the incomplete slot; do not disable certificate verification or copy host bytes into the worker.

For `NanoHost Harness turn.start refused: dependency_failed (workspace_materialization: git_fetch_transport_failed)`, Web and remote MCP/API expose the same Turn explanation: “The worker could not complete the Git fetch transport. This covers a subprocess, timeout, or transport failure and is not proof that the remote lacks the commit. The incomplete slot stays in place.” Preserve the failed Turn and the incomplete slot; do not treat a ready host checkout as proof the sandbox fetch succeeded.

A NanoCore-only update does not by itself require a new Worker environment. A later Turn can restore the exact compatible idle runtime and attached storage when the same ready physical Epoch, native-session proof and current admission remain valid. Verify the retained checkout and resulting Turn rather than treating a visible Worker target as proof of file continuity. Missing or fenced storage stays an error; do not replace it with a fresh environment to conceal the failure.

For a failed Worker inference stream, inspect the Turn and its attributed calls through `usage.read`. A recorded `provider_stream_truncated` identifies a stream that ended without the required completion; `provider_stream_failed` identifies a stream failure. Both remain failures, and neither alone identifies the upstream cause. A generic stream error from an older record cannot be retrospectively classified. Preserve the exact Turn and call evidence before deciding whether to submit a new bounded request.

For a NanoHost Harness result timeout, read the original Turn failure. New diagnostics identify the fixed Harness operation and distinguish never dispatched from dispatched while awaiting a result. Neither phase grants permission to replay: dispatched effects can be unknown, and cleanup or retained storage must still be inspected through their existing owners. Older generic timeout records cannot be retrospectively classified from duration or absent heartbeat alone. Do not infer model execution time from the Harness result budget.

Harness acknowledgement retries are internal result delivery, not another Task execution. NanoCore accepts the identical prior result while a successor operation is still queued without repeating completion effects. This does not authorize clients to resubmit failed Tasks; inspect their durable Turn and retained environment before starting a new authorized request.

A completed Turn proves execution closeout, not that its visible answer satisfies the task. If Web and `thread.items` contain only an intermediate update, keep the result review pending and preserve the Turn and runtime evidence. A final answer present only in raw evidence does not authorize rewriting canonical messages or accepting the review. Diagnose the shared inference/output path before a new authorized verification task; do not retry merely to hide the missing result.

For an owner-requested permanent Workspace deletion, use `workspace.delete` and preserve its exact `requestId`, confirmation, and returned phase. A fenced response is not deletion success; retry the same request only after runtime quiescence is proven. A failed lease may retain `needs-evidence` when its exact matching backend records completed physical cleanup; NanoCore verifies that proof without clearing the unknown historical result. Missing cleanup proof and other unresolved leases continue to fence deletion. Use local-mode `workspace.deleted-recover` only when the retained deletion export and closure verify successfully; recovery always remints the Workspace identity.

Current running admission lets a current usable server-admin bearer owned by the original deleting Workspace owner resume that exact deletion request after the registry becomes `deleting` or `deleted`. That running original-owner limit is not the rule. A currently usable administrator credential is eligible to start or resume that deletion, and to recover a deleted Workspace, under the administrator eligibility rule in [Core Permissions](https://github.com/lingkaix/openkit/blob/main/docs/core/permissions.md#administrator-eligibility), without first becoming the owner. That narrow deletion retry still grants no ordinary Workspace content access outside the request. The recorded actor is the administrator, and a recovered Workspace returns to its original owner. Explicit access recovery remains a separate membership operation. Quick Chat remains owner-only as a Workspace classification, and the credential may read another user's Quick Chat under that same rule without transferring ownership.

A Worker may finish its commands while transcript or Workspace-change handoff fails. Its Turn is still failed; assistant text alone does not prove a durable review exists. Inspect `sync.review-list` and `sync.change-set-list` before retrying or applying anything. A handoff failure before backend cleanup uses the normal verified AgentSession close path instead of retaining a native session that Core marked failed. A separately authorized new Task can retire a leftover native binding for its terminal predecessor after fresh scheduler admission and verified cleanup, without reopening or replaying the failed Turn. If cleanup is unknown or a current-session conflict remains, preserve the exact failure and use the exposed recovery or operator path; do not delete binding rows or treat an empty interrupted-worker list as proof of recoverability.

For a legacy `git_repository_missing` handoff failure, preserve the exact failed input identity and original Turn. This failure can leave no staged review, output manifest, or reconciliation record, so an empty Recovery page is not a retry route. Do not create a host repository binding as an implementation of the accepted hosting target. If the original retained environment is still available, use **Recover a retained checkout** below to start a new authorized Task and inspect its changes under current storage and audience admission. Keep the original Turn failed, verify any newly produced evidence, and obtain the authority required by the actual non-Git apply or vendor hosting effect. Do not fabricate a quarantine reason, reopen the old Turn, or equate recovered files with applied or published changes.

A storage validation error naming `evidence/backend/` while the raw output merely quotes the Data Root path is an implementation defect, not evidence of a path escape. Preserve the failed Turn and original bytes. If the App still answers, create and verify a deployment backup through `backup.create` and `backup.verify` before maintenance; a successful configuration file update does not prove `runtime.reload` succeeded. An affected image may fail to reopen the same bytes after restart. Repair requires an authorized operator with a verified fixed image; do not delete or rewrite the evidence, fabricate recovery records, or retry the Worker to hide the failure. After replacement, verify readiness and the intended loaded configuration through the same public operations used by Web.

A failed persistence write can leave a Product Turn recorded as running and its AgentSession busy even after the exact backend session is cleaned and the checkpoint is failed. Those recorded labels do not establish a live process. `recovery.worker-list` lists authoritatively interrupted attempts, not every failed or inconsistent checkpoint; an empty list does not establish healthy closeout. For Worker work, `turn.interrupt` requires an exact live Worker control session and cannot settle this historical persistence failure. Preserve the original failure and request identity, inspect available public evidence, and use separately authorized operator diagnosis when the public projection lacks the required lineage. Do not rewrite records, manufacture interrupted status, or repeatedly send interrupts to make the display clear.

For active internal Chat, explicit `turn.interrupt` stops the admitted model wait and persists `interrupted` with `provider_call_aborted`. A transport disconnect or locally aborted wait does not stop server work. Replaying the Chat submission or accepted interrupt reads the retained lineage without another provider invocation; a new attempt needs a new request id. If interruption cannot persist its required records, NanoCore returns `recovery_required`; do not claim cancellation from a rejected Stop, a timeout, or a later provider failure.

## Handle retries conservatively

Reuse the same request only when the public operation contract and returned state make replay safe. Treat changed input under the same idempotency identity as a conflict.

When NanoCore returns `recovery_required`, assume that safe exact replay cannot be proven. Do not blindly repeat the mutation. Re-read the owning durable records, explain the uncertainty, and use an explicit retry, new request, interruption, cancellation, or operator decision only when operation discovery exposes it and the user authorizes it.

A Goal-admitted Task uses ordinary Task recovery. There is no `goal.step` closeout and no Goal pin. Do not invent a new request to bypass an exact retained reservation. An anchored runtime, conflicting lineage, or missing proof remains `recovery_required`, and an original attempt awaiting reconnection remains busy. A successful replay response confirms recorded failure closeout, not successful work. User input remains history, not Worker output. Recovery grants no database-editing or automatic rerun authority.

`scheduler_admission_denied` reports that the exact submitted queue entry was rejected by scheduler admission; preserve its returned reason instead of interpreting it as waiting for capacity. Inspect current Workspace authority and scheduler state before retry. Accepted Tasks remain queued under HTTP 202 while the backend is busy; use existing Turn reads or exact replay to observe their current owner. Queue-full is a definite refusal and creates no hidden later execution. A denial belonging to another queue entry is not evidence that this request was denied.

For an interrupted worker or checkpoint, inspect the exposed durable lineage and status before requesting retry. Let NanoCore validate ownership, sequence, execution attempt, scheduler, and checkpoint eligibility; do not synthesize or repair those records in the client.

## Diagnose stalled package downloads

An allowed network policy decision does not prove that TLS or a package download succeeded. Preserve the exact Turn before stopping a stalled install with `turn.interrupt`, then wait for durable terminal status. A bounded diagnostic Task can run a package metadata request with a short process timeout, disabled retries, and unbuffered output; inspect its actual exit code and error before repeating an install.

`SELF_SIGNED_CERT_IN_CHAIN` from Node-based package tools can indicate missing trust for the sandbox proxy certificate. The Worker shim derives Node's additional CA file from the backend-provided `SSL_CERT_FILE`; ambient or runtime-credential `NODE_EXTRA_CA_CERTS` is not a supported repair. Do not disable certificate verification or widen network grants to bypass this failure. An authorized operator must update an affected Worker image through the existing environment preparation and activation workflow, then verify the same bounded download in a new Turn. A directory-only certificate setting does not supply Node's required CA file. Host image building and installation remain separate operator tools; see [administrator operations](nanocore-operations.en.md).

## Continue administrator Tasks with the presented credential

The Task remains bound to the credential presented when it was submitted. After the work waits in queue or NanoCore restarts, NanoCore rechecks that bound Token before the next governed effect. Reads may use another authorized credential. An expired, revoked, rebound, or unusable Token denies that next effect; it is not queued capacity. Inspect exposed Task and Turn metadata and current authority. Ask the user only if the credential must be replaced, then submit a new authorized request after correction. Do not grant membership, invent a replacement Token, or repair scheduler, lease, or admission records.

A denied storage reservation before Sandbox creation completes local cleanup after rolling back the reservation. It does not require a NanoHost restart. Retained storage still requires the same responsible user and current access to every contributing Thread. A currently usable administrator credential meets that audience under the administrator eligibility rule in [Core Permissions](https://github.com/lingkaix/openkit/blob/main/docs/core/permissions.md#administrator-eligibility).

## Recover a retained checkout

Use this sequence when the user wants a new Task on an authorized idle association that still holds a predecessor checkout. Web Advanced settings can select the retained environment for new Task Worker work, and public `conversation.submit` forwards `workerStorageChoice` on warm/new Task Worker targets. Recovering one exact predecessor checkout also requires the existing explicit `reuseWorkSlotRef`; use remote MCP `task.start` or `conversation.submit` with that exact choice, rather than assuming environment selection resumes a particular checkout.

1. Describe `worker-environment.list`, `worker-environment.status`, `worker-environment.select`, `environment.snapshot-list`, and `task.start` before calling them.
2. List retained environments for the Workspace and copy the intended `storageRef`, current `revision`, `layoutDigest`, occupancy, and contributor Thread lineage. Do not reuse a `revision` remembered from an earlier call.
3. Read `worker-environment.status` for that `storageRef`. Continue only when the association is idle, host storage is available, and there is no current attachment.
4. Call `worker-environment.select` with the current `expectedRevision`, `layoutDigest`, target `threadId`, `purpose`, and `taskId`. Successful select is an eligibility check, not attachment.
5. List `environment.snapshot-list` for the Workspace. Match the exact predecessor Thread and Turn, then copy `snapshot.extensions.openkit.workerStorage.workSlotRef`. A missing field is not a reason to invent a slot or treat the volume as the checkout.
6. Start the Task with a new `requestId` and `workerStorageChoice` `{ "kind": "selected", "storageRef": "<storageRef>", "expectedRevision": <current revision>, "purpose": "work", "reuseWorkSlotRef": "<workSlotRef>" }` only when the intent is that predecessor checkout. Selected `storageRef` without `reuseWorkSlotRef` can attach the same volume while placing a distinct Thread slot, so it does not recover the same checkout.
7. Re-read `worker-environment.status` and the Task Turn. Claim recovery only after the selected association is attached for this work and a read-only Worker inspection of that checkout matches the predecessor files. A clean unrelated worktree, a successful select, or command acceptance alone is not recovery.

Preserve stale, unknown, audience, layout, or competing-writer refusals. Do not weaken the reuse check or drop the selected storage or work-slot choice when changing submission surfaces.

## Recover a fenced NanoHost cleanup

Verified writer cleanup can release the exact failed materialization's Worker storage reservation even when no durable Sandbox record was created. Release makes the association idle without deleting retained bytes or changing unrelated reservations. A non-null Sandbox binding must match the durable backend's binding; a null pre-Sandbox reservation is valid only with the matching durable lineage and verified cleanup. Unknown, contradictory, ambiguous or stale proof stays fenced rather than becoming idle. Re-read the environment status before selecting it for another request; retained files alone do not prove cleanup.

If a failed Task reports that backend cleanup requires a different fresh physical Epoch, inspect the exact Turn and `nanohost.runtime-target` before submitting more work. This is physical execution-host recovery, not a reason to rewrite scheduler records or remove storage. The public interface can inspect the failure and readiness; it does not expose a generic host-service restart. An authorized deployment operator can restart the affected NanoHost after checking other active work. Once NanoHost reports a different fenced, ready, fresh-empty physical Epoch, existing NanoCore maintenance retries the exact cleanup. Confirm the original failure is terminal and cleanup has settled before submitting a new request; restarting NanoCore is not required solely to trigger that maintenance.

A terminal failed Task can also leave an idle failed Sandbox with an unknown Harness operation, while `recovery.worker-list` is empty because its execution attempts are already closed. After the existing authenticated replacement-host procedure proves a different fenced, ready, fresh-empty physical Epoch, a new authorized Task can retire those absent runtime handles through normal admission. Active Turns, nonclosed execution attempts, storage checks and authorization still block unsafe replacement. The old Task remains failed or unknown; this neither retries its operation nor deletes retained storage. Same-Epoch reconnect or an increased connection generation alone is insufficient.

## Preserve fail-closed outcomes

Keep contradictory, incomplete, or stale recovery evidence visible. Do not convert it to success, invent a receipt, close a workflow locally, or create an ad hoc settlement process.

Escalate to administration only when the durable result identifies an operator-owned action. Otherwise prefer a truthful interrupted or unknown outcome and a new explicit request over hidden automatic repair.

## Diagnose canonical Artifact reference boot failures

A boot failure stating that an Artifact reference does not use its deterministic identity indicates invalid persisted reference metadata, not missing Artifact content. Preserve the exact error and affected identity; do not delete the Artifact, mark its reference declined, or bypass canonical validation. When NanoCore cannot start, Web and public API operations cannot repair it. An authorized deployment operator must stop the affected App, preserve the touched files outside its data root, inspect every referrer, and correct only the proven malformed identity using the canonical Artifact/Turn identity function. Historical boot audit failures remain unchanged. Deploy the producer correction before submitting more attachments, then verify readiness and exact Artifact content through the public interface.

## Acceptance Guidance

Use the existing deployment and its authorized connection. Do not reinstall OpenKit, recreate Provider accounts or clear existing data merely to start a new check. A successful `doctor` confirms the connection/contract boundary; it is not proof that a real Worker can complete work.

## Execute A User Goal

Select a Workspace or create clearly identifiable scenario state within the user's authorization. Use the normal Task or Goal workflow for actual Agent workloads. Follow durable status with bounded reads and a deadline; do not treat accepted submission as completion. If a human decision is pending, expose it through the normal product flow.

Keep the user's objective open-ended. Discover the operations needed to accomplish it; do not use a hidden expected answer or prescribed call sequence. If acting as an acceptance Actor, do not inspect implementation files, judge instructions or private database state.

## Locate Results

Search for `thread`, `turn`, `artifact`, `evidence`, `audit` and `usage` as needed, then describe the relevant operations. Retain the Workspace, Thread and Turn identifiers from the actual responses. Read the terminal result and meaningful output; use the existing evidence and audit operations to establish only the facts they expose. Preserve pagination, missing records and partial coverage in the report.

With deployment-admin authority, use `diagnostics` discovery for boot/readiness, configuration and available process observations. Missing optional telemetry is a diagnostic limitation, not product failure or success. Do not infer Worker reachability from configured readiness alone. Keep private conversation content separate from shared operational reports.

When authorized retained or exported observations include `env.bound`, it records the internal Chat or Administration environment through its NanoCore version, Workspace identity, prompt digest and Tool-schema digests; it does not contain the prompt or prove complete model-body capture. Requested sampling fields omitted by the caller remain absent, while explicit zero stays zero. A `turn.reap` row records NanoCore restart recovery and unresolved observed calls, not proof that their external effects did not happen. Imported observations preserve correlations within their reminted Turn group; do not join identical correlation strings across different groups. These meanings are shared by Web and remote MCP/API consumers.

## Diagnose Without Changing The Verdict

Distinguish product failure, environment failure, tool failure and insufficient evidence. Preserve the returned error and relevant observations before correcting anything. A local timeout stops waiting, not necessarily remote work; read current state before retrying. Never rewrite product state to make a check pass.

A Task error `unsupported_gateway_feature` means the selected Gateway route cannot preserve the requested features. Choose a compatible model route and submit a new Task; do not treat this as a quota failure or retry the same unsupported combination. Web and public thread reads expose the same Turn error. Historical generic errors are not retroactively reclassified.

For authorized Worker dependency setup, distinguish blocked native-addon downloads from missing build tools. The Worker Shim defaults node-gyp to its own Node installation only when local `include/node/node.h` exists; it does not install headers or expand network access. A command using another Node version must select matching headers explicitly. Older Worker images may need an explicit matching `npm_config_nodedir` in the sandbox command environment until an approved image update supplies the default; never declare this setting as a runtime credential. Preserve the lockfile and report the actual install and native-module smoke results; successful model inference alone does not prove the development environment is ready.

The Agent host may separately have SSH, browser, repository or deployment tools. Use them only within the user's explicit scope and outside the administrator CLI. An operator repair or version change ends the original attempt; test the repaired behavior in a new attempt. Do not copy secrets, raw configuration dumps or unrestricted logs into the task.

## Report And Continue

Report the goal, actual identifiers, observed outcome, relevant evidence and unresolved limitations. A benchmark additionally identifies its inputs/checks, model/configuration, budget and sample count; a single sample is an observation, not a demonstrated performance improvement. Use existing tasks and Artifacts rather than a private test database.

Remove only attempt-owned temporary resources when cleanup is requested and safe. Keep the deployment and its Provider configuration available for the next task. Report unrelated discoveries without expanding the work or closing untested plans.
