---
type: change-plan
status: in-progress
date: "2026-10-02"
---
# Interface Unification

## Intent Revision 1 — 2026-10-02

This plan records a design discussion between the engineer and the primary agent (Claude Code, Opus) held on 2026-10-02. The engineer's verbatim statements are kept uncommitted in `temp/interface-unification/`: the opening question in `context.md`, the agreement with the six working hypotheses in `engineer-r1.md`, and the rulings on proposal revision 2 in `engineer-r2.md`. The rationale is in [proposal.md](proposal.md).

**The engineer's outcome.** Unify the interfaces between users and agents, between agents and system functions, and between agents, under one design mechanism and interface. The agent-native tool definition and call is the system's interface primitive: for a person the interface is the screen and the API behind it, and for an agent it is the tools it calls. Chat, Task, and Goal modes share the underlying mechanisms. The engineer's translated words: "in this redesign and reimplementation, unify them as far as possible onto one operation primitive as the one interface", and every component and technology in an agent-native system evolves fast, so the work must be forward-looking.

**Acceptance observations.**
- A user adds the OpenKit instance as a remote MCP server in their own agent client, authenticates, and can perform every operation the user-facing Skill and bundled CLI perform today, with the interface version following the instance.
- The internal Assistant uses the same operations through a tool loop, including a Task proposal that the person approves or rejects with a note.
- Knowledge retrieval and proposal are available in every tool set, including worker MCP, and the Knowledge Manager drafts proposals when a Task finishes.
- After the remote MCP is verified to cover the Skill and CLI, the user-facing Skill and bundled CLI are deleted; the operator skill stays.

**Non-negotiables.** Root `AGENTS.md`, including NONNEG-001 data continuity and no compatibility layers for first-party interfaces; the Safety Kernel; the Goal development freeze, which stays until the engineer activates the Goal redesign; DOC-018.

**Exclusions.** The Goal redesign itself, which the engineer will discuss next and which gets its own plan; `docs/product-vision.md`; `docs/changes/202609290900000001-chat_task_stability_handoff/`; the member-role cutover parked under the multi-user owner.

**Effect boundary.** Local code, tests, and documentation; live verification on the disposable A2 staging host under the existing standing authorization; pushing `main`. No other external publication.

## Accepted Decisions

Each item gives the decision, its source, its reason, and when to revisit it. Sources are in `temp/interface-unification/engineer-r2.md` unless stated.

1. **The operation is the primitive, and surfaces differ only in actor and permission.** Every surface, the Web UI's API, a remote MCP endpoint, internal agent tools, and worker MCP tools, performs the same operations. No registry, message bus, generic approval entity, inbox, or universal resource object is added. Reason: the engineer agreed with all eight research findings and with the proposal's core conclusion, and it matches the intended direction of development. Revisit when an operation cannot be expressed once for two surfaces without changing its meaning.
2. **The parallel operation definitions are unified as far as possible.** The engineer accepted that the four or five existing definitions may have had reasons, but wants them unified onto the one primitive in this redesign. This supersedes revision 2's narrower rule that only forbade a new surface from shipping its own list. The concrete single-definition architecture is not decided yet; see Open Questions. Revisit when a definition site has a demonstrated need that the shared definition cannot carry.
3. **Remote MCP now, with plain fallbacks for unsupported standards.** NanoCore serves a remote MCP endpoint with search, describe, and one call over the existing operations. Where clients do not yet support a newer MCP feature, such as dynamic Skill loading, the server offers a plain MCP call instead (for example a manual or instruction read), accepting some cost, and switches to the standard method once protocol, SDKs, and clients support it well. Reason: lower installation friction and lockstep versioning, and the engineer's forward-looking principle. Revisit when the target clients support Skills Over MCP or progressive tool loading.
4. **D1: an external agent holding a user's token acts as that user.** The approval interface stays open to it, because a user may direct approvals through their own agent. The only control is instruction text in the MCP tools, guidance, and manual that tells the external agent to ask the user for each approval. No mechanical agent-versus-human check is added. Reason, translated: the external agent is an agent but acts on the user's authorization, and the two cannot be fully separated. Revisit when OpenKit issues agents their own credentials (decision 5).
5. **Agents get their own identity and permissions, in the future.** Every agent, whether external, NanoCore-internal, or a worker, should eventually have an independent identity and permissions, resolved by the NGAC Policy Kernel with fine-grained policy over all resources, users, and agents. The engineer called this a product principle; it is not designed or landed yet, but current architecture must follow it and leave room and mechanism for it. Revisit when the Policy Kernel's per-operation resolution is designed.
6. **D2: Task proposal with a note.** When an agent raises a Task in conversation, the person approves or rejects the exact proposal. A note that adds or changes a requirement is written into the Task's admitted input before the start operation runs, and the started work cites it; a note that does not change the effect stays on the decision record; the decision is delivered to the requester's Thread. Tool approvals and reviews keep their current responses. Revisit when a second proposal kind needs the same shape.
7. **D3: build the remote MCP first, then delete the Skill and CLI.** Once the new remote MCP is verified feasible and functionally covers the current user-facing Skill and bundled CLI, both are retired and deleted with no transition period. The operator skill stays. Revisit if a supported client cannot reach the remote MCP.
8. **D4: knowledge capture.** Knowledge retrieve and propose are shared by every role and surface; the Knowledge Manager drafts proposals when a Task finishes and when any participant proposes; a person reviews them; this follows the remote endpoint.
9. **D5: the Goal board, written down for the Goal redesign.** Users may create cards and edit description, priority, and cancellation, but not observed execution status; a permitted user edit is the same operation the Coordinator uses with a different actor, and the Coordinator recognizes it by rereading Goal state on its next admitted Turn. The Goal redesign is the next discussion and must share the same primitives, mechanisms, and interface.

## Owners And Seams

Amendments still to be drafted, after the open questions below are settled where they apply:
- [Foundation](../../core/foundation.md): the agent-native sentence says an agent projection must not make a decision an owner reserves to a human; decision 4 makes an agent holding the human's own credential that human, so the sentence must distinguish an agent acting under its own identity from one holding the human's credential, and decision 5 adds the independent-identity principle.
- [OpenKit Agent Skill Interface](../../specs/20260713-openkit_agent_skill_interface.md): withdraw "No user-facing MCP", name the remote MCP owner, and state the retirement condition; a new remote MCP interface specification owns the endpoint.
- [App API OpenAPI projection](../../specs/20260704-app_api_openapi_projection.md), [Permissions](../../core/permissions.md), [Policy model](../../specs/20260629-openkit_policy_model.md), [Policy enforcement mapping](../../specs/20260703-policy_enforcement_mapping.md) and [Identity](../../core/identity.md), for the single operation definition and the room left for per-operation Policy Kernel resolution and non-human actors.
- [Remote auth credential bootstrap](../../specs/20260704-remote_auth_credential_bootstrap.md), for bearer use by remote MCP clients.
- [Pending Requests](../../specs/20260930-pending_requests.md) and [Chat Mode Assistant](../../specs/20260704-chat_mode_assistant.md), for the Task proposal and the Assistant tool loop.
- The knowledge owners, for retrieve and propose in every tool set and capture on Task completion.
- [Goal Mode Coordination](../../specs/20260704-goal_mode_coordination.md) is frozen; decision 9 is recorded as input to the Goal redesign, not as an amendment.
- [Agent Operator Skill](../../specs/20260910-agent_operator_skill.md) stays.

The primary is the single writer of this bundle and coordinates the owner amendments through writer and verifier agents.

## Open Questions

- The concrete single operation definition: which site becomes the source, what each projection derives and what it adds, and where per-operation Policy Kernel resolution attaches. This is architecture, so the primary presents the design to the engineer before implementation. Research is running (`temp/interface-unification/reports/research-operation-unification.md`).
- The connection probe result with an ordinary user token and a second client (`temp/worktrees/mcp-probe`).
- The seven administration tool names, which break the general internal-tool naming rule while the Chat Mode Assistant specification names them, and whether a retrieval trace makes `knowledge.retrieve` a mutation.

## Working Checkpoint

State on 2026-10-02: the engineer ruled on proposal revision 2. Running: the operation-unification research, the connection probe rerun, and a Goal current-state census for the next discussion (`temp/goal-redesign/`). Next action: when the research returns, design the single operation definition with Consultant scrutiny and present it to the engineer; meanwhile draft the remote MCP interface specification and the Foundation, Skill interface, Pending Requests, and Chat Mode Assistant amendments with the decision record for decisions 1 to 9.
