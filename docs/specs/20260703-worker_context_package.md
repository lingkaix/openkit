---
status: Accepted
implementation: Partial
---
# Worker Context Package

Implementation note: item projection, digest records, and the accepted Turn-owned Task and Goal delivery trace are implemented. Real worker launches persist and verify the exact Coordinator request, generated `context` input, immutable package files and trace, Workspace Input Snapshot, Workspace Materialization Record, backend handoff, selected or excluded Workspace Material revisions, and queue proof before launch. Direct Task traces also bind selected Knowledge page identities, content digests, complete provenance, and worker-visible bytes through the same owner. Broader candidate audit detail and citation projection remain unimplemented, so this broader specification remains Partial; Goal-mode Knowledge integration remains explicitly deferred outside the current accepted scope.

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
- The one immutable worker-Turn delivery trace shared by Task Mode, Goal Mode, Work Resource Interaction, replay, and governed Knowledge-use review.

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
- The real Task and Goal launch paths deliver the exact Coordinator request as compact JSON, retain those bytes in the Turn-owned `user-message` Item, create the canonical package under `threads/<threadId>/turns/<turnId>/context-package/`, persist the sibling immutable `context-package.json` trace, materialize the generated read-only `context` input at `/openkit/context`, and verify the existing scheduler, AgentSession, AEP, Workspace Input Snapshot, Workspace Materialization Record, backend-session, Item, Goal or Task, Material, file, and digest owners before worker launch. Mutable checkpoint diagnostics remain non-authoritative and cannot substitute for this proof.
- S51 portable import remints the complete worker Context Package graph and verifies its exact package bytes, stale imported AgentSession, AEP, worker-request Item, Material selections, Workspace Input Snapshot, Workspace Materialization Record, and reserved `import-lineage:` request lineage before publication. This imported-history classification may support only read-only historical `lastWorkerSeenRevisionId` and same-Turn Review integrity; it cannot prove current delivery, admission, command replay, reconnect, steering application, or another external effect.
- The former standalone Knowledge context trace, readback, and materialization operations are deleted without aliases. Knowledge Manager context preparation returns S61's retrieval trace reference, and only this S39 owner materializes or proves worker delivery.
- The current projection policy classifies durable items as user, assistant, artifact, approval, diagnostic, review, goal, tool, knowledge, handoff, or file-change categories. The `knowledge` category covers knowledge-derived context projection items.
- Current exclusion reasons are item-projection reasons only: `policy_excluded`, `ui_only`, `diagnostic_noise`, `artifact_pointer`, `approval_gate`, `goal_state_not_needed`, `review_context_not_needed`, `empty_content`, `sensitive_content`, and `unsupported_item_type`.

The stock OpenShell worker backend uploads the pre-materialized read-only generated context root to the declared `context` slot and verifies its extracted files before launch. A direct Task trace materializes and verifies each selected Knowledge page's exact bytes, digest, complete source references, and package path under that Turn-owned package; Goal Mode has no accepted Knowledge selection integration. Automatic root or Artifact selection, binary root-file conversion, broader audit-only Knowledge candidate traces, model-specific tokenizer accounting beyond the accepted deterministic byte estimate, and citation projection into worker outputs remain deferred future work. Historical inspection is limited to retained digest-checked package bytes; missing package bytes are unavailable rather than reconstructed from current owners.

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

The first production delivery trace is the accepted worker-turn delivery of this specification. S39 owns the trace shape and replay proof; Task or Goal Mode owns the worker request and Turn lifecycle; S16 owns Workspace Material revision, binding, queue, and active-input semantics. Completing this shared delivery does not close the broader Knowledge implementation.

Each worker Turn has exactly one trace whose durable identity is `(workspaceId, threadId, turnId)`. The trace has no independent lifecycle id: `contextPackageId` is exactly `ctxpkg_${turnId}`, and the canonical workspace path is exactly `threads/<threadId>/turns/<turnId>/context-package.json`. A Core-local Turn, including workspace-only Artifact introduction, MUST NOT create this trace.

The immutable trace fields are exact:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Exactly `1`. |
| `contextPackageId` | Exactly `ctxpkg_${turnId}`. |
| `workspaceId`, `threadId`, `turnId` | The one accepted worker Turn lineage and storage scope. |
| `requestId` | The immutable Task, Goal step, or outer-command request that reserved the Turn. |
| `goalId`, `taskId` | Both null for a direct Task Turn; both non-null and mutually valid for a Goal worker Turn. A half-null pair is invalid. |
| `agentSessionId`, `packageSnapshotId` | The exact accepted AgentSession and AEP snapshot used by the Turn admission. |
| `workerRequestItemId`, `workerRequestDigest` | The same Turn's immutable `user-message` Item and `sha256:` digest over its exact compact UTF-8 worker-request bytes. |
| `workspaceInputSnapshotId`, `workspaceMaterializationRecordId` | The exact dedicated read-only Context Package root handoff owners used by the accepted admission. A valid completed existing Materialization Record is ready by predicate; no lifecycle field is added. |
| `policyVersion` | Exactly `worker-context-v1` for this slice. |
| `includedItemIds` | Ordered Item ids actually included. `workerRequestItemId` is first; S13's validated latest Goal Gate request/response pair and any other selected prior Items follow canonical Thread Item order. |
| `excludedItems` | Exactly `{ itemId, reason }` for every considered Item not included. |
| `knowledgeSelectionInput` | Null when no Knowledge selection was requested; otherwise the exact S61 governed-retrieval trace reference defined below. The retrieval trace is an input but not delivery authority. |
| `knowledgeSelections` | The exact included Knowledge page identity-and-content entries defined below. |
| `knowledgeExclusions` | Only the exact S61-selected Knowledge pages omitted by S39's later package budget, as defined below. S61-owned policy, validity, sensitivity, freshness, relevance, and limit exclusions are not copied. |
| `materialSelections` | The exact included Workspace Material revision entries defined below. |
| `materialExclusions` | Exactly `{ materialId, revisionId, sensitivity, reason }` for every addressed Phase 1 Material revision not included under the closed candidate and reason rules below. |
| `fileInventory` | Exactly `{ path, byteLength, contentDigest }` for every worker-visible package file, including the completed `package.json`. |
| `contextPackageDigest` | `ctxpkg_sha256_` plus 64 lowercase hexadecimal digits over the canonical JSON object containing every other listed field. |

Canonical JSON recursively sorts object keys. `includedItemIds` retains delivery order; the worker-request Item is first, then every selected prior Item follows canonical Thread Item order. A non-null S13 `latestGateContextItemId` requires both its uniquely matching request Item and response or decision Item in this ordered set and in the worker request's Item context refs. `excludedItems` sorts by `itemId`; Knowledge selections and budget exclusions sort by `(knowledgePageId, contentDigest)`; Material selections and exclusions sort by `(materialId, revisionId)`; and `fileInventory` sorts by `path`. Every `reason` is one baseline value from this specification, `byteLength` is the exact UTF-8 byte count, and every `contentDigest` uses `sha256:` plus 64 lowercase hexadecimal digits. `contextPackageDigest` excludes only its own field and includes every other listed field, including the digest of the completed worker-visible `package.json`; there is no timestamp in the trace. Accepted time remains owned by the existing Turn and scheduler admission rather than introducing mutable trace state.

The package-root digest is exactly `sha256:` plus 64 lowercase hexadecimal digits over the canonical JSON array of the trace's complete `fileInventory`, already sorted by `path`; canonical JSON uses the rule above. It is a deterministic derivative of the immutable trace rather than another trace field or durable owner. Because `package.json` excludes itself from its worker-visible inventory but the completed file is included in the trace's `fileInventory`, this digest covers every worker-visible byte without a self-reference.

The canonical Workspace package-root directory is `threads/${threadId}/turns/${turnId}/context-package/`; each `fileInventory.path` resolves beneath that directory, while the sibling `context-package.json` remains the trace owner. The accepted AEP snapshot MUST contain exactly one dedicated Context Package workspace input for this Turn. Its `id` is `context_${turnId}`, `kind` is `generated`, `source` is `{ kind: "generated", pathRef: "threads/${threadId}/turns/${turnId}/context-package" }`, `target` is exactly `/openkit/context`, `access` is `read-only`, and `materialization` contains exactly `{ strategy: "filesystem", contentDigest: packageRootDigest, slotId: "context" }`; it carries no mount declaration. This exact tuple binds the existing S23 `context` slot and generated-source adapter rather than introducing a source kind or slot. It is app-local generated content, not a Workspace data source, and therefore has no `sourceId` or catalog authority.

The trace's `workspaceInputSnapshotId` is exactly `wis_${packageSnapshotId}_context_${turnId}` and resolves to one existing Workspace Input Snapshot with `workspaceId` from the trace, `resourceId=context_${turnId}`, absent `sourceId`, `resourceKind=filesystem`, `strategy=filesystem`, `pathScope=["context_${turnId}"]`, empty `writableRoots`, `ignoredPaths`, and `generatedFiles`, `base={ commit: null, contentDigest: packageRootDigest }`, and `createdAt` equal to the accepted Turn's `startedAt`. Its backend summary uses the accepted backend kind, label `${backendKind} worker backend`, and the exact frozen capability list used by the AEP admission.

The trace's `workspaceMaterializationRecordId` is exactly `wmr_${packageSnapshotId}_context_${turnId}` and resolves to one existing Workspace Materialization Record whose `inputSnapshotId`, `workspaceId`, absent `sourceId`, `backendKind`, `packageSnapshotId`, `strategy`, `base`, and `createdAt` equal that Workspace Input Snapshot and accepted admission; `workerSessionId` is the matching existing Worker Backend Session's `backendSessionId`; and `materializedRootRef` is exactly `/openkit/context`. Its `policyDigest` is `sha256:` over canonical JSON of exactly `{ backendKind, packageSnapshotId, requiredCapabilities }`, with `requiredCapabilities` retaining the frozen AEP order. `readinessEvidence` is diagnostic and is exactly, in order, one `{ kind: "backend.<health>", ref: "version:<version>" }` entry when the accepted materialization reports backend health and a version, the same entry with `ref=backendKind` when version is null, followed by one `{ kind: "sandbox.<state>", ref: backendSessionId }` entry when that backend reports a sandbox; omitted evidence produces no entry. The record is complete only when the matching Worker Backend Session has `workspaceHandoffState=complete` and the root at `/openkit/context` verifies against the package-root digest. Existence plus this exact tuple, backend handoff, file inventory, and digest verification is the ready predicate; neither existing record gains a status or lifecycle field.

The owning mode validates and freezes the Goal/Task tuple when it writes the trace. Both fields are null for a direct Task Turn; both are non-null for a Goal worker Turn and MUST resolve to the existing Goal, current Task, worker request, Turn, Workspace, and Thread lineage at write time. The trace retains this linkage after diagnostic checkpoint cleanup, and later verification MUST NOT depend on a checkpoint.

Before the accepted trace becomes durable, current item-projection exclusions map to this specification's existing baseline only. `sensitive_content` remains exact; a structurally unsupported item maps to `unsupported_type`; a missing or unverifiable source maps to `source_unavailable`; and the remaining current category or policy exclusions map to `policy_excluded`. Implementing the trace MUST NOT expand the durable reason enum merely to preserve private projection vocabulary.

### Knowledge Selection Input And Delivery

The accepted Knowledge bridge extends this one existing Turn-owned package and trace; it does not create a Knowledge delivery trace, receipt, state, or lifecycle. Under the current accepted scope, only a direct Task Turn MAY carry a non-null `knowledgeSelectionInput` or non-empty Knowledge arrays. A Goal worker Turn MUST carry `knowledgeSelectionInput=null`, `knowledgeSelections=[]`, and `knowledgeExclusions=[]`; broader Goal integration requires a separately accepted update to its owning mode specification.

The existing `turn.read` release-coupled response projection and its unified Skill/CLI operation expose one additional nullable `contextPackageDigest`; this field is not persisted in `TurnSchema`. It is the exact digest only when S39's strict live accepted-delivery verifier resolves the Turn-owned trace, manifest, inventory, and retained package bytes. It is null for a Core-local Turn, imported history, missing or drifted package bytes, or any Turn without current accepted delivery proof. The projection exposes no package bytes, host path, selection score, or new authority and exists so citations and Knowledge proposal source references can name the already-owned S39 digest without a Context Package read operation.

For a direct Task, the owning Task service invokes S17 `prepare-context-material` exactly once with caller assigned as `task-mode` and normalized S61 request `{ query: input, limit: 5, pinnedConceptIds: [] }`, where `input` is the exact immutable schema-valid `StartTaskModeRequest.input` string with no trimming or rewriting. S17 delegates to S61 exactly once and returns that existing retrieval trace reference; Task MUST NOT call S61 or another selector in parallel. V1 Task Mode exposes no Knowledge pin field; adding one requires an owning Task contract update. The returned S61 row is the sole selection input for that Turn.

`knowledgeSelectionInput` is exactly `{ retrievalTraceId }`, where `retrievalTraceId` names the one existing S61 row returned through S17. The referenced row already owns request digest, ranking, and retrieval exclusions; S39 does not duplicate them. The linkage identifies which selection invocation the Task consumed but is neither an accepted-delivery predicate nor a replay, launch, or repair authority. The S17 response references only this trace and cannot become a second selection owner.

Each `knowledgeSelections` entry is exactly `{ knowledgePageId, contentDigest, sourceRefs, packagePath }`. `knowledgePageId` names one Workspace-owned Knowledge page and `contentDigest` is the V1 identity of its exact canonical UTF-8 bytes at selection time and of the exact bytes written at `packagePath`; no general Knowledge revision record is implied. `sourceRefs` is the page's complete duplicate-free source-reference array sorted bytewise ascending, and `packagePath` is exactly `knowledge/pages/<knowledgePageId>.md`. Review state and sensitivity remain inside the validated exact page bytes and are not duplicated in the trace. V1 does not transform an accepted page into a summary or excerpt: a future transformed projection requires an accepted tuple that separately identifies and digests source bytes and projected bytes.

`knowledgeExclusions` contains exactly one `{ knowledgePageId, contentDigest, reason: "budget_exceeded" }` entry for each page selected by the linked S61 row but omitted by S39's package-stage budget. S61-owned exclusions are never copied here. S39 starts with the exact existing selected-content byte count after the worker request and accepted Material bytes, scans S61 selections in their persisted order, and includes a page only when `ceil((selectedContentBytes + pageByteLength) / 4) <= contextBudgetTokens`; an omitted page does not increase the counter, and scanning continues. This is the only Knowledge exclusion S39 owns.

Before first acceptance, the owning Task service MUST read each S61-selected Workspace Knowledge page, verify its active and retrieval-visible state, policy, sensitivity, page identity, source references, canonical bytes, and digest, then apply the package budget above. It writes only included Knowledge files into the existing package root, repeats the exact delivered selection tuples in `package.json`, and includes every delivered file in the existing `fileInventory`; it creates no other delivery record. Every S61 selection appears exactly once in either `knowledgeSelections` or the S39-only budget exclusions, each delivered entry resolves to exactly one inventory path whose digest equals `contentDigest`, no budget-excluded page has a package file, duplicate page identities or package paths are invalid, and restricted Knowledge can never enter either S39 array or worker-visible bytes.

Missing canonical page bytes before any accepted trace or worker-launch effect returns the existing retryable `source_unavailable` result. Invalid Workspace lineage, an unresolved selected page or content digest, a retrieval contradiction, altered source references, a digest mismatch, a restricted selection, a duplicate disposition, an unexpected Knowledge file, or any trace-manifest-file disagreement returns `recovery_required` before launch. Once the immutable trace and package are accepted, later Knowledge edits, deletion of the retrieval trace, or loss of ranking detail do not invalidate the historical delivery proof: the Turn-owned delivered selection tuples, package-budget exclusions, `package.json`, `fileInventory`, and exact package bytes are sufficient. Conversely, a retrieval or preparation trace, even when intact, MUST NOT prove delivery, replace missing package bytes, or authorize launch.

Exact replay reads this Turn-owned trace before running S17 or S61. An identical request with no worker-launch effect may reuse the already accepted Knowledge selection and byte-identical files for the one authorized first launch. Replay MUST NOT reselect current Knowledge, substitute newer page bytes, recreate a missing file from a retrieval trace, or rewrite the linkage. A changed Task request, a second retrieval trace, a missing delivered Knowledge file, or any mismatch returns `recovery_required`; no receipt, recovery phase, or settlement owner is added.

Each `materialSelections` entry is exactly `{ materialId, revisionId, parentRevisionId, mediaType, contentDigest, packagePath, inclusionReason, bindingMutationRequestId, sensitivity, sensitivityDecision }`, and one trace contains at most one entry per Material. `inclusionReason` is exactly `thread_binding` or `goal_steering`; every `thread_binding` entry carries the exact selected `ThreadMaterialBinding.lastMutationRequestId`. A `goal_steering` entry remains selected by the exact claimed `PendingUserTurnRecord` and takes precedence whenever the same Material is also queued through a binding, regardless of revision; it additionally carries that binding mutation proof only when the queued revision equals the steering revision, and otherwise carries null so a different queued revision remains eligible for a later Turn. `sensitivityDecision` is exactly `included`; and `packagePath` is `workspace/materials/<materialId>/<revisionId>.md` for Markdown or `.txt` for plain text. The trace's Workspace handoff records MUST preserve every selected revision and digest. No entry may substitute a newer revision or a caller-provided byte string.

The complete Phase 1 Material candidate set is closed and ordered: first the exact Material revision in a claimed `goal_steering` pending row, when present, then the exact non-null `latestQueuedRevisionId` of the Thread's unique `bound` Material binding. An unbound binding, a binding with no queued revision, any superseded historical revision, and a different revision queued for the same Material after steering precedence are not addressed by this trace and appear in neither Material list. The claimed steering candidate is required and MUST NOT be placed in `materialExclusions`.

Required steering-candidate failure mapping is exhaustive:

| Failure before accepted delivery | Owning result |
| --- | --- |
| `sensitivity=restricted` | `409 sensitive_content` |
| Current Workspace or worker policy denies delivery, or the verified candidate cannot fit after the required worker request | `503 goal_steering_delivery_unavailable` |
| Canonical source bytes or the selected materializer are temporarily unavailable before any accepted trace or worker-launch effect | Retryable `503 source_unavailable` |
| The pending row, Item, Goal, Turn, Material, revision, digest, package, WIS, WMR, or backend-handoff authority is missing, corrupt, partial, or contradictory | `409 recovery_required` |

Each result is returned before accepting the new worker Turn, advancing its Goal Task, publishing a step receipt, or launching the worker. A failure detected during preflight creates no steering claim. A failure detected only after the operation has compare-and-set the exact `applied` claim but before any downstream effect MUST compare-and-set release that same zero-effect claim during the same invocation before returning the mapped result; the original Item and pending row remain externally `queued`, and a different binding queue remains unchanged. If any downstream effect exists, or the exact release cannot be proven and completed, the result is `recovery_required` and the claim remains for inspection; retry never reselects or silently excludes the required steering revision.

For the remaining automatic binding candidate, exclusion mapping is exact. `inclusionState=excluded` produces `explicit_scope_excluded`; `sensitivity=restricted` produces `sensitive_content`; a current Workspace or worker policy denial produces `policy_excluded`; and failure to fit the verified candidate after required request and steering content produces `budget_exceeded`. These predicates are evaluated in that order, and exactly the first matching reason is recorded. A public or internal, included, policy-allowed candidate that fits MUST be selected. A missing revision, invalid Material ownership, missing canonical bytes, digest disagreement, or unavailable materializer is not an exclusion: it prevents Turn acceptance with S16's typed `recovery_required` or pre-acceptance `source_unavailable` result. This slice does not emit `freshness_expired`, `confidence_too_low`, `relevance_too_low`, `duplicate_or_covered`, `lower_conformance`, `source_unavailable`, or `unsupported_type` for Material candidates.

A Material with `sensitivity=restricted` MUST appear only in `materialExclusions` with reason `sensitive_content`; its title, canonical content, digest, package path, or derived summary MUST NOT enter the worker-visible package. An owning command that explicitly requires a restricted Material must reject before accepting delivery rather than queue input that the package will silently omit. Other sensitivity or policy exclusions use the same fail-closed trace boundary.

The trace is accepted only when the existing Turn, worker-request Item, scheduler admission, AgentSession, AEP snapshot, and package files match the trace and verify by digest. Each Material selection additionally requires its named Workspace Input Snapshot, ready Workspace Materialization Record, and source revision to match the same identity and digest. This predicate, not a trace status field, proves availability to the worker. It does not prove model cognition.

The strict accepted-delivery verifier MUST reject any trace whose `requestId` begins with the reserved `import-lineage:` prefix before reading scheduler, lease, backend-session, or handoff authority. Even matching target-local runtime lookalikes cannot promote imported history into accepted delivery.

The owning mode service writes and verifies the immutable trace after the exact scheduler admission, AgentSession, AEP snapshot, input snapshot, and ready materialization are durable but before the worker receives the request or begins execution. Exact replay consults the trace before reselecting Items, Material revisions, Knowledge, or files. An identical request with no worker-launch effect may reuse that exact trace for the one already-authorized first launch; a different request, different immutable input, second trace, or changed bytes returns `recovery_required`. An accepted Turn or scheduler admission without its trace, a trace whose owner tuple is missing, a missing package file, any digest disagreement, or a restricted Material in `materialSelections` also returns `recovery_required`. Replay MUST NOT rebuild the missing trace from current projections, replace an unavailable revision, append later input, or create a receipt, recovery phase, settlement record, or second context owner.

Portable import does not relax this accepted-delivery verifier. S51 MAY invoke one separate imported-history verifier only for a target Workspace with durable `importedFrom` lineage whose reminted trace, AEP, Turn, and worker-request Item use the reserved `import-lineage:sha256:<digest>` request lineage. That verifier MUST still validate the exact Workspace, Thread, Turn, Goal and Task when present, stale imported AgentSession and reminted AEP linkage, worker-request Item and digest, included and excluded Items, package file inventory and every byte digest, Workspace Input Snapshot, Workspace Materialization Record, Material selections and exclusions, and the recomputed trace digest. It intentionally does not require a target scheduler admission, lease, Worker Backend Session, or live backend handoff because S51 forbids importing those authorities. The imported Workspace Materialization Record instead carries S51's deterministic redacted historical worker-session reference and internally consistent package, backend-kind, policy, readiness, root, and digest fields; it is not ready for execution.

An imported-history verification result is ephemeral and creates no trace field, status, receipt, record, recovery owner, or workflow. It may support import graph validation, S16's read-only historical `lastWorkerSeenRevisionId`, and the same-Turn S16 Artifact Review integrity check. It MUST NOT support `currentTurnRevisionId` or `activeDelivery`, satisfy worker admission or launch, command replay, reconnect, Goal steering `applied` proof, live materialization readiness, capability or credential authority, or any external effect. A non-imported Workspace, a non-reserved request lineage, or any missing or contradictory portable owner MUST use the strict verifier and fail `recovery_required` when its runtime authorities are absent. An ordinary current target request in an imported Workspace remains eligible only for the strict verifier, and the strict writer and launch reader never call the imported-history verifier.

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

Each V1 Knowledge package entry carries the exact Knowledge Page id, canonical-byte content digest, complete source references, review state, sensitivity decision, and package-relative path defined by the accepted trace shape below. The package materializes the exact reviewed page bytes; it does not invent a Knowledge revision, excerpt, summary, or alternate content identity.

Only active reviewed or directly user-authored pages are eligible for the direct-Task Knowledge bridge. Observations and rejected, deferred, or pending proposals are not worker Knowledge candidates in V1.

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

The Turn-level record is the only durable delivery trace. The runtime-level directory is a derived byte materialization of the package named by that trace and MUST NOT carry an independent status, receipt, or mutable delivery history. Its `knowledge/pages/` subtree contains only the exact selected page bytes, and its `workspace/materials/` subtree contains only the exact non-restricted Material revisions selected by the trace.

File-system-first records should remain the durable explanation. SQLite or read-model indexing may accelerate lookup, attachment, search, and debugging, but it must not become the only source of truth for context package meaning.

## Historical Inspection

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
- Workspace Material selection is restricted to the exact bound or steered revision accepted by S16 and the matching ready workspace handoff records. Restricted Material is recorded only as `sensitive_content` exclusion and never enters worker-visible bytes.
- Exact launch and command replay fail closed when that trace or any named authority or byte is absent or conflicting. Historical inspection may report unavailable or drifted bytes but cannot repair or replace accepted delivery.
- The accepted Task and Goal worker-Turn trace records exact request bytes, ordered Item references, Material selection or exclusion, deterministic byte-based budget decisions, immutable package files, generated `context` input, WIS/WMR and backend-session lineage, queue proof, and stock OpenShell read-only upload verification. Direct Task uses this same trace for exact selected Knowledge bytes and lineage; no standalone Knowledge Manager context trace or materialization remains.
- Durable context traces should retain stable baseline exclusion reasons. Current item-projection reasons are implementation-specific and should map to the baseline vocabulary before they become durable cross-version trace records.
- Previously open questions are resolved by accepted V1 defaults: worker and artifact-review citations use `contextPackageDigest`, `entryId`, `sourceRef`, optional span metadata, and entry content digest; item-visible traces expose only the selected source summary, citations, redacted selection reason, and package digest, while ranking scores, omitted entries, raw prompt material, and sensitive assembly details stay audit-only.

## Deferred / Future Work

- Extend explicit workspace-root file materialization into automatic root-file selection.
- Extend captured text source snippets into derived representations and policy-filtered full package assembly.
- Extend S61 retrieval diagnostics only when real-use evidence requires more explanation, without changing or duplicating the accepted worker-Turn trace.
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
- One direct-Task Knowledge test proves the exact single S17-to-S61 request, deterministic package-budget subset, exact delivered page bytes and source references, and absence of S61-excluded or restricted bytes in the one existing package; Goal traces retain null and empty Knowledge fields until Goal integration is separately accepted.
- One representative fail-closed Knowledge test proves a digest-invalid selected page prevents worker launch with the bounded error and cannot be reconstructed from retrieval diagnostics.
- Material tests proving the trace and package select the exact bound or steered revision, preserve matching workspace handoff lineage, and never include restricted Material bytes or metadata beyond the allowed exclusion tuple.
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
