---
id: story-chat-mode-mcp-smoke
title: Complete deterministic Chat Mode routing through MCP
persona: Product evaluator checking the Assistant entry path through the MCP interface
entrypoint: mcp
default_tool: mcp_stdio
timeout_seconds: 300
requires_real_provider: false
requires_real_codex: false
---

# Complete Deterministic Chat Mode Routing Through MCP

## Purpose

Verify that a product evaluator can use the OpenKit MCP facade as the Chat Mode entry point, receive a source-traceable answer, get a bounded clarification gate for vague input, get read-only linked-repository file-list and file-read answers, see a visible Task Mode handoff that starts bounded worker progress, and see a visible Goal Mode handoff without requiring real provider quota or real Codex credentials.

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
2. Create a thread for Chat Mode routing.
3. Seed one accepted workspace knowledge entry through NanoCore public API.
4. Ask Chat Mode a workspace knowledge question through `openkit.start_chat`.
5. Ask Chat Mode a vague request through `openkit.start_chat`.
6. Read Action Center and confirm the clarification question is visible.
7. Link a disposable local Git repository.
8. Ask Chat Mode for a linked repository file list through `openkit.start_chat`.
9. Ask Chat Mode for one linked repository text file through `openkit.start_chat`.
10. Ask Chat Mode for bounded implementation work through `openkit.start_chat`.
11. Read the Task handoff thread and Action Center worker gate.
12. Ask Chat Mode for a multi-step plan through `openkit.start_chat`.
13. Read Goal Mode state for the thread.

## Expected Outcomes

- The knowledge question returns `answered` with an `assistant-message`.
- The vague request returns `clarification-needed` with a `user-input-request`.
- Action Center exposes the clarification question.
- The linked repository file-list request returns `answered` and names `README.md` without starting a worker.
- The linked repository file-read request returns `answered`, previews the requested safe text file, and does not expose the local repository path.
- The bounded implementation request returns `task-handoff`, records a Task Mode handoff status item, starts bounded worker progress, and exposes the worker approval gate through Action Center.
- The multi-step request returns `goal-handoff` and creates a durable Goal Mode summary in `planning`.
- The MCP result summary contains no raw token, API key, cookie, authorization header, or secret-shaped value.

## Deterministic Assertions

- `openkit.start_chat` is present in the MCP tool list.
- The knowledge answer cites the seeded knowledge entry.
- The clarification turn is `awaiting_human`.
- The linked repository file-list answer includes the repository root `README.md`.
- The linked repository file-read answer includes the requested `docs/guide.md` content and no absolute local path.
- The Task Mode handoff includes `handoff.targetMode: task`.
- The Task Mode handoff thread includes a `Task Mode handoff` status item and an assistant progress item from the bounded worker.
- The Goal Mode handoff does not start a worker turn.

## Evidence To Collect

- Story metadata and final assertion summary.
- MCP Chat Mode JSON result.
- NanoCore health response.
- Chat Mode outcomes, repository file-list and file-read answer outcomes, Action Center question and worker-gate visibility, Task Mode handoff outcome, Goal Mode status, and MCP tool count.

## Cleanup

- Stop spawned NanoCore and MCP processes.
- Remove the temporary data root.

## Failure Triage Notes

Any confirmed deterministic defect from this story must be reduced into the lowest-layer regression test that can catch it in L1, L2, L3, L4, or L5. Environment failures such as missing build output or blocked localhost binding should be classified separately from product failures.
