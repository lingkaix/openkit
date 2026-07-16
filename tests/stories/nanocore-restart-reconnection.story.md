---
id: story-nanocore-restart-reconnection
title: Finish one remote worker task after NanoCore restarts
persona: Operator validating a stock OpenShell deployment
entrypoint: app_api
default_tool: core_client
timeout_seconds: 420
requires_real_provider: true
requires_real_codex: true
---

# NanoCore Restart Reconnection

## Purpose

Prove that one live remote worker reconnects and finishes through the public App API after its local NanoCore owner is killed and restarted.

## Preconditions

- A fresh local NanoCore data root, fixed port, disposable repository, and stock remote OpenShell Gateway are available.
- Real-provider quota use is explicitly enabled.

## Flow

1. Start NanoCore and one bounded Task Mode request through Core Client.
2. Wait until the public backend handle identifies the live worker.
3. Kill NanoCore and restart it with the same data root, port, and environment.
4. Wait for one completed assistant message through the public thread API.
5. Read the backend handle once more and confirm the same worker is cleaned.

## Acceptance

- The worker reconnects within the lease's bounded awaiting-reconnect interval.
- No replacement backend handle or worker session appears.
- The public task output completes and the original backend handle becomes `cleaned`.
- The run uses stock OpenShell without a fork or patch.

## Failure

Stop the local NanoCore process and retain its data root for diagnosis.
