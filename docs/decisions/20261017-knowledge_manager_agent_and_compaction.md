---
status: Accepted
date: "2026-10-17"
decider: Engineer
---
# Knowledge Manager Agent And OpenKit Compaction

## Decision

The Knowledge Manager is an internal agent role. Working agents receive a bounded notebook overview and ask it for source-cited answers. It writes, integrates and organizes Memory and Knowledge through the existing notebook publisher. Users supply intent, information and approval; simple authorized direct edits remain available. Facts grant no authority.

Each notebook scope has one nonresident maintenance Thread as its record and approval place, and one writer maintains the notebook. Daily scheduling or an explicit request starts a fresh bounded Turn. The 09:55Z ruling refines the earlier option B choice: the notebook and commit history provide cross-run memory, not a continuing model conversation. Users inspect and approve there. Queries run independently and in parallel under each asker's query context and audience. Thread, Turn, Item, capability call and notebook publication owners retain their existing authority; no new store, registry, scheduler, ledger or status family is admitted.

The Knowledge Manager uses OpenKit compaction only inside a bounded run near the selected logical model's threshold. Both compaction and rolling context retain the existing context-summary Item, with its covered Item range, strategy and producing model. Reconstruction uses the latest valid summary plus later Items. Each execution records its pinned strategy beside role, model and threshold; no per-call window record ships in v0.1.0. This is an exception to [Private Assistant Timeline And Durable Rolling Context](20261015-private_assistant_timeline_and_rolling_context.md), which selected rolling context for all internal roles. Assistant and Goal Coordinator retain rolling context. A future admitted Evaluator would use compaction. Restart reconstructs from current durable owners; it never replays the model run or Tool effects.

Every internal role uses the existing configurable execution-profile resolver. The Knowledge Manager should use a knowledgeable model with low hallucination and a large context window. Grok 4.7 is the engineer's current deployment choice because only the xAI login is available; it is not a hard-coded model requirement.

The engineer's approximately 06:36Z clarification keeps the existing internal roles and gives Knowledge Manager its own work and usage accounting. The requesting call supplies lineage only. Knowledge Manager has no network tools or effects outside querying and managing its notebook scope. Its operations are trusted at this stage; additional model review and confidence marks are deferred. Required human authority still applies.

OKF keeps a closed core and open front-matter extensions. No page-level origin or trust field is required; existing commit metadata records the source of each change. A simple administrator tombstone mechanism is specified for the Git notebook, with implementation deferred. It masks content through ordinary commits and product reads, without rewriting history. Items and backups remain outside this mechanism.

## Reason

The engineer wants agent-native retrieval and curation, not a deterministic retrieval coordinator with an agent label. A dedicated Knowledge Manager can search, read, combine evidence and explain uncertainty. The maintenance Thread preserves user-visible work and approval without a resident agent or context carried between runs. Independent query runs keep audiences isolated. The engineer chose traditional compaction for its long-context maintenance work rather than applying the Assistant's rolling-window choice to every role.

Source: coordinator's recorded engineer rulings of 2026-10-17, approximately 05:29Z and 05:38Z, and the accepted option B in the Knowledge and Memory rethink, Revision 2. The original wording follows verbatim at the engineer's request. The English translations preserve its meaning.

At approximately 06:36Z, the engineer clarified accounting, single-purpose trust, extensible front matter and notebook-only masking. The coordinator's 06:38Z addendum assigned these rules to this same owner change. Mixed-origin pages make one required page-level origin label misleading; per-change Git attribution preserves the relevant distinction. The notebook needs a product masking mechanism because external text tools cannot easily change its Git-backed read projections. This does not require history rewrite or physical erasure.

### Approximately 05:29Z: Verbatim

> 关于 knowledge 和 memory 的这部分，我认为你的设计与思考缺了非常重要的一环，就是单独的 knowledge manager agent。 比如你提到的渐进式披露，这个我是同意的。但是，在我们的系统设计里面，我们这是一个 agent native 的系统。你要考虑如何最大化地利用 agent 的能力，也就是说，在我们的系统里面，更多的做法应当是告诉工作当中的 agent，不论是 nanocore 当中的 agents，还是 workers。 我们的知识库当中有一些什么？然后在检索的时候，应当向 Knowledge Manager 进行提问，由 Knowledge Manager 使用相关的工具进行检索与汇总，然后答复。Memory/knowledge的写入、整理和管理也应由 Knowledge Manager 来完成。 用户的话只是提出意图，提供信息，审批确认（当然，也有可能自行进入 knowledge base 进行简单的修改）。 另外，一个额外的话题是关于 knowledge manager 的 agent loop。由于我们常用的 assistant、coordinator 等这些 agent 的 agent loop 已经改成了 rolling context window，但是我认为这个方式使用在 knowledge manager 上并不太好。事实上，我们应该选择一个知识丰富、幻觉力低。 且能够处理大上下文窗口的模型作为 knowledge manager 的模型，而 context 管理应该还使用传统的压缩方式。

### English Translation

For Knowledge and Memory, your design and reasoning omit an essential part: a separate Knowledge Manager agent. I agree with progressive disclosure. But our system is agent-native, and you must consider how to make full use of agent capabilities. Tell working agents, both NanoCore agents and Workers, what our knowledge base contains. When they need retrieval, they should ask the Knowledge Manager. It uses the relevant tools to retrieve and summarize, then answers. The Knowledge Manager should also write, organize and manage Memory and Knowledge. Users provide intent and information, and approve or confirm. They can also enter the knowledge base for simple edits. There is another point about its agent loop. Assistant and Coordinator loops now use a rolling context window, but I do not think that fits the Knowledge Manager. Choose a knowledgeable model with low hallucination and a large context window. Its context management should still use traditional compaction.

### 05:38Z: Verbatim

> 一、使用你推荐的B选项。二、这个模型应该是可以在配置文件中配置的。事实上，我们所有的每一个 workspace 当中的 internal role 都应该是可以配置的。那么当前的话，由于我们只有一个 XAI 的登录，所以使用 Grok 4.7 作为我们当前的模型。

### English Translation

First, use your recommended option B. Second, the model should be configurable in a configuration file. In fact, every internal role in every Workspace should be configurable. At present, because we have only one xAI login, use Grok 4.7 as our current model.

### Bounded Maintenance And Shared Summary Storage

The engineer's approximately 09:47Z, 09:55Z and 09:59Z inputs refine the earlier maintenance and storage choices. Scheduled consolidation and learning from recent authorized scope Threads ship in v0.1.0. Each Server, User and Workspace scope has one daily enablement setting, default off; it is enabled only for acceptance, testing and evaluation. Explicit requests remain available. The existing recurring-trigger owner admits the closed Knowledge Manager target through its existing scan; it adds no independent scheduler or record family.

Each run retains its notebook base revision, processed source range since the prior run, trigger and instructions. It starts from the overview, run inputs and needed Thread records. Candidate commits use the fixed base; current maintenance delegation permits publication, otherwise the exact proposal needs approval. The diff is the review surface. Human edits are inputs and cannot be overwritten; source access and stale-base checks remain in force. Knowledge Manager's own run records never become later learning inputs. Failed and skipped scheduled runs have visible outcomes. AI assessment and usage aging remain deferred.

The two context strategies serve different task boundaries without claiming either is universally better. Their shared Item representation preserves history and lets evaluation group executions by the pinned strategy. Compaction checkpoints are durable existing Items, not another store. No tool name changes in this refinement; the naming discussion is separate.

### Approximately 09:47Z: Verbatim

> 关于 Knowledge Manager 的设计，我大体上同意你的设计，不过我认为有几点需要注意和讨论。第一是接口的命名, 不论是我们通过 MCP Gateway 向 Worker 提供的接口名称，还是 NanoCore 内部的工具名称，还是我们通过 Server 的 MCP 向外部的 Agent 暴露的接口的名称都应该有一个统一的命名规则(从 first principle 出发，我认为这些之所以明明是统一的，是因为他们就是同一套我们系统提供的机制和工具)。我不清楚现行的状况如何，你可以派出一个 Grok worker 来盘点一下。不过，从 common sense 出发，我认为是否可以命名为 [namesoace(only onw word)]_(or ':'?)[action_name], 我们来讨论。 第二点是关于 context window 管理的问题。这里事实上我们相当于实现了两种 agent loop。第一种是 rolling context window，第二种是传统的上下文预算压缩, 之所以使用两种，也是之前我们的理念，我们并不假设一种方式就比另一种更好。这部分的理论和实践还在发展当中，我们都放到我们的系统里来进行评估。其次就是从 First principle出发，我认为像 assistant 这种不能区分单次对话边界的长期存在的 agent，包括 coordinator 也是一个半长期的，像这样的 agent，我认为 rolling context window。 会更加的自然，而像 Knowledge Manager，还有将来，比如说 Performance Evaluator，这样它的单次任务边界和 Task Model 当中的 Worker 类似，是有非常清晰的对话边界的，我认为用传统的上下文压缩的方式会更好。你认为呢？另外，这两种上下文压缩模式的工作信息存储格式(也就是我们的 thread turn items 模型)，我们是否能够统一起来呢？

### English Translation

I generally agree with the Knowledge Manager design, but two points need discussion. First, tools exposed through Worker MCP, NanoCore and Server MCP should have one naming rule, because they expose the same system mechanisms. Consider a single-word namespace and an action name; the naming choice remains separate. Second, rolling context and traditional budget compaction are two agent-loop strategies. We do not assume one is better and want to evaluate both. Rolling context seems natural for the long-lived Assistant and partly long-lived Coordinator. Traditional compaction seems better for bounded Knowledge Manager tasks and a future Evaluator. Can their Thread, Turn and Item storage format be unified?

### Approximately 09:55Z: Verbatim

> 我认为那个维护的 thread 不应该算作是常驻的，只是它会被我们的定时机制拉起来。你可以查一下 Claude Code 当中的 dreaming 机制。你可以让 Grok 去社区查询相关的讨论。 我希望两种管理上下文的方式的存储格式是统一的。不过，如果格式是统一的，我们在评估的时候又怎样区分他们在使用哪一种方式呢？

### English Translation

The maintenance Thread should not be considered resident; our scheduling mechanism starts it. Check Claude Code dreaming and community discussion. I want both context-management strategies to share a storage format. If the format is shared, how can evaluation distinguish which strategy each execution used?

### Approximately 09:59Z: Verbatim

> 定时触发放进0.1，就像你讲的，工作量不大，但是允许用户配置开启还是关闭(server、User和Workspace scope分别有各自的配置), 默认是关闭的，只有我们在验收, 测试与评估的时候，把它打开。

### English Translation

Put scheduled triggering in v0.1.0. Allow a separate on/off setting for Server, User and Workspace scopes. Default it to off and enable it only during acceptance, testing and evaluation.

## Rejected Alternatives

- A deterministic-first retrieval coordinator omits the agent's search, synthesis and curation work that the engineer requires.
- Rolling context for the Knowledge Manager conflicts with the engineer's chosen long-context compaction policy.
- A resident maintenance conversation carries model context across unrelated runs. The later ruling selects fresh bounded runs while retaining one Thread for records and approval; it does not discard that review place as the earlier option A did.
- A new Knowledge Manager runtime, store, scheduler or ledger duplicates owners that already hold conversation, evidence and publication.
- A fixed provider or hard-coded model prevents the per-Workspace configuration that the engineer requires.
- Charging queries to the caller hides the Knowledge Manager's own work and usage.
- A required page-origin/trust label cannot describe mixed sources and closes the intended front-matter extensions.
- History rewrite and a new review/confidence mechanism exceed the engineer's current scope.

## Revisit When

Revisit if the engineer changes maintenance continuity, query isolation or the Knowledge Manager's context policy. Revisit masking if product requirements need finer content selection or physical erasure. Revisit model selection when provider supply or measured role suitability changes; configuration changes do not require a new agent architecture.

## Affected Owners

- [Knowledge And Personal Memory](../core/knowledge.md)
- [Core Architecture](../core/architecture.md)
- [Knowledge Manager Internal Agent Runtime](../specs/20260704-knowledge_manager_internal_agent_runtime.md)
- [Internal Agent Runtime](../specs/20260813-internal_agent_runtime.md)
- [Context Management And Compaction](../specs/20260902-agent_runtime_context_compaction.md)
- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md)
- [Personal Memory And Knowledge Learning](../specs/20260909-personal_memory_and_knowledge_learning.md)
- [Knowledge Notebook Editing And Publication](../specs/20260909-knowledge_notebook_editing.md)
- [Recurring Triggers](../specs/20260711-scheduler_recurring_event_triggers.md)
