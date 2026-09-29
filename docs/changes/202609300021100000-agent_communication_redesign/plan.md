---
type: change-plan
status: in-progress
date: "2026-09-30"
---
# Agent Communication Interfaces Redesign

## Intent Revision 1 — 2026-09-30

This plan records a redesign discussion between the engineer and the primary agent (Claude Code, Opus) held on 2026-09-29 and 2026-09-30. The engineer's verbatim statements are kept uncommitted in `temp/agent-native/engineer-statements.md` (Rounds 5 to 13).

**The engineer's outcome.** Re-examine, improve, and where needed redesign every communication interface and architecture between NanoCore agents and workers, between workers, and from workers up to NanoCore. The process has three steps:
1. Resolve every open design question.
2. Amend the Core and specification documents.
3. Land the implementation in the codebase.

The current phase is design and discussion. The work includes the two engineer-approved proposals `temp/proposals/20260929-four-runtime-adapters.md` and `temp/proposals/20260929-agent-session-process-lifecycle.md`, and the primary's proposals in `temp/agent-interfaces/`.

**Effect boundary.** The primary implements and runs the code-level checks: unit tests and end-to-end tests that need no deployed test environment. Deployment, and every test, acceptance, or validation that needs a test environment, is handed to the engineer's colleague through this plan. When the primary's work ends, it writes a handoff section here recording what was done and what remains.

**Non-negotiables:**
- Root `AGENTS.md`, including NONNEG-001 data continuity: no compatibility layers for first-party wire formats, obsolete implementations are removed, and retained data stays usable.
- The Safety Kernel.
- The Goal Mode freeze: shared changes must not alter frozen Goal behavior.

**Exclusions.** This plan does not change:
- `docs/product-vision.md`, beyond the one engineer-requested agent-native paragraph;
- `docs/changes/202609290900000001-chat_task_stability_handoff/`, which belongs to another writer and keeps its release-stability scope.

## Intent Revision 2 — 2026-09-30

Source: the engineer's Round 16 message. The engineer closes the design discussion, authorizes execution, and sets the working method.

**Authorization:**
- The primary may read and modify any information and resource in this repository, including rewriting any part of it.
- All other work in the repository is stopped until this plan's work is complete, so concurrent-writer coordination with other changes is not needed.
- Commit locally at each milestone, using the local git identity with no attribution trailer. Pushing is not authorized unless the engineer asks for it.

**Scope rulings:**
- **Q4:** Goal Mode issues are deferred to a later complete Goal redesign. This change does not migrate or preserve frozen Goal worker behavior. Where removed dependencies would leave Goal paths incoherent, the minimal honest handling is an explicit unavailable result for Goal entry, with old Goal data kept readable.
- **Q6:** Both implementation stages are in this change.
  - Stage 1: Core lifecycle; Gateway on MCP SDK v2; pending tool calls; snapshot-chain collection; the `openkit-work` tools (`work_request_input`, `work_list_peers`, `work_read_peer`); with the Codex App Server v2 and Pi SDK host adapters.
  - Stage 2: the OpenCode V2 and DeepSeek ACP adapters.
- **Q7:** Local commits at each milestone.
- The consequences listed under Open Questions stand, since the engineer did not object:
  - a Task is its Thread and all its Turns;
  - the internal Assistant's MCP approval follows decision 24;
  - open legacy worker Gates are closed honestly at upgrade;
  - the knowledge tools and external MCP clients stay deferred.

**Working method:**
- **Documents.** The primary is the primary writer, and a Pi agent on gpt-6-astra reviews.
- **Implementation.** The primary acts only as orchestrator. It dispatches building, review, and other bulk work to multiple Grok 4.7 agents run through Grok Build, and uses Pi on gpt-6-astra as the high-judgment advisor and auditor. Every interaction with another agent goes through herdr (engineer, 2026-09-30).
- **CodeGraph.** Pi has no MCP support, so every dispatch tells the agent to use the `codegraph` CLI (`codegraph explore "<query>"`).
- **Tests.** The primary delivers code-level unit and end-to-end tests without a deployed environment. Deployment and test-environment acceptance go to the engineer's colleague through this plan.
- **Completion.** Work continues until every task is complete with high quality. The primary then writes the handoff instructions here, and the colleague finishes the plan with pre-release testing and acceptance.

## Intent Revision 3 — 2026-09-30

Source: the engineer's Round 17 message, sent during execution.

**Handoff acceptance state.** All four supported worker runtimes must work under the new design: Codex, Pi, OpenCode V2, and DeepSeek Harness.
- The mechanisms covered are downward session control, upward MCP capabilities, same-Sandbox peer reads, and pending requests such as `work_request_input` and approvals. Every designed mechanism must operate correctly.
- The primary proves this at code level, with unit and end-to-end tests against local synthetic providers, for each runtime.
- The primary also lays the ground for live testing: images, configuration, runbooks, and probe scripts. The colleague then deploys, tests, and accepts in the test environment. That work is part of the handoff.

**One multi-runtime Sandbox image.** Package all four runtimes and their adapters into one container Sandbox image.
- The image is the Sandbox configuration for the initial version's test and acceptance phase.
- It is also the first, deliberately simple warm Sandbox after launch.
- This amends the singular-leaf image rule in the [worker execution environment images](../../specs/20260721-worker_execution_environment_images.md) owner and `containers/README.md`. It uses the accepted shared-Sandbox model in [Sandbox](../../core/sandbox.md): one static compatibility envelope with a declared Harness set, where the runtime is chosen per AgentSession.

## Owners And Seams

The redesign touches these accepted owners, with amendments still to be drafted:
- **Core:**
  - [AgentSession](../../core/agent-session.md);
  - [Communication](../../core/communication.md);
  - [Protocol](../../core/protocol.md);
  - [Permissions](../../core/permissions.md), only if the approver definition changes;
  - [Foundation](../../core/foundation.md), where the agent-native principle is already drafted.
- **Lifecycle and runtime:**
  - [AgentSession continuity](../../specs/20260704-agent_session_continuity.md);
  - [Worker runtime communication model](../../specs/20260629-worker_runtime_communication_model.md);
  - [Worker control protocol](../../specs/20260703-worker_control_protocol.md);
  - the [Codex](../../specs/20260716-codex_worker_adapter.md), [Pi](../../specs/20260716-pi_worker_adapter.md), and [OpenCode](../../specs/20260716-opencode_worker_adapter.md) adapter owners, plus a new DeepSeek Harness adapter owner.
- **MCP gateway and capabilities:**
  - [Worker MCP tool supply](../../specs/20260704-worker_mcp_tool_supply.md);
  - [Worker agent capability](../../specs/20260703-worker_agent_capability.md);
  - [Policy enforcement mapping](../../specs/20260703-policy_enforcement_mapping.md).
- **Human decisions, closeout, and delivery:**
  - [Human attention and intervention](../../specs/20260531-human_attention_intervention_model.md);
  - [Task Mode worker delegation](../../specs/20260704-task_mode_worker_delegation.md);
  - [Worker Turn reliability envelope](../../specs/20260531-worker_turn_reliability_envelope.md);
  - [Workspace synchronization](../../specs/20260703-workspace_synchronization.md);
  - [NanoHost workspace data boundary](../../specs/20260801-nanohost_workspace_data_boundary.md).

The primary is the single writer of this bundle and of the owner amendments it drafts. It does not edit the two `temp/proposals/` files or the stability-handoff change.

## Accepted Decisions

Each item gives the decision, its source, its reason, and when to revisit it. "Agent analysis" marks a reason the primary supplied and the engineer approved.

1. **OpenKit is agent-native** (engineer, Round 5; drafted in `docs/product-vision.md`, `docs/core/foundation.md`, and `docs/decisions/20260929-agent_native_capabilities.md`, all uncommitted). Reason: without agents the platform does not stand. Revisit per that decision record.
2. **Worker runtimes must speak MCP**; a runtime without MCP is not supported (engineer, Round 6). Reason: one standard agent interface keeps new-runtime cost near zero.
3. **Sandbox Integration's role** is to keep the link with NanoHost and NanoCore and to do only the work no standard covers: work-data capture, extra configuration, and Turn management (engineer, Round 6).
4. **Delegated work is a tree**, not a mesh, for control edges such as dispatch and cancel (engineer, Round 4).
5. **The upward direction is NanoCore-served MCP**, exposed through the existing gateway and loaded by the worker runtime (engineer, Round 8).
6. **Tool-surface changes happen at Turn boundaries** (engineer, Round 9). Reason: the audit shows which tools the agent could see, and a mid-Turn change breaks prompt caching and the model's plan.
7. **One approval mechanism with a variable approver** (engineer, Round 9). An agent may later approve non-sensitive requests; this is not activated.
8. **Asynchronous approval follows the unreleased MCP draft SEP-2848** (engineer, Round 9, reconfirmed in Round 13). A requestable denial returns a pending handle. The approver resolves it out of band. At execution the server re-evaluates authority against the immutable call binding, executes at most once through an atomic claim, and reports an execution disposition.
9. **The four runtime adapter choices** (engineer-approved in the four-runtime proposal):
   - Codex: App Server v2;
   - Pi: official SDK in a dedicated host;
   - OpenCode V2: native server with its official client;
   - DeepSeek Harness: native ACP.
10. **AgentSession is one active execution binding, independent of Turns** (engineer-approved in the lifecycle proposal). Turn completion does not close it; closure releases the binding; a successor resumes the exact native conversation. Consequence: every Turn-coupled rule that closes an AgentSession must be amended with it, including Gate closeout.
11. **Pi uses `nicobailon/pi-mcp-adapter`** until official Pi MCP ships (engineer, Round 10, M2).
12. **Full permission inside the Sandbox** (engineer, Round 10, A2). Restrictions sit only at the Sandbox boundary: storage and network policy, and external systems reached through the MCP Gateway. There are no native runtime permission prompts. Reason: this is why agents run in Sandboxes.
13. **In-Sandbox configuration and tools are unrestricted** (engineer, Round 13, G4). An in-Sandbox MCP server or tool, such as CodeGraph configured for a software-development Sandbox, is there for the worker to use. Approval and audit apply only to the worker's interaction with external systems. This amends the direct-connection prohibition in [Worker MCP tool supply](../../specs/20260704-worker_mcp_tool_supply.md).
14. **External systems are integrated through the vendor's own MCP server**, proxied by the Gateway, which holds authentication and account and repository binding (engineer, Round 10). The comparison with `openkit-repository` is deferred (Round 11).
15. **The Gateway adopts the latest official MCP SDK and full support for the current standard**, including the 2026-07-28 stateless era, in this redesign's implementation (engineer, Round 11, S1).
16. **The ACP boundary** (engineer, Round 12; agent analysis):
    - the common runtime contract is the single downward standard;
    - each adapter uses the runtime's most capable maintained first-party interface;
    - ACP is used only where that interface is ACP;
    - no third-party bridge sits beside a first-party native interface, and non-ACP adapters use no partial ACP;
    - ACP is the default path for long-tail runtimes that speak it natively.

    Revisit when a later ACP version standardizes identity, compaction, credentials, quiescence, and recovery admission, and vendors maintain first-party ACP at parity.
17. **NanoCore is the agent control plane, not an agent harness** (engineer, Round 12). "Harness" names only the in-Sandbox worker-shim component.
18. **`work_request_input` is the first implementation** (engineer, Round 13). Its design must be redone for decision 10 and aligned with decision 8, so the answer is not attached to the originating Turn.

19. **Workspace collection is a snapshot chain** (engineer, Round 14, accepting Q2; agent analysis).
    - Each collection records `base` as the previous `head` and a new `head`, taken by a read-only scan outside the Sandbox, so change sets telescope with no duplicate and no omission.
    - NanoCore rejects a change set whose `base` differs from the previous `head` as `recovery_required`.
    - Each collection scans twice for a stable tree and marks itself `unstable` when writers persist.
    - Collection points: Turn end (the next Turn is dispatched after it completes), AgentSession release, and before a successor starts on the same work volume. Mid-way checkpoints exist but are enabled only when a consumer exists.
    - Reason: the engineer's principles are to never affect the running worker, and never duplicate or omit data. Freezing was rejected because it pauses background processes.
20. **A read-only same-Sandbox peer tool** (engineer, Round 14, accepting Q3; agent analysis). `work_list_peers` and `work_read_peer` read Core's canonical records of the other AgentSessions in the same Sandbox. Reason: same-Sandbox AgentSessions are already one compromise domain with compatible trust ([Sandbox](../../core/sandbox.md)), and read-only information creates no control edge. The same-Sandbox relatedness boundary is an interim simplification, removed when relatedness must cross Sandboxes or depend on permissions. Asking a peer is deferred.
21. **Pending requests and approvals follow one mechanism.** A pending tool call is resolved out of band, and its result is delivered to the agent as a new Turn on the same Thread; the user's input re-wakes the agent (engineer, Round 14, accepting Q1 b).
22. **No default request deadline** (engineer, Round 14, Q1 c). A pending request or approval waits until it is answered, denied, or withdrawn by the user, or until an invalidating event such as Thread closure. A configurable deadline policy may be added later. The engineer raised the trade-off between blocking and non-blocking requests; the primary's refinement is under Open Questions.
23. **Agent-initiated withdrawal** (SEP-2848 `tasks/cancel`) is recorded as design only and not implemented, because the draft is unreleased (engineer, Round 14, Q1 d).

24. **After approval, the Gateway executes the captured call** (engineer, Round 15, Q1 a; SEP-2848 completion semantics).
    - The Gateway stores the immutable call binding: tool, full arguments, and originating authorization context.
    - After the approver grants, it re-evaluates against current authority, credentials, policy, and tool schema, then executes once through an atomic claim and records the disposition.
    - The agent never re-issues the call to claim a grant.
    - Reason: the approver sees exactly what executes; there is no dependence on the model reproducing arguments; at-most-once is enforced by the server; and it replaces the claim-on-later-Turn rule, which existed only because the old lifecycle bound AgentSession to Turns.
25. **Blocking is derived from Thread state, and expiry is event-based** (engineer, Round 15, accepting the refinement of decision 22).
    - A pending request is blocking when the agent ended its Turn while the request was outstanding and no later Turn has run.
    - Neither kind expires by time.
    - Staleness is guarded by re-evaluation at execution, and the approval card shows the request's age, the Turns run since, and the recent changes.
    - Invalidating events are:
      - Thread closure, archive, or deletion;
      - Workspace deletion;
      - loss of the requester's membership or authority;
      - denial;
      - withdrawal by the user;
      - withdrawal by the agent, which is design only.
    - AgentSession release does not invalidate a request.
    - Accumulation is bounded by a per-Thread count, not by time.

26. **Resident runtime requests are attributed to the Turn bound when they arrive** (engineer, Round 18; [decision](../../decisions/20260930-resident_request_attribution.md)).
    - Session-local loopback credentials, one per route family, are refused when no Turn is bound, drained at the Turn barrier, and destroyed at close.
    - Upstream route tokens still rotate per Turn.
    - This replaces the rule that native work from one Turn can never acquire a later Turn's authority.
27. **One multi-runtime image is the sole deployment worker image** (engineer, Round 18; [decision](../../decisions/20260930-one_multi_runtime_worker_image.md)). `worker-common` stays the public base. The three single-runtime images are removed, and stored agent manifests are rewritten to the combined image by a one-way migration.

## Primary Design Derivations

The primary derived these details inside the accepted decisions. A fresh Pi Consultant on gpt-6-astra challenged them at the direction check on 2026-09-30 (report kept uncommitted in `temp/comm-redesign/reports/direction-check.md`, outcome Ask Human). The engineer then decided the two questions it raised: derivations 1 and 8 became decisions 26 and 27. Each remaining derivation below has been corrected for the Consultant's findings, and its rationale is in [proposal.md](proposal.md).

1. **Session loopback credentials:** now decision 26. Correction from the review: NanoCore mints one credential per route family and delivers them in `session.open`, so NanoCore knows every value it must check. On a NanoCore restart the values are gone, so the binding is not adoptable, and a successor resumes natively.
2. **Tool refresh is declared by each adapter.** The Turn boundary runs in this order:
   1. fence the earlier Turn;
   2. admit and bind the new Turn;
   3. discover tools;
   4. verify the snapshot the model will see;
   5. prompt.

   A runtime that cannot list tools again treats a supply change as a setup change, which is replaced at the boundary the continuity owner names (AgentSession, Harness, or Sandbox), with native resume. Resume can still fail explicitly, so nothing is claimed to be lossless. Tests check the model-visible schema, not only `tools/list`.
3. **Delivery of outcomes.** Turn admission freezes a bounded set of undelivered outcomes into the Turn, within the existing input bounds, and records the association from each outcome to that Turn. An outcome resolved after admission waits for the next Turn.
   - A proved pre-native refusal releases the set to the next Turn.
   - An unknown native submission is never resubmitted automatically. The outcome is marked delivery-unknown and follows the existing Turn recovery.
   - Exactly-once is claimed only for proved submissions.
4. **A `user-input-response` Item may reference its request anywhere in the same Thread.** The checks that the same-Turn schema rule performed move to the pending-request owner, at command admission and at canonical load: one outstanding request, the correct responder, and one winning response.
5. **The approval-pending result is `isError: true`, and the `work_request_input` result is `isError: false`.** Structured and text content carry the same pending fields. A pinned-client test must show that the handle survives error normalization and that a retry does not multiply requests.
6. **Deduplication uses the qualified immutable effect binding.** The binding is server id, catalog revision, schema snapshot, tool, canonical arguments, Thread, Agent, and responsible user. Deduplication runs only against non-terminal requests, and only after current authorization. It never substitutes an old approved effect for a new one, and it does not solve general occurrence identity after a terminal result.
7. **The literal credential check runs in the NanoHost scan over exact staged blob bytes.** NanoCore supplies the check values in memory with each collection command: Vault-resolved runtime-env values and the binding's loopback credentials. The values are never persisted.
   - **On a hit.** The collection fails with a typed rejection, that scan's private objects are deleted, and the head does not advance.
   - **Other checks.** The Harness keeps its assistant-text and diagnostic checks.
8. **The multi-runtime image:** now decision 27.
9. **The snapshot chain's guarantee is contiguity of captured states.** A state that exists only between two scans is not observed, and an `unstable` capture is flagged. Review candidates stay Core's: a candidate is computed from Core's accepted base, the last applied or origin state, to the current head, not from one per-Turn link. A rejected candidate does not advance the accepted base.
10. **NanoHost runs Git only against its private store.** The data-boundary prohibition is amended narrowly: a pinned Git with its own `GIT_DIR` and the retained volume as work tree. No worker-controlled configuration, hooks, attributes, filters, or drivers apply, and blobs are hashed byte-exact without filters. Untracked ignored paths are excluded, as today.
11. **Repository push under decision 24.** The pending binding is the exact push intent: source ref, commit, target branch, and linkage.
    - **Human mode.** On grant, the Gateway runs the Git owner's host-side push for that exact intent, with every existing barrier: host commit, review linkage, current Vault, target, and the unknown-outcome rule with no retry.
    - **Automatic mode.** The push executes in the same call.
    - **Removed.** The separate `repository_push_execute` tool.
12. **Deferred execution authorization.** Execution after the originating Turn ended re-evaluates current Workspace membership and Agent authority, the Thread's current supply for that server and tool, current credentials and policy, and the current schema. A supply that has dropped the tool gives `denied-not-executed`. Execution runs inside the owner of the response command. After a restart, a claimed but unfinished execution is `outcome-unknown` and is never executed again. No background runner is added.
13. **Declared runtime-env credentials.** They are session-static inside a resident binding. A changed declaration or value gives a successor AgentSession at the next Turn, and a revocation interrupts and closes the binding at once.

**Owners added by the review:**
- [Git write workflow](../../specs/20260704-git_write_workflow.md);
- [internal agent resource integration](../../specs/20260909-internal_agent_resource_integration.md), with human attention's internal branch;
- [worker credential access declarations](../../specs/20260709-worker_credential_access_declarations.md);
- [runtime scheduling scale](../../specs/20260703-runtime_scheduling_scale.md), for concurrent active Turns across distinct AgentSessions, which it already accepts but which is not implemented;
- the new pending-requests specification, which supersedes the [Delayed User Input Draft](../../specs/20260921-delayed_user_input.md).

**Handoff acceptance inventory.** For each of Codex, Pi, OpenCode V2, and DeepSeek Harness, the code-level evidence covers the items below. The proofs use the real runtime distributions against synthetic local providers, never a synthetic runtime:
- resident Turns, exact successor resume, explicit incompatible or missing-context failure, cancellation mid-model and mid-tool, reconnect, and no replay of uncertain work;
- upward MCP discovery and calls under current authority, both protocol eras where the client allows, tool refresh, and fail-closed native permissions;
- same-Sandbox peer list and read, with correct residence, paging, and product-safe disclosure;
- human input, approval execution, denial, user withdrawal, invalidation, no default deadline, a response while a Turn is busy, waking an idle or successor AgentSession, and restart and unknown handling;
- configured model, tools, Skills, and extensions, including Pi's user Extensions with a session-start hook, a Skill or template, one sandbox-local MCP, OpenKit MCP exactly once, a browser path, and an explicit unsupported result for UI-only features;
- credential change and removal, truthful compaction evidence, and snapshot-chain collection, including a background writer, a sentinel credential in a binary file, rejected ingestion, and review after a rejected predecessor;
- the combined image, with exact pins, four adapter selections, configuration examples, runnable probe commands, and a live runbook whose deployed checks are pending the colleague.

## Open Questions

All questions below are resolved: Q1 to Q3 by decisions 19 to 25, and Q4 to Q7 by Intent Revision 2. The record of what was asked follows.
- **Q4, frozen Goal Mode.** Goal code reads Turn-level `humanGate` and `awaiting_human` (for example in `apps/nanocore/src/goal-routes.ts`), and it runs on the adapter paths being replaced. The primary recommends closing Goal Mode entry with an explicit unavailable result for the duration of this change, and keeping old Goal data readable, until the Goal redesign. The alternatives rejected are rebuilding the old Gate stop on the new adapters, or migrating Goal, which would break the freeze.
- **Q5, concurrent writer coordination** (Safety Kernel). The stability-handoff change's Intent Revision 5 (resident Pi) touches the same worker-shim Harness, adapter, and gateway paths. This needs:
  - confirmation that that line of work pauses and moves to this plan;
  - confirmation that the primary is the single writer of those paths during implementation;
  - the author of the two `temp/proposals/` files.
- **Q6, implementation scope and order.**
  - Stage 1: Core lifecycle, Gateway SDK v2, pending calls, collection, and the `openkit-work` tools, with the Codex App Server v2 and Pi SDK host adapters.
  - Stage 2: the OpenCode V2 and DeepSeek ACP adapters.

  Is stage 2 inside this change? End-to-end tests use local synthetic providers.
- **Q7, commits.** The primary proposes local commits at each milestone with no push unless asked.

Consequences the primary will write unless the engineer objects:
- **A Task becomes its Thread and all its Turns.** The single-Turn rule and `remainingWorkerIterations=0` are removed, and Task state is projected as running, waiting (a blocking request is pending), or completed, over the Turns and pending requests.
- **The internal Assistant's MCP approval exit**, which is not yet implemented, follows decision 24.
- **Worker Gates still open at upgrade are closed honestly.** They are marked not executed, with an upgrade reason, and their history stays readable. Old Approvals store only an argument digest, so they cannot move to decision 24.
- **Still deferred:** the knowledge tool family and external user MCP clients.
- **Deferred:**
  - cross-mode leaf rules (M4);
  - general occurrence identity (M6);
  - external user MCP clients (M7);
  - GitHub identity, repository binding, and commit transport (G1 to G3);
  - agent approvers;
  - resident tool refresh through notifications;
  - native MCP Tasks in runtime clients.

## Working Checkpoint

The design is closed (Intent Revision 2), and execution has started.

Milestones, each with one local commit:
1. **M1, consolidated proposal.** Write `proposal.md` in this bundle from the `temp/` proposals (`temp/agent-interfaces/`, `temp/proposals/`, `temp/agent-native/`), keeping the worthwhile argument. Commit it together with the drafted agent-native edits: `docs/product-vision.md`, `docs/core/foundation.md`, and `docs/decisions/20260929-agent_native_capabilities.md`.
2. **M2, decision records.** Record the engineer's rulings under `docs/decisions/`.
3. **M3, Core amendments.** Amend `agent-session`, `communication`, and `protocol` (requests are not Turn pauses; AgentSession is a binding). Pi reviews.
4. **M4, specification amendments.** Amend these owners, and write the new DeepSeek adapter spec. Pi reviews.
   - `agent_session_continuity`, `worker_runtime_communication_model`, and `worker_control_protocol`;
   - the adapter specs;
   - `worker_mcp_tool_supply`, `worker_agent_capability`, and `policy_enforcement_mapping`;
   - `human_attention_intervention_model`, `task_mode_worker_delegation`, and `worker_turn_reliability_envelope`;
   - `workspace_synchronization` and `nanohost_workspace_data_boundary`;
   - `worker_execution_environment_images` and `container_image_packaging`, for the multi-runtime image.
5. **M5 onward, implementation.** Implement stage 1 in owner-seam slices through Grok builders and reviewers, with focused tests, and commit each slice. Then implement stage 2, and build the multi-runtime Sandbox image.
6. **Final milestone.** Write the handoff section here. The handoff state is that every mechanism passes code-level tests for all four runtimes, and the image, configuration, and live-test runbook are ready.

The fresh-context direction check ran on 2026-09-30 and returned Ask Human; the engineer's two answers are decisions 26 and 27, and the corrections are in the derivations above and in the proposal.

M1 is committed together with the two decision records that the plan cites. Next action: M2, the remaining decision records (decisions 4, 19, 20, the Goal deferral, and the supersession of the blocking-gate expiry record), then M3.
