---
status: Accepted
date: 2026-04-15
---
# Product Vision

> **文档说明：** 本文使用中文书写，proper names、canonical terms、product names、technical identifiers 与其他专有 item 保留 English 原词；这项 document-local exception 仅适用于 `docs/product-vision.md`，不修改或扩张其他 repository documentation 的 English-only 规则。

模型能力与 harness 成熟度会消灭只是为了操作工具而产生的交互，但不会消灭为了形成意图、判断品味、评估质量和探索可能性而产生的交互。

随着高质量 candidate generation 的成本下降，用户会通过比较、预览、选择和细微调整进行更多而不是更少的创造性探索。因此，高带宽交互将从教 AI 如何执行，转向共同判断什么值得存在。

OpenKit 必须覆盖从 delegation 到 co-creation 的连续过渡，同时不复刻垂直领域的 production workbench。这个边界让 OpenKit 保持为 Agent manager，并能够成长为 Human + Agent 工作系统。

OpenKit 拥有的更高层能力是 `judgement grounding`：把难以通过文字完整表达的 human judgement 转换成 precise、localized、executable 且 replayable 的 Agent input。

OpenKit 不应只让用户告诉 Agent 做什么，还应让用户通过选择、比较、标注、调整和局部修改，传递尚未完全语言化的专业判断。

模型越强，这项能力越重要，因为微小的 intent 偏差可能驱动越来越大量的、执行正确但方向错误的自动化工作。

OpenKit 持久的产品护城河，是在不让自身成为垂直领域工具的前提下，把 tacit human judgement 压缩成 Agent 能够准确理解并采取行动的信号。

## 1. 产品定位

OpenKit 是一个面向 `agent workflow` 的个人与小团队工作系统，目标是提供一个友好、清晰、可扩展的统一入口，让用户像管理真实团队一样管理 agents。

它首先可以以 `SPA` 形态实现，后续再封装到 `Tauri` desktop app 中；产品重点不是自研完整 `agent runtime`，而是把成熟 runtimes 组织起来，形成轻量的 `App + Core + Agent` 体系。

OpenKit 的核心价值不是“能调度 agents”本身，而是在真实工作中持续提升 human + agents 团队的协作能力，逐步优化 knowledge、context supply、agent configuration、skills 和 handoff patterns。

## 2. 目标用户

OpenKit 面向高效率学习和工作的专业个人，以及 typically 3-5 人的小型专家团队。

这些用户会驱动大量不同类型的 agents 组成 human + agents 混合团队，把 agents 当作团队成员分派任务、跟踪进展、评估结果，并共同完成复杂目标。

系统尤其希望服务 end user，包括 non-tech users，让他们不用处理使用 agents 的技术细节和 operational issues，而是专注于自己的专业判断、工作目标和团队管理。

## 3. 核心理念

### 3.1 Agents 作为 Teammates

OpenKit 把 agents 视为真实 teammates，而不是一次性的 tool calls。用户可以直接与一个 agent 协作，产品也应提供一种一致的方式，通过 Core 指挥和监督整个 agent team。

关于 bounded delegation、execution accountability、human authority 和 durable product truth 的规范规则由 [Foundation](./core/foundation.md) 所有。

### 3.2 Human 作为 Leader、Driver 与 Supervisor

真实 human 始终是团队的 leader、driver 和 supervisor。Agents 执行 delegated work 时，产品应让 human 清楚看见工作、handoffs、outputs 和 risks。

关于 final authority、observability、reviewability 和 stop boundary 的规范原则由 [Foundation](./core/foundation.md) 所有。

### 3.3 让 Human 专注于最擅长的事

OpenKit 的 unified interface 应让用户专注于发挥人最重要的能力。

- **Agency**：主动发起、调整、推进工作，而不是被动等待 agents 输出。
- **Open mind and wide/deep sight**：保持开放视野，从多维度审视问题并做出判断。
- **Clear logic**：在复杂局面中保持清晰思路，做出高质量决策。
- **Clean instructions / prompts**：向 agents 传达精准、无歧义的工作指令。
- **Maintain a good system / workflow / standards**：建立和维护高质量的工作体系、流程和标准。

系统的责任是屏蔽 agents 使用中的复杂性，让 human expertise 得到最大化发挥。

## 4. 系统架构

### 4.1 App + Core + Agent

OpenKit 的基本架构是 `App + Core + Agent`。

- `App` 是用户交互界面。
- `Core` 是受治理的 coordination 与 durable-truth boundary。
- `Agent` 集成执行 delegated work 的 specialized runtimes。

[Foundation](./core/foundation.md) 与 [Architecture](./core/architecture.md) 拥有规范的 responsibility 和 execution boundaries；本节只说明产品形态。

### 4.2 Core 作为 Hub

对用户而言，Core 是指挥 agent team 并观察其工作的统一 operating layer。Core 的具体服务和内部职责由 [Architecture](./core/architecture.md) 所有，而不是由 Product Vision 定义。

### 4.3 Agents 承担 Heavy Lifting

产品应把复杂且 runtime-specific 的执行交给 specialized agents，同时为用户保持一致的 coordination 体验。持久的 Core-versus-runtime boundary 由 [Foundation](./core/foundation.md) 所有。

## 5. 用户体验

### 5.1 Conversation-First 界面

UI 应围绕 conversation-first 体验展开，形式上接近 `ChatGPT` 一类的 chat-style interface，但重点不是复刻已有产品，而是为 agent work 提供更清楚的操作面。

这个界面的重点不只是“可以聊天”，而是让用户能像管理真实 team 一样管理 agents。

界面应自然回答以下问题。

- 谁在负责什么。
- 当前任务进行到哪里。
- Agents 之间发生了哪些 communication 与 handoff。
- 哪些 artifacts 已经完成，哪些还在处理中。
- 用户什么时候需要介入，什么时候可以只看结果。

### 5.2 主要 UI 能力

- `Conversation UI`：以对话为主入口，适合发起任务、查看进展、继续追问。
- `Artifacts`：支持展示结构化输出和工作产物，参考 `LibreChat Artifacts` 这类交互形式。
- `Generative UI`：未来在合适场景下支持生成式界面，让模型输出更丰富的 visual / interactive result。
- `Config interface`：只呈现必须由用户提供的目标、约束、授权、偏好和例外决策，不把 agents、runtime、Workspace 或环境的日常管理转嫁给用户。
- `Task and communication tracking`：以友好方式追踪 task ownership、status、handoff、messages 和 results。

### 5.3 UI 设计原则

- 保持简单，避免过多层级和复杂交互。
- 保持代码库小而清晰，不因为追求功能完整而把前端做重。
- 优先让任务可读、状态可见、产物可访问，而不是堆叠额外功能。
- UI 要 `capable but neat`，既能承载对话、产物和配置，又保持整洁、直接、不过度设计。

## 6. 功能设计

### 6.1 Agent 编排

Core 的首要职责是 orchestrate `UI -> Core -> Agent` 的 agent 工作链路。

当前阶段 orchestration 逻辑可以硬编码，由 Core 按固定规则选择 agent 和分发任务。

演进方向是让 Core 具备动态规划能力，根据任务特征选择合适的 `agent config pack` 和 agent，而不是长期依赖预设路由。

`agent config pack` 可以包含 instructions、context、skills 等组合，类似 agent 动态加载 skill 的方式。

### 6.2 多渠道 Communication Gateway

Core 不仅是 `UI -> Core -> Agent` 的通信、调度和存储中枢，也应成为多渠道通信网关。

它可以接入外部 messaging channels，参考 `OpenClaw` 的 gateway 模式。

- Discord。
- Signal。
- Slack。
- 其他适合团队协作的 channel。

用户可以从自己习惯的工具发起任务、接收进展通知和结果，而不必始终停留在 OpenKit UI 中。

Core 统一处理来自不同 channels 的消息，并将其转化为内部任务流。

### 6.3 轻量对话与任务执行

Core 本身可以具备简短对话能力，支持类似 ChatGPT 的 quick answer。

Core 也可以完成轻量任务，参考 `nanobot` 的 ultra-lightweight posture。

但 Core 不加载额外工具，不承担 heavy execution，复杂任务一律交给 agent 完成。

### 6.4 专用 Internal Agents

随着系统成熟，Core 内部可以实现专门的轻量 agents 来承担特定 coordination 职责。

- `Knowledge Manager`：管理 workspace knowledge、source-traceable retrieval、knowledge proposals 和 context material preparation。
- `Task Evaluator`：对 agent 产出进行质量评估，决定是否需要 second pass、revision 或 escalation。
- `Workflow Coordinator`：根据任务类型、历史效果和可用 runtime 规划 workflow mode、worker selection、context assembly 与 handoff pattern。

这些 internal agents 仍受 `Core Boundary` 约束，属于 coordination plane，不承担 heavy execution。

### 6.5 Unified Proxy

Core 提供统一的外部资源访问出口，参考 `Bifrost` 的 `AI Gateway` 模式。

Unified proxy 覆盖以下能力。

- `LLM Provider Proxy`：统一接口访问多家 LLM providers，支持 fallback 和 load balancing。
- `MCP Server Proxy`：代理 agent 对 MCP servers 的访问。
- `Third-party Resource Proxy`：代理对外部 APIs 和服务的访问。
- `Network Proxy`：作为 agents 的统一网络出口。

Proxy 的核心价值如下。

- **Auth proxy**：让 agent 在不把 credentials 放入 prompts 或 stable product records 的情况下访问 authenticated resources；agent 的可见范围取决于经过批准的 injection path。
- **Access control**：对 agent 可访问的外部资源进行限制和审批。
- **Load balancing & rate limiting**：在多 agent 并发场景下管理外部资源访问压力。
- **Audit & logging**：所有外部资源访问都经过 proxy，天然具备访问记录，支持 usage statistics、cost tracking 和 security audit。

### 6.6 Secret Vault

`Secret Vault` 是专门管理终端用户凭证的安全组件，参考 `Claude Managed Agents Vaults`。

基本工作方式如下。

- 用户将访问外部服务的 secrets 存入 vault，例如 Linear API Key、GitHub Token 等。
- 每次启动 AgentSession 时，传入对应的 `vault_id`。
- Agent 调用外部工具时，由 proxy 层自动注入凭证。

Credentials 必须保持在 agent prompts、context packages 和 stable product records 之外。每条获准 injection path 的 visibility、containment、redaction 与 audit contract 由 [Vault](./core/vault.md) 所有。

### 6.7 Knowledge Base / Notebook

`Knowledge Base / Notebook` 是个人或团队的统一知识管理系统。

- 汇集学习、工作、研究相关的数据、信息、发现和成果。
- 方便作为 context 注入任务，Core 在分发任务时可从 knowledge base 中选取相关 context 提供给 agent。
- 支持 structured 和 unstructured content，服务于 knowledge retrieval 和 context packaging。

### 6.8 Generative Kernel

`Generative Kernel` 概念来自《超越 DRY：AI 原生软件工程的思考》。

在 User Generated Software 时代，交付物不只是成品应用，而是支撑 AI 进行代码生成的生成内核，由核心套件、引导知识和杠杆工具集组成。

在 OpenKit 中，Generative Kernel 为 agent 生成个人或团队内部应用、保存和管理结构化数据提供基础设施支持。

核心能力是提供 `data structure contract and storage`，参考 `Supabase`、`PocketBase`、`NocoDB` 和 `InstantDB`。

Generative Kernel 有双向消费模式。

- **End user** 通过 `Generative UI` 查询和管理数据。
- **Agent** 通过 skill、CLI 和 proxy 访问数据。

数据治理要求是保持数据 clean 和安全，不因 agent 访问而引入脏数据或泄露敏感信息。

示例场景是内部 CRM。

Kernel 持有核心客户数据，用户通过 `Generative UI` 查询和管理，agent 通过 skill + CLI 访问数据，并可以制作 scripts 和 scheduled agent tasks 作为业务逻辑，例如追踪和响应用户转化、自动化 follow-up 等。

## 7. Knowledge 愿景

Knowledge 是 OpenKit 长期价值的重要来源，但不应该在 `v1` 阶段做成过于激进、自动推断过多的复杂子系统。

更稳妥的路线是分阶段推进，先把 knowledge 当作 `retrieval problem`，再逐步扩展成 `synthesis problem`。

### 7.1 V1: Retrieval First

`v1` 的核心原则如下。

- `knowledge selection, not knowledge generation by default`。
- `history first, interpretation later`。
- `explicit knowledge over speculative knowledge`。

也就是说，Core 在初期主要负责以下工作。

- 保存 `conversation history`。
- 保存 `task history`。
- 保存少量明确、结构化、低歧义的 knowledge。
- 在任务启动时为当前 task / agent 选择最相关的 context。

`v1` knowledge 可以优先限定在以下范围。

- `user preferences`：例如输出风格、语言偏好、是否偏好 concise answer、是否希望先设计后实现。
- `project context`：例如工作空间说明、关键约束、固定工具链、repo-level guidance。
- `task summaries`：例如已完成任务的简短摘要、产物位置、关键决策。

这一阶段的重点不是“自动理解用户的一切”，而是准确保存已有事实，在正确时机取回正确 context，并避免向 agent 注入过多无关或低可信度的信息。

`v1` 应尽量避免以下行为。

- 自动生成大量长期偏好。
- 把一次性行为推断为稳定习惯。
- 对 user personality 和 working style 做高自信的自动总结。
- 在没有足够证据时覆盖或改写已有 knowledge。

换句话说，`v1 treats knowledge as a retrieval and governance problem, not a synthesis-only problem`。

### 7.2 V2: Knowledge-Driven Improvement

在 `task history`、agent orchestration 和 retrieval 质量稳定之后，系统再进入 `v2`，逐步引入更接近长期上下文系统的能力。

`v2` 可以开始支持以下能力。

- 从历史任务中提取 `task summaries`。
- 从多次重复信号中提取较稳定的 `user preferences`。
- 识别某类任务更适合的 agent、skills 和 handoff pattern。
- 基于历史结果优化默认 context injection 和 agent configuration。

这一阶段的重点不只是保存 history，而是把 history 转化为可复用的工作知识。

- 哪类 agent 更适合哪类任务。
- 哪些 prompt / skill 组合更容易产出高质量结果。
- 哪些 context 应该默认带入。
- 哪些偏好已经足够稳定，可以视为长期 knowledge。

`v2` 的 knowledge generation 必须带有明确控制机制。

- `confidence`。
- `freshness`。
- `source traceability`。
- `conflict handling`。
- `human override`。

系统不应把任何自动总结都视为事实，而应把它视为带来源和置信度的工作假设。

## 8. Storage 与 Deployment

Core 的结构和部署应保持轻量级。

### 8.1 Storage 策略

OpenKit 应让 durable product truth 保持 ownership-scoped、inspectable 和 portable，并确保 baseline deployment 无需依赖外部 database service 即可运行。

[Storage](./core/storage.md) 拥有 OpenKit-owned records 的持久化规则及其 source of truth 声明。具体 engine、file、index 和 physical topology 由相应 storage specifications 所有；Product Vision 不固定某一种 database engine 或 one-file-per-scope layout。

### 8.2 Storage 收益

- **Low operational dependency**：baseline deployment 不要求 PostgreSQL、Redis 或其他外部 database service。
- **Observability and portability**：authoritative records 及其必要 companion state 应当可检查、可备份，并能按照所属 contract 迁移。
- **Ownership / scope isolation**：server、user 和 Workspace data 必须保持清晰的 ownership boundary，physical topology 则由 Storage 及其 specifications 所有。

## 9. 产品设计原则

### 9.1 最低用户管理与配置负担

OpenKit 必须把用户对系统的管理与配置负担降到最低。默认体验不应要求用户自行配置或维护 Workspace、Worker Agent 或新的 sandbox image，也不应要求用户理解 AEP、Policy 或运行中治理的内部机制。

NanoCore 内置的 agent 功能应在 user authorization 与 Core governance 边界内完成这些工作，包括生成和更新 AEP 与 Policy、选择和维护 Worker Agent 与 sandbox image，以及执行 in-the-middle 的监控、管理和更新。用户主要提供目标、约束、授权和必须由 human 作出的判断；只有系统无法安全决定，或需要扩大权限与 external effect 时，才要求用户介入。

系统能够自动完成的管理工作，不应退化成默认的 `Config interface` 负担。

### 9.2 All-in-one Workspace，而非 all-in-one IT system

OpenKit 的目标不是替代用户已经使用的 CMS、CRM、BI、data analytics platform 或其他垂直系统。这些系统继续拥有各自领域的专业能力与 authoritative data。

OpenKit 负责汇总和粘合用户完成工作所需的 components、data、tools、Agents、work resources 与 workflows，并把它们组织成一个连贯的 Workspace 和 workbench。

因此，OpenKit 不是解决用户全部 digital 或 IT 需求的 all-in-one solution，但它是用户的 all-in-one Workspace 和工作台。只有当某项能力直接服务于跨系统整合、协作、governance 或 `judgement grounding` 时，OpenKit 才应把它纳入自身边界，而不重建已有垂直产品。

### 9.3 其他原则

- `Minimal implementation first`：先做最小可用实现，不在一开始追求完整平台化。
- `Clear responsibility boundaries`：遵循 Foundation 与 Architecture，不把一个 component 扩张成另一个 product 或 runtime。
- `Reuse over reinvention`：优先封装 existing runtimes，而不是自研新 runtime。
- `Speed matters`：系统需要快速响应，至少支持 quick answer 和基础工具调用。
- `Small codebase`：控制复杂度，保持实现和维护成本可控。
- `Flexible composition`：支持 local / remote、host / container 等不同组合方式。
- `Improve through work`：系统通过真实工作持续学习 user preferences、working style 和 team patterns。
- `Optimize agents over time`：agent 的 skills、context injection 和配置策略随着任务积累逐步优化。
- `Security by design`：credentials、network access、external APIs 和 audit trails 应在 Core / proxy 层统一治理。

## 10. 总结

OpenKit 的本质不是再造一个庞大的 all-in-one agent framework，也不是替代 CMS、CRM、BI 等垂直系统，而是做一个简洁的 agent workspace，以及用户的 all-in-one Workspace 和工作台。

它用 neat 的 UI 承载交互体验，用 minimal Core 做 orchestration，用 Docker-based agents 或其他 agent boundary 封装现有 runtimes 来完成重任务，并通过 NanoCore 内置 agent 功能吸收默认的配置与管理负担。

它把 agents 组织成真实 teammates，由 Core 作为 team manager 驱动协作，并在长期使用中持续积累 knowledge、优化 agent configuration、改进 context supply，并越来越理解 user 的工作方式。

这条路线可以在保持产品清晰度和实现克制的同时，最大化复用现有 agent ecosystem，并为后续扩展留下足够空间。

## 11. 参考资料

- `LibreChat Artifacts`: https://www.librechat.ai/docs/features/artifacts
- `Generative UI`: https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/
- `OpenClaw`: https://openclaw.ai/
- `nanobot`: https://github.com/HKUDS/nanobot
- `pi-mono`: https://github.com/badlogic/pi-mono
- `Bifrost`: https://github.com/maximhq/bifrost
- `Claude Managed Agents Vaults`: https://platform.claude.com/docs/en/managed-agents/vaults
- `Generative Kernel`: https://yage.ai/ai-software-engineering.html
- `Supabase`: https://github.com/supabase/supabase
- `PocketBase`: https://github.com/pocketbase/pocketbase
- `NocoDB`: https://github.com/nocodb/nocodb
- `InstantDB`: https://github.com/instantdb/instant
