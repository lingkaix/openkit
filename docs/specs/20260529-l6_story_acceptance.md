# L6 Story Acceptance Testing

Status: Accepted
Implementation: Partial

## Owns

This specification owns the L6 story-acceptance boundary: when a realistic user-intent workflow deserves L6 proof, the minimum story artifact, execution role separation, adjudication authority, execution and failure semantics, evidence proportionality and retention, story admission stability, and reduction of confirmed defects into lower test layers.

## Does Not Own

This specification does not own product behavior, Core or specification authority, the complete L0-L6 test strategy, release policy, a general agent executor, browser automation infrastructure, process supervision, transport clients, credential management, evidence storage, or workflow recovery. Those responsibilities remain with their existing owners.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/communication.md`
- `docs/core/audit.md`
- `docs/specs/20260529-test_strategy.md`

## Summary

L6 answers one question: can a user or AI agent complete one important product intent through a supported public surface in a realistic environment?

L6 is an opt-in acceptance layer, not a required copy of L1-L5 and not a test platform for every feature, failure branch, provider, runtime, transport, or deployment shape. A behavior already proved deterministically at a lower layer receives L6 coverage only when a distinct end-to-end product risk remains.

OpenKit prefers agent-first real use for exploratory and release-candidate acceptance. A deterministic story adapter is justified only for a stable, repeatedly valuable workflow that cannot be protected more cheaply at L1-L5. Both modes must reuse existing product clients and runner support instead of growing parallel authentication, transport, process-control, evidence, Git, cleanup, or recovery systems.

Agent-first execution separates three roles: an orchestrator that prepares the environment and assembles evidence, an actor that receives only the persona and the user ask, and a judge that adjudicates the deterministic assertions from the story text and the evidence package alone. The product verdict must be reproducible by an independent judge from that package without access to the live run.

## Current Scope

The current engineering baseline is one NanoCore process, one logical SQLite writer, one configured local or remote runtime target, one active worker slot, and a small trusted team that is typically under ten people. L6 should prove that product shape and the most important stock OpenShell integration path; it does not simulate multi-process, multi-writer, fleet, fairness, hot-failover, or high-availability behavior.

One accepted story should normally prove one complete user intent. It may cross several existing components when the user intent naturally does so, but it MUST NOT accumulate unrelated cache, usage, audit, review, Git, cleanup, Cell-recycle, cancellation, compression, credential-override, and recovery assertions merely because one runner can reach them.

Security, authorization, credential isolation, secret redaction, sandbox containment, data-loss prevention, durable authority, and irreversible external effects remain strict. Availability, optional diagnostics, cleanup projection, reconnect convenience, and external-run interruption may use an explicit environment failure, product interruption, `recovery_required`, inspection, or fresh-run fallback when transparent recovery is not part of the owning product contract.

## Goals

- Validate a small number of high-value user-intent workflows through supported public surfaces.
- Detect integration and usability failures that lower deterministic layers cannot reveal.
- Keep stories versioned, readable, and tied to explicit machine-checkable outcomes.
- Use real providers or workers only when their behavior is the distinct risk being accepted.
- Reduce every confirmed deterministic defect into the lowest sufficient L1-L5 regression test.
- Keep execution and evidence mechanisms thin, reusable, and subordinate to the story.

## Non-goals

- Do not create an L6 story for every feature, state transition, fallback, backend, or deployment combination.
- Do not require every story to have a deterministic adapter.
- Do not treat subjective agent judgement as the sole blocking oracle.
- Do not let an executor mutate private product state during the user-flow portion of a story.
- Do not build another authentication transport, process supervisor, workflow engine, recovery coordinator, evidence platform, Git harness, or general agent-runner framework for L6.
- Do not require real credentials, quota, host state, or external network access in the default repository checks.
- Do not make L6 an automatic pull-request, ordinary push, or tag gate under the current policy.
- Do not test deferred scale or availability properties that the product does not currently promise.

## Authority And Projection

The owning Core and feature specifications remain the authority for product behavior. A story references those contracts and selects a realistic proof path; it does not create or broaden product requirements.

The Markdown story is the authority for that acceptance run's intent, preconditions, supported entry point, deterministic assertions, allowed setup, and cleanup. Runner code is an execution projection and MUST NOT silently add stronger product requirements or hidden setup.

Product records remain authoritative for Workspace, Thread, Turn, Item, Artifact, Goal, Task, Session, lease, approval, usage, and audit state. An L6 evidence summary records observations and identifiers needed for triage but MUST NOT duplicate those records into another lifecycle.

Screenshots, traces, transcripts, logs, and reports are supporting evidence, not product authority. Absence of optional evidence does not overturn an otherwise provable product result unless the story declared that evidence as a deterministic assertion.

## Story Selection

Add or retain an L6 story only when all of the following are true:

- It represents one material user intent or release-risk path.
- At least one important failure can occur only across supported public boundaries or during realistic use.
- The same confidence cannot be obtained more cheaply at L1-L5.
- The required environment and oracle are available without inventing private product capabilities.
- The story has an explicit owner and remains cheap enough to run intentionally.

A new or materially revised story becomes acceptance evidence only after repeated agent-first runs return a consistent typed classification: three consecutive runs for stories without real-provider requirements, two for opt-in real-provider or real-Codex stories. Per-story `inconclusive`, `environment_failure`, and `tool_failure` rates stay in the run records so instrument noise remains visible.

Delete, merge, or demote a story when lower-layer coverage now owns its only distinct risk, the public surface is removal-only, the story depends on private seeding, or its adapter costs more than the product confidence it provides.

## Story Artifact Contract

Story artifacts live under `tests/stories/` as Markdown. Each committed story has a scalar front matter block with these fields:

```yaml
id: story-real-task-worker
title: Complete one Task with a real worker
persona: Operator validating a release candidate
entrypoint: skill
default_tool: openkit
timeout_seconds: 600
requires_real_provider: false
requires_real_codex: true
contracts: docs/specs/20260704-task_mode_worker_delegation.md, docs/specs/20260616-agent_environment_package.md
```

`id` is repository-unique. `title` and `persona` describe the user intent. `entrypoint` names a supported public product surface. `default_tool` names the existing product client or browser control used for the run. `timeout_seconds` is one story-level budget. Real provider or Codex requirements require explicit opt-in metadata. `contracts` is one comma-separated scalar line naming the owning Core and specification documents whose behavior the story accepts; the scalar shape preserves the existing no-YAML-dependency metadata parser. A change to a listed document marks the story for review, and a story whose listed document no longer exists fails validation.

The front matter grammar is the closed field set above, not YAML. If a second field ever needs structure, adopt a real YAML parser with a closed schema in one step; do not extend the scalar parser with partial YAML syntax.

The body contains only the sections needed to make independent executions materially equivalent. These sections are required:

- `Purpose`: the one user intent and the owning product contracts.
- `Preconditions`: required implemented capabilities and environment assumptions.
- `User-visible Steps`: actions through the supported public surface.
- `Expected Outcomes`: observable product results.
- `Deterministic Assertions`: the minimum machine-checkable pass/fail oracles.
- `Failure Triage Notes`: product, environment, tool, or inconclusive classification and the likely lower regression layer.

These sections are allowed when the story needs them:

- `Setup`: allowed non-user preparation using existing public or test-owned support.
- `Required Opt-in Environment Variables`: the explicit opt-in variables for real-provider or host-dependent runs.
- `Evidence To Collect`: the artifacts the orchestrator captures for adjudication and triage.
- `Cleanup`: bounded process and disposable-state cleanup.

No other body section is allowed. The section list is normative for repository validation.

Every deterministic assertion is an oracle over collected evidence or readable product records and names what decides it. A verdict about the run itself, such as "the run executes and passes", is not an assertion; execution, skip, and gate semantics are owned by this specification.

Evidence requirements appear only when they change the acceptance decision or materially shorten failure triage. Long transcripts, screenshots at every state, database dumps, network archives, repository snapshots, and full audit exports are not default requirements.

## Execution Modes

### Agent-first Execution

Agent-first execution is the default for exploratory, dogfooding, and release-candidate stories. It separates three roles with different context rules.

The orchestrator reads the full story, performs Setup, provisions the actor, captures the evidence named by the story, records the verdicts, writes Failure Triage Notes, and performs Cleanup. The orchestrator is authoritative for `skipped`, `environment_failure`, and `tool_failure` and never issues a product verdict.

The actor performs the user-visible flow through the declared public surface. Its context contains only the persona and the user ask; it MUST NOT receive the story file, Expected Outcomes, Deterministic Assertions, or answers the story requires it to discover. The verbatim actor prompt is part of the evidence package. When the entrypoint is itself an agent surface, the tested agent is the actor and the same context rules apply.

The judge adjudicates in a clean context from exactly two inputs: the story text and the evidence package. It has no tool or environment access, does not interact with the actor or the live run, and returns the product verdict with a per-assertion rationale. For stories on strict surfaces the judge SHOULD come from a different model family than the actor.

The actor may adapt to benign presentation differences but may not bypass product authority or replace a failed product path with private writes. Setup, cleanup, and diagnostic inspection remain orchestrator work using declared repository tools.

No general committed agentic executor is required. Repeated manual steps may be automated only after real runs demonstrate a stable shared need, and the resulting support must reuse an existing runner owner rather than create another framework.

### Deterministic Execution

A deterministic adapter is appropriate only for a stable, high-value story that is intentionally repeated. It validates the source story, invokes existing stack and product clients, performs only story-specific actions and assertions, and returns ordinary test results. A deterministic adapter evaluates its assertions in code, so the role separation above applies only to agent-first execution.

A deterministic adapter MUST NOT reimplement authentication transport, command routing, process-group supervision, credential redaction, evidence-directory policy, Git inspection, timeout orchestration, or cleanup already owned elsewhere. If existing support cannot serve the story without such duplication, keep the story agent-first or improve the existing owner as a separately justified change.

## Lifecycle

1. Author or revise one story against accepted Core and feature specifications.
2. Confirm its distinct L6 risk and identify the lowest-layer checks already covering the underlying behavior.
3. Preflight only the environment capabilities named by the story.
4. Execute through the named public surface under one bounded deadline.
5. Adjudicate and classify the result as `passed`, `failed`, `skipped`, `environment_failure`, `tool_failure`, or `inconclusive` under the authority split in Pass And Failure Semantics.
6. Preserve the story revision, assertion summary, redaction result, and the evidence required by the retention policy in Evidence And Security.
7. Reduce a confirmed deterministic product defect into L1-L5, then retain L6 only if its end-to-end intent remains valuable.
8. Clean disposable state; a cleanup failure is reported separately and does not rewrite the product result.

An interrupted real-provider or real-worker run may preserve available redacted evidence and be retried as a fresh run. L6 does not require transparent executor recovery, resumable evidence settlement, or reconstruction of every partially written report.

## Pass And Failure Semantics

In agent-first execution the judge issues `passed`, `failed`, and `inconclusive` from the story and the evidence package; the orchestrator records that verdict without arbitration and is authoritative only for `skipped`, `environment_failure`, and `tool_failure`. Once the actor has completed the user-visible flow and evidence collection has succeeded, `environment_failure` and `tool_failure` are no longer available classifications; a doubtful product outcome is `inconclusive`.

`passed` means every required deterministic assertion passed and no observed behavior contradicted the explicit story intent.

`failed` means the product violated a required assertion, blocked the supported workflow, lost required state, duplicated a protected effect, or exposed protected data.

`skipped` means an opt-in capability required by the story was not enabled or provisioned before execution was attempted; the report names the unmet capability and no setup or product step runs. A skip is not acceptance evidence and MUST NOT be presented or counted as a pass.

`environment_failure` means the story was selected with its required capabilities declared available, but an external service, credential, quota, host, tool environment, or disposable environment failed during preflight, setup, or execution before the product result could be judged.

`tool_failure` means the executor or browser-control tool failed independently of the product.

`inconclusive` means the story lacks a sufficient oracle or the run ended after an effect whose outcome cannot be proved. A judge that cannot decide a required assertion from the evidence package returns `inconclusive` naming the missing evidence; that result is a story defect that tightens `Evidence To Collect`, not a product defect. Tighten the story or inspect existing product authority; do not synthesize a pass, build a recovery workflow, or expand the runner to guess the outcome.

Subjective usability findings are non-blocking unless they contradict an explicit expected outcome. Every recorded finding is either linked to a change record or product issue or explicitly waived with a reason in the run record; findings do not silently disappear. They may become product issues or design discussion without adding permanent runner behavior.

## Evidence And Security

Every completed run retains the story identifier and revision, environment kind, elapsed time, final classification, deterministic assertion results, and a redaction check.

The evidence package is the adjudication input and must satisfy one bar: an independent judge with no run memory reaches the same product verdict from the story and the package alone. It always contains the verbatim actor prompt and the artifacts named by `Evidence To Collect`. Each agent-first run also records four non-blocking scalars trended per story revision: actor tool calls, error-recovery retries, guidance loaded beyond the story's declared minimum, and elapsed time.

`failed` and `inconclusive` runs retain the full redacted transcript and evidence package for one release cycle. `passed` runs retain the summary, plus the full package for a small sampled fraction kept one release cycle for re-adjudication and review calibration.

Real secrets, tokens, cookies, authorization headers, full credential files, and private account data MUST NOT appear in story files, command output, evidence, reports, CI artifacts, or committed fixtures. Opt-in real runs must reuse the existing credential and redaction owners.

Evidence directories are output locations, not databases or workflow owners. A partial evidence write may be deleted or replaced on a fresh run; it does not require a settlement record, append protocol, or recovery state machine.

## Test And Release Policy

The story metadata parser and the story schema check — front matter fields, existing `contracts` references, and the normative body section list — receive focused L0/L1 coverage. Shared runner support receives tests only for policies it uniquely owns. Story-specific logic stays in the story or its thin adapter and does not receive a duplicate framework-level test suite.

One deterministic story may smoke-test the L6 infrastructure itself. Real-provider and real-worker acceptance should prove only the critical integration path named by their owning specification. Cancellation, compression, malicious override, cache, usage, audit, review, Git, cleanup, and Cell recycle remain lower-layer concerns unless one of them is the story's distinct user-visible risk.

L6 remains manually or explicitly invoked. `pnpm -w test:stories` may run the bounded deterministic subset, while quota-consuming or host-dependent stories use explicit opt-in commands. `pnpm -w verify:full` may include deterministic stories only at a work-package exit, release-candidate gate, or explicit request; ordinary slices use their focused lower-layer checks.

Skipped, environment-failed, and unexecuted stories are not acceptance evidence. When an owning release policy or current release record designates an opt-in real-provider or real-worker story as applicable, that L6 gate contribution is satisfied only when the story actually executed and passed in that cycle; a missing capability or skipped run leaves it unmet rather than silently green. This specification defines evidence semantics and does not decide which stories are applicable to a release.

## Current Implementation

Story artifacts live under `tests/stories/`, and current execution support lives under `tests/story-runner/`. The deterministic Web adapter, unified Skill progressive-discovery story, opt-in real Codex and Task worker runs, and real-provider runs are implementation inventory rather than authorization to expand the platform.

The six committed stories are normalized to the artifact contract and declare their owning contracts. `scripts/validate-story-schema.mjs` enforces the closed front matter field set, contract-reference existence, repository-unique story ids, and the normative body section list inside `check:repo`; parsing, the contracts list convention, and the section rules are owned by `tests/story-runner/story-metadata.mjs`. Orchestrator/actor/judge separation in runner support, friction scalars, and retention sampling remain accepted design that is not yet implemented; the owning change record tracks that follow-up.

The former user-facing MCP stories and runners are deleted. Equivalent acceptance is owned by the unified Skill and bundled CLI at the lowest sufficient layer plus one representative real progressive-discovery story; no transport-parity story matrix is required.

The current real Task worker runner duplicates capabilities already present in Goal runner support. Its feature surface is frozen: complete the minimum real happy-path proof, then reuse or move genuinely shared behavior into the existing owner and delete duplicate Task-specific transport, supervision, evidence, Git, redaction, and timeout code. This does not authorize a third runner framework.

No new cancellation, compression, credential-override, restart, recovery, or backend-specific L6 harness is accepted by this specification. A confirmed real integration failure is fixed in product code and reduced to the lowest sufficient regression layer.

## Acceptance Predicates

- Two independent readers can identify the story's one user intent, supported entry point, required environment, and deterministic pass/fail oracles.
- The recorded actor prompt shows the actor received only the persona and the user ask, with no story content or discovery answers.
- An independent judge reproduces the product verdict from the story and the evidence package alone.
- Every deterministic assertion names the evidence or product record that decides it.
- Story front matter declares owning contract documents that exist in the repository.
- Every non-blocking finding in a run record is linked to a change record or product issue, or explicitly waived with a reason.
- A run uses only declared public product surfaces during the user-flow portion.
- The executor reuses existing transport, process, credential, redaction, timeout, cleanup, and evidence owners.
- Unavailable optional infrastructure yields a typed non-product result rather than a fabricated product pass or new recovery system.
- A confirmed deterministic defect has a named L1-L5 regression owner.
- Removing the L6 adapter would not remove the sole deterministic guard for an already known product defect.
- Deferred deployment shapes and hypothetical variants add no current runner or test cases.

## Alternatives Considered

### One L6 Story Per Feature Or Boundary

Rejected because it duplicates cheaper deterministic coverage and turns the layer taxonomy into a checklist.

### General Agentic Runner And Evidence Platform

Rejected for the current product scale because it duplicates existing process, transport, credential, evidence, and workflow owners before repeated real use proves a shared requirement.

### Exhaustive Evidence Collection

Rejected because evidence should shorten diagnosis or prove an oracle, not become a second durable product history.

### Transparent Recovery Of Interrupted Acceptance Runs

Rejected because a fresh opt-in run plus preserved minimal evidence is the smaller honest fallback.

### Orchestrating Agent As Judge

Rejected because setup knowledge contaminates the verdict, the verdict stops being reproducible from the evidence package, and self-triage bias misclassifies product failures as environment failures. Diagnosis benefits from run context, so the orchestrator keeps Failure Triage Notes; judgment is harmed by run context, so the verdict belongs to a clean judge. This repository-acceptance rule does not authorize a product Evaluation Harness; the explicit product self-improvement loop separately keeps agent analysis advisory and human Knowledge Review authoritative under `docs/specs/20260710-self_improvement_evaluation_loop.md`.

## Deferred, Non-authorizing Questions

- Whether repeated agent-first runs justify one small shared executor entry point.
- Whether story count eventually justifies catalog or selection metadata.
- Whether a cheap, stable subset should become a release-candidate gate.
- Whether judge-model rotation and seeded-defect adjudication calibration deserve a standing schedule once run volume grows.

These questions create no current implementation or test obligation. A future proposal must begin with evidence from repeated real runs and identify what existing owner cannot meet the need.

## Related Docs

- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `tests/stories/README.md`
- `tests/story-runner/README.md`
- `README.md`
