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

## Intent Revision 2 — 2026-10-02

The engineer ruled on the single operation definition in three rounds (verbatim in `temp/interface-unification/engineer-r3.md` and `engineer-r4.md`, the last approving draft 3's direction for Consultant review), then on blocking, administrator authority and remote MCP authentication (`engineer-r5.md`, `engineer-r6.md`). The Consultant confirmed the direction with corrections (`temp/interface-unification/reports/consult-operation-definition-d3.md`), applied in draft 4 (`temp/interface-unification/operation-definition-d4.md`), which is the basis for the boundary specification. The rulings and their reasons are recorded in [the operation definition rulings](../../decisions/20261002-operation_definition_rulings.md). Revision 1's acceptance observation that deletes the bundled CLI is replaced: the CLI moves under the operator skill with full coverage through an administrator token.

10. **Unification is mandatory.** One semantic owner per mechanism with derived surfaces, for every later design and implementation. It does not merge distinct authentication, storage, effect, lifecycle or offline host authorities. Revisit when surfaces cannot share one owner without merging such authorities.
11. **One declarative definition table per resource family, an exact typed implementation map and closed trusted resolvers; corrected H2.** This settles the first open question below. Revisit when a definition site has a demonstrated need the table cannot carry.
12. **The CLI stays under the operator skill with full coverage.** It amends decision 7: the user-facing Skill is still retired once the remote MCP covers it; secret-returning operations stay off MCP and the CLI writes them to local secret-safe sinks; with decision 16, an administrator token reaches every operation. Revisit if an operation cannot be offered through the CLI without a separate host procedure.
13. **After launch, operations are only added, deprecated or retired.** Before launch they change freely. Deprecation (a release no longer needs a function or replaced it) and blocking (a deployment cannot support an operation, or its owner or administrator keeps users from it) are different concepts; unsupported is an availability condition its owner reports, and an owner's or administrator's choice is a permission deferred to the Policy Kernel implementation and later user-configurable (`engineer-r5.md`, `engineer-r6.md`). Revisit at the launch boundary.
14. **In-sandbox Codex approves every MCP tool.** The managed configuration sets `default_tools_approval_mode` to approve; remote MCP keeps one `call`. Revisit if Codex changes its approval semantics.
15. **Data-defined operations are reserved** through the Generative Kernel and component owners, with no dynamic source, registry state or execution engine now. Revisit when the Kernel's fixed operation is implemented.
16. **The administrator may perform every operation.** Including other users' resources (deleted-resource recovery, private Threads, approvals, archives) through one rule in the existing authorizer, for the administrator's Web session and bearer alike; attribution stays truthful, per-effect authority objects still exist but the administrator may issue them, and credential limits and the sandbox boundary are unchanged. Reason: the Policy Kernel is not in use, so no second permission model is built, and the product is a small team's shared workbench whose administrator maintains it for non-technical teammates. Recorded in [administrator authority](../../decisions/20261002-administrator_authority.md). Revisit when the Policy Kernel lands.
17. **Remote MCP authentication.** Once the remote MCP endpoint is live, users need a way to authenticate to it over MCP; it is designed and built together with the endpoint (`engineer-r6.md`). Research on the MCP authorization specification and client support runs before the remote MCP interface specification. Revisit when the design is presented.

## Intent Revision 3 — 2026-10-02

The engineer ruled on the remote MCP authentication draft `temp/interface-unification/remote-mcp-auth-d1.md` (verbatim in `temp/interface-unification/engineer-r7.md`). This refines decision 17 without replacing it.

18. **Remote MCP authentication: a static administrator-issued bearer now, browser OAuth designed but not built.** The first release authenticates with an ordinary Token that the administrator issues and the user places in the client's header configuration, with no refresh token, and Token listing and revocation stay with the administrator. d1's browser OAuth design (authorization code with PKCE, client identity through Client ID Metadata Documents, consent backed by the existing login, an ordinary Token bound to the MCP resource with a configurable default lifetime and browser reconnection) is written into Remote Auth as accepted design and is not implemented. Dynamic Client Registration, rotating refresh tokens and an external identity provider are not designed. Recorded in [remote MCP authentication](../../decisions/20261002-remote_mcp_authentication.md). Revisit when a teammate needs a hosted or desktop client without per-user static headers.

## Open Questions

- Settled by decision 11: the concrete single operation definition.
- The connection probe result with an ordinary user token and a second client (`temp/worktrees/mcp-probe`).
- The seven administration tool names, which break the general internal-tool naming rule while the Chat Mode Assistant specification names them, and whether a retrieval trace makes `knowledge.retrieve` a mutation.

## Working Checkpoint

State on 2026-10-02: decisions 1 to 18 are accepted; the decision records are [interface unification](../../decisions/20261002-interface_unification_rulings.md), [operation definition](../../decisions/20261002-operation_definition_rulings.md), [administrator authority](../../decisions/20261002-administrator_authority.md) and [remote MCP static bearer first](../../decisions/20261002-remote_mcp_static_bearer_first.md), which supersedes [remote MCP authentication](../../decisions/20261002-remote_mcp_authentication.md) to record the engineer's reason for deferring browser OAuth. The Codex approval configuration landed in e27bec09, the operation definition specification in 67774045, and the Goal redesign owners in 6e561d55. The projection owners the first slice depends on landed in 6f3ae048, the administrator authority owners in d8931467, and the remote MCP interface specification with the Remote Auth and Skill interface amendments in this change, which also aligns the Operation Definition, Agent Operator Skill and Policy Enforcement Mapping sentences that still named those owners as pending. Next action: implement the first slice (one Generative Kernel read and one replayable local mutation across HTTP and Core Client, remote MCP, worker MCP, the CLI and one administration read) under the landed owners. The Knowledge owners are amended when Knowledge operations migrate.
