---
id: story-task-mode-real-worker-release
title: Complete a real OpenShell Codex Task Mode run
persona: Release owner validating Task Mode against a disposable repository
entrypoint: mcp
default_tool: mcp_stdio
timeout_seconds: 1200
requires_real_provider: true
requires_real_codex: true
---

# Complete A Real OpenShell Codex Task Mode Run

## Purpose

Verify that a release owner can use the OpenKit MCP facade to start one bounded Task Mode request against an existing NanoCore deployment whose worker runtime uses real OpenShell and Codex credentials.

## Preconditions

- NanoCore is already running and reachable from the machine running this story.
- `@openkit/mcp`, `@openkit/core-client`, `@openkit/app-api-schemas`, and `nanocore` build outputs exist.
- A disposable git repository exists at a path visible to the NanoCore process.
- The NanoCore worker environment has access to a valid Codex auth JSON through the accepted vault or deployment setup path.
- The story is skipped by default because it may consume real Codex subscription capacity and provider quota.

## Required Opt-in Environment Variables

- `OPENKIT_L6_TASK_REAL_WORKER=1` enables this real Task Mode runner.
- `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1` confirms the operator accepts provider or subscription usage.
- `OPENKIT_L6_TASK_NANOCORE_URL` points to the existing NanoCore endpoint.
- `OPENKIT_L6_TASK_REPO_ROOT` points to the disposable git repository as seen by NanoCore.
- `OPENKIT_L6_TASK_CODEX_AUTH_JSON` points to the operator-owned Codex auth JSON path used by the deployment setup.
- `OPENKIT_L6_EVIDENCE_DIR` points to a writable directory for redacted evidence.

## Setup

- Build NanoCore and MCP packages before running the story.
- Start or reuse NanoCore with the real OpenShell worker backend configured.
- Confirm the disposable repository has a clean initial git status.
- Run the MCP runner from an environment that can reach the NanoCore endpoint and repository path.

## User-visible Steps

1. Read NanoCore status through MCP.
2. Create a release validation thread.
3. Link the disposable repository.
4. Start Task Mode through `openkit.start_task` with one bounded repository change request.
5. Read the Task Mode thread after the attempt returns.
6. Read Action Center for pending review, approval, or question rows.
7. Record the Task Mode state, worker selection, evidence ids, workspace review ids, and final git status.

## Expected Outcomes

- `openkit.start_task` returns a Task Mode response rather than a hidden local execution path.
- The response includes a Workflow Coordinator Task Mode decision with a selected worker.
- The returned state is one of `running`, `completed`, `needs-review`, or `awaiting-human`; `blocked`, `failed`, and `escalated-to-goal` are failures for this bounded request.
- The thread contains visible Task Mode items.
- The thread contains at least one completed assistant message from the real worker path.
- Any produced artifacts or staged workspace reviews are exposed through existing evidence ids.
- The evidence files do not contain raw OAuth tokens, bearer tokens, cookies, authorization headers, or Codex auth JSON content.

## Deterministic Assertions

- The selected story metadata requires real provider and real Codex execution.
- `openkit.start_task` is present in the MCP tool list.
- NanoCore status is readable before mutation.
- Repository linking succeeds for the provided repository path.
- `openkit.start_task` returns a raw Task Mode payload with a turn id and accepted Task Mode state.
- `openkit.read_thread` returns at least one item for the Task Mode thread.
- `openkit.read_thread` returns at least one completed assistant-message item for the Task Mode thread.
- The evidence report includes only redacted configuration summaries and product-safe ids.

## Evidence To Collect

- Story metadata and final assertion summary.
- NanoCore base URL with token material omitted.
- Workspace id, thread id, Task Mode state, worker target, evidence item ids, artifact ids, review ids, and Action Center item count.
- Redacted final git status output for the disposable repository.
- Redaction notes describing the secret classes that were not preserved.

## Cleanup

- Preserve evidence only after redaction checks pass.
- Delete or reset the disposable repository after the release validation session.

## Failure Triage Notes

If the story fails because opt-in variables, Codex auth setup, NanoCore reachability, or repository visibility are missing, classify it as an environment failure.

If the story reaches NanoCore but Task Mode does not launch through Workflow Coordinator or loses evidence visibility, reduce the defect into the lowest practical L1-L5 regression test.
