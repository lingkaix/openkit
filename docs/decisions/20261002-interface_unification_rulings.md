---
status: Accepted
date: "2026-10-02"
decider: Engineer, on a Consultant-reviewed proposal
---
# Interface Unification Rulings

## Decision

The engineer ruled on the interface unification proposal on 2026-10-02.

1. The operation is the interface primitive. The Web UI's API, a remote MCP endpoint, internal agent tools, and worker MCP tools perform the same operations and differ only in the acting identity and its permissions. No registry, message bus, generic approval entity, inbox, or universal resource object is added for unification.
2. The parallel operation definitions are unified onto that primitive as far as possible in the current redesign and reimplementation. The concrete single-definition architecture is decided separately.
3. NanoCore serves a remote MCP endpoint for users' own agent clients. Where clients do not yet support a newer standard mechanism, such as loading Skills over MCP, the endpoint offers a plain MCP call instead, for example one that returns the manual or instructions, and adopts the standard mechanism once protocol, SDKs, and clients support it well.
4. An external agent that presents a user's own credential acts as that user for authorization, including approval responses. OpenKit adds no mechanical agent-versus-human check; the agent-facing instructions in tools, guidance, and the manual tell the external agent to ask the user for each approval.
5. Every agent, whether a user's external agent, a NanoCore internal agent, or a worker, is intended to receive its own identity and permissions, resolved by the NGAC Policy Kernel with fine-grained policy over resources, users, and agents. This is not yet designed in detail; current architecture leaves room for it.
6. When an agent raises a Task in conversation, the person approves or rejects the exact proposal. A note that adds or changes a requirement is written into the Task's admitted input before the start operation runs, and the started work cites it; a note that does not change the effect stays on the decision record and is not a requirement; the decision is delivered to the requester's Thread. Tool approvals and reviews keep their current responses.
7. The remote MCP endpoint is built first. Once it is verified feasible and functionally covers the user-facing Skill and bundled CLI, both are retired and deleted. The operator skill stays.
8. Knowledge retrieval and source-linked proposal are shared by every role and surface, including workers mid-run. After the remote endpoint lands, the Knowledge Manager drafts proposals when a Task finishes and when any participant proposes; capture is its responsibility and is not routed through the Assistant. A person reviews the proposals under the knowledge owner's review.
9. On the Goal board, users may create cards and edit description, priority, and cancellation, but not observed execution status. A permitted user edit is the same operation the Coordinator uses with a different actor, and the Coordinator recognizes it by rereading Goal state on its next admitted Turn. This is input to the Goal redesign, which must share the same primitives, mechanisms, and interface.

Foundation owns rules 1, 4, and 5 and the forward-looking principle behind rule 3. The remote MCP interface, operation definition, Pending Requests, Chat Mode Assistant, and knowledge owners take the remaining rules as their amendments land; the Goal Mode Coordination specification stays frozen until the engineer activates the Goal redesign.

## Reason

Translated from Chinese. The engineer agreed with the research findings and with the proposal's core conclusion that unification needs no registry, bus, approval entity, inbox, or resource object, and that operations are the primitive: different interfaces perform the same operations with different identities and permissions, which matches the intended direction of development. OpenKit built its Policy Kernel on the NGAC model; it is not widely used yet, and permission resolution through it will later be added to every operation.

On the parallel definitions: "there may have been a need for this, but in this redesign and reimplementation we want them unified as far as possible, using one operation primitive as the one interface."

On standards support: some newly published standards are not yet supported by clients, so a fallback that may cost some performance is used until protocol, SDKs, and clients support the standard well. "Every component and technology stack in an agent-native system is evolving quickly, so our work must be forward-looking."

On the external agent: with a personal token, the external agent has the same permissions as the user. "It is an agent, but it is also acting on the user's authorization, and we cannot fully separate the two." If a user directs approvals through their external agent, the approval interface must be open to that agent, so instruction text that requires the agent to ask the user for approval is enough, and no mechanism is built for it. This raised a product principle: OpenKit should assign independent identities and permissions to agents, which is why the Policy Kernel exists. Those parts are not landed or designed in detail in early versions, but the system architecture must follow the principle and leave enough room and mechanism for the future policy model.

On retirement: implement the new MCP first, and once it is verified feasible and functionally covers the current Skill plus CLI, retire and delete them. On the Goal board: the engineer agreed with the design and idea, asked for it to be written down, and named the Goal redesign as the next discussion, with the aim of sharing the same primitives, mechanisms, and interface.

The proposal was written by the primary agent from four research reports and two Consultant reviews. Its framing of rules 1, 6, 8, and 9 originated in the agent's proposal and was accepted by the engineer; rules 2, 3, 4, 5, and 7 state the engineer's own refinements.

Source: change record 202610020440000000-interface_unification.

## Rejected Alternatives

- Wait for MCP progressive tool loading and Skills over MCP support before offering a remote endpoint. Rejected in favor of plain fallbacks now.
- Give the external agent a separate non-human credential now, so that it cannot answer approvals. Not chosen for the current system; independent agent identities are the intended future direction under rule 5.
- Add a mechanical check that distinguishes an agent from the human who holds the credential. Rejected because the two cannot be fully separated; instructions carry the requirement.
- Mark operations as human-reserved, or refuse every token actor for reserved decisions. Rejected during Consultant review because a per-user token is the human user, so this would also refuse the person and would not stop an agent holding the person's token.
- Record other actors' changes as Items on the owning agent's Thread. Rejected because model history drops such Items; agents reread current state instead.
- Keep each surface's own operation definitions and only forbid a new surface from shipping its own list. Superseded by rule 2.
- Retire the Skill and CLI as soon as a connection probe passes. Rejected in favor of retiring them once the remote MCP is verified to cover them.

## Revisit When

- The Policy Kernel's per-operation resolution or independent agent identities are designed, which reopens rule 4.
- The target clients support Skills over MCP or progressive tool loading, which retires the rule 3 fallback for those clients.
- An operation cannot be expressed once for two surfaces without changing its meaning, which bounds rule 2.
- The Goal redesign is activated, which takes rule 9 as input rather than as settled design.

## Affected Owners

- docs/core/foundation.md
- docs/core/identity.md
- docs/core/permissions.md
- docs/specs/20260713-openkit_agent_skill_interface.md
- docs/specs/20260704-app_api_openapi_projection.md
- docs/specs/20260930-pending_requests.md
- docs/specs/20260704-chat_mode_assistant.md
- docs/core/knowledge.md
- docs/specs/20260704-knowledge_manager_internal_agent_runtime.md
- docs/specs/20260704-goal_mode_coordination.md
