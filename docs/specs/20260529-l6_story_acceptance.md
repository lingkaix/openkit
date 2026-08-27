---
status: Accepted
implementation: Partial
---
# L6 Story Acceptance Testing

## Owns

This specification owns the L6 story-acceptance boundary: L6 admission, the minimum story artifact and its on-disk shape, the execution model, execution role separation with per-role falsifiers, the two assertion channels and their required and optional tiers, adjudication authority, friction findings, multi-run accumulation, execution and failure semantics, evidence proportionality and retention, story admission stability, and the handoff conditions when a proof or a confirmed defect leaves L6 for a lower test layer.

## Does Not Own

This specification does not own product behavior, Core or specification authority, the complete L0-L6 test strategy, release policy, a general agent executor, browser automation infrastructure, process supervision, transport clients, credential management, evidence storage, or workflow recovery. Those responsibilities remain with their existing owners.

It does not own deterministic tests of any kind, including opt-in real-provider ones. A mechanical proof of a fixed path through the product belongs to an L3 or L4 test under `docs/specs/20260529-test_strategy.md`, which also owns real-provider opt-in rules across every layer.

It does not own material change coordination under `docs/change-execution.md`, including repository-path writer ownership, actual-artifact acceptance, or the choice of independent judgment. This specification's run roles govern one story execution only; Role Composition states the division and does not restate that document's rules.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/communication.md`
- `docs/core/audit.md`

## Summary

L6 answers one question: can a user or AI agent complete one important product intent through a supported public surface in a realistic environment?

L6 is an opt-in acceptance layer, not a required copy of L1-L5 and not a test platform for every feature, failure branch, provider, runtime, transport, or deployment shape. A behavior already proved deterministically at a lower layer receives L6 coverage only when a distinct end-to-end product risk remains.

L6 is agent-first by definition. An actor exercises the intent knowing only what a real user would know, and what that unconstrained attempt reveals is the whole reason the layer exists. A mechanical proof of a fixed path is not a lesser L6 story; it is an L3 or L4 test, and `docs/specs/20260529-test_strategy.md` owns it there. A story therefore has no committed runner, adapter, or per-story command, and must reuse existing product clients rather than grow parallel authentication, transport, process-control, evidence, Git, cleanup, or recovery systems.

Agent-first execution separates three roles: a stage manager that prepares the environment and assembles evidence, an actor that receives only the persona and one user ask, and a judge that adjudicates from the story text and the evidence package alone. The product verdict must be reproducible by an independent judge from that package. Each role's central claim carries a named falsifier under Role Claims And Falsifiers.

Assertions read from two channels. Outside-in assertions check what the product returned to the actor; inside-out assertions check the product records the run produced. Neither may constrain the path by which its subject became true, and that single prohibition is what keeps an open-ended attempt from collapsing into a mechanical one.

## Current Scope

The current engineering baseline is the V1 scheduling profile and counts defined in `docs/specs/20260703-runtime_scheduling_scale.md`: one configured `RuntimeTarget` projecting one NanoHost and one active worker slot, with NanoHost runtime details owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`. L6 targets the small-team shape described by the Judgment in `docs/deployment.md` without defining a team-size threshold of its own. It should prove that product shape after the target path is implemented; it does not simulate multi-process, multi-writer, fleet, fairness, hot-failover, or high-availability behavior, and prior Cell or A1 runs do not prove the accepted RelayStream plus nested standard HTTP/2 feasibility precondition.

One accepted story should normally prove one complete user intent. It may cross several existing components when the user intent naturally does so, but it MUST NOT accumulate unrelated cache, usage, audit, review, Git, cleanup, Runtime Epoch recovery, cancellation, compression, credential-override, and recovery assertions merely because one runner can reach them.

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
- Do not admit a proof that needs a committed runner, adapter, or fixed script; that proof belongs to a lower layer.
- Do not treat subjective agent judgement as the sole blocking oracle.
- Do not let an executor mutate private product state during the user-flow portion of a story.
- Do not build another authentication transport, process supervisor, workflow engine, recovery coordinator, evidence platform, Git harness, or general agent-runner framework for L6.
- Do not require real credentials, quota, host state, or external network access in the default repository checks.
- Do not make L6 an automatic pull-request, ordinary push, or tag gate under the current policy.
- Do not test deferred scale or availability properties that the product does not currently promise.

## Authority And Projection

The owning Core and feature specifications remain the authority for product behavior. A story references those contracts and selects a realistic proof path; it does not create or broaden product requirements.

The Markdown story is the authority for that acceptance run's intent, preconditions, supported entry point, deterministic assertions, allowed setup, and cleanup. Runner code is an execution projection and MUST NOT silently add stronger product requirements or hidden setup.

Product records remain authoritative for Workspace, Thread, Turn, Item, Artifact, Goal, Task, AgentSession, lease, approval, usage, and audit state. An L6 evidence summary records observations and identifiers needed for triage but MUST NOT duplicate those records into another lifecycle.

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

A story is one Markdown document under `tests/stories/`. It takes one of exactly two shapes:

- `tests/stories/<name>.story.md` when the story needs no assets.
- `tests/stories/<name>/<file>.story.md` when the story needs assets, which live in that directory beside it. The directory contains exactly one `*.story.md`.

The Markdown document is always the story. A directory is a container for the fixtures, sample inputs, or fake data one story needs, never a second authority; nothing in it overrides the document, and no committed executable belongs there.

Each committed story has a scalar front matter block with these fields:

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

`id` is repository-unique. A direct story's `id` MUST equal its document basename without `.story.md`, and a nested asset story's `id` MUST equal its asset directory name. `title` and `persona` describe the user intent. `entrypoint` names a supported public product surface. `default_tool` names the existing product client or browser control used for the run. `timeout_seconds` is one story-level budget. Real provider or Codex requirements require explicit opt-in metadata. `contracts` is one comma-separated scalar line naming the owning Core and specification documents whose behavior the story accepts; the scalar shape preserves the existing no-YAML-dependency metadata parser. A change to a listed document marks the story for review, and a story whose listed document no longer exists fails validation.

There is no mode or runner field. Every L6 story is agent-first by definition under Admission below, so declaring the mode would be restating the layer, and naming a committed runner would contradict it.

The front matter grammar is the closed field set above, not YAML. If a second field ever needs structure, adopt a real YAML parser with a closed schema in one step; do not extend the scalar parser with partial YAML syntax.

The body contains only the sections needed to make independent executions materially equivalent. These sections are required:

- `Purpose`: the one user intent and the owning product contracts.
- `Preconditions`: required implemented capabilities and environment assumptions.
- `User-visible Steps`: actions through the supported public surface.
- `Expected Outcomes`: observable product results.
- `Deterministic Assertions`: the minimum machine-checkable pass/fail oracles, each declaring its channel and its tier under Assertion Channels and Required And Optional Assertions.
- `Failure Triage Notes`: product, environment, tool, or inconclusive classification and the likely lower regression layer.

These sections are allowed when the story needs them:

- `Setup`: allowed non-user preparation using existing public or test-owned support.
- `Required Opt-in Environment Variables`: the explicit opt-in variables for real-provider or host-dependent runs.
- `Evidence To Collect`: the artifacts the stage manager captures for adjudication and triage.
- `Cleanup`: bounded process and disposable-state cleanup.

No other body section is allowed. The section list is normative for repository validation.

Every deterministic assertion is an oracle over collected evidence or readable product records and names what decides it. A verdict about the run itself, such as "the run executes and passes", is not an assertion; execution, skip, and gate semantics are owned by this specification.

Evidence requirements appear only when they change the acceptance decision or materially shorten failure triage. Long transcripts, screenshots at every state, database dumps, network archives, repository snapshots, and full audit exports are not default requirements.

## Admission

L6 is agent-first. That is the layer's definition, not its preference. An agent or a person exercises one product intent through a public surface while knowing only what a real user would know, and the value of the layer is what that unconstrained attempt reveals. A proof that does not work this way is not a weaker L6 story; it is a test at a different layer, and `docs/specs/20260529-test_strategy.md` already owns those layers.

One satisfiability test decides admission, applied to the story's own Deterministic Assertions:

> Every assertion in an L6 story MUST be satisfiable by a competent actor that knows only the persona and the sole user ask.

Bounds and prohibitions are satisfiable and remain available: `only X`, `no Y`, `at most N`, `not before Z`, and assertions over product records and their ordering. An exact call sequence, an exact call cardinality, a fixed call order, or a prohibition on retry is not satisfiable from a persona and an ask alone — an actor could satisfy it only by being told the trajectory, which the actor context rules forbid.

**A story containing any such assertion is not admitted to L6.** Its assertions describe a mechanical path through the product, which is what L3 NanoCore black-box integration and L4 Web browser end-to-end tests exist to check. Send it there as ordinary test code; do not keep a story document beside it. Two artifacts that must agree about one mechanical path will drift, and the drift has no owner.

This test is decidable at authoring time, which is the only cheap moment. A story that asserts a trajectory its actor cannot know has no valid execution: the actor cannot satisfy the assertion, and every attempt to close the gap feeds the trajectory back to the run through Setup, which destroys the isolation the layer depends on. The correct disposition is to move the proof to its real layer, never to widen the evidence until the assertion looks satisfied.

An L6 story body MUST NOT contain a fenced code block. Committed executable detail in story prose is the observable form of that feedback, and a story that appears to need it has failed admission.

Admission is re-decided on every revision, not only at authoring. A story drifts past the line one compliant edit at a time, so the test applies to the story as revised rather than to the story as first admitted. A revision that would cross the line is refused and its proof redirected. If repeated revisions do not produce an admitted story or completed run, the primary agent reframes rather than repeating the method under `docs/change-execution.md`.

### Execution Support

L6 has no committed runner, no adapter, and no per-story command. A story is dispatched by a stage manager when someone decides to run it, so adding a story adds no entry to `package.json`, no CI target, and no file under a runner directory. Mechanical validation of the story document is separate and remains part of the ordinary repository gate.

When a run needs a throwaway script, the actor or the stage manager writes it during that run and discards it with the rest of the disposable state. That script is run scaffolding, not a repository artifact: it is never committed, never named by the story, and never reused across runs. A script that someone wants to commit is evidence that the proof is mechanical, which returns the story to Admission above.

### Execution Model

One run proceeds in four movements, and each hands a bounded artifact to the next.

1. **The stage manager sets the scene.** It reads the full story, performs Setup, and provisions the actor. Everything the run needs to exist before the actor acts is its responsibility.
2. **The actor improvises.** It receives a situation and one thing it wants to accomplish — never a sequence of steps. It is a cooperating user, not a performer with lines: how it reaches the goal is its own choice, and its unconstrained attempt is what this layer exists to observe.
3. **The run is recorded from two sides.** The actor's own record holds what it encountered, what it saw, and what the product returned. The stage manager separately collects the product records the story names. Both go into the evidence package.
4. **The judge adjudicates.** From the story and that package alone it decides each assertion and returns the product verdict with a per-assertion rationale.

The word `script` does not describe anything in this model. A script is a fixed sequence, and handing one to the actor would supply the trajectory the Admission test exists to keep out. What the actor receives is a persona and a single ask.

### Roles

Agent-first execution separates three roles with different context rules.

The role that prepares and runs the execution is the **stage manager**. It is scoped to one story run and does not accept repository artifacts. It is distinct from the primary agent coordinating repository changes under `docs/change-execution.md`. The name states the constraint — a stage manager runs the show and never judges it.

The stage manager reads the full story, performs Setup, provisions the actor, captures the evidence named by the story, records the verdicts, writes Failure Triage Notes, and performs Cleanup. It is authoritative for `skipped`, `environment_failure`, and `tool_failure` and never issues a product verdict.

The actor performs the user-visible flow through the declared public surface. Its context contains only the persona and the user ask; it MUST NOT receive the story file, Expected Outcomes, Deterministic Assertions, or answers the story requires it to discover. The verbatim actor prompt is part of the evidence package. When the entrypoint is itself an agent surface, the tested agent is the actor and the same context rules apply.

The judge adjudicates in a clean context from exactly two inputs: the story text and the evidence package. It never interacts with the actor, never observes a run in progress, and never reads the host environment. It returns the product verdict with a per-assertion rationale. For stories on strict surfaces the judge SHOULD come from a different model family than the actor.

The judge MAY perform read-only verification and MUST recompute at least one named value the stage manager claims. Its permitted sources are the evidence package and the product's public read surfaces for records the story names. **After the run has terminated and its evidence is sealed, a read-only query to a public product read surface is not interaction with a live run.** That distinction is what makes the boundary decidable: what is forbidden is influencing or observing an execution in flight, not re-deriving a settled fact from the product's own contract.

Read-only recomputation is not run context. It tells the judge nothing about what the story expects, and it is the only mechanism by which the stage manager's faithfulness claim below becomes falsifiable. Absent it, that claim can only be argued in prose, and the argument grows without bound.

An actor or judge surface whose host injects an immutable context envelope independent of the task payload does not satisfy these context rules and is not an approved agent-first surface. A story that needs such a surface fails Admission: the envelope cannot be narrowed by the story, so the isolation the layer depends on cannot be established. This specification grants no per-story exception to the context rules, because an exception would have to be verified by the same evidence apparatus whose trustworthiness the rules exist to establish.

The actor may adapt to benign presentation differences but may not bypass product authority or replace a failed product path with private writes. Setup, cleanup, and diagnostic inspection remain stage-manager work using declared repository tools.

No general committed agentic executor is required. Repeated manual steps may be automated only after real runs demonstrate a stable shared need, and the resulting support must reuse an existing runner owner rather than create another framework.

### Role Claims And Falsifiers

Each run role makes one central claim, and each claim has a named falsifier. A role whose claim cannot be falsified is not verified by evidence; it is asserted, and its assertion will be replaced over time by unbounded documentation attempting to establish it.

| Role | Central claim | Falsifier |
| --- | --- | --- |
| actor | The task payload contained only the persona and the sole user ask. | Any story text, Expected Outcome, Deterministic Assertion, or answer the story requires the actor to discover is reachable in that payload. |
| judge | The product verdict is reproducible from the story and the evidence package alone. | A second independent judge instance returns a different verdict from the same two inputs. |
| stage manager | The evidence package faithfully represents the run. | The judge's read-only recomputation of a named claimed value disagrees with the package. |
| accumulating verifier | The completed runs form one accepted sequence. | A run count, order, per-run verdict, or cleanup receipt in the retained evidence contradicts the accumulated verdict. |

A falsified claim is a finding against the run, not against the specification. It returns to the role that made it.

### Multi-run Accumulation

A story requiring more than one run has exactly one accumulating verifier, distinct from every per-run judge, that owns run count, run ordering, per-run verdicts, and cleanup completeness. No per-run judge may issue an accumulated verdict, because a judge that passed one run is not independent of the sequence that contains it.

Accumulation is never owned by a transient execution document. The accumulating verifier is one named role that reads only the retained per-run evidence.

### Role Composition

A story run may occur during material repository work, so this specification's run roles and `docs/change-execution.md` may apply at once. When they do, the following division is normative.

The primary agent assigns one writer per repository path and accepts changed artifacts from their actual bytes and evidence. Run roles own one execution: preparation, the user-visible flow, adjudication, and cleanup. A finding about a repository artifact returns to the primary agent; a finding about a run returns to the stage manager.

A review failure is not by itself authority to amend this specification. Amending an owning contract to accommodate one story requires user intent or an accepted owner; failed verification cannot authorize the contract change. A specification that names one story artifact as an exception has recorded a failed verification as permanent design authority, which inverts the precedence order in `docs/documentation-model.md`.

#### Shared Identity

One agent may coordinate the repository change and stage-manage its story run. That is permitted. The L6 separation below still applies, and acceptance of any changed repository artifact follows `docs/change-execution.md`: inspect the artifact itself, do not rely on a producer report, and add independent judgment when consequence, uncertainty, or producer bias makes it material.

When one agent holds both roles, all of the following apply:

- Its evidence claim MUST be discharged by the falsifier in Role Claims And Falsifiers, exercised by a party it does not control: the judge's read-only recomputation. A self-attested evidence package is not evidence.
- It MUST NOT be the accumulating verifier for runs it stage-managed.
- It MUST NOT resolve an adverse review finding by amending the contract the finding was raised against. A producer that also controls the run evidence could otherwise close its own failed verification by editing the standard it failed, which is the concrete mechanism by which a transient run corrupts a durable contract.

The actor and the judge MUST be separate agent instances from the stage manager, and from each other. Their isolation is a property of the instance, not of a promise: an agent cannot forget the story it already read.

### Assertion Channels

An assertion reads from exactly one of two channels, and the channel decides what the assertion is allowed to constrain.

**Outside-in** assertions read what the product returned to the actor: responses, statuses, visible state, and error surfaces. This is the product seen as a user sees it.

**Inside-out** assertions read product records that the run produced: audit events, capability usage, approvals, leases, and the durable Workspace, Thread, Turn, Item, Artifact, Goal, Task, and AgentSession state named in Authority And Projection. This is whether the product did internally what it promises to do, and the stage manager collects it through the product's own public read surfaces.

An inside-out assertion MUST name a product record that has an owning specification. That single rule is the whole boundary against implementation testing. An audit event is a product promise with a named owner; a log line, a function-call trace, a process argument, a configuration digest, and in-memory state are not, and a story that reaches for them has left the product contract and will have to define its own oracle from scratch — an obligation with no natural bound.

When a run reveals internal misbehaviour that no product record can witness, that absence is itself a product finding: the system lacks observability it should have. Record it as a finding against the owning product specification. Do not close the gap by inventing a story-local oracle.

### What No Assertion May Constrain

Both channels share one prohibition, and it is the same prohibition the Admission test enforces:

> Assert what must be true. Never assert the path by which it became true.

An outside-in assertion may constrain what came back, never how the actor got there. An inside-out assertion may constrain the end state of product records and the ordering relations between them, never the sequence of internal operations that produced them.

The distinction is not visible in the grammar, only in the object. "Exactly one usage row per successful tool call" is an invariant over product records and is admissible. "Exactly nine ordered calls" fixes the actor's trajectory and is not. Both use "exactly"; only one names something the product promises.

Demanding that two runs produce the same trajectory is the same error stated as a policy, and it is forbidden. Verdict reproducibility is required and cheap: two judges reading one evidence package reach the same conclusion. Trajectory reproducibility is neither, and requiring it silently converts an open-ended attempt into a mechanical one until the story no longer belongs at this layer.

### Required And Optional Assertions

Because the actor is uncontrolled, a run may simply never reach some mechanism, leaving an assertion unwitnessed. Each assertion therefore declares one tier.

A **required** assertion must be witnessed. An unwitnessed required assertion is not a pass; the run is `inconclusive`, because the story promised to exercise something and did not.

An **optional** assertion is decided when witnessed and skipped when not. A run in which an optional assertion was never reached still passes, and the judge records that it was unwitnessed rather than treating absence as failure.

The tier is derived, not chosen. An assertion may be required only when a goal-shaped ask exists that the actor cannot complete without crossing the mechanism:

> A required assertion MUST be reachable by an ask that states an objective the mechanism serves, and MUST NOT need an ask that names the mechanism.

Giving the actor a task it cannot finish without passing an approval gate is admissible; telling it to trigger the approval flow is not, because that is the trajectory again arriving through the ask. When no such ask can be constructed, the assertion cannot be required. It is optional, or the proof belongs at a lower layer.

Optional assertions decay silently, so the count of unwitnessed runs is retained per assertion. An optional assertion that no run has witnessed over a full release cycle is a finding: either its ask never approaches the mechanism, or the assertion is dead. Both dispositions belong to the story's owner, not to the judge.

### Friction Findings

The actor's record contains more than assertion inputs. It also holds the shape of the attempt: how many tries a step took, where the actor was confused, what it had to guess, which affordance it looked for and did not find. That signal is unique to this layer, because a mechanical test only ever checks what its author already thought to check.

Friction is never adjudicated. It is not a predicate, so making it one would reintroduce trajectory constraints — "too many attempts" is a trajectory assertion wearing different clothes — and discarding it would throw away the layer's distinctive output.

Friction is therefore a non-blocking finding owned by the stage manager, which already writes Failure Triage Notes and already may not issue a product verdict. It follows the existing disposition rule in Acceptance Predicates: every non-blocking finding in a run record is linked to a change record or product issue, or explicitly waived with a reason. A passing run with recorded friction is a passing run; the friction is still owed a disposition.

### Reduction Handoff

Two paths leave this layer: a story that fails Admission, and a confirmed defect reduced into lower coverage. Both hand a proof to `docs/specs/20260529-test_strategy.md` and its layers, and both carry one condition.

The receiving test MUST NOT reimplement authentication transport, command routing, process-group supervision, credential redaction, evidence-directory policy, Git inspection, timeout orchestration, or cleanup already owned elsewhere. When existing support cannot host the proof without such duplication, improve that owner as a separately justified change. Accepting the duplication instead is what produces a parallel execution framework, and the framework then grows to absorb everything the proof cannot otherwise establish.

A proof that leaves L6 leaves completely. Its story document is deleted rather than retained beside the test, because a document that restates what code asserts carries no authority while it agrees and misleads once it drifts.

## Lifecycle

1. Author or revise one story against accepted Core and feature specifications.
2. Confirm its distinct L6 risk and identify the lowest-layer checks already covering the underlying behavior.
3. Apply the Admission test to the drafted assertions. The change record admitting or revising an L6 story states the satisfiability argument in its acceptance observations, so an inadmissible proof is redirected to its real layer before writes rather than during execution.
4. Preflight only the environment capabilities named by the story.
5. Execute through the named public surface under one bounded deadline.
6. Adjudicate and classify the result as `passed`, `failed`, `skipped`, `environment_failure`, `tool_failure`, or `inconclusive` under the authority split in Pass And Failure Semantics.
7. Preserve the story revision, assertion summary, redaction result, and the evidence required by the retention policy in Evidence And Security.
8. Reduce a confirmed deterministic product defect into L1-L5, then retain L6 only if its end-to-end intent remains valuable.
9. Clean disposable state; a cleanup failure is reported separately and does not rewrite the product result.

An interrupted real-provider or real-worker run may preserve available redacted evidence and be retried as a fresh run. L6 does not require transparent executor recovery, resumable evidence settlement, or reconstruction of every partially written report.

## Pass And Failure Semantics

In agent-first execution the judge issues `passed`, `failed`, and `inconclusive` from the story and the evidence package; the stage manager records that verdict without arbitration and is authoritative only for `skipped`, `environment_failure`, and `tool_failure`. Once the actor has completed the user-visible flow and evidence collection has succeeded, `environment_failure` and `tool_failure` are no longer available classifications; a doubtful product outcome is `inconclusive`.

`passed` means every required deterministic assertion passed, every witnessed optional assertion passed, and no observed behavior contradicted the explicit story intent. An optional assertion the run never reached is recorded as unwitnessed and does not withhold a pass.

`failed` means the product violated a required assertion, blocked the supported workflow, lost required state, duplicated a protected effect, or exposed protected data.

`skipped` means an opt-in capability required by the story was not enabled or provisioned before execution was attempted; the report names the unmet capability and no setup or product step runs. A skip is not acceptance evidence and MUST NOT be presented or counted as a pass.

`environment_failure` means the story was selected with its required capabilities declared available, but an external service, credential, quota, host, tool environment, or disposable environment failed during preflight, setup, or execution before the product result could be judged.

`tool_failure` means the executor or browser-control tool failed independently of the product.

`inconclusive` means the story lacks a sufficient oracle, the run ended after an effect whose outcome cannot be proved, or a required assertion was never witnessed because the actor did not reach its mechanism. A judge that cannot decide a required assertion from the evidence package returns `inconclusive` naming the missing evidence. Every `inconclusive` here is a story defect rather than a product defect, and the two shapes have different repairs: missing evidence tightens `Evidence To Collect`, while an unwitnessed required assertion means the ask does not reliably reach the mechanism, so either the ask is reshaped under Required And Optional Assertions or the assertion becomes optional. Do not synthesize a pass, build a recovery workflow, or add guidance that names the mechanism to the actor.

Subjective usability findings and the friction signal in the actor's record are non-blocking unless they contradict an explicit expected outcome. Every recorded finding is either linked to a change record or product issue or explicitly waived with a reason in the run record; findings do not silently disappear. They may become product issues or design discussion without adding permanent runner behavior.

## Evidence And Security

Every completed run retains the story identifier and revision, environment kind, elapsed time, final classification, deterministic assertion results, and a redaction check.

The evidence package is the adjudication input and must satisfy one bar: an independent judge with no run memory reaches the same product verdict from the story and the package alone. It always contains the verbatim actor prompt and the artifacts named by `Evidence To Collect`. Each agent-first run also records four non-blocking scalars trended per story revision: actor tool calls, error-recovery retries, guidance loaded beyond the story's declared minimum, and elapsed time.

`failed` and `inconclusive` runs retain the full redacted transcript and evidence package for one release cycle. `passed` runs retain the summary, plus the full package for a small sampled fraction kept one release cycle for re-adjudication and review calibration.

Real secrets, tokens, cookies, authorization headers, full credential files, and private account data MUST NOT appear in story files, command output, evidence, reports, CI artifacts, or committed fixtures. Opt-in real runs must reuse the existing credential and redaction owners.

Evidence directories are output locations, not databases or workflow owners. A partial evidence write may be deleted or replaced on a fresh run; it does not require a settlement record, append protocol, or recovery state machine.

## Test And Release Policy

The story metadata parser and the story schema check — front matter fields, existing `contracts` references, and the normative body section list — receive focused L0/L1 coverage. This mechanical validation is separate from agent-first L6 execution, remains part of the ordinary repository gate, and supplies no L6 acceptance evidence.

L6 execution is opt-in and agent-first. A stage manager explicitly dispatches an admitted story under the execution model in this specification; ordinary L0/L1 validation does not dispatch or execute it. Real-provider or real-worker dependencies remain explicit properties of that run and reuse their existing credential, redaction, supervision, and cleanup owners.

Skipped, environment-failed, and unexecuted stories are not acceptance evidence. When an owning release policy or current release record designates an opt-in real-provider or real-worker story as applicable, that L6 gate contribution is satisfied only when the story actually executed and passed in that cycle; a missing capability or skipped run leaves it unmet rather than silently green. This specification defines evidence semantics and does not decide which stories are applicable to a release.

## Current Implementation

Story artifacts live under `tests/stories/`. The committed stories declare their owning contracts, and `scripts/validate-story-schema.mjs` mechanically validates the closed front matter field set, contract-reference existence, repository-unique story ids, and normative body section list inside `check:repo`; focused parser coverage lives in `tests/story-metadata.test.mjs`. These L0/L1 checks validate artifacts without executing L6.

The five former mechanical story proofs now run from the L3 and L4 entrypoints and gates owned by `docs/specs/20260529-test_strategy.md`. Their obsolete story documents and shared runner location have been removed.

The remaining admitted stories have no committed runner, adapter, or per-story command. Stage-manager/actor/judge separation, friction scalars, and retention sampling remain accepted execution design that is not yet implemented.

No new cancellation, compression, credential-override, restart, recovery, or backend-specific L6 harness is accepted by this specification. A confirmed real integration failure is fixed in product code and reduced to the lowest sufficient regression layer.

## Acceptance Predicates

- Two independent readers can identify the story's one user intent, supported entry point, required environment, and deterministic pass/fail oracles.
- The recorded actor prompt shows the actor task payload contained only the persona and the user ask, with no story content or discovery answers.
- An independent judge reproduces the product verdict from the story and the evidence package alone.
- Every deterministic assertion names the evidence or product record that decides it.
- Story front matter declares owning contract documents that exist in the repository.
- Every assertion in a committed story is satisfiable from the persona and the sole user ask, and no committed runner, adapter, per-story command, or fixed script exists for any story.
- Every assertion declares its channel and tier, every inside-out assertion names a product record with an owning specification, and no assertion constrains the path by which its subject became true.
- Every required assertion is reachable by an ask that states an objective without naming the mechanism, and an unwitnessed required assertion yields `inconclusive` rather than a pass.
- Recorded friction is dispositioned as a non-blocking finding and never enters the product verdict.
- The change record admitting or revising a story states the satisfiability argument in its acceptance observations.
- Each committed story is one `*.story.md`, either directly under `tests/stories/` or alone in one asset directory there, and that directory contains no committed executable.
- Every run role's central claim has a named falsifier, and the judge recomputed at least one value the stage manager claimed.
- A story requiring more than one run names one accumulating verifier that is not a per-run judge.
- No accepted specification names one story artifact as an exception to a rule it states generally.
- When one agent coordinates the repository change and stage-manages the run, its evidence claim was falsified by a party it does not control, it did not verify its own accumulation, and it did not amend a contract to close a finding raised against it.
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

Rejected because setup knowledge contaminates the verdict, the verdict stops being reproducible from the evidence package, and self-triage bias misclassifies product failures as environment failures. Diagnosis benefits from run context, so the stage manager keeps Failure Triage Notes; judgment is harmed by run context, so the verdict belongs to a clean judge. This repository-acceptance rule does not authorize a product Evaluation Harness; the explicit product self-improvement loop separately keeps agent analysis advisory and human Knowledge Review authoritative under `docs/specs/20260710-self_improvement_evaluation_loop.md`. Read-only recomputation by the judge is not this rejected shape: it supplies no setup knowledge, no run context, and no expectation, and the judge still never prepares or executes the run.

### Judge With No Verification Capability At All

Rejected after a real program showed the cost. A judge that can only read prose cannot check a claim, so every fact the stage manager asserts must instead be made self-evidently trustworthy in writing. That obligation has no natural bound: each review of the resulting evidence contract discovers another unproven step, and the contract grows to absorb hashing, provenance, cardinality, and envelope enumeration that a single recomputation would have settled. The tool ban was intended to keep run context out of the verdict, but it also removed the only cheap falsifier for evidence faithfulness, and the missing falsifier was paid for in unbounded documentation. Read-only recomputation restores the falsifier while keeping the context boundary intact.

## Deferred, Non-authorizing Questions

- Whether repeated agent-first runs justify one small shared executor entry point.
- Whether story count eventually justifies catalog or selection metadata.
- Whether a cheap, stable subset should become a release-candidate gate.
- Whether judge-model rotation and seeded-defect adjudication calibration deserve a standing schedule once run volume grows.

These questions create no current implementation or test obligation. A future proposal must begin with evidence from repeated real runs and identify what existing owner cannot meet the need.

## Related Docs

- `docs/change-execution.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `tests/stories/README.md`
- `README.md`
