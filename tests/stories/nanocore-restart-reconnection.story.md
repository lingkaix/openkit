---
id: story-nanocore-restart-reconnection
title: Finish one remote worker task after NanoCore restarts
persona: Operator validating a stock OpenShell deployment
entrypoint: app_api
default_tool: core_client
timeout_seconds: 420
requires_real_provider: true
requires_real_codex: true
contracts: docs/specs/20260703-durable_scheduler_design.md, docs/specs/20260703-worker_control_protocol.md, docs/specs/20260704-nanocore_bootstrap_readiness.md, docs/specs/20260715-openshell_disposable_cell_lifecycle.md
---

# NanoCore Restart Reconnection

## Purpose

Prove that one live remote worker reconnects and finishes through the public App API after its local NanoCore owner is killed and restarted.

## Preconditions

- A fresh local NanoCore data root, fixed port, disposable repository, and stock remote OpenShell Gateway are available.
- Real-provider quota use is explicitly enabled.

## User-visible Steps

1. Start NanoCore and one bounded Task Mode request through Core Client.
2. Wait until the public backend handle identifies the live worker.
3. Kill NanoCore and restart it with the same data root, port, and environment.
4. Wait for one completed assistant message through the public thread API.
5. Read the backend handle once more and confirm the same worker is cleaned.

## Expected Outcomes

- The original worker survives the NanoCore restart, reconnects, and finishes the same task.
- No replacement worker or backend session is created.
- The run uses stock OpenShell without a fork or patch.

## Deterministic Assertions

- The lease records show the same lease is adopted within the bounded awaiting-reconnect deadline and its worker sequence advances past its pre-restart value.
- The backend records show exactly one backend handle for the task and no replacement worker session.
- The public thread API returns one completed assistant message for the original turn.
- The final backend handle read reports `cleaned`.

## Evidence To Collect

- Story metadata and final assertion summary.
- Lease, backend-handle, and worker-sequence reads before the kill and after completion.
- The completed assistant message identifier from the public thread API.
- Redacted runner log covering kill and restart timing.

## Cleanup

- Stop the local NanoCore process.
- Remove the disposable data root and repository after a passed run; retain the data root for diagnosis when the run failed.

## Failure Triage Notes

Stop the local NanoCore process and retain its data root for diagnosis. Reduce any confirmed deterministic product defect into the lowest sufficient L1-L5 regression.
