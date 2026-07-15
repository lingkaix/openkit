# Contract Freeze Scope（当前阶段契约冻结清单）

Status: Draft
Date: 2026-07-13
Review: pending team review

## 1. 目的与使用方式

咨询式部署在即（首批 1-2 个客户项目）。一旦系统进入客户环境，数据模型、存储格式、导出格式和嵌入客户 BWM Skill Package 的接口，每一次破坏性变更的代价都会乘以客户数。本文档列出**当前阶段必须设计并冻结的全部契约**，作为对照清单：逐项检查哪些已定形、哪些还缺失或不稳定，然后逐一补齐。

本文档 owns：冻结项清单、每项的冻结内容与 scope、当前状态、缺口、生效门禁。

本文档 does not own：各契约的具体设计（归 `docs/core/` 各语义文档与 `docs/specs/`）、契约演进与判定规则（归 [`docs/core/contract-evolution.md`](./core/contract-evolution.md)）、实现排期。

使用方式：

1. 对照第 3 节总览表，确认每项状态。
2. 每个缺口开一份 `docs/specs/YYYYMMDD-*.md` 设计 spec，完成后回填状态。
3. 全部 P0 项定形后，宣布 baseline freeze，此后 Tier F 变更走 major 版本 + 迁移方案。

## 2. 冻结判定标准与稳定性分级

一项契约满足以下任一条即应入本清单：

1. 变更会破坏已部署客户的数据或历史（数据模型、存储格式、导出格式）。
2. 会被嵌入客户 BWM Skill Package 或被外部 coordinator 依赖（变更代价 × 客户数）。
3. 是 OpenKit 与 BWM 两侧共享的语义（身份、风险分级、审计），单侧修改会造成语义分叉。

稳定性分级：

| Tier | 含义 | 变更规则 |
| --- | --- | --- |
| **F（Frozen）** | 语义与格式冻结 | 破坏性变更需 major 版本 + 迁移方案 + 双人确认 |
| **S（Stable）** | 稳定但可演进 | 需弃用周期与公告，兼容窗口内共存 |
| **E（Experimental）** | 自由迭代 | 明确标注，外部不得依赖 |

核心原则：**冻结的是"形"（schema、格式、语义），不是实现时间。** 字段可以先占位、单用户模式下填默认值，机制后置实现。这正是"tenancy pre-pass"的含义——先把身份和归属字段放进协议，多用户机制以后再做。

## 3. 总览对照表

状态图例：✅ 已定形 ｜ 🟡 部分（语义有、schema/门禁缺）｜ ❌ 缺失

| # | 契约 | 优先级 | 目标 Tier | 语义设计 | Schema/格式落地 | 机器门禁 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Actor 身份与租户字段 | P0 | F | ✅ identity.md | ❌ 协议无字段 | ❌ |
| C2 | 核心协议对象语义 | P0 | F | ✅ protocol.md | ✅ 已实现 | 🟡 未宣布 v1 冻结 |
| C3 | Workspace Export/Import 格式 | P0 | F | ✅ spec 20260704 | ✅ v2 已实现 | ❌ 无跨版本兼容门禁 |
| C4 | OpenKit↔BWM Hosting Contract | P0 | F | 🟡 仅外部草案 | ❌ | ❌ |
| C5 | Secret 声明与注入模型 | P0 | F | ✅ vault.md | 🟡 缺 manifest 对接 | 🟡 |
| C6 | Action 风险分级 L0-L4 与审批语义 | P0 | F | 🟡 两侧各有一半 | ❌ 未统一 | ❌ |
| C7 | 审计链语义 | P0 | F | ✅ audit.md | 🟡 缺版本戳/交叉引用 | ❌ |
| C8 | BWM Spec Envelope 与 semver | P1 | F | 🟡 BWM doc 04 §5 | ❌ | ❌ |
| C9 | Action Contract 必备字段集 | P1 | F | 🟡 BWM doc 04 §7 | ❌ | ❌ |
| C10 | App API 与 MCP 工具面分级 | P1 | S | 🟡 app-api.md | ❌ 无 stable 子集标注 | ❌ |
| C11 | 存储所有权 scope 与 JSONL canonical | P1 | F | ✅ storage.md | ✅ 已实现 | 🟡 |
| C12 | Knowledge/Evidence 分界与 provenance | P1 | F | 🟡 knowledge.md + OKF | 🟡 | ❌ |
| C13 | 稳定标识符策略 | P2 | F | ❌ | 🟡 事实存在未成文 | ❌ |
| C14 | 时间语义声明位 | P2 | S | 🟡 BWM doc 03 §5.5 | ❌ | ❌ |
| C15 | 兼容性元政策（支持窗口/升级流程） | P2 | S | 🟡 contract-evolution.md | ❌ 无具体数字 | ❌ |

> 状态基于 2026-07-13 对仓库的快查（`docs/core/` 文档状态、`packages/protocol/src/models/` grep、`docs/specs/` 清单），团队应复核。

## 4. P0 —— 第一个客户部署前必须定形

### C1. Actor 身份与租户字段（Identity / Tenancy Pre-pass）

**目的**：单租户改多租户是最昂贵的改造，且几乎必然破坏 schema。现在不冻结身份字段，"先稳定、后多租户"两个目标会互相矛盾——之后加租户就是我们想避免的那次大迁移，而且砸在首批客户头上。

**冻结内容**：

- 每条 Item、Turn、approval、audit、action log 记录必须携带 `actor` 字段：actor id + actor type（user / agent / automation / integration，取 identity.md 的分类）。消息的 `role`（user/assistant）不等于 actor 身份，二者并存。
- Workspace 与 Thread 记录携带 ownership scope 字段（归属的 user / 未来的 tenant）。
- Tenant id 占位字段（单租户部署填固定默认值）。
- 成本归属（cost attribution）占位字段：usage 记录可归到 actor 与 workspace。

**Scope**：owns 字段定义与默认值策略；不 owns 授权策略实现、多用户 UI、认证流程（identity.md / permissions.md 已各自 own 语义）。

**当前状态**：[`docs/core/identity.md`](./core/identity.md)（Accepted）已定义 actor context 语义，包括 automation/integration 身份。但 `packages/protocol/src/models/` 中 grep 未发现 actorId / tenantId / ownerId 字段——语义设计完成，协议 schema 未落地。

**缺口与待办**：开一份 spec 定义字段集与默认值；协议 models 增补；存储记录与 export 格式同步携带；识别既有数据的回填策略。

**门禁**：L0 lint——新增记录类型必须带 actor 字段；L2 contract test 校验字段存在与枚举合法。

### C2. 核心协议对象语义（Workspace → Thread → Turn → Item）

**目的**：这是整个系统的名词表，客户数据和 BWM package 都建在它上面。

**冻结内容**：

- 四层对象的语义与生命周期；15 种 Item variant 的语义。
- Variant 演进规则：新增 variant = minor；修改既有 variant 语义 = major；**所有消费者必须容忍未知 variant**（open enum 原则），否则每次新增都是破坏性变更。
- Turn 生命周期状态机的状态集与合法迁移。

**Scope**：owns 协议对象语义与版本规则；不 owns 存储布局（C11）、传输行为、App API 端点形状（C10）。

**当前状态**：已实现且 `packages/protocol` / `apps/nanocore` / `apps/web` 三方结构对齐（AGENTS.md 明确要求）。缺的是显式的 v1 语义冻结声明与 variant 演进规则成文。

**缺口与待办**：在 protocol.md 或新 spec 中宣布 v1 冻结边界 + open enum 规则；协议包打显式版本号。

**门禁**：L2 conformance test 以冻结的 JSON Schema 快照为基准做漂移检测（schema-drift 检查已存在于 L0，将其基准固定到 v1 快照）。

### C3. Workspace Export/Import 格式（迁移保险）

**目的**：这是对客户的核心承诺——"系统怎么变，你的数据都能带走、能升级"。它也是所有其他冻结项的兜底：万一必须做破坏性变更，export → migrate → import 是逃生通道。

**冻结内容**：

- Export 包的目录结构、记录格式、manifest 与格式版本号（显式的 `formatVersion`）。
- 兼容承诺：**版本 N 必须能 import 版本 N-1 与 N-2 的 export**。
- Remint / digest 语义（已在 v2 实现中）。

**当前状态**：[`docs/specs/20260704-workspace_backup_export_import.md`](./specs/20260704-workspace_backup_export_import.md) + v2 实现已完成。

**缺口与待办**：格式版本号显式化；把兼容承诺写成永久门禁——为每个 shipped tag 保存 export fixture，release gate 中跑"旧 fixture import 到 HEAD"矩阵测试。

**门禁**：L2/L3 兼容矩阵测试进 `verify:release`，任何使矩阵变红的变更即为破坏性变更。

### C4. OpenKit ↔ BWM Hosting Contract（接缝契约）

**目的**：第一个客户踩的恰好全是这条缝。它会被嵌入每一个客户 package，事后变更代价最高。这是清单中唯一接近"从零"的 P0 项。

**冻结内容**（六件）：

1. **Skill Package Manifest 格式**（`bwm.manifest.json`）：package id、customer/workspace scope、schema version、生成它的 Meta-Skill 版本、required credential scopes、required data stores、required network/API domains、risk policy defaults、兼容的 OpenKit capability 版本。
2. **Sandbox capability 声明与协商**：package 声明所需能力，OpenKit 声明所提供能力，装载时做版本协商，不匹配即拒绝装载并给出可读原因。
3. **Skill 装载与版本治理语义**：workspace/thread 级的 package 版本选择、运行时记录（装载了哪个 skill version + schema version + action code version）、回滚与冻结某客户版本。
4. **审批路由 payload**：L3/L4 action 提交 Action Center 的请求/响应结构（action id、risk tier、evidence refs、决策、决策者 actor、时间）。
5. **Audit projection 接口**：BWM action log 投影进 OpenKit audit 的记录 schema 与双向 ID 引用（"聚合不替代"，见 C7）。
6. **Secret scope 握手**：manifest 中的 credential scope 声明 → OpenKit vault 注入的对接（见 C5）。

**Scope**：owns 接口与格式；不 owns BWM 业务词汇表（C8 只管信封）、Meta-Skill 实现、sandbox 实现机制。

**当前状态**：BWM doc 04（外部草案，位于 `~/Documents/AI/docs/Business World Model/`，未入仓）有设计；OpenKit 侧 [`docs/core/sandbox.md`](./core/sandbox.md)、[`docs/core/audit.md`](./core/audit.md) 有相邻语义；doc 04 §12 映射表中约半数所需能力标记为 future。

**缺口与待办**：全部六件。建议先把 BWM 理论文档正式引入仓库（或按 OKF 快照模式 pin 一份），再开 hosting contract spec；做一个最小 fixture package 作为 conformance 样例与测试载体。

**门禁**：L2 contract test 以 fixture package 验证装载、协商、审批路由、审计投影全链路。

### C5. Secret / Credential 声明与注入模型

**目的**："凭证永不进入 agent context"是对客户最有力的安全承诺，其声明格式会进入每个客户 package。

**冻结内容**：credential scope 的命名规范与声明格式（manifest 内）；注入方式枚举（env / 短期 token / proxy handle）；vault-use 审计记录字段；轮换与吊销语义。

**当前状态**：[`docs/core/vault.md`](./core/vault.md)（Accepted）已定义注入边界与"secret 不入 prompt/knowledge/artifact/log"规则；vault key-file 后端已实现。

**缺口与待办**：scope 命名规范与 C4 manifest 对接；注入方式枚举成文。

**门禁**：L2 测试——注入后扫描 item/knowledge/artifact/audit 无明文泄漏；lint 校验 manifest scope 命名。

### C6. Action 风险分级（L0-L4）与审批语义

**目的**：风险分级是 OpenKit 审批机制与 BWM policy 的共同语言。不统一就会出现两套分级、两种审批语义，审计无法解释"为什么这个动作放行了"。

**冻结内容**：

- L0-L4 分级定义与默认行为表（采 BWM doc 04 §6：L0 读取/草稿自动、L1 本地派生写入自动留痕、L2 可回滚低风险外部调用默认自动可抽检、L3 客户可见变更需审批或成熟策略、L4 不可逆/高合规默认禁止）。
- 审批记录语义字段：risk tier、依据的 policy、决策（approve/reject/defer/refine）、决策者 actor、时间。
- 自治度晋级所需的统计字段占位（某 action 连续 N 次人审通过率）——机制后实现，字段先冻结。

**当前状态**：OpenKit 有 approval items 与 policy-kernel（NGAC）；BWM 文档有 L0-L4；两者尚未统一为一份 vocabulary。

**缺口与待办**：一份 risk tier vocabulary spec，让 [`docs/core/permissions.md`](./core/permissions.md) 与 BWM package policy 共同引用；一个风险模型、两个执行点（OpenKit 治理面 + package policy 检查）。

**门禁**：L0 lint——任何 action / approval 记录必须携带合法 risk tier。

### C7. 审计链语义（可从任一端完整重建）

**目的**：客户第一次质疑"AI 为什么做了这件事"时，必须能给出完整因果链。双系统（OpenKit audit + BWM action log）若各持一半真相，等于没有审计。

**冻结内容**：

- 审计记录最小字段集：actor（C1）、发生时的 spec/schema 版本戳、evidence refs、关联的 approval 记录、external call summary（redacted）、state change。
- 分工规则：BWM action log 是业务动作的事实记录，OpenKit audit projection 聚合它而不替代它；两侧记录持有对方 ID 形成交叉引用。
- 重建保证：从任一端出发都能重建完整链条。

**当前状态**：[`docs/core/audit.md`](./core/audit.md)（Accepted）语义清晰。缺版本戳字段、与 BWM 侧的交叉引用字段、重建测试。

**缺口与待办**：字段增补 spec；与 C4 第 5 件联合设计。

**门禁**：L6 story——对 fixture package 的一条 L3 动作，分别从 OpenKit audit 与 BWM action log 出发重建全链并比对一致。

## 5. P1 —— 第一个客户交付期间定形

### C8. BWM Spec Envelope（`bwm.schema.json` 信封与 semver）

冻结**信封**而非词汇表：九个 section（objects / links / evidence rules / states / goals / actions / effects / policies / audit fields）的结构、必备元数据（schema version、生成来源）、semver 语义（major = 对象/状态/action contract 语义变更；minor = 增补；patch = 文档与非语义字段——BWM doc 04 §5 已草拟）、"spec version 必须进 audit"规则。各行业/客户的具体词汇表明确**不**冻结。建议按 [`docs/okf-spec-v0.1-snapshot.md`](./okf-spec-v0.1-snapshot.md) 的快照模式管理 BWM 理论文档版本。

### C9. Action Contract 必备字段集

把 BWM doc 04 §7 的字段清单（actionId、riskLevel、input/outputSchema、requiredEvidence、preconditions、allowedActorRoles、approvalPolicy、idempotencyKey、dataAccess、externalApiScopes、sideEffects、successCriteria、failureHandling、compensationOrRollback、auditFields、businessEffects）定为 required / optional 两档并冻结 required 集。Meta-Skill 的 lint 门禁（"每个动作必须声明审批策略 + 回滚 + 幂等"）依赖这份字段集才能成立。

### C10. App API 与 MCP 工具面分级

约 100 个 MCP 工具全部承诺稳定不现实。冻结内容：一份 **core stable 子集**标注（建议 30 个以内：workspace/thread/turn/item 读写、goal mode 主干、approval、artifact、export/import），其余标 experimental；工具与端点的弃用周期（公告 → 共存 → 移除的最短窗口）；命名规范。当前 [`docs/app-api.md`](./app-api.md) 与 MCP catalog 存在，缺分级标注与 deprecation policy。门禁：L0 检查工具注册必须带 stability 标注。

### C11. 存储所有权 scope 与 JSONL canonical 地位

[`docs/core/storage.md`](./core/storage.md) 与实现已就位（core/user/workspace sqlite 按 ownership 划分 + canonical JSONL + index rebuild）。补两条并冻结：**JSONL 记录格式是数据的最终事实源**，其格式变更等同 export 格式变更，走同样的兼容门禁（它决定十年后数据还能不能读）；哪类数据落哪个 scope 的分配表成文。SQLite/Postgres 等引擎选择明确不冻结（adapter 可换，契约不变）。

### C12. Knowledge / Evidence 分界与 provenance 字段

冻结分界规则：**客户业务事实只进 BWM package DB（带 evidence 链：source / confidence / 推断方式）；OpenKit knowledge 只放工作方法、偏好、流程经验。** 不立此规则，业务事实迟早被倒进 OpenKit memory，两侧都被污染。同时给 knowledge 条目冻结 provenance 字段占位（source、confidence），与 OKF v0.1 快照对齐。BWM doc 04 §10 的"memory 只能提案、不能改 truth source"规则一并采纳为冻结语义。

## 6. P2 —— 第二个客户之前定形

### C13. 稳定标识符策略

ID 生成方式、命名空间划分、跨 export/import 的稳定性保证（remint 规则何时改 ID、何时保 ID）、为未来 RDF/IRI 升级预留的命名整洁度。当前事实上存在但未成文。

### C14. 时间语义声明位

在协议与 BWM schema 中给属性提供声明位：valid-time（现实有效期）还是靠 audit log 重建（system-time）——语义取 BWM doc 03 §5.5。只冻结"声明位"的存在与含义，各属性的具体标注随模型演进。

### C15. 兼容性元政策

[`docs/core/contract-evolution.md`](./core/contract-evolution.md) 已 own 演进判定；补具体数字并冻结为运营承诺：版本支持窗口（建议 N-2）、客户部署 pin tag 规范、升级 runbook、弃用公告渠道与最短周期、每个 Tier F 变更必须附 migration 与双人确认。

## 7. 明确不冻结（Explicitly Not Frozen）

以下部分保持 Experimental / 自由迭代，理由：其变更不破坏已部署数据，也不嵌入客户 package 接口。

- Goal Mode 内部编排与 coordinator 策略
- Web UI 全部（跟随稳定 API）
- 存储引擎与 adapter 实现（SQLite/Postgres/DuckDB 选型；契约不变即可换）
- Meta-Skill 的实现方式（v1 方法论 + 模板 + lint 脚本，编译器后置）
- Generative Kernel 的实现路径
- Scheduler 内部机制、worker 运行时细节
- 模型 / provider 选型与路由策略
- BWM 各行业与客户的具体词汇表（信封之下的内容）

## 8. 生效门禁（冻结如何被机器强制）

宣布冻结而没有机器门禁，等于没有冻结。落地方式沿用现有 L0-L6 体系：

| 层 | 新增检查 |
| --- | --- |
| L0 | schema lint：actor 字段（C1）、risk tier（C6）、stability 标注（C10）、manifest scope 命名（C5） |
| L2 | 协议 JSON Schema 漂移基准固定到 v1 快照（C2）；hosting contract fixture 一致性（C4）；secret 无泄漏扫描（C5） |
| L2/L3 | export/import 跨版本兼容矩阵（C3、C11），fixture 随每个 shipped tag 归档 |
| L6 | 审计链双端重建 story（C7） |
| 发布 | `verify:release` 增加 freeze-guard 步骤：上述全绿方可打 tag；audit 记录带 spec version 戳 |

流程约定：每个缺口项 → 开 `docs/specs/` 设计 spec → 实现与门禁 → 回填第 3 节状态表。Tier F 项的破坏性变更需要 major 版本、迁移方案与第二人确认。

## 9. 相关文档

- [`docs/core/contract-evolution.md`](./core/contract-evolution.md) — 契约演进与判定规则（本清单的上位规则）
- [`docs/core/identity.md`](./core/identity.md) / [`docs/core/permissions.md`](./core/permissions.md) / [`docs/core/audit.md`](./core/audit.md) / [`docs/core/vault.md`](./core/vault.md) / [`docs/core/sandbox.md`](./core/sandbox.md) / [`docs/core/storage.md`](./core/storage.md) / [`docs/core/knowledge.md`](./core/knowledge.md) / [`docs/core/protocol.md`](./core/protocol.md)
- [`docs/specs/20260704-workspace_backup_export_import.md`](./specs/20260704-workspace_backup_export_import.md)
- [`docs/okf-spec-v0.1-snapshot.md`](./okf-spec-v0.1-snapshot.md) — 外部格式快照管理的先例
- Business World Model 理论文档（外部：`~/Documents/AI/docs/Business World Model/`，doc 03 工程架构、doc 04 嵌入式 package 架构）——建议正式引入仓库或按快照模式 pin
- [`docs/product-vision.md`](./product-vision.md) / [`docs/roadmap.md`](./roadmap.md)
