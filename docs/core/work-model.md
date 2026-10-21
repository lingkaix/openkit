---
status: Accepted
---
# Work Model

This document owns how OpenKit work appears to users and product surfaces and the Core workflow mechanisms used to coordinate worker-agent work.

It projects the canonical Core model without redefining root concepts, protocol records, App API shapes, UI components, storage, runtime behavior, or agent-native protocols. This document does not own agent runtime substrate, AgentSession continuity, agent supply, agent capability routing, protocol record schemas, channel-specific remote MCP interface behavior, Skill implementation, App API endpoints, storage schemas, or agent-private task graphs. The Internal Agent Runtime specification owns the role-agnostic bounded internal Agent runtime, while this document owns only the durable workflow mechanisms composed around it.

`Agent Workflow` is the Core-owned mechanism layer for composing planned, bounded, reviewable, resumable worker-agent work.

## Purpose

OpenKit is a workspace for delegating real work to agents.

Users should be able to ask quick questions, delegate bounded tasks or durable goals, watch progress, intervene through explicit human-attention modes, collaborate precisely against work resources, and preserve useful outputs and knowledge.

OpenKit should not force every workspace, user, Skill, automation, or future product surface into one fixed workflow.

Core should instead provide stable workflow mechanisms that can be composed into different workflow modes and recipes.

Those mechanisms let OpenKit move from intent or objective to planning, bounded worker execution, human attention, review, retry, refinement, acceptance, stop, and closeout without introducing a vague `TaskRun` layer or hiding product state inside agent-private loops.

The work model uses the same backbone as the core protocol:

```text
Workspace -> Thread -> Turn -> Item[]
```

Agent workflow organizes that backbone into reusable mechanisms.

Goal Mode is OpenKit's default workflow setup over those mechanisms: the person keeps the intent, one approved Plan version authorizes the work, and the Coordinator admits ordinary Tasks. Remote MCP's loop recipe remains a low-configuration channel over those same operations and does not advance a Goal by a step. That setup is optimized for low-configuration, reviewable worker-agent work, but it is not the only valid workflow shape. [Architecture](architecture.md#app-and-channel) owns the App and Channel boundary, including remote MCP over the same operations and the operator CLI as the administrator channel.

## Principles

- Delegation is the default posture, precise collaboration is available on demand, and governance remains visible throughout.
- Product surfaces should make work understandable without requiring users to understand AgentSessions, runtime handles, storage layout, or adapter internals.
- Product-facing terms such as task, job, goal, deliverable, review, redo, and refinement must map to their owning durable records instead of creating parallel truth.
- The thread narrative and ordered Item history remain the user-visible source of truth even when surfaces group, summarize, or highlight work.
- Quick reply, delegated work, long-running goals, grounded collaboration, and human attention must preserve the same Core backbone.
- An explicit interruption or uncertain external outcome is a legitimate work state when Core cannot safely prove continuation or completion. The product should preserve prior history, explain what is known, and offer only the inspect or new-attempt actions authorized by the owning workflow.
- Mechanisms come first, modes come second. Core should stabilize primitives that many workflows can reuse before treating one product mode as canonical.
- Core owns workflow truth. Worker agents may execute work, and channels may operate the workflow, but durable workflow state belongs to Core.
- Default setup is not a universal model. Goal Mode, one-step loops, Action Center projections, artifacts, and evidence bundles form the current recommended setup, not the definition of all agent workflows.
- Keep the default backbone small. Use workspace, thread, turn, item, artifact, approval, and AgentSession records before promoting richer workflow objects.
- Move work forward in bounded, reviewable steps. A worker step should produce observable items, artifacts, evidence, pending human attention, or a terminal state before the next step begins.
- Deliver the accepted worker request itself. A Turn-owned worker input must preserve the exact Coordinator-composed request; routing summaries, dashboard projections, context summaries, and checkpoints cannot substitute for that request or prove its delivery.
- Keep human decisions explicit. Plan approval, user input, sensitive action approval, review, retry, refinement, acceptance, and stop decisions must be visible and auditable.
- Treat channels as projections. Web UI, remote MCP over the same operations, the operator CLI as the administrator channel, desktop apps, automations, and future integrations may operate the same workflow mechanisms, but they do not redefine them.
- Keep agent-private loops private until Core needs them. Tool retries, model self-reflection, private planner traces, and runtime-native task graphs should not become core records unless Core must schedule, retry, show, approve, audit, or attach artifacts to them.
- Avoid a `Core Agent` concept by default. Workflow orchestration is a Core responsibility, not a separate canonical agent unless a future design proves that abstraction is necessary.
- Delegated work is a tree, not a mesh ([decision](../decisions/20260929-delegated_work_is_a_tree.md)). Threads are its nodes and delegations its edges. Control, such as dispatching work, answering a pending request, or cancelling, flows only between a parent and its child through Core. Each scope has one orchestrator, which today is a person in Task Mode. Worker execution is always a leaf: a worker cannot spawn Threads, start other workers, or control a sibling. Read-only views of peers create no control edge.

## Canonical Terms

`Agent Workflow` is the Core-owned mechanism layer for composing planned, bounded, reviewable worker-agent work inside a workspace and thread.

`Workflow Mechanism` is a reusable Core primitive for workflow composition, such as intent, objective, phase, plan, bounded step, gate, decision, evidence, checkpoint, context compaction, handoff, retry, or refinement.

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

`Workflow Evidence` is the item-backed, artifact-backed, review-backed, checkpoint-backed, or external-check-backed material used to decide whether the workflow may continue or close. Audit may project or reference that evidence, but an audit row does not authorize progression, recovery, or terminalization.

`Goal Mode` is defined in [Product Modes](#product-modes). See [Default Workflow Setup](#default-workflow-setup) for the current built-in setup.

## Boundaries And Non-Goals

This document owns:

- user-facing work vocabulary, product modes, human-attention modes, grounded collaboration, deliverables, and active/long-running work semantics
- reusable workflow mechanisms for Core-led worker-agent work
- workflow mode and recipe composition boundaries
- default workflow setup semantics
- planning and the human approval of one exact Plan version as workflow mechanisms, ordinary bounded Tasks, gate, decision, evidence, checkpoint, context compaction, handoff, retry, refinement, stop, and closeout semantics. This document does not own the Goal record or the person's approval record.
- the relationship between workflow mechanisms, current Goal Mode, the remote MCP guide loop recipe as a channel that does not advance a Goal by a step, worker execution, artifacts, evidence, and review
- the rule that prevents premature `TaskRun`-style core concepts
- the concept-level meanings of `Judgement` and `Candidate Set` as the human ground truth for improvement

This document does not own:

- agent, runtime, turn assignment, and runtime lifecycle semantics, which belong to `runtime-model.md`
- current AgentSession continuity, exact reconnect, interruption, and fresh-session fallback, which belong to `agent-session.md`
- agent catalogs, setup contracts, and profile supply, which belong to `agent-supply.md`
- LLM, MCP, tool, network, credential, context, usage, and rate-limit supply for worker agents, which belongs to `mediation.md`
- protocol schemas, commands, events, and lifecycle enum definitions, which belong to `protocol.md` and `communication.md`
- Action Center response fields, channel operation arguments, Skill file contents, Web UI components, database tables, or route paths
- agent-private planning, hidden chain-of-thought, tool retry traces, runtime-native task graphs, or provider-native workflow representations
- a single mandatory workflow shape that every user or workspace must follow

## Product Projection

Core Concepts owns the canonical meanings of Workspace, Thread, Turn, Item, Artifact, ApprovalRequest, Channel, and TriggerSource. Product surfaces project them as follows:

- Workspace establishes the current work scope, defaults, authority, and visible resources.
- Thread is the durable narrative for resuming, reviewing, searching, and explaining related work.
- Turns make execution progress and boundaries understandable without exposing runtime internals.
- Items supply the ordered history from which visible messages, status, decisions, reviews, and outputs are projected.

A product projection may summarize or reorganize these records, but it must preserve their identity, order, lineage, and owning authority.

Server work can use a Server-owned Thread under [Core Concepts](core-concepts.md#thread). Its narrative, Turns and Items retain the same product meaning. It does not appear as work owned by a Workspace.

Product surfaces present parallel work as related execution Threads linked from the originating or Coordinator Thread. They keep worker Items in the execution narrative that produced them instead of interleaving several agents' work into one conversation, while still making status, results, evidence, and navigation understandable from the parent surface.

## Mechanism Layer

Use existing records first:

- thread for durable work container
- turn for agent-bound execution unit
- item for observable history
- artifact for durable outputs
- approval request for human decisions
- AgentSession for runtime continuity

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
  -> continue, refine, retry, handoff, pause, block, accept, or close
```

A workflow mode may use all of these mechanisms or only a subset. A small workflow may skip explicit planning. A high-risk workflow may require plan approval, review gates, evidence collection, and explicit closeout.

## Relationship To TaskRun

OpenKit does not use `TaskRun` as a default core concept.

Agent-private task graphs should stay private unless Core needs to schedule, retry, show, approve, audit, or attach artifacts to them.

## Personal Workspace

Each User receives a default personal Workspace. It is an ordinary Workspace with Task, Goal, Artifact, Sandbox, repository, and data-source capability under their existing owners. It cannot add members. User Memory belongs to the User independently of that Workspace. Existing Quick Chat data moves one way into the personal Workspace; the former capability restrictions end ([decision](../decisions/20261015-private_assistant_timeline_and_rolling_context.md)).

Exact kinds, provisioning, migration, and client selection belong to implementation-facing contracts.

## Personal Assistant And Shared Work

Core Assistant is the user's Personal Assistant across eligible work contexts. It uses shared internal runtime machinery while maintaining private conversation and personally owned Memory. Workspace capabilities, configuration and information remain governed resources selected on demand; personalization does not widen authority.

Each `(User, Workspace)` has one private Assistant Timeline. Users cannot create additional private chat Threads. Management dialogue retains its separate private entry. Task and Goal narratives are Workspace-shared, including their execution Threads and eligible results. A private project Thread remains Workspace-owned with a narrower audience; persistent personal Memory is independently User-owned. Other members do not gain private conversation access merely through Workspace membership. A currently usable administrator credential is eligible under the administrator eligibility rule in `docs/core/policy.md`.

Users may explicitly publish selected personal conversation material to a shared discussion or formal task. Handoff identifies the receiving Workspace and exact disclosed brief/inputs; private history, personal Memory and hidden provider context are not implicitly copied. Shared effects and their eligible audit remain visible according to their resource owner, without publishing the private discussion. A shared card never delegates the original caller's privileges to its reader. Visibility and notification prominence are separate: full shared work can remain inspectable while attention surfaces emphasize decisions, progress and outcomes.

Chat has no special result-card mechanism or proactive completion response. The Assistant dispatches requested work and answers status/result questions when the User asks. Existing Thread and Item projections expose that work ([decision](../decisions/20261015-private_assistant_timeline_and_rolling_context.md)).

After `v0.1.0` and the private Timeline, team Workspaces may offer directly created shared Chat Threads. The Core Assistant is their only agent and acts as a Workspace role, without personal Memory, private Timeline input, or administration Tools. Each shared conversation has its own rolling context and uses the addressing member's authority. Whole-audience source admission and linked Task/Goal handoffs retain their existing boundaries ([decision](../decisions/20261015-shared_conversation_and_single_agent_threads.md)).

## Internal Role Collaboration

Agent Workflow coordinates internal Core roles without turning those roles into user-selectable worker agents.

`architecture.md` owns the internal role definitions for Core Assistant, Workflow Coordinator, Knowledge Manager, and the future Task Evaluator.

The Core Assistant may handle quick replies, clarification, simple state reads, and triage. When the request becomes bounded worker work, it should hand the workflow to the Workflow Coordinator instead of directly calling worker agents. When the request becomes a Goal, it calls the Goal owner's create operation.

The Assistant chooses conversational mode within its admitted authority. Workflow Coordinator retains conversational classification for undecided Chat; for trusted explicit Task delegation it selects an eligible worker and composes the exact request without semantic reclassification. The mode service derives entry intent from the operation or accepted handoff, never from prose, and validates and applies effects under the existing admission and safety owners. Workflow Coordinator does not own Goal truth, a Goal Plan, or a Goal stop. It does not persist mode state, execute progression effects, or materialize and deliver worker context. The owning workflow boundary performs those effects through Core-owned records and services.

The Knowledge Manager owns knowledge retrieval support and knowledge maintenance. Before a bounded step, the owning workflow boundary may ask the Knowledge Manager for relevant knowledge or source material and supply the authorized result to the Workflow Coordinator. The Knowledge Manager returns source-traceable material, exclusions, uncertainty, or proposals; the Coordinator owns semantic inclusion and composition, while the workflow boundary owns persistence, materialization, and delivery.

After the worker capability plane is implemented, worker agents may request additional knowledge through Core-governed capability and knowledge boundaries. Those future requests should route to the Knowledge Manager or a Knowledge Manager-backed service rather than letting the worker read the Knowledge Store directly. A selected Knowledge reference becomes worker-visible only when Core explicitly binds it into the worker input or a materialized Context Package; selection alone does not imply delivery.

`Context Package` is a data projection owned by `knowledge.md` and projected into workflow. It is not a separate Internal Core Role. The Knowledge Manager prepares knowledge-derived material, the Workflow Coordinator composes the semantic worker context for the specific step, and the owning workflow boundary persists, materializes, and delivers that context.

The future Task Evaluator may review task outcomes, workflow or Skill updates, test evidence, verification results, and measured improvement before changes are accepted. Until its evaluation model is designed, it remains a placeholder role rather than a required workflow mechanism.

## Product Modes

Product modes are user-facing projections over the same Core work backbone.

| Mode | Stable product boundary |
| --- | --- |
| Chat Mode | Immediate answers, clarification, and lightweight state lookup inside Core. It does not start worker execution unless an explicit visible handoff enters another mode. |
| Task Mode | Bounded, near-term delegated work with worker execution when needed. It does not require plan negotiation by default and escalates when work becomes multi-step, ambiguous, high-risk, multi-agent, or long-running. |
| Goal Mode | One continuous outcome. The person states the outcome and its work-intent cards, approves one exact Plan version, and accepts an evidence-backed completion. A Coordinator admits ordinary Tasks inside that version. The board is a projection. There is no invisible autonomous loop. |
| Plan Mode | A product label for planning-heavy interaction. It does not require every workflow to begin with a plan or create a separate runtime. |

Transitions between modes must remain visible in Thread history.

Task Mode is a non-trivial work path. It should route to a Workflow Coordinator and use bounded worker steps when worker-agent execution is required. A Task is its Thread and all of its Turns. A pending request's outcome, a later user message, or, when the Task was admitted under a Goal, an authorized Coordinator request, continues the same Task on a new Turn. Standalone Task Mode does not gain a loop.

Core should keep the routing decision explicit enough to explain why a request stayed in quick reply or moved into worker-agent workflow.

Goal Mode may be operated by Web UI, remote MCP over the same operations, the operator CLI as the administrator channel, desktop channels, automations, or future integrations, but NanoCore remains the source of truth for Goal state. None of these channels advances a Goal by a step.

The Goal is one continuous outcome, its work-intent cards, and immutable Plan versions. Existing Goal-owned data is removed with the new implementation. Records outside that ownership stay usable. [Goal Redesign Rulings](../decisions/20261002-goal_redesign_rulings.md) records the decision.

## Workflow Modes And Recipes

A workflow mode is a named composition of mechanisms.

OpenKit may provide built-in modes, and future workspaces, Skills, automations, or templates may define their own modes when the authoring model is stable.

A workflow recipe is the operating playbook for a mode. It may define the expected phase order, default gates, required evidence, retry policy, review policy, stop condition, and channel guidance.

Modes and recipes must not bypass Core ownership. They should compose stable mechanisms rather than inventing private product state.

## Default Workflow Setup

The current default workflow setup is:

```text
Goal Mode
  + one approved Plan version before the Coordinator admits Tasks
  + ordinary Tasks inside that version
  + Action Center projections for human attention
  + artifacts and evidence bundles
  + remote MCP guide as a low-configuration channel over the same operations, not a Goal step
```

This setup is recommended when the user wants reviewable worker-agent work without custom workflow configuration.

The built-in default setup combines one approved Plan version for a Goal, ordinary Tasks inside that version, Action Center projections, artifacts, evidence bundles, workspace review and apply records, and remote MCP guide and operation calls over those same mechanisms. Those calls do not advance a Goal by a step. Its channels follow the [App and Channel boundary](architecture.md#app-and-channel). Approving the Plan version does not require a separate approval of each Task. An additional editorial review of Plan wording may be optional, and it never substitutes for the exact Plan approval.

That setup is a recommended composition of Core workflow mechanisms, not the definition of Agent Workflow itself.

Future workflows may reuse these mechanisms only after an accepted specification names their owner, lifecycle, failure semantics, and verification. The examples of research, maintenance, batch, multi-agent review, automation, or user-defined workflows do not authorize new records, modes, runtimes, or product surfaces.

User-defined workflow modes and workflow recipes should be promoted only after real workflows prove the need.

Use thread, turn, item, artifact, approval, AgentSession, goal, review, and evidence records where they already express the workflow.

Workflow mechanisms become stable protocol records only when App API projections cannot preserve ordering, recovery, audit, or interoperability semantics.

User-defined workflow modes, recipes, templates, and Task Evaluator behavior are not core primitives until promoted by a stable core update.

## Remote MCP Loop Projection

Remote MCP and the administrator CLI can operate Agent Workflow mechanisms through governed public NanoCore contracts.

The remote MCP guide provides setup guidance, safe workflow policy, operation ordering, review expectations, and recovery playbooks alongside bounded operation discovery.

They do not own workflow state and must not bypass Core-owned workflow mechanisms, approval gates, user-input gates, artifacts, evidence, repository readiness when a Git source is selected, human decisions, or App API Action Center projections.

The bundled CLI is a deterministic channel facade over public Core or App API contracts. It is separate from planned worker-side MCP capability supply, which belongs to Mediation.

The remote MCP guide's loop guidance is a workflow recipe for worker work in the default setup. It should drive one bounded worker step at a time, read workflow state after each step, present evidence, and ask the human before continuing when a gate or external side effect is involved. It does not advance a Goal by a step.

## Planning

Planning is a mechanism, not a mandatory global mode.

A workflow mode may require a planning phase, skip planning for trivial work, or use planning only after the workflow becomes risky or ambiguous.

Product or channel surfaces may call a planning-heavy interaction Plan Mode when it helps users understand the experience, but `Planning Phase` is the stable core concept unless a later design promotes Plan Mode as a separate workflow mode.

Planning may ask the user questions, present alternatives, request scope clarification, estimate risk, or propose step boundaries.

Planning should be reviewable when it controls non-trivial work.

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

## Active Work Semantics

| Product term | Stable product meaning |
| --- | --- |
| Steering | User direction during active work. The product must show the exact accepted or rejected outcome proved by the owning delivery contract; a projection must not claim delivery, interruption, or follow-up on its own. |
| Review | Evaluation by a user, another agent, or both. Review remains visible through normal Thread history, evidence, decisions, and outputs. |
| Redo | A replacement attempt that preserves the prior result and its history. |
| Refinement | A follow-up that keeps the prior result as context while requesting changes. |
| Handoff | A visible transfer of responsibility that explains why it happened, what context and constraints moved, and who or what acts next. |
| Context compact | A traceable summary used for continuation, handoff, retry, recovery, or worker execution without replacing its source history. |
| Interruption | A truthful stop when execution or its external outcome cannot be proved. It preserves the prior attempt and may require inspection or a new authorized Turn; it does not promise transparent resume or automatic repair. |

## Context Compaction And Handoff

Context compaction is a workflow mechanism for continuing work without carrying the entire raw thread, runtime state, or source material forward.

It may be useful before long-running continuation, handoff, retry, recovery, worker restart, or context-limited execution.

Context compaction must preserve traceability to the underlying thread items, artifacts, evidence, knowledge pages, source references, decisions, and checkpoints that justify the compacted context.

When compaction captures runtime continuity, `agent-session.md` owns the session and resume boundary.

When compaction promotes reusable learning, `knowledge.md` owns the resulting knowledge proposal or knowledge update.

When compaction prepares material for the next bounded step, the Workflow Coordinator owns semantic worker-context composition, the owning workflow boundary owns persistence, materialization, and delivery, and the Knowledge Manager supports knowledge-derived material.

Handoff is a workflow mechanism for moving work from one agent, profile, role, mode, or channel to another while preserving history and decision traceability.

A handoff should be item-backed, checkpoint-aware, and explicit about what context, evidence, constraints, and pending gates move forward.

## Long-Running Work

Long-running work must keep progress, pending attention, evidence, review state, and stop conditions visible without requiring users to understand runtime handles or backend snapshots.

Persistence and resumption must use owning durable records rather than hidden coordinator conversation memory or agent-private state.

When exact continuation cannot be proved, preserving an interrupted attempt and requiring a new authorized Turn is an acceptable product outcome. Retry must not overwrite the earlier attempt or imply that an uncertain external effect did not occur.

## Human Attention

Human attention is any state the product should surface because human authorization, information, correction, review, or awareness is useful.

OpenKit uses four composable product modes for human attention:

| Mode | Stable product meaning |
| --- | --- |
| Approval Gate | A pending authorization decision for safety, policy, budget, credential use, irreversible operations, or external side effects. The governed effect waits for it; the requesting work does not pause. |
| Elicitation Gate | A pending answer to a question, missing input, planning choice, or recovery choice. It is not authorization. |
| Steering Input | Non-terminal user input that corrects or extends active work only through a delivery contract accepted by the owning workflow. Unsupported active-work input is rejected rather than assigned an inferred delivery behavior. A Goal work-intent edit is recorded on the Goal and does not by itself change a running worker. |
| Review And Acceptance | Human or agent evaluation of plans, artifacts, diffs, knowledge proposals, evidence, or outcomes that may lead to acceptance, refinement, redo, rejection, deferral, escalation, or stop. |

Only Approval Gate and Elicitation Gate are pending human requests. Neither pauses a Turn or expires by time. A request is blocking only when the requesting agent ended its Turn while the request was outstanding and no later Turn has run, and its outcome reaches the agent on a later Turn, as `docs/core/protocol.md` defines. The four modes may compose without becoming four new Core objects or a parallel workflow engine.

Action Center is a product and App API projection over pending human attention across these modes. Plan approval and completion acceptance appear as pending requests. It helps users find required attention but must not replace Thread narrative, Item history, or the owning decision records.

Concrete gate fields, Item types, delivery policies, row kinds, actions, and API shapes belong to implementation-facing contracts.

## Gates, Decisions, And Evidence

Gates are part of workflow composition.

An agent workflow may wait for the following. A pending approval or user-input request makes the governed effect or the requesting agent wait, never the Turn that raised it:

- plan approval
- sensitive action approval
- user input or clarification
- artifact review
- workflow or mode-specific review
- budget or quota decision
- recovery choice after failure
- acceptance, rejection, retry, or refinement

The canonical workflow state remains item-backed, objective-backed, approval-backed, artifact-backed, review-backed, evidence-backed, and checkpoint-backed records owned by Core. Audit records are derived evidence projections and MUST NOT become workflow authority.

## Conversation And Grounded Collaboration

Conversation is the narrative and coordination layer. When a product surface knows the exact resource, revision or freshness point, location, candidate, or bounded value under discussion, it should preserve that grounding instead of forcing the user or agent to reconstruct it from prose.

A conversation composer may let the user choose an applicable internal Core role, Agent supply and profile, logical model preference, and referenced Artifact or uploaded resource before submission. Those are product selections over their existing owners: the composer is not a provider router, runtime scheduler, attachment store, AgentSession picker, or workflow authority.

Choosing an existing worker continues only the Thread that owns that worker's current AgentSession. Choosing new bounded worker work enters Task Mode and creates a linked Task execution Thread under the existing handoff rules. A product may label that action `New Shard + Worker`, but `Shard` is not a Core concept, durable object, identifier, or lifecycle.

Grounded interaction must flow through ordinary input, Steering Input, Review And Acceptance, Elicitation Gate, or Approval Gate. It must not create a global strong-interaction mode, universal Resource entity, universal Artifact model, or hidden feedback log.

Product terms such as compare, select, annotate, adjust, patch, accept, reject, and redo describe intent. Exact Work Resource Classes, payload envelopes, locators, revision handling, delivery receipts, conflict checks, and editor controls belong to implementation-facing contracts.

## Agent Visibility

Product surfaces may show the selected Agent, current work status, product-safe runtime availability, and effective capability and Sandbox summaries when those details help users understand responsibility or risk.

They offer two conversation actions: continue the current Thread or create a new Thread. AgentSession is hidden runtime continuity and MUST NOT appear as a picker, creation action, navigation object, identifier, history, or native handle.

Product surfaces must not expose raw adapter internals, process handles, provider payloads, secret-bearing diagnostics, or hidden Agent-private task graphs as normal user concepts.

## Artifacts And Deliverables

Product surfaces present an Artifact as a durable user-visible output that can be inspected, reused, exported, or referenced later. Artifact is an output role, not the universal identity for every editable material, source, external record, or piece of feedback.

When work creates or changes an Artifact, that mutation must be represented in ordered Item history and remain traceable to its Workspace, Thread, Turn, and Item lineage. Artifact indexes, read models, and byte stores must not become a competing work log.

A Workspace-only Artifact import or registration may omit an originating Thread and Turn only when it preserves explicit source and provenance. It must remain visibly imported or registered, must not masquerade as user or agent work output, and any later work-produced mutation must become Item-backed.

Deliverable, task, job, and goal are product-facing terms. A Deliverable normally projects one or more Artifacts plus Item-backed status or summary, and none of these labels creates parallel durable truth.

## Judgement And Candidate Set

Human judgement on exact outputs and candidate selection provide the v0.1.0 foundation for improvement through ordinary work.

A `Judgement` records one human assessment of one exact target. It retains the authenticated actor, server-recorded time, request identity, kind, choice and optional note. The closed kinds are `accept`, `reject`, `correct`, `select` and `rate`. A judgement is immutable after acceptance. A later judgement preserves the earlier assessment rather than editing it. A judgement does not independently accept a proposal, change content or authorize an effect.

A `Candidate Set` retains an ordered collection of at least two distinct exact Artifact-version references from one Workspace. Each reference includes its content digest. The set also retains its creator and creation time. Its identity and membership are immutable. A different membership creates a different set. A human selects one member through an attributable `select` judgement. Selection alone starts no work.

The Evaluation Foundation specification owns the judgement record and the candidate set with its attributable selection, and keeps the record detail.

## Invariants

- Product projections MUST preserve canonical identity, order, lineage, and owning authority; they MUST NOT independently accept, apply, recover, or terminalize work.
- A personal Workspace remains owner-only and cannot add members. Ordinary work capability follows its existing owners without the former Quick Chat restrictions.
- Chat Mode MUST NOT hide worker execution; entry into Task Mode or Goal Mode MUST be explicit in Thread history.
- Task Mode MUST remain bounded delegated work. Goal Mode MUST remain one durable outcome whose completion is a human decision.
- Parallel worker activity MUST appear as linked execution narratives rather than several agents writing inside one Thread.
- Product surfaces MUST express conversation continuity as continuing a Thread or creating a new Thread and MUST NOT expose AgentSession as a user-selectable conversation concept.
- Conversation target and logical-model controls MUST remain independent product selections and MUST NOT expose or derive Provider routes, account slots, AgentSessions, Harnesses, Sandboxes, RuntimeTargets, or native processes.
- A `New Shard + Worker` product action MUST project creation of a Task execution Thread and MUST NOT create a Shard record or parallel task lifecycle.
- Once a workflow accepts an immutable execution request, that accepted record MUST own every task-specific worker-request fact. A coordinator, channel, caller payload, default, or mutable projection MUST NOT replace or reconstruct those accepted facts.
- Human attention MUST use the four composable product modes without turning Action Center into a new authority.
- Grounded collaboration MUST preserve exact subject and version context through owning records without creating a hidden feedback log.
- Work-produced Artifact mutations MUST remain Item-backed. A Workspace-only import or registration MAY omit Thread and Turn lineage only with explicit provenance; its first introduction into a Thread and every later work-produced mutation MUST create exact Item-backed lineage.
- Redo and refinement MUST create new traceable work without mutating or deleting prior attempts; refinement MUST explicitly carry the selected prior result as context.
- Accepted Steering Input MUST have one current owning delivery path and an authoritative outcome. If immediate receipt or durable later delivery cannot be proven, the input MUST NOT be accepted as Steering Input or represented as delivered.
- Concurrent and replayed commands MUST remain bound to their originally accepted Workspace, Thread, subject, and work lineage; a newer current projection MUST NOT retarget them or create duplicate Turns, Items, decisions, or side effects.
- After acceptance, failure or restart MUST leave work durably pending, explicitly interrupted or uncertain, or terminal under its owning records; accepted input, decisions, lineage, and prior attempts MUST NOT be silently dropped, duplicated, or reconstructed from runtime memory or a latest-current projection. Automatic recovery is not required when a safe inspect or new-attempt path is explicit.
- A failed mutation MUST NOT leave partially applied or contradictory durable truth visible as authoritative.
- Review, handoff, and context compact MUST preserve traceability to prior Thread history and Artifacts.
- Agent Workflow MUST preserve the `Workspace -> Thread -> Turn -> Item[]` backbone unless a later core revision explicitly replaces it.
- Core MUST remain the source of truth for workflow mechanisms, workflow mode state, gates, decisions, checkpoints, artifacts, evidence, and terminal workflow decisions.
- A workflow mode MUST compose Core-owned mechanisms instead of making channel-local or agent-private state the product source of truth.
- The default workflow setup MUST NOT be treated as the only valid workflow shape.
- The Core Assistant MUST NOT directly call worker agents for non-trivial work; it should route that work to the Workflow Coordinator.
- Workflow execution MUST NOT bypass the Knowledge Manager or Core-governed knowledge boundary when worker context needs reusable knowledge.
- The Knowledge Manager MUST NOT own the whole task workflow or silently update high-impact knowledge without the required review gate.
- Worker agents MUST NOT read the Knowledge Store directly. Core MUST supply selected Knowledge through prepared context packages or, after the worker capability plane exists, through Core-governed capability and knowledge boundaries.
- Context packages MUST remain data projections, not Internal Core Roles.
- A channel MUST NOT advance workflow state by mutating worker runtime internals, storage internals, or agent-private state directly.
- A worker agent MUST NOT be treated as the canonical owner of workflow state merely because it executed a step.
- A bounded step MUST return observable status to Core before the next bounded step is run.
- A worker MUST NOT hold a control edge to another worker; control edges run only between a parent and its child through Core.
- Human decisions MUST be represented through visible workflow state, approval records, user-input records, review records, or other promoted human-attention projections.
- Agent-private graphs, traces, retries, and hidden reasoning MUST NOT become core records unless Core needs them for scheduling, retry, visibility, approval, audit, artifact lineage, or recovery.

## Relationships To Other Core Aspects

`runtime-model.md` explains agents, profiles, runtimes, turns, and runtime lifecycle.

`agent-session.md` explains runtime continuity for initialized agent execution.

`agent-supply.md` explains which agents, profiles, and setup contracts are available for a workflow.

`mediation.md` explains the capability supply used by worker agents during bounded steps.

`knowledge.md` explains Knowledge Manager responsibilities and context package semantics.

`protocol.md` and `communication.md` define the stable records, commands, events, and communication semantics that project workflow changes.

`policy.md`, `sandbox.md`, and `vault.md` define important constraints that workflow orchestration must respect.

`evidence.md` defines durable projections that explain workflow-relevant events after the fact.
