# Repository Agent Execution Contract

This file is the concise, always-loaded execution contract for work in this repository.

## Authority & Precedence

- [AUTHORITY-001] Root `AGENTS.md` owns repository execution; Core and accepted specifications own design; `docs/documentation-model.md` owns document types and precedence; `docs/change-execution.md` owns material-work coordination; `docs/verification-instruments.md` owns evidence quality; `docs/toolchain.md` owns setup and dependency procedure; local guides own local workflow; change and audit records are evidence, never design authority.
- [OM-002] Engineers own user intent, architecture, governing trade-offs, strict-risk acceptance, and final approval. Agents may choose and revise a working method, task decomposition, probe, and role composition when that does not change those decisions.
- [PRECEDENCE-001] MUST and MUST NOT override SHOULD, PREFER, and MAY. Correctness, security, authority, and scope override quality preferences; otherwise use the smallest coherent change that satisfies the requested outcome.
- [PRECEDENCE-002] Git and running systems decide implementation fact; accepted owners decide intent. A disagreement is a finding, not permission to invert authority.
- [PRECEDENCE-003] If same-concern authorities conflict or governing intent is ambiguous, do not silently choose a side. Stop the affected work and ask the engineer.
- [AUTHORITY-002] This file owns its six top-level sections, a ceiling of 2100 words, and three to eight binary completion questions carrying clause IDs and expected answers. Only an engineer may raise that ceiling. `tests/agents-root-contract.test.mjs` is an executable projection and holds no authority.

## Non-negotiables

- [NONNEG-001] 我们的项目处在内部开发中，因此在做设计、决策、实现和修改时，不要考虑任何向后兼容的问题
- [LANG-001] Repository code, comments, and documentation MUST be English Markdown where documentation applies. The two Chinese meta-instructions in this file and localized manuals are the only exceptions.
- [LANG-002] `docs/manual/` follows the localized manual rules in `docs/documentation-model.md`.
- [NONNEG-002] 在输出任何文本时，禁止在一个完整的语句或段落内插入换行符

The Safety Kernel stays hard for every task:

- Authorization
- Confidentiality
- Credential Handling
- Data Loss
- Destructive Action
- External Effect and Publication
- Sandbox Containment
- Concurrent Write Ownership

[SCOPE-004] Uncertainty in the Safety Kernel fails closed. Ordinary local and reversible work may continue after the smallest correction. Parallel dispatch MUST name write ownership, and the same repository path may have only one writer at a time; coordinate before expanding into another writer's path.

## Build Loop

Apply these twelve principles as judgments, not as a mandatory workflow:

1. Intent First
2. Principles Over Procedure
3. Facts Over Plans
4. Probe Before Commitment
5. Methods Stay Plastic
6. Roles Are Capabilities
7. Independence By Risk
8. Errors Stay Local
9. Progress Changes Artifact, Belief, Or Decision
10. Reframe Before Repetition
11. Patterns Trial Before Binding
12. Hard Where Irreversible Or Accountable

- [WORK-001] Understand the owner, implementation, surrounding path, and local guidance before editing. Start at one cohesive seam and follow existing ownership unless current evidence requires a different route.
- [EVID-001] Before asking an engineer for a factual answer, run the cheapest safe and authorized probe whose result could change the decision. Plans and reports are claims until reconciled with the owned artifact, Git, named execution output, or the external system concerned.
- [TEST-002] Features and bug fixes normally begin with the lowest-sufficient regression. A probe may precede the test when the failure, environment, or oracle is unknown. Name the expected failure before running a check; setup, permission, or collection failure proves nothing. `docs/specs/20260529-test_strategy.md` owns test layers and `docs/verification-instruments.md` owns oracle and harness quality.
- [QUALITY-001] Apply high cohesion, low coupling, DRY, KISS, and YAGNI. Complete required behavior with the smallest clear design, not the fewest lines.
- [QUALITY-003] Add no entity, dependency, option, abstraction, wrapper, runner, durable state, or compatibility path without a present need. Do not deduplicate code that only looks similar or predict variants that do not exist. Reuse an existing owner before creating a parallel one.
- [SCOPE-012] Keep failures and corrections local. Do not silently absorb adjacent improvements. When evidence defeats the premise or repeated method, reframe instead of adding another procedural container around the same work.
- [OM-009] Keep affected owners, producers, and consumers aligned. Document changed code entities using the language-standard style, and update the local guide when an app or package changes.
- [TEST-006] After implementation, inspect simplicity, cohesion, duplication, authority alignment, and direct evidence. An acceptor MUST inspect the actual diff, bytes, or named execution output; a producer report cannot alone constitute acceptance.
- [CHECK-019] Run focused lint, typecheck, tests, and build checks in proportion to the changed slice, reporting exact results. Full gates run only when the touched surface, accepted plan, release boundary, or engineer requires them.

### Completion Gate

- [AUTH-003] Does the diff add architecture, behavior, feature scope, durable state, or cross-module responsibility without an accepted owner? Expected: No.
- [TEST-009] Does observable behavior change without a lowest-sufficient regression or an explicit evidence-backed reason that another proof is stronger? Expected: No.
- [TEST-012] Does a deciding check use a weak oracle or require an effect domain its subject does not own without a finding? Expected: No.
- [QUALITY-016] Does the diff retain dead code, speculative abstraction, duplicate ownership, an unnecessary wrapper, or a fragmented path? Expected: No.
- [CODEDOC-001] Is a changed code entity undocumented in its required style, or is an affected app or package guide stale? Expected: No.
- [CHECK-019] Is an applicable focused check missing exact observed evidence? Expected: No.
- [GOV-017] Did a producer's report alone accept its artifact, or is independent judgment absent where consequence or uncertainty requires it? Expected: No.

## Change Authority

- [AUTH-001] Before changing architecture, design, feature behavior, public contract, or durable lifecycle, identify the owner under `docs/core/` or `docs/specs/`. If none covers the decision, discuss and accept an owner before production code, test infrastructure, or public contract changes.
- [DOC-002] Non-trivial decisions require a specification. Material execution uses `docs/change-execution.md`; a change record preserves intent and evidence but never supplies design authority.
- [DOC-017] Every material concept's owning Core or specification set MUST preserve five decision classes: exact definition and exclusions; unique durable authority and projection boundary; creation, update, termination, retry, and recovery lifecycle; conflict, missing, stale, restart, and dependency-failure semantics; and externally observable acceptance predicates. A class that does not apply MUST be stated explicitly.
- [DOC-015] Compression, relocation, or reconciliation must not remove a criterion that could change implementation, tests, failure, recovery, ownership, or responsibility.
- [SCOPE-001] `docs/core/foundation.md` owns proportionality and fallback doctrine. Strict Safety Kernel concerns remain strict regardless of ordinary proportionality.
- [SCOPE-007] Core storage and an external Agent Runtime are separate effect domains. Do not invent cross-domain atomicity or automatic repair where an explicit unknown result, inspection, or new-request retry is truthful.
- [SCOPE-013] A durable record, lifecycle, state machine, runner, harness, or cross-module owner needs a demonstrated current need not served by an existing owner.

## Program Governance

- [GOV-ACTIVATE-001] Material coordination applies to cross-owner or cross-package work, public contracts, durable data or lifecycle, product workflow, architecture, deployment topology, governing authority, strict risk, multi-agent or long-running execution, likely future audit, or an explicit change plan. Ordinary scoped tasks execute directly.
- [GOV-001] For material work load and follow `docs/change-execution.md`. The primary agent coordinates work and may choose probes, decomposition, roles, and review depth. It may not change user intent, governing authority, or a strict-risk boundary, and it may not adjudicate an authority-bearing artifact it produced.
- [GOV-013] Spawn only registered `.codex/agents/` capabilities. Use independence according to consequence and uncertainty rather than a fixed role sequence.
- [GOV-016] No producer may weaken, delete, skip, or bypass a contract-derived failing check to obtain green. Where a check and contract conflict, return the conflict to their owner.
- [GOV-023] A finding or failed review normally causes a local correction or reframe, not an engineer interruption. Ask the engineer only for a real intent, trade-off, authority, strict-effect, or residual-risk decision.

## Local Guides & References

- [LOCAL-001] Each important directory has a `README.md` for purpose, boundaries, commands, and workflow. An optional local `AGENTS.md` adds only directory-specific execution rules and must direct readers to the README first.
- [LOCAL-006] Before app or package work, read its parent and local guides. For setup, CI, dependencies, generators, deployment, or operations, check `docs/toolchain.md` and the relevant cookbook.
- [LOAD-001] Enter through `README.md`; use `docs/INDEX.md` to locate owners; load `docs/documentation-model.md` for documentation governance and `docs/change-execution.md` for material coordination.
- [LOAD-003] `docs/manual/` contains non-authoritative user and operator projections. `CONTRIBUTING.md` owns human contribution workflow and is required for authorized commit work.
- [OM-011] External research stays uncommitted under `temp/research/`; promote only accepted conclusions into their canonical owner.
