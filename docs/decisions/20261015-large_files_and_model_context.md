---
status: Accepted
date: "2026-10-15"
decider: Engineer, with details delegated to the coordinator and independent Consultant agreement
---
# Large Files And Model Context

## Decision

OpenKit separates three accounting domains: raw model output, file storage and transfer, and model-context and transport budgets. Original bytes remain with their canonical owner. Models receive bounded representations and retrieve or reference additional content on demand. This applies to Workers and NanoCore internal agents.

The coordinator adopts every correction and all six decisions in the independent Consultant report. Where the synthesis differs, the Consultant report governs. The synthesis's older numeric proposals and metadata-only delivery phase are superseded. The following values are current accepted defaults, subject to measured qualification; they are not claims about current enforcement.

### Raw Model Output

The per-Turn Worker ceiling is 16 MiB, exactly 16,777,216 bytes of UTF-8 emitted content fields. It includes intermediate and final generated text, generated tool-call argument text, and stored exposed reasoning. It excludes transport envelopes, escaping overhead, duplicate final snapshots, uploaded bytes, tool results, and program-produced file bytes. OpenKit does not acquire hidden reasoning for accounting.

Meter emissions before truncation or conversion to a file. A model emitting a 20 MiB file body in tool arguments exceeds this ceiling. Writing those already-counted arguments to disk adds no charge. A short generated program consumes its generated code and arguments; the resulting large file consumes file capacity. Newly generated summaries or repeated answers count as new output.

Use one atomic Turn aggregate across concurrent children and all observed provider attempts. Deduplicate by trusted attempt, emission/content-part identity, and stream position. Equal text or equal file digests do not establish duplicates. A genuinely new attempt counts again. Mechanical forwarding of a child result adds no model emission. Count observed failed-attempt output before retry buffering discards it. Billed but unobserved generation remains cost accounting.

Persist the count and deduplication evidence through the existing Turn recovery owner. Reconnect, adoption, and restart cannot reset capacity. Exhaustion uses the existing `budget_exhausted` stop outcome after proved stop; incomplete over-limit arguments cannot execute. Uncertain stop retains the existing failure and fencing rules. An unobservable inference or child route cannot claim enforcement and must remain blocked for dependent work until qualified.

### File Storage And Transfer

The limit is 1,000,000,000 decimal bytes per upload submission and per Worker-produced file. Unsent uploads remain client drafts without cross-device recovery. Successful submission retains them as Turn-owned inputs; explicit direct Artifact import remains a separate operation. It is not a cumulative Turn file quota. Store arbitrary-byte originals through existing Artifact/upload owners, with streamed capture, exact size, declared and observed media facts, and SHA-256. Preserve immutable versions, current authorization, review, receipts, and exact replay.

ZIP extraction has ceilings of 4,000,000,000 actual expanded bytes and 100,000 entries. Count streamed bytes and entries, not advertised headers. Reject traversal, absolute paths, links, special files, and normalized-path collisions. Extract into isolated staging. Disable automatic recursive extraction. If nested extraction is explicitly admitted, all nesting shares one cumulative byte, entry, and resource budget.

Bound processing CPU/time, memory, and temporary disk. Admission protects one configurable server reserve plus worst-case current writes and existing in-flight reservations. Those reservations cover concurrent staging, extraction, derivatives, and publication overlap. A current-free-space check alone is insufficient. Record measured reserve and processor defaults before release. Storage exhaustion rejects affected new work and preserves accepted bytes. Encoded/decoded transport, frame, parser, diagnostic, and timeout guards remain separate.

### Model Context And Exact Reads

Text previews contain at most 2,048 UTF-8 bytes or 50 lines. Requested reads contain at most 51,200 bytes or 2,000 lines. Whichever cap binds first applies. Bound serialized envelopes, aggregate search/list responses, inventories, and the complete model request independently. Reserve room for identity, status, continuation, and errors.

Use model-specific token budgets independently of byte caps. Include instructions, history, Tool schemas, media cost, and output reserve in request admission. Bytes divided by four is not a hard token oracle. Continuation must advance through huge single lines, preserve UTF-8 boundaries, and bind source revision, representation, and exact range. Report omitted ranges and coverage. Invalid text cannot silently acquire replacement bytes under the original digest.

Return a bounded unavailable/error descriptor when saving, processing, or retrieval fails. Do not promise an unavailable handle or fall back to a full body. Search completeness applies only to the named searchable representation. A metadata-only match cannot prove absence in an unsupported body.

### Per-Turn Snapshot And Disclosure

Eagerly materialize only selected, currently authorized bytes into a digest-verified, read-only Turn snapshot through existing materialization owners. Keep writable work, scratch, and outputs separate. Do not add lazy hydration or a new source store. Large bytes use the data plane rather than the Task request.

A running Turn retains its admitted local snapshot. This does not freeze authorization for subsequent OpenKit operations. Search, reads, downloads, history, and exports recheck current source access and destination disclosure. A later Turn cannot inherit a revoked snapshot through an old mount. Previews, names, digests, snippets, counts, and diagnostics are disclosures. Filter before generation access and ranking, not only before returning hits. Personal Memory remains unavailable to Workers.

### v0.1.0 Media And Harness Scope

v0.1.0 includes PDF text-layer extraction and an explicitly requested bounded vision view. Isolated, bounded processors outside the domain-free Retrieval Kernel produce versioned sidecars. Each sidecar binds the original digest, processor identity/version/output-changing configuration, its own digest, page locators, and coverage. Scanned, encrypted, failed, or resource-limited PDFs report unavailable, unsupported, or incomplete content; they never establish complete body absence.

Bound image pixels, frames, decoded memory, and processing time before downscaling. Bound delivered media and provider token cost independently. Multimodal vector retrieval remains before OCR in the later roadmap. This decision selects no extractor dependency or new media editor.

User-supplied native harness configuration is allowed within existing Sandbox admission and policy. OpenKit may supply qualified native settings and bounded capabilities. It does not replace native context managers, ship context-mode code, or depend on context-mode. Preserve authored retained configuration and distinguish fresh-home defaults from effective settings in existing homes.

## Reason

The engineer's #190 ruling excludes uploads and non-LLM file production from the Worker output ceiling. It also rejects repeatedly placing entire large inputs into model context because of cost, latency, context use, and compaction effects on work quality. The engineer accepted the recommended decisions-zh.md options except the named overrides and delegated other design details to the coordinator with independent Astra Consultant agreement.

Sources: `/home/simonx/AI/temp/backlog-20261015/engineer-rulings-20261015.md` (#190, expanded delegation, and user-supplied context-mode clarification); `/home/simonx/AI/temp/research/2026-10-15-large-context/synthesis.md` (design synthesis and owner map); `/home/simonx/AI/temp/research/2026-10-15-large-context/consultant.md` (independent review, six governing corrections, and blockers). The engineer directed this owner change; it is not an agent-initiated challenge. Acceptance of the design does not qualify runtime enforcement or measured defaults.

## Rejected Alternatives

- Raise the shared 16 MiB constant for every domain: this confuses generation, file capacity, and request safety.
- Count only final assistant text: generated intermediate text, tool arguments, children, and observed failed attempts could evade the bound.
- Deduplicate equal text or file digests: this would erase genuinely new emissions.
- Inline a large body after retrieval or spill failure: this defeats context admission and can disclose unbounded content.
- Keep whole-page-only Knowledge delivery or bytes/4 admission: these prevent useful bounded projections or misstate model token capacity.
- Put media extraction inside the Kernel, or retain a metadata-only first delivery phase: the former breaks domain independence; the latter omits accepted v0.1.0 PDF and vision scope.
- Replace harness context managers, bundle context-mode, or add a parallel source registry: existing source, retrieval, and configuration owners serve the need.

## Revisit When

Revisit numeric defaults when measured supported workloads show insufficient capacity or unsafe resource use. Revisit processor scope only with measured coverage, safety, and task-quality evidence. Revisit uniform enforcement claims when a new route or harness changes emission observability. A new storage service, lazy hydration path, or changed media ordering requires an accepted owner decision.

## Affected Owners

- [Worker Turn Reliability](../specs/20260531-worker_turn_reliability_envelope.md), [Worker Communication](../specs/20260629-worker_runtime_communication_model.md), and [Sub-Agent Provenance](../specs/20260711-worker_runtime_subagent_provenance.md).
- [Work Resource Interaction](../specs/20260713-work_resource_interaction_model.md), [Context Package](../specs/20260703-worker_context_package.md), and [Retrieval Kernel](../specs/20261014-retrieval_kernel.md).
- [Session Materialization](../specs/20260704-session_static_workspace_materialization.md), [Source Catalog](../specs/20260704-workspace_data_source_catalog.md), [NanoHost Data Boundary](../specs/20260801-nanohost_workspace_data_boundary.md), and [Persistent Volumes](../specs/20260910-persistent_worker_volumes.md).
- [Internal Runtime](../specs/20260813-internal_agent_runtime.md), [Chat Mode](../specs/20260704-chat_mode_assistant.md), [Knowledge Manager](../specs/20260704-knowledge_manager_internal_agent_runtime.md), [Coordinator](../specs/20260704-workflow_coordinator_internal_agent.md), and [Context Management](../specs/20260902-agent_runtime_context_compaction.md).
- [Knowledge](../core/knowledge.md), [Knowledge Store](../specs/20260703-knowledge_store_implementation.md), and [Knowledge Governance](../specs/20260702-knowledge_store_governance_rules.md).
- [Storage](../core/storage.md), [Protocol](../core/protocol.md), [Permissions](../core/permissions.md), [Storage Layout](../specs/20260703-storage_layout_record_ownership.md), and [Backup And Export](../specs/20260704-workspace_backup_export_import.md).
- [Worker Images](../specs/20260721-worker_execution_environment_images.md) and the [Codex](../specs/20260716-codex_worker_adapter.md), [OpenCode](../specs/20260716-opencode_worker_adapter.md), [Pi](../specs/20260716-pi_worker_adapter.md), and [DeepSeek](../specs/20260930-deepseek_worker_adapter.md) adapters.
