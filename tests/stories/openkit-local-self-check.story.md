---
id: story-web-local-turn
title: Complete a local worker turn from the Web UI
persona: Product evaluator using a clean local OpenKit workspace
entrypoint: web
default_tool: playwright
timeout_seconds: 300
requires_real_provider: false
requires_real_codex: false
---

# Complete A Local Worker Turn From The Web UI

## Purpose

Verify that a user can open the Web UI, create a workspace and thread, submit a deterministic self-check task, respond to the approval and question gates, inspect the result artifact, and confirm diagnostics do not expose raw secrets.

## Preconditions

- NanoCore can boot with a disposable data root.
- Web can boot against the NanoCore instance.
- The deterministic internal self-check executor is enabled.
- The story does not require real Codex, real OpenAI, ChatGPT subscription auth, or external network access.

## Setup

- Start NanoCore in local mode with `OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR=1`.
- Start the Web UI against that NanoCore instance.
- Use a fresh temporary data root and dynamic localhost ports.
- Link a disposable git repository to the story workspace through setup before sending the turn.

## User-visible Steps

1. Open the Web UI root route.
2. Create a workspace named `Story Workspace`.
3. Create a thread named `Story thread`.
4. Submit a turn prompt asking the simulator to run the full flow.
5. Approve the simulated workspace update.
6. Answer the simulator question with `Concise`.
7. Open the generated artifact.
8. Open Settings Diagnostics.

## Expected Outcomes

- The new workspace is visible.
- The story workspace has a linked repository before the turn starts.
- The new thread dashboard is visible.
- The submitted turn shows simulator output.
- The approval card can be granted.
- The question card accepts the answer.
- The generated artifact renders the simulator summary.
- Diagnostics render without exposing raw secret markers.

## Deterministic Assertions

- The workspace button named `Story Workspace` is visible.
- The heading `Story thread Dashboard` is visible.
- The turn output contains `simulator: ok`.
- The approval state reaches `Granted`.
- The artifact view contains `Simulator answer: Concise`.
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
