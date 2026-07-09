# Knowledge Model

Status: Accepted

This document defines OpenKit knowledge semantics.

This document owns workspace knowledge, notebook semantics, sources, derived representations, proposals, reviews, Knowledge Manager responsibilities, retrieval, context-package preparation, knowledge governance, and the boundary between reusable knowledge and task-time context.

This document does not own runtime session continuity, workflow progression, final worker prompt assembly, vault secret storage, raw domain-system records, protocol record schemas, storage layout, UI component design, or agent-private memory.

Knowledge is reusable workspace understanding, learning, and collected context.

It is the durable notebook-like layer where users, teams, integrations, NanoCore, and agents preserve information that may become valuable future context.

Knowledge is not runtime session state, not a prompt dump, not hidden agent memory, not raw source storage, and not a replacement for external systems of record.

## Purpose

OpenKit should let a workspace become a useful notebook and agent-near context reserve for the person or team using it.

Users may use a workspace to manage personal notes, reading notes, creative inspiration, project ideas, research collections, team practices, imported wiki material, meeting-derived knowledge, and other long-lived working context.

Teams may use a workspace to collect project thinking, background material, lessons learned, operating rules, external references, and knowledge imported from scattered systems.

The product pain is that valuable information is usually scattered across personal folders, inconsistent file names, ad hoc notes, meeting records, team wikis, chat threads, PDFs, bookmarks, and third-party systems.

OpenKit should help turn that scattered material into an organized, reviewable, and agent-ready notebook without asking users to perform all curation work by hand.

The same knowledge should remain close to agent work.

NanoCore should retrieve, cite, govern, and project relevant knowledge and source material into worker context packages when users ask agents to act.

## Principles

Knowledge is workspace-owned, not agent-owned.

Users and teams retain authority over reviewed knowledge.

The Knowledge Manager performs most organization and maintenance work, but important changes remain reviewable.

Sources provide evidence; knowledge stores curated interpretation.

Context packages are task-time projections, not raw dumps of the notebook or workspace.

File-system-first records should remain inspectable, portable, editable, and easy to back up.

Indexes, embeddings, graph edges, summaries, search CLIs, and read models are accelerators over the notebook, not the primary source of truth.

OpenKit should preserve context near worker execution without absorbing domain systems such as warehouses, CRMs, HR systems, asset systems, or source repositories.

## Canonical Terms

`Knowledge Store` is the workspace-owned system that manages reusable knowledge, notebook pages, source references, proposal lifecycle, review decisions, retrieval indexes, and context-package selection.

`Knowledge Page` is a durable, reviewable, user-visible unit of reusable knowledge.

`Knowledge Source` is evidence or material that a knowledge page, proposal, claim, source summary, or context package cites.

`Derived Representation` is model-readable or searchable material derived from a source, such as extracted text, OCR, captions, transcripts, chunks, thumbnails, summaries, or metadata.

`Knowledge Proposal` is a proposed create, update, merge, split, supersede, archive, or delete operation against the Knowledge Store.

`Knowledge Review` is the human, team, or policy decision that accepts, edits, rejects, defers, archives, or supersedes a proposal.

`Knowledge Manager` is the NanoCore internal agent role responsible for primary knowledge maintenance through schema-aware ingest, query support, retrieval support, source-traceable context material preparation, linting, proposal drafting, page organization, naming, deduplication, stale detection, and source-reference repair.

`Observation` is a low-friction agent-recorded signal about work, source material, or repeated behavior.

Observations are not notebook pages by default.

They may later be aggregated, validated, promoted into proposals, or expired.

`Notebook` is the user-facing product shape over knowledge pages, source references, proposals, source material, and review history.

`Agent-Near Context` is context preserved close enough to worker execution that NanoCore can retrieve, filter, cite, and inject it quickly without asking the worker to rediscover scattered material from unrelated systems.

`Context Package` is the task-time projection of selected knowledge and other context sent to a worker agent.

## Boundaries And Non-Goals

Knowledge owns reusable workspace understanding and source-traceable context preparation.

Knowledge does not own the whole task workflow, worker-agent execution, runtime continuity, final worker prompt assembly, raw source-of-truth records in external systems, or secret material.

Artifacts may become sources for knowledge, but artifacts are not required as an intermediate step for ordinary ingest-to-knowledge updates.

## Operating Model

The canonical lifecycle is:

```text
intake or source
  -> source identity and derived representations
  -> knowledge proposal
  -> review
  -> active knowledge
  -> retrieval and policy filtering
  -> context package
  -> worker execution
  -> observations or proposals
```

Users, team members, integrations, workers, or NanoCore subsystems may introduce potentially useful material.

Ingest inputs may include rough notes, idea fragments, reading notes, uploaded PDFs, documents, media, bookmarks, web captures, meeting records, imported wiki pages, chat records, ticket records, artifacts, and prior outputs.

Ingest does not mean every input becomes active knowledge immediately.

The Knowledge Manager should classify the input, preserve or reference it as source material, create derived representations when useful, normalize titles and filenames where appropriate, draft source summaries, link related material, and propose knowledge pages or page updates.

Users should review and verify important proposed knowledge instead of being responsible for all routine cleanup.

Direct user editing remains available, but the primary maintenance posture is agent-assisted curation with human authority.

## Roles

| Role | Responsibility |
| --- | --- |
| User or team | Provide direction, rough notes, sources, review decisions, verification, and final authority over important knowledge. |
| Knowledge Manager | Maintain notebook health through ingest, naming, summarization, linking, deduplication, source tracing, stale detection, retrieval support, source-traceable context material preparation, and proposal drafting. |
| NanoCore | Own governance, storage coordination, retrieval, policy filtering, context-package projection, audit, and capability boundaries. |
| Worker agent | Consume context packages, produce work, and report observations or knowledge proposals. |
| Integration | Bring external records or source material into the workspace under governed source identity. |

## Notebook-First Use

Knowledge pages are first-class user and team material, not only agent-generated memories.

Users may create and edit pages directly, organize them into collections, link pages together, attach or cite sources, and use the workspace as a long-lived notebook before any agent proposes a change.

The expected product loop should assume users often start from incomplete input: a rough bullet, a half-formed idea, a short instruction, an uploaded PDF, a web link, a folder of files, a meeting integration, or an imported wiki page.

Users should not need to manually transform every input into polished notebook pages.

Agents, especially the Knowledge Manager, maintain this notebook by ingesting sources, drafting summaries, proposing updates, detecting stale or duplicated material, improving names and structure, and preparing knowledge-derived material for context packages used by worker tasks.

OpenKit Web and App are the target product frontends for this notebook.

External Markdown-oriented editors may remain useful for local workflows, but they are not the target frontend or a core dependency.

## Agent-Centric Use

Agents should not care whether useful context originally came from a user-written note, a rough idea, an uploaded PDF, a captured web page, a team wiki import, a meeting transcript, a source summary, or an accepted knowledge page.

For worker agents, those are all context candidates managed behind one workspace boundary.

NanoCore should provide a unified route from stored material to worker-visible context:

```text
source / note / integration / prior work
  -> source identity and derived representations
  -> knowledge pages, summaries, claims, observations, or proposals
  -> retrieval and policy filtering
  -> context package projection
  -> worker agent execution
```

This is the reason to keep useful material in the Knowledge Store.

It places potential context near the work so agents can use it without re-finding, re-summarizing, or re-validating scattered inputs every time.

Agent-near does not mean agent-owned.

Core owns retrieval, policy, source traceability, and injection.

Users or teams own authority over reviewed knowledge.

## Sources And Knowledge

Sources provide evidence.

Knowledge stores reusable, curated interpretation.

The same source may support many knowledge pages.

For example, one uploaded PDF may support a product-positioning page, a research-summary page, and a project-risk page.

The PDF itself remains source material; the reviewed pages are knowledge.

Sources may include user-authored notes, uploaded documents, imported or captured web pages, images, video, audio, meeting records, repository files, thread history, artifacts, external API results, third-party system records, and derived representations.

Sources are not automatically knowledge.

Raw sources should remain source material unless a user or agent curates reusable interpretation from them.

OpenKit may normalize filenames, store metadata, generate derived representations, and track source references.

It should not become the editor or source of truth for raw PDFs, raw datasets, external business records, or domain systems.

## Knowledge Pages

A knowledge page stores reusable, curated workspace understanding.

Examples include:

- user preferences
- workspace principles
- project facts
- personal notes
- reading notes
- creative inspiration
- side-project ideas
- team ideas and project thinking
- meeting-derived decisions or lessons
- imported wiki summaries
- repository conventions
- reviewed decisions
- known failure modes
- reusable procedures
- domain notes
- accepted task lessons
- stable source summaries

Knowledge pages should be readable and editable by users.

The preferred source-of-truth form is file-system-first Markdown with structured metadata where needed.

Detailed schema requirements belong in the Knowledge Store governance spec.

## Direct Knowledge Updates

Ingest should use the shortest governed path into knowledge.

For example, when a user uploads a PDF, NanoCore should preserve the PDF as a source, create derived representations such as metadata or extracted text, then let the Knowledge Manager propose one or more new knowledge pages or updates to existing pages.

The proposal review updates the Knowledge Store directly.

Artifacts are not a required middle step for ordinary ingest-to-knowledge updates.

Worker outputs may also become part of the notebook when they are themselves useful knowledge.

A question may produce an answer page, report, slide deck, visualization, chart, or other deliverable.

If the output is an independent task deliverable, it may first be stored as an artifact.

If the output is already a knowledge page or source summary candidate, the Knowledge Manager may propose it directly as a knowledge update.

The accumulating loop is:

```text
sources -> derived representations -> knowledge proposals -> review -> compiled notebook
compiled notebook -> Q&A / worker output -> knowledge proposals when useful -> improved notebook
```

This loop should work at small and medium workspace scale without requiring a complex RAG stack first.

Search indexes, vector indexes, graph traversal, CLIs, and visual renderers are optional accelerators over the file-system-first notebook.

## Proposals And Review

Agent-generated knowledge must start as proposed knowledge unless policy or explicit user action allows direct creation.

Users may also create proposals or direct edits through notebook surfaces.

A knowledge proposal may request creating, updating, merging, splitting, superseding, archiving, or deleting knowledge.

Each proposal should explain the proposed change, why it matters, which sources support it, confidence, freshness, sensitivity, and target scope when those factors matter.

Knowledge should be visible, reviewable, editable, and removable from active retrieval.

Important edits must preserve history.

Editing important knowledge should create a revision or replacement that supersedes the previous active version.

The previous version should be archived, superseded, or expired rather than silently overwritten.

## Retrieval And Injection

Retrieval selects relevant knowledge or source material for a task.

Retrieval may use explicit scope filters, notebook structure, tags, links, source references, full-text search, vector search, graph traversal, recency, confidence, freshness, sensitivity, human pinning, and agent hints.

Retrieval is not injection.

Retrieved material may still be excluded by policy, token budget, freshness, sensitivity, or relevance.

Injection is the controlled act of adding selected knowledge-derived context to a worker turn.

Injected context should be traceable to knowledge pages and source references.

Injection should preserve which knowledge pages, sources, or derived representations were selected; why they were selected when practical; which turn received the context; whether the worker saw summaries or raw excerpts; and whether sensitive or restricted knowledge was excluded.

Agents should not silently read all knowledge.

Core should mediate retrieval and injection through context packages.

`Context Package` is a task-time data projection, not a separate internal agent role.

The Knowledge Manager selects, filters, cites, and prepares relevant knowledge or source material for a context package.

The Workflow Coordinator decides how that material combines with task instructions, workflow state, constraints, capabilities, stop conditions, and review policy in the final worker context.

During worker execution, worker agents may request additional knowledge through Core-governed capability and knowledge boundaries. The Knowledge Manager may respond with source-traceable material, ask for clarification when evidence is insufficient, or draft knowledge proposals when the work reveals reusable learning.

## Scope And Sharing

Knowledge is workspace-scoped by default.

Inside a workspace, knowledge may have narrower scopes such as personal, shared workspace, project, repository, thread-derived, task-derived, agent-relevant, source-derived, or workspace-specific domain scopes.

Cross-workspace knowledge sharing must be explicit.

Knowledge must not leak across workspaces through agent sessions, manifests, caches, embeddings, indexes, or context packages.

## Governance

Knowledge health is guaranteed by both programmatic validation and manager-agent maintenance.

Programmatic validation should enforce mandatory schema rules, required fields, allowed types, reserved paths, source-reference shape, sensitivity rules, and save-time invariants.

The Knowledge Manager should perform maintenance that requires judgment or synthesis, including ingesting new sources, detecting duplicate topics, repairing links, detecting stale claims, surfacing conflicts, proposing page updates, maintaining indexes, preparing source-traceable context material, and asking clarifying questions when evidence is insufficient.

The Knowledge Manager should not silently rewrite active high-impact knowledge when schema or policy requires review.

Detailed schema lifecycle, conformance levels, observation retention, conflict states, source identity rules, health-check rules, and runtime calling interfaces belong to implementation-facing contracts below the core model.

## Relationships

Items record work history.

Knowledge may be extracted from or attached to work history, but work history is not itself knowledge.

Thread, turn, and item records are important sources because they preserve user instructions, review decisions, approvals, corrections, and agent observations.

Artifacts are durable outputs.

Artifacts may become sources for future knowledge, but artifacts are not the normal middle step for direct source ingest.

Vault owns secret values.

Knowledge must not store secret values.

Knowledge may mention that a credential exists only through a non-secret reference or operational note.

Actual secret material belongs to the vault boundary.

Domain systems own their source-of-truth records.

For example, data warehouses own raw datasets and dataset versioning; CRMs own customer records; HR systems own regulated employee records; asset systems may own raw media; repositories own source files and code history.

OpenKit may cite, summarize, annotate, and contextualize those systems.

It should preserve reusable knowledge and task context around them, not replace them.

## Invariants

- Knowledge MUST remain workspace-scoped by default and MUST NOT leak across workspaces implicitly through agent sessions, manifests, caches, embeddings, indexes, or context packages.
- Reviewed knowledge MUST remain user- or team-authoritative rather than agent-owned.
- Important agent-generated knowledge MUST start as proposed knowledge unless policy or explicit user action allows direct creation.
- Knowledge pages MUST NOT store secret values.
- Context packages MUST be task-time projections, not raw dumps of the notebook or agent-private state.
- Worker agents MUST NOT silently read all knowledge; Core should mediate retrieval and injection.
- Raw domain-system records MUST remain owned by their external system of record unless explicitly imported as OpenKit source material.
