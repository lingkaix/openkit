# Product Vision

Status: Accepted
Date: 2026-04-15

## Current Implementation Posture

The current implementation path is NanoCore-first and MCP-first. OpenKit is hardening the core kernel, public API, and AI-native coordination channel before completing the Web UI as the primary product surface. This preserves the long-term product vision while letting the team validate the real work loop through external coordinator agents and NanoCore contracts first.

## 1. 产品定位

OpenKit 是一个面向 `agent workflow` 的个人与小团队工作系统，目标是提供一个友好、清晰、可扩展的统一入口，让用户像管理真实团队一样管理 agents。

它首先可以以 `SPA` 形态实现，后续再封装到 `Tauri` desktop app 中；产品重点不是自研完整 `agent runtime`，而是把成熟 runtimes 组织起来，形成轻量的 `App + Core + Agent` 体系。

OpenKit 的核心价值不是“能调度 agents”本身，而是在真实工作中持续提升 human + agents 团队的协作能力，逐步优化 knowledge、context supply、agent configuration、skills 和 handoff patterns。

## 2. 目标用户

OpenKit 面向高效率学习和工作的专业个人，以及 typically 3-5 人的小型专家团队。

这些用户会驱动大量不同类型的 agents 组成 human + agents 混合团队，把 agents 当作团队成员分派任务、跟踪进展、评估结果，并共同完成复杂目标。

系统尤其希望服务 end user，包括 non-tech users，让他们不用处理使用 agents 的技术细节和 operational issues，而是专注于自己的专业判断、工作目标和团队管理。

## 3. 核心理念

### 3.1 Agents as Teammates

OpenKit 把 agents 当作真实 teammates，而不是一次性调用的工具。

每个 agent 都应在明确的 context、tools 和 skills 下尽可能 end to end 地完成任务，并对自己的工作结果负责。

用户可以直接和某个 agent 对话，但更常见的模式是通过 `Core Agent` 或 `Core` 来管理整个 agent team。

### 3.2 Human as Leader, Driver, and Supervisor

具体任务由 agents 完成，但整个过程必须 trackable、可回溯、可解释，并且不脱离人的掌控。

Real human 始终是团队的 leader、driver 和 supervisor，拥有最终决定权和全局视野。

系统需要帮助 human 保持对 task state、communication、handoff、outputs 和 risks 的持续可见性。

### 3.3 Let Humans Focus on What Humans Do Best

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

- `App` 提供面向用户的 UI，当前以 `SPA` 为主，未来可以封装为 desktop app。
- `Core` 是 orchestration hub，负责 communication、task state、storage、routing、context supply、proxy 和 coordination。
- `Agent` 封装实际执行任务的 agent runtimes，例如 `Codex`、`OpenCode`、`Pi Agent`，承担 heavy execution。

这套边界的目的是保持 `Core minimal`，避免 Core 退化成另一个完整 runtime。

### 4.2 Core as Hub

Core server 是整个体系的中枢，提供使用 agents 所需的功能、数据和基础设施。

它不是另一个 `agent runtime`，而是让 human 高效管理 agent team 的统一操作层。

Core 负责下达任务、分配执行、跟踪协作，并通过 UI 或外部 channels 持续呈现 communication、task state 和 outputs。

### 4.3 Agents Do the Heavy Lifting

复杂任务、大型执行、扩展逻辑和 runtime-specific capabilities 应交给 agents 完成。

Core 可以完成 quick answer 和轻量任务，但不加载额外工具，不承担 heavy execution。

这条边界保证 Core 始终保持 orchestrator 身份，并让系统最大化复用现有 agent ecosystem。

## 5. User Experience

### 5.1 Conversation-First Interface

UI 应围绕 conversation-first 体验展开，形式上接近 `ChatGPT` 一类的 chat-style interface，但重点不是复刻已有产品，而是为 agent work 提供更清楚的操作面。

这个界面的重点不只是“可以聊天”，而是让用户能像管理真实 team 一样管理 agents。

界面应自然回答以下问题。

- 谁在负责什么。
- 当前任务进行到哪里。
- Agents 之间发生了哪些 communication 与 handoff。
- 哪些 artifacts 已经完成，哪些还在处理中。
- 用户什么时候需要介入，什么时候可以只看结果。

### 5.2 Main UI Capabilities

- `Conversation UI`：以对话为主入口，适合发起任务、查看进展、继续追问。
- `Artifacts`：支持展示结构化输出和工作产物，参考 `LibreChat Artifacts` 这类交互形式。
- `Generative UI`：未来在合适场景下支持生成式界面，让模型输出更丰富的 visual / interactive result。
- `Config interface`：提供必要配置界面，用于管理 agents、runtime、环境和基础偏好。
- `Task and communication tracking`：以友好方式追踪 task ownership、status、handoff、messages 和 results。

### 5.3 UI Design Principles

- 保持简单，避免过多层级和复杂交互。
- 保持代码库小而清晰，不因为追求功能完整而把前端做重。
- 优先让任务可读、状态可见、产物可访问，而不是堆叠额外功能。
- UI 要 `capable but neat`，既能承载对话、产物和配置，又保持整洁、直接、不过度设计。

## 6. Functional Design

### 6.1 Agent Orchestration

Core 的首要职责是 orchestrate `UI -> Core -> Agent` 的 agent 工作链路。

当前阶段 orchestration 逻辑可以硬编码，由 Core 按固定规则选择 agent 和分发任务。

演进方向是让 Core 具备动态规划能力，根据任务特征选择合适的 `agent config pack` 和 agent，而不是长期依赖预设路由。

`agent config pack` 可以包含 instructions、context、skills 等组合，类似 agent 动态加载 skill 的方式。

### 6.2 Multi-Channel Communication Gateway

Core 不仅是 `UI -> Core -> Agent` 的通信、调度和存储中枢，也应成为多渠道通信网关。

它可以接入外部 messaging channels，参考 `OpenClaw` 的 gateway 模式。

- Discord。
- Signal。
- Slack。
- 其他适合团队协作的 channel。

用户可以从自己习惯的工具发起任务、接收进展通知和结果，而不必始终停留在 OpenKit UI 中。

Core 统一处理来自不同 channels 的消息，并将其转化为内部任务流。

### 6.3 Lightweight Conversation & Task Execution

Core 本身可以具备简短对话能力，支持类似 ChatGPT 的 quick answer。

Core 也可以完成轻量任务，参考 `nanobot` 的 ultra-lightweight posture。

但 Core 不加载额外工具，不承担 heavy execution，复杂任务一律交给 agent 完成。

### 6.4 Specialized Internal Agents

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

- **Auth proxy**：帮助 agent 访问需要认证的资源，agent 自身不需要持有或看到凭证。
- **Access control**：对 agent 可访问的外部资源进行限制和审批。
- **Load balancing & rate limiting**：在多 agent 并发场景下管理外部资源访问压力。
- **Audit & logging**：所有外部资源访问都经过 proxy，天然具备访问记录，支持 usage statistics、cost tracking 和 security audit。

### 6.6 Secret Vault

`Secret Vault` 是专门管理终端用户凭证的安全组件，参考 `Claude Managed Agents Vaults`。

基本工作方式如下。

- 用户将访问外部服务的 secrets 存入 vault，例如 Linear API Key、GitHub Token 等。
- 每次启动 agent session 时，传入对应的 `vault_id`。
- Agent 调用外部工具时，由 proxy 层自动注入凭证。

关键安全设计是 credentials 永远不会被读进 agent 的 context window。

即使发生 prompt injection，agent 也无法泄露密钥，因为 credentials 根本不在 agent 能“看到”的地方。

Credentials injection 发生在 proxy / transport layer，对 agent 完全透明。

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

## 7. Knowledge Vision

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

## 8. Storage & Deployment

Core 的结构和部署应保持轻量级。

### 8.1 Storage Strategy

`SQLite` 是结构化数据的唯一存储引擎。

SQLite files 按 ownership scope 划分，而不是按功能模组划分：`core.sqlite` 属于 Core server，`user.sqlite` 属于单个 user，`workspace.sqlite` 属于单个 workspace，详见 `docs/core/storage.md`。每个 ownership scope 拥有自己的 db file，保持各 scope 数据独立、可替换、可单独备份。当前实现先以单一 `core.sqlite` 承载 server-scope 数据，`user.sqlite` 与 `workspace.sqlite` 随 scope 演进逐步落地。

Filesystem `data/` 用于存储非结构化或半结构化数据，并按目录组织。

- Thread / turn / item records。
- Artifacts，也就是 agent 产出的工作产物。
- 其他不适合放入 SQLite 的内容，例如大文件、二进制产物等。

### 8.2 Storage Benefits

- **Zero external dependency**：不需要 PostgreSQL、Redis 或任何外部数据库服务，单机即可运行。
- **Observability**：SQLite files 和 `data/` directory 都可以直接查看、备份、迁移。
- **Ownership / scope isolation**：每个 ownership scope，例如 server、user、workspace，使用独立 db file（`core.sqlite` / `user.sqlite` / `workspace.sqlite`），避免单一数据库膨胀，也方便按 scope 演进、备份、导出和删除。

## 9. Design Principles

- `Minimal implementation first`：先做最小可用实现，不在一开始追求完整平台化。
- `Core minimal`：Core 只保留 orchestration 必需能力，不承担重执行逻辑。
- `Agents do the heavy lifting`：大型任务、复杂执行、扩展逻辑交给 agents。
- `Reuse over reinvention`：优先封装 existing runtimes，而不是自研新 runtime。
- `Speed matters`：系统需要快速响应，至少支持 quick answer 和基础工具调用。
- `Small codebase`：控制复杂度，保持实现和维护成本可控。
- `Flexible composition`：支持 local / remote、host / container 等不同组合方式。
- `Improve through work`：系统通过真实工作持续学习 user preferences、working style 和 team patterns。
- `Optimize agents over time`：agent 的 skills、context injection 和配置策略随着任务积累逐步优化。
- `Security by design`：credentials、network access、external APIs 和 audit trails 应在 Core / proxy 层统一治理。

## 10. Summary

OpenKit 的本质不是再造一个庞大的 all-in-one agent framework，而是做一个简洁的 agent workspace。

它用 neat 的 UI 承载交互体验，用 minimal Core 做 orchestration，用 Docker-based agents 或其他 agent boundary 封装现有 runtimes 来完成重任务。

它把 agents 组织成真实 teammates，由 Core 作为 team manager 驱动协作，并在长期使用中持续积累 knowledge、优化 agent configuration、改进 context supply，并越来越理解 user 的工作方式。

这条路线可以在保持产品清晰度和实现克制的同时，最大化复用现有 agent ecosystem，并为后续扩展留下足够空间。

## 11. References

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
