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
  - open legacy worker Gates are closed honestly at upgrade (withdrawn by Intent Revision 4);
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

## Intent Revision 4 — 2026-09-30

Source: the engineer's message during M3 round-three corrections: 「不需要考虑旧版本的数据和会话的问题。」 ("There is no need to consider the issue of earlier-version data and sessions.")

**Earlier-version data and sessions are not carried** ([decision](../../decisions/20260930-earlier_version_data_not_carried.md)). This version starts from a new data root and reads no data an earlier version wrote. It removes the upgrade migration of retained requests, gates, and fields from derivation 17, the native-conversation classification from derivation 20, the upgrade handling of open executions in derivation 25, and the manifest rewrite from decision 27. Removed mechanisms are deleted outright, with no reader kept for records an earlier version wrote. The engineer confirmation the M3 reviews had reserved for the native-context fallback no longer arises, because no earlier-version conversation exists. The second reserved question, a closeout Turn on an archived Thread, is resolved separately and applies to new Threads too: closeout is written before the archived status, and archive waits for an idle Thread when something must be closed out.

## Intent Revision 5 — 2026-09-30

Source: the engineer's messages during M5, translated from Chinese.

**Battle test of a user-authored sandbox.** The engineer asked that the four-runtime image be exercised with Pi configured as the pi-optimized-agent wrapper (https://github.com/lingkaix/pi-optimized-agent, every plugin installed and configured), agent-browser configured for all four worker runtimes, and agent-browser sharing the one Chromium that the sandbox's Playwright installation provides, with no browser or browser engine installed twice. The engineer then stated the purpose: to verify whether the current designs and adapter implementations satisfy a user who creates and configures a sandbox themselves. The concrete in-sandbox configuration and the container's Dockerfile therefore do not enter system decisions; the platform must leave users room and mechanisms to create and configure different sandboxes and workers for their own needs. The wrapper, browser stack, keyless search choice (the wrapper's bundled Exa and DuckDuckGo need no key), and single-Chromium arrangement are a test fixture kept outside the owners. Gaps the fixture exposes are raised as generic mechanisms for engineer decision.

**Codex native home** (decision record `20260930-codex_home_retained_whole`, landing with the Codex adapter slice). The Codex adapter retains its whole native home, and in-Sandbox native configuration may influence local execution while AEP, adapter bindings, and the Gateway keep external authority.

**Dispatch routing.** Builders and writers run as Codex CLI on gpt-6.1-sol at medium effort in herdr. Small reviews run on gpt-6.1-sol; large or complex reviews and Consultant or advisor work run on Pi with gpt-6-astra. This supersedes the Grok routing stated in Intent Revision 2.

## Intent Revision 6 — 2026-09-30

Source: the engineer's messages and answers during the battle-test consultation, translated from Chinese. The Consultant's working analysis is `temp/comm-redesign/reports/consult-pi-wrapper-r2.md`.

**Externally managed native environment** (decision record `20260930-native_environment_managed_outside_the_sandbox`, landing with its owner amendments). The engineer asked whether in-Sandbox environment variables could be exposed outside the Sandbox so that the user can view and change them from NanoCore, with NanoHost or OpenShell recognizing image declarations, and approved that direction, delegating its details to the primary and the Consultant and asking to proceed unless an insurmountable technical blocker or an unrepairable design defect appears. The settled design reads the verified image's OCI `Config.Env` as digest-bound read-only defaults, lets the Server Agent manifest author non-secret overrides and removals edited through NanoCore's existing configuration App API, resolves the result once into the immutable AEP, delivers it in a separate non-secret `session.open` field beside the private Vault map, keeps the launcher's `env -i`, and applies a change at the next Turn through a successor with exact native resume. Modification by NanoCore's built-in agents, such as the Assistant and the Coordinator, through an MCP tool is pending, because the engineer is redesigning the built-in agents' tool system.

**Native defaults, native local configuration, and native MCP discovery.** The engineer accepted the Consultant's recommendations: use each runtime's native default layering where it exists and otherwise initialize only a fresh private home once from an image-designated native default tree, never overwriting an existing home and using no OpenKit profile format; honor each runtime's native local configuration in its native precedence, with the adapter overlaying only what it must own and failing on a protected conflict without editing user files, qualified per pinned version, with Codex plugins and hooks assessed separately; and let the Pi host load the native discovery mechanism that default-exposure local MCP servers need. For the last point the engineer asked a researcher to check whether Pi's SDK supports codemode and tool search and whether upstream will, before choosing between waiting, loading the native extensions, or `pi-mcp-adapter`; the primary observed that the pinned 0.99.1 SDK exports both extension constructors. The researcher's report (`temp/research/20260930-pi-codemode-mcp/report.md`) found that neither waiting nor `pi-mcp-adapter` is needed: loading the native tool-search extension alone makes default-exposure MCP tools discoverable and callable, while the codemode extension is not loaded because open upstream issue #10239 can route a call to the wrong one of two same-named tools; its removal condition is a released upstream fix qualified against the pin (decision record `20260930-pi_native_mcp_discovery`). During implementation the W3 Builder found that Pi 0.99.1's `createAgentSession` always supplies an initial tool list, so neither the SDK nor the CLI resume path restores the transcript's active tools, and a tool found through search before an exact successor is inactive afterwards. The Consultant (`temp/comm-redesign/reports/consult-pi-wrapper-r4.md`) withdrew its earlier assumption that native resume restores that state and recommended following the pin: the successor starts from the current native initial selection plus `tool_search`, and the model finds a previously searched tool again through search, while a stale direct call returns the native unavailable-tool error with no target effect. The primary accepted that settlement within the engineer's native-precedence and native-discovery rulings; it is a pin limitation that the Pi owner records and a later SDK upgrade requalifies, not an engineer ruling and not a claim about upstream intent.

**Credential-free public egress.** The engineer ruled that a credential-free, non-LLM public endpoint, such as a keyless search MCP server, may be reached directly from the Sandbox under an exact AgentManifest network grant, while credentialed or audit-requiring external integrations still go through the Gateway. Asked where that property must hold, the engineer chose classification at admission (an administrator-declared class validated by NanoCore) with the boundary enforcing only the existing exact grant rules, over boundary-enforced request inspection.

**DeepSeek removed-model successor.** Pinned `@deepseek-ai/dsh-acp@0.2.0-rc.2`, the newest published release, cannot natively resume a conversation when the successor's admitted catalog excludes the model it last used. Under the continuity owner's resume-or-fail-explicitly rule, that successor fails explicitly and the limit is recorded against the pin; rendering a non-routable placeholder descriptor to make resume succeed is an alternative left for the engineer.

## Intent Revision 7 — 2026-10-01

Source: the engineer's messages of 2026-10-01, translated from Chinese. The research is `temp/research/20261001-runtime-adoption-lody/` (`report-lody.md`, `report-adapters.md` and the pending `report-comparison.md`); the Consultant analysis is `temp/comm-redesign/reports/consult-pi-wrapper-r5.md`.

**Adoption paths as an experiment.** The engineer explained that the four runtimes use different adoption paths in order to test whether a unified or partially unified underlying mechanism is possible, asked to keep discussing during landing what an efficient and stable way to adopt a runtime is, and asked for a comparison with Lody, which connects runtimes through an ACP extension protocol. After the research summary, the engineer agreed with its conclusions and asked to optimize the adapters according to them: product lifecycle and authority are already shared; the repeated cost is adapter-local proof handling, where a weaker fact was promoted to a stronger one; a mandatory ACP bridge would move those proofs behind each bridge rather than remove them. The direction is a small shared proof and settlement substrate inside the existing worker-shim adapter support seam, together with an adversarial contract suite, with native evidence producers staying in each adapter. Its first step is the research's bounded counterfactual, and the substrate is extracted only if that step's falsifier does not fire.

**Pi native codemode support boundary** (decision record `20261001-pi_codemode_support_boundary`, landing with W3). The engineer approved Consultant round 5's option (b): Pi 0.99.1 native codemode is unsupported OpenKit supply refused at the static and immediate post-`session_start` setup checks, and later user Extension execution is outside the supported configuration rather than universally prevented; Sandbox and Gateway authority and all managed and lifecycle protections are unchanged. Translated: "For Pi Agent CodeMode, I also agree with your suggested narrowing to a support boundary."

**Pending-request exact effect and delivery bound** (decision records `20261001-approval_exact_effect_disclosure` and `20261001-pending_delivery_count_bound`, landing with N-pending). N-pending round 2 stopped on two gaps in the pending owner; the Consultant analysis is `temp/comm-redesign/reports/consult-pending-gaps.md`. The engineer chose both recommendations. First, approval cards and shared Items carry a bounded summary of at most 2 KiB and never raw captured arguments; only the responsible user reads the complete canonical exact-effect detail of at most 512 KiB under current authority; and unavailable, oversized or undisclosable detail makes the server refuse grant with `409 approval_preview_unavailable` while deny and withdraw remain available. Second, the phantom "existing aggregate input bounds" reference is removed: delivery is bounded by the 16-outcome count and each owner's real limits, and it carries selected values completely, with the stated limitation that a large input may exceed an executor's capacity.

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
    - A pending request is blocking when the agent ended its Turn while the request was outstanding and no later Turn has run. The pending-requests owner reads "has run" as "has started", so a request stops blocking once a later Turn starts on its Thread.
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
27. **One multi-runtime image is the sole deployment worker image** (engineer, Round 18; [decision](../../decisions/20260930-one_multi_runtime_worker_image.md)). `worker-common` stays the public base. The three single-runtime images are removed. The manifest rewrite this decision named is withdrawn by Intent Revision 4.

## Primary Design Derivations

The primary derived these details inside the accepted decisions. A fresh Pi Consultant on gpt-6-astra challenged them at the direction check on 2026-09-30 (report kept uncommitted in `temp/comm-redesign/reports/direction-check.md`, outcome Ask Human). The engineer then decided the two questions it raised: derivations 1 and 8 became decisions 26 and 27. Each remaining derivation below has been corrected for the Consultant's findings, and its rationale is in [proposal.md](proposal.md).

1. **Session loopback credentials:** now decision 26. Correction from the review: NanoCore mints one credential per route family and delivers them in `session.open`, so NanoCore knows every value it must check. Its first statement, that on a NanoCore restart the values are gone and the binding is not adoptable, is withdrawn by derivation 30.
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
7. **The literal credential check runs in the NanoHost scan over exact staged blob bytes.** NanoCore supplies the check values in memory with each collection command: Vault-resolved runtime-env values and the binding's loopback credentials. The values are never persisted. (Corrected by derivations 29 and 30: runtime-env values stay raw in the command, and the loopback credentials are carried and checked as persisted digests.)
   - **On a hit.** The collection fails with a typed rejection, that scan's private objects are deleted, and the head does not advance.
   - **Other checks.** The Harness keeps its assistant-text and diagnostic checks.
8. **The multi-runtime image:** now decision 27.
9. **The snapshot chain's guarantee is contiguity of captured states.** A state that exists only between two scans is not observed, and an `unstable` capture is flagged. Review candidates stay Core's: a candidate is computed from Core's accepted base, the last applied or origin state, to the current head, not from one per-Turn link. A rejected candidate does not advance the accepted base.
10. **NanoHost runs Git only against its private store.** The data-boundary prohibition is amended narrowly: a pinned Git with its own `GIT_DIR` and the retained volume as work tree. No worker-controlled configuration, hooks, attributes, filters, or drivers apply, and blobs are hashed byte-exact without filters. Untracked ignored paths are excluded, as today.
11. **Repository push under decision 24.** The pending binding is the exact push intent: source ref, commit, target branch, and linkage.
    - **Human mode.** On a grant of a worker's `repository_push` call, the Gateway runs the Git owner's host-side push for that exact intent inside the approval response command, with every existing barrier: host commit, review linkage, current Vault, target, and the unknown-outcome rule with no retry. A person's App API host push follows derivation 16.
    - **Automatic mode.** The push executes in the same call.
    - **Removed.** The separate `repository_push_execute` tool.
12. **Deferred execution authorization.** Execution after the originating Turn ended re-evaluates current Workspace membership and Agent authority, the Thread's current supply for that server and tool, current credentials and policy, and the current schema. A supply that has dropped the tool gives `denied-not-executed`. Execution runs inside the owner of the response command. After a restart, a claimed but unfinished execution is `outcome-unknown` and is never executed again. No background runner is added.
13. **Declared runtime-env credentials.** They are session-static inside a resident binding. A changed declaration or value gives a successor AgentSession at the next Turn, and a revocation interrupts and closes the binding at once.

**Derivations from the impact maps (2026-09-30).** The five specification impact maps under `temp/comm-redesign/reports/` left questions open that no accepted decision settles. The primary settles the following as implementation of the accepted decisions. Each stays open to the M3 and M4 reviewers:
14. **One pending-request owner.** A new workspace record owns both kinds of pending request: its Thread, raising Turn, requester, responsible user, state, resolution, the captured call binding for an approval that governs a call, the claim and disposition, and the delivery association. No existing record can hold the full arguments additively. It is the source of the Approval status, which replaces the reload derivation from Items.
15. **Where decisions and answers are written.** A Thread has one non-terminal Turn, so a delivering Turn cannot exist while another is active. The decision or answer is durable in the owner at response time, and its Item is written on the delivering Turn as input, recording who decided and when; it is never back-filled onto the raising Turn. An outcome is ready only when final: an answer, a denial, an ending, or a grant whose execution disposition is recorded. A Turn admitted for any cause freezes the ready outcomes whose requester is its executor and keeps its own trigger; an outcome-initiated Turn carries `approval-resolution` or `user-input`. Admission is attempted when an outcome becomes ready on an idle Thread, at every Turn's terminal barrier except that of an outcome-initiated worker Turn refused before native submission, and at boot. Delivery is proved at each executor's own boundary, and only a worker delivery waits for worker capacity. An outcome's Items are written once, on the first Turn that freezes it for delivery, and a later attempt after a refusal references them. An outcome that no requester can receive, because its Thread is archived or its Agent lost authority, is closed out in the detecting command when the Thread is idle, or at the active Turn's terminal barrier, and archive refuses until the Thread is idle when closeout is required: its Items are written on a completed Core-local Turn, never on the raising Turn or another run's Turn, before the archived status for an archive, which keeps the engineer's rule that a void request produces an Item stating the handling and reason and admits no Turn after archive. (Corrected after the M3 review rounds through round five.)
16. **Non-agent requesters.** The App API host push, whose requester is a person or an external coordinator, uses the same owner: its request Turn completes after recording the request, a Core-local delivering Turn records the decision without running an agent, and the caller then runs the existing host execute command, so the public Skill operations stay. Only an agent's captured call is executed by the gateway on a grant. (Corrected while amending the Git owner.) Chat clarification becomes a pending user-input request whose answer starts a new Assistant Turn; the current same-Turn answer path works only in the simulator.
17. **What is removed from the protocol.** Every producer of `awaiting_human` and `humanGate` moves to the pending owner, so both are removed, with AgentSession `suspended` and StopReason `ask_user`, which only the human-gate path produced. The reload-time approval derivation from Items and the boot-reconciliation denial are deleted in the same change. Under Intent Revision 4 no upgrade migration exists. (Revised by Intent Revision 4.)
18. **Approval statuses.** `denied` for an approver's refusal, `withdrawn` for withdrawal by the responsible user (or later the agent), and `expired` for any invalidating event. `superseded` stays reserved without a producer. The per-Thread bound is 16 outstanding requests, and a request over it fails `request_limit_reached` before it is recorded.
19. **`openkit-work` is supplied to every worker AgentSession**, like `openkit-generative`, and needs no manifest selection. Human-mode repository push is one `repository_push` tool, and `repository_push_request_approval` and `repository_push_execute` are removed.
20. **Lifecycle details:**
    - The session loopback credentials are two, one per route family, and Integration drains in-flight requests at the Turn barrier within a bounded wait.
    - The raw native resume reference is kept in retained Sandbox storage outside the disposable control root, and `session.open` carries its locator and digest.
    - A binding that never had a native conversation, the first binding of a Thread or an explicit runtime switch, starts a new one. A binding that expects one and finds its reference missing, corrupt, or mismatched fails explicitly, and the user continues in a new Thread; absence is never permission to start fresh.
    - There is no upgrade classification of native conversations, by Intent Revision 4; a missing expected reference is always a resume failure.
    - Each Harness keeps one active Turn in this change. The scale owner's concurrent Turns across bindings stay accepted and unimplemented.
    - No idle timer is added.
21. **The first snapshot link.** A work volume's chain starts from Core's accepted base for that work slot, the materialized or last applied state; when it is unknown, collection returns `recovery_required`.
22. **Goal operations.** Goal entry, planning with its question Gate, step, and steering reach removed mechanisms and return unavailable. Pause, resume, and reads stay unless the code shows that they reach one.
23. **Task projection.** A Task shows running, waiting, or settled with its last Turn's outcome, and a retry is a new Turn on the same Thread.

**Derivations for the M4 amendments (2026-09-30).** The impact maps left further questions to the writers; the primary settles them as implementation of the accepted decisions, open to the M4 reviewers:
24. **Lifecycle details.** The loopback credentials are two, per decision 26. Integration drains in-flight loopback requests at the Turn barrier within a bounded wait of 10 seconds, after which remaining requests are cut and their results refused. `session.open` carries `resume: { locator, digest } | null`, and Core stores the locator and the digest; the raw reference stays in retained Sandbox storage. Adoption after a transport loss or a NanoCore restart follows derivation 30 (corrected: the non-adoptability after a NanoCore restart that this derivation first stated is withdrawn). The setup-change replacement boundary is the AgentSession: a change the live binding cannot apply gives a successor AgentSession that resumes natively. Each adapter declares whether it re-lists tools at Turn start, and its slice establishes the answer by probe; no spec invents it. The Goal predicates in the envelope and scale specifications stay verbatim as the readable contract for retained records, and new execution does not use them.
25. **No upgrade of open executions.** Withdrawn by Intent Revision 4: a deployment of this version starts from a new data root, so no earlier binding, Turn, or Gate exists to drain, adopt, or close.
26. **Snapshot chain details.** A link's `head` is the tree object of the second scan in NanoHost's private store, recorded with the worktree's `HEAD` commit as context, whether or not the tree is dirty; an unstable link has the same identity with `unstable=true`. (Corrected after the second collection review: a Git tree does not record full permission modes, so a captured snapshot reference is the pair of that tree and the private-store blob of the snapshot's canonical full-permission manifest, and every comparison, retention, and replay uses the pair. The manifest records every tree entry recursively, directories and symbolic links included, with each entry's own permission bits read without following a link; an empty directory is not captured, as in Git. A `no_new_head` result still reports whether the two scans differed, and an unstable one is recorded as a link from the previous head to itself.) The two scans of decision 19 are the whole procedure, with no further retries. The link is capture provenance, and review follows derivation 29 (corrected after the M4 collection review, because the snapshot-chain decision rejects per-link review candidates). One scan covers Git and non-Git trees on the volume under the same rules, with no separate filesystem collector. The literal credential check covers every added or changed blob; a deletion carries no bytes. Ignored paths follow the current candidate-path rules and stay out of the diff. The collection command carries the work slot. The chain's failure is the one `recovery_required` code, distinguished by a cause field, beside the conflicting-review result, which keeps its meaning. Restart of a committed link replays that link exactly, and the next collection scans from its head. NanoHost keeps the private index and object store beside the persistent volume, outside the bind-mounted worktree and outside the worker `.git`, surviving NanoHost restart and epoch replacement; it is not canonical storage, and it retains the objects of Core's accepted base and of the current head until Core names a later head or base in a collection command.
27. **Image and adapter details.** The combined image id is `worker-runtimes`, named on the existing pattern for its registry name, tag, and Dockerfile target. The catalog replaces singular `runtime` with the runtime set `runtimes`, and the OCI label follows the existing label's name in the plural. Each binding has its own runtime process in this change, DeepSeek included, until shared-host isolation is proved. Runtime version pins, package names, and native fields are established by the adapter slices from probes and recorded in the image's version manifest; the specifications name the rule, not guessed values, and cite the proposal's examined versions only as evidence. The Codex-plus-Pi dogfood image stays backlog.
28. **Sweep details.** `Turn.humanGate` is removed entirely, including the `humanGate=null` assignment on Core-local follow-up Turns. NanoCore keeps its host-side process-group supervisor for stdio MCP children under the SDK v2.
29. **Collection corrections from the M4 collection review.**
    - **Review candidate.** A link records its base, the previous head, its head, `unstable`, and its credential-check result; it is capture provenance and carries no patch Core applies. The review candidate is one immutable patch from Core's accepted base for the work slot, as recorded when the candidate is staged, to the link's head. Review display, digest and length verification, conflict preflight, and apply all bind to that candidate and its base. Several reviews may be pending on one work slot, and each is decided on its own; accepting one does not change another's decision, and applying a later candidate after an earlier one moved the accepted base conflicts under the existing conflict result.
    - **Carriage.** Collection is a NanoHost effect pair `workspace.collect` beside the existing pairs, a twelfth pair that the NanoHost runtime and transport owner pins. The command is a bounded JSON poll result carrying the request id, work slot, collection id, accepted base, previous head, and the check values; the runtime-env check values are a second bounded exception, beside `runtimeEnvironment`, to the prohibition on raw credentials in NanoHost commands (narrowed by derivation 30, under which the loopback credentials travel only as digests), held in NanoHost memory only for the scan and never persisted or logged. The result travels on the existing file-data stream reservation, which it joins as a fourth user: the candidate bytes as `application/octet-stream` with exact metadata headers for the head, previous head, accepted base, `unstable`, digest, and length, or `application/json` for a scan with no new head, an empty candidate, a credential hit, or a typed failure. NanoCore returns `204` once it owns verified request-private staging, and only then records the link and advances the cursor. Capture emptiness and candidate emptiness are independent (corrected after the second collection review): a changed capture whose candidate against the accepted base is empty returns an `empty` JSON result carrying its snapshot references, and NanoCore records that link and advances the cursor without staging a review; `no_new_head` means the complete captured snapshot equals the previous one. The scan is read-only on the volume, so a lost result leaves the effect unknown and a later attempt is a new request from the same previous head; objects of an unrecorded attempt are pruned by the next recorded link.
    - **Check values across a NanoCore restart.** Runtime-env values are session-static and are held by NanoCore in memory for the binding's life. After a NanoCore restart they are re-resolved at the exact Vault material version recorded by the binding's injection evidence; when that version cannot be resolved, collection returns `recovery_required` with cause `check_values_unavailable`, stages no review, and does not advance the cursor, and it never substitutes a current value, skips a value, or persists one. The loopback credentials are checked by digest under derivation 30, so a restart does not make them unavailable.
    - **Per-Turn exports.** A per-Turn `file.export` starts after NanoCore accepts that Turn's `final_status`, which the worker-control owner defines as sealing the Turn's transcript, provenance, and artifact output; it does not wait for process-group absence. Process and Harness termination proof stays on operations that end the Harness or the Sandbox. The existing no-follow, size, digest, staging, optional-absence, failure, and no-replay rules are unchanged, and a file that changes during export fails as drift.
    - **Empty collection and permissions.** An empty collection has no content, path, file-kind, deletion, or supported permission delta. The scan records each entry's full permission mode in the snapshot's canonical manifest blob, which derivation 26's corrected snapshot pair binds to the tree, so a byte-identical `0644` to `0600` change yields a `mode_changed` candidate for review and is never applied automatically.
    - **Recovery and reuse.** After a transport loss or a NanoCore restart, `awaiting-reconnect` and exact adoption keep their safeguards under derivation 30. Sequential reuse by the same binding requires completed collection, exact lineage, safe Turn-slot hygiene, and current authority; a surviving background writer and an `unstable` link do not by themselves require worktree or binding replacement.
30. **NanoCore restart adopts the exact surviving binding (correction, 2026-09-30).** Derivation 24 first said a binding is not adoptable after a NanoCore restart, because the loopback credential values would exist only in the stopped NanoCore's memory. No accepted decision says that, and it contradicts the accepted NanoHost restart contract (Required Scenario 1 of the NanoHost runtime and transport specification, and its rule that a NanoCore restart does not tear down healthy local execution) and Core's runtime model, which permits adoption of the exact surviving execution under an accepted proof contract. It also contradicts decision 26's reason of not affecting a worker that is working, since closing every binding on restart stops the runtime and its background work. The statement is withdrawn:
    - A NanoCore restart, like a transport loss, may adopt the exact surviving Sandbox, Harness, runtime host, AgentSession binding, native conversation, Turn, lease, and sequence under the existing continuity and NanoHost proof contracts. The active Turn's route bindings are rebuilt from their lease-owned hashes as the NanoHost owner already defines; Integration keeps the loopback credentials, so the resident runtime is untouched.
    - NanoCore persists only the SHA-256 digests of the two loopback credentials with the binding, as it does for route tokens, and retains no raw value after the `session.open` dispatch. The collection command carries those digests, not raw values. The NanoHost scan detects a loopback credential by computing the SHA-256 of every 43-byte window of the credential alphabet in each added or changed blob and comparing it with the digests; a match fails the collection exactly as a literal hit does. This is exact byte equality for fixed-length random values, and it keeps the literal-check criterion of derivation 7 across a restart.
    - Runtime-env values keep derivation 29's rule, because they may be low-entropy and a persisted digest of them could be brute-forced: raw values in the command, re-resolved at the exact recorded Vault material version after a restart, otherwise `check_values_unavailable`.
    - A binding that cannot be proved exactly after either event is not adopted; it is closed or fenced as the continuity owner defines, and a successor resumes the native conversation.
31. **The resume locator (completion, 2026-09-30).** The owners said that Core stores the resume locator and the digest but not what the locator is or which record keeps it, and runtime-binding rows are deleted at `session.close`. The locator is the `agentSessionId` of the AgentSession whose binding proved a ready native handle, so no wire field is added. When a binding reports ready, its Harness has stored the adapter's restricted handle in retained Sandbox storage under that id, and `nativeHandleDigest` is the SHA-256 of exactly those bytes. Core records the digest on the AgentSession record when it accepts the proof and keeps it after close. A successor's `resume` is the pair of the predecessor it succeeds; the Harness reads only that reference and requires the carried digest. The Persistent Worker Volumes owner lost its older fallback that created a fresh native execution from Core context when exact resume was unavailable. Pi reviewed this completion and accepted it with those two corrections.

**Owners added by the review:**
- [Git write workflow](../../specs/20260704-git_write_workflow.md);
- [internal agent resource integration](../../specs/20260909-internal_agent_resource_integration.md), with human attention's internal branch;
- [worker credential access declarations](../../specs/20260709-worker_credential_access_declarations.md);
- [runtime scheduling scale](../../specs/20260703-runtime_scheduling_scale.md), for concurrent active Turns across distinct AgentSessions, which it already accepts but which is not implemented;
- the [pending-requests specification](../../specs/20260930-pending_requests.md), which supersedes the [historical Delayed User Input Draft](../../specs/superseded/20260921-delayed_user_input.md).

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
- **Worker Gates still open at upgrade are closed honestly.** They are marked not executed, with an upgrade reason, and their history stays readable. Old Approvals store only an argument digest, so they cannot move to decision 24. (Withdrawn by Intent Revision 4: no earlier-version data is carried.)
- **Still deferred:** the knowledge tool family and external user MCP clients.
- **Deferred:**
  - cross-mode leaf rules (M4);
  - general occurrence identity (M6);
  - external user MCP clients (M7);
  - GitHub identity, repository binding, and commit transport (G1 to G3);
  - agent approvers;
  - resident tool refresh through notifications;
  - native MCP Tasks in runtime clients.

## Intent Revision 8 — 2026-10-01

Source: the engineer's messages of 2026-10-01, translated from Chinese.

**Live test and dogfooding.** The final live test runs on the A2 staging host when the work reaches a suitable stage. The primary acts only as coordinator, like OpenKit's Goal coordinator, and assigns defects to dispatched agents. Usage data on A2 (conversations, Tasks and similar records) is deleted while accounts, secrets and configuration are kept, and the host's backups are removed because it is a test server. The primary then dogfoods the deployed platform with the latest Skill and CLI: it works open GitHub issues in Task mode, submits and merges the resulting pull requests, and keeps testing until the release is deployable. No handoff file is written at the final stage. The peer-read design stays as accepted.

**Dispatch routing.** The Consultant role runs on Grok 4.7 at high effort, on Pi with gpt-6-astra at high effort, or both. Builders, testers, reviewers and other job workers run as Codex CLI on gpt-6.1-sol at high effort in herdr. This supersedes the routing in Intent Revision 5. The engineer warned that GPT-6 family models tend to over-engineer and over-defend, so the primary checks each finding and output against an owner predicate, whether the actor is user code inside the Sandbox, and whether the fix adds machinery.

## Intent Revision 9 — 2026-10-01

Source: the engineer's messages of 2026-10-01 after returning, translated from Chinese.

**Priority.** The worker runtimes are external and evolve fast. The runtime integration, and even NanoHost as a whole, may later be redone, refactored or retired, for example by moving worker dispatch and scheduling to another platform. The first goal now is to run the whole flow end to end, express the product concept completely, and let users start working on the platform. What must hold is that the platform loses no data and records none wrongly, that users can keep using it, and that its function, product logic and stability as a user workbench and control plane are assured. For this change, in-Sandbox runtime behavior therefore gets support boundaries rather than prevention machinery, and strictness goes to data continuity: retained records, schema alignment, collection of worker output, and audit.

**OpenCode native plugins.** The engineer approved narrowing the OpenCode adapter's protected-binding guarantee to a support boundary: native plugins load, a statically detectable replacement still fails before work, and later plugin hook code that rewrites a provider request is user code inside the Sandbox and outside supported supply. The decision record lands with the OpenCode native-configuration slice.

**Publishing.** The engineer pushed main to GitHub at `beba2095` and authorized the primary to push main to origin from now on.

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
5. **M5 onward, implementation.** Implement stage 1 in owner-seam slices through Grok builders and reviewers, with focused tests, and commit each slice. Then implement stage 2, and build the multi-runtime Sandbox image. The slices run in five streams whose write sets are disjoint by package, so the streams proceed in parallel while each stream has one writer at a time:
   - **Stream N, NanoCore with `packages/protocol`, `packages/app-api-schemas`, `packages/core-client`, and `apps/web`.** S1 cuts the Gateway to the MCP SDK v2. N1 adds the pending-request record, its commands, delivery admission, closeout, and canonical-load validation beside the old mechanism. N2 moves every producer onto it: the MCP approval path with execution inside the response command, the single `repository_push` tool, `work_request_input` in the new `openkit-work` server, Chat clarification, and the host push; it deletes the human-gate stop callback, the one-hour expiry, and the later-Turn claim. N3 removes `awaiting_human`, `humanGate`, `suspended`, and `ask_user` from every consumer, adds the Goal unavailable guards and the Task-is-its-Thread projection, and updates Action Center and Web; there is no upgrade cutover. N4 is the NanoCore side of the resident lifecycle: binding capacity, `session.open` with `resume` and the two minted loopback credentials, Integration's per-Turn attribution and barrier drain, the resume locator and digest, persistence of only the loopback credentials' SHA-256 digests, and exact adoption after a transport loss or a NanoCore restart under derivation 30. N5 adds `work_list_peers` and `work_read_peer`. N6 is the NanoCore side of the snapshot chain: the cursor, acceptance of the host scan with the Turn wait, and the review-head split.
   - **Stream W, `packages/worker-shim` and `packages/worker-protocol`.** W1 is the resident Harness seam: a supervised runtime host across `turn.start`, `session.open` with `resume` and the loopback credentials, and removal of bounded-turn, the `human-gate` purpose, and the `ask_user` mapping. W2 is the Codex App Server v2 adapter. W3 is the Pi adapter over the SDK host. W4 and W5, in stage 2, are OpenCode V2 and DeepSeek. W6 removes the in-Sandbox workspace publisher once N6 accepts the host scan.
   - **Stream P, the new `packages/pi-runtime-host`**, the Pi SDK host with `pi-mcp-adapter`, beside W2.
   - **Stream H, `apps/nanohost`**: the `workspace.collect` effect pair and the read-only double scan into a private store, with the literal runtime-env check and the windowed loopback digest check over staged blob bytes.
   - **Stream I, the `worker-runtimes` image**, after W5: the Dockerfile target, the image catalog, the smoke, and the agent manifest templates.
   Cross-stream contracts are fixed by the amended specifications before their consumers start: N4 follows W1's control bodies, and N6 follows H's scan result. A stream's commit leaves the whole repository typechecking; where a removal in one stream breaks another package's compile, the two slices are committed together.
6. **Final milestone.** Write the handoff section here. The handoff state is that every mechanism passes code-level tests for all four runtimes, and the image, configuration, and live-test runbook are ready.

The fresh-context direction check ran on 2026-09-30 and returned Ask Human; the engineer's two answers are decisions 26 and 27, and the corrections are in the derivations above and in the proposal.

M1, M2, and M3 are committed; M3 took six Pi review rounds. S1, the Gateway's move to the MCP SDK v2, is committed after three Grok review rounds. M4 is committed after independent Pi review of each batch to acceptance: sweep in two rounds, pending-request consumers in three, adapters and images in three, lifecycle in three, and collection in four. Next action: start the M5 streams: N-pending in the main checkout, the lifecycle slices W1 and N4 in a separate worktree, H1 in apps/nanohost, and P, the new packages/pi-runtime-host.

State on 2026-10-01 at `a09bb651`, which is pushed to GitHub. Main carries every stage 1 and stage 2 slice:
- W2, W3, W4, W5, N-pending, N-egress and the owner amendments;
- the `worker-runtimes` image (`b47af2b1`);
- the repository gate repair (`6ff7909d`);
- N-env (`6863556a`), and the narrower Codex protected native environment names (`227d9bc0`);
- the exact Zod pin, which fixes the App startup crash that stopped the first A2 deployment (`a9bc2d0b`);
- N5 peer reads (`beba2095`);
- N6 and W6, the NanoCore snapshot chain and the removal of the in-Sandbox publisher (`a09bb651`).

Main could not run its own NanoHost from H1 (`b8be63d1`) until N6. H1's NanoHost polls the `workspace.collect` effect routes, which Core served only from N6, and NanoHost treats any non-204 idle answer as terminal. The A2 round 3 deployment of `a9bc2d0b` reproduced this with a 404 on the first poll. N6 adds a NanoCore regression that reads NanoHost's `EFFECT_PATHS` and polls each route idle.

On `a09bb651` typecheck, lint, OpenAPI generation and validation, the shared package suites, Web, the eight repository gates, the Task mode real-worker runner, the serial worker-shim suite (653 tests) and the App image smoke pass. The NanoCore suite fails only the 82 failures named in `temp/comm-redesign/reports/baseline-nanocore.md`. N6 passed independent review in three rounds, and N5 in two.

A2 runs the `a9bc2d0b` App with the four Agent files pointed at the `worker-runtimes` image, and NanoHost is stopped. Round 4 deploys `a09bb651` after aligning the Core column and the two new Workspace tables; `temp/a2-ops/` holds its briefs and reports.

Open work:
- Pi and OpenCode Native Local Configuration, building in separate worktrees;
- the four-runtime live smoke on A2;
- dogfooding GitHub issue #108 in Task mode on A2;
- small follow-ups: the upstream Gateway `mcp-result-too-large` message lacks the artifacts and data-plane hint, and the adapter README adoption guide.
