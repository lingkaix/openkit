---
status: Accepted
date: "2026-10-17"
decider: Engineer
---
# Agent-Facing Naming

## Decision

[Operation Definition](../specs/20261002-operation_definition.md#names) owns one naming rule for release-owned agent-facing operations and Tools. Canonical IDs are lowercase dotted paths; words within a segment use hyphens. Model names replace dots with underscores only. Operation projections use the operation's actual ID. The Agent Interface's own Tools use the `openkit` namespace; its four Server MCP Tools are `openkit_search`, `openkit_describe`, `openkit_guide` and `openkit_call`. A repository check enforces grammar, projected length at most 40 and uniqueness after also folding hyphens to underscores. The owner documents verified compatibility facts and explicit limits.

## Reason

The engineer required one spelling across Worker MCP, internal Tools and Server MCP because they expose the same system mechanisms. On 2026-10-17, the engineer discussed the rule at approximately 09:47 UTC and 10:10 UTC and accepted the coordinator's concrete proposal at approximately 10:15 UTC. The following original-language quotations and their English translations are included at the engineer's explicit request. The first quotation is the naming excerpt; the separate context-window discussion is outside this decision.

Verbatim naming excerpt, 09:47 UTC:

> 关于 Knowledge Manager 的设计，我大体上同意你的设计，不过我认为有几点需要注意和讨论。第一是接口的命名, 不论是我们通过 MCP Gateway 向 Worker 提供的接口名称，还是 NanoCore 内部的工具名称，还是我们通过 Server 的 MCP 向外部的 Agent 暴露的接口的名称都应该有一个统一的命名规则(从 first principle 出发，我认为这些之所以明明是统一的，是因为他们就是同一套我们系统提供的机制和工具)。我不清楚现行的状况如何，你可以派出一个 Grok worker 来盘点一下。不过，从 common sense 出发，我认为是否可以命名为 [namesoace(only onw word)]_(or ':'?)[action_name], 我们来讨论。

English translation: I broadly agree with the Knowledge Manager design, but we must discuss several points. First, the names exposed through the Worker MCP Gateway, NanoCore internal Tools and Server MCP must follow one rule, because they are the same system mechanisms and Tools. You may send a Grok worker to inventory the present state. Let us discuss a one-word namespace and action form, using an underscore or perhaps a colon.

Verbatim, 10:10 UTC:

> 那我MCP呢四个通用工具是否改为openkit_[action-name], 也就是以 OpenKit 为命名空间，以便和外部 Agent 的当中其他的注册的 MCP 和工具区分呢？ 关于命名方案的话，是否使用规范标识用点号形式转换的时候变成下划线，一个字段内使用破折号作为单词划分符号，你认为这样合理吗？有什么兼容性问题吗？

English translation: Should the four generic MCP Tools become `openkit_[action-name]`, with OpenKit as the namespace so external agents can distinguish them from other registered Tools? Is it reasonable to use dots in canonical IDs, convert dots to underscores for model names and use hyphens between words inside a segment? What compatibility problems does that have?

Verbatim, 10:15 UTC:

> 没有问题了，就这么执行。记得把你对于兼容性方面的考虑的细节和限制也写进相关的规格文档。

English translation: There is no further issue. Proceed with this. Include the details and limits of the compatibility considerations in the relevant specifications.

The accepted coordinator proposal is the exact rule in Decision. The compatibility discussion is evidence, not a claim that all providers or harnesses use identical validators. The 40-character budget reserves space for harness prefixes. The additional folded-name uniqueness rule prevents ambiguous wrapper identifiers without changing the actual hyphen-preserving wire projection.

## Rejected Alternatives

- Colon or dotted model-visible separators: they are not portable across the verified provider interfaces.
- Separately authored aliases for operation projections: they create a second identity to maintain.
- Folding hyphens in the actual projection: it loses the agreed segment spelling; check folded collisions instead.
- Keeping old pre-stable callable aliases: the accepted reset boundary permits direct replacement.

## Revisit When

A required provider or harness cannot accept this projection or needs more prefix space, or the accepted operation-identity owner changes the semantic namespace model. A provider example alone is not proof of a new interoperability guarantee.

## Affected Owners

- [Operation Definition](../specs/20261002-operation_definition.md).
- [Core Agent Capability](../core/agent-capability.md).
- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md).
- [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md).
- [Internal Agent Runtime](../specs/20260813-internal_agent_runtime.md).
- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md).
