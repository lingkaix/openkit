# Worker Context Package

Status: Accepted
Implementation: Partial

Implementation note: item projection, digest records, and standalone Knowledge materialization are implemented. Task and Goal mode services deliver the exact Coordinator-composed request, but they still lack the accepted Turn-owned immutable delivery trace defined below and do not yet bind Workspace Material revisions into that trace. Replay Reconstruction stops at digest-checked materialization readback. The G01 shared delivery-trace slice is accepted target design and remains unimplemented.

## Summary

This spec defines the task-time context package sent to worker agents.

The clean target is to stop treating context as a prompt blob. A context package is a governed, traceable projection of user input, thread state, workspace state, knowledge, sources, artifacts, policy, and runtime instructions. Workers consume the package; NanoCore owns selection, policy filtering, traceability, and storage.

This spec supersedes `docs/specs/superseded/20260702-worker_context_taxonomy.md` for active worker-facing context categories. `docs/core/knowledge.md` remains the canonical owner for Knowledge Store, Knowledge Page, Knowledge Source, Notebook, Knowledge Manager, Agent-Near Context, and the concept of a Context Package. This spec owns the concrete worker-facing package projection, package files, trace records, and implementation alignment.

## Owns

- Worker-facing context package inputs, manifest shape, materialized file layout, trace records, and replay requirements.
- Context categories used when assembling a task-time package for worker execution.
- The boundary between retrieved context candidates and context actually injected into a worker runtime.
- Package traceability across selected, excluded, summarized, and policy-filtered material.
- The current implementation projection for provider-visible context digests and attachment records.
- The one immutable worker-Turn delivery trace shared by Task Mode, Goal Mode, Work Resource Interaction, replay, and later G07 Knowledge review.

## Does Not Own

- Canonical knowledge semantics, notebook semantics, proposal lifecycle, or Knowledge Manager responsibilities.
- Final worker prompt authorship, workflow progression, task planning, or worker selection.
- Agent Capability calls for runtime retrieval after a worker has started.
- Workspace materialization, writable roots, patch review, or artifact transfer.
- Vault storage, raw secret handling, or credential injection.
- Web UI notebook interactions or domain-specific source-of-truth schemas.
- A delivery receipt, workflow, settlement lifecycle, worker acknowledgement, or claim that the model understood package content.

## Core References

- `docs/core/knowledge.md`
- `docs/core/agent-workflow.md`
- `docs/core/architecture.md`
- `docs/core/storage.md`
- `docs/core/protocol.md`
- `docs/core/agent-capability.md`
- `docs/core/vault.md`

## Goals

- Define context package inputs, files, and trace records.
- Connect Knowledge Store retrieval to worker execution without exposing the whole notebook.
- Preserve selected and excluded context decisions for audit and debugging.
- Keep context source references and digests stable enough for replay.
- Make context budget, sensitivity, freshness, and policy filtering explicit.

## Non-goals

- Do not design a full RAG stack.
- Do not let workers silently read all knowledge.
- Do not store chain-of-thought or hidden runtime reasoning as knowledge.
- Do not make artifacts a mandatory middle step for direct knowledge updates.
- Do not define Web UI notebook interactions.

## Current Implementation Projection

The current implementation is the accepted V1 context package projection:

- `apps/nanocore/src/context/llm-projection.ts` converts durable item history into provider-visible LLM messages through an explicit projection policy.
- The projection result records `policyVersion`, `contextPackageDigest`, included item ids, excluded item policy decisions, and provider messages.
- `createContextPackageRecord` creates an attachable record for `internal-agent` and `worker-turn` targets with digest, policy version, included item ids, and excluded item ids.
- Tests cover deterministic context package digests and attachment records.
- Worker-turn checkpoint storage carries the diagnostic field `contextDigest` and, for real Goal Mode worker steps, a product-safe context assembly summary containing only selected context refs and repository resource id while the step remains recoverable. Checkpoint `contextDigest` is not the accepted trace's `contextPackageDigest`, carries no queued-steering or follow-up count, and is not delivery proof.
- The real Task and Goal launch paths now deliver the exact Coordinator request as compact JSON and retain those bytes in the Turn-owned `user-message` Item, but no generic worker-turn `context-package.json` trace is persisted or delivered. The in-memory attachment record and mutable checkpoint diagnostics are not accepted Context Package delivery proof, so Goal steering must fail closed until this specification's turn-owned trace and materialization path are implemented.
- The standalone Knowledge context operation returns and persists a Knowledge-selected package-level trace and its existing App API materialization operation can write a `/openkit/context` snapshot under the Context Package and Knowledge Store owners. Those are explicit operation effects, not a Knowledge Manager private lifecycle, and they do not prove that Task or Goal Mode delivered the snapshot to a worker. The trace contains `contextPackageId`, deterministic `contextPackageDigest`, `policyVersion`, selected knowledge entry ids, selected explicit artifact ids, selected explicit workspace-owned file paths, selected explicit workspace-root file refs, selected accepted claim ids, selected unresolved conflict ids, excluded candidate count, and the effective selection budget. The same response includes selected claims, artifacts, workspace file summaries, unresolved conflicts, and a compact `knowledge-context-v1` policy summary. NanoCore appends it to `knowledge/context-packages/<YYYYMM>.jsonl`; the readback and materialization routes verify the stored package and per-file digests without assembling a prompt. The snapshot contains `package.json`, `instructions.md`, selected material files, and `policy.json`; it applies package bounds, provenance, sensitivity labels, raw-secret-shaped material redaction, and `source_unavailable` decisions. Mode services now bind the exact Coordinator-composed request, but they must still bind this snapshot into the same accepted worker Turn before claiming Context Package delivery.
- The current projection policy classifies durable items as user, assistant, artifact, approval, diagnostic, review, goal, tool, knowledge, handoff, or file-change categories. The `knowledge` category covers knowledge-derived context projection items.
- Current exclusion reasons are item-projection reasons only: `policy_excluded`, `ui_only`, `diagnostic_noise`, `artifact_pointer`, `approval_gate`, `goal_state_not_needed`, `review_context_not_needed`, `empty_content`, `sensitive_content`, and `unsupported_item_type`.

The OpenShell worker backend can upload pre-materialized read-only `materialized-dir` workspace inputs to the declared context slot, so a materialized context package can be mounted into `/openkit/context` through the same session workspace materialization path as other read-only inputs. Automatic root or artifact selection, binary root-file conversion, complete audit-only package traces beyond the readable Knowledge Manager response snapshot, full sensitivity-filter detail beyond raw-secret-shaped material redaction and manifest labels, model-specific budget accounting, and citation projection into worker outputs remain deferred future work. The Replay Reconstruction contract is implemented only up to digest-checked materialization readback; per-entry reconstruction from source references is not started.

## Context Package Role

A context package is the task-time projection that bridges NanoCore-owned workspace history and worker-visible runtime input.

It should answer:

- what the worker was asked to do
- what workspace state the worker was allowed to see
- what knowledge and sources were selected
- what artifacts or prior work were included
- what was excluded and why
- what policy and budget limits applied
- which digests prove the package content

The package hides source diversity without hiding provenance. A worker receives a coherent task package, while NanoCore preserves whether each selected piece came from a note, source file, derived representation, knowledge page, artifact, external observation, work-history record, runtime capability summary, or policy summary.

Context package preparation is not a separate internal agent. The Knowledge Manager selects, filters, cites, and prepares knowledge-derived or source-derived material. The Workflow Coordinator semantically combines authorized material with task instructions, workflow state, constraints, available capabilities, stop conditions, and review policy for a specific bounded step. The owning Task or Goal mode service persists, materializes, and delivers that decision.

## Ownership Boundary With Knowledge

`docs/core/knowledge.md` owns the canonical definition of Knowledge, Source, Knowledge Manager, Agent-Near Context, retrieval, injection, and the statement that a Context Package is a task-time projection.

This spec owns the worker-facing projection mechanics for that concept:

- concrete package categories
- materialized package file layout
- manifest fields needed by worker runtimes
- trace records for selected and excluded candidates
- digest and replay requirements
- implementation projection from current item-to-LLM context records

Knowledge-derived material is prepared by the Knowledge Manager. Semantic worker-context composition is performed by the Workflow Coordinator; the owning mode service performs persistence, materialization, and delivery. The context package is not an internal agent, not a knowledge store, and not a second source of truth.

## Knowledge, Sources, And Package Model

The active model is:

```text
Sources and work history provide evidence.
Knowledge stores reusable notebook material and reviewed interpretation.
Context packages project task-relevant context to worker agents.
```

Retrieval is not injection. Retrieved material may still be excluded by explicit task scope, policy, sensitivity, freshness, confidence, relevance, budget, or workflow state.

`Memory` is not the top-level product model. It may remain as an implementation or agent-facing legacy term until renamed, but worker context must be described through Knowledge, Sources, and Context Packages.

## Context Categories

Context packages may draw from these categories:

| Category | Package role | Knowledge relation |
| --- | --- | --- |
| Authority context | Governing task instruction, accepted plan, explicit constraints, and non-negotiable requirements. | Current-task authority does not automatically become knowledge; durable principles may become reviewed knowledge. |
| User intent context | Immediate preferences, clarifications, corrections, acceptance criteria, and review feedback. | Reusable preferences or durable corrections may become knowledge proposals. |
| Intake context | Rough notes, idea fragments, URLs, uploads, meeting notes, imported wiki pages, and integration records. | Usually source or proposal input until curated by Knowledge Manager. |
| Workflow context | Thread state, turn state, goal state, plan items, Action Center rows, approvals, pending input, and handoff records. | Usually not knowledge, though durable process lessons may become knowledge. |
| Work history context | Prior attempts, decisions, summaries, items, approvals, and review verdicts. | Work history is a source; reusable conclusions may become knowledge. |
| Knowledge context | Reviewed reusable workspace knowledge, accepted proposals, and user-edited notebook pages. | This is the active knowledge layer. |
| Source corpus context | Uploaded files, PDFs, Markdown, media, URLs, attachments, external records, and raw materials. | Sources are evidence, not knowledge. |
| Derived representation context | Extracted text, OCR, captions, transcripts, summaries, chunks, thumbnails, metadata, and citation anchors. | Derived representations are not knowledge unless curated as reusable interpretation. |
| Workspace material context | Repository files, specs, READMEs, configs, scripts, tests, design files, notebooks, and workspace artifacts. | Workspace materials are sources; conventions or decisions derived from them may become knowledge. |
| External observation context | API responses, web search results, issues, tickets, messages, calendar events, analytics, and warehouse queries. | External observations are sources; reviewed stable summaries may become knowledge with freshness metadata. |
| Artifact context | Prior outputs and evidence generated by OpenKit work. | Artifacts are sources; accepted findings or lessons from artifacts may become knowledge. |
| Generated output context | Answers, reports, slides, charts, diagrams, notebook pages, and exported documents from earlier work. | Reviewed outputs may become knowledge proposals, pages, source summaries, claims, or artifacts. |
| Feedback and review context | Human approval, rejection, correction, comments, reviewer verdicts, and client feedback. | Durable feedback is a strong source for proposals. |
| Runtime and capability context | Agent profile, available tools, MCP servers, workspace roots, sandbox summary, provider, model, budget, timeout, and platform constraints. | Not knowledge by default. |
| Policy, permission, and safety context | Permissions, capability policy, vault grants, redaction rules, sensitivity labels, and audit requirements. | Not ordinary notebook knowledge; secret values never become knowledge. |
| Agent observation context | Tool outputs, command summaries, diagnostics, failure observations, worker reports, and reasoning summaries. | Observations become knowledge only through proposal and review. |

## Package Files

The worker-visible package should be materialized under:

```text
/openkit/context/package.json
/openkit/context/instructions.md
/openkit/context/thread.md
/openkit/context/knowledge/
/openkit/context/sources/
/openkit/context/artifacts/
/openkit/context/workspace/
/openkit/context/workspace/materials/
/openkit/context/policy.json
```

The exact file set is constrained by the AEP snapshot, Knowledge Manager material selection, and Workflow Coordinator semantic context decision, then materialized by the owning mode service without adding excluded material.

`package.json` is the worker-visible index. It carries package lineage, relative paths, source references, sensitivity labels, budget metadata, and the digest inventory for every other package file. It MUST NOT contain `contextPackageDigest` or an inventory entry for itself. The Turn-owned trace computes the actual `package.json` digest after that file is complete and includes it in `fileInventory`; this one-way ordering prevents a self-referential digest.

## Input Categories

Context candidates include:

- current user instruction
- system and developer instructions approved for the worker
- thread summary
- recent items
- active goal or task state
- workspace repository summaries
- selected workspace files
- knowledge pages
- knowledge claims
- source snippets
- derived representations
- prior artifacts
- review decisions
- approval decisions
- policy summaries
- vault reference summaries
- runtime capability catalog summaries

Raw secrets are never context.

## Selection Pipeline

NanoCore selects context through this pipeline:

```text
collect candidates
  -> apply explicit task scope
  -> apply workspace and user policy
  -> apply sensitivity filters
  -> apply freshness and confidence filters
  -> rank by relevance
  -> fit budget
  -> assemble package
  -> compute package digest
  -> store trace
  -> materialize into worker runtime
```

Retrieval is not injection. Candidates can be retrieved and then excluded.

## Context Trace

Every package must create a context trace.

The trace should record:

- context package id
- workspace id
- thread id
- turn id
- agent session id when known
- package snapshot id when known
- selected items
- selected artifacts
- selected knowledge pages
- selected source snippets or derived representations
- selected workspace file refs
- selected policy summaries
- excluded candidates and reasons when useful
- token or byte budget
- sensitivity decisions
- freshness decisions
- selection timestamp
- package digest

The trace may split item-visible summaries from audit-only detail outside the accepted worker-Turn trace below. The worker-Turn trace itself is one immutable record rather than a mutable trace plus a second delivery receipt.

## Accepted Worker-Turn Delivery Trace

The first production delivery trace is the shared G01 implementation slice of this specification. S39 owns the trace shape and replay proof; Task or Goal Mode owns the worker request and Turn lifecycle; S16 owns Workspace Material revision, binding, queue, and active-input semantics. Completing this shared slice does not close the broader G07 Knowledge group.

Each worker Turn has exactly one trace whose durable identity is `(workspaceId, threadId, turnId)`. The trace has no independent lifecycle id: `contextPackageId` is exactly `ctxpkg_${turnId}`, and the canonical workspace path is exactly `threads/<threadId>/turns/<turnId>/context-package.json`. A Core-local Turn, including workspace-only Artifact introduction, MUST NOT create this trace.

The immutable trace fields are exact:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Exactly `1`. |
| `contextPackageId` | Exactly `ctxpkg_${turnId}`. |
| `workspaceId`, `threadId`, `turnId` | The one accepted worker Turn lineage and storage scope. |
| `requestId` | The immutable Task, Goal step, or outer-command request that reserved the Turn. |
| `goalId`, `taskId` | Both null for a direct Task Turn; both non-null and mutually valid for a Goal worker Turn. A half-null pair is invalid. |
| `agentSessionId`, `packageSnapshotId` | The exact accepted Agent Session and AEP snapshot used by the Turn admission. |
| `workerRequestItemId`, `workerRequestDigest` | The same Turn's immutable `user-message` Item and `sha256:` digest over its exact compact UTF-8 worker-request bytes. |
| `workspaceInputSnapshotId`, `workspaceMaterializationRecordId` | The exact Workspace handoff owners used by the accepted admission; the Materialization Record is `ready`. |
| `policyVersion` | Exactly `worker-context-v1` for this slice. |
| `includedItemIds` | Ordered Item ids actually included. `workerRequestItemId` is first; S13's validated latest Goal Gate request/response pair and any other selected prior Items follow canonical Thread Item order. |
| `excludedItems` | Exactly `{ itemId, reason }` for every considered Item not included. |
| `materialSelections` | The exact included Workspace Material revision entries defined below. |
| `materialExclusions` | Exactly `{ materialId, revisionId, sensitivity, reason }` for every addressed Material revision not included. |
| `fileInventory` | Exactly `{ path, byteLength, contentDigest }` for every worker-visible package file, including the completed `package.json`. |
| `contextPackageDigest` | `ctxpkg_sha256_` plus 64 lowercase hexadecimal digits over the canonical JSON object containing every other listed field. |

Canonical JSON recursively sorts object keys. `includedItemIds` retains delivery order; the worker-request Item is first, then every selected prior Item follows canonical Thread Item order. A non-null S13 `latestGateContextItemId` requires both its uniquely matching request Item and response or decision Item in this ordered set and in the worker request's Item context refs. `excludedItems` sorts by `itemId`; Material selections and exclusions sort by `(materialId, revisionId)`; and `fileInventory` sorts by `path`. Every `reason` is one baseline value from this specification, `byteLength` is the exact UTF-8 byte count, and every `contentDigest` uses `sha256:` plus 64 lowercase hexadecimal digits. `contextPackageDigest` excludes only its own field and includes every other trace authority field, including the digest of the completed worker-visible `package.json`; there is no timestamp in the trace. Accepted time remains owned by the existing Turn and scheduler admission rather than introducing mutable trace state.

Each `materialSelections` entry is exactly `{ materialId, revisionId, parentRevisionId, mediaType, contentDigest, packagePath, inclusionReason, sensitivity, sensitivityDecision }`. `inclusionReason` is exactly `thread_binding` or `goal_steering`; `sensitivityDecision` is exactly `included`; and `packagePath` is `workspace/materials/<materialId>/<revisionId>.md` for Markdown or `.txt` for plain text. The trace's Workspace handoff records MUST preserve every selected revision and digest. No entry may substitute a newer revision or a caller-provided byte string.

A Material with `sensitivity=restricted` MUST appear only in `materialExclusions` with reason `sensitive_content`; its title, canonical content, digest, package path, or derived summary MUST NOT enter the worker-visible package. An owning command that explicitly requires a restricted Material must reject before accepting delivery rather than queue input that the package will silently omit. Other sensitivity or policy exclusions use the same fail-closed trace boundary.

The trace is accepted only when the existing Turn, worker-request Item, scheduler admission, Agent Session, AEP snapshot, and package files match the trace and verify by digest. Each Material selection additionally requires its named Workspace Input Snapshot, ready Workspace Materialization Record, and source revision to match the same identity and digest. This predicate, not a trace status field, proves availability to the worker. It does not prove model cognition.

The owning mode service writes and verifies the immutable trace after the exact scheduler admission, Agent Session, AEP snapshot, input snapshot, and ready materialization are durable but before the worker receives the request or begins execution. Exact replay consults the trace before reselecting Items, Material revisions, Knowledge, or files. An identical request with no worker-launch effect may reuse that exact trace for the one already-authorized first launch; a different request, different immutable input, second trace, or changed bytes returns `recovery_required`. An accepted Turn or scheduler admission without its trace, a trace whose owner tuple is missing, a missing package file, any digest disagreement, or a restricted Material in `materialSelections` also returns `recovery_required`. Replay MUST NOT rebuild the missing trace from current projections, replace an unavailable revision, append later input, or create a receipt, recovery phase, settlement record, or second context owner.

## Exclusion Reason Baseline

Context traces should use stable exclusion reasons so debugging, tests, and future tuning can compare packages over time.

Baseline exclusion reasons:

| Reason | Meaning |
| --- | --- |
| `explicit_scope_excluded` | The task scope, user instruction, or plan excluded the candidate. |
| `policy_excluded` | Workspace, user, or system policy excluded the candidate. |
| `sensitive_content` | Sensitivity or permission rules blocked injection. |
| `freshness_expired` | The candidate was too stale for the task. |
| `confidence_too_low` | Confidence, review state, or source quality was insufficient. |
| `budget_exceeded` | The candidate lost budget fitting after higher-priority material was selected. |
| `relevance_too_low` | Ranking determined that the candidate was not useful enough. |
| `duplicate_or_covered` | Another selected candidate already covered the same information. |
| `lower_conformance` | The candidate did not meet the required knowledge or source conformance level. |
| `source_unavailable` | The referenced source, representation, or revision could not be materialized or verified. |
| `unsupported_type` | The candidate type cannot be projected into the current package shape. |

Implementation-specific projection reasons may be more granular, such as `diagnostic_noise`, `artifact_pointer`, `approval_gate`, `goal_state_not_needed`, and `review_context_not_needed`. Those reasons should map back to a baseline reason when package traces become durable cross-version records.

## Knowledge Handling

Knowledge package entries should carry:

- knowledge page id
- revision id
- source references
- confidence or review state
- sensitivity label
- excerpt or summary mode
- digest

Workers should see reviewed knowledge by default. Unreviewed observations require policy permission and should be labeled.

Rejected or deferred knowledge proposals are not active context unless explicitly included as review history.

## Source Handling

Source entries should carry:

- source id
- source kind
- original location or redacted locator
- derived representation id when used
- excerpt range or chunk id
- digest
- citation label
- sensitivity label

Large sources should be summarized or chunked. Raw source files should be included only when the task requires them and policy allows it.

## Artifact Handling

Artifacts may be context when they are relevant prior outputs.

Artifact entries should include:

- artifact id
- version or digest
- media type
- summary
- relative materialized path when included
- source relationship

Artifacts remain artifacts; including them in context does not convert them into knowledge.

## Workspace File Handling

Workspace files included as context should use workspace-relative paths and digests.

The package must not expose absolute host paths or Core-private storage paths.

Writable workspace roots are controlled by the workspace materialization plan, not by the context package alone.

## Policy And Budget

The package must include policy summaries that help the worker understand limits without exposing policy internals.

Examples:

- read-only roots
- writable roots
- capability ids available
- prohibited external side effects
- approval-required actions
- token or cost budget
- time budget

## Storage

The context package manifest and trace are workspace-owned records.

Accepted worker-Turn storage:

```text
threads/<threadId>/turns/<turnId>/context-package.json
runtime/agent-sessions/<agentSessionId>/context/<contextPackageId>/
```

The Turn-level record is the only durable delivery trace. The runtime-level directory is a derived byte materialization of the package named by that trace and MUST NOT carry an independent status, receipt, or mutable delivery history. Its `workspace/materials/` subtree contains only the exact non-restricted revisions selected by the trace.

File-system-first records should remain the durable explanation. SQLite or read-model indexing may accelerate lookup, attachment, search, and debugging, but it must not become the only source of truth for context package meaning.

## Replay Reconstruction

A context package is the replay unit for after-the-fact evaluation: `docs/specs/20260710-self_improvement_evaluation_loop.md` freezes the worker context package, not the workspace, as the faithful reproduction of what the Coordinator semantically composed and the owning mode service materialized. This section makes reconstruction a contract.

Requirements:

- Given a context package id, NanoCore MUST be able to rebuild the worker-visible materialized package and verify it byte-identically against the recorded package digest and per-file manifest digests.
- Evaluation reconstruction resolves in priority order: first the stored materialized snapshot (the existing digest-checked readback path); then, when the snapshot is absent or incomplete, per-entry reconstruction from the manifest's source references — source id, revision or capture record, and content digest — for registered sources, knowledge entries, artifacts, Workspace Material revisions, and workspace file refs.
- Reconstruction MUST be frozen: an entry is rebuilt only from the recorded revision with a matching content digest. Substituting current or newer content for a recorded entry is prohibited, even when the current content is available and the recorded revision is not.
- Failures are typed per entry (`source_unavailable`, `digest_mismatch`, `revision_unavailable`), and a reconstruction result MUST report entry-level outcomes so consumers can distinguish a fully reproducible package from a drifted one. Partial reconstruction is a reported state, not a silent fallback.
- Redaction decisions recorded at assembly time (`sensitive_content`, raw-secret-shaped redaction) apply identically at reconstruction; replay MUST NOT expose material the original materialization redacted.
- Consumers that need long-lived replay (for example harvested `EvalTask` records) SHOULD retain the materialized snapshot rather than rely on live source records; entry-level digest mismatch on reconstruction is the intended drift-detection signal such consumers use to retire stale replay material.

Evaluation reconstruction is diagnostic only. It may explain a complete, partial, or drifted historical package, but it MUST NOT establish the accepted-delivery predicate, authorize first admission, or repair an accepted worker Turn. Launch and exact command replay require the original immutable Turn trace and all bytes that its inventory names; any missing or conflicting authority remains `recovery_required`.

## Resolved Decisions

- The active context taxonomy belongs inside this package spec; the earlier standalone taxonomy draft is superseded.
- `docs/core/knowledge.md` owns canonical Knowledge, Source, Notebook, Knowledge Manager, Agent-Near Context, and Context Package semantics.
- A context package is a data projection, not a separate internal agent role.
- Core Knowledge owns the canonical concept of Context Package; this spec owns the worker-facing package projection, manifest, materialized layout, trace, digest, and replay contract.
- The Knowledge Manager prepares source-traceable knowledge or source material; the Workflow Coordinator composes the semantic worker context; the owning mode service persists, materializes, and delivers it.
- Workers do not silently read all knowledge. NanoCore mediates retrieval, filtering, packaging, and traceability.
- Artifacts can be included as context or become sources for knowledge, but artifacts are not a mandatory middle step for ingest-to-knowledge updates.
- One worker Turn owns one immutable trace at `threads/<threadId>/turns/<turnId>/context-package.json`; its identity, worker request, Item order, exact Material revisions, package files, lineage, and digest are deterministic, and it creates no receipt or workflow.
- Workspace Material selection is restricted to the exact bound or steered revision accepted by S16 and the matching ready workspace handoff records. Restricted Material is recorded only as `sensitive_content` exclusion and never enters worker-visible bytes.
- Exact launch and command replay fail closed when that trace or any named authority or byte is absent or conflicting. Diagnostic reconstruction may report historical drift but cannot repair or replace accepted delivery.
- The implemented slices record provider-visible item projections, context package digests, included item ids, excluded item ids, persisted Knowledge Manager context material package traces, a worker-visible Knowledge Manager `/openkit/context` snapshot with captured text source snippets, explicit inline artifact files, explicit workspace-owned text files, explicit materialized workspace-root text files, byte/file/token-estimate budget metadata, package-relative manifest paths, raw-secret-shaped material redaction, unavailable-source materialization decisions, Goal Mode step context assembly summaries, and OpenShell upload support for pre-materialized read-only context roots.
- Durable context traces should retain stable baseline exclusion reasons. Current item-projection reasons are implementation-specific and should map to the baseline vocabulary before they become durable cross-version trace records.
- Previously open questions are resolved by accepted V1 defaults: worker and artifact-review citations use `contextPackageDigest`, `entryId`, `sourceRef`, optional span metadata, and entry content digest; item-visible traces expose only the selected source summary, citations, redacted selection reason, and package digest, while ranking scores, omitted entries, raw prompt material, and sensitive assembly details stay audit-only.

## Deferred / Future Work

- Extend explicit workspace-root file materialization into automatic root-file selection.
- Extend captured text source snippets into derived representations and policy-filtered full package assembly.
- Extend the first persisted Knowledge Manager trace ledger into broader audit-only detail for Knowledge candidates, rationale, freshness decisions, and model-specific budgets without changing or duplicating the accepted worker-Turn trace.
- Define item-visible versus audit-only projections for context package traces.
- Define citation projection from context package entries into worker outputs and artifact reviews.
- Extend first byte/file/token-estimate package budget accounting into model-specific tokenizer, time, and cost accounting.

## Testing Strategy

- Selection fixture tests for explicit scope, knowledge, artifacts, and workspace files.
- Policy filter tests for restricted knowledge and sensitive sources.
- Budget tests proving lower-priority context is excluded.
- Trace tests proving selected and excluded records are explainable.
- Materialization tests proving no host paths or secrets appear.
- Determinism tests proving one accepted worker Turn yields exactly `ctxpkg_${turnId}`, one immutable trace, stable ordering, and the same digest from the same authoritative inputs.
- Material tests proving the trace and package select the exact bound or steered revision, preserve matching workspace handoff lineage, and never include restricted Material bytes or metadata beyond the allowed exclusion tuple.
- Replay tests proving same-request/no-effect retry reuses the exact trace and bytes, while a changed request, second trace, missing file, missing revision, digest mismatch, or restricted selection fails `recovery_required` without reconstruction or settlement state.
- Evaluation tests proving frozen source reconstruction can report complete, partial, or drifted history but cannot satisfy accepted delivery or authorize worker launch.

## Risks & Mitigations

- Risk: Context becomes another hidden context store. Mitigation: package records are projections with source references, not new canonical knowledge.
- Risk: Workers miss important context because selection is too aggressive. Mitigation: trace excluded candidates and tune ranking with review.
- Risk: Sensitive knowledge leaks into broad worker sessions. Mitigation: policy filtering happens before packaging.
- Risk: Package files drift from stored trace. Mitigation: use digests and verify before launch.

## Links

- `docs/core/knowledge.md`
- `docs/core/storage.md`
- `docs/core/agent-capability.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260713-work_resource_interaction_model.md`
