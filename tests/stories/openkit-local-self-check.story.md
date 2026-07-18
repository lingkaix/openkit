---
id: story-web-local-turn
title: Inspect a local workspace from the Web UI
persona: Product evaluator using a clean local OpenKit workspace
entrypoint: web
default_tool: playwright
timeout_seconds: 300
requires_real_provider: false
requires_real_codex: false
---

# Inspect A Local Workspace From The Web UI

## Purpose

Verify that a user can open the Web UI, create a workspace and thread, inspect the thread dashboard, and confirm diagnostics do not expose raw secrets.

## Preconditions

- NanoCore can boot with a disposable data root.
- Web can boot against the NanoCore instance.
- The story does not require real Codex, real OpenAI, ChatGPT subscription auth, or external network access.

## Setup

- Start NanoCore in local mode without a worker runtime.
- Start the Web UI against that NanoCore instance.
- Use a fresh temporary data root and dynamic localhost ports.

## User-visible Steps

1. Open the Web UI root route.
2. Create a workspace named `Story Workspace`.
3. Create a thread named `Story thread`.
4. Open Settings Diagnostics.

## Expected Outcomes

- The new workspace is visible.
- The new thread dashboard is visible.
- Diagnostics render without exposing raw secret markers.

## Deterministic Assertions

- The workspace button named `Story Workspace` is visible.
- The heading `Story thread Dashboard` is visible.
- The Diagnostics page is visible.
- The browser body does not contain `sk-openkit`.

## Evidence To Collect

- Playwright trace on failure.
- Screenshot on failure.
- Story metadata and assertion summary attachments.
- Browser console and network evidence from the Playwright report.

## Cleanup

- Stop all spawned NanoCore and Web processes.
- Remove the temporary data root.

## Failure Triage Notes

Any confirmed defect from this story must be reduced into the lowest-layer deterministic regression test that can catch it in L1, L2, L3, L4, or L5.
