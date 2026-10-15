---
status: Accepted
date: "2026-10-15"
decider: Engineer
---
# Private Assistant Timeline And Durable Rolling Context

## Decision

Each `(User, Workspace)` has exactly one private Assistant Timeline. Users cannot create private chat Threads. A personal Workspace is an ordinary `personal` Workspace with Task, Goal, Artifact, and Sandbox capability; it cannot add members. Existing Quick Chat Workspaces move one way to `personal`, retaining their Threads and Knowledge. The Quick Chat kind and capability guards are removed. The administration entry moves to the personal Workspace.

All NanoCore internal model-using roles use one shared durable rolling-context mechanism in place of the unimplemented Gateway compactor. Private Timelines and later shared conversations keep separate windows and current source/audience authority. This does not change Worker-native compaction or create a per-user runtime process.

Chat has no extra result-card mechanism and no proactive Task/Goal completion response. The Assistant dispatches requested work. The User sees it in the Thread list and asks the Assistant when a status or result is wanted. Memory is User-scoped and follows the User. Workspace and Server personalization remains Knowledge.

Shared Chat implementation remains after `v0.1.0`, with the Core Assistant as the only agent, under [Shared Conversations And Single-Agent Chat Threads](20261015-shared_conversation_and_single_agent_threads.md).

## Reason

Source: core-experience change record 202610140256550000-v0_1_0_core_experience, Engineer Rulings 1, 2, 5, 12, and 13. Rulings 1, 2, and 5 were given on 2026-10-14. Rulings 12 and 13 were confirmed on 2026-10-15. The P11 dispatch explicitly authorizes these owner amendments. The change record preserves source wording and does not supply design authority.

The engineer accepted an ordinary personal Workspace instead of a special lightweight Workspace. The engineer rejected an additional result-card mechanism because requested work and status already have existing owners. Confirmation 12 explicitly settled Timeline cardinality, the shared durable rolling context, and the prohibition on members in personal Workspaces.

## Rejected Alternatives

- User-created private chat Threads break the single private Timeline boundary.
- Keeping the Quick Chat capability restrictions prevents ordinary personal Task and Goal work.
- A Gateway compactor as an internal-role dependency preserves an unimplemented mechanism that the engineer replaced.
- Separate completion cards and proactive replies add the mechanism that ruling 2 rejected.
- Workspace- or Server-scoped Memory duplicates their Knowledge ownership.

## Revisit When

Revisit when the engineer changes Timeline cardinality, admits members to a personal Workspace, requires proactive conversation, or changes the internal-context mechanism. Revisit scoped Memory if Knowledge cannot serve a named Workspace personalization need.

## Affected Owners

- [Chat Mode And Core Assistant](../specs/20260704-chat_mode_assistant.md)
- [Context Management](../specs/20260902-agent_runtime_context_compaction.md)
- [Internal Agent Runtime](../specs/20260813-internal_agent_runtime.md)
- [Personal Workspace](../specs/20260709-quick_chat_workspace.md)
- [Work Model](../core/work-model.md)
- [Thread Visibility](../specs/20260909-thread_visibility_and_sharing.md)
