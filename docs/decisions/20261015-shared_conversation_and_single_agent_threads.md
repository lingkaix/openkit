---
status: Accepted
date: "2026-10-15"
decider: Engineer
---
# Shared Conversations And Single-Agent Chat Threads

## Decision

On 2026-10-15, the engineer accepted the coordinator's proposal for shared conversations and one agent per Chat Mode Thread. [Work Model](../core/work-model.md), [Chat Mode And Core Assistant](../specs/20260704-chat_mode_assistant.md), and [Thread Visibility And Explicit Sharing](../specs/20260909-thread_visibility_and_sharing.md) are the relevant existing owners. This record preserves the accepted design. The feature work package will amend the owners listed below.

1. Audience and work contract are independent axes. The audience is a private Assistant Timeline, a shared conversation Thread, or a shared work Thread. The work contract is Chat, Task, or Goal Mode. More users change only the audience and create no new mode. A shared conversation is Chat Mode with a Workspace-shared audience.
2. A shared conversation Thread is a Workspace-shared conversation Thread in a team Workspace. Members of a team Workspace can create one directly, without a share snapshot. A personal Workspace cannot add members and cannot provide this shared conversation.
3. The Core Assistant is the only agent in every Chat Mode Thread, private or shared. In a shared conversation, it acts as a Workspace role, not as any member's Personal Assistant. It reads no member's Memory or private Timeline. It offers no administration Tools.
4. Sources follow the Retrieval Kernel R2 query context: Server, Workspace, Actor, and Thread or Turn. The Actor is the member who addressed the Assistant. Knowledge is available. The Memory section is empty.
5. The answer goes to every member of the Thread audience. Source filtering therefore covers the whole current Thread audience, not only the asking member. The Assistant must never disclose a source to another member through the asking member's narrower access.
6. Each Turn's Actor is the member who addressed the Assistant. Tool calls and Task or Goal handoffs use that member's current authority. Another participant's earlier approval or result gives no authority.
7. The Assistant replies only when a member addresses it, not to every human message. One Turn per Thread applies. Simultaneous requests queue.
8. Each shared conversation Thread has its own rolling context window. That window never includes a private Timeline window.
9. A member can share selected private Timeline material into a shared conversation through the existing `thread.share` snapshot. A member can also hand off from a shared conversation to Task or Goal.
10. No Worker or other agent joins a Chat Mode Thread as a participant. Addressing a Worker from a conversation requires a Task handoff with confirmation. The handoff creates a linked Task execution Thread. The conversation shows its state and result through ordinary Items. A multi-agent outcome uses Goal Mode under the Coordinator and an approved Plan. Talking to an existing Worker occurs only in the execution Thread that owns its AgentSession. Task and Goal execution Threads are already Workspace-shared. Several members can therefore work with one Worker there.
11. Implementation waits until after v0.1.0 and after the private Assistant Timeline lands. Retrieval Kernel R2 and Chat Mode work must not block this design. R2 already limits Memory recall to the private Timeline and assigns traces to the querying Thread or Turn.

## Reason

Earlier on 2026-10-15, the engineer confirmed one private Assistant Timeline per (User, Workspace), with no user-created private chat Threads. The engineer also confirmed one durable rolling context window for every NanoCore internal role and that a personal Workspace cannot add members.

The engineer then asked whether several users in one Workspace could talk together with the agent in Chat Mode. The engineer also asked whether several agents could join that conversation and whether this would blur Chat, Task, and Goal. The coordinator proposed the design recorded above. The engineer accepted it with this ruling, quoted verbatim:

> 我同意我们这个对于 Chat Mode 的再次澄清的设计。同时，我也同意在 Chat Mode 里面每一个 thread，也就是每一个对话，只有一个 agent，也就是 core assistant参与。

English translation:

> I agree with this re-clarified design for Chat Mode. I also agree that in Chat Mode every Thread, that is, every conversation, has only one agent participating, namely the Core Assistant.

Separating audience from work contract lets members talk together without creating a new mode. Keeping one agent in a conversation preserves the existing distinction between conversation and execution. Private context and personal Memory stay private. Current Actor authority controls actions, while the whole output audience controls source disclosure.

The existing Work Model places parallel work in linked execution Threads and excludes interleaved work from several agents in one conversation. Choosing an existing Worker continues only the Thread that owns its AgentSession. Choosing new Worker work enters Task Mode. The visibility owner already allows a shared conversational continuation to address the Assistant after explicit sharing. It fixes the audience as private or Workspace-shared at creation. It excludes restricted information before generation when another user's shared follow-up asks for more. The accepted design extends these boundaries to direct shared conversation creation.

## Rejected Alternatives

- A new mode for several human participants. The accepted design separates the audience from the work contract.
- Several agents participating directly in one Chat Mode Thread. Linked Task execution Threads and Goal Mode preserve agent responsibility and work history.
- A shared Personal Assistant that reads a member's private context or offers administration Tools. The shared Assistant acts as a Workspace role with no personal Memory or private Timeline input.
- Filtering sources only for the asking member, or reusing another participant's authority. Shared output requires admission for the whole audience. Actions require the current Actor's authority.
- Requiring a private share snapshot before every shared conversation. Team Workspace members can create shared conversations directly.
- Implementing shared conversations in v0.1.0 or making Retrieval Kernel R2 wait for them. The private Assistant Timeline lands first, and implementation follows after v0.1.0.

## Revisit When

Revisit when: a measured product need requires an agent other than the Core Assistant to speak directly in a conversation Thread.

## Affected Owners

Amend these owners when the feature work package starts:

- [Work Model](../core/work-model.md): audience and mode, one agent per Chat Mode Thread, and linked execution Threads.
- [Chat Mode And Core Assistant](../specs/20260704-chat_mode_assistant.md): the shared Workspace role, sources, authority, triggering, concurrency, context, and handoffs.
- [Thread Visibility And Explicit Sharing](../specs/20260909-thread_visibility_and_sharing.md): direct shared conversation creation in team Workspaces, audience, and snapshot sharing.
- [Unified Conversation Composer](../specs/20260831-unified_conversation_composer.md): shared conversation creation, addressing the Assistant, and Worker handoffs.
- [Core Permissions](../core/permissions.md): the whole-audience output rule and current Actor authority.
