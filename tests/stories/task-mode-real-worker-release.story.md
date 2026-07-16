---
id: story-task-mode-real-worker-release
title: Verify real OpenShell Codex runtime provenance
persona: Release owner validating governed Codex sub-agent provenance
entrypoint: app_api
default_tool: core_client
timeout_seconds: 3600
requires_real_provider: true
requires_real_codex: true
---

# Verify Real OpenShell Codex Runtime Provenance

## Purpose

Verify that a release owner can use the public OpenKit App API through Core Client to start one bounded Task Mode request whose real OpenShell/Codex worker spawns exactly two runtime-internal sub-agents while NanoCore preserves one outer result, an exact one-root/two-child runtime forest, trusted AEP-bound Gateway attribution, separated cache lineage, cached-token telemetry, and redacted product evidence.

## Preconditions

- NanoCore is already running and reachable from the machine running this story.
- `@openkit/core-client`, `@openkit/app-api-schemas`, and `nanocore` build outputs exist.
- A disposable git repository exists at a path visible to the NanoCore process.
- The local NanoCore data root owns the default server OAuth slot; the runner streams `/home/ubuntu/.codex/auth.json` from A1 only when that server-owned `0600` account file is absent. The worker never receives the auth JSON.
- The target uses the repository-pinned OpenShell and Codex versions and advertises both `trusted-worker-inference-relay` and `worker.runtime-provenance.v1` only after their same-target executable probe has passed.
- The story is skipped by default because it may consume real Codex subscription capacity and provider quota.

## Required Opt-in Environment Variables

- `OPENKIT_L6_TASK_REAL_WORKER=1` enables this real Task Mode runner.
- `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1` confirms the operator accepts provider or subscription usage.
- `OPENKIT_L6_TASK_NANOCORE_URL` points to the existing NanoCore endpoint.
- `OPENKIT_L6_NANOCORE_DATA_ROOT` points to the local data root owned by that NanoCore process.
- `OPENKIT_L6_TASK_REPO_ROOT` points to the disposable git repository as seen by NanoCore.
- `OPENKIT_L6_TASK_WORKER_IMAGE_REF` identifies the exact A1-built worker image used by the target Cell.
- `OPENKIT_L6_EVIDENCE_DIR` points to a writable directory for redacted evidence.

## Setup

- Build NanoCore, App API schemas, and Core Client before running the story.
- Start or reuse NanoCore with the real OpenShell worker backend configured.
- Let the runner securely materialize the default Codex OAuth account slot, configure `openai_codex` and `agent_codex_host`, and stop for a NanoCore restart when strict reload requires one.
- Confirm NanoCore reports that it is accepting product work, exposes `openai_codex`, and has no blocked provider diagnostics before consuming provider quota.
- Run the Core Client runner from an environment that can reach the NanoCore endpoint and repository path. The runner creates a dedicated acceptance workspace before creating the thread or linking the repository.

## User-visible Steps

1. Read NanoCore status through Core Client.
2. Create a release validation thread.
3. Link the disposable repository.
4. Start Task Mode through the public App API with one bounded repository workload that explicitly delegates two independent inspections to exactly two Codex sub-agents and asks the root worker to synthesize one outer result.
5. Read the Task Mode thread, turn AEP, capability usage, and RuntimeEvidence after the attempt returns.
6. Reject any workspace review returned by the bounded workload as cleanup rather than as a provenance acceptance oracle.
7. Record the Task Mode state, worker selection, AEP summary, forest counts, correlation counts, and cache telemetry.

## Expected Outcomes

- The public Task Mode operation returns a Task Mode response rather than a hidden local execution path.
- The response includes a Workflow Coordinator Task Mode decision with a selected worker.
- The returned state is `completed` or `needs-review`; non-terminal, blocked, failed, human-gated, and escalated states cannot satisfy this completed-turn acceptance story.
- The thread contains visible Task Mode items.
- The thread contains exactly one completed outer assistant message from the real worker path; runtime-internal child messages do not become canonical OpenKit items.
- The turn has exactly one AEP snapshot shared by every worker Gateway call, with OpenShell, Codex, direct NanoCore control, the exact A1-built image supplied through `OPENKIT_L6_TASK_WORKER_IMAGE_REF`, provider `openai_codex`, model `openai-codex/gpt-5.6-sol`, one placeholder NanoCore Gateway route, no credential or vault projection, no secret visibility, and both trusted relay and runtime provenance capabilities.
- RuntimeEvidence identifies the actual backend as OpenShell 0.0.80 and reports exactly one root, exactly two children, four or more retained streams, exactly three distinct runtime origins, and complete reconciliation of at least three authenticated worker Gateway calls.
- Every reconciled worker LLM call is bound to one AEP snapshot, has a unique request id, carries opaque runtime-origin and runtime-cache-lineage refs, and links to provider usage telemetry.
- The run contains exactly three distinct runtime origins and at least two cache lineages; positive cached-input token rows remain queryable when the provider reports them, while absence means zero or unreported and is recorded instead of treated as a cache failure.
- The public surfaces and written evidence do not contain raw runtime ids, raw prompt-cache keys, Codex turn metadata, OAuth tokens, bearer tokens, cookies, authorization headers, or Codex auth JSON content.

## Deterministic Assertions

- The selected story metadata requires real provider and real Codex execution.
- NanoCore status and runtime diagnostics are readable before mutation, and runtime diagnostics report that the target accepts product work.
- A dedicated acceptance workspace is created through the public App API before thread creation and repository linking.
- Repository linking succeeds for the provided repository path.
- The public Task Mode operation returns a raw payload with a turn id and accepted Task Mode state.
- Core Client thread reads return at least one item for the Task Mode thread.
- Core Client thread reads return exactly one completed assistant-message item for the outer Task Mode turn.
- The public turn AEP is the single snapshot named by all worker Gateway calls, uses the required trusted OpenShell/Codex/Gateway configuration, and projects no credentials or secrets.
- Public RuntimeEvidence reports backend type `openshell`, backend version `0.0.80`, at least four streams, exactly one root, exactly two children, exactly three distinct runtime origins, and complete reconciliation for at least three Gateway calls.
- Capability usage contains one package-scoped terminal worker-inference Gateway call per reconciled Gateway call, exactly three opaque runtime-origin refs, at least two opaque cache-lineage refs, non-empty unique request ids, authoritative outer lineage, provider usage for succeeded calls, and positive `cache_read` token telemetry when the provider exposes it.
- A leak scan over thread items, AEP snapshots, RuntimeEvidence, capability usage, and written reports rejects runtime-native metadata and credential material.

## Evidence To Collect

- Story metadata, final assertion summary, and an owner-only structured failure record when the run fails.
- NanoCore base URL with token material omitted.
- Workspace id, thread id, Task Mode state, worker target, AEP summary, exact forest counts, opaque correlation counts, cached-input token total, and review cleanup count.
- Redaction notes describing the secret classes that were not preserved.

## Cleanup

- Preserve evidence only after redaction checks pass.
- Reject any workspace review returned by the bounded workload before preserving the final result.

## Failure Triage Notes

If the story fails because opt-in variables, Codex auth setup, NanoCore reachability, or repository visibility are missing, classify it as an environment failure.

If the story reaches NanoCore but Task Mode does not launch through Workflow Coordinator or loses evidence visibility, reduce the defect into the lowest practical L1-L5 regression test.

If the story creates the wrong number of runtime children, loses AEP-bound Gateway attribution, collapses cache lineages, loses the outer result, or exposes restricted metadata, classify it as a product defect and preserve only redacted evidence.
