---
id: story-goal-mode-mcp-smoke
title: Complete a deterministic Goal Mode run through MCP
persona: Product evaluator dogfooding OpenKit through the MCP interface
entrypoint: mcp
default_tool: mcp_stdio
timeout_seconds: 600
requires_real_provider: false
requires_real_codex: false
---

# Complete A Deterministic Goal Mode Run Through MCP

## Purpose

Verify that a product evaluator can operate the stable NanoCore Goal Mode workflow through the OpenKit MCP facade: inspect runtime status, link a repository, start a goal, draft and approve a plan, run one bounded step, resolve human attention when raised, collect evidence, and read artifacts without requiring real provider quota or real Codex credentials.

## Preconditions

- NanoCore and `@openkit/mcp` build outputs exist.
- The deterministic internal self-check executor can run in local NanoCore mode.
- The story does not require real Codex, real OpenAI, ChatGPT subscription auth, GitHub credentials, or external network access.

## Setup

- Start NanoCore in local mode with a disposable data root and `OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR=1`.
- Start the MCP stdio server against that NanoCore instance.
- Use a temporary repository fixture unless the operator provides a disposable repository path.

## User-visible Steps

1. Read OpenKit status through MCP.
2. Read runtime diagnostics through MCP.
3. Link the disposable repository to the workspace.
4. Create a thread for the Goal Mode run.
5. Start Goal Mode with this story title as the objective.
6. Draft a Goal Mode plan.
7. Approve the plan.
8. Run exactly one bounded Goal Mode step.
9. Read Goal Mode state and Action Center state.
10. Resolve approval or question gates when the deterministic worker raises them.
11. Create an evidence bundle and read the produced artifact when present.

## Expected Outcomes

- Runtime diagnostics include runtime config status.
- Repository diagnostics become ready before Goal Mode starts.
- Goal Mode plan drafting returns a plan item id.
- Plan approval succeeds before worker execution.
- One bounded worker step returns a worker turn id.
- Action Center exposes approval or question gates when the deterministic worker asks for them.
- The evidence bundle records item and artifact evidence.
- The MCP result summary contains no raw token, API key, cookie, authorization header, or secret-shaped value.

## Deterministic Assertions

- `openkit.step_goal` is present in the MCP tool list.
- `openkit.read_runtime_diagnostics` returns runtime config status.
- `openkit.read_repositories` reports the default repository as ready.
- `openkit.create_thread` returns a thread id.
- `openkit.draft_goal_plan` returns a plan item id.
- `openkit.step_goal` returns a worker turn id.
- `openkit.create_evidence_bundle` returns item or artifact evidence.
- The final result reports whether approval and question gates were resolved.

## Evidence To Collect

- Story metadata and final assertion summary.
- MCP smoke JSON result.
- NanoCore health response.
- Goal Mode status, Action Center item count, evidence item count, evidence artifact count, and artifact-read status.
- Redaction notes if any fake secret marker appears in logs or results.

## Cleanup

- Stop spawned NanoCore and MCP processes.
- Remove the temporary data root and temporary repository fixture.

## Failure Triage Notes

Any confirmed deterministic defect from this story must be reduced into the lowest-layer regression test that can catch it in L1, L2, L3, L4, or L5. Environment failures such as missing build output or blocked localhost binding should be classified separately from product failures.
