---
status: Accepted
date: "2026-10-17"
decider: Engineer
---
# Server Knowledge Is Shared Knowledge

## Decision

Server Knowledge is a shared Knowledge base for Workspaces on the same Server. Only User-owned personal information is Memory. Workspace work may query Workspace Knowledge and Server Knowledge when the Server Knowledge owner admits its actor. Retrieval keeps each source's selection, ranking and citation scope separate. Model arguments cannot select another owner or source scope. User Memory never enters shared work.

Worker contributions remain Workspace-only. A user, or the Assistant acting for that user, may explicitly contribute to Server Knowledge. Publication needs current Server maintenance delegation or approval by the Server Knowledge owner. Server maintenance uses explicit requests, their admitted Sources and human changes to the Server notebook. Automatic learning across Workspace Threads is outside v0.1.0.

## Reason And Source

At 11:07Z on 2026-10-17, the engineer corrected the coordinator's description of Server scope. The coordinator supplied the read and contribution boundaries at 11:09Z. This clarifies the existing owner model; it does not move Memory into a shared scope or give a Worker Server write authority.

### Engineer Statement: English Translation

Continue at the current pace. One correction: the Server level is not Memory. It is a Knowledge base, like Workspace Knowledge. Only User-scope personal information is Memory. Its main use is sharing information across Workspaces within the Server scope.

## Rejected Alternatives

- Treating Server Knowledge as Memory would mix personal information with shared facts.
- Letting a model choose a scope would make message text select authority.
- Automatic cross-Workspace learning adds a collection policy that this version does not define.

## Revisit When

Revisit the collection boundary when an accepted owner defines automatic cross-Workspace consolidation and its input admission.

## Affected Owners

- [Knowledge And Personal Memory](../core/knowledge.md)
- [Knowledge Manager Agent](../specs/20260704-knowledge_manager_internal_agent_runtime.md)
- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md)
- [Personal Memory And Knowledge Learning](../specs/20260909-personal_memory_and_knowledge_learning.md)
