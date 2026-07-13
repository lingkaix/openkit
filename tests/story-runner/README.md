# Story Runner

This directory contains deterministic executable adapters for OpenKit L6 story acceptance tests.

The detailed L6 design is documented in `docs/specs/20260529-l6_story_acceptance.md`.

Stories live under `tests/stories/` as versioned Markdown artifacts with scalar front matter.

The default runners use Playwright for the visible Web UI story and the OpenKit MCP facade for deterministic Goal Mode, Task Mode, Chat Mode, workspace portability, and recovery stories without external provider quota. Separate opt-in runners exercise real providers and workers only after explicit quota acknowledgement.

Future runners may add an `executor: agentic` path that lets an AI agent operate the same story contract through Playwright or Chrome DevTools MCP.

Any defect discovered by an L6 story must be reduced into the lowest-layer deterministic regression test that can catch it: L1 unit, L2 contract, L3 NanoCore black-box e2e, L4 Web browser e2e, or L5 smoke.

## How It Works

Deterministic adapters read a story file, validate the front matter, start the required isolated environment, operate the declared product entrypoint, and attach or write a story assertion summary.

The current local stack helper starts built NanoCore with a disposable data root and runs Web against it on a dynamic localhost port.

The story body remains the acceptance contract. The adapter is only the deterministic execution path for stories that are stable enough to automate.

## Commands

Run all deterministic story acceptance checks from the workspace root:

```bash
pnpm -w test:stories
```

Run the explicit deterministic alias:

```bash
pnpm -w test:stories:deterministic
```

Run the Web package story suite directly:

```bash
pnpm --filter @openkit/web e2e:stories
```

Run the deterministic MCP stories directly:

```bash
pnpm -w test:stories:mcp
```

Run parser tests only when changing story metadata parsing:

```bash
node --test tests/story-runner/story-metadata.test.mjs
```

Run the real Codex Goal Mode L6 kernel story manually against an existing NanoCore deployment:

```bash
pnpm --filter @openkit/core-client build
pnpm --filter @openkit/mcp build
pnpm -w test:stories:real-codex
```

That command is skipped by default.

It executes only when `OPENKIT_L6_REAL_CODEX=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_L6_NANOCORE_URL`, `OPENKIT_L6_NANOCORE_DATA_ROOT`, `OPENKIT_L6_GOAL_REPO_ROOT`, and `OPENKIT_L6_EVIDENCE_DIR` are set. `OPENKIT_NANOCORE_TOKEN` is also required when the deployment requires bearer authentication.

The runner must execute on the NanoCore data-root host, have `codex app-server` available there for the account-status probe, have non-interactive `ssh a1` access, and use a clean disposable repository with one baseline commit. Its first invocation securely creates the server-owned `0600` OAuth account file when absent and writes only necessary provider or agent config changes. The complete OAuth path must stay inside the NanoCore data root without symbolic links, and an existing auth file must be a single-linked regular file owned by the runner user with mode `0600`. Runtime provider and agent files are compared with JSONC semantics. A strict provider or agent restart requirement stops before MCP execution, provider quota, or evidence and instructs the operator to restart NanoCore and rerun. The rerun verifies `logged_in` through the public OAuth status, reuses canonical config, consumes only the lazy `workspaceDataSources` deferral when present, then requires a strict dry-run no-op before running the public MCP Goal flow. The CLI executes the story in a detached Unix process group, kills the complete group at the committed story deadline, and lets only the parent process create the exclusive `0600` failure evidence. Every run requires a direct evidence directory with no existing fixed output. It never copies Codex auth into the worker sandbox.

Run the real pi-ai provider gateway L6 runner manually:

```bash
pnpm -w test:stories:real-provider
```

That command is skipped by default.

It writes redacted evidence only when `OPENKIT_L6_REAL_PROVIDER=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_L6_GATEWAY_BASE_URL`, `OPENKIT_L6_GATEWAY_PROVIDER_ID`, `OPENKIT_L6_GATEWAY_MODEL`, `OPENKIT_L6_GATEWAY_WORKSPACE_ID`, and `OPENKIT_L6_EVIDENCE_DIR` are set.

Run the real OpenShell/Codex Task Mode L6 runner manually:

```bash
pnpm -w test:stories:real-task-mode
```

That command is skipped by default.

It writes redacted evidence only when `OPENKIT_L6_TASK_REAL_WORKER=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_L6_TASK_NANOCORE_URL`, `OPENKIT_L6_TASK_REPO_ROOT`, and `OPENKIT_L6_EVIDENCE_DIR` are set. The target deployment, not the runner process, owns real Codex credential setup.

If the local sandbox cannot bind localhost or launch Chromium, rerun the affected command in a permitted environment before changing product code.

## Files

- `story-metadata.mjs`: scalar front matter parser and metadata validator.
- `story-metadata.test.mjs`: parser and validator tests.
- `real-codex-goal-mode-runner.mjs`: opt-in MCP-first real Codex Goal kernel runner for server-owned OAuth setup, strict provider and agent config, hard process supervision, review-gated workspace application, Goal completion, AEP boundaries, capability usage, audit, runtime evidence, git assertions, and redaction.
- `real-codex-goal-mode-runner.test.mjs`: opt-in, secure SSH streaming and path handling, exclusive evidence creation, process-group deadline, complete MCP and Core Client flow, evidence linkage, repository, and leak-guard coverage for the real Goal kernel runner.
- `pi-ai-real-provider-runner.mjs`: opt-in real provider gateway L6 runner for public Chat Completions, streaming, capability usage evidence, and redaction checks against an existing NanoCore deployment.
- `pi-ai-real-provider-runner.test.mjs`: skip, opt-in, story metadata, fake gateway, and evidence-file coverage for the real provider runner.
- `task-mode-real-worker-runner.mjs`: opt-in real OpenShell/Codex Task Mode L6 runner that verifies pinned-backend RuntimeEvidence, the runtime forest, trusted worker-inference CapabilityCall lineage, cache routing, usage and audit linkage, automatic evidence bundles, one canonical outer result, and public-surface redaction against an existing NanoCore deployment.
- `task-mode-real-worker-runner.test.mjs`: skip, opt-in, story metadata, prerequisite, provenance, cache, telemetry, and leak-guard coverage for the real Task Mode runner.
- `goal-mode-mcp-smoke-runner.mjs`: deterministic Goal Mode MCP story runner that wraps the existing NanoCore MCP smoke.
- `goal-mode-mcp-smoke-runner.test.mjs`: story validation and environment coverage for the deterministic MCP story runner.
- `task-mode-mcp-smoke-runner.mjs`: deterministic Task Mode MCP story runner for bounded self-check work, Action Center gates, artifact completion, and Task-to-Goal escalation through `openkit.start_task`.
- `task-mode-mcp-smoke-runner.test.mjs`: story validation and environment coverage for the deterministic Task Mode MCP runner.
- `chat-mode-mcp-smoke-runner.mjs`: deterministic Chat Mode MCP story runner for knowledge-backed answers, clarification gates, read-only repository file-list and file-read answers, Action Center projection, Task Mode handoff, and Goal Mode handoff.
- `chat-mode-mcp-smoke-runner.test.mjs`: story validation and environment coverage for the deterministic Chat Mode MCP runner.
- `workspace-portability-mcp-runner.mjs`: deterministic workspace portability MCP story runner for export, cross-data-root import, repository re-binding, lineage, and redaction checks.
- `workspace-portability-mcp-runner.test.mjs`: story validation coverage for the deterministic workspace portability MCP runner.
- `recovery-mcp-smoke-runner.mjs`: deterministic Recovery MCP story runner for interrupted worker reads, pending input edit/follow-up/cancel, and checkpoint retry.
- `recovery-mcp-smoke-runner.test.mjs`: story validation and build-output coverage for the deterministic Recovery MCP runner.
- `web-stack.mjs`: isolated local NanoCore and Web stack helper.
- `openkit-local-self-check.spec.ts`: deterministic adapter for `tests/stories/openkit-local-self-check.story.md`.
