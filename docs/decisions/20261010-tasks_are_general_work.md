---
status: Accepted
date: "2026-10-10"
decider: Engineer
---
# Tasks Are General Work

## Decision

Tasks are general work. Make the whole direct-Task default set domain-neutral under [Task Mode](../specs/20260704-task_mode_worker_delegation.md), as an rc.1 blocker fix. Include all domain-neutral product wording and UI corrections in rc.1. The source-readiness qualification is amended in [Agent Workflow](../core/agent-workflow.md). At configuration time, truthfully refuse unsupported sources and name the supported source kinds under [Session Static Workspace Materialization](../specs/20260704-session_static_workspace_materialization.md). Leave Chat routing for the already planned full redesign; that later work must amend [Chat Mode](../specs/20260704-chat_mode_assistant.md). Make directory snapshot import and binary Artifacts the first post-release item; that later work must amend [Session Static Workspace Materialization](../specs/20260704-session_static_workspace_materialization.md) and the [Artifact owner](../specs/20260713-work_resource_interaction_model.md). A neutral Worker identity across Codex, Pi, OpenCode V2 and DeepSeek is post-release and must be disclosed in rc.1; that later work must amend the [Worker environment](../specs/20260721-worker_execution_environment_images.md) and [runtime communication](../specs/20260629-worker_runtime_communication_model.md) owners.

## Reason

The engineer challenged the software-specific defaults on 2026-10-10, quoted verbatim:

> 我认为这个固定条件是不是有问题？你要考虑到我们的这些 task 不仅仅只是软件开发的 task。如果我们来进行其他 task，比如，在整理法律文件，或者会计在整理invoice，这种情况，他们根本就不会使用Git，为什么还需要git repository 呢？

Faithful English translation: "I think there may be a problem with this fixed condition. You need to consider that our tasks are not only software development tasks. If we do other tasks, such as organizing legal documents or an accountant organizing invoices, they would not use Git at all. Why would they need a Git repository?"

Asked how far to change the defaults, the engineer chose, verbatim:

> 整组改成中性（推荐）

Faithful English translation: "Make the whole set neutral (recommended)."

The engineer then requested an audit beyond that file, quoted verbatim:

> 不仅仅是这个文件，你还需要检查一下我们的整个设计以及实现当中有没有依赖那些 Git 或者其他领域特有的服务的设计，比如说 Worktree、分支、Git 或者 GitHub Server 远程提供的特有服务，比如 issue、PR 等等等等。

Faithful English translation: "Not only this file: you also need to check our entire design and implementation for designs that depend on Git or other domain-specific services, such as worktrees, branches, Git, or specific services provided remotely by GitHub Server, such as issues, pull requests, and so on."

The reported audit found no hard Git dependency in the design. It found software-steering wording and UI, a Chat routing heuristic biased to software verbs, Git-only folder materialization, text-only import and Artifacts, and coding-oriented runtime identities. The engineer accepted the scope and timing, quoted verbatim:

> 2.1 yes 2.2 Chat 的部分我们已经决定了需要之后进行全面的 redesign，所以现在不需要去修它。2.3 & 2.4 同意。

Faithful English translation: "2.1 yes. For 2.2, we have already decided that Chat needs a complete redesign later, so there is no need to fix it now. I agree with 2.3 and 2.4."

In that response, 2.1 was the wording and UI corrections in rc.1; 2.3 was early truthful refusal now, with directory import and binary Artifacts first after release; 2.4 was neutral Worker identity after release, disclosed in rc.1. This records the engineer's accepted sequencing, not an assertion that the deferred capabilities are implemented. The neutral direct-Task defaults landed in `d1f7417f` and `2048298c`.

## Rejected Alternatives

- Fix only the escalation sentence in issue #188 and retain the other software defaults: this would leave the whole default set steering general work toward software outputs and checks, contrary to the engineer's choice to make the whole set neutral.

## Revisit When

No revisit trigger was given by the engineer.

## Affected Owners

- [Task Mode](../specs/20260704-task_mode_worker_delegation.md): direct-Task defaults.
- [Agent Workflow](../core/agent-workflow.md): current source-readiness qualification.
- [Session Static Workspace Materialization](../specs/20260704-session_static_workspace_materialization.md): current configuration-stage source refusal.
- Product wording and UI corrections are non-authoritative projections of the current owning amendments.
- [Chat Mode](../specs/20260704-chat_mode_assistant.md): owner that the later full Chat redesign must amend; no current amendment.
- [Session Static Workspace Materialization](../specs/20260704-session_static_workspace_materialization.md) and [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md): owners that the first post-release directory snapshot import and binary Artifact work must amend.
- [Worker Execution Environment Images](../specs/20260721-worker_execution_environment_images.md) and [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md): owners that the later neutral Worker identity work across the four runtimes must amend.
