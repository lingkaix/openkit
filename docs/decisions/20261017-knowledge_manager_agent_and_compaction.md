---
status: Accepted
date: "2026-10-17"
decider: Engineer
---
# Knowledge Manager Agent And OpenKit Compaction

## Decision

The Knowledge Manager is an internal agent role. Working agents receive a bounded notebook overview and ask it for source-cited answers. It writes, integrates and organizes Memory and Knowledge through the existing notebook publisher. Users supply intent, information and approval; simple authorized direct edits remain available. Facts grant no authority.

Option B is selected: each notebook scope has one persistent maintenance Thread, requests arrive as Turns, and one writer maintains the notebook. Users inspect and approve there. Queries run independently and in parallel under each asker's query context and audience. Thread, Turn, Item, capability call and notebook publication owners retain their existing authority; no new store, registry, scheduler, ledger or status family is admitted.

The Knowledge Manager uses OpenKit compaction with a summary checkpoint near the selected logical model's threshold. This is an exception to [Private Assistant Timeline And Durable Rolling Context](20261015-private_assistant_timeline_and_rolling_context.md), which selected rolling context for all internal roles. Other internal roles retain rolling context. Restart reconstructs from current durable owners; it never replays the model run or Tool effects.

Every internal role uses the existing configurable execution-profile resolver. The Knowledge Manager should use a knowledgeable model with low hallucination and a large context window. Grok 4.7 is the engineer's current deployment choice because only the xAI login is available; it is not a hard-coded model requirement.

## Reason

The engineer wants agent-native retrieval and curation, not a deterministic retrieval coordinator with an agent label. A dedicated Knowledge Manager can search, read, combine evidence and explain uncertainty. A persistent maintenance conversation preserves user-visible intent and approval. Independent query runs keep audiences isolated. The engineer chose traditional compaction for its long-context maintenance work rather than applying the Assistant's rolling-window choice to every role.

Source: coordinator's recorded engineer rulings of 2026-10-17, approximately 05:29Z and 05:38Z, and the accepted option B in the Knowledge and Memory rethink, Revision 2. The original wording follows verbatim at the engineer's request. The English translations preserve its meaning.

### Approximately 05:29Z: Verbatim

> 关于 knowledge 和 memory 的这部分，我认为你的设计与思考缺了非常重要的一环，就是单独的 knowledge manager agent。 比如你提到的渐进式披露，这个我是同意的。但是，在我们的系统设计里面，我们这是一个 agent native 的系统。你要考虑如何最大化地利用 agent 的能力，也就是说，在我们的系统里面，更多的做法应当是告诉工作当中的 agent，不论是 nanocore 当中的 agents，还是 workers。 我们的知识库当中有一些什么？然后在检索的时候，应当向 Knowledge Manager 进行提问，由 Knowledge Manager 使用相关的工具进行检索与汇总，然后答复。Memory/knowledge的写入、整理和管理也应由 Knowledge Manager 来完成。 用户的话只是提出意图，提供信息，审批确认（当然，也有可能自行进入 knowledge base 进行简单的修改）。 另外，一个额外的话题是关于 knowledge manager 的 agent loop。由于我们常用的 assistant、coordinator 等这些 agent 的 agent loop 已经改成了 rolling context window，但是我认为这个方式使用在 knowledge manager 上并不太好。事实上，我们应该选择一个知识丰富、幻觉力低。 且能够处理大上下文窗口的模型作为 knowledge manager 的模型，而 context 管理应该还使用传统的压缩方式。

### English Translation

For Knowledge and Memory, your design and reasoning omit an essential part: a separate Knowledge Manager agent. I agree with progressive disclosure. But our system is agent-native, and you must consider how to make full use of agent capabilities. Tell working agents, both NanoCore agents and Workers, what our knowledge base contains. When they need retrieval, they should ask the Knowledge Manager. It uses the relevant tools to retrieve and summarize, then answers. The Knowledge Manager should also write, organize and manage Memory and Knowledge. Users provide intent and information, and approve or confirm. They can also enter the knowledge base for simple edits. There is another point about its agent loop. Assistant and Coordinator loops now use a rolling context window, but I do not think that fits the Knowledge Manager. Choose a knowledgeable model with low hallucination and a large context window. Its context management should still use traditional compaction.

### 05:38Z: Verbatim

> 一、使用你推荐的B选项。二、这个模型应该是可以在配置文件中配置的。事实上，我们所有的每一个 workspace 当中的 internal role 都应该是可以配置的。那么当前的话，由于我们只有一个 XAI 的登录，所以使用 Grok 4.7 作为我们当前的模型。

### English Translation

First, use your recommended option B. Second, the model should be configurable in a configuration file. In fact, every internal role in every Workspace should be configurable. At present, because we have only one xAI login, use Grok 4.7 as our current model.

## Rejected Alternatives

- A deterministic-first retrieval coordinator omits the agent's search, synthesis and curation work that the engineer requires.
- Rolling context for the Knowledge Manager conflicts with the engineer's chosen long-context compaction policy.
- Option A, per-request maintenance rebuilt only from the notebook and Git history, omits the persistent maintenance conversation selected for user inspection and approval.
- A new Knowledge Manager runtime, store, scheduler or ledger duplicates owners that already hold conversation, evidence and publication.
- A fixed provider or hard-coded model prevents the per-Workspace configuration that the engineer requires.

## Revisit When

Revisit if the engineer changes maintenance continuity, query isolation or the Knowledge Manager's context policy. Revisit model selection when provider supply or measured role suitability changes; configuration changes do not require a new agent architecture.

## Affected Owners

- [Knowledge And Personal Memory](../core/knowledge.md)
- [Core Architecture](../core/architecture.md)
- [Knowledge Manager Internal Agent Runtime](../specs/20260704-knowledge_manager_internal_agent_runtime.md)
- [Internal Agent Runtime](../specs/20260813-internal_agent_runtime.md)
- [Context Management And Compaction](../specs/20260902-agent_runtime_context_compaction.md)
- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md)
- [Personal Memory And Knowledge Learning](../specs/20260909-personal_memory_and_knowledge_learning.md)
