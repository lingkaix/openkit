# OpenKit Development Loop Protocol

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the development-loop protocol for improving OpenKit through OpenKit's own public coordination surfaces.

It owns the roles, lifecycle, approval gates, evidence requirements, fallback classification, local-first topology, optional remote verification topology, and completion criteria for coordinator-driven OpenKit self-improvement work.

## Does Not Own

This spec does not own general Agent Workflow mechanisms, user-facing work vocabulary, MCP tool schemas, worker-control protocol details, workspace synchronization mechanics, agent environment packaging, authentication internals, deployment runbooks, or repository change-record storage policy.

Those contracts are owned by the relevant core documents, protocol specs, runtime specs, and `docs/change-tracking.md`.

## Core References

- `docs/core/agent-workflow.md`
- `docs/core/work-model.md`
- `docs/core/agent-capability.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/agent-session.md`
- `docs/core/architecture.md`

## Summary

OpenKit development should dogfood OpenKit itself through a bounded, review-gated loop that uses the OpenKit AI Interface MCP channel, NanoCore workflow state, Human Attention Action Center, artifacts, evidence bundles, repository lifecycle records, GitHub synchronization, and an optional independent verifier environment.

The protocol defines a local-first coordinator model for improving OpenKit with OpenKit, with a remote verifier used only when independent-machine, server-mode, deployment-shape, or backup-execution evidence is required.

This is a concrete development-loop recipe over the Core Agent Workflow mechanisms. It is not the canonical definition of Agent Workflow, Goal Mode, MCP, Action Center, workspace synchronization, or change-record governance.

## Current Implementation Projection

The current implementation supports the accepted V1 protocol through `@openkit/mcp`, NanoCore Goal Mode, Action Center reads and resolution, artifact and evidence surfaces, workspace synchronization review surfaces, repository diagnostics, local NanoCore execution, scoped server-mode MCP authentication, GitHub branch synchronization, and approval-gated GitHub push records and execution.

The current posture is review-gated dogfooding, not unattended automation. The coordinator should run one bounded step at a time, review Action Center and evidence after each step, record MCP or NanoCore bypasses as product gaps, and ask the human before commits, pushes, releases, backend restarts, or external side effects.

The remaining work is outside the accepted V1 development-loop protocol: unattended automation, richer remote-verifier UX, broader server-mode release automation, complete runtime-recovery polish, deeper audit labeling, and workspace synchronization recovery hardening.

## Goals

- Define the default development loop for material OpenKit self-improvement work.
- Use the developer machine as the default coordinator environment for human interaction, MCP operation, local NanoCore validation, change records, code edits, commits, and GitHub branch management.
- Use the same machine for ordinary OpenKit self-improvement loops when local NanoCore, local checks, and human review provide enough evidence.
- Use a maintainer-provided remote verifier server as an optional runtime and verifier environment for server-mode validation, reproducibility checks, independent Codex review, and backup execution when the loop needs evidence that cannot be produced locally.
- Keep NanoCore as the source of truth for Goal Mode state, worker execution, Action Center rows, artifacts, and evidence.
- Keep the MCP server as a thin AI-native user interface over public NanoCore APIs.
- Preserve coordinator context by pushing concrete work into NanoCore, sub-agents, or remote Codex sessions instead of forcing the loop manager to carry all implementation detail in one conversation.
- Make local mode the default proof path for coordinator-driven self-improvement, and require server-mode or remote proof only when the changed surface or release gate depends on it.
- Record lifecycle decisions in the current repository lifecycle-record system governed by `docs/change-tracking.md`.

## Non-goals

- Do not build unattended recursive self-modification.
- Do not let MCP become a shell, deployment daemon, generic admin API, worker runtime, or NanoCore internals API.
- Do not bypass Goal Mode plan approval, Action Center review, repository diagnostics, evidence review, or human decisions.
- Do not expose generic commit, deploy, tag, publish, secret inspection, raw environment inspection, SQLite access, `DATA_ROOT` access, process handles, or raw worker checkpoint access through the first loop interface.
- Do not expose generic push as a shell-like MCP action; V1 push is only the approval-gated, GitHub-only `workspace.git.push` contract owned by `docs/specs/20260704-git_write_workflow.md`.
- Do not preserve historical internal loop shapes once the current protocol and implementation have moved on.
- Do not assume remote server mode is complete until authentication, session handling, workspace permissions, and audit behavior are verified through public contracts.

## Background

OpenKit already has the ingredients for a self-improvement loop: Goal Mode for objectives and plans, bounded worker steps, Action Center for human attention, artifact and evidence reads, repository lifecycle records, a standard stdio MCP facade over NanoCore, and Skills that teach desktop agent apps how to operate OpenKit.

The missing part is an accepted development protocol that explains how a coordinator agent, NanoCore, a verifier agent, the local machine, the remote server, GitHub, and human approval interact during real OpenKit development.

## Decision

OpenKit self-improvement work should follow a single-machine-first loop protocol.

The local developer machine is the primary coordinator, execution, and local verification environment.

A remote verifier server is an optional remote runtime and verifier environment.

GitHub is the durable synchronization layer when a second environment, a PR, or a remote verifier participates in the loop.

NanoCore local mode is used for fast no-auth validation on the developer machine.

NanoCore server mode is used locally or on a remote verifier server when the changed surface requires authentication, server deployment, remote operation, or cross-machine proof.

Both machines may use their local Codex login subscription state, including their own installed and logged-in Codex CLI or app state, as the LLM provider for worker execution or verifier execution.

The Codex authentication material, including `auth.json`, remains machine-local credential state and must not be copied into the repository, stored in change records, exposed through MCP, printed into artifacts, or synchronized through GitHub.

## Roles

### Human

The human defines intent, approves Goal Mode plans, approves or rejects Action Center decisions, accepts or rejects evidence, and explicitly authorizes commits, pushes, PRs, provider-quota work, and external side effects.

### Coordinator

The coordinator is the agent application or CLI session that calls the OpenKit MCP server and manages the loop.

The coordinator should conserve its own context.

It should keep only the current objective, next decision, and evidence summary in conversation context.

It should delegate concrete discovery, triage, implementation, verification, and evidence collection to NanoCore through MCP whenever possible.

When MCP or NanoCore cannot perform the required work yet, the coordinator may use a local sub-agent or a remote verifier server as a backup execution path, but the deviation must be recorded in the change record.

The coordinator should treat NanoCore as the dogfood path, not merely as an optional helper.

It should try the public NanoCore or MCP capability first for goal creation, planning, bounded execution, review, evidence, artifacts, and Action Center decisions.

If the coordinator must bypass NanoCore because the product path is missing, broken, unstable, or too narrow, the bypass becomes product evidence.

The change record must classify each bypass as a one-off environment issue, a documentation or setup gap, a public API or MCP surface gap, a runtime reliability gap, or a product workflow gap.

Repeated bypasses or bypasses that affect public workflow, API, data, or recovery semantics should be promoted into a spec, product backlog item, or concrete follow-up change instead of remaining only in the loop record.

### NanoCore

NanoCore owns Goal Mode, worker steps, Action Center, thread state, artifacts, evidence bundles, repository diagnostics, and public App API behavior.

NanoCore must remain the only source of truth for loop state that the MCP channel exposes.

### MCP Server

The OpenKit AI Interface MCP server is a standard stdio interface between the coordinator and NanoCore.

It connects to a configured local or remote NanoCore endpoint.

It does not supervise backend processes, execute arbitrary commands, inspect machine credentials, or mutate repository state outside documented NanoCore public APIs.

### Optional Remote Verifier

The remote verifier is a separate Codex session or equivalent agent, normally running on a maintainer-provided remote verifier server when local evidence is not enough.

It checks out the GitHub branch or PR produced by the coordinator, runs the agreed verifier checklist, validates server-mode behavior where applicable, and writes its result back to a durable channel such as a PR comment, pushed verifier artifact, or change-record update.

By default, the remote verifier reviews and tests only.

It must not push fixes unless the human explicitly approves a verifier-fix branch.

## Machine Topology

### Developer Machine

The developer machine runs the coordinator agent, the MCP server process, and a local NanoCore backend in local mode.

The local backend is the fast path for proving MCP, Goal Mode, Action Center, artifact, and evidence behavior without server-mode authentication friction.

Ordinary self-improvement loops should stay on this machine when the work can be validated through local NanoCore, repository checks, tests, artifacts, evidence bundles, and human review.

Recommended local mode shape:

```bash
pnpm --filter @openkit/nanocore dev
OPENKIT_NANOCORE_URL=http://127.0.0.1:3000 pnpm --filter @openkit/mcp start
```

### Remote Verifier Server

A remote verifier server runs remote validation only when independent-machine evidence, server-mode proof, deployment-shape proof, or backup execution is required.

It may run NanoCore in server mode, Docker or OpenShell-backed execution, and an independent Codex verifier session.

Each developer or maintainer may provide their own remote verifier server.

Private hostnames, machine-specific ports, credentials, and local tool paths belong in private operator runbooks or environment-specific notes, not in the public development loop protocol.

Recommended server-mode shape:

```bash
OPENKIT_CORE_MODE=server OPENKIT_DATA_ROOT="$PWD/temp/nanocore-data" PORT=54001 pnpm --filter @openkit/nanocore dev
```

Server mode uses Better Auth session behavior for browser-facing product APIs and scoped NanoCore bearer tokens for MCP and remote coordinator use.

MCP authenticates to server mode with `OPENKIT_NANOCORE_TOKEN` per `docs/specs/20260704-remote_auth_credential_bootstrap.md`. The coordinator and verifier must treat the token as machine-local credential material and must not print, store, or synchronize it.

If MCP cannot authenticate to server mode through this documented public contract, the loop must treat that as a product gap rather than bypassing auth.

## GitHub Synchronization

GitHub is the cross-machine state layer for code synchronization when a remote verifier or PR participates.

The coordinator should use a dedicated branch for each material loop run.

The remote verifier should fetch and check out that branch or its PR.

Verifier results should be written back to GitHub, the change record, or another durable repository artifact.

The verifier should not rely on transient terminal output as the only record.

## Loop Lifecycle

### 1. Define The Goal

The coordinator and human define a narrow objective, reviewable stop condition, scope, and non-goals.

The stop condition must be externally checkable from NanoCore state, repository state, GitHub state, test output, or verifier evidence.

### 2. Create Durable Lifecycle Record

For material loop work, the coordinator creates or updates the repository lifecycle record required by `docs/change-tracking.md` before implementation begins.

The change record captures intent, scope, related specs, roles, plan, checkpoints, blockers, verification evidence, deviations, and final summary.

### 3. Start Local Loop

The coordinator connects to local NanoCore through MCP.

It starts by calling `openkit.read_status`, links the OpenKit repository after human confirmation, creates or selects a thread, starts Goal Mode, drafts a plan, presents the plan, and waits for explicit human approval.

### 4. Execute One Bounded Step

After approval, the coordinator calls exactly one bounded worker step through MCP.

After the step, it reads the goal summary, Action Center, relevant thread items, artifacts, and evidence bundle.

It presents evidence to the human before continuing.

### 5. Correct Problems Inside The Loop

If the loop finds a blocker, missing capability, configuration gap, test failure, or design flaw, the coordinator records it in the change record.

If the blocker is small and inside scope, the coordinator may use the same loop to implement or document the fix.

If the blocker changes the architecture or public contract, the coordinator must update or create a spec before implementation proceeds.

If the worker discovers that NanoCore itself must be reconfigured, rebuilt, or restarted, the coordinator must treat that as a controlled loop interruption rather than an ordinary worker continuation.

The coordinator records the reason, current goal id, current task id, Action Center state, pending evidence, and intended restart action in the change record before touching the backend process.

The coordinator then asks the human before stopping, restarting, rebuilding, or reconfiguring NanoCore.

After NanoCore is available again, the coordinator reconnects through MCP, calls `openkit.read_status`, re-reads the repository diagnostics, thread, goal summary, Action Center, and relevant evidence, then resumes from the durable state instead of relying on pre-restart conversation memory.

If the restart loses required state, changes the public API shape, or breaks MCP reconnection, the coordinator marks the loop blocked and records the product gap before attempting further fixes.

### 6. Synchronize To GitHub

When the human approves a code or documentation change, the coordinator runs local checks and commits through host-side development tools or through accepted OpenKit Git workflow surfaces when they apply.

Generic commit operations remain host-side development actions. Publishing through OpenKit is allowed only through the explicit GitHub-only V1 `workspace.git.push` path: `openkit.request_git_push_approval` creates the approval and policy gate, and `openkit.execute_git_push` executes only after that approval is granted.

### 7. Decide Whether Remote Verification Is Required

Remote verification is required when the work changes server-mode behavior, authentication, deployment shape, remote MCP access, worker isolation, or any release gate that explicitly requires independent-machine evidence.

Remote verification is optional for local-only documentation, Skill, UI copy, or narrow local NanoCore changes when local checks and human review are sufficient.

The coordinator records the remote-verification decision and rationale in the change record.

### 8. Verify Remotely When Required

The remote verifier checks out the branch on the selected remote verifier server, starts or connects to server-mode NanoCore where applicable, uses machine-local Codex or provider state available on that server, and runs the verifier checklist.

If server mode fails because of authentication or remote setup gaps, the verifier records the exact failure and the coordinator treats it as a loop finding.

### 9. Human Decision

The coordinator summarizes local evidence, remote evidence if any, Action Center state, test output, and remaining risk.

The human accepts, rejects, asks for refinement, requests another bounded step, approves a verifier-fix branch, or pauses the loop.

### 10. Close The Record

The coordinator closes the same change record with final implementation summary, verification evidence, skipped checks, final decisions, links to commits or PRs, and follow-ups.

## Context Conservation Rules

The coordinator should not carry full implementation transcripts, raw test logs, long diffs, or full artifacts in conversation context.

It should store durable state in NanoCore threads, artifacts, evidence bundles, GitHub, and the repository lifecycle record required by the current documentation governance rules.

It should summarize evidence before asking the human for a decision.

It should use MCP resources and tools to reload current state instead of relying on memory from earlier conversation turns.

It should hand off large implementation or verification subtasks to NanoCore worker steps, sub-agents, or remote Codex sessions.

It should record every backup path that bypasses MCP because those bypasses identify missing OpenKit product capabilities.

## Dogfood Evidence Rules

The development loop exists to validate whether OpenKit can operate real OpenKit work through its own product surfaces.

The coordinator should follow this order:

1. Use NanoCore public capabilities through MCP.
2. If blocked, record the exact missing or broken product capability.
3. Use a narrowly scoped external fallback only to recover control, gather evidence, or implement the smallest in-scope fix.
4. Re-run the affected path through NanoCore after the fix when practical.
5. Promote repeated or structural bypasses into specs, product backlog, or implementation work.

Bypass records belong first in the active repository lifecycle record for the loop.

Runtime evidence should also remain in NanoCore state, Action Center rows, artifacts, and evidence bundles when those surfaces are available.

Design-level bypasses that affect the public loop workflow, App API, MCP contract, data model, verifier model, or recovery behavior should be promoted to `docs/specs/`.

The goal is not to avoid all bypasses during self-development.

The goal is to make every bypass visible enough that OpenKit can learn which product capabilities must become first-class.

## Self-Maintenance Control Plane

The first loop protocol does not require a large self-maintenance API surface.

OpenKit should add self-maintenance capabilities only when Loop 0 or later real loop runs expose concrete blockers.

Preferred first capabilities are read-only diagnostics and narrowly gated recovery actions.

Candidate read-only diagnostics:

- runtime status
- environment configuration summary
- repository diagnostics
- worker readiness
- Goal Mode run health
- Action Center health
- evidence bundle health
- Git push record health

Candidate gated recovery actions:

- retry a failed bounded goal step
- pause or cancel a stuck goal run
- mark a run blocked with a reason
- reload workspace configuration
- revalidate a repository resource

Generic shell execution, secret inspection, deployment mutation, provider credential export, generic commit, and unreviewed repository mutation must remain outside this control plane.

Approval-gated GitHub push is not a generic repository mutation path; it remains governed by the separate Git write workflow contract, Action Center approval, policy decision, provider gate, linkage checks, and durable `GitPushRecord`.

## Verification Requirements

A loop run is not complete until it has evidence for:

- MCP connection to local NanoCore.
- Local repository linking.
- Goal Mode start, plan draft, human plan approval, and one bounded step.
- Action Center read after worker execution.
- Artifact or evidence bundle read.
- Human review decision.
- Change record updates at meaningful checkpoints.
- Local verification checks for changed code or docs.
- GitHub branch or documented reason no branch was needed.
- Remote verifier execution, a documented decision that remote verification is not required, or a precise blocker explaining why remote verification could not complete.
- Server-mode NanoCore verification, a documented decision that server-mode verification is not required, or a precise blocker explaining the missing auth, deployment, or configuration contract.

## Risks And Mitigations

- Risk: the coordinator becomes the real system and NanoCore becomes only a side tool. Mitigation: concrete work should flow through MCP and NanoCore first, and every backup path must be recorded as a product gap.
- Risk: bypasses make the loop appear successful while hiding product gaps. Mitigation: classify every bypass in the change record, re-run through NanoCore after fixes when practical, and promote repeated or workflow-shaping bypasses into specs or product work.
- Risk: server mode is blocked by auth/session handling. Mitigation: treat missing remote MCP auth as a first-class loop finding and implement a public contract rather than bypassing Better Auth.
- Risk: two machines diverge. Mitigation: use the local machine as the default loop environment, use GitHub branches and PRs as the synchronization boundary only when remote verification participates, and require clean worktrees before role handoff.
- Risk: NanoCore self-update interrupts the loop that is controlling the work. Mitigation: treat backend restart or reconfiguration as a controlled loop interruption, persist the current state before the restart, reconnect through MCP, and reload state from NanoCore and the change record before continuing.
- Risk: verifier output is lost in remote terminal state. Mitigation: require verifier results to land in GitHub, a change record, or a repository artifact.
- Risk: self-improvement becomes unbounded. Mitigation: require one bounded worker step at a time, explicit approval gates, Action Center review, and final human decisions.
- Risk: machine-local Codex auth leaks into durable artifacts. Mitigation: use local auth state only on each machine, never copy it, never print it, and never expose it through MCP.

## Rollout / Migration Plan

Current development loops should use this protocol as the active guidance.

Loop runs should start on the developer machine and add a remote verifier server only when the changed surface requires remote verification, server-mode proof, deployment-shape proof, or backup execution.

If a loop discovers blockers, it should fix or document the smallest required gap inside the same review-gated loop.

When the protocol is routine enough for day-to-day use, the operational recipe may be projected into a cookbook without moving the contract out of this spec.

## Links

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/agent-capability.md`
- `docs/product-vision.md`
- `docs/specs/20260617-openkit_ai_interface.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260526-codex_chatgpt_subscription_login.md`
- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260529-l6_story_acceptance.md`
