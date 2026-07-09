---
name: openkit-loop-dev
description: Coordinate review-gated OpenKit self-improvement loops through NanoCore and the OpenKit MCP server. Use when setup is already available and Codex, Pi Agent, Claude CoWork, or another agent app is working inside the OpenKit repository as the loop coordinator, maintaining `docs/changes` state, using Goal Mode through MCP, running one bounded worker step at a time, reviewing Action Center and evidence, recording dogfood fallbacks, handling controlled NanoCore restarts, synchronizing through GitHub when needed, or asking a second agent or remote verifier to check the result. Do not use for normal end-user workspace loops; use `openkit-loop` instead.
---

# OpenKit Developer Loop

## Role

Use this Skill when the AI application is the coordinator for improving OpenKit with OpenKit.

If NanoCore or the MCP server is not configured yet, use `openkit-setup-dev` first.

The coordinator talks to the human, calls the OpenKit MCP server, and keeps the loop bounded, reviewable, and auditable.

NanoCore remains the source of truth for Goal Mode, worker execution, Action Center, artifacts, evidence, and repository state.

The MCP server is a standard stdio channel over public NanoCore APIs. It is not worker-side MCP supply, a shell, a backend supervisor, a package manager, or an internal admin API.

Use the local developer machine as the default coordinator, execution, and local verification environment.

Use a remote verifier server only when the loop needs server-mode proof, independent-machine evidence, deployment-shape validation, or backup execution that cannot be produced locally.

## Do Not Use This Skill For

- Normal end-user workspace loops. Use `openkit-loop`.
- Repository setup and MCP connection bootstrap. Use `openkit-setup-dev`.
- Unattended recursive self-modification or bypassing approval, review, repository diagnostics, or human decisions.

## Required Context

Read `AGENTS.md`, `skills/AGENTS.md`, `docs/change-tracking.md`, `docs/specs/20260617-openkit_ai_interface.md`, and `docs/specs/20260627-openkit_development_loop_protocol.md` before changing repository files.

Keep repository text in English.

Do not design for backward compatibility while OpenKit remains internal pre-release.

## Loop Contract

Every development loop has five parts:

1. Goal definition: define a narrow objective, external stop condition, scope, and non-goals.
2. Automation: use Goal Mode to draft a plan and run exactly one bounded worker step at a time.
3. Memory and state: keep durable state in NanoCore, GitHub, and one `docs/changes/` record.
4. Verification: separate the worker from the checker by using deterministic checks and, when useful, a local second Codex session or remote verifier.
5. Self-correction: if the loop finds a real setup, spec, code, test, or docs gap, record it and fix the smallest in-scope gap through the same review-gated process.

Do not implement unattended recursive self-modification.

## Dogfood Rule

Use NanoCore first.

The coordinator should attempt OpenKit self-improvement through public NanoCore capabilities exposed by MCP before falling back to direct repository, terminal, sub-agent, or remote-machine work.

Use external fallback paths only when NanoCore or MCP cannot currently perform the needed operation, cannot reconnect, loses required state, has a broken route shape, or lacks a necessary product capability.

Every fallback is product evidence.

Record each fallback in the active `docs/changes/` record with:

- the intended NanoCore or MCP path
- the exact blocker or missing capability
- whether the issue is environmental, documentation/setup-related, App API or MCP surface-related, runtime reliability-related, or product workflow-related
- the smallest recovery action taken outside NanoCore
- whether the fixed path was re-run through NanoCore afterward

Promote repeated fallbacks or fallbacks that affect public workflow, API, data, verifier, or recovery semantics into a spec or follow-up product change.

## First MCP Calls

Always call `openkit.read_status` first, then call `openkit.read_runtime_diagnostics` before running Goal Mode worker steps.

Summarize NanoCore reachability, runtime config status, worker capability readiness, workspace id, repository readiness, active goal state, and Action Center counts before acting.

Before linking this repository, confirm the path with the human, then call `openkit.link_repository` and `openkit.read_repositories`.

Create or resume a thread with `openkit.create_thread` or a human-provided thread id, then call `openkit.read_thread`.

For lightweight questions, current-state triage, or explicit handoff testing, call `openkit.start_chat` before heavier work.

Call `openkit.start_task` when Chat Mode hands off to Task Mode or when the change is one bounded delegated implementation task that needs worker execution but not plan negotiation.

Continue to Goal Mode when Chat Mode or Task Mode hands off to Goal Mode, or when the human already requested tracked multi-step implementation.

## Change Record

For material repository work, create a `docs/changes/[datetime]-[short_name].md` change plan before implementation.

The record must include intent, scope, non-goals, related docs, impacted surfaces, plan, verification, handoff points, risks, tracking log, and final summary.

Update the same record at meaningful checkpoints: phase completion, scope change, blocker, deviation, handoff, verification result, commit, PR, or final state.

Do not use the change record as a terminal transcript.

## Goal Mode Procedure

Call `openkit.start_goal` with one narrow objective when the work needs tracked planning or Chat Mode hands off to Goal Mode.

Call `openkit.draft_goal_plan`, present the plan, and wait for explicit human approval before calling `openkit.approve_goal_plan`.

Call `openkit.step_goal` once.

After every worker step, call `openkit.read_goal`, `openkit.read_action_center`, `openkit.read_workspace_reviews`, and relevant `openkit.read_thread`, `openkit.read_artifact`, or `openkit.create_evidence_bundle`.

Ask the human whether to continue, steer, refine, reject, accept, or stop.

Use `openkit.submit_steering` only for human-approved direction changes.

Use `openkit.resolve_action_center_item` only after the human chooses a concrete decision for a specific row.

## NanoCore Self-Update Interruptions

When a worker step finds that NanoCore itself must be rebuilt, reconfigured, restarted, or debugged before the loop can continue, treat that as a controlled interruption.

Before changing the backend process, record the blocker, current goal id, current task id, pending Action Center rows, relevant evidence, and intended recovery action in the change record.

Ask the human before stopping, restarting, rebuilding, or reconfiguring NanoCore.

After NanoCore is reachable again, call `openkit.read_status`, then re-read repositories, the thread, Goal Mode state, Action Center, and relevant artifacts or evidence.

Resume only from the durable state returned by NanoCore and the change record.

If MCP cannot reconnect, state is lost, or the route shape changed, mark the loop blocked and record the product gap before attempting another fix.

## Developer Verification

Prefer checks that match the changed surface.

For Skill-only changes, run Skill validation when available and repo static checks.

For MCP or NanoCore changes, add focused tests first, then run package tests, typecheck, lint, build, and deterministic MCP/NanoCore smoke.

Useful smoke commands:

```bash
OPENKIT_MCP_SMOKE_REPOSITORY=/Users/m5pro/Documents/AI/openkit pnpm --filter @openkit/mcp smoke:nanocore
OPENKIT_MCP_SMOKE_CORE_MODE=server OPENKIT_MCP_SMOKE_REPOSITORY=/Users/m5pro/Documents/AI/openkit pnpm --filter @openkit/mcp smoke:nanocore
```

Use a developer- or maintainer-provided remote verifier server when the loop needs server-mode proof, independent-machine evidence, deployment-shape validation, or backup execution.

The remote verifier server should use its own machine-local provider credentials, Codex login state, toolchain, and NanoCore configuration.

Do not copy local auth files, private machine paths, or host-specific run commands into this Skill, artifacts, or change records.

Keep the remote verifier read-only by default. It should fetch the GitHub branch, run the agreed checklist, and report evidence rather than push fixes unless the human explicitly approves a verifier-fix branch.

For local-only documentation, Skill, UI copy, or narrow local NanoCore changes, remote verification is optional when local checks and human review are enough.

Record the remote-verification decision and rationale in the change record.

## Human Gates

Ask the human before approving plans, resolving Action Center rows, accepting results, rejecting results, extending budgets, running provider-quota work, committing, pushing, opening PRs, tagging, deploying, or triggering external side effects.

Do not treat worker completion, green tests, or a verifier comment as human acceptance.

When asking for a decision, state the evidence, the risk, and the exact next action.

## Completion

A developer loop is complete only when the stop condition is met, evidence has been read through OpenKit or recorded durably, the change record is closed, relevant checks have passed or have precise skipped reasons, remote verification has either passed or been explicitly deemed unnecessary, and the human accepts the result.
