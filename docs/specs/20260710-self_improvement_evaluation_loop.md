# Explicit Work Reflection And Knowledge Improvement

Status: Accepted
Implementation: Implemented

## Owns

- The V1 composition by which an authorized agent explicitly reviews exact completed Workspace work and may create one existing source-linked pending Knowledge Proposal.
- The boundary between advisory agent analysis, human Knowledge Review authority, later S39 delivery proof, and bounded Knowledge-owner reversal.
- The end-to-end acceptance predicates for that composition.

## Does Not Own

- A new reflection operation, API route, durable record, lifecycle, or internal Core Role. S18 adds no operation: the composition uses existing work-history reads, `knowledge.proposal-draft`, and `knowledge.proposal-decide`, plus the S61-owned bounded `knowledge.proposal-reverse` operation and existing Knowledge Page reads.
- Knowledge, Knowledge Proposal, Knowledge Review, validation, retrieval, proposal application, or revision storage. `docs/core/knowledge.md`, `docs/specs/20260702-knowledge_store_governance_rules.md`, and `docs/specs/20260703-knowledge_store_implementation.md` own those contracts.
- Worker-context selection, persistence, materialization, or delivery. The owning mode service and `docs/specs/20260703-worker_context_package.md` own those effects and the single accepted S39 trace.
- A persistent Reflector, Task Evaluator implementation, internal-agent runner, scheduler, trigger, event hook, retry queue, checkpoint, private session, or recovery workflow.
- Evaluation suites, `EvalTask`, a Judge, an Evaluation Harness, Skill Catalog versioning, prompt mutation, coordinator mutation, auto-promotion, or unattended self-improvement.

## Core References

- `docs/core/foundation.md`
- `docs/core/architecture.md`
- `docs/core/knowledge.md`
- `docs/core/agent-workflow.md`
- `docs/core/protocol.md`
- `docs/core/audit.md`

## Related Specifications

- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260702-knowledge_store_governance_rules.md`
- `docs/specs/20260703-knowledge_store_implementation.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`

## Summary

OpenKit V1 supports deliberate learning from real work without adding another runtime or workflow engine. An authenticated user asks an agent to inspect one retained completed work history through the existing unified `openkit` Skill and bundled CLI. The agent may then call the existing `knowledge.proposal-draft` operation with exact Workspace-owned source references and complete create-only Knowledge Page content, or explain that the evidence does not justify a reusable lesson without creating Knowledge state.

Agent analysis is advisory. The proposal remains pending until the existing human Knowledge Review owner accepts, rejects, or defers it. Changing the fixed candidate requires a new proposal. A later worker has used accepted knowledge only when its existing S39 Context Package trace proves that the exact selected bytes were materialized and delivered. Reversal is a narrow Knowledge-owner mutation against the exact proposal-created page and retained lineage, not a second improvement lifecycle.

## Goals / Non-goals

### Goals

- Turn exact completed-work evidence into a reviewable, source-linked, create-only Knowledge Proposal when the evidence supports one bounded reusable lesson.
- Preserve an honest no-proposal result when evidence is missing, contradictory, `restricted`, denied by current policy, secret-bearing, or too weak.
- Keep every mutation under existing Knowledge Proposal, Review, validation, page, audit, and command-idempotency owners.
- Prove later use only through the existing S39 delivery authority.
- Provide one stale-safe reversal path for a page created by an accepted proposal.

### Non-goals

- Do not mine work passively or on a schedule.
- Do not infer improvements from incomplete or cross-Workspace history.
- Do not create a general improvement-proposal type or lifecycle.
- Do not evaluate or mutate Skills, prompts, agents, workflows, coordinator behavior, NanoCore code, or external systems.
- Do not automatically accept, promote, confirm, expire, or reverse knowledge.

## Decision

- V1 reflection is a composition of existing transport-neutral operations, not a new `knowledge.reflect` operation or NanoCore subsystem.
- The reviewing agent reads exact completed Workspace records through the unified Skill/CLI and either returns ordinary advisory output or invokes `knowledge.proposal-draft` once.
- A generated proposal is create-only. Before review it fixes its target page id, exact page bytes, content digest, and source lineage; it cannot describe a generic update, merge, Skill change, or workflow change.
- NanoCore validates the normal proposal command, exact same-Workspace source references, create-only target, content shape, and authorization. It does not run a model or persist reflection state.
- Human Knowledge Review is the only activation authority. Agent output, proposal existence, retrieval selection, citation count, and later model agreement cannot activate knowledge.
- Later worker use is proved only by the immutable S39 trace owned by that worker Turn.
- Reversal uses the existing Knowledge owner and exact proposal, review, page, and digest lineage. It creates no rollback workflow or durable improvement state.

## Contract / Expected Behavior

### Evidence boundary

The reviewing agent may inspect existing readable completed-work projections from one Workspace. For the V1 proposal mutation, however, S61's closed evidence vocabulary is the complete boundary: one terminal direct-Task worker Turn, the final completed `assistant-message` Item projected by that Turn, and the exact accepted S39 digest exposed by the existing `turn.read` response projection, with optional exact registered-Source or directly `user-authored` Knowledge-Page references. That digest is non-null only when S39's strict live accepted-delivery verifier succeeds; imported history and any Turn without retained verified package bytes project null and cannot supply this evidence. An `accepted` generated Page cannot become proposal evidence because V1 deliberately avoids a transitive proposal-authority graph. The agent supplies the matching `turn`, `item`, and `context-package` references in the fixed candidate page and proposal; a request `user-message` or another completed Item cannot masquerade as worker output. Other Artifacts, reviews, EvidenceBundles, audit, usage, or external material may guide advisory analysis but must first be explicitly captured through the existing registered Knowledge Source owner before becoming proposal evidence.

Candidate lesson text, caller-supplied summaries, copied response text, model claims, projection labels, and external URLs are proposed interpretation, not evidence. A missing accepted S39 trace MUST NOT be reconstructed or replaced with current Workspace state. Secret values, Vault material, raw credentials, unrestricted host paths, and cross-Workspace content MUST NOT enter the proposal, review projection, audit summary, or CLI output.

If the evidence is missing, contradictory, stale, unavailable, or insufficient, the agent returns ordinary advisory output and does not call the proposal mutation. No durable `advisory`, `partial`, `reflection`, or `evaluation` record is created.

### Proposal creation and command replay

`knowledge.proposal-draft` MUST accept the complete create-only target and exact source references required by S60 and S61. A successful call creates one ordinary pending Knowledge Proposal and returns its existing identifier and validation result. It creates no page, review decision, reflection record, evaluation record, or private lifecycle.

The command uses the normal command-ledger key `command + requestId + scope`, with scope exactly `{ workspaceId }`; the complete normalized draft request is the input hash. A stored receipt replays through the existing owner projection, any changed draft input under the same Workspace and request id returns `idempotency_key_conflict`, and a proposal found through S61's deterministic Workspace-plus-request owner id without a completed receipt returns `recovery_required`. Title and candidate fields MUST NOT enter the ledger scope because changing them would bypass same-request conflict detection. The command does not reconstruct a response, expand the direct-mutation ledger contract, or create recovery state.

### Human review and application

The existing Knowledge Proposal and Knowledge Review owners decide acceptance, rejection, or deferral. Acceptance applies only the exact reviewed create-only target and remains subject to current authorization, validation, conflict, sensitivity, and source-lineage checks. Once any generated proposal for a page id is accepted, its retained Proposal and Review permanently reserve that id against later generated proposals; reversal removes the page but a later generated proposal must choose another id.

Application may require more than one file write. Success MUST NOT be reported until both the accepted decision and the matching proposal-created page are durable. If interruption leaves an accepted decision without its exact page effect, that condition remains discoverable; replay of the same authorized decision may complete the deterministic missing effect, otherwise it returns `recovery_required`. No background repair, settlement record, or recovery workflow is created.

Rejecting or deferring a proposal changes only its existing review lifecycle. It MUST NOT trigger another agent call, worker Turn, retry, or follow-up automatically.

### Later use and delivery proof

S61 retrieval may select the accepted page according to its deterministic rules. Its trace is an audit input, not delivery proof. A later Task worker has received the page only when its accepted S39 trace names the exact page identity, content digest, source references, materialized path, and verified bytes under the worker Turn's owner tuple.

If the required S39 trace, page byte, digest, or owner tuple is missing or contradictory, delivery remains unproved and the owning S39 path fails closed. Reflection MUST NOT repair, replace, or settle that delivery.

### Bounded reversal

A reversal request through the existing Knowledge owner MUST name the original proposal and accepted review, the exact proposal-created page, and the expected current digest. The original content digest is resolved from the named immutable proposal and review rather than duplicated in the request. It may remove that page only when all lineage matches and the page remains unchanged. Proposal, review, command, and audit evidence remain retained and continue reserving the page id, so no later byte-identical page can be mistaken for the old proposal's effect.

If the page has changed, reversal returns S61's `409 conflict`; missing or contradictory lineage returns `409 recovery_required`, and both produce zero mutation. Reversal MUST NOT delete intervening history, reopen completed work, enqueue follow-up execution, or create recovery state.

### Restart and dependency failure

The composition has no resumable lifecycle. After restart, only records owned by the completed work, Knowledge Proposal, Knowledge Review, Knowledge Page, command ledger, audit, usage, and S39 contracts remain. An interrupted reviewing-agent attempt is simply incomplete; the user may inspect existing records and authorize a fresh attempt.

An authorization, Knowledge Store, canonical-history, provider, worker, or transport failure uses its existing bounded error and creates no reflection state. If a pending proposal was already created, it remains visible through its existing owner; otherwise no improvement mutation exists.

## Proposed Design

Use the unified `openkit` Skill and bundled CLI as the agent's composition surface. Reuse existing work-history reads, `knowledge.proposal-draft`, `knowledge.proposal-decide`, Knowledge Page reads, the S61-owned bounded `knowledge.proposal-reverse`, and S39; extend only their owning contracts where exact source, page, application, reversal, and delivery predicates require it. Add no reflection route, schema family, module, table, file-backed ledger, runner, or dependency.

## Current Implementation Projection

The repository already has completed-work projections, a unified Skill/CLI, pending Knowledge Proposals, human review decisions, deterministic retrieval, audit and usage records, and accepted S39 worker delivery traces. These are the only permitted V1 owners.

The explicit V1 composition is implemented through existing owners. Proposal drafting freezes one create-only page target, exact bytes, digest, and same-Workspace completed-work lineage; human acceptance applies only that reviewed target; direct Task retrieval uses S61 and S39 materializes and verifies the exact selected page bytes; bounded reversal removes only the unchanged proposal-created page while retaining proposal, review, command, and audit evidence. One real stock-OpenShell/Codex loop on A1 proved completed work, proposal, human acceptance, later worker-visible use, and reversal without adding a reflection endpoint, lifecycle, scheduler, runner, or Harness.

## Testing Strategy / Acceptance Criteria

- L1/L2 prove the existing proposal command's exact same-Workspace source validation, create-only target, request replay/conflict, product-safe errors, application retry boundary, and stale-safe reversal. One negative case proves missing, contradictory, restricted, policy-denied, secret-bearing, or insufficient evidence causes no proposal call and no durable Knowledge or reflection state.
- L3 proves one existing direct-Task path selects one accepted page into the exact S39 package and excludes one invalid or restricted candidate.
- L6 uses the existing unified Skill/CLI and stock OpenShell surface for one useful completed Task, explicit agent review, pending proposal, human decision, later Task delivery, and reversal. A skipped or synthetic story is not evidence.
- No reflection endpoint test, separate runner, Evaluation Harness, crash matrix, recurring-trigger story, Judge story, or long-horizon platform is required.

Acceptance requires no new reflection owner; one source-linked create-only pending proposal or an honest no-proposal response; human-only activation; discoverable and bounded interrupted application; exact S39-only later-delivery proof; stale-safe owner-local reversal; typed fail-closed behavior; and no passive agent framework.

## Risks & Mitigations

- Manual reflection may miss useful patterns. This is an accepted compromise until repeated real use proves cadence is worth a separate trigger owner.
- Agent judgment may produce plausible but weak lessons. Exact source lineage and human Review keep the output pending and reversible.
- Missing retained history prevents reflection. V1 reports that boundary and does not reconstruct across owners.
- Later page edits may prevent automatic reversal. Exact expected-current matching fails safely and leaves manual Knowledge governance available.

## Deferred / Future Work

- Scheduled or event-triggered reflection after explicit use proves value and an accepted trigger design exists.
- A future Evaluation Harness only after repeated evaluation demand satisfies `docs/specs/20260711-evaluation_harness_design.md` activation gates.
- Skill or prompt improvement, automated promotion, general Knowledge updates or merges, and cross-Workspace learning under separate accepted designs.

## Links

- `docs/changes/202607111600390001-self_improvement_loop_foundations.md`
- `docs/changes/202607172152230001-openkit_execution_program.md`
- `docs/changes/202607111941330001-core_spec_implementation_alignment_audit.md`
