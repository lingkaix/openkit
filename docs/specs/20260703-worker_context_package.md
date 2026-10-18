---
status: Accepted
implementation: Partial
kind: boundary
---
# Worker Context Package

Implementation note: item projection, digest records, and the accepted Turn-owned Task and Goal delivery trace are implemented. Real worker launches persist and verify the exact Coordinator request, generated `context` input, immutable package files and trace, Workspace Input Snapshot, Workspace Materialization Record, backend handoff, selected or excluded Workspace Material revisions, and queue proof before launch. Direct Task traces also bind selected Knowledge page identities, content digests, complete provenance, and worker-visible bytes through the same owner. Broader candidate audit detail and citation projection remain unimplemented, so this broader specification remains Partial. A Goal-dispatched Task uses this ordinary Task package. Goal-mode Knowledge integration is not a second path.

## File References And Historical Availability

For the shared file-reference format, [File Storage And Knowledge Packages](20261018-file_storage_and_knowledge_packages.md) supersedes requirements to retain another original or derivative excerpt solely for historical replay. Packages keep exact owner references, captured digests, locations, delivered identities and explicit availability. Missing historical bytes remain unavailable; current content never reconstructs them.

An authorized running Turn may still require a verified disposable read-only snapshot. Existing readiness, delivery proof, source admission and Item/evidence lifecycles remain binding. Context source entries use digest references and exact delivered projections as defined below. A separate explicitly admitted full input snapshot keeps its execution contract without creating a historical source-retention promise.

## Personal Scope Projection

Personal Memory is not ambient Worker input. Under `20260909-thread_visibility_and_sharing.md`, shared Task/Goal work receives only the exact confirmed brief, selected attachments and explicitly promoted personal context. Source selection must exclude private Thread/Memory bodies and metadata outside the receiving audience before materialization. Existing S39 trace records the actual admitted bytes; an inaccessible origin link is not permission to fetch the private conversation. Scoped Knowledge trace identities include owner scope and page revision/digest while this owner alone proves delivery.

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
- The one immutable worker-Turn delivery trace shared by an ordinary Task, including a Goal-dispatched Task, Work Resource Interaction, replay, and governed Knowledge-use review. It is not a Coordinator package.

## Does Not Own

- Canonical knowledge semantics, notebook semantics, proposal lifecycle, or Knowledge Manager responsibilities.
- Final worker prompt authorship, workflow progression, task planning, or worker selection.
- Agent Capability calls for runtime retrieval after a worker has started.
- A Goal steering queue, a Goal knowledge path, and a Coordinator package. A Goal-dispatched Task uses the ordinary Task package.
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

The optional `knowledgeOverview` package input becomes `knowledge-overview.md` in the package root. The AEP Turn input names that file so the stock Worker shim exposes the navigation instruction.

The current implementation is the accepted V1 context package projection:

- `apps/nanocore/src/context/llm-projection.ts` converts durable item history into provider-visible LLM messages through an explicit projection policy.
- The projection result records `policyVersion`, `contextPackageDigest`, included item ids, excluded item policy decisions, and provider messages.
- `createContextPackageRecord` creates an attachable record for `internal-agent` and `worker-turn` targets with digest, policy version, included item ids, and excluded item ids.
- Tests cover deterministic context package digests and attachment records.
- Worker-turn checkpoint storage carries the diagnostic field `contextDigest`. Checkpoint `contextDigest` is not the accepted trace's `contextPackageDigest`, carries no queued-steering or follow-up count, and is not delivery proof.
- The real Task launch path, including a Goal-dispatched Task, delivers the exact Coordinator request as compact JSON, retains those bytes in the Turn-owned `user-message` Item, creates the canonical package under `threads/<threadId>/turns/<turnId>/context-package/`, persists the sibling immutable `context-package.json` trace, materializes the generated read-only `context` input at `/openkit/sessions/<agent-session-id>/context`, and verifies the existing scheduler, AgentSession, AEP, Workspace Input Snapshot, Workspace Materialization Record, backend-session, Item, Task, Material, file, and digest owners before worker launch. Mutable checkpoint diagnostics remain non-authoritative and cannot substitute for this proof.
- S51 portable import remints the complete worker Context Package graph and verifies its exact package bytes, stale imported AgentSession, AEP, worker-request Item, Material selections, Workspace Input Snapshot, Workspace Materialization Record, and reserved `import-lineage:` request lineage before publication. This imported-history classification may support only read-only historical `lastWorkerSeenRevisionId` and same-Turn Review integrity; it cannot prove current delivery, admission, command replay, reconnect, steering application, or another external effect.
- The former standalone Knowledge context trace, readback, and materialization operations are deleted without aliases. Knowledge Manager context preparation returns S61's retrieval trace reference, and only this S39 owner materializes or proves worker delivery.
- The current projection policy classifies durable items as user, assistant, artifact, approval, diagnostic, review, goal, tool, knowledge, handoff, or file-change categories. The `knowledge` category covers knowledge-derived context projection items.
- Current exclusion reasons are item-projection reasons only: `policy_excluded`, `ui_only`, `diagnostic_noise`, `artifact_pointer`, `approval_gate`, `goal_state_not_needed`, `review_context_not_needed`, `empty_content`, `sensitive_content`, and `unsupported_item_type`.

The stock OpenShell worker backend uploads the pre-materialized read-only generated context root to the declared `context` slot and verifies its extracted files before launch. A Task trace, including a Goal-dispatched Task, materializes each selected Knowledge page's bounded UTF-8 body or excerpt and verifies the exact selected Notebook commit, separate original page digest, delivered digest, complete source references, ranges, and package path under that Turn-owned package. Automatic root or Artifact selection, binary root-file conversion, broader audit-only Knowledge candidate traces, and citation projection into worker outputs remain deferred future work. Package text allowances use the local estimate below; the final physical Provider route separately admits its complete actual request. A package preview does not prove token count or physical fit. Selected Knowledge continuation uses its canonical pinned Notebook reader under current source and receiving-audience admission. Historical inspection is limited to retained digest-checked package bytes; missing package bytes are unavailable rather than reconstructed from current owners. Workspace import validates the source canonical page and exact delivered projection before publication. In the existing staging callback after Notebook initialization, it binds target Knowledge projections to the actual target commit and recomputes dependent package, trace, AEP, Workspace Input Snapshot and materialization proofs before file or row publication. Owned identity/reference remint preserves delivered ranges and omitted content; an excerpt that cannot be reminted truthfully uses the existing unavailable historical-closure refusal.

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

Context package preparation is not a separate internal agent. The Knowledge Manager selects, filters, cites, and prepares knowledge-derived or source-derived material. The Workflow Coordinator semantically combines authorized material with task instructions, workflow state, constraints, available capabilities, stop conditions, and review policy for a specific bounded step. The owning Task service persists, materializes, and delivers that decision. A Goal-dispatched Task uses that same service.

## Ownership Boundary With Knowledge

An available scope overview MUST retain its exact `knowledgeBaseId` once in metadata while keeping `index.md` as its logical path. Knowledge selection and exclusion rows MUST retain the exact `knowledgeBaseId` supplied by their admitted source. Ordering, duplicate detection, overlap checks and continuation identity MUST use the Knowledge Base plus page ID; a matching page path alone is insufficient. The current default Knowledge Base keeps its existing `knowledge/pages/<pageId>.md` Worker-delivered path. Retained manifest and trace entries carry the base identity, and current reads MUST refuse a missing or different base. Additional Knowledge Bases can add distinct delivered paths later without rewriting these retained default paths. The [Protocol reference owner](../core/protocol.md#scope-qualified-object-references) owns the qualified identity and URI; this field grants no access.

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

The completed direct rename permits only Knowledge, Sources, and Context Package vocabulary; `Memory` aliases or legacy schemas are not accepted.

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

## Bounded Model Projection

The package contains compact instructions, a bounded source inventory, selected delivered representations and retrieval affordances. A file reference does not imply full original delivery or a Provider message. Exact selected preview or descriptor bytes travel through the [read-only Turn input](20260704-session_static_workspace_materialization.md#read-only-turn-source-snapshot); models receive logical qualified references rather than host paths or base64 bodies. Full originals are read on demand under current admission and digest verification.

Current text defaults are 2,048 UTF-8 bytes or 50 lines per preview, and 51,200 bytes or 2,000 lines per requested read. Whichever cap binds first applies. Independently bound serialized envelopes, inventories, aggregate list/search results, and the complete model request. Reserve envelope capacity for status, identity, continuation, and errors. Final model-capacity admission is independent of all byte caps and includes the separately owned media cost.

For every internal Agent Provider route, admit the final serialized text request with a local estimate against the selected model capacity. Include instructions, history, Tool schemas and results, native continuity, and the existing output reserve after transport overlays. The current default estimates input tokens as `ceil(UTF-8 bytes / 3) + 4096`, then adds the output reserve. The result is an estimate, not a proved token bound. Missing exact accounting alone must not refuse a valid route, including a Codex subscription route. Exact counting may be used only when it is local and cheap; do not call a remote count endpoint per request. A Provider context rejection must produce one clear error that directs the caller to reduce input or retrieve a smaller excerpt. Large inputs retain bounded projection and retrieval on demand. This text admission changes no Worker request admission, media accounting, source identity, authorization, or durable lifecycle. The [local estimate decision](../decisions/20261017-model_request_local_estimate.md) records the ruling and its scope.

At the existing final physical-request callback, each transport-admitted inline PNG/JPEG occurrence receives a separate approximate local allowance. The current default is 8,192 tokens per image, added to the text estimate and actual output reserve. The counting projection replaces only the image data values in Native Responses user-message content arrays and function-result output arrays. Text, metadata, native continuity and arbitrary text data URLs remain counted. The actual Provider request remains unchanged. Selected-model image-input gating and independent processing, delivery, authorization and raw output limits remain binding. This allowance is neither complete media proof nor a universal Provider token bound. Unknown exact accounting alone must not refuse an otherwise admitted route. The [image estimate decision](../decisions/20261017-image_request_local_estimate.md) records L-AW's coordinator-unavailable fallback and its revisit condition.

Exact reads report source size, revision/digest, representation, returned half-open byte range, omitted ranges, truncation, and EOF or continuation. Continuation binds the revision, representation, requested mode, and range. It advances through huge single lines without splitting UTF-8 code points. Invalid UTF-8 returns an unavailable text representation rather than silently changing original bytes. A cursor is a locator, not authority.

Saving, processing, or retrieval failure returns a bounded unavailable/error descriptor with no fabricated working handle. Never return the full body as fallback. Recheck current source access and destination disclosure on every retrieval and subsequent display. Names, digests, previews, snippets, counts, and diagnostics are disclosures too. Keep private Memory outside Worker packages.

Record original and delivered identities separately for every transformed source, including Material and Artifact projections. The existing immutable inventory covers every delivered file and the completed manifest. Retain the one-way manifest/trace digest ordering and exact replay proof. Do not reconstruct missing historical representations from current sources. A Retrieval Kernel trace remains selection evidence, never delivery authority.

Acceptance must verify distinct original/delivered digests, body/excerpt/descriptor replay, a huge UTF-8 line, CJK/JSON token admission, bounded aggregates, missing handles, and revocation. Exact file bytes must remain downloadable without entering model context.

## Package Files

The worker-visible package should be materialized under:

```text
/openkit/sessions/<agent-session-id>/context/package.json
/openkit/sessions/<agent-session-id>/context/instructions.md
/openkit/sessions/<agent-session-id>/context/thread.md
/openkit/sessions/<agent-session-id>/context/knowledge/
/openkit/sessions/<agent-session-id>/context/sources/
/openkit/sessions/<agent-session-id>/context/artifacts/
/openkit/sessions/<agent-session-id>/context/workspace/
/openkit/sessions/<agent-session-id>/context/workspace/materials/
/openkit/sessions/<agent-session-id>/context/policy.json
```

The exact file set is constrained by the AEP snapshot, Knowledge Manager material selection, and Workflow Coordinator semantic context decision, then materialized by the owning mode service without adding excluded material.

`package.json` is the worker-visible index. It carries package lineage, relative paths, source references, sensitivity labels, budget metadata, and the digest inventory for every other retained package file. It MUST NOT contain `contextPackageDigest` or an inventory entry for itself. The Turn-owned trace computes the actual `package.json` digest after that file is complete and includes it in `fileInventory`; this one-way ordering prevents a self-referential digest.

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
- AgentSession id when known
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

The first production delivery trace is the accepted worker-turn delivery of this specification. S39 owns the trace shape and replay proof; the Task owner owns the worker request and Turn lifecycle, including a Goal-dispatched Task; S16 owns Workspace Material revision, binding, queue, and active-input semantics. Completing this shared delivery does not close the broader Knowledge implementation.

Each worker Turn has exactly one trace whose durable identity is `(workspaceId, threadId, turnId)`. The trace has no independent lifecycle id: `contextPackageId` is exactly `ctxpkg_${turnId}`, and the canonical workspace path is exactly `threads/<threadId>/turns/<turnId>/context-package.json`. A Core-local Turn, including workspace-only Artifact introduction, MUST NOT create this trace.

The immutable trace fields are exact:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Exactly `1`. |
| `contextPackageId` | Exactly `ctxpkg_${turnId}`. |
| `workspaceId`, `threadId`, `turnId` | The one accepted worker Turn lineage and storage scope. |
| `requestId` | The immutable Task or outer-command request that reserved the Turn. |
| `goalId`, `taskId` | Both absent for an ordinary Task Turn. The absent Task id and binding-only selection rules govern new admissions. On a new Goal-dispatched admission, `goalId` may name the Goal that authorized the Task and may be absent, and `taskId` stays absent because a Task has no separate task record. Retained Turn-owned traces and package bytes remain usable as historical evidence. References to deleted Goal-owned rows confer no authority and require no live Goal or Goal Task during historical validation. |
| `agentSessionId`, `packageSnapshotId` | The exact accepted AgentSession and AEP snapshot used by the Turn admission. |
| `workerRequestItemId`, `workerRequestDigest` | The same Turn's immutable `user-message` Item and `sha256:` digest over its exact compact UTF-8 worker-request bytes. |
| `workspaceInputSnapshotId`, `workspaceMaterializationRecordId` | The exact dedicated read-only Context Package root handoff owners used by the accepted admission. A valid completed existing Materialization Record is ready by predicate; no lifecycle field is added. |
| `policyVersion` | Exactly `worker-context-v1` for this slice. |
| `includedItemIds` | Ordered Item ids actually included. `workerRequestItemId` is first, and any other selected prior Items follow canonical Thread Item order. |
| `excludedItems` | Exactly `{ itemId, reason }` for every considered Item not included. |
| `knowledgeSelectionInput` | Null when no Knowledge selection was requested; otherwise the exact S61 governed-retrieval trace reference defined below. The retrieval trace is an input but not delivery authority. |
| `knowledgeSelections` | The exact included Knowledge page identity-and-content entries defined below. |
| `knowledgeExclusions` | Only the exact S61-selected Knowledge pages omitted by S39's later package budget, as defined below. S61-owned policy, validity, sensitivity, freshness, relevance, and limit exclusions are not copied. |
| `materialSelections` | The exact included Workspace Material revision entries defined below. |
| `materialExclusions` | Exactly `{ materialId, revisionId, sensitivity, reason }` for every addressed Phase 1 Material revision not included under the closed candidate and reason rules below. |
| `fileInventory` | Exactly `{ path, byteLength, contentDigest }` for every retained delivered projection and ordinary package file, including the completed `package.json`. Disposable live originals are derived from `sourceFiles`, not retained here. |
| `contextPackageDigest` | `ctxpkg_sha256_` plus 64 lowercase hexadecimal digits over the canonical JSON object containing every other listed field. |

Canonical JSON recursively sorts object keys. `includedItemIds` retains delivery order; the worker-request Item is first, then every selected prior Item follows canonical Thread Item order. Goal Gate context is not a package input. `excludedItems` sorts by `itemId`; Knowledge selections and budget exclusions sort by `(knowledgePageId, contentDigest)`; Material selections and exclusions sort by `(materialId, revisionId)`; and `fileInventory` sorts by `path`. Every `reason` is one baseline value from this specification, `byteLength` is the exact delivered file byte count, and every `contentDigest` uses `sha256:` plus 64 lowercase hexadecimal digits. `contextPackageDigest` excludes only its own field and includes every other listed field, including the digest of the completed worker-visible `package.json`; there is no timestamp in the trace. Accepted time remains owned by the existing Turn and scheduler admission rather than introducing mutable trace state.

The package-root digest is exactly `sha256:` plus 64 lowercase hexadecimal digits over the canonical JSON array of the complete live input inventory, sorted by `path`. Start with the retained trace `fileInventory`; for each selected `sourceFiles` original, add `{ path: "originals/<digest-hex>", byteLength, contentDigest: originalDigest }`, sharing identical originals by digest and refusing a size disagreement or retained-path collision. The 64 lowercase digest hex digits come from the existing SHA-256 content identity. This derivation adds no trace field or durable owner. NanoCore streams originals directly from their exact authorized canonical owners into disposable files in the existing read-only `context` slot; no additional original is written under the Core package root. Existing per-file size/digest verification and readiness cover the complete live inventory before execution. Because `package.json` excludes itself but its completed bytes are included in the trace inventory, the digest has no self-reference. Historical verification checks retained delivered files and derives this same live inventory from captured source metadata, without claiming that original bytes remain available.

The canonical Workspace package-root directory is `threads/${threadId}/turns/${turnId}/context-package/`; each `fileInventory.path` resolves beneath that directory, while the sibling `context-package.json` remains the trace owner. The accepted AEP snapshot MUST contain exactly one dedicated Context Package workspace input for this Turn. Its `id` is `context_${turnId}`, `kind` is `generated`, `source` is `{ kind: "generated", pathRef: "threads/${threadId}/turns/${turnId}/context-package" }`, `target` is exactly `/openkit/sessions/<agent-session-id>/context`, `access` is `read-only`, and `materialization` contains exactly `{ strategy: "filesystem", contentDigest: packageRootDigest, slotId: "context" }`; it carries no mount declaration. This exact tuple binds the existing S23 `context` slot and generated-source adapter rather than introducing a source kind or slot. It is app-local generated content, not a Workspace data source, and therefore has no `sourceId` or catalog authority.

The trace's `workspaceInputSnapshotId` is exactly `wis_${packageSnapshotId}_context_${turnId}` and resolves to one existing Workspace Input Snapshot with `workspaceId` from the trace, `resourceId=context_${turnId}`, absent `sourceId`, `resourceKind=filesystem`, `strategy=filesystem`, `pathScope=["context_${turnId}"]`, empty `writableRoots`, `ignoredPaths`, and `generatedFiles`, `base={ commit: null, contentDigest: packageRootDigest }`, and `createdAt` equal to the accepted Turn's `startedAt`. Its backend summary uses the accepted backend kind, label `${backendKind} worker backend`, and the exact frozen capability list used by the AEP admission.

The trace's `workspaceMaterializationRecordId` is exactly `wmr_${packageSnapshotId}_context_${turnId}` and resolves to one existing Workspace Materialization Record whose `inputSnapshotId`, `workspaceId`, absent `sourceId`, `backendKind`, `packageSnapshotId`, `strategy`, `base`, and `createdAt` equal that Workspace Input Snapshot and accepted admission; `workerSessionId` is the matching existing Worker Backend Session's `backendSessionId`; and `materializedRootRef` is exactly `/openkit/sessions/<agent-session-id>/context`. Its `policyDigest` is `sha256:` over canonical JSON of exactly `{ backendKind, packageSnapshotId, requiredCapabilities }`, with `requiredCapabilities` retaining the frozen AEP order. `readinessEvidence` is diagnostic and is exactly, in order, one `{ kind: "backend.<health>", ref: "version:<version>" }` entry when the accepted materialization reports backend health and a version, the same entry with `ref=backendKind` when version is null, followed by one `{ kind: "sandbox.<state>", ref: backendSessionId }` entry when that backend reports a sandbox; omitted evidence produces no entry. The record is complete only when the matching Worker Backend Session has `workspaceHandoffState=complete` and the root at `/openkit/sessions/<agent-session-id>/context` verifies against the package-root digest. Existence plus this exact tuple, backend handoff, file inventory, and digest verification is the ready predicate; neither existing record gains a status or lifecycle field.

The Task owner validates the trace when it writes it. On a new admission, `goalId`, when present, names the Goal that authorized the admission. A missing Goal removed by the accepted deletion is known absence. Retained Turn-owned traces and package bytes remain usable as historical evidence. References to deleted Goal-owned rows confer no authority and require no live Goal or Goal Task during historical validation. The trace stays readable when the non-Goal owners agree and current containing-record/source audiences permit disclosure. Later verification does not depend on a checkpoint.

Before the accepted trace becomes durable, current item-projection exclusions map to this specification's existing baseline only. `sensitive_content` remains exact; a structurally unsupported item maps to `unsupported_type`; a missing or unverifiable source maps to `source_unavailable`; and the remaining current category or policy exclusions map to `policy_excluded`. Implementing the trace MUST NOT expand the durable reason enum merely to preserve private projection vocabulary.

### Knowledge Selection Input And Delivery

The coordinator and Consultant accepted the qualified retrieval reference below under the engineer's delegation; the Task bridge carries `retrievalTraceRef` for the existing query-owned selection. This amendment changes no package history, notebook commit or import-closure contract.

The accepted Knowledge bridge extends this one existing Turn-owned package and trace; it does not create a Knowledge delivery trace, receipt, state, or lifecycle. A Goal-dispatched Task uses the same Knowledge selection as an ordinary Task. There is no second Goal knowledge path.

The existing `turn.read` release-coupled response projection and its remote MCP and administrator CLI operation expose one additional nullable `contextPackageDigest`; this field is not persisted in `TurnSchema`. It is the exact digest only when S39's strict live accepted-delivery verifier resolves the Turn-owned trace, manifest, inventory, and retained package bytes. It is null for a Core-local Turn, imported history, missing or drifted package bytes, or any Turn without current accepted delivery proof. The projection exposes no package bytes, host path, selection score, or new authority and exists so citations and Knowledge proposal source references can name the already-owned S39 digest without a Context Package read operation.

For a direct Task, the owning Task service invokes S17 `prepare-context-material` exactly once with caller assigned as `task-mode` and normalized S61 request `{ query: input, limit: 5, pinnedReferences: [] }`, where `input` is the exact immutable schema-valid `StartTaskModeRequest.input` string with no trimming or rewriting. S17 delegates to S61 exactly once and returns that existing retrieval trace reference; Task MUST NOT call S61 or another selector in parallel. V1 Task Mode exposes no Knowledge pin field; adding one requires an owning Task contract update. The returned S61 row is the sole selection input for that Turn.

A Chat-subordinate Task retains the selection posture of its admitted entry. A command handoff is recognized by its exact command-derived receiving tuple. An outcome-initiated Assistant handoff with no requested Knowledge selection is recognized only by the Assistant owner's existing confirmed source proof: exact delivered Pending Request, human selection, completed source Turn and handoff Item, receiving lineage, and matching worker objective. Both package preparation and strict live verification consume that same proof. A parent Thread or identifier shape alone is insufficient; missing, stale or contradictory proof refuses package publication or strict delivery. This exception adds no Knowledge query, receipt, classifier owner or imported-history execution authority.

`knowledgeSelectionInput` is exactly `{ retrievalTraceRef }`, where `retrievalTraceRef` is the Core Protocol `{scopeId,objectId}` reference to the querying Thread/Turn's one S61 selection trace returned through S17. Before Turn creation, Task preparation binds its current Server, Workspace, Actor and existing Task Thread through trusted context and publishes at `threads/<threadId>/retrieval-traces/<traceId>.json`; the request cannot replace that context. The new Turn's Context Package consumes that exact qualified reference after admission. The trace is never moved, copied or re-scoped into the Turn; if admission fails without a Turn, it stays as evidence of the query without a cleanup rewrite. A query made inside an existing Turn instead uses that Turn's trace path under Knowledge Store. The default source is that Task's Workspace Knowledge base; no Memory or cross-source union is admitted. This projection follows [Query Context, Sources, References And Acts](../decisions/20261015-context_sources_references_query_acts.md). The referenced row already owns the request digest, persisted selection order and retrieval exclusions, without persisted scores; S39 does not duplicate them. The linkage identifies which selection invocation the Task consumed but is neither an accepted-delivery predicate nor a replay, launch, or repair authority. The S17 response references only this trace and cannot become a second selection owner.

Each `knowledgeSelections` entry carries `{ knowledgePageId, notebookRevision, contentDigest, sourceRefs, packagePath, projection }`. `contentDigest` identifies the original canonical UTF-8 page at S61's exact published notebook commit. `sourceRefs` remains the complete duplicate-free array sorted bytewise ascending. `packagePath` remains `knowledge/pages/<knowledgePageId>.md`. `projection` records `kind` (`body`, `excerpt`, or `descriptor`), source revision, representation identity/digest, original snapshot path when materialized, delivered digest, exact half-open representation byte ranges, byte length, truncation, and availability. Projections do not retain a per-projection token budget or accounting identity. The manifest retains the existing package allowance; complete final-request admission and its actual output reserve remain separately owned. Neither a package nor a preview proves physical model fit. The [projection accounting decision](../decisions/20261017-context_projection_accounting.md) records this cut. A body has the original bytes; an excerpt or descriptor has its own delivered digest. Only the delivered digest must equal that inventory file's digest. Keep original review state and sensitivity in validated source evidence; projection cannot promote them. [The accepted decision](../decisions/20261015-large_files_and_model_context.md) replaces whole-page-only delivery.

`knowledgeExclusions` contains exactly one `{ knowledgePageId, notebookRevision, contentDigest, reason: "budget_exceeded" }` entry for each S61-selected page omitted by S39's later package budget. S61-owned exclusions are never copied. Scan S61 selections in persisted order after the required request and accepted Material projections. Admit a body, excerpt, or descriptor only when independent byte limits and the selected model's token budget permit it. Count instructions, history, Tool schemas, other selected content, media cost, and output reserve in complete-request admission. Worker text package allowances use the same approximate local text estimate as the [local admission rule](#bounded-model-projection). This package estimate controls which bounded representations enter the package; it proves neither a token bound nor physical model fit. The existing final physical-route callback admits the complete actual Provider request after transport overlays, including native continuity and output reserve, against the selected physical context capacity. Missing exact accounting alone does not refuse a valid Worker route. The [Worker package estimate decision](../decisions/20261017-worker_package_local_estimate.md) records the delegated fallback and its scope. Never use `ceil(bytes/4)` as a hard token limit. An omitted page does not consume the package budget, and scanning continues. This remains S39's only Knowledge exclusion.

Before first acceptance, the owning Task service MUST read each S61-selected Workspace Knowledge page from its pinned notebook commit, recheck current authorization, source disclosure and suppression, and verify its active and retrieval-visible state, policy, sensitivity, page identity, source references, canonical bytes, and digest, then apply the package budget above. It writes only included Knowledge files into the existing package root, repeats the exact delivered selection tuples in `package.json`, and includes every delivered file in the existing `fileInventory`; it creates no other delivery record. Every S61 selection appears exactly once in either `knowledgeSelections` or the S39-only budget exclusions, each delivered entry resolves to exactly one inventory path whose digest equals its projection delivered digest, no budget-excluded page has a package file, duplicate page identities or package paths are invalid, and restricted Knowledge can never enter either S39 array or worker-visible bytes.

Missing canonical page bytes before any accepted trace or worker-launch effect returns the existing retryable `source_unavailable` result. Invalid Workspace lineage, an unresolved selected page or content digest, a retrieval contradiction, altered source references, a digest mismatch, a restricted selection, a duplicate disposition, an unexpected Knowledge file, or any trace-manifest-file disagreement returns `recovery_required` before launch. Once the immutable trace and package are accepted, later Knowledge edits, deletion of the retrieval trace, or loss of ranking detail do not invalidate the historical delivery proof: the Turn-owned delivered selection tuples, package-budget exclusions, `package.json`, `fileInventory`, and exact package bytes are sufficient. Conversely, a retrieval or preparation trace, even when intact, MUST NOT prove delivery, replace missing package bytes, or authorize launch.

Exact replay reads this Turn-owned trace before running S17 or S61. An identical request with no worker-launch effect may reuse the already accepted Knowledge selection and byte-identical files for the one authorized first launch. Replay MUST NOT reselect current Knowledge, substitute newer page bytes, recreate a missing file from a retrieval trace, or rewrite the linkage. A changed Task request, a second retrieval trace, a missing delivered Knowledge file, or any mismatch returns `recovery_required`; no receipt, recovery phase, or settlement owner is added.

Each `materialSelections` entry is exactly `{ materialId, revisionId, parentRevisionId, mediaType, contentDigest, packagePath, inclusionReason, bindingMutationRequestId, sensitivity, sensitivityDecision, projection }`, and one trace contains at most one entry per Material. For a new admission, `inclusionReason` is exactly `thread_binding`. Goal steering is not a package input of a new admission, and there is no `goal_steering` reason and no `PendingUserTurnRecord` on that admission. The absent Task id and binding-only selection rules govern new admissions. Retained Turn-owned traces and package bytes remain usable as historical evidence. References to deleted Goal-owned rows confer no authority and require no live Goal or Goal Task during historical validation. Every `thread_binding` entry carries the exact selected `ThreadMaterialBinding.lastMutationRequestId`. `sensitivityDecision` is exactly `included`; and `packagePath` is `workspace/materials/<materialId>/<revisionId>.md` for Markdown or `.txt` for plain text. `projection` uses the same original-versus-delivered identity, range, budget, and availability tuple as Knowledge selections. The trace's Workspace handoff records MUST preserve every selected original revision/digest and the separately digested delivered representation. No entry may substitute a newer revision or a caller-provided byte string.

The complete Phase 1 Material candidate set is the exact non-null `latestQueuedRevisionId` of the Thread's unique `bound` Material binding. An unbound binding, a binding with no queued revision, and any superseded historical revision are not addressed by this trace and appear in neither Material list. Goal steering is not a candidate.

For the binding candidate, exclusion mapping is exact. `inclusionState=excluded` produces `explicit_scope_excluded`; `sensitivity=restricted` produces `sensitive_content`; a current Workspace or worker policy denial produces `policy_excluded`; and failure to fit the verified candidate after the required worker request produces `budget_exceeded`. These predicates are evaluated in that order, and exactly the first matching reason is recorded. A public or internal, included, policy-allowed candidate that fits MUST be selected. A missing revision, invalid Material ownership, missing canonical bytes, digest disagreement, or unavailable materializer is not an exclusion: it prevents Turn acceptance with S16's typed `recovery_required` or pre-acceptance `source_unavailable` result. This slice does not emit `freshness_expired`, `confidence_too_low`, `relevance_too_low`, `duplicate_or_covered`, `lower_conformance`, `source_unavailable`, or `unsupported_type` for Material candidates.

A Material with `sensitivity=restricted` MUST appear only in `materialExclusions` with reason `sensitive_content`; its title, canonical content, digest, package path, or derived summary MUST NOT enter the worker-visible package. An owning command that explicitly requires a restricted Material must reject before accepting delivery rather than queue input that the package will silently omit. Other sensitivity or policy exclusions use the same fail-closed trace boundary.

The trace is accepted only when the existing Turn, worker-request Item, scheduler admission, AgentSession, AEP snapshot, and package files match the trace and verify by digest. Each Material selection additionally requires its named Workspace Input Snapshot, ready Workspace Materialization Record, and source revision to match the original identity and original digest. Verify original bytes in the read-only source snapshot against that digest. Verify the body, excerpt, or descriptor at `packagePath` against its delivered digest and file-inventory entry; those bytes need not equal the original digest. This predicate, not a trace status field, proves availability to the worker. It does not prove model cognition.

The strict accepted-delivery verifier MUST reject any trace whose `requestId` begins with the reserved `import-lineage:` prefix before reading scheduler admission, execution-attempt, backend-session, or handoff authority. Even matching target-local runtime lookalikes cannot promote imported history into accepted delivery.

The owning mode service writes and verifies the immutable trace after the exact scheduler admission, AgentSession, AEP snapshot, input snapshot, and ready materialization are durable but before the worker receives the request or begins execution. Exact replay consults the trace before reselecting Items, Material revisions, Knowledge, or files. An identical request with no worker-launch effect may reuse that exact trace for the one already-authorized first launch; a different request, different immutable input, second trace, or changed bytes returns `recovery_required`. An accepted Turn or scheduler admission without its trace, a trace whose owner tuple is missing, a missing package file, any digest disagreement, or a restricted Material in `materialSelections` also returns `recovery_required`. Replay MUST NOT rebuild the missing trace from current projections, replace an unavailable revision, append later input, or create a receipt, recovery phase, settlement record, or second context owner.

Portable import does not relax this accepted-delivery verifier. S51 MAY invoke one separate imported-history verifier only for a target Workspace with durable `importedFrom` lineage whose reminted trace, AEP, Turn, and worker-request Item use the reserved `import-lineage:sha256:<digest>` request lineage. That verifier MUST still validate the exact Workspace, Thread, Turn, stale imported AgentSession and reminted AEP linkage, worker-request Item and digest, included and excluded Items, package file inventory and every byte digest, Workspace Input Snapshot, Workspace Materialization Record, Material selections and exclusions, and the recomputed trace digest. Retained Turn-owned traces and package bytes remain usable as historical evidence. References to deleted Goal-owned rows confer no authority and require no live Goal or Goal Task during that historical validation. It intentionally does not require a target scheduler admission, execution attempt, Worker Backend Session, or live backend handoff because S51 forbids importing those authorities. The imported Workspace Materialization Record instead carries S51's deterministic redacted historical worker-session reference and internally consistent package, backend-kind, policy, readiness, root, and digest fields; it is not ready for execution.

An imported-history verification result is ephemeral and creates no trace field, status, receipt, record, recovery owner, or workflow. It may support import graph validation, S16's read-only historical `lastWorkerSeenRevisionId`, and the same-Turn S16 Artifact Review integrity check. It MUST NOT support `currentTurnRevisionId` or `activeDelivery`, satisfy worker admission or launch, command replay, reconnect, live materialization readiness, capability or credential authority, or any external effect. A non-imported Workspace, a non-reserved request lineage, or any missing or contradictory portable owner MUST use the strict verifier and fail `recovery_required` when its runtime authorities are absent. An ordinary current target request in an imported Workspace remains eligible only for the strict verifier, and the strict writer and launch reader never call the imported-history verifier.

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

When Core and retained data authority are available, each accepted Worker package includes the applicable Workspace overview and any currently admitted Server overview from the notebook root index. Each overview states its scope, exact notebook revision, original digest, delivered digest and truncation state. Overview content is bounded to 4096 UTF-8 bytes per scope. A missing or denied overview is marked unavailable without storage diagnostics; absence of an overview does not establish absence of Knowledge. User Memory is excluded. Current source and receiving Thread authority are checked before and after package publication, and again before backend materialization and model submission. Server access uses only the current credential retained by the originating scheduler admission.

The Worker receives an explicit instruction to read the overview and ask the Knowledge Manager through `knowledge_ask` for relevant understanding and citations. The overview is untrusted navigation, not instructions or complete evidence. Its exact delivered bytes use the existing package file inventory and digests; no separate selection record, receipt or lifecycle is added. The canonical Worker request and its instruction file remain byte-exact. Historical inspection and exact replay use the retained overview bytes under the existing package rules. Workspace portable read, export and import refuse an immutable package that contains Server overview content under [S51 Personal Data And Audience Coverage](20260704-workspace_backup_export_import.md#personal-data-and-audience-coverage); the value-free Server-unavailable notice remains portable.

Each Knowledge package entry retains the original page id, pinned notebook commit, original digest, complete source references, validated review state, and sensitivity decision. The immutable package separately retains the exact delivered body, excerpt, or descriptor and its digest. Git proves source version; only the S39 trace, inventory, manifest, and retained package bytes prove delivery. A bounded projection never claims delivery of omitted source bytes.

Only valid active pages published under exact human or delegated maintenance authority are eligible for the direct-Task Knowledge bridge. Observations and rejected, deferred, or pending proposals are not worker Knowledge candidates in V1.

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

The Turn-level record is the only durable delivery trace. The runtime-level directory is a derived byte materialization of the package named by that trace and MUST NOT carry an independent status, receipt, or mutable delivery history. Its `knowledge/pages/`, `workspace/materials/` and `sources/` subtrees contain only exact delivered bodies, excerpts or descriptors selected by the trace. Inventory digests verify those delivered bytes. Original page commits, Material revisions and file digests remain separate source references. A source reference does not require another complete original in the package or place its body in a Provider message.

The manifest and Turn trace carry selected files in the existing `sourceFiles` projection. Each entry binds an existing scope-qualified Artifact reference and exact version, Material reference and exact revision, or Turn input reference and immutable ordinal to its original digest, byte length, media type, delivered `packagePath` and representation proof. These are digest references to existing owners, not a new content family, registry, receipt or lifecycle. Before first acceptance, verify current canonical ownership, stream the complete original to verify its captured digest and size, and verify selected delivered ranges against the exact original or representation. Do not retain an additional original or complete representation solely for historical replay. Exact delivered bodies, excerpts and descriptors remain governed work records in the ordinary immutable inventory. Historical verification checks that inventory, manifest, WIS, materialization and trace without requiring current original availability. Missing or corrupt delivered bytes fail closed with no reconstruction. Portable import remints owned qualified references and delivered paths and recalculates existing package proofs; reference-only original or derivative payloads are not required.

A selected PDF text-layer projection retains its processor identity/version/configuration, original and representation digests and sizes, page locators in representation-byte coordinates, coverage and delivered ranges. Only the exact delivered text or descriptor belongs in the retained package. Incomplete extraction remains incomplete even when its available text fits the preview. Current read, search or vision operations recheck the live Turn, current source and receiving audience, resolve the exact selected owner/version and verify the captured original digest and size before disclosure. Current PDF processing may use disposable bounded staging, and a text read or search must also match the captured representation identity and lineage; this is current retrieval, never historical-delivery reconstruction. Missing, changed, inaccessible or unsupported content returns a bounded value-free unavailable result, never newer content under the same locator. Explicitly selected Artifact versions, Material revisions and receiving-Turn inputs retain their complete live delivery: their originals stream through the existing verified per-file transfer into `originals/<digest-hex>` beneath the read-only Context root. The existing owner/version and `originalDigest` locate those files without a new retained path field. A disposable read-only snapshot serves execution but creates no post-settlement retention promise; existing Turn cleanup removes or fences its exposure.

File-system-first records should remain the durable explanation. SQLite or read-model indexing may accelerate lookup, attachment, search, and debugging, but it must not become the only source of truth for context package meaning.

## Historical Inspection

Readers ignore descriptive additions in package manifests, traces, Material and Knowledge selection or exclusion facts, and checkpoint selection summaries. They verify canonical serialization and package, trace and file integrity against the original retained representation before deriving known-field comparisons or public views. Inventory membership and entries remain exact, as do materialization and structured worker instructions; an ignored annotation cannot establish delivery or authorize execution. Same-identity trace writes preserve the original representation, while accepted portable remint recomputes digests after rewriting owned references.

The retained immutable trace and materialized package bytes are the only faithful historical view of what the owning mode delivered. NanoCore MAY read those retained bytes and verify them against the package and per-file digests for inspection, review, or explicit work reflection.

If the retained package is absent, incomplete, or digest-invalid, the historical package is `unavailable` or `drifted`. NanoCore MUST NOT reconstruct it from current Knowledge, source, Artifact, Material, or Workspace records, substitute newer bytes, replay stale authority, or create a repair record. A consumer that needs later inspection retains the original package snapshot; missing history is the accepted bounded compromise.

Historical inspection is diagnostic only. It cannot establish a missing accepted-delivery predicate, authorize first admission, repair a worker Turn, or satisfy launch replay. Launch and exact command replay require the original immutable Turn trace and every byte its inventory names; missing or conflicting authority remains `recovery_required`.

## Resolved Decisions

- The active context taxonomy belongs inside this package spec; the earlier standalone taxonomy draft is superseded.
- `docs/core/knowledge.md` owns canonical Knowledge, Source, Notebook, Knowledge Manager, Agent-Near Context, and Context Package semantics.
- A context package is a data projection, not a separate internal agent role.
- Core Knowledge owns the canonical concept of Context Package; this spec owns the worker-facing package projection, manifest, materialized layout, trace, digest, and replay contract.
- The Knowledge Manager prepares source-traceable knowledge or source material; the Workflow Coordinator composes the semantic worker context; the owning mode service persists, materializes, and delivers it.
- Workers do not silently read all knowledge. NanoCore mediates retrieval, filtering, packaging, and traceability.
- Artifacts can be included as context or become sources for knowledge, but artifacts are not a mandatory middle step for ingest-to-knowledge updates.
- One worker Turn owns one immutable trace at `threads/<threadId>/turns/<turnId>/context-package.json`; its identity, worker request, Item order, exact Material revisions, package files, lineage, and digest are deterministic, and it creates no receipt or workflow.
- A direct Task's Knowledge delivery is proven only by its exact Knowledge page identity, content digest, provenance, and byte tuples inside that same trace, manifest, and file inventory. The single S61 retrieval trace remains a diagnostic selection input and can never substitute for the accepted Turn-owned package; an S17 preparation response only references that trace and is not another Task selection authority.
- Workspace Material selection is restricted to the exact bound revision accepted by S16 and the matching ready workspace handoff records. Goal steering is not a selection. Restricted Material is recorded only as `sensitive_content` exclusion and never enters worker-visible bytes.
- Exact launch and command replay fail closed when that trace or any named authority or byte is absent or conflicting. Historical inspection may report unavailable or drifted bytes but cannot repair or replace accepted delivery.
- The accepted worker-Turn trace, including a Goal-dispatched Task, records exact request bytes, ordered Item references, Material selection or exclusion, independent byte and model-specific token budget decisions, immutable package files, generated `context` input, WIS/WMR and backend-session lineage, queue proof, and stock OpenShell read-only upload verification. That Task uses this same trace for exact selected Knowledge bytes and lineage; no standalone Knowledge Manager context trace or materialization remains.
- Durable context traces should retain stable baseline exclusion reasons. Current item-projection reasons are implementation-specific and should map to the baseline vocabulary before they become durable cross-version trace records.
- Previously open questions are resolved by accepted V1 defaults: worker and artifact-review citations use `contextPackageDigest`, `entryId`, `sourceRef`, optional span metadata, and entry content digest; item-visible traces expose only the selected source summary, citations, redacted selection reason, and package digest, while ranking scores, omitted entries, raw prompt material, and sensitive assembly details stay audit-only.

## Deferred / Future Work

- Extend explicit workspace-root file materialization into automatic root-file selection.
- Extend captured text source snippets into derived representations and policy-filtered full package assembly.
- Extend S61 retrieval diagnostics only when real-use evidence requires more explanation, without changing or duplicating the accepted worker-Turn trace.
- Define item-visible versus audit-only projections for context package traces.
- Define citation projection from context package entries into worker outputs and artifact reviews.
- Extend the required independent byte and model-specific token budgets into time and cost accounting when their owners require it.

## Testing Strategy

- Selection fixture tests for explicit scope, knowledge, artifacts, and workspace files.
- Policy filter tests for restricted knowledge and sensitive sources.
- Budget tests proving lower-priority context is excluded.
- Trace tests proving selected and excluded records are explainable.
- Materialization tests proving no host paths or secrets appear.
- Determinism tests proving one accepted worker Turn yields exactly `ctxpkg_${turnId}`, one immutable trace, stable ordering, and the same digest from the same authoritative inputs.
- One Task Knowledge test proves the exact single S17-to-S61 request, deterministic package-budget subset, exact delivered body/excerpt/descriptor bytes, separate original and delivered digests, and complete source references, and absence of S61-excluded or restricted bytes in the one existing package. A Goal-dispatched Task uses that same proof.
- One representative fail-closed Knowledge test proves a digest-invalid selected page prevents worker launch with the bounded error and cannot be reconstructed from retrieval diagnostics.
- Material tests proving the trace and package select the exact bound revision, verify the captured original digest separately from the delivered projection digest, preserve matching workspace handoff lineage, and never include restricted Material bytes or metadata beyond the allowed exclusion tuple.
- Replay tests proving same-request/no-effect retry reuses the exact trace and bytes, while a changed request, second trace, missing file, missing page bytes, digest mismatch, or restricted selection fails `recovery_required` without reconstruction or settlement state.
- Historical-inspection tests proving retained package bytes verify exactly, while missing or drifted bytes remain unavailable and cannot satisfy accepted delivery or authorize worker launch.

## Risks & Mitigations

- Risk: Context becomes another hidden context store. Mitigation: package records are projections with source references, not new canonical knowledge.
- Risk: Workers miss important context because selection is too aggressive. Mitigation: S61 records addressed retrieval exclusions, S39 records only its own budget omissions, and real review may tune the one ranking owner.
- Risk: Sensitive knowledge leaks into broad worker sessions. Mitigation: policy filtering happens before packaging.
- Risk: Package files drift from stored trace. Mitigation: use digests and verify before launch.

## Links

- `docs/core/knowledge.md`
- `docs/core/storage.md`
- `docs/core/agent-capability.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-knowledge_store_implementation.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260713-work_resource_interaction_model.md`
