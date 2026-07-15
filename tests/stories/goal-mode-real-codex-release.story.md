---
id: story-goal-mode-real-codex-release
title: Complete a real Codex Goal kernel run through MCP
persona: Release owner validating the governed Goal kernel against a disposable repository
entrypoint: mcp
default_tool: mcp_stdio
timeout_seconds: 1800
requires_real_provider: true
requires_real_codex: true
---

# Complete A Real Codex Goal Kernel Run Through MCP

## Purpose

Verify through the transitional removal-only OpenKit MCP kernel-test facade that NanoCore can plan, execute, review, and complete one bounded Goal through a real OpenShell Codex worker while NanoCore owns provider credentials, inference routing, workspace synchronization, evidence, usage, and audit.

## Preconditions

- A fresh NanoCore server deployment is already running on the runner host and reachable from the runner.
- The runner has local access to that NanoCore deployment's data root and disposable repository.
- The NanoCore host can launch `codex app-server` to probe the streamed account slot.
- A1 hosts the disposable OpenShell gateway and the ARM64 `openkit/worker-codex:dev` image built natively on A1; NanoCore reaches that gateway through the configured tunnel and A1 reaches the NanoCore worker-control endpoint through the reverse tunnel.
- `ssh a1` can read `/home/ubuntu/.codex/auth.json` without interactive input. A1 is only the server-owned auth source; the auth file is streamed into the local NanoCore account slot and never copied into the worker image or sandbox.
- A disposable local git repository with one baseline commit is visible to NanoCore.
- The story is skipped by default because it consumes real Codex subscription capacity and provider quota.

## Required Opt-in Environment Variables

- `OPENKIT_L6_REAL_CODEX=1` enables the real Codex Goal runner.
- `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1` confirms the operator accepts provider usage.
- `OPENKIT_L6_NANOCORE_URL` points to the existing NanoCore deployment.
- `OPENKIT_L6_NANOCORE_DATA_ROOT` points to that deployment's local data root.
- `OPENKIT_L6_GOAL_REPO_ROOT` points to the disposable git repository.
- `OPENKIT_L6_EVIDENCE_DIR` points to a writable redacted evidence directory.
- `OPENKIT_L6_GOAL_WORKSPACE_ID` optionally selects the workspace and defaults to `ws_demo`.
- `OPENKIT_NANOCORE_TOKEN` is required when the NanoCore deployment requires bearer authentication.

## Setup

- Confirm the repository is clean, has a baseline commit, and does not contain `docs/l6-real-goal-proof.md`.
- Ask NanoCore to materialize its default OpenAI Codex OAuth account slot.
- When the server-owned account file is absent, stream the A1 auth file directly into a new `0600` file; when it already exists, require a regular file owned by the runner user with mode `0600` and validate `logged_in` through the public OAuth status without transferring auth again. Never place auth content in process arguments, environment variables, logs, evidence, or the worker sandbox.
- Create the `openai_codex` OAuth provider for `openai-codex/gpt-5.6-sol` only when absent, update it by revision only when it differs, and bind `agent_codex_host` only when its selection differs.
- If the strict reload reports only provider or agent restart-required changes, stop before MCP execution, provider quota, or evidence, restart NanoCore, and rerun. After restart, consume only an exact `workspaceDataSources` session-scoped deferral when present, then require the strict dry-run response to be an exact no-op before continuing.
- Confirm NanoCore accepts product work, the provider registry contains `openai_codex`, provider diagnostics are not blocked, and the linked repository is ready.

## MCP Steps

1. Create a thread named `L6 Goal Mode real Codex kernel`.
2. Start Goal Mode with the exact bounded proof-file objective from the runner.
3. Read the planning state, draft a one-task plan, and confirm it has verification checks.
4. Approve the plan and confirm approval does not start worker execution.
5. Run one bounded Goal step and wait for the real worker turn to reach its terminal checkpoint.
6. Fail if the worker requested approval or user input.
7. Read the Action Center and require exactly one workspace review and one Goal review.
8. Accept the workspace review through the public Core Client and require it to apply only `docs/l6-real-goal-proof.md`.
9. Accept the stored Goal review verdict through `openkit.resolve_action_center_item`.
10. Read Goal state until it is terminal and require successful completion.
11. Read the thread, AEP snapshot, CapabilityCall and usage rows, audit events, EvidenceBundles, RuntimeEvidence, and final git state.

## Exact Proof File

The only repository change must be `docs/l6-real-goal-proof.md` with this exact content:

```markdown
- Real Goal Mode executed through OpenShell.
- Worker inference stayed behind NanoCore.
- Repository changes remained review-gated.
```

## Deterministic Assertions

- Goal planning produces exactly one task with at least one verification check.
- Plan approval is explicit and returns `startsWorkerTurn: false`.
- The worker returns a real turn id, worker session id, successful stop reason, terminal checkpoint, and review outcome.
- No approval or question row is produced by the worker turn.
- The workspace review applies exactly the proof path before the Goal review is accepted.
- The Goal review advances the one-task graph to `complete_goal`.
- Final Goal state is `completed`, exactly one task is complete, and a terminal summary exists.
- The thread contains exactly one completed outer assistant message for the worker turn.
- The turn AEP uses OpenShell, Codex, `direct-nanocore` control, the A1-built `openkit/worker-codex:dev` image, one NanoCore Gateway route, provider `openai_codex`, model `openai-codex/gpt-5.6-sol`, placeholder credential visibility, no direct credential declarations, no provider attachments, no vault material, and `policy.secrets.visibility: none`.
- At least one successful `worker-inference-gateway` LLM CapabilityCall is linked to matching provider and model usage, a successful audit event, an EvidenceBundle, and successful RuntimeEvidence.
- The linked successful RuntimeEvidence identifies OpenShell `0.0.80` as the governance backend used by the A1 run.
- Exactly one successful terminal `runtime.worker_turn` CapabilityCall is linked to one runtime UsageRecord measured as one `sandbox_sessions` unit for the completed worker checkpoint.
- `git diff --check` succeeds, the baseline commit is unchanged, and final git status contains only the untracked proof file.
- Preserved evidence excludes OAuth content, bearer tokens, authorization headers, private account labels, account-file paths, and the NanoCore data-root path.

## Evidence To Collect

- Redacted story metadata, runtime config summary, OAuth status summary, Goal outcome, review outcomes, AEP boundary summary including the A1-built image identity, OpenShell backend version, inference and terminal runtime usage counts, thread result count, and final git status.
- Redaction notes naming every public surface scanned before evidence was written.

## Cleanup

- Stop and remove the disposable NanoCore deployment after evidence has been preserved.
- Remove its data root, including the streamed server-owned OAuth account file.
- Restore or delete the disposable repository according to the release validation runbook.
- Remove any retained A1 sandbox and verify that the A1 OpenShell gateway reports zero residual sandboxes.
- Stop the SSH forward and reverse tunnels created for the run.

## Failure Triage Notes

If explicit opt-in, provider quota, the local NanoCore process, local data root, or local disposable repository is unavailable, classify the result as a runner-host environment failure.

If the A1 gateway, A1-built worker image, A1 auth source, or required forward and reverse tunnels are unavailable, classify the result as an A1 execution-environment failure.

If Goal execution, workspace review, Goal review, AEP boundaries, inference attribution, evidence linkage, or repository assertions fail, classify the result by the owning product layer and reduce the defect into the lowest practical L1-L5 regression test.

If any secret-bearing value reaches public output or preserved evidence, treat the failure as release-blocking and retain only redacted reproduction evidence.
