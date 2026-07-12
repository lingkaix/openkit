# Worker Context Taxonomy

Status: Superseded
Implementation: N/A
Status Changed: 2026-07-03
Current Guidance: `docs/specs/20260703-worker_context_package.md`, `docs/core/knowledge.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The Worker Context Package specification absorbed the operational context categories used during package assembly, while the Core Knowledge document became the canonical owner for durable knowledge semantics. This draft lost authority because its mixed taxonomy can no longer govern either contract independently.

## Retention Reason

This document preserves the original taxonomy discussion and the boundary questions between durable knowledge and task-local context so maintainers can understand why ownership was split between the active package contract and Core semantics.

## Summary

This spec defines the context categories OpenKit should recognize when preparing a worker agent to do useful work.

The goal is not to turn every piece of context into durable knowledge. The goal is to classify worker-relevant context clearly enough that NanoCore can decide what to retrieve, what to inject, what to preserve, what to cite, and what to leave in an external source of truth.

The same taxonomy also protects the user-facing notebook model: a workspace may be used for personal notes, reading notes, creative inspiration, team wiki material, meeting-derived knowledge, project thinking, and other long-lived knowledge even before a worker agent consumes it.

The clean target model is:

```text
Sources and work history provide evidence.
Knowledge stores reusable notebook material and reviewed interpretation.
Context packages project task-relevant context to worker agents.
```

## Goals

- Define the main categories of context a worker agent may need.
- Distinguish durable knowledge from knowledge sources, workflow state, raw materials, external systems, and runtime policy.
- Keep the taxonomy domain-neutral so each workspace can grow its own notebook structure, labels, templates, and domain vocabulary.
- Make context packaging explicit instead of letting worker agents silently read all workspace material.
- Treat user-authored and team-authored notebook material as first-class knowledge, not merely as future agent memory.
- Preserve the file-system-first and notebook-like user experience while keeping retrieval and indexes as derived support layers.

## Non-goals

- Do not define an implementation schema, storage layout, API contract, or migration plan.
- Do not define domain-specific objects such as datasets, campaigns, candidates, customers, invoices, employees, or assets as core OpenKit concepts.
- Do not make OpenKit a data warehouse, digital asset editor, document editor, HRIS, CRM, ERP, ATS, DAM, MAM, or source-of-truth replacement for external systems.
- Do not require every context source to become a knowledge page.
- Do not require every worker run to produce knowledge proposals.

## Background

OpenKit coordinates real work through durable workspaces, threads, turns, items, artifacts, approvals, agents, and worker runtimes. It also lets a person or team build a durable workspace notebook from their own notes, ideas, source material, imported records, and accumulated lessons.

Many inputs begin as scattered, low-structure material: brief user notes, loose ideas, uploaded files, web links, meeting records, copied snippets, imported wiki pages, and third-party integration records. OpenKit should treat those as candidates for curation near agent work, not as already-polished knowledge.

A worker agent needs enough task-specific context to operate correctly, but raw context can come from many places: user instructions, workflow state, repository files, notebook pages, uploaded documents, external APIs, prior work, artifacts, policy, and runtime capabilities.

From the agent perspective, these different origins should converge into one governed context path. The worker should not need separate mental models for notes, PDFs, imported wikis, meeting records, source summaries, or reviewed knowledge pages. NanoCore should retrieve and package the relevant subset through a unified context mechanism.

If every category is collapsed into `memory`, the system will either inject too much noisy context or preserve transient material as if it were stable knowledge. If every category is treated as a note, the worker-facing execution boundary becomes unclear. OpenKit needs a neutral taxonomy that supports both user-facing notebooks and worker-facing context packages.

## Decision

OpenKit should use `Knowledge` as the core semantic layer for reusable workspace knowledge and `Context Package` as the worker-facing execution projection.

`Notebook` is the user-facing product shape over knowledge pages, source references, proposals, source material, and review history.

`Memory` should not be the top-level core model. It may remain an agent-facing or legacy implementation term until the implementation is renamed, but the target model is knowledge-centered.

## Context Categories

| Category | Purpose | Typical sources | Worker use | Knowledge relation |
| --- | --- | --- | --- | --- |
| Authority context | Defines the current task's governing instruction and non-negotiable constraints. | Current user request, system instruction, active goal, accepted plan, explicit user constraints. | Usually injected directly and given high priority. | Durable user preferences or stable workspace principles may become knowledge after review; current-task authority does not automatically become knowledge. |
| User intent context | Captures the user's immediate intent, preferences, clarifications, corrections, and acceptance criteria. | User messages, follow-up turns, pending input, user comments, review feedback. | Inject when relevant to the task or active thread. | Reusable preferences, durable corrections, and accepted judgments may become knowledge proposals. |
| Intake context | Captures low-structure material the user, team, integration, or worker introduces for later organization. | Rough notes, idea fragments, URLs, uploaded folders, PDFs, meeting minutes, imported wiki pages, clipped text, integration records. | Usually not injected directly until classified, summarized, or linked to a task. | Intake material should become sources, drafts, observations, or knowledge proposals after Knowledge Manager curation. |
| Workflow context | Explains where the current work is in the OpenKit process. | Thread state, turn state, goal state, plan items, Action Center rows, pending approvals, pending user input, handoff records. | Inject as operational context so the worker knows what to do next. | Usually not knowledge. Durable process lessons or workflow conventions may become knowledge. |
| Work history context | Provides prior attempts, decisions, and traceable conversation history. | Threads, turns, items, approval decisions, review verdicts, prior summaries. | Inject selectively through summaries, cited items, or handoff context. | Work history is a source. Reusable conclusions extracted from it may become knowledge. |
| Knowledge context | Provides reviewed, reusable workspace knowledge. | Knowledge pages, accepted knowledge proposals, user-edited notebook pages, reviewed lessons. | Retrieve and inject by scope, relevance, freshness, sensitivity, and token budget. | This is the active knowledge layer. |
| Source corpus context | Provides raw or imported materials that may support work. | Uploaded PDFs, Markdown files, Word documents, images, videos, audio, URLs, meeting records, source files, attachments. | Inject selected snippets, derived representations, or file references when relevant. | Sources are evidence, not knowledge. Stable interpretation of sources may become knowledge. |
| Derived representation context | Makes source material model-readable and searchable. | Extracted text, OCR, captions, transcripts, summaries, thumbnails, chunks, metadata, citation anchors. | Inject instead of raw media when it is the right representation for the task. | Derived representations are not knowledge unless curated and reviewed as reusable interpretation. |
| Workspace material context | Provides the actual work objects in the workspace. | Repository files, specs, READMEs, configs, scripts, tests, design files, notebooks, artifacts. | Inject references or excerpts needed for the assigned task. | Workspace materials are sources. Conventions, decisions, and procedures derived from them may become knowledge. |
| External observation context | Provides current or third-party information. | API responses, web search results, GitHub issues, Linear tickets, Slack messages, calendar events, analytics tools, warehouse queries. | Inject with source, timestamp, provider, and freshness information. | External observations are sources. Reviewed stable summaries may become knowledge with freshness metadata. |
| Artifact context | Provides prior outputs and evidence generated by OpenKit work. | Reports, diffs, generated files, charts, screenshots, test evidence, design assets, exported documents. | Inject when the artifact is input to the new task or evidence for a decision. | Artifacts are sources. Accepted findings or lessons from artifacts may become knowledge. |
| Generated output context | Captures worker-generated answers, reports, slides, visualizations, charts, and notebook pages that may become workspace knowledge or artifacts. | Markdown answers, slides, charts, generated diagrams, rendered summaries, exported documents. | Inject when a later task builds on the generated output. | Reviewed outputs may become direct knowledge proposals, knowledge pages, source summaries, claims, lessons, artifacts, or artifact-backed source references. |
| Feedback and review context | Records human or reviewer interpretation of work. | User approval, rejection, correction, comments, client feedback, reviewer verdicts. | Inject when it changes the task direction or validates prior output. | Durable feedback often becomes a strong source for knowledge proposals. |
| Runtime and capability context | Explains what the worker can do in the current environment. | Agent profile, available tools, MCP servers, workspace roots, sandbox summary, model, provider, budget, timeouts, platform constraints. | Inject as a concise execution summary. | Not knowledge. Some durable workspace setup conventions may become knowledge. |
| Policy, permission, and safety context | Defines allowed actions and sensitive boundaries. | Permissions, capability policy, vault grants, redaction rules, sensitivity labels, audit requirements. | Inject only as necessary policy summaries and non-secret references. | Not knowledge in the ordinary notebook sense. Policy documents or operating rules may be sources for knowledge, but secret values never become knowledge. |
| Agent observation context | Captures what agents discovered during work. | Tool outputs, command summaries, diagnostics, reasoning summaries, failure observations, worker reports. | Inject only after filtering and summarization. | Agent observations become knowledge only through proposal and review. |

## Knowledge Versus Sources

Knowledge is reusable, governed interpretation that a future worker may use as trusted workspace context.

Sources are the evidence, materials, records, or external observations that justify or explain knowledge.

The same object may act as a source for many knowledge pages. For example, one uploaded PDF may support a product-positioning page, a research-summary page, and a project-risk page. The PDF itself remains source material; the reviewed pages are knowledge.

## What Should Become Knowledge

These context types are strong candidates for knowledge when they are useful beyond one turn:

- User-authored or team-authored notes after they are organized enough to be reusable.
- Rough ideas or inspiration after they are curated into a durable page, topic, or project note.
- User preferences that should guide future work.
- Workspace goals, standards, and operating principles.
- Project facts that remain useful across tasks.
- Repository conventions and validation commands.
- Reviewed decisions and their rationale.
- Reusable procedures and playbooks.
- Known failure modes and proven mitigations.
- Domain notes that the user wants to maintain in notebook form.
- Lessons extracted from completed work after review.
- Stable summaries of source materials with citations.
- Accepted interpretations of user feedback.

## What Should Remain A Source

These context types should usually remain sources rather than active knowledge:

- Low-structure intake material before curation.
- Raw uploaded files.
- Raw PDFs, images, videos, audio, or web captures.
- Raw external API responses.
- Raw databases, data warehouse tables, analytics exports, or large datasets.
- Repository files that already have their own source-of-truth lifecycle.
- Thread logs, turn logs, and item logs.
- Artifacts such as reports, charts, diffs, screenshots, and generated documents.
- Tool outputs and diagnostics.
- Meeting transcripts and raw notes before curation.

OpenKit may normalize names, store metadata, generate derived representations, and keep source references for these objects. It should not pretend that source management is the same as knowledge curation.

## What Should Not Be Stored As Knowledge

The following must not become ordinary knowledge pages:

- Secret values.
- Raw credentials, tokens, passwords, keys, or recovery codes.
- Unreviewed agent guesses that affect future decisions.
- Temporary task state.
- Hidden chain-of-thought or private scratchpads.
- Raw personal or sensitive records unless the workspace explicitly models them as governed source material with policy controls.
- Domain-system records that should remain in a system of record such as a warehouse, CRM, HRIS, ATS, ERP, or file repository.

## Source References

Knowledge pages and proposals should cite sources when the claim needs traceability.

Source references may point to:

- Thread, turn, and item records.
- User messages and review decisions.
- Artifacts and generated evidence.
- Uploaded files and page, section, or timestamp anchors.
- Workspace files and line ranges.
- URLs and captured snapshots.
- External provider records.
- Derived representations such as OCR, transcripts, captions, or extracted text.

Source references make knowledge reviewable without copying every source into the knowledge page.

## Context Package Role

A context package is the task-time projection sent to a worker agent.

It is the point where scattered workspace material becomes agent-usable context.

It may include:

- Authority context.
- Current user intent.
- Relevant workflow state.
- Selected knowledge.
- Source snippets and citations.
- Artifact references.
- Derived representations.
- External observations with timestamps.
- Runtime and capability summaries.
- Policy and safety summaries.
- Expected outputs and acceptance criteria.

It should not be a raw dump of the whole workspace, the whole notebook, the whole thread, or every matching search result.

The context package should hide source diversity without hiding provenance. A worker receives selected context in a coherent package, while NanoCore preserves whether each selected piece came from a note, source file, derived representation, knowledge page, artifact, external observation, or work-history record.

## Compiled Notebook Role

The Knowledge Store may operate like an LLM-compiled wiki.

Raw or imported material enters as sources and intake context. The Knowledge Manager turns that material into derived representations, source summaries, concept pages, indexes, backlinks, and curated knowledge pages.

Worker Q&A should read the compiled notebook first, follow links and indexes, then pull sources or derived representations when the answer needs evidence. Generated outputs such as Markdown reports, slides, charts, or visual summaries may be proposed or incorporated into the notebook after review.

Ingest-to-knowledge should be direct. A new source may produce metadata, extracted text, summaries, and one or more knowledge proposals without first becoming a task artifact.

Generated task deliverables may still be stored as artifacts when they are reports, charts, slides, or exported documents. If a generated output is already a knowledge page or source summary candidate, the Knowledge Manager may propose it directly as a knowledge update.

This role does not require a particular external editor or retrieval engine. OpenKit Web and App are the target product frontends. Custom search CLIs, rendered visualizations, and vector or graph indexes are product or implementation choices over the same core model.

## Proposal Flow

Agents and users may propose changes to knowledge.

The common user-facing flow is:

```text
User, team, integration, or worker introduces rough material
  -> NanoCore records source or intake material
  -> Knowledge Manager classifies, summarizes, links, and drafts candidate knowledge
  -> user, team, or policy reviews important changes
  -> accepted or edited proposal becomes active knowledge
  -> future context packages may retrieve and inject it
```

The worker-originated flow is:

```text
Worker or user observes useful reusable context
  -> NanoCore records a knowledge proposal
  -> proposal cites source references
  -> user, team, or policy reviews it
  -> accepted or edited proposal becomes active knowledge
  -> future context packages may retrieve and inject it
```

Rejected or deferred proposals remain useful review records, but they are not active knowledge.

## Domain-Neutral Extension

OpenKit should not hard-code domain concepts into the core taxonomy.

Different workspaces may grow different notebook structures:

- Software and data teams may organize architecture, metrics, incidents, procedures, and research.
- Marketing teams may organize clients, brand voice, creative references, and campaign learnings.
- HR teams may organize role rubrics, hiring principles, and process lessons.
- Personal workspaces may organize ideas, readings, side projects, and life admin.

Those are workspace-specific structures built on the same core categories: sources, derived representations, knowledge pages, proposals, reviews, indexes, and context packages.

## Consequences

- OpenKit can keep knowledge close to agent work without turning every source into memory.
- Worker agents can receive high-quality context while NanoCore preserves source traceability and human control.
- Users get a notebook-like surface instead of a hidden memory manager.
- Domain-specific work can evolve inside a workspace without forcing domain objects into the core model.
- Implementation must eventually rename memory-centered schemas, tools, and item names to knowledge/context-centered contracts.

## Open Questions

- What minimum source reference shape should land first?
- Should source material live under one generic source registry before specialized media or document helpers exist?
- Which proposal actions are required for the first implementation slice: create, update, merge, supersede, archive, or delete?
- How much source evidence should a proposal require before it can be accepted without additional user editing?
- Which context package decisions should be item-visible by default, and which should stay in audit or capability records?

## Links

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/storage.md`
- `docs/core/knowledge.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260616-agent_environment_package.md`
