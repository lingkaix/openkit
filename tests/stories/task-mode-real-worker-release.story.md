---
id: story-task-mode-real-worker-release
title: Verify real OpenShell Codex runtime provenance
persona: Release owner validating governed Codex sub-agent provenance
entrypoint: mcp
default_tool: mcp_stdio
timeout_seconds: 3600
requires_real_provider: true
requires_real_codex: true
---

# Verify Real OpenShell Codex Runtime Provenance

## Purpose

Verify that a release owner can use the OpenKit MCP facade to start one bounded Task Mode request whose real OpenShell/Codex worker spawns exactly two runtime-internal sub-agents while NanoCore preserves one outer result, an exact one-root/two-child runtime forest, a trusted AEP bound to the repository base, one review-gated proof change, successful backend teardown, trusted relay attribution, cache lineage, cached-token telemetry, audit linkage, and redacted product evidence.

## Preconditions

- NanoCore is already running and reachable from the machine running this story.
- `@openkit/mcp`, `@openkit/core-client`, `@openkit/app-api-schemas`, and `nanocore` build outputs exist.
- A disposable git repository exists at a path visible to the NanoCore process.
- The NanoCore worker environment has access to a valid Codex auth JSON through the accepted vault or deployment setup path.
- The target uses the repository-pinned OpenShell and Codex versions and advertises both `trusted-worker-inference-relay` and `worker.runtime-provenance.v1` only after their same-target executable probe has passed.
- The story is skipped by default because it may consume real Codex subscription capacity and provider quota.

## Required Opt-in Environment Variables

- `OPENKIT_L6_TASK_REAL_WORKER=1` enables this real Task Mode runner.
- `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1` confirms the operator accepts provider or subscription usage.
- `OPENKIT_L6_TASK_NANOCORE_URL` points to the existing NanoCore endpoint.
- `OPENKIT_L6_TASK_REPO_ROOT` points to the disposable git repository as seen by NanoCore.
- `OPENKIT_L6_EVIDENCE_DIR` points to a writable directory for redacted evidence.

## Setup

- Build NanoCore and MCP packages before running the story.
- Start or reuse NanoCore with the real OpenShell worker backend configured.
- Confirm NanoCore reports that it is accepting product work before consuming provider quota.
- Confirm the disposable repository has a clean initial git status, has a baseline commit, and does not contain `docs/task-mode-runtime-provenance-proof.md`.
- Run the MCP runner from an environment that can reach the NanoCore endpoint and repository path.

## User-visible Steps

1. Read NanoCore status through MCP.
2. Create a release validation thread.
3. Link the disposable repository.
4. Start Task Mode through `openkit.start_task` with one bounded repository change request that explicitly delegates two independent inspections to exactly two Codex sub-agents, creates only `docs/task-mode-runtime-provenance-proof.md` with exactly three Markdown bullet lines, and makes no commit.
5. Read the Task Mode thread after the attempt returns.
6. Read Action Center for pending review, approval, or question rows.
7. Read the turn AEP through MCP, and read the returned workspace review and backend workspace handle through Core Client.
8. Read capability usage plus the public EvidenceBundle, RuntimeEvidence, and audit ledgers.
9. Reject the single pending workspace review through Core Client.
10. Record the Task Mode state, worker selection, AEP and provenance assertion summaries, evidence ids, workspace review id, cleanup evidence, and final git status.

## Expected Outcomes

- `openkit.start_task` returns a Task Mode response rather than a hidden local execution path.
- The response includes a Workflow Coordinator Task Mode decision with a selected worker.
- The returned state is `completed` or `needs-review`; non-terminal, blocked, failed, human-gated, and escalated states cannot satisfy this completed-turn acceptance story.
- The thread contains visible Task Mode items.
- The thread contains exactly one completed outer assistant message from the real worker path; runtime-internal child messages do not become canonical OpenKit items.
- The turn has exactly one AEP snapshot shared by every worker Gateway call, with OpenShell, Codex, direct NanoCore control, image `openkit/worker-codex:dev`, provider `openai_codex`, model `openai-codex/gpt-5.5`, one placeholder NanoCore Gateway route, no credential or vault projection, no secret visibility, and both trusted relay and runtime provenance capabilities.
- The AEP has exactly one read-write Git workspace input whose source commit equals the repository baseline commit.
- RuntimeEvidence identifies the actual backend as OpenShell 0.0.80 and reports exactly one root, exactly two children, four or more retained streams, exactly three distinct runtime origins, and complete reconciliation of at least three authenticated worker Gateway calls.
- RuntimeEvidence contains exactly one successful terminal teardown record for the authoritative worker session.
- The two automatic provenance bundles are linked from RuntimeEvidence, the restricted bundle exposes no raw refs through the ordinary read, and the normalized bundle exposes only its product-safe index ref.
- Every reconciled worker LLM call is bound to one AEP snapshot, has a unique request id, carries opaque runtime-origin and runtime-cache-lineage refs, and links to usage and successful audit rows.
- The run contains exactly three distinct runtime origins and at least two cache lineages; positive cached-input token rows remain queryable when the provider reports them, while absence means zero or unreported and is recorded instead of treated as a cache failure.
- The returned evidence exposes exactly one pending workspace review linked to an artifact and one change set based on the initial repository commit.
- The review adds only `docs/task-mode-runtime-provenance-proof.md`, reports one changed file with three additions and no deletions, and contains exactly three added Markdown bullet lines.
- The review change set has exactly one matching backend workspace handle whose cleanup status is `cleaned`.
- Rejecting the review records a rejected decision and leaves the repository clean at the unchanged initial commit.
- The public ledgers and written evidence do not contain raw runtime ids, raw prompt-cache keys, Codex turn metadata, OAuth tokens, bearer tokens, cookies, authorization headers, or Codex auth JSON content.

## Deterministic Assertions

- The selected story metadata requires real provider and real Codex execution.
- `openkit.start_task` is present in the MCP tool list.
- NanoCore status and runtime diagnostics are readable before mutation, and runtime diagnostics report that the target accepts product work.
- Repository linking succeeds for the provided repository path.
- `openkit.start_task` returns a raw Task Mode payload with a turn id and accepted Task Mode state.
- `openkit.read_thread` returns at least one item for the Task Mode thread.
- `openkit.read_thread` returns exactly one completed assistant-message item for the outer Task Mode turn.
- The initial repository is clean, has a baseline commit, passes `git diff --check`, and does not already contain the proof path.
- The public turn AEP is the single snapshot named by all worker Gateway calls, uses the required trusted OpenShell/Codex/Gateway configuration, projects no credentials or secrets, and binds its sole read-write Git input to the exact baseline commit.
- Public RuntimeEvidence reports backend type `openshell`, backend version `0.0.80`, at least four streams, exactly one root, exactly two children, exactly three distinct runtime origins, complete reconciliation for at least three Gateway calls, and exactly one successful terminal teardown record.
- The public EvidenceBundle ledger contains the linked promoted restricted and normalized bundles while exposing no restricted raw ref.
- Capability usage contains one package-scoped successful worker-inference Gateway call per reconciled Gateway call, exactly three opaque runtime-origin refs, at least two opaque cache-lineage refs, non-empty unique request ids, authoritative outer lineage, linked usage rows, and positive `cache_read` token telemetry when the provider exposes it.
- Workspace audit contains one successful event linked to every provenance-attributed capability call.
- Core Client reads exactly one returned pending workspace review and one matching cleaned backend workspace handle; the review proves the exact base commit, proof path, and three-line addition.
- Core Client rejects the review, after which the repository passes `git diff --check`, has an empty short status, and remains at the initial commit.
- A leak scan over thread items, AEP snapshots, workspace review data, backend handles, evidence bundles, RuntimeEvidence, capability usage, audit events, and written reports rejects runtime-native metadata and credential material.

## Evidence To Collect

- Story metadata and final assertion summary.
- NanoCore base URL with token material omitted.
- Workspace id, thread id, Task Mode state, worker target, evidence item ids, artifact ids, the single review id, AEP summary, Action Center item count, exact forest counts, opaque correlation counts, cached-input token total, linked bundle ids, backend handle cleanup count, teardown evidence count, and review rejection status.
- Redacted final git status output and unchanged-HEAD assertion for the disposable repository.
- Redaction notes describing the secret classes that were not preserved.

## Cleanup

- Preserve evidence only after redaction checks pass.
- Reject the pending workspace review before preserving the final result.
- Confirm the disposable repository is clean and still points to its initial commit before deleting it after the release validation session.

## Failure Triage Notes

If the story fails because opt-in variables, Codex auth setup, NanoCore reachability, or repository visibility are missing, classify it as an environment failure.

If the story reaches NanoCore but Task Mode does not launch through Workflow Coordinator or loses evidence visibility, reduce the defect into the lowest practical L1-L5 regression test.

If the story creates the wrong number of runtime children, loses AEP/base lineage, stages any path outside the proof file, fails backend or teardown cleanup, or leaves repository changes after review rejection, classify it as a product defect and preserve only redacted evidence.
