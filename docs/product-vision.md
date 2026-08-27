---
status: Accepted
date: 2026-04-15
---
# Product Vision

## Current Implementation Posture

The accepted implementation path is NanoCore-first and end-user Agent-Skill-first. OpenKit hardens the core kernel and public API, then projects the complete supported user/operator capability surface through the progressively disclosed `openkit` Skill and bundled CLI before completing the Web UI as the primary product surface. The removed user-facing MCP facade and split setup/loop Skills must not be restored, while worker-side MCP capability supply remains a separate accepted future plane whose current AEP projection is disabled.

## Strategic Work Resource Thesis

Model capability and harness maturity will eliminate interaction created only by the need to operate tools. They will not eliminate interaction required to form intent, exercise taste, judge quality, or explore possibility.

As high-quality candidate generation becomes cheaper, users may perform more creative exploration through comparison, preview, selection, and fine adjustment rather than less. High-bandwidth interaction therefore moves from teaching AI how to execute toward jointly deciding what should exist.

OpenKit must cover the continuous transition from delegation to co-creation without reproducing domain production workbenches. This boundary keeps OpenKit an Agent manager while allowing it to grow into a Human + Agent work system.

The higher-layer capability OpenKit owns is judgement grounding: converting human judgement that is difficult to express in prose into Agent input that is precise, localized, executable, and replayable.

OpenKit should not only let users tell an Agent what to do. It should let users transmit professional judgement that is not yet fully verbalized through selection, comparison, annotation, adjustment, and local modification.

This capability becomes more important as models become stronger because a small intent error can drive an increasingly large amount of correct but misdirected automated execution.

OpenKit's durable product moat is the ability to compress tacit human judgement into signals that an Agent can interpret and act on accurately without requiring OpenKit to become the domain tool itself.

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

OpenKit treats agents as real teammates rather than disposable tool calls. Users may work directly with one agent, but the product should also provide one coherent way to direct and supervise the agent team through Core.

The normative rules for bounded delegation, execution accountability, human authority, and durable product truth belong to [Foundation](./core/foundation.md).

### 3.2 Human as Leader, Driver, and Supervisor

The real human remains the team's leader, driver, and supervisor. The product should give that human clear visibility into work, handoffs, outputs, and risks while agents perform delegated execution.

[Foundation](./core/foundation.md) owns the normative final-authority, observability, reviewability, and stop-boundary doctrine.

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

- `App` is the user interaction surface.
- `Core` is the governed coordination and durable-truth boundary.
- `Agent` integrates specialized runtimes that perform delegated execution.

[Foundation](./core/foundation.md) and [Architecture](./core/architecture.md) own the normative responsibility and execution boundaries; this section states only the product shape.

### 4.2 Core as Hub

To the user, Core is the unified operating layer for directing the agent team and observing its work. Its exact services and internal responsibilities belong to [Architecture](./core/architecture.md), not Product Vision.

### 4.3 Agents Do the Heavy Lifting

The product should delegate complex and runtime-specific execution to specialized agents while keeping coordination coherent for the user. [Foundation](./core/foundation.md) owns the durable Core-versus-runtime boundary.

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

- **Auth proxy**: lets an agent access authenticated resources without placing credentials in prompts or stable product records; agent visibility depends on the approved injection path.
- **Access control**：对 agent 可访问的外部资源进行限制和审批。
- **Load balancing & rate limiting**：在多 agent 并发场景下管理外部资源访问压力。
- **Audit & logging**：所有外部资源访问都经过 proxy，天然具备访问记录，支持 usage statistics、cost tracking 和 security audit。

### 6.6 Secret Vault

`Secret Vault` 是专门管理终端用户凭证的安全组件，参考 `Claude Managed Agents Vaults`。

基本工作方式如下。

- 用户将访问外部服务的 secrets 存入 vault，例如 Linear API Key、GitHub Token 等。
- 每次启动 AgentSession 时，传入对应的 `vault_id`。
- Agent 调用外部工具时，由 proxy 层自动注入凭证。

Credentials must remain outside agent prompts, context packages, and stable product records. [Vault](./core/vault.md) owns the visibility, containment, redaction, and audit contract for every approved injection path.

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

OpenKit should keep durable product truth ownership-scoped, inspectable, portable, and operable without a required external database service in the baseline deployment.

[Storage](./core/storage.md) owns the rules for persisting OpenKit-owned records and declaring their source of truth. Concrete engines, files, indexes, and physical topology belong to the owning storage specifications; this product vision does not freeze one database engine or one-file-per-scope layout.

### 8.2 Storage Benefits

- **Low operational dependency**: the baseline deployment requires no PostgreSQL, Redis, or other external database service.
- **Observability and portability**: authoritative records and required companion state should be inspectable, backup-ready, and migratable through their owning contracts.
- **Ownership / scope isolation**: server, user, and workspace data must retain clear ownership boundaries, while Storage and its specifications own the physical topology.

## 9. Design Principles

- `Minimal implementation first`：先做最小可用实现，不在一开始追求完整平台化。
- `Clear responsibility boundaries`: follow Foundation and Architecture instead of growing one component into another product or runtime.
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
