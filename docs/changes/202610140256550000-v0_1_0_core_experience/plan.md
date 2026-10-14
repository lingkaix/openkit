---
type: change-plan
status: planned
date: "2026-10-14"
branch: main
---
# v0.1.0 Core Product Experience

This record preserves the source intent, the engineer's rulings and the working checkpoint for four features that the engineer wants before `v0.1.0`: the redesigned Chat Mode, one retrieval mechanism, Artifacts of any file type, and the Worker's view of Workspace data.

It adds no design authority. Each feature needs an accepted owner amendment before production code under AUTH-001.

[Chat Mode And Core Assistant](../../specs/20260704-chat_mode_assistant.md), [Quick Chat Workspace](../../specs/20260709-quick_chat_workspace.md), [Internal Agent Runtime](../../specs/20260813-internal_agent_runtime.md), [Agent Runtime Context Management And Compaction](../../specs/20260902-agent_runtime_context_compaction.md), [Personal Memory And Knowledge Learning](../../specs/20260909-personal_memory_and_knowledge_learning.md), [Knowledge Store Implementation](../../specs/20260703-knowledge_store_implementation.md), [Work Resource Interaction Model](../../specs/20260713-work_resource_interaction_model.md), [Session-Static Workspace Materialization](../../specs/20260704-session_static_workspace_materialization.md), [NanoHost Workspace Data Boundary](../../specs/20260801-nanohost_workspace_data_boundary.md) and [Workspace Data Source Catalog](../../specs/20260704-workspace_data_source_catalog.md) are the current owners that the work will amend.

The release work in [v0.1.0-rc.6 Pre-Release](../202610131730000000-v0_1_0_rc_6_prerelease/plan.md) runs in parallel and is outside this plan.

## Intent

### Intent Revision 1 — 2026-10-14

Source: the engineer's messages to the coordinator on 2026-10-14. The first message named six goals for the next release. The engineer later moved goals 3 and 6 to rc.6 and kept goals 1, 2, 4 and 5 here.

Goal 1, verbatim, with one local research path replaced by `[an uncommitted research report]`: "重设计的 chat mode 的落地。 [an uncommitted research report] 我已经写了一份调研报告，基本的设计方向是清楚了，细节还需要确认。（另外, 是否可以把我们的nanocore内置的  agent loop 统一做成 rolling context window 的设计？)"

Faithful English translation: "Land the redesigned Chat Mode. I wrote a research report; the basic design direction is clear, and details still need confirmation. (Also, can we make NanoCore's built-in agent loop use one rolling context window design?)"

Goal 2, verbatim: "一个用于索引和检索知识库、workspace当中的数据、artifacts以及对话记录等等的检索引擎。 file-based / 文本检索 / 多模态RAG / OCR? 默认当前文件夹 / 可以指定目录 参考或直接使用，比如： https://github.com/zvec-ai/zvec-grep https://github.com/microsoft/tgrep https://github.com/dmtrKovalenko/fff https://github.com/quickwit-oss/tantivy"

Faithful English translation: "A retrieval engine that indexes and searches the knowledge base, Workspace data, Artifacts, conversation records and similar data. File-based, text retrieval, multimodal RAG, OCR? Default to the current folder; allow a named directory. Use as reference or directly, for example zvec-grep, tgrep, fff and tantivy."

Goal 4, verbatim: "Artifacts 允许接收不局限具体类型的文本与二进制文件，允许用户上传与下载任何文件类型的。 文本与二进制文件。nano server 应保证 server 有足够的 storage 空间。压缩包格式制定为 zip，大小限制在 1GB 以下。"

Faithful English translation: "Artifacts accept text and binary files of any type, and users can upload and download files of any type. The NanoCore server must make sure that it has enough storage space. The archive format is zip, and the size limit is below 1 GB."

Goal 5, verbatim: "重新审视和完善沙盒当中的 worker 如何看到 workspace 当中的数据的机制，包括其他沙盒当中的 worker 所创建的 artifact、用户上传的文件以及关联的 git repository。 以及将来的我们的 workspace 还可以从 S3 及各种 cloud storage 上映射存储&数据。"

Faithful English translation: "Re-examine and improve how a Worker in a Sandbox sees Workspace data, including Artifacts created by Workers in other Sandboxes, files the user uploaded, and linked Git repositories. In the future a Workspace can also map storage and data from S3 and other cloud storage."

The engineer's later message, verbatim: "剩下的新功能的开发工作包括一二四五，它们其实是相关的，目标都是在0.1版本发布之前，为用户提供一个完整的产品体验。现在还缺少一些最基本的功能和features。之所以我们需要一个检索引擎，是因为 如果我们的 artifact 允许多种文件类型上传，也允许用户上传多种文件（By the way，1GB的限制，我指的是单次上传），还有我们新 设计的 chat mode 需要 agents 能够检索历史对话，还有我们的 knowledge base，希望能够有一个更有效的信息检索工具，因此，我希望能够像我们的 Policy Kernel 那样，有一个统一的检索机制和工具可用。"

Faithful English translation: "The remaining feature work is goals 1, 2, 4 and 5. They are related, and they all aim to give users a complete product experience before the 0.1 release. Some of the most basic functions and features are still missing. We need a retrieval engine because Artifacts will accept uploads of many file types, users will upload many kinds of files (by the way, the 1 GB limit means one upload), the newly designed Chat Mode needs agents to search past conversations, and our knowledge base needs a more effective retrieval tool. So, like our Policy Kernel, I want one unified retrieval mechanism and tool."

Outcome: before `v0.1.0`, a user has a complete basic experience: a persistent personal Assistant in each Workspace, one retrieval mechanism over conversations, Knowledge, Artifacts and uploads, Artifacts and uploads of any file type, and Workers that can see the Workspace data they are allowed to use.

Acceptance observations are not yet fixed. They come from the accepted owner amendments.

Effect boundary: design, research and local work only until owner amendments are accepted. No push, publication or deployment change is authorized by this plan.

## Engineer Rulings

Each ruling below was given on 2026-10-14 in the coordinator conversation. Each one lands in its owner through an amendment and, where it sets a rule, a decision record.

1. Default personal Workspace. Verbatim: "我们为用户提供一个默认的个人 workspace，我认为这个没有问题。" and "同意你的建议，去掉 quick check workspace 这个特殊类型，转而使用 personal 这个 workspace 类型，正好我们可以利用 workspace type 这个字段值。" Translation: "Giving each user a default personal Workspace is fine." and "I agree with your suggestion: remove the special Quick Chat Workspace type and use a `personal` Workspace type instead; we can reuse the Workspace type field for this." The coordinator's proposal that the engineer accepted: a personal Workspace is an ordinary Workspace with full Task, Goal, Artifact and Sandbox capability; its only special rule is that its one member is its owner; existing `quick-chat` Workspaces move to `personal` by a one-way migration with their Threads and Knowledge kept; the administration entry moves to the personal Workspace; the `quick-chat` kind and its guards are removed. Revisit when a user needs to share a personal Workspace.
2. No result-card mechanism in Chat Mode. Verbatim: "这个 chat mode 当中的结果卡片 我们的设计逻辑应该是这样，用户可能会指派 assistant 来派发一个任务，那么 assistant 就只管派发。用户可以在下面的 thread list 当中看到 task mode 和 goal mode 的相关的信息；如果用户是在询问某一个任务或者目标的状态，Assistant就去查询，然后告知用户。也就是说，这里没有一个额外的结果卡片的机制。 不需要主动提供任何的信息。所有的 response 都是用户触发的。将来在这个 timeline 当中，我们可以使用 generative UI 来生成更漂亮的数据和信息的展示，包括。 某一个任务或者目标的状态和结果，但是这不是一个特殊的机制。" Translation: "For result cards in Chat Mode, the design logic is this: the user may ask the Assistant to dispatch a Task, and the Assistant only dispatches it. The user sees Task Mode and Goal Mode information in the Thread list. If the user asks about the state of a Task or Goal, the Assistant queries it and tells the user. There is no extra result-card mechanism. The Assistant offers no information proactively. Every response is triggered by the user. Later, the timeline can use generative UI to show data and information better, including the state and result of a Task or Goal, but that is not a special mechanism." Revisit when a product need for proactive notification appears.
3. One unified retrieval mechanism. Verbatim: "检索。你的设计的方向是正确的，就按这个去做。 注意，我们的设计方向，向量检索的话，是多模态的向量检索，这一点请参照zvec-grep and https://github.com/Tencent/WeKnora。 OCR反倒是比多模态向量更靠后的部分，仅使用在多模态检索效果十分差的特定场景之下。" Translation: "Retrieval: your design direction is right; do it that way. Note that our direction for vector retrieval is multimodal vector retrieval; refer to zvec-grep and Tencent WeKnora. OCR comes after multimodal vectors and is used only in specific cases where multimodal retrieval works very badly." The direction the engineer accepted: a domain-free Retrieval Kernel like the Policy Kernel, with source adapters at the edge; the caller passes the readable scopes and the kernel filters before ranking and never authorizes; index data is derived and can be rebuilt; one Rust program built on tantivy serves as a NanoCore library or service, a CLI that defaults to the current directory and accepts a named directory, and an MCP tool; the first phase is lexical retrieval with Chinese and Japanese word segmentation, exact and regular-expression match, and text extraction from text-bearing formats; multimodal vector retrieval comes next; OCR comes last and only where multimodal retrieval fails badly. Revisit when a measured retrieval failure defeats the lexical-first order.
4. Upload limit. Verbatim: "1GB的限制，我指的是单次上传". Translation: "The 1 GB limit means one upload."
5. Assistant Memory scope. Verbatim: "对于这个新的 chat agent 的 memory 的部分，我们现在只落地 user scope 的 memory，也就是说 memory 是跟随 user 生效的。 Server和workspace这两个scope内，我们的个性化信息主要留存在knowledge base当中。" Translation: "For the Memory of the new chat agent, we now implement only user-scope Memory; Memory follows the user. In the Server and Workspace scopes, personalized information stays mainly in the knowledge base." Revisit when Knowledge cannot serve a Workspace-scoped personalization need.
6. Retrieval design accepted, simplest first. Verbatim: "我同意你的这个搜索引擎的设计。我们先做一个最简单的实现，能够把最基本的功能提供给客户。至于 Pi AI 没有 embedding 接口的问题，等到我们实现多模态检索的时候，再来处理。" Translation: "I agree with your retrieval engine design. We first build the simplest implementation that gives customers the most basic functions. The problem that pi-ai has no embedding interface waits until we implement multimodal retrieval." Phase 1 is therefore the smallest lexical implementation over the four sources; the Gateway embedding question belongs to the multimodal phase. Revisit when the basic implementation cannot serve a named source or query.

## Working Checkpoint — Rewritable

This checkpoint is rewritable and is not authority.

| Topic | Current state |
| --- | --- |
| Chat Mode | Settled by rulings 1, 2 and 5. Still to confirm with the engineer: one private Assistant Timeline per user and Workspace with no user-created private chat Threads; one durable rolling context window for every NanoCore internal role in place of the unimplemented Gateway compactor; a personal Workspace that cannot add members. Current code calls the Provider directly, sends the whole Thread history, passes no Tools, and routes by regular expressions ([#192](https://github.com/lingkaix/openkit/issues/192)) |
| Retrieval | Direction settled by ruling 3. The researcher report (uncommitted, 2026-10-14) supports the order and recommends Tantivy with Chinese and Japanese segmentation, a separate exact and regular-expression scan, bounded extraction in a subprocess, and, for phase 2, one multimodal embedding model with a local vector store. Two of its findings were checked against source: stock pi-ai 0.99.2 has no embedding operation, and WeKnora skips image vectors for scanned PDF pages because OCR text serves dense text better. A writer is drafting the Draft Retrieval Kernel specification on branch `v010/retrieval-kernel-spec`; Consultant review follows. It also replaces the Knowledge JSON index and fixes [#222](https://github.com/lingkaix/openkit/issues/222) |
| Artifacts | Ruling 4 sets one upload at most 1 GB. Still to discuss: storage form, folder handling, per-Turn Worker output bound, free-space reserve, review of binary content. Current limits: UTF-8 Markdown, text or JSON only, 16 MiB per Worker Turn ([#190](https://github.com/lingkaix/openkit/issues/190)) |
| Workspace data view | Not yet discussed in detail. The coordinator proposed a read-only, digest-addressed view per Turn with Artifacts, uploads, Git checkouts, Knowledge and a prebuilt index, and a future `sources/` mount point for object stores |

Next action: dispatch the retrieval researcher; discuss Artifacts and the Workspace data view with the engineer; then draft the owner amendments for independent Consultant scrutiny.
