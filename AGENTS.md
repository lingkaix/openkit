# Repository Agent Execution Contract

This file is the concise, always-loaded execution contract for work in this repository.

[FIRST-001] [First Principles](docs/decisions/20260928-first_principles_first.md): in discussion, decisions, and design, identify the essential user need, desired outcome, and genuine constraints; derive the best justified design and a practical implementation path from them. Existing architecture and implementation are evidence, not limits on the design space. Do not compromise the target merely to preserve current code or compatibility. Reasoning beyond the current design does not authorize changing accepted owners without AUTH-001.

## Authority & Precedence

- [AUTHORITY-001] Root `AGENTS.md` owns repository execution; Core and accepted specifications own design; `docs/documentation-model.md` owns document types and precedence; `docs/change-execution.md` owns material-work coordination; `docs/verification-instruments.md` owns evidence quality; `docs/toolchain.md` owns setup and dependency procedure; local guides own local workflow; change and audit records are evidence, never design authority.
- [OM-002] Engineers own user intent, architecture, governing trade-offs, strict-risk acceptance, and final approval of those decisions and of any gate explicitly reserved to them. Agents may choose and revise a working method, task decomposition, probe, and role composition when that does not change those decisions, and may complete and report ordinary work under existing authorization without a new approval. Reporting execution complete never satisfies a reserved gate.
- [PRECEDENCE-001] Settle which authority owns the concern and whether a rule applies to the current scope before comparing requirement strength; `docs/documentation-model.md` owns document precedence. Within one authority and scope, MUST and MUST NOT override SHOULD, PREFER, and MAY. Correctness, security, authority, and scope override quality preferences; otherwise use the smallest coherent change that satisfies the requested outcome.
- [PRECEDENCE-002] Git and running systems decide implementation fact; accepted owners decide intent. A disagreement is a finding, not permission to invert authority.
- [PRECEDENCE-003] If same-concern authorities conflict or governing intent is ambiguous, do not silently choose a side. Stop the affected work and ask the engineer.
- [AUTHORITY-002] This file owns its six top-level sections, a ceiling of 2100 words, and three to eight binary completion questions carrying clause IDs and expected answers. Only an engineer may raise that ceiling. `tests/agents-root-contract.test.mjs` is an executable projection and holds no authority.

## Non-negotiables

- [NONNEG-001] 兼容义务只落在数据上：服务器留存的数据（包括配置文件）在系统功能与实现方式变化后必须仍可继续使用。数据之上随系统一同发布的第一方 API、协议线格式、客户端与实现不承担兼容义务，另行接受的契约义务除外；重构时直接删除过时实现，禁止新增兼容层、deprecated shim 或双写逻辑。
- [COMPAT-001] NONNEG-001's data obligation is data continuity: retained canonical records, including persisted protocol records, and authored configuration stay usable now, and SQLite source-of-truth records from the first release. Extend data additively or carry it forward by a one-way migration under an accepted design, never a permanent legacy reader or dual write. Core semantics stay Durable while projections change. Design records and configuration so an older reader tolerates safely ignorable unknown fields in owner-defined tolerant locations, while unknown required or authority-bearing semantics fail closed. Do not churn settled mechanisms without a demonstrated design need. `docs/core/contract-evolution.md` owns stability classes, data continuity, and extension tolerance.
- [LANG-001] Repository code, comments, and documentation MUST be English Markdown where documentation applies. The two Chinese meta-instructions in this file and localized manuals are the only exceptions.
- [LANG-002] `skills/openkit-ops/references/` follows the localized manual rules in `docs/documentation-model.md`.
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
- [QUALITY-001] Apply SOLID, KISS, DRY, YAGNI, and high cohesion with low coupling as engineering judgments. Complete required behavior with the smallest clear design, not the fewest lines. SOLID does not require classes, interfaces, or layers without a present need.
- [QUALITY-003] Prevent Over-engineering: add no entity, dependency, option, abstraction, wrapper, runner, durable state, or compatibility path without a present need. Do not deduplicate code that only looks similar or predict variants that do not exist. Reuse an existing owner before creating a parallel one.
- [SCOPE-012] Keep failures and corrections local. Do not silently absorb adjacent improvements. When evidence defeats the premise or repeated method, reframe instead of adding another procedural container around the same work.
- [OM-009] Keep affected owners, producers, and consumers aligned. When observable behavior or a contract changes, change its owning criterion first or in the same change; an implementation-only change edits no normative document. Document changed code entities using the language-standard style, and update the local guide when an app or package changes.
- [CODEDOC-002] Code, comments, tests, and architecture documents preserve context for future maintainers. Document non-obvious design decisions, compatibility constraints, known defects, and temporary solutions with reasons, affected scope, risks, and removal conditions (or why removal does not apply). Link technical debt to a traceable task. After engineer confirmation, place key architectural rules in Core or specifications and their rationale in decision records; link rather than duplicate. Comments explain purpose and constraints, not merely restate code.
- [TEST-006] After implementation, inspect simplicity, cohesion, duplication, authority alignment, and direct evidence. Consider Code Smells as diagnostic clues: identify the concrete maintenance cost or behavior risk before proposing a refactor. An acceptor MUST inspect the actual diff, bytes, or named execution output; a producer report cannot alone constitute acceptance.
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

- [DOC-018] MUST NOT modify `docs/product-vision.md` unless the engineer explicitly requests changes to that document. General design, architecture, implementation, or documentation-alignment requests do not authorize editing it. The reason is recorded in [a decision record](docs/decisions/20260909-product_vision_protected.md).
- [AUTH-001] Before changing architecture, design, feature behavior, public contract, or durable lifecycle, identify the owner under `docs/core/` or `docs/specs/`. Implementing or restoring what an accepted owner already decided uses that owner and needs no new one. If no owner covers a new governing decision, discuss and accept one before production code, test infrastructure, or public contract changes; authorized investigation and work that does not depend on it continue meanwhile. Accepted design remains binding while challenged. Before an agent-initiated challenge changes a governing design decision, obtain independent Consultant scrutiny and present the concrete owner amendment, alternatives, and consequences to the engineer. Change that decision only after explicit engineer approval. Implementation choices within accepted design and corrections to its non-authoritative projections do not activate this requirement.
- [DOC-002] Non-trivial design decisions require a specification; implementation choices that do not change an accepted contract do not. Material execution uses `docs/change-execution.md`; a change record preserves intent and evidence but never supplies design authority.
- [DOC-017] Every material concept's owning Core or specification set MUST preserve five decision classes: exact definition and exclusions; unique durable authority and projection boundary; creation, update, termination, retry, and recovery lifecycle; conflict, missing, stale, restart, and dependency-failure semantics; and externally observable acceptance predicates. A class that does not apply MUST be stated explicitly.
- [DOC-015] Compression, relocation, or reconciliation must not remove a criterion that could change implementation, tests, failure, recovery, ownership, or responsibility.
- [SCOPE-001] `docs/core/foundation.md` owns proportionality and fallback doctrine. Strict Safety Kernel concerns remain strict regardless of ordinary proportionality.
- [SCOPE-007] Core storage and an external Agent Runtime are separate effect domains. Do not invent cross-domain atomicity or automatic repair where an explicit unknown result, inspection, or new-request retry is truthful.
- [SCOPE-013] A durable record, lifecycle, state machine, runner, harness, or cross-module owner needs a demonstrated current need not served by an existing owner.

## Program Governance

- [GOV-ACTIVATE-001] Judge materiality from consequence, uncertainty, reversibility, and coordination need. Cross-owner scope, public contracts, durable lifecycle, product workflow, architecture, deployment, governing authority, strict risk, and long-running or delegated work are signals, not a complete classifier. Material work follows `docs/change-execution.md`; create a change record when context must survive or the engineer requires a plan. Ordinary scoped tasks execute directly. The Safety Kernel always applies.
- [GOV-001] For material work load and follow `docs/change-execution.md`. The primary agent coordinates work and may choose probes, decomposition, roles, and review depth. It may not change user intent, governing authority, or a strict-risk boundary, and it may not adjudicate an authority-bearing artifact it produced.
- [GOV-013] Dispatch only the roles whose contracts live in `docs/roles/`, choosing them from its README, through a dispatch prompt that names the contract; `docs/agent-harnesses.md` owns the template and model binding. An agent dispatched as a role reads its contract after root `AGENTS.md` and before task work. Use independence according to consequence and uncertainty rather than a fixed role sequence.
- [GOV-016] No producer may weaken, delete, skip, or bypass a contract-derived failing check to obtain green. Where a check and contract conflict, return the conflict to their owner.
- [GOV-023] Correct or reframe ordinary findings locally. Actively invite the engineer for an intent, trade-off, authority, strict-effect, or important residual-risk decision, an unresolved consequential disagreement, or no credible next route after a useful probe or independent intervention. Do not prolong empty work to avoid asking. Pause only dependent work; missing authorization pauses its effect immediately.

## Local Guides & References

- [LOCAL-001] Each important directory has a `README.md` for purpose, boundaries, commands, and workflow. An optional local `AGENTS.md` adds only directory-specific execution rules and must direct readers to the README first.
- [LOCAL-006] Before app or package work, read its parent and local guides. For setup, CI, dependencies, generators, deployment, or operations, check `docs/toolchain.md` and the relevant cookbook.
- [LOAD-001] Enter through `README.md`; use `docs/INDEX.md` to locate owners; load `docs/documentation-model.md` for documentation governance and `docs/change-execution.md` for material coordination.
- [LOAD-003] `skills/openkit-ops/` packages non-authoritative user and operator instructions; `docs/manual/` points there. `CONTRIBUTING.md` owns human contribution workflow and is required for authorized commit work.
- [OM-011] External research stays uncommitted under `temp/research/`; promote only accepted conclusions into their canonical owner.
- [LOAD-004] Situation index, a projection that adds no rule: fixing or building behavior uses WORK-001, TEST-002, AUTH-001, and CHECK-019 with the builder and test-author contracts; dispatching agents uses GOV-001, GOV-013, and SCOPE-004 with `docs/change-execution.md`; reviewing or accepting uses TEST-006 and GOV-017 with the reviewer contract; changing tests or checks uses TEST-002, TEST-012, and GOV-016 with the test strategy and `docs/verification-instruments.md`; writing specifications or governance uses DOC-015, DOC-017, and AUTH-001 with `docs/writing.md`, `docs/glossary.md`, and the writer contract; challenging accepted design uses AUTH-001 and PRECEDENCE-003 with the Consultant contract; an engineer ruling is recorded under `docs/decisions/`; removing code or documents uses QUALITY-016 and the Safety Kernel; temporary material uses OM-011 and the retention rules of `docs/change-execution.md`.
