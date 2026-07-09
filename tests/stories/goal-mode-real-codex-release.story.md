---
id: story-goal-mode-real-codex-release
title: Complete a real Codex Goal Mode release run
persona: Release owner validating host-mode Goal Mode against a disposable local repository
entrypoint: web
default_tool: playwright
timeout_seconds: 1800
requires_real_provider: true
requires_real_codex: true
---

# Complete A Real Codex Goal Mode Release Run

## Purpose

Verify that a release owner can use Goal Mode from the Web UI to plan, execute, review, verify, and complete a bounded product task in a linked local git repository with the real Codex host adapter.

## Preconditions

- NanoCore can boot with a disposable data root.
- Web can boot against the NanoCore instance.
- A disposable local git repository exists for the story run.
- The local machine has a valid Codex OAuth account slot that the operator explicitly points to with an environment variable.
- The story is skipped by default because it can consume real provider quota and real Codex subscription capacity.

## Required Opt-in Environment Variables

- `OPENKIT_L6_REAL_CODEX=1` enables real Codex story execution.
- `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1` confirms the operator accepts provider or subscription usage.
- `OPENKIT_L6_CODEX_OAUTH_ACCOUNT_DIR` points to the local Codex OAuth account directory for this machine.
- `OPENKIT_L6_GOAL_REPO_ROOT` points to the disposable git repository that Goal Mode may modify.
- `OPENKIT_L6_EVIDENCE_DIR` points to a writable directory for transcripts, screenshots, server logs, item history, artifact references, verification output, and redaction notes.

## Setup

- Start NanoCore in host mode with a fresh temporary data root.
- Start the Web UI against that NanoCore instance.
- Link the disposable git repository through the repository App API setup route before opening the Goal Mode thread.
- Use a fresh browser context.
- Confirm the repository has a clean initial git status before starting the goal.

## User-visible Steps

1. Open the Web UI root route.
2. Select or create the workspace used for release validation.
3. Create a thread named `L6 Goal Mode real Codex release`.
4. Start Goal Mode with an objective that asks OpenKit to make a small, reversible repository change and verify it.
5. Review the generated plan, including assumptions, tasks, verification checks, expected artifacts, risks, and human review policy.
6. Approve the plan only if every task is bounded to the disposable repository.
7. Observe the first worker task running through the real Codex host adapter.
8. Review the worker result, changed files, artifacts, verification output, and any requested human attention.
9. Accept, retry, refine, or block the task according to the visible review outcome.
10. Continue until all planned tasks are terminal.
11. Review the final Goal Mode completion summary and final verification evidence.

## Checkpoints

- Capture a checkpoint after repository linking succeeds.
- Capture a checkpoint after the plan is generated but before approval.
- Capture a checkpoint after each worker task reaches review.
- Capture a checkpoint after verification evidence is attached.
- Capture a checkpoint after the final terminal summary is visible.

## Expected Outcomes

- Goal Mode starts without a missing workspace repository warning.
- The plan approval step is explicit and does not start worker execution before approval.
- Worker execution occurs in the linked disposable repository.
- The review surface shows changed files, artifacts, or evidence sufficient for a release owner to accept or reject the work.
- Verification output is visible before final completion.
- The terminal summary shows completed tasks, blocked or skipped tasks if any, artifact references, verification evidence, risks, and suggested next work.

## Deterministic Assertions

- The Web UI does not show `Workspace repository is not configured.` after repository setup.
- The Goal Mode panel shows a planning state before plan approval.
- The Goal Mode panel shows a running, reviewing, verifying, awaiting-human, completed, blocked, aborted, or failed state after plan approval.
- Final completion requires visible verification evidence.
- The evidence bundle records the final git status and changed-file summary for the disposable repository.
- The browser body, server logs, item history, and evidence bundle do not contain raw OAuth tokens, bearer tokens, API keys, or provider secrets.

## Evidence To Collect

- Agent transcript with goals, actions, observations, assertions, deviations, and final status.
- Browser screenshots or trace at each checkpoint when available.
- NanoCore process logs and health responses.
- Goal Mode item history for plan, task progress, review, verification, and terminal summary items.
- Artifact ids, artifact titles, or changed-file summaries produced by the run.
- Verification commands, exit codes, and redacted output snippets.
- Final git status for the disposable repository.
- Redaction notes describing every scanned evidence source.

## Secret Redaction Expectations

- Do not write raw OAuth tokens, bearer tokens, API keys, cookie values, authorization headers, or private account payloads into committed files or evidence artifacts.
- Replace any accidental secret-like values with `[REDACTED]` before preserving evidence.
- Treat fake secret markers as test data only when they are intentionally introduced for redaction checks.
- Record the evidence locations that were scanned for secret leakage.

## Cleanup

- Stop all spawned NanoCore and Web processes.
- Preserve the evidence directory only after redaction checks pass.
- Remove the temporary data root.
- Restore or delete the disposable repository according to the runbook for the release validation session.

## Failure Triage Notes

If the story fails because the environment cannot provide the explicit real Codex opt-in, classify the result as an environment failure.

If the story fails because Goal Mode cannot complete the visible workflow, classify the result by suspected layer and add or request the lowest practical L1-L5 regression test.

If the story finds a secret leak, treat it as a release-blocking defect and preserve only redacted reproduction evidence.
