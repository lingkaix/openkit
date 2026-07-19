# Knowledge Model

Status: Accepted

This document defines OpenKit knowledge semantics.

This document owns workspace knowledge, notebook semantics, sources, derived representations, proposals, reviews, Knowledge Manager responsibilities, retrieval, knowledge-derived material selection and preparation, knowledge governance, and the boundary between reusable knowledge and task-time context.

This document does not own runtime session continuity, workflow progression, concrete Context Package files or delivery traces, final worker prompt assembly, vault secret storage, raw domain-system records, protocol record schemas, storage layout, UI design, or agent-private memory.

Knowledge is reusable workspace understanding, learning, and collected context.

Knowledge is not runtime session state, a prompt dump, hidden agent memory, raw source storage, or a replacement for an external system of record.

## Purpose

OpenKit keeps reusable understanding in a workspace-owned notebook and makes relevant, governed material available near agent work.

Sources remain evidence, knowledge remains curated interpretation, and Context Packages remain bounded task-time projections rather than copies of the notebook.

## Principles

- Knowledge is workspace-owned, not agent-owned.
- Authorized humans retain final authority over reviewed knowledge.
- The Knowledge Manager may inspect, organize, retrieve, and propose, but generated learning never promotes itself into active knowledge.
- Sources provide evidence; knowledge stores curated interpretation.
- Context Packages are governed task-time projections, not raw workspace dumps.
- File-system-first knowledge remains inspectable, portable, editable, and easy to back up.
- Indexes, embeddings, graph edges, summaries, and read models are rebuildable accelerators rather than durable knowledge authority.
- OpenKit preserves context near worker execution without absorbing domain systems or their source-of-truth records.

## Canonical Terms

`Knowledge Store` is the workspace-owned system that manages reusable knowledge, notebook pages, source references, proposal lifecycle, review decisions, retrieval indexes, and knowledge selection for Context Packages.

`Knowledge Page` is a durable, reviewable, user-visible unit of reusable knowledge.

`Knowledge Source` is evidence or material cited by a knowledge page, proposal, claim, source summary, or Context Package.

`Derived Representation` is model-readable or searchable material derived from an identified source, such as extracted text, OCR, captions, transcripts, chunks, summaries, thumbnails, or metadata.

`Knowledge Proposal` is a pending request to create, update, merge, split, supersede, archive, or delete Knowledge Store content.

`Knowledge Review` is an explicit decision by an authorized human to accept, reject, or defer a Knowledge Proposal. In create-only V1, changing the proposed page content requires a new proposal rather than a combined edit-and-accept transition.

`Knowledge Manager` is the Internal Core Role responsible for source-traceable knowledge query support, context-material preparation, proposal drafting, validation support, and bounded maintenance suggestions.

`Observation` is a low-friction agent-recorded signal about work, source material, or repeated behavior; it is not active knowledge by default.

`Notebook` is the user-facing product projection over knowledge pages, source references, proposals, and review history.

`Agent-Near Context` is context preserved close enough to worker execution for Core to retrieve, filter, cite, and project it without requiring the worker to rediscover unrelated systems.

`Context Package` is the task-time projection of selected knowledge and other authorized context sent to a worker agent.

## Boundaries And Non-Goals

Knowledge owns reusable workspace understanding and source-traceable knowledge selection.

Knowledge does not own workflow progression, worker execution, final semantic context composition, concrete Context Package persistence or delivery, raw external records, permission semantics, audit schemas, or secret material.

Artifacts may become Knowledge Sources, but artifacts are not required between ordinary source ingest and a Knowledge Proposal.

The Knowledge Manager is not a persistent agent runtime, workflow engine, scheduler, retry queue, or autonomous proposal-application owner.

## Authority And Projection

Authorized users or team members own Knowledge Review decisions and direct user-authored knowledge.

The Knowledge Manager prepares source-traceable answers, context material, proposals, and maintenance suggestions through explicit bounded operations.

The Knowledge Store validates and persists knowledge, proposals, reviews, content identity and lineage, and retrieval projections through its existing owners.

The Workflow Coordinator decides how authorized material combines with task instructions, workflow state, constraints, capabilities, stop conditions, and review policy.

The owning Task or Goal boundary persists, materializes, and delivers the resulting Context Package through the separately owned delivery trace.

A Knowledge selection or preparation result, workspace record, imported record, or diagnostic trace does not prove that a worker received or used knowledge.

## Lifecycle

The canonical lifecycle is:

```text
intake or source
  -> source identity and derived representations
  -> pending Knowledge Proposal
  -> human Knowledge Review
  -> active Knowledge Page
  -> retrieval and policy filtering
  -> Context Package selection
  -> owning worker delivery trace
  -> worker execution
  -> observations or pending Knowledge Proposals
```

Raw material does not become active knowledge merely because it was ingested, summarized, cited, scheduled, or generated by an agent.

## Sources And Generated Learning

Sources preserve evidence identity and lineage; knowledge preserves reusable interpretation.

The same source may support multiple Knowledge Pages, and a Knowledge Page may cite multiple sources.

Raw sources remain source material unless an authorized user authors knowledge directly or accepts a source-linked Knowledge Proposal.

An explicit bounded inspection of exact completed work history MAY produce a source-linked pending Knowledge Proposal.

That inspection drafts a proposal; it is not a Knowledge Review and does not activate knowledge.

Generated learning MUST remain pending until an authorized human accepts it through Knowledge Review.

Citation count, elapsed time, repeated generation, absence of rejection, schedule execution, or later agent use MUST NOT confirm or promote generated learning.

Worker-output provenance requires the exact completed worker Turn and its owning delivery trace.

Workspace-only work, imported history, reconstructed history, standalone Knowledge operations, and records without accepted worker-delivery proof MUST NOT masquerade as worker output.

## Proposal Review, Application, And Reversal

Knowledge changes that may affect future worker behavior MUST remain proposed until Knowledge Review accepts them, except for explicit direct user-authored edits.

An authorized human MAY create or edit knowledge directly through the existing Knowledge mutation owner, but the candidate MUST pass current validation and become `user-authored`; changed bytes MUST NOT retain the acceptance label of an earlier reviewed proposal.

An accepted Knowledge Review authorizes one bounded application through the Knowledge Store owner; the review decision alone does not prove that the change became active.

V1 generated learning is create-only: its pending proposal fixes one absent Knowledge Page id, exact page bytes and content digest, sources, and producer before review. The business activation tuple is the exact proposal, accepting human review, created page and digest, sources, producer, and reviewer. Request, Audit, and command-receipt evidence prove command completion and replay but are not additional activation authority.

A missing or contradictory application owner MUST fail closed and MUST NOT be reconstructed from the current page or process memory.

V1 reversal is an explicit authorized Knowledge-owner command that removes only the unchanged page created by that accepted proposal.

The reversal result MUST retain the original proposal, original review, created-page digest, reversal request, actor, and audit lineage.

Reversal MUST NOT create a second proposal or rollback workflow, erase source evidence, remove a subsequently edited page, or imply reversal of external effects already caused by prior worker use.

Generated update, replacement, merge, split, patch, archive, and delete proposals plus generalized historical restoration remain outside V1 until a separate accepted specification defines their present need and content-history owner.

## Retrieval And Context

Retrieval selects candidate knowledge or source material; policy filtering decides what remains eligible; the owning Context Package projection records the selected bounded result.

Workers MUST NOT silently read all knowledge.

Knowledge selection MUST preserve source references, exact page content digest, freshness, sensitivity, conflict state, and exclusion reasons in the governed retrieval evidence; the owning package trace preserves only its retrieval linkage, delivered page identity and bytes, and any exclusion caused by package-stage budgeting.

Only the owning worker delivery trace proves which exact knowledge-derived bytes or references reached a worker Turn.

Later citations, evaluation, or learning claims MUST resolve to that delivery trace rather than a current Knowledge Page, mutable index, standalone selection trace, or imported history.

## Scope And Relationships

Knowledge is workspace-scoped by default and MUST NOT leak across workspaces through sessions, manifests, caches, embeddings, indexes, traces, or Context Packages.

Items and work history may be Knowledge Sources, but they are not knowledge by themselves.

Artifacts may become Knowledge Sources, but they are not the ordinary ingest-to-knowledge middle step.

Vault owns secret values; Knowledge Pages MUST NOT store them.

External domain systems own their raw source-of-truth records; OpenKit may cite, summarize, and contextualize those records without replacing their authority.

## Invariants

- Reviewed knowledge MUST remain human-authoritative and MUST NOT become agent-owned.
- Direct human creates and edits MUST pass current validation and MUST NOT preserve a reviewed-proposal acceptance label across changed bytes.
- Generated learning MUST enter as a source-linked pending Knowledge Proposal and MUST NOT self-promote or self-confirm.
- Only an authorized human Knowledge Review may accept generated learning for active retrieval.
- An accepted review MUST NOT count as applied knowledge until the exact proposal-created page, content digest, source lineage, producer, and accepting human review are durable. Missing Audit or command receipt prevents a success or replay claim and returns `recovery_required`, but does not deactivate an otherwise complete business tuple.
- A V1 reversal MUST remove only the unchanged proposal-created page and retain both the original and reversal evidence.
- Workspace-only, imported, reconstructed, or standalone Knowledge provenance MUST NOT masquerade as completed worker output.
- Only the owning worker delivery trace may prove that a worker received selected knowledge.
- Knowledge Pages MUST NOT store secret values.
- Raw external records MUST remain owned by their external system unless explicitly captured as OpenKit source material.
