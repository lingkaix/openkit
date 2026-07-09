---
id: story-task-mode-mcp-smoke
title: Complete deterministic Task Mode bounded work and escalation through MCP
persona: Product evaluator checking Task Mode routing through the MCP interface
entrypoint: mcp
default_tool: mcp_stdio
timeout_seconds: 300
requires_real_provider: false
requires_real_codex: false
---

# Complete Deterministic Task Mode Bounded Work And Escalation Through MCP

## Purpose

Verify that a product evaluator can use the OpenKit MCP facade to start Task Mode, see bounded worker progress and human gates, resolve the deterministic gates into a completed artifact, see an explicit Task-to-Goal escalation for a multi-step request, and inspect the resulting Goal Mode state without requiring real provider quota, real Codex credentials, or a live OpenShell worker backend.

## Preconditions

- NanoCore and `@openkit/mcp` build outputs exist.
- NanoCore can run in local mode with a disposable data root.
- The story uses NanoCore's deterministic internal self-check executor and does not require real Codex, real OpenAI, ChatGPT subscription auth, GitHub credentials, or external network access.

## Setup

- Start NanoCore in local mode with a disposable data root.
- Start the MCP stdio server against that NanoCore instance.
- Use the default development workspace.

## User-visible Steps

1. Read OpenKit status through MCP.
2. Create a thread for Task Mode delegation.
3. Link a disposable local Git repository.
4. Start bounded Task Mode work through `openkit.start_task`.
5. Read thread progress and Action Center approval/question gates.
6. Resolve the deterministic approval and question through `openkit.resolve_action_center_item`.
7. Read the completed bounded thread and verify the artifact reference.
8. Start Task Mode with a multi-step request through `openkit.start_task`.
9. Read Goal Mode state for the escalation thread through `openkit.read_goal`.
10. Read the escalation thread through `openkit.read_thread`.

## Expected Outcomes

- The bounded task request returns `state: awaiting-human` before human gate resolution.
- The paused bounded task does not expose a terminal `completion`.
- The bounded thread exposes assistant progress and an approval gate.
- Resolving the deterministic approval and question completes the bounded work and creates an artifact reference.
- The task request returns `state: escalated-to-goal`.
- The escalation projection targets Goal Mode and includes a goal id.
- The thread has a durable Goal Mode summary in `planning`.
- The thread contains the visible escalation status item.
- The MCP result summary contains no raw token, API key, cookie, authorization header, or secret-shaped value.

## Deterministic Assertions

- `openkit.start_task` is present in the MCP tool list.
- The bounded Task Mode response includes `state: awaiting-human`.
- The bounded Task Mode response includes `completion: null`.
- `openkit.read_action_center` exposes approval and question rows for the bounded Task turn.
- The bounded Task thread dashboard reports completed work after the deterministic human gates are resolved.
- The bounded Task thread contains an `artifact-reference` item after completion.
- The Task Mode response includes `state: escalated-to-goal`.
- The Task Mode response includes `escalation.targetMode: goal`.
- The Task Mode response includes a turn id.
- `openkit.read_goal` returns `goal.status: planning`.

## Evidence To Collect

- Story metadata and final assertion summary.
- MCP bounded Task Mode JSON result.
- MCP Task Mode JSON result.
- NanoCore health response.
- Bounded Task state, bounded artifact id, escalation state, Goal Mode status, turn id, and MCP tool count.

## Cleanup

- Stop spawned NanoCore and MCP processes.
- Remove the temporary data root.

## Failure Triage Notes

Any confirmed deterministic defect from this story must be reduced into the lowest-layer regression test that can catch it in L1, L2, L3, L4, or L5. Environment failures such as missing build output or blocked localhost binding should be classified separately from product failures.
