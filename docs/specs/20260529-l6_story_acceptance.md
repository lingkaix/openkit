---
status: Accepted
implementation: Partial
kind: process
updated: "2026-10-13"
---
# L6 Story Acceptance Testing

## Owns

This specification owns the L6 story-acceptance boundary: L6 admission, the story artifact and its on-disk shape, the current catalog, actor channels, the execution model, execution role separation with per-role falsifiers, predicate channels and their required and optional tiers, adjudication authority, friction and improvement suggestions, how a story names the integrity invariants that it relies on, the story-run evidence bundle, reduction and the handoff conditions when a proof or a confirmed defect leaves L6 for a lower test layer, multi-run accumulation, execution and failure semantics, evidence proportionality and retention, and story admission stability.

## Does Not Own

This specification does not own product behavior, Core or specification authority, the complete L0-L6 test strategy, release policy, a general agent executor, browser automation infrastructure, process supervision, transport clients, credential management, evidence storage, or workflow recovery. Those responsibilities remain with their existing owners.

It does not own deterministic tests of any kind, including opt-in real-provider ones. A mechanical proof of a fixed path through the product belongs to an L3 or L4 test under `docs/specs/20260529-test_strategy.md`, which also owns real-provider opt-in rules across every layer.

It does not own material change coordination under `docs/change-execution.md`, including repository-path writer ownership, actual-artifact acceptance, or the choice of independent judgment. This specification's run roles govern one story execution only; Role Composition states the division and does not restate that document's rules.

It does not own the product integrity check operation. [Product Integrity Check](20261012-product_integrity_check.md) owns that operation. It does not own product telemetry instrumentation.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/communication.md`
- `docs/core/audit.md`

## Summary

L6 answers one question: can a user or AI agent complete one important product intent through a supported public surface in a realistic environment?

L6 is an opt-in acceptance layer, not a required copy of L1-L5 and not a test platform for every feature, failure branch, provider, runtime, transport, or deployment shape. A behavior already proved deterministically at a lower layer receives L6 coverage only when a distinct end-to-end product risk remains.

L6 is agent-first by definition. An actor exercises the intent knowing only what a real user would know, and what that unconstrained attempt reveals is the whole reason the layer exists. A mechanical proof of a fixed path is not a lesser L6 story; it is an L3 or L4 test, and `docs/specs/20260529-test_strategy.md` owns it there. A story therefore has no prescribed Actor trajectory or per-story executable. Shared execution support may reuse existing product clients and collection tools; it must not grow parallel authentication, transport, process-control, evidence, Git, cleanup, or recovery systems.

Agent-first execution separates three roles: a stage manager that prepares the environment and assembles evidence, an actor that receives only the persona and one user ask, and a judge that adjudicates from the story text and the evidence package alone. The product verdict must be reproducible by an independent judge from that package. Each role's central claim carries a named falsifier under Role Claims And Falsifiers.

Outcome predicates read from two channels. Outside-in predicates check what the product returned to the actor. Inside-out predicates check the product records the run produced. Neither predicate may constrain the path by which its subject became true. That prohibition keeps an open-ended attempt from becoming a mechanical one.

## Current Scope

The current engineering baseline is the V1 scheduling profile and counts defined in `docs/specs/20260703-runtime_scheduling_scale.md`: one configured `RuntimeTarget` projecting one NanoHost and one active worker slot, with NanoHost runtime details owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`. Ordinary L6 runs default to the persistent-deployment modes in `docs/specs/20260909-persistent_deployment_acceptance.md`: in-product work or an external Skill/browser Actor operating the same real product. The Actor need not run inside NanoCore. A dedicated environment is used when the story names a distinct installation, cold-start, destructive or isolation condition that a persistent instance cannot prove. L1-L5 retain their existing execution owners. L6 targets the small-team shape described by the Judgment in `docs/deployment.md` without defining a team-size threshold of its own. It should prove that product shape after the target path is implemented; it does not simulate multi-process, multi-writer, fleet, fairness, hot-failover, or high-availability behavior, and prior Cell or A1 runs do not prove the accepted RelayStream plus nested standard HTTP/2 feasibility precondition.

One accepted story should normally prove one complete user intent. It may cross several existing components when the user intent naturally does so, but it MUST NOT accumulate unrelated cache, usage, audit, review, Git, cleanup, Runtime Epoch recovery, cancellation, compression, credential-override, and recovery predicates merely because one runner can reach them.

Security, authorization, credential isolation, secret redaction, sandbox containment, data-loss prevention, durable authority, and irreversible external effects remain strict. Availability, optional diagnostics, cleanup projection, reconnect convenience, and external-run interruption may use an explicit environment failure, product interruption, `recovery_required`, inspection, or fresh-run fallback when transparent recovery is not part of the owning product contract.

## Goals

- Validate a small number of high-value user-intent workflows through supported public surfaces.
- Detect integration and usability failures that lower deterministic layers cannot reveal.
- Keep stories versioned, readable, and tied to explicit machine-checkable outcomes.
- Use real providers or workers only when their behavior is the distinct risk being accepted.
- Reduce a confirmed defect only by the rule in Reduction Handoff.
- Keep execution and evidence mechanisms thin, reusable, and subordinate to the story.

## Non-goals

- Do not create an L6 story for every feature, state transition, fallback, backend, or deployment combination.
- Do not admit a proof whose Actor must follow a fixed script; that proof belongs to a lower layer. Shared preparation, collection and adjudication support does not prescribe an Actor trajectory.
- Do not treat subjective agent judgement as the sole blocking oracle.
- Do not let an executor mutate private product state during the user-flow portion of a story.
- Do not build another authentication transport, process supervisor, workflow engine, recovery coordinator, evidence platform, Git harness, or general agent-runner framework for L6.
- Do not require real credentials, quota, host state, or external network access in the default repository checks.
- Do not make L6 an automatic pull-request, ordinary push, or tag gate under the current policy.
- Do not test deferred scale or availability properties that the product does not currently promise.

## Authority And Projection

The owning Core and feature specifications remain the authority for product behavior. A story references those contracts and selects a realistic proof path; it does not create or broaden product requirements.

The Markdown story is the authority for that run's intent, starting world, outcome predicates, perturbations, named integrity invariants, allowed setup, and cleanup. Runner code is an execution projection and MUST NOT silently add stronger product requirements or hidden setup.

Product records remain authoritative for Workspace, Thread, Turn, Item, Artifact, Goal, Task, AgentSession, execution attempt, approval, usage, and audit state. An L6 evidence summary records observations and identifiers needed for triage but MUST NOT duplicate those records into another lifecycle.

Screenshots, traces, transcripts, logs, and reports are supporting evidence, not product authority. Absence of optional evidence does not overturn an otherwise provable product result unless the story declared that evidence as an outcome predicate.

## Story Selection

Add or retain an L6 story only when all of the following are true:

- It represents one material user intent or release-risk path.
- At least one important failure can occur only across supported public boundaries or during realistic use.
- The same confidence cannot be obtained more cheaply at L1-L5.
- The required environment and oracle are available without inventing private product capabilities.
- The story has an explicit owner and remains cheap enough to run intentionally.

### Run Consistency

A new or materially revised story becomes acceptance evidence only after repeated agent-first runs return a consistent typed classification: three consecutive runs for stories without real-provider requirements, two for opt-in real-provider or real-Codex stories. Per-story `inconclusive`, `environment_failure`, and `tool_failure` rates stay in the run records so instrument noise remains visible.

Only the engineer may delete, merge, or demote a catalog story. Do that when lower-layer coverage now owns its only distinct risk, the public surface is removal-only, the story depends on private seeding, or its adapter costs more than the product confidence it provides.

## Catalog

The current catalog has ten stories. Only the engineer may add, remove, or replace one. Each story has one persona and one ask. [L6 story reorganization](../decisions/20261012-l6_story_reorganization.md) records why this list is closed.

1. First install from release assets. Run it on a disposable host.
2. The operator updates the persistent deployment from an earlier published release to the latest published prerelease through the built-in update tools. The earlier published release is the previous release or an older published release. The deployment carries that release's real data. The outcome includes data continuity and rollback. The Data Root and the protected configuration remain. Retained Workspace records stay readable through a public read. Public health, the Web entry, authenticated diagnostics, and the runtime-target read show readiness before Worker admission. [App Update Delivery](20260910-app_update_delivery.md) owns the helper, including rollback. A mocked receipt is not success. This story does not prove a first install or a cold start.
3. The operator configures one provider, one Vault credential, and one subscription, and obtains one ordinary assistant reply. The credential is not printed. A missing credential or quota is an environment failure. A public response shows the logical model only.
4. The operator issues a scoped token for an external agent and then revokes it. A workspace token can create a Thread. A workspace-readonly token cannot, and the protected effect does not run. The remote connection uses a protected per-user static bearer. [Remote auth credential bootstrap](20260704-remote_auth_credential_bootstrap.md) owns issuance and revocation.
5. An external agent completes the designated work through remote MCP and grounds the answer in a public record on that deployment. The Chat exchange folds into this story as an optional predicate. A simple question is answered on the addressed Thread and creates no delegated Worker Turn and no handoff Item. When that predicate is witnessed, the answer is a meaningful assistant message. Its completed assistant-message Item is on the addressed Thread. Complete Thread, Turn, and Item reads show that Item. When that predicate is witnessed, the public `conversation.submit` result has `targetRef=internal-role:assistant`, `outcome=answered`, and `handoff=null`, the originating and receiving Workspace and Thread are the same, and the completed Turn has `agentId=quick-chat`. Dashboard work-status fields do not prove the routing decision. Missing `guide` does not by itself fail the attempt. The judge recomputes the deciding fact. An operator spot check alone does not prove the flow. The evidence retains the redacted MCP tool descriptions actually supplied to the actor. The evidence retains the requests and responses the actor used. [Chat Mode](20260704-chat_mode_assistant.md) owns the no-delegation boundary.
6. A Goal runs to completion with Plan approval and one Worker Task. The actor approves the Plan through a public surface. The actor decides completion through a public surface. The approved Plan is the exact immutable version, approved through its Pending Request. Activation admits an ordinary Task linked to the current card revision and the approved Plan. The Task's actual output is readable. Completion is accepted with the exact candidate and evidence through its Pending Request. That request is then consumed. The terminal completion disposition is then recorded. No worker starts from creation or from Plan approval alone. The approved Plan authorizes the linked Task without a second per-Task approval. Worker completion leaves the Goal open until the completion grant is consumed. Effect-specific approvals stay separate when the chosen Task needs them. Do not add pause, resume, a recipe graph, a Sandbox pin, automatic worker retry, Knowledge publication, or a deferred evaluation loop. The deciding evidence is the public Goal read with intent, card, Plan identity, and digest. It includes the linked Task Thread and terminal Turns and the output Artifact. It includes the Plan and completion Pending Requests with exact intents and deciding actors. The final Goal disposition names the accepted candidate.
7. An issue proceeds to a Worker pull request and then to a reviewed merge. The starting world includes one designated issue and one acceptance branch. The Worker uses the Gateway-mediated GitHub MCP. Issue and repository reads do not need write approval. The Task produces the meaningful fix for the designated issue. The Task reaches a completed result. Governed external writes pause for the matching Pending Requests. The actor approves the branch write, the pull-request creation, and the reviewed merge through public surfaces. Each grant is an exact-request decision. There is no blanket write grant. The granted effects are only the authorized branch writes, pull-request creation for that issue and repository, and the reviewed merge. Authorized branch writes are branch creation and a commit or push to that branch. Default-branch writes, unrelated repositories, and other effects stay refused. Answered requests are delivered on later Turns of the same Task Thread. No step resumes a paused worker or invents an automatic Task loop. An admission response, a grant, or a URL does not prove that the pull request exists. Retained evidence shows the open pull request against the declared base, bound to the designated issue and branch, before the merge. A final fresh GitHub read shows the reviewed and merged result into that base. A fresh GitHub read of the branch and of the actual changed-file diff is deciding evidence. That read is bound to the designated issue, the branch, and the declared base. These observations use existing GitHub reads and product approval records only. The deciding evidence includes the public `task.start` admission result that names the Task Turn and Thread. It includes the replay and the Task Mode Thread and Turn reads. It includes the initiating Item and the completion Item. It includes the GitHub capability-call evidence. It includes each Pending Request's exact intent, deciding actor, and recorded execution outcome.
8. The user captures Knowledge with sources and uses it in an answer. The answer cites the accepted knowledge entry. [Knowledge store governance](20260702-knowledge_store_governance_rules.md) owns source references.
9. The operator reviews diagnostics and health. Diagnostics do not reveal a raw secret. Public health, the Web entry, authenticated diagnostics, and the runtime-target read show readiness.
10. Restart or update during work has an accounted outcome and no duplicate protected effect. The restart or the update is a perturbation. The actor does not receive that procedure. A claim that no replacement worker is ever created is not a predicate.

Deployment readiness checks remain post-conditions of stories 2 and 9; they are not catalog stories. The four-runtime matrix is Worker qualification, not a story. [Release Management](20260829-release_management.md#catalog-stories) owns catalog and qualification cadence. Automated updates and qualification supply no L6 verdict; independent Actor and Judge rules remain binding. Story files come in a later package.

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

- `Intent`: one persona and one ask, written as a real user would say them.
- `Starting World`: the world that exists before the actor starts.
- `Outcome Predicates`: what must be true when the run ends. Each predicate names its channel and its tier under Predicate Channels and Required And Optional Predicates.
- `Perturbations`: conditions the stage manager applies. A perturbation is a condition the user does not cause, such as a restart, an update, or a provider failure. An approval is not a perturbation. Write `None.` when the story has none.
- `Integrity Invariants`: the names of the invariants the story relies on. This specification does not define those invariants. A story that relies on no invariant writes `None.`
- `Failure Triage Notes`: product, environment, tool, or inconclusive classification and the likely lower regression layer.

These sections are allowed when the story needs them:

- `Setup`: non-user preparation through existing public or test-owned support.
- `Required Opt-in Environment Variables`: the explicit opt-in variables for a real-provider or host-dependent run.
- `Evidence To Collect`: the artifacts the stage manager captures for adjudication and triage.
- `Cleanup`: bounded process and disposable-state cleanup.

No other body section is allowed. The section list is normative for repository validation. A story states an outcome. A story does not state actor steps.

Every outcome predicate is an oracle over collected evidence or a public product read, and it names what decides it. A verdict about the run itself, such as "the run executes and passes", is not an outcome predicate. Execution, skip, and gate semantics are owned by this specification.

Evidence requirements appear only when they change the acceptance decision or materially shorten failure triage. Long transcripts, screenshots at every state, database dumps, network archives, repository snapshots, and full audit exports are not default requirements.

## Admission

L6 is agent-first. That is the layer's definition, not its preference. An agent or a person exercises one product intent through a public surface while knowing only what a real user would know, and the value of the layer is what that unconstrained attempt reveals. A proof that does not work this way is not a weaker L6 story; it is a test at a different layer, and `docs/specs/20260529-test_strategy.md` already owns those layers.

One satisfiability test decides admission, applied to the story's own outcome predicates:

> Every outcome predicate in an L6 story MUST be satisfiable by a competent actor that knows only the persona and the sole user ask.

Bounds and prohibitions are satisfiable and remain available: `only X`, `no Y`, `at most N`, `not before Z`, and predicates over product records and their ordering. An exact call sequence, an exact call cardinality, a fixed call order, or a prohibition on retry is not satisfiable from a persona and an ask alone. An actor could satisfy it only by being told the trajectory, which the actor context rules forbid.

**A story containing any such outcome predicate is not admitted to L6.** Its outcome predicates describe a mechanical path through the product, which is what L3 NanoCore black-box integration and L4 Web browser end-to-end tests exist to check. Send it there as ordinary test code; do not keep a story document beside it. Two artifacts that must agree about one mechanical path will drift, and the drift has no owner.

This test is decidable at authoring time, which is the only cheap moment. A story that states a trajectory its actor cannot know has no valid execution. The actor cannot satisfy the outcome predicate, and every attempt to close the gap feeds the trajectory back to the run through Setup, which destroys the isolation the layer depends on. Move the proof to its real layer. Do not widen the evidence until the outcome predicate looks satisfied.

An L6 story body MUST NOT contain a fenced code block. Committed executable detail in story prose is the observable form of that feedback, and a story that appears to need it has failed admission.

Admission is re-decided on every revision, not only at authoring. A story drifts past the line one compliant edit at a time, so the test applies to the story as revised rather than to the story as first admitted. A revision that would cross the line is refused and its proof redirected. If repeated revisions do not produce an admitted story or completed run, the primary agent reframes rather than repeating the method under `docs/change-execution.md`.

### Execution Support

L6 has no per-story runner, adapter or command. Adding a story adds no entry to `package.json`, no CI target and no executable beside the story. Shared support may prepare an existing deployment, invoke an existing Agent host, preserve evidence or recompute deterministic facts when repeated use demonstrates the need. That support is parameters, the evidence directory, browser preflight, actor provisioning, evidence collection, and cleanup. Such support stays in its existing owning module, remains independent of story answers and reuses public clients. Mechanical validation of the story document is separate and remains part of the ordinary repository gate.

A one-off script may remain disposable. Repeated generic setup or evidence collection may be retained in shared support after focused verification; copying disposable scripts per run is not required. Promotion must remove scenario-specific answers, duplicated transport and private product-state mutation. A script that dictates the Actor's solution remains a mechanical proof and returns to Admission above. The stage manager may reuse a healthy deployment without invoking installation or teardown.

### Execution Model

One run proceeds in four movements, and each hands a bounded artifact to the next.

1. **The stage manager sets the scene.** It reads the full story, performs Setup, and provisions the actor. Everything the run needs to exist before the actor acts is its responsibility.
2. **The actor improvises.** It receives a situation and one thing it wants to accomplish — never a sequence of steps. It is a cooperating user, not a performer with lines: how it reaches the goal is its own choice, and its unconstrained attempt is what this layer exists to observe.
3. **The run is recorded from two sides.** The actor's own record holds what it encountered, what it saw, and what the product returned. The stage manager separately collects the product records the story names. Both go into the evidence package.
4. **The judge adjudicates.** From the story and that package alone it decides each outcome predicate and returns the product verdict with a per-predicate rationale.

The word `script` does not describe anything in this model. A script is a fixed sequence, and handing one to the actor would supply the trajectory the Admission test exists to keep out. What the actor receives is a persona and a single ask.

### Roles

Agent-first execution separates three roles with different context rules.

The role that prepares and runs the execution is the **stage manager**. It is scoped to one story run and does not accept repository artifacts. It is distinct from the primary agent coordinating repository changes under `docs/change-execution.md`. The name states the constraint — a stage manager runs the show and never judges it.

The stage manager reads the full story, performs Setup, provisions the actor, captures the evidence named by the story, records the verdicts, writes Failure Triage Notes, and performs Cleanup. It is authoritative for `skipped`, `environment_failure`, and `tool_failure` and never issues a product verdict.

The actor pursues the ask through the declared public surface. Its context contains only the persona and the user ask. It MUST NOT receive the story file, the outcome predicates, or answers the story requires it to discover. The verbatim actor prompt is part of the evidence package. When the entrypoint is itself an agent surface, the tested agent is the actor and the same context rules apply.

The judge adjudicates in a clean context from exactly two inputs: the story text and the evidence package. It never interacts with the actor, never observes a run in progress, and never reads the host environment. It returns the product verdict with a per-predicate rationale. For stories on strict surfaces the judge SHOULD come from a different model family than the actor.

The judge MAY perform read-only verification and MUST recompute at least one named value the stage manager claims. Its permitted sources are the evidence package and the product's public read surfaces for records the story names. **After the run has terminated and its evidence is sealed, a read-only query to a public product read surface is not interaction with a live run.** That distinction is what makes the boundary decidable: what is forbidden is influencing or observing an execution in flight, not re-deriving a settled fact from the product's own contract.

Read-only recomputation is not run context. It tells the judge nothing about what the story expects, and it is the only mechanism by which the stage manager's faithfulness claim below becomes falsifiable. Absent it, that claim can only be argued in prose, and the argument grows without bound.

Normal Agent-host instructions, public product documentation and the installed Skill are permitted operating context. The task payload still contains only persona and user ask for the Actor, and story plus evidence for the Judge. Neither instance may inherit the current development conversation, hidden expected answers, another role's reasoning or private implementation guidance. Use a fresh host session away from the source checkout and disable unrelated memory or task-context injection when necessary. Retain the host/profile, supplied task prompt and admitted tools/Skill identity; if material context isolation cannot be established, record an exploratory use result rather than claiming admitted L6 evidence. An immutable host envelope is not disqualifying merely because it exists; hidden task knowledge remains disqualifying.

Limit the actor's channels. Do not limit the actor's intelligence. The actor may use every general ability through a public surface. Those abilities include documentation, retries, reasoning, and another use of the product. The actor must not use a privileged channel. A privileged channel is host SSH, direct database access, direct file access, repository source, or internal development knowledge. An outcome reached through public channels passes. Record each workaround as friction. An outcome reached only through a privileged channel does not pass. Setup, cleanup, and diagnostic inspection remain stage-manager work using declared repository tools.

No general committed agentic executor is required. Repeated manual steps may be automated only after real runs demonstrate a stable shared need, and the resulting support must reuse an existing runner owner rather than create another framework.

### Role Claims And Falsifiers

Each run role makes one central claim, and each claim has a named falsifier. A role whose claim cannot be falsified is not verified by evidence; it is asserted, and that claim will be replaced over time by unbounded documentation attempting to establish it.

| Role | Central claim | Falsifier |
| --- | --- | --- |
| actor | The task payload contained only the persona and the sole user ask. | Any story text, outcome predicate, or answer the story requires the actor to discover is reachable in that payload. |
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

### Predicate Channels

An outcome predicate reads from exactly one of two channels, and the channel decides what the predicate is allowed to constrain.

**Outside-in** predicates read what the product returned to the actor: responses, statuses, visible state, and error surfaces. This is the product seen as a user sees it.

**Inside-out** predicates read product records that the run produced: audit events, capability usage, approvals, execution attempts, and the durable Workspace, Thread, Turn, Item, Artifact, Goal, Task, and AgentSession state named in Authority And Projection. This is whether the product did internally what it promises to do, and the stage manager collects it through the product's own public read surfaces.

An inside-out predicate MUST name a product record that has an owning specification. That single rule is the whole boundary against implementation testing. An audit event is a product promise with a named owner; a log line, a function-call trace, a process argument, a configuration digest, and in-memory state are not, and a story that reaches for them has left the product contract and will have to define its own oracle from scratch — an obligation with no natural bound.

When a run reveals internal misbehaviour that no product record can witness, that absence is itself a product finding: the system lacks observability it should have. Record it as a finding against the owning product specification. Do not close the gap by inventing a story-local oracle.

### What No Predicate May Constrain

Both channels share one prohibition, and it is the same prohibition the Admission test enforces:

> State what must be true. Never state the path by which it became true.

An outside-in predicate may constrain what came back, never how the actor got there. An inside-out predicate may constrain the end state of product records and the ordering relations between them, never the sequence of internal operations that produced them.

The distinction is not visible in the grammar, only in the object. "Exactly one usage row per successful tool call" is an invariant over product records and is admissible. "Exactly nine ordered calls" fixes the actor's trajectory and is not. Both use "exactly"; only one names something the product promises.

Demanding that two runs produce the same trajectory is the same error stated as a policy, and it is forbidden. Verdict reproducibility is required and cheap: two judges reading one evidence package reach the same conclusion. Trajectory reproducibility is neither, and requiring it silently converts an open-ended attempt into a mechanical one until the story no longer belongs at this layer.

### Required And Optional Predicates

Because the actor is uncontrolled, a run may simply never reach some mechanism, leaving an outcome predicate unwitnessed. Each outcome predicate therefore declares one tier.

A **required** outcome predicate must be witnessed. An unwitnessed required outcome predicate is not a pass; the run is `inconclusive`, because the story promised to exercise something and did not.

An **optional** outcome predicate is decided when witnessed and skipped when not. A run in which an optional outcome predicate was never reached still passes, and the judge records that it was unwitnessed rather than treating absence as failure.

The tier is derived, not chosen. An outcome predicate may be required only when a goal-shaped ask exists that the actor cannot complete without crossing the mechanism:

> A required outcome predicate MUST be reachable by an ask that states an objective the mechanism serves, and MUST NOT need an ask that names the mechanism.

Giving the actor a task it cannot finish without passing an approval gate is admissible; telling it to trigger the approval flow is not, because that is the trajectory again arriving through the ask. When no such ask can be constructed, the outcome predicate cannot be required. It is optional, or the proof belongs at a lower layer.

Optional outcome predicates decay silently, so the count of unwitnessed runs is retained per outcome predicate. An optional outcome predicate that no run has witnessed over a full release cycle is a finding: either its ask never approaches the mechanism, or the outcome predicate is dead. Both dispositions belong to the story's owner, not to the judge.

### Friction Findings

The actor's record contains more than predicate inputs. It also holds the shape of the attempt: how many tries a step took, where the actor was confused, what it had to guess, which affordance it looked for and did not find. That signal is unique to this layer, because a mechanical test only ever checks what its author already thought to check.

Friction is never adjudicated. It is not an outcome predicate, so making it one would reintroduce trajectory constraints. "Too many attempts" is a trajectory predicate wearing different clothes. Discarding friction would throw away the layer's distinctive output.

Friction is therefore a non-blocking finding owned by the stage manager, which already writes Failure Triage Notes and already may not issue a product verdict. It follows the existing disposition rule in Acceptance Predicates: every non-blocking finding in a run record is linked to a change record or product issue, or explicitly waived with a reason. A passing run with recorded friction is a passing run; the friction is still owed a disposition.

The actor's record carries improvement suggestions next to friction. A suggestion never enters the verdict. Triage each suggestion into an issue. A passing run may still carry suggestions.

### Reduction Handoff

Reduce the product-side cause. Do not reduce the actor's trajectory. A product defect replays the captured request sequence at L2 or L3. An interface-clarity failure pins the interface property. A tool description and the next action in an error are examples. External model behavior is recorded only, under the [accepted external-provider decision](../decisions/20261002-external_provider_behavior_accepted.md). An unreproducible race is recorded in an issue with its reason. "Not reducible, with reason" is an allowed outcome.

Two paths leave this layer: a story that fails Admission, and a confirmed defect reduced into lower coverage. Both hand a proof to `docs/specs/20260529-test_strategy.md` and its layers, and both carry one condition.

The receiving test MUST NOT reimplement authentication transport, command routing, process-group supervision, credential redaction, evidence-directory policy, Git inspection, timeout orchestration, or cleanup already owned elsewhere. When existing support cannot host the proof without such duplication, improve that owner as a separately justified change. Accepting the duplication instead is what produces a parallel execution framework, and the framework then grows to absorb everything the proof cannot otherwise establish.

A proof that leaves L6 leaves completely. Its story document is deleted rather than retained beside the test, because a document that restates what code asserts carries no authority while it agrees and misleads once it drifts. A reduced defect does not remove a catalog story. Only the engineer removes a catalog story.

### Integrity Invariants

Integrity invariants belong in the product as a read-only integrity check operation. [Product Integrity Check](20261012-product_integrity_check.md) owns that operation and its invariant names. This specification does not define it. A story names each invariant it relies on. The test side keeps one generic evidence collector over public operations. The judge recomputes deciding facts through public reads.

## Lifecycle

1. Author or revise one story against accepted Core and feature specifications.
2. Confirm its distinct L6 risk and identify the lowest-layer checks already covering the underlying behavior.
3. Apply the Admission test to the drafted outcome predicates. The change record admitting or revising an L6 story states the satisfiability argument in its acceptance observations, so an inadmissible proof is redirected to its real layer before writes rather than during execution.
4. Preflight only the environment capabilities named by the story.
5. Execute through the named public surface under one bounded deadline.
6. Adjudicate and classify the result as `passed`, `failed`, `skipped`, `environment_failure`, `tool_failure`, or `inconclusive` under the authority split in Pass And Failure Semantics.
7. Preserve the story revision, outcome-predicate summary, redaction result, and the evidence required by the retention policy in Evidence And Security.
8. Apply Reduction Handoff to a confirmed product defect. A catalog story stays unless the engineer removes it.
9. Clean disposable state; a cleanup failure is reported separately and does not rewrite the product result.

An interrupted real-provider or real-worker run may preserve available redacted evidence and be retried as a fresh run. L6 does not require transparent executor recovery, resumable evidence settlement, or reconstruction of every partially written report.

## Pass And Failure Semantics

In agent-first execution the judge issues `passed`, `failed`, and `inconclusive` from the story and the evidence package; the stage manager records that verdict without arbitration and is authoritative only for `skipped`, `environment_failure`, and `tool_failure`. Once the actor has completed the ask and evidence collection has succeeded, `environment_failure` and `tool_failure` are no longer available classifications; a doubtful product outcome is `inconclusive`.

`passed` means every required outcome predicate passed, every witnessed optional outcome predicate passed, and no observed behavior contradicted the explicit story intent. An optional outcome predicate the run never reached is recorded as unwitnessed and does not withhold a pass.

`failed` means the product violated a required outcome predicate, blocked the supported workflow, lost required state, duplicated a protected effect, or exposed protected data.

`skipped` means an opt-in capability required by the story was not enabled or provisioned before execution was attempted; the report names the unmet capability and no setup or product step runs. A skip is not acceptance evidence and MUST NOT be presented or counted as a pass.

`environment_failure` means the story was selected with its required capabilities declared available, but an external service, credential, quota, host, tool environment, or disposable environment failed during preflight, setup, or execution before the product result could be judged.

`tool_failure` means the executor or browser-control tool failed independently of the product.

`inconclusive` means the story lacks a sufficient oracle, the run ended after an effect whose outcome cannot be proved, or a required outcome predicate was never witnessed because the actor did not reach its mechanism. A judge that cannot decide a required outcome predicate from the evidence package returns `inconclusive` naming the missing evidence. Every `inconclusive` here is a story defect rather than a product defect, and the two shapes have different repairs: missing evidence tightens `Evidence To Collect`, while an unwitnessed required outcome predicate means the ask does not reliably reach the mechanism, so either the ask is reshaped under Required And Optional Predicates or the outcome predicate becomes optional. Do not synthesize a pass, build a recovery workflow, or add guidance that names the mechanism to the actor.

Subjective usability findings, friction, and improvement suggestions in the actor's record are non-blocking unless they contradict an explicit outcome predicate. Every recorded finding is either linked to a change record or product issue or explicitly waived with a reason in the run record; findings do not silently disappear. They may become product issues or design discussion without adding permanent runner behavior.

## Evidence And Security

Every completed run retains the story identifier and revision, environment kind, elapsed time, final classification, outcome predicate results, and a redaction check. An interrupted attempt on a release prerelease retains that same minimum for the evidence that is available.

The evidence package is the adjudication input and must satisfy one bar: an independent judge with no run memory reaches the same product verdict from the story and the package alone. It always contains the verbatim actor prompt and the artifacts named by `Evidence To Collect`. Each agent-first run also records four non-blocking scalars trended per story revision: actor tool calls, error-recovery retries, guidance loaded beyond the story's declared minimum, and elapsed time.

The evidence package of a story run also contains the public-read snapshot from which the judge recomputed each deciding fact, the result of the product integrity check when that operation exists, the run's telemetry file, and native artifacts recorded by digest. Native artifacts include the actor transcript, browser traces, and logs. [L6 story reorganization](../decisions/20261012-l6_story_reorganization.md) records why the bundle has this shape.

The stage manager runs one stock OpenTelemetry Collector for each story run. The Collector writes OpenTelemetry Protocol JSON (OTLP/JSON) to the run's evidence directory and stops when the run ends, so its file covers that run only. The actor exports to that Collector. Deployment telemetry joins the run's file only when the deployment's own same-deployment Collector forwards it there. This specification does not change where the deployment sends OTLP. The actor's telemetry carries the story run identifier as a resource attribute.

Telemetry never decides an outcome predicate, a classification, or a verdict. A missing, partial, or contradictory telemetry file does not change the verdict. It only limits diagnosis. The independent-judge bar above applies without the telemetry file.

Telemetry carries no content. The actor's prompts, the actor transcript, and product content stay in native artifacts, which pass the redaction check. This keeps the bundle within [Operational Telemetry](20260731-operational_telemetry_standardization.md#data-safety), which prohibits content in telemetry and lets telemetry reference native artifacts only by digest.

`failed` and `inconclusive` runs retain the full redacted transcript and evidence package for one release cycle. `passed` runs retain the summary, plus the full package for a small sampled fraction kept one release cycle for re-adjudication and review calibration. On a release prerelease, that sample does not replace the complete private evidence that Release Management requires.

Real secrets, tokens, cookies, authorization headers, full credential files, and private account data MUST NOT appear in story files, command output, evidence, reports, CI artifacts, or committed fixtures. Opt-in real runs must reuse the existing credential and redaction owners.

Evidence directories are output locations, not databases or workflow owners. When the run is not on a release prerelease, a fresh run may delete or replace a partial evidence write. That write does not require a settlement record, an append protocol, or a recovery state machine. Before a fresh run on the same release prerelease starts, the earlier attempt's available redacted evidence is kept separately.

## Test And Release Policy

The story metadata parser and the story schema check — front matter fields, existing `contracts` references, and the normative body section list — receive focused L0/L1 coverage. This mechanical validation is separate from agent-first L6 execution, remains part of the ordinary repository gate, and supplies no L6 acceptance evidence.

L6 execution is opt-in and agent-first. A stage manager explicitly dispatches an admitted story under the execution model in this specification; ordinary L0/L1 validation does not dispatch or execute it. Real-provider or real-worker dependencies remain explicit properties of that run and reuse their existing credential, redaction, supervision, and cleanup owners.

Skipped, environment-failed, and unexecuted stories are not acceptance evidence. When an owning release policy or current release record designates an opt-in real-provider or real-worker story as applicable, that L6 gate contribution is satisfied only when the story actually executed and passed in that cycle; a missing capability or skipped run leaves it unmet rather than silently green. This specification owns the current catalog. [Release Management](20260829-release_management.md) owns when that catalog runs.

## Current Implementation

Story artifacts live under `tests/stories/`. The committed stories declare their owning contracts, and `scripts/validate-story-schema.mjs` mechanically validates the closed front matter field set, contract-reference existence, repository-unique story ids, and normative body section list inside `check:repo`; focused parser coverage lives in `tests/story-metadata.test.mjs`. These L0/L1 checks validate artifacts without executing L6.

The five former mechanical story proofs now run from the L3 and L4 entrypoints and gates owned by `docs/specs/20260529-test_strategy.md`. Their obsolete story documents and shared runner location have been removed.

The remaining admitted stories have no per-story executable or prescribed actor path. The schema check requires Intent, Starting World, Outcome Predicates, Perturbations, Integrity Invariants, and Failure Triage Notes. Setup, Required Opt-in Environment Variables, Evidence To Collect, and Cleanup may each appear once. The runner does not build an image or replace a container. Stage-manager, actor, and judge separation remains accepted execution design. Friction scalars and retention sampling are not yet implemented. The story-run Collector is not yet implemented.

No new cancellation, compression, credential-override, restart, recovery, or backend-specific L6 harness is accepted by this specification. A confirmed real integration failure is fixed in product code and leaves L6 under Reduction Handoff.

## Acceptance Predicates

- Two independent readers can identify the story's one user intent, supported entry point, required environment, and outcome predicates.
- The recorded actor prompt shows the actor task payload contained only the persona and the user ask, with no story content or discovery answers.
- An independent judge reproduces the product verdict from the story and the evidence package alone.
- Every outcome predicate names the evidence or product record that decides it.
- Story front matter declares owning contract documents that exist in the repository.
- Every outcome predicate in a committed story is satisfiable from the persona and the sole user ask. No per-story executable or fixed actor path exists; shared support preserves the context and public-surface boundaries.
- Every outcome predicate declares its channel and tier, every inside-out predicate names a product record with an owning specification, and no outcome predicate constrains the path by which its subject became true.
- Every required outcome predicate is reachable by an ask that states an objective without naming the mechanism, and an unwitnessed required outcome predicate yields `inconclusive` rather than a pass.
- Recorded friction and improvement suggestions are non-blocking findings, and neither enters the product verdict.
- The change record admitting or revising a story states the satisfiability argument in its acceptance observations.
- Each committed story is one `*.story.md`, either directly under `tests/stories/` or alone in one asset directory there, and that directory contains no committed executable.
- Every run role's central claim has a named falsifier, and the judge recomputed at least one value the stage manager claimed.
- A story requiring more than one run names one accumulating verifier that is not a per-run judge.
- No accepted specification names one story artifact as an exception to a rule it states generally.
- When one agent coordinates the repository change and stage-manages the run, its evidence claim was falsified by a party it does not control, it did not verify its own accumulation, and it did not amend a contract to close a finding raised against it.
- Every non-blocking finding in a run record is linked to a change record or product issue, or explicitly waived with a reason.
- A run uses only declared public product surfaces during the actor's attempt.
- The executor reuses existing transport, process, credential, redaction, timeout, cleanup, and evidence owners.
- Unavailable optional infrastructure yields a typed non-product result rather than a fabricated product pass or new recovery system.
- A confirmed product defect has a named L1-L5 regression owner, or a recorded reason why it is not reducible.
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
- Whether judge-model rotation and seeded-defect adjudication calibration deserve a standing schedule once run volume grows.

These questions create no current implementation or test obligation. A future proposal must begin with evidence from repeated real runs and identify what existing owner cannot meet the need.

## Related Docs

- `docs/change-execution.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260710-self_improvement_evaluation_loop.md`
- `docs/specs/20261002-remote_mcp_interface.md`
- `docs/specs/20260731-operational_telemetry_standardization.md`
- `docs/specs/20260829-release_management.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `tests/stories/README.md`
- `README.md`
