---
id: story-recovery-mcp-smoke
title: Complete deterministic recovery controls through MCP
persona: Product evaluator validating worker recovery from an AI application
entrypoint: mcp
default_tool: node
timeout_seconds: 180
requires_real_provider: false
requires_real_codex: false
---

# Complete Deterministic Recovery Controls Through MCP

## Purpose

Verify that a product evaluator can use the OpenKit MCP facade to inspect and resolve recoverable worker interruption state without real provider quota, real Codex credentials, or a live OpenShell worker backend.

## Preconditions

- NanoCore can boot in local mode with a disposable data root.
- The MCP registry can connect to NanoCore through the public App API.
- The deterministic recovery setup route can seed one interrupted worker checkpoint and one pending user turn for the story thread.

## Setup

- Start built NanoCore in local mode with a temporary data root and dynamic localhost port.
- Start the MCP registry against that NanoCore endpoint.
- Create a disposable workspace thread through `openkit.create_thread`.
- Seed one deterministic interrupted worker checkpoint and one pending user turn through NanoCore's public recovery setup route.

## User-visible Steps

1. Read runtime status through `openkit.read_status`.
2. Read interrupted worker recovery rows with `openkit.list_interrupted_workers`.
3. Read preserved pending input with `openkit.list_recovery_pending_user_turns`.
4. Edit the preserved input with `openkit.edit_recovery_pending_user_turn`.
5. Convert the preserved input to follow-up delivery with `openkit.convert_recovery_pending_user_turn_to_follow_up`.
6. Cancel the preserved input with `openkit.cancel_recovery_pending_user_turn`.
7. Retry the interrupted worker checkpoint with `openkit.retry_interrupted_worker_checkpoint`.
8. Read recovery rows again and confirm the retried checkpoint is no longer pending.

## Expected Outcomes

- MCP exposes the interrupted worker row seeded for the story thread.
- MCP exposes the pending user turn seeded for the story thread.
- Editing pending input returns the edited user-message item.
- Converting pending input returns a `follow_up` queue mode.
- Cancelling pending input removes it from the pending input list.
- Retrying the interrupted worker checkpoint returns a retried turn and clears the pending checkpoint row.

## Deterministic Assertions

- `openkit.list_interrupted_workers` returns the seeded turn before retry.
- `openkit.list_recovery_pending_user_turns` returns the seeded request before cancellation.
- `openkit.edit_recovery_pending_user_turn` returns `edited: true`.
- `openkit.convert_recovery_pending_user_turn_to_follow_up` returns `converted: true` and `queueMode: follow_up`.
- `openkit.cancel_recovery_pending_user_turn` returns `cancelled: true`.
- `openkit.retry_interrupted_worker_checkpoint` returns `retried: true`.
- The interrupted worker row for the seeded turn is absent after retry.
- The pending user turn for the seeded request is absent after cancellation.

## Evidence To Collect

- Story metadata and assertion summary.
- NanoCore recovery seed response.
- MCP tool result summary with workspace id, thread id, turn id, and request id.
- Redaction check that evidence does not contain fake secret markers.

## Cleanup

- Stop NanoCore.
- Remove the temporary data root.

## Failure Triage Notes

If the story cannot bind localhost or start NanoCore, classify it as an environment failure. If an MCP recovery tool is missing, returns the wrong mutation state, or fails to clear the expected recovery row, reduce the defect into the lowest-layer App API, Core Client, MCP registry, or storage regression test that can catch it.
