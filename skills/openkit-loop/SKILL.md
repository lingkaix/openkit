---
name: openkit-loop
description: Coordinate bounded OpenKit work loops for a normal end-user workspace through NanoCore and the OpenKit MCP server. Use when setup is already available and Codex, Pi Agent, Claude CoWork, or another agent app should define a verifiable goal with the human, run Goal Mode one approved step at a time, review Action Center decisions, read artifacts and NanoCore-produced evidence bundles, steer or retry based on feedback, and help the human accept, reject, or stop the result. Do not use for OpenKit repository self-development; use `openkit-loop-dev` instead.
---

# OpenKit Loop

## Role

Use this Skill when the AI application is the coordinator for an end user's OpenKit workflow.

If NanoCore or the MCP server is not configured yet, use `openkit-setup` first.

The coordinator helps the human define a goal, connects to NanoCore through the OpenKit MCP server, runs bounded Goal Mode work, summarizes evidence, and asks the human for decisions.

NanoCore owns workspace state, threads, Goal Mode, worker steps, Action Center, artifacts, and evidence.

The MCP server is a standard stdio facade over public NanoCore APIs. It does not install NanoCore, supervise backend processes, execute arbitrary commands, read secrets, or access backend internals.

## Do Not Use This Skill For

- Setting up the MCP connection. Use `openkit-setup`.
- Improving the OpenKit repository itself. Use `openkit-loop-dev`.
- Unattended recursive work, hidden side effects, or accepting worker output without human review.

## Loop Contract

Every user loop has five parts:

1. Goal definition: turn the user's intent into a concrete objective and an externally checkable stop condition.
2. Automation: draft a plan and run one bounded worker step at a time through Goal Mode.
3. Memory and state: use NanoCore thread state, artifacts, evidence, and external workspace files as durable memory.
4. Verification: use Action Center, artifacts, evidence, and a reviewer or sub-agent when the result needs independent checking.
5. Self-correction: when evidence shows a problem, steer the loop, retry within budget, or split the work into a smaller goal.

Do not run unattended recursive work.

## First MCP Calls

Always call `openkit.read_status` first, then call `openkit.read_runtime_diagnostics` before running Goal Mode worker steps.

Explain NanoCore reachability, runtime config status, worker capability readiness, workspace id, linked repository or workspace resource, active goal state, and Action Center counts before acting.

If the task needs a repository or local workspace path, ask the human to confirm it, then call `openkit.link_repository` and `openkit.read_repositories`.

If the task does not need a repository, continue with the workspace and thread context available from NanoCore.

Create or resume a thread with `openkit.create_thread` or a human-provided thread id, then call `openkit.read_thread`.

For lightweight questions or routing triage, call `openkit.start_chat` before heavier work.

Call `openkit.start_task` when Chat Mode hands off to Task Mode or when the user asks for one bounded delegated task that needs worker execution but not plan negotiation.

Continue to Goal Mode only when Chat Mode or Task Mode hands off to Goal Mode, or when the human already requested a tracked multi-step goal.

## Define The Goal

Before starting Goal Mode, ask for or infer:

- objective
- workspace or repository resource
- stop condition
- constraints and non-goals
- allowed tools and side effects
- review expectations
- budget or maximum number of steps

If the stop condition is vague, propose a sharper one and ask the human to approve it.

## Goal Mode Procedure

Call `openkit.start_goal` with one narrow objective when the work needs tracked planning or Chat Mode hands off to Goal Mode.

Call `openkit.draft_goal_plan`, present the plan in plain language, and wait for explicit human approval before calling `openkit.approve_goal_plan`.

Call `openkit.step_goal` once.

After every step, call `openkit.read_goal`, `openkit.read_action_center`, `openkit.read_workspace_reviews`, and relevant `openkit.read_thread` or `openkit.read_artifact` tools, then inspect `openkit://workspaces/{workspaceId}/evidence-bundles` when automatic evidence applies.

Summarize what changed, what evidence exists, what still needs a decision, and what the safest next action is.

Ask the human whether to continue, steer, refine, reject, accept, or stop.

Use `openkit.submit_steering` only for human-approved direction changes.

Use `openkit.resolve_action_center_item` only after the human chooses a concrete decision for a specific row.

## Review And Evidence

Treat Action Center as authoritative for human attention.

Read artifacts before summarizing deliverables.

Read NanoCore-produced evidence bundles when the human must accept, reject, compare, or hand off the result.

For high-stakes or expensive work, recommend an independent verifier before acceptance.

Do not treat worker completion as acceptance.

## Human Gates

Ask the human before approving plans, resolving Action Center rows, accepting results, rejecting results, extending budgets, spending provider quota, changing workspace files, calling external services, committing, pushing, publishing, deploying, or triggering external side effects.

When asking for a decision, state the evidence, the risk, and the exact next action.

## Completion

A user loop is complete only when the stop condition is met, evidence has been reviewed, Action Center has no blocking unresolved decisions for the goal, and the human accepts the result.

If the loop cannot complete, record the precise blocker and suggest the smallest next loop that can make progress.
