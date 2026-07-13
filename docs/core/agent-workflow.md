# Agent Workflow Model

Status: Accepted

This document owns the Core workflow mechanisms used to coordinate worker-agent work.

This document does not own user-facing work vocabulary, agent runtime substrate, agent session continuity, agent supply, agent capability routing, protocol record schemas, channel-specific Agent Skill Interface behavior, Skill implementation, App API endpoints, storage schemas, UI components, or agent-private task graphs.

`Agent Workflow` is the Core-owned mechanism layer for composing planned, bounded, reviewable, resumable worker-agent work.

## Purpose

OpenKit should not force every workspace, user, Skill, automation, or future product surface into one fixed workflow.

Core should instead provide stable workflow mechanisms that can be composed into different workflow modes and recipes.

Those mechanisms let OpenKit move from intent or objective to planning, bounded worker execution, human attention, review, retry, refinement, acceptance, stop, and closeout without introducing a vague `TaskRun` layer or hiding product state inside agent-private loops.

The default workflow backbone remains:

```text
Workspace -> Thread -> Turn -> Item[]
```

Agent workflow organizes that backbone into reusable mechanisms.

Goal Mode and the accepted unified `openkit` Skill's loop recipe are OpenKit's default workflow setup over those mechanisms. They are optimized for low-configuration, reviewable worker-agent work, but they are not the only valid workflow shape.

## Principles

- Mechanisms come first, modes come second. Core should stabilize primitives that many workflows can reuse before treating one product mode as canonical.
- Core owns workflow truth. Worker agents may execute work, and channels may operate the workflow, but durable workflow state belongs to Core.
- Default setup is not a universal model. Goal Mode, one-step loops, Action Center projections, artifacts, and evidence bundles form the current recommended setup, not the definition of all agent workflows.
- Keep the default backbone small. Use workspace, thread, turn, item, artifact, approval, and agent session records before promoting richer workflow objects.
- Move work forward in bounded, reviewable steps. A worker step should produce observable items, artifacts, evidence, pending human attention, or a terminal state before the next step begins.
- Keep human decisions explicit. Plan approval, user input, sensitive action approval, review, retry, refinement, acceptance, and stop decisions must be visible and auditable.
- Treat channels as projections. Web UI, the unified end-user Agent Skill Interface, desktop apps, automations, and future integrations may operate the same workflow mechanisms, but they do not redefine them.
- Keep agent-private loops private until Core needs them. Tool retries, model self-reflection, private planner traces, and runtime-native task graphs should not become core records unless Core must schedule, retry, show, approve, audit, or attach artifacts to them.
- Make graph semantics earned. Dependencies, attempts, branches, joins, and lineage should be promoted only after real workflows require them beyond item causality and normal turn structure.
- Avoid a `Core Agent` concept by default. Workflow orchestration is a Core responsibility, not a separate canonical agent unless a future design proves that abstraction is necessary.

## Canonical Terms

`Agent Workflow` is the Core-owned mechanism layer for composing planned, bounded, reviewable worker-agent work inside a workspace and thread.

`Workflow Mechanism` is a reusable Core primitive for workflow composition, such as intent, objective, phase, plan, bounded step, gate, decision, evidence, checkpoint, context compaction, handoff, retry, refinement, branch, join, or lineage.

`Workflow Mode` is a named composition of workflow mechanisms for a recognizable way of doing work.

`Workflow Recipe` is an operational sequence or template that guides how a workflow mode should be used.

`Default Workflow Setup` is OpenKit's built-in low-configuration composition for reviewable worker-agent work.

`Intent` is the user, system, automation, or integration input that starts or steers work.

`Objective` is the desired outcome that gives a workflow direction and a stop condition.

`Phase` is a named workflow segment such as planning, execution, review, recovery, refinement, or closeout.

`Plan` is a reviewable proposed path for satisfying an objective.

`Planning Phase` is the part of an agent workflow where Core, a coordinator, a planner, or a worker proposes or updates a plan before execution continues.

`Plan Approval` is the human or policy decision that authorizes a plan to move into worker execution.

`Bounded Step` is one Core-authorized unit of worker-agent progress that must return control to Core with observable state before another step is run.

`Workflow Loop` is the repeated operating pattern of reading state, deciding the next allowed action, running at most one bounded step, collecting evidence, surfacing gates, and deciding whether to continue, retry, refine, accept, or stop.

`Gate` is a workflow pause that requires a decision before work can continue safely.

`Human Attention Gate` is a gate that requires a human decision, answer, review, approval, or recovery choice.

`Review Gate` is a gate where work output, artifacts, evidence, or a plan is evaluated before acceptance or continuation.

`Decision` is a recorded choice that changes what the workflow may do next.

`Checkpoint` is a resumable workflow point that records enough state to continue, recover, retry, or explain the current position.

`Context Compaction` is the workflow mechanism for reducing prior history, workflow state, selected knowledge, evidence, and constraints into a smaller resumable or worker-usable context representation.

`Stop Condition` is the explicit condition that determines when a workflow is complete, blocked, rejected, or intentionally paused.

`Workflow Evidence` is the item-backed, artifact-backed, audit-backed, or external-check-backed material used to decide whether the workflow may continue or close.

`Goal Mode` is the current built-in workflow mode for objective-driven, reviewable worker-agent work.

`Workflow Graph` is a future optional structure for representing dependencies, attempts, branches, joins, lineage, evaluation, and retry semantics when the default thread, turn, and item structure is not expressive enough.

`Attempt`, `Dependency`, `Branch`, `Join`, and `Lineage` are candidate graph terms. They are not default protocol objects until promoted by a later accepted design.

## Boundaries And Non-Goals

Agent workflow owns:

- reusable workflow mechanisms for Core-led worker-agent work
- workflow mode and recipe composition boundaries
- default workflow setup semantics
- planning, plan approval, bounded step, gate, decision, evidence, checkpoint, context compaction, handoff, retry, refinement, stop, and closeout semantics
- the relationship between workflow mechanisms, current Goal Mode, the unified Agent Skill loop recipe, worker execution, artifacts, evidence, and review
- the boundary for future dynamic workflow and graph semantics
- the rule that prevents premature `TaskRun`-style core concepts

Agent workflow does not own:

- user-facing task vocabulary, which belongs to `work-model.md`
- agent, runtime, turn assignment, and runtime lifecycle semantics, which belong to `runtime-model.md`
- agent session continuity, snapshots, resume, fork, clone, rollback, and recovery, which belong to `agent-session.md`
- agent catalogs, setup contracts, and profile supply, which belong to `agent-supply.md`
- LLM, MCP, tool, network, credential, context, usage, and rate-limit supply for worker agents, which belongs to `agent-capability.md`
- protocol schemas, commands, events, and lifecycle enum definitions, which belong to `protocol.md` and `communication.md`
- Action Center response fields, channel operation arguments, Skill file contents, Web UI components, database tables, or route paths
- agent-private planning, hidden chain-of-thought, tool retry traces, runtime-native task graphs, or provider-native workflow representations
- a single mandatory workflow shape that every user or workspace must follow

## Mechanism Layer

Use existing records first:

- thread for durable work container
- turn for agent-bound execution unit
- item for observable history
- artifact for durable outputs
- approval request for human decisions
- agent session for runtime continuity

The reusable mechanism flow is:

```text
intent or objective
  -> workflow mode or recipe
  -> phase
  -> plan or direct step
  -> gate or decision when required
  -> bounded worker step
  -> items, artifacts, evidence, audit projections
  -> checkpoint or context compaction when needed
  -> continue, refine, retry, handoff, branch, join, pause, block, accept, or close
```

A workflow mode may use all of these mechanisms or only a subset. A small workflow may skip explicit planning. A high-risk workflow may require plan approval, review gates, evidence collection, and explicit closeout.

## Internal Role Collaboration

Agent Workflow coordinates internal Core roles without turning those roles into user-selectable worker agents.

`architecture.md` owns the internal role definitions for Core Assistant, Workflow Coordinator, Knowledge Manager, and the future Task Evaluator.

The Core Assistant may handle quick replies, clarification, simple state reads, and triage. When the request becomes non-trivial worker-agent work, it should hand the workflow to the Workflow Coordinator instead of directly calling worker agents.

The Workflow Coordinator owns workflow progression. It selects the workflow mode or recipe, prepares or updates plans when needed, advances bounded steps, chooses worker agents, composes the final worker prompt and worker context, handles gates, collects evidence, and decides whether the workflow should continue, refine, retry, hand off, pause, block, accept, or close.

The Knowledge Manager owns knowledge retrieval support and knowledge maintenance. Before a bounded step, the Workflow Coordinator may ask the Knowledge Manager for relevant knowledge or source material. The Knowledge Manager returns source-traceable material, exclusions, uncertainty, or proposals. The Workflow Coordinator decides how to package that material into the worker context.

During worker execution, worker agents may request additional knowledge through Core-governed capability and knowledge boundaries. Those requests should route to the Knowledge Manager or a Knowledge Manager-backed service rather than letting the worker read the Knowledge Store directly.

`Context Package` is a data projection owned by `knowledge.md` and projected into workflow. It is not a separate internal agent. The Knowledge Manager prepares knowledge-derived material for the package, while the Workflow Coordinator assembles the final worker context for the specific step.

The future Task Evaluator may review task outcomes, workflow or Skill updates, test evidence, verification results, and measured improvement before changes are accepted. Until its evaluation model is designed, it remains a placeholder role rather than a required workflow mechanism.

## Workflow Modes And Recipes

A workflow mode is a named composition of mechanisms.

OpenKit may provide built-in modes, and future workspaces, Skills, automations, or templates may define their own modes when the authoring model is stable.

A workflow recipe is the operating playbook for a mode. It may define the expected phase order, default gates, required evidence, retry policy, review policy, stop condition, and channel guidance.

Modes and recipes must not bypass Core ownership. They should compose stable mechanisms rather than inventing private product state.

## Default Workflow Setup

The current default workflow setup is:

```text
Goal Mode
  + planning and plan approval when useful
  + one bounded worker step at a time
  + Action Center projections for human attention
  + artifacts and evidence bundles for review
  + the unified openkit Skill loop recipe for low-configuration operation
```

This setup is recommended when the user wants reviewable worker-agent work without custom workflow configuration.

It is not the only workflow Core can support.

Future workflows may use the same mechanisms for research workflows, maintenance workflows, batch workflows, multi-agent review workflows, automation workflows, or user-defined workspace workflows.

## Goal Mode Projection

Goal Mode is the current built-in workflow mode over Agent Workflow mechanisms.

It binds a thread to an objective, optional planning, bounded steps, review state, evidence, human attention, and terminal status.

Goal Mode must not become a hidden autonomous loop. It should advance through explicit gates, bounded worker steps, visible review state, and human decisions.

Goal Mode may be operated by Web UI, the unified end-user Agent Skill Interface, desktop channels, automations, or future integrations, but NanoCore remains the source of truth for Goal Mode state.

## Chat And Task Modes

Chat Mode and Task Mode are product or channel projections over workflow decisions. `work-model.md` owns their user-facing meaning.

Chat Mode is the quick-reply path. It may be handled by the Core Assistant when the request only needs lightweight response, clarification, or state lookup.

Task Mode is a non-trivial work path. It should route to a Workflow Coordinator, choose a workflow mode or recipe, and use bounded worker steps when worker-agent execution is required.

Core should keep the routing decision explicit enough to explain why a request stayed in quick reply or moved into worker-agent workflow.

## Planning

Planning is a mechanism, not a mandatory global mode.

A workflow mode may require a planning phase, skip planning for trivial work, or use planning only after the workflow becomes risky or ambiguous.

Product or channel surfaces may call a planning-heavy interaction Plan Mode when it helps users understand the experience, but `Planning Phase` is the stable core concept unless a later design promotes Plan Mode as a separate workflow mode.

Planning may ask the user questions, present alternatives, request scope clarification, estimate risk, or propose step boundaries.

Planning should be reviewable when it controls non-trivial work.

## Context Compaction And Handoff

Context compaction is a workflow mechanism for continuing work without carrying the entire raw thread, runtime state, or source material forward.

It may be useful before long-running continuation, handoff, retry, recovery, branch comparison, worker restart, or context-limited execution.

Context compaction must preserve traceability to the underlying thread items, artifacts, evidence, knowledge pages, source references, decisions, and checkpoints that justify the compacted context.

When compaction captures runtime continuity, `agent-session.md` owns the session and resume boundary.

When compaction promotes reusable learning, `knowledge.md` owns the resulting knowledge proposal or knowledge update.

When compaction prepares material for the next bounded step, the Workflow Coordinator owns final worker-context assembly, with Knowledge Manager support for knowledge-derived material.

Handoff is a workflow mechanism for moving work from one agent, profile, role, mode, or channel to another while preserving history and decision traceability.

A handoff should be item-backed, checkpoint-aware, and explicit about what context, evidence, constraints, and pending gates move forward.

## Bounded Worker Steps

A bounded step is the unit of worker-agent progress that Core authorizes inside an agent workflow.

A bounded step should have:

- workflow mode or recipe context
- objective or phase context
- selected agent supply and runtime setup
- effective capability and permission constraints
- a clear step objective
- a maximum scope, budget, or stop condition
- expected evidence or artifact output when applicable
- a return path to Core with status and observations

A bounded step must not hide an unbounded worker loop behind one product action.

After a bounded step, Core should read the resulting items, artifacts, evidence, pending gates, audit projections, and checkpoint state before another step is run.

## Gates, Decisions, And Evidence

Gates are part of workflow composition.

An agent workflow may pause for:

- plan approval
- sensitive action approval
- user input or clarification
- artifact review
- workflow or mode-specific review
- budget or quota decision
- recovery choice after failure
- acceptance, rejection, retry, or refinement

Action Center is an App API and product-surface projection over pending human attention. It should not become the canonical workflow store.

The canonical workflow state remains item-backed, objective-backed, approval-backed, artifact-backed, review-backed, evidence-backed, checkpoint-backed, and audit-backed records owned by Core.

## Agent Skill Loop Projection

The unified end-user `openkit` Skill and its bundled CLI can operate Agent Workflow mechanisms through governed public NanoCore contracts.

The Skill may provide setup guidance, safe workflow policy, operation ordering, review expectations, and recovery playbooks through progressive disclosure.

They do not own workflow state and must not bypass Core-owned workflow mechanisms, approval gates, user-input gates, artifacts, evidence, repository readiness, human decisions, or App API Action Center projections.

The bundled CLI is a deterministic channel facade over public Core or App API contracts. It is separate from planned worker-side MCP capability supply, which belongs to Agent Capability.

The Skill's loop guidance is a workflow recipe for the default setup. It should drive one bounded step at a time, read workflow state after each step, present evidence, and ask the human before continuing when a gate or external side effect is involved.

## Dynamic Workflow And Graph Semantics

The default model should not introduce a workflow graph when item causality and turn structure are enough.

A future workflow graph may be justified when Core must represent:

- dependencies between multiple turns
- multiple attempts for one planned operation
- parallel branches that later merge
- explicit implementation-review pipelines
- scheduled or cron-derived recurring work
- reproducible retry lineage
- artifact provenance across many turns
- evaluation loops that compare competing attempts
- cross-thread or cross-workspace lineage
- dynamically authored workflow templates or repeatable workflow recipes

These requirements should be proven by product or runtime behavior before becoming stable core schema.

If promoted later, a workflow graph should organize or reference objectives, phases, steps, gates, decisions, turns, items, artifacts, approvals, reviews, evidence, checkpoints, agent sessions, and audit projections. It should not replace the item log.

Product surfaces may render graph views, but the graph should remain derivable or auditable through stable history.

## Relationship To TaskRun

OpenKit does not use `TaskRun` as a default core concept.

Agent-private task graphs should stay private unless Core needs to schedule, retry, show, approve, audit, or attach artifacts to them.

If a future graph is promoted, it should be designed around explicit workflow and graph semantics rather than reintroducing a vague task-run layer.

## Invariants

- Agent Workflow MUST preserve the `Workspace -> Thread -> Turn -> Item[]` backbone unless a later core revision explicitly replaces it.
- Core MUST remain the source of truth for workflow mechanisms, workflow mode state, gates, decisions, checkpoints, artifacts, evidence, and terminal workflow decisions.
- A workflow mode MUST compose Core-owned mechanisms instead of making channel-local or agent-private state the product source of truth.
- The default workflow setup MUST NOT be treated as the only valid workflow shape.
- The Core Assistant MUST NOT directly call worker agents for non-trivial work; it should route that work to the Workflow Coordinator.
- The Workflow Coordinator MUST NOT bypass the Knowledge Manager or Core-governed knowledge boundary when worker context needs reusable knowledge.
- The Knowledge Manager MUST NOT own the whole task workflow or silently update high-impact knowledge without the required review gate.
- Worker agents MUST NOT read the Knowledge Store directly; they should request knowledge through Core-governed capability and knowledge boundaries.
- Context packages MUST remain data projections, not internal agent roles.
- A channel MUST NOT advance workflow state by mutating worker runtime internals, storage internals, or agent-private state directly.
- A worker agent MUST NOT be treated as the canonical owner of workflow state merely because it executed a step.
- A bounded step MUST return observable status to Core before the next bounded step is run.
- Human decisions MUST be represented through visible workflow state, approval records, user-input records, review records, or other promoted human-attention projections.
- Agent-private graphs, traces, retries, and hidden reasoning MUST NOT become core records unless Core needs them for scheduling, retry, visibility, approval, audit, artifact lineage, or recovery.
- A future workflow graph MUST reference or organize stable core records instead of replacing item history.

## Relationships To Other Core Aspects

`work-model.md` explains how users understand work, review, steering, redo, refinement, and deliverables.

`runtime-model.md` explains agents, profiles, runtimes, turns, and runtime lifecycle.

`agent-session.md` explains runtime continuity for initialized agent execution.

`agent-supply.md` explains which agents, profiles, and setup contracts are available for a workflow.

`agent-capability.md` explains the capability supply used by worker agents during bounded steps.

`knowledge.md` explains Knowledge Manager responsibilities and context package semantics.

`protocol.md` and `communication.md` define the stable records, commands, events, and communication semantics that project workflow changes.

`permissions.md`, `sandbox.md`, and `vault.md` define important constraints that workflow orchestration must respect.

`audit.md` defines durable projections that explain workflow-relevant events after the fact.

## Default Setup Projection

The built-in default setup may combine Goal Mode, optional plan review, bounded worker steps, Action Center projections, artifacts, evidence bundles, workspace review and apply records, and end-user Agent Skill loop operation.

That setup is a recommended composition of Core workflow mechanisms, not the definition of Agent Workflow itself.

User-defined workflow modes, workflow recipes, and workflow graph semantics should be promoted only after real workflows prove the need.

Use thread, turn, item, artifact, approval, agent session, goal, review, and evidence records where they already express the workflow. Keep richer workflow mechanisms and graph concepts in reserve until they remove real ambiguity.

Workflow mechanisms become stable protocol records only when App API projections cannot preserve ordering, recovery, audit, or interoperability semantics.

User-defined workflow modes, recipes, templates, workflow graphs, Task Evaluator behavior, and cross-thread or cross-workspace workflow lineage are not core primitives until promoted by a stable core update.
