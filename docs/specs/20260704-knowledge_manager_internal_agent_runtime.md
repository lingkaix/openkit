# Knowledge Manager Internal Agent Runtime

Status: Accepted
Implementation: Implemented

## Owns

- The runtime interface for the Knowledge Manager internal Core agent.
- Assistant-to-Knowledge Manager query support.
- Workflow Coordinator-to-Knowledge Manager context material requests.
- Passive, active, and scheduled Knowledge Manager execution envelopes as NanoCore internal-agent work.
- Knowledge Manager output classes: answer, uncertainty report, context material, proposal draft, repair suggestion, and health report.

## Does Not Own

- Canonical Knowledge Store semantics, notebook semantics, Knowledge Page, Knowledge Source, Knowledge Proposal, Knowledge Review, or Context Package concepts. `docs/core/knowledge.md` owns those.
- Knowledge governance rules and OKF conformance. `docs/specs/20260702-knowledge_store_governance_rules.md` owns those.
- Knowledge Store file layout, validation pipeline, retrieval implementation, and memory-to-knowledge migration. `docs/specs/20260703-knowledge_store_implementation.md` owns those.
- Final worker-context assembly. Workflow Coordinator owns that.
- Assistant direct answers outside knowledge query support.

## Core References

- `docs/core/knowledge.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/storage.md`

## Summary

Knowledge Manager is the internal Core agent responsible for knowledge retrieval support and knowledge maintenance. Existing knowledge specs define the store, governance, validation, proposals, and retrieval. This spec defines how Knowledge Manager runs as an internal NanoCore agent and how Assistant, Workflow Coordinator, scheduled maintenance, and post-event hooks call it.

Knowledge Manager may prepare source-traceable material and draft proposals. It must not silently rewrite high-impact active knowledge, bypass validation, compose final worker prompts, or become the whole workflow coordinator.

## Goals / Non-goals

### Goals

- Give Assistant and Workflow Coordinator a stable Knowledge Manager interface.
- Keep knowledge answers and context material source-traceable.
- Make passive and scheduled knowledge maintenance governed and auditable.
- Ensure all writes go through the knowledge service and proposal/review rules.
- Keep Knowledge Manager separate from final context assembly and workflow routing.

### Non-goals

- Do not redefine Knowledge Store format or validation.
- Do not let Knowledge Manager write secrets or read vault material.
- Do not let Knowledge Manager directly launch workers.
- Do not let Knowledge Manager silently apply meaning-changing repairs.
- Do not build semantic knowledge v2 or history-derived preference synthesis beyond existing governance.

## Background

`docs/core/knowledge.md` defines Knowledge Manager responsibilities. The governance and implementation specs define Knowledge Manager action categories and rollout sequencing. The missing contract is the runtime boundary that makes Knowledge Manager callable by Assistant, Coordinator, scheduled jobs, and passive hooks without duplicating knowledge semantics.

## Decision

- Knowledge Manager is an internal Core agent.
- It exposes bounded operation families: `answer`, `prepare-context-material`, `draft-proposal`, `suggest-repair`, and `health-check`.
- Assistant may call Knowledge Manager for direct knowledge answers and uncertainty reports.
- Workflow Coordinator may call Knowledge Manager for source-traceable material, exclusions, and confidence signals before final context assembly.
- Knowledge Manager writes must go through the knowledge service and must obey validation, proposal, review, and low-risk repair rules.

## Contract / Expected Behavior

### Operation families

`answer`:

- answers a bounded knowledge question for Assistant or user-facing knowledge lookup
- returns cited knowledge pages, source references, confidence, and uncertainty
- may return `insufficient-evidence` instead of speculating

`prepare-context-material`:

- selects source-traceable material for Coordinator
- returns material references, excerpts or summaries allowed by policy, exclusions, confidence, and trace metadata
- does not assemble the final worker prompt

`draft-proposal`:

- creates a candidate Knowledge Proposal from source material, worker output, user correction, or maintenance findings
- records source references, confidence, freshness, scope, and conflict notes
- does not activate the proposal without review unless governance allows a low-risk path

`suggest-repair`:

- suggests low-risk or review-required repairs for broken links, invalid metadata, stale claims, duplicates, or conflicts
- labels whether the repair is auto-applicable under policy

`health-check`:

- produces a prioritized maintenance report
- may schedule proposal drafts or low-risk repairs according to policy
- must not run an unbounded rewrite

### Callers

- Assistant may call `answer` and receive an answer or uncertainty report.
- Workflow Coordinator may call `prepare-context-material` and `answer` for planning or worker context.
- Post-event hooks may call `draft-proposal` or `suggest-repair` after worker turns, ingest events, user edits, and review decisions.
- Scheduled maintenance may call `health-check`.

### Write rules

- Every Knowledge Manager write must pass through the knowledge service.
- Invalid active knowledge must not enter retrieval.
- High-impact generated output, observations, claims, and repairs require proposal and review unless policy explicitly allows direct application.
- Low-risk repairs may be auto-applied only when they do not change meaning, authority, sensitivity, scope, freshness, or future worker behavior.

### Output and audit

Knowledge Manager outputs must include:

- operation id
- caller context
- workspace id
- source references
- confidence or uncertainty
- policy and validation result when writes are proposed
- created records or proposal ids when applicable

Outputs must not contain secret values, raw vault material, unrestricted file contents, or cross-workspace knowledge.

## Accepted Design

NanoCore implements Knowledge Manager as a thin internal-agent runtime over the knowledge service, retrieval pipeline, validator, proposal service, and scheduler. Operation handlers return typed results to Assistant, Workflow Coordinator, or maintenance jobs. Model use is allowed for synthesis and proposal drafting, but deterministic validation and source traceability gate every write.

## Current Implementation Projection

The current implementation has completed the memory-to-knowledge route and projection rename across the active minimal knowledge slice. NanoCore now exposes deterministic Knowledge Manager `answer`, `prepare-context-material`, first-slice `draft-proposal`, first-slice `suggest-repair`, and bounded `health-check` operations through App API schemas, `@openkit/core-client`, NanoCore server routes, OpenAPI projection, and the MCP `openkit.answer_knowledge`, `openkit.prepare_knowledge_context`, `openkit.draft_knowledge_proposal`, `openkit.suggest_knowledge_repairs`, and `openkit.check_knowledge_health` tools. The read operations are source-cited, return `insufficient-evidence` instead of speculating, and reuse the minimal workspace `KnowledgeEntry` store. The context-material operation returns material references, excerpts, exclusions, confidence, and trace metadata without assembling the final worker prompt. Task Mode Workflow Coordinator now consumes that context-material operation to add matching knowledge refs to bounded worker delegation decisions. The proposal draft operation creates a pending app-local Knowledge Proposal through the existing proposal store and Action Center review flow instead of directly activating knowledge, and it returns deterministic source lineage plus validation status for each caller-supplied source reference. The lineage slice classifies references as registered workspace sources, existing workspace knowledge entries, or external unregistered references that require review. The repair suggestion operation detects duplicate knowledge titles and returns review-required suggestions without applying changes. The health-check operation summarizes current knowledge availability and review-required repair suggestions without scheduling maintenance, applying repairs, or writing new knowledge.

The accepted V1 Knowledge Manager runtime contract is implemented. The Knowledge Store implementation spec still owns the governed validation pipeline, retrieval pipeline, OKF-backed storage, legacy data validation report, and passive or scheduled maintenance loops. Governed proposal validation beyond source-reference resolution, broader repair classes, scheduled health checks, broader Goal Mode Coordinator integration, semantic retrieval traces, and richer maintenance automation remain future hardening work rather than blockers for this V1 runtime boundary.

## Alternatives Considered

- Fold Knowledge Manager into Workflow Coordinator. Rejected: knowledge maintenance and workflow coordination have different ownership and review rules.
- Let Assistant read the Knowledge Store directly. Rejected: Knowledge Manager provides source traceability, uncertainty, and governance-aware answers.
- Make Knowledge Manager an external worker agent. Rejected: it maintains Core-owned knowledge and should stay in the coordination plane.

## Consequences

- Assistant and Coordinator get a stable knowledge support interface.
- Knowledge maintenance remains governed by the same validation and proposal rules.
- Implementation can add active query support before scheduled maintenance.

## Rollout / Migration Plan

1. Implement the knowledge service, validation, retrieval, and legacy data validation report.
2. Add `answer` and `prepare-context-material` operations for Assistant and Coordinator.
3. Add `draft-proposal` after proposal review flow is stable.
4. Add passive hooks after worker turns and ingest events.
5. Add scheduled health checks last. The V1 runtime exposes a bounded on-demand health-check operation; scheduled execution remains deferred until the Knowledge Store maintenance loop exists.

## Testing Strategy / Acceptance Criteria

- L1: operation schema tests for answer, context material, proposal draft, repair suggestion, and health report.
- L1: write-path tests proving every proposed write goes through validation and proposal rules.
- L2: contract tests for Assistant and Coordinator caller interfaces.
- L3: NanoCore black-box tests for knowledge answer, context material request, proposal draft, and health report.
- L6: story acceptance where a user asks Assistant a knowledge-backed question, then a worker task receives Coordinator-assembled context sourced from Knowledge Manager material.

Acceptance: Knowledge Manager can answer with citations or uncertainty, prepare context material without assembling the final prompt, and propose knowledge changes without bypassing validation or review.

## Risks & Mitigations

- Risk: Knowledge Manager over-synthesizes facts. Mitigation: source references and insufficient-evidence outcomes are required.
- Risk: maintenance changes surprise users. Mitigation: high-impact changes become proposals and low-risk auto-repairs are narrowly defined.
- Risk: context material becomes too large. Mitigation: Coordinator applies final context bounds and package policy.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: scheduled Knowledge Manager health checks are deferred until active query and proposal drafting are stable; Assistant-facing knowledge answers must carry structured citations by default, with product surfaces free to render them as inline markers, expandable details, or both.

## Deferred / Future Work

- Knowledge v2 synthesis from long-term history.
- Semantic retrieval and embedding-backed ranking.
- Cross-workspace knowledge sharing.
- Team review rules for shared knowledge.

## Links

- `docs/core/knowledge.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-knowledge_store_implementation.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
