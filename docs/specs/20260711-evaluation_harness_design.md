# Evaluation Harness Design

Status: Draft
Implementation: Not Started

## Owns

- The activation gates and mandatory safety predicates that any future OpenKit Evaluation Harness proposal must satisfy before it can become an accepted contract.
- The explicit statement that no Evaluation Harness is authorized in the current V1.

## Does Not Own

- Any current evaluation operation, record, runner, scheduler behavior, public surface, or test obligation.
- The explicit V1 work-reflection composition, owned by `docs/specs/20260710-self_improvement_evaluation_loop.md`.
- Task, Turn, Context Package, Artifact, review, audit, usage, evidence, sandbox, provider, or scheduler semantics owned by their existing Core documents and specifications.

## Core References

- `docs/core/foundation.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/sandbox.md`
- `docs/core/audit.md`

## Summary

This Draft records future decision gates and safety boundaries only. It is not an accepted runtime contract, is not part of the current G07/WP-6 V1, and authorizes no implementation.

## Decision

Current V1 evaluation uses existing completed-work, S39, evidence, and human-review owners. A Harness remains deferred until repeated real use proves a concrete capability gap and a new accepted specification defines the smallest necessary mechanism. This Draft cannot itself satisfy that design gate.

## Current Posture

Current evaluation work must reuse the existing owners for `Thread`, `Turn`, `Item`, the accepted Context Package trace, `Artifact`, review, audit, usage, and evidence. Human review remains the authority for accepting or rejecting a proposed change.

An explicit evaluation may compare existing evidence or start a fresh authorized Task or Goal. It must not create a private evaluation lifecycle. If retained inputs are missing, authority is stale, or execution is interrupted, the truthful result is inconclusive; the user may inspect the evidence or authorize a new attempt.

No current requirement justifies an `EvalTask`, suite snapshot, evaluation-area, evaluation-run record, Harness version, Judge runner, health sweep, or evaluation-specific recovery mechanism.

## Activation Gates

A concrete Harness design may be proposed only when all of the following are true:

1. Real use has produced repeated evaluations of the same asset family, rather than only planned scenarios or repository tests.
2. Those evaluations demonstrate a specific invariant that existing Turn, Context Package, Artifact, EvidenceBundle, and human-review owners cannot express safely or reliably.
3. The missing capability causes a measured correctness, security, review-cost, or repeatability problem large enough to justify another maintained product mechanism in the documented small-deployment profile.
4. The proposed mechanism reuses existing scheduler, sandbox, provider, policy, audit, usage, and review owners without becoming a second workflow engine or test platform.
5. An accepted replacement specification defines the smallest record and execution boundary needed before implementation begins.

Until every gate is met, manual or request-scoped evaluation through existing owners is the accepted compromise.

## Mandatory Safety Predicates For Any Future Design

Any future accepted design must preserve all of these predicates:

- Candidate-visible material must be constructed from an explicit allowlist. Held-back checks and assertions must have no candidate-readable path through mounts, context, capabilities, generic file reads, path traversal, symlinks, provider payloads, or exported supply.
- Every comparison must identify the exact candidate and incumbent inputs, originating Workspace and work lineage, retained Context Package digest, asset revisions or digests, rubric or check revision, model and provider configuration, execution budget, and evaluator build identity.
- Historical AEPs, credentials, permissions, memberships, provider routes, and external-effect grants are provenance only. They must never authorize a later evaluation run.
- Current authority must be checked before every provider, credential, capability, repository, network, or other external effect. Side-effecting capability must remain absent unless a future accepted contract names the current actor, approval, bounded effect, and failure behavior.
- Secret values and unrestricted historical Workspace material must not enter retained evaluation inputs, candidate context, Judge context, audit, evidence, or export records.
- External LLM outputs may be attributable to pinned inputs and provider configuration, but they are nondeterministic and must not be described as byte-, verdict-, or outcome-reproducible.
- A missing or digest-invalid retained snapshot makes the sample inconclusive or retired. The system must not reconstruct missing authority or silently substitute current Workspace state.
- Process, provider, sandbox, or transport interruption makes the attempt inconclusive. A retry is a fresh explicit authorized attempt, not recovery or continuation of the interrupted run.
- No whole-run retry workflow, settlement, replay synthesis, or transparent restart recovery may be introduced for evaluation.
- Mechanical checks and model judgments are evidence. They do not replace the target owner's review or promotion authority, and incomplete or contradictory evidence must never authorize promotion.
- EvidenceBundle and audit remain projections over the owning work and decision records; duplicated environment fields must not become a second source of evaluation truth.
- Cross-Workspace evaluation, sampling, or graduation requires a separately accepted access and authority design and is not implied by shared deployment trust.

## Questions A Future Accepted Specification Must Resolve

Before this document can be replaced by an accepted implementation contract, that contract must answer:

- Which demonstrated evaluation case cannot be represented by existing work, evidence, and review records?
- Who may curate retained inputs and held-back checks, and what are their sensitivity, retention, deletion, export, and membership rules?
- Can all checks remain deterministic Core-side predicates, or is isolated executable check material genuinely required?
- What single owner records an attempt's immutable inputs and terminal `complete`, `inconclusive`, or `retired` outcome without duplicating Task, Turn, Review, or EvidenceBundle authority?
- What exact predicate combines mechanical evidence and advisory model judgment while preserving human promotion authority?
- What is the smallest focused verification that proves held-back isolation and current-authority enforcement without creating a new runner or acceptance platform?

## Explicitly Not Authorized

This Draft does not authorize:

- `EvalTask`, suite, suite-snapshot, evaluation-run, comparison, Judge-verdict, or evaluation-budget record families
- a dedicated evaluation filesystem or export family
- candidate/incumbent/inspection Cell orchestration or a Judge sandbox runner
- automatic retry, restart recovery, budget deferral, reservation, settlement, or Action Center failure workflow
- recurring health sweeps, configurable A/A sampling, trajectory curves, trend read models, or public evaluation operations
- evaluation-specific L0-L6 matrices, smoke runners, acceptance harnesses, or day-scale stories
- Skill or prompt promotion, provisional Knowledge auto-promotion, or cross-Workspace graduation

These remain future options only after the activation gates are satisfied and a new accepted specification promotes their exact scope.

## Current Implementation Projection

No Evaluation Harness is implemented. Existing Task and Goal execution, Context Package trace, Artifact, review, audit, usage, and EvidenceBundle mechanisms remain the only current substrate, and none of them implies a private evaluation runtime.

## Related Documents

- `docs/core/foundation.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/sandbox.md`
- `docs/core/audit.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260703-worker_context_package.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/changes/202607111600390001-self_improvement_loop_foundations.md`
- `docs/changes/202607172152230001-openkit_execution_program.md`
