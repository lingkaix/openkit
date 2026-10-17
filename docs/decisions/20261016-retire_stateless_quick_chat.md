---
status: Accepted
date: "2026-10-16"
decider: Engineer
---
# Retire Stateless Quick Chat

## Decision

Remove `chat.quick` and its standalone request and response schemas without a compatibility shim. All ordinary Assistant requests use `conversation.submit` on the current user's private Timeline. Keep an equivalent one-shot path in the generated CLI and packaged operations Skill. Remove the former operation from OpenAPI, remote MCP, authorizer projections and bundled CLI, and replace its tests with the durable entry's checks. The landing change record must name this removal for the next prerelease notes.

## Reason

The engineer accepted this choice through the L-AK question channel on 2026-10-16: a stateless direct Provider call bypasses the already accepted single private Timeline, and a second entry adds surface without a current need. Web production already uses `conversation.submit`.

## Rejected Alternatives

Keeping the stateless call would preserve the Timeline bypass. Routing a second public operation into Timeline admission would retain another entry and command surface without a demonstrated consumer need. A compatibility alias is excluded by the repository's pre-stable first-party contract policy.

## Revisit When

Revisit only if a concrete consumer needs a different authorized entry that the Timeline command cannot provide, or if the engineer changes the single-Timeline decision.

## Affected Owners

- [Chat Mode And Core Assistant](../specs/20260704-chat_mode_assistant.md).
- [Personal Workspace](../specs/20260709-quick_chat_workspace.md).
- [Internal Agent Resource Integration](../specs/20260909-internal_agent_resource_integration.md).
- [Agent Operator Skill](../specs/20260910-agent_operator_skill.md).
