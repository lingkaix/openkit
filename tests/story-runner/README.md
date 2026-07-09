# Story Runner

This directory contains deterministic executable adapters for OpenKit L6 story acceptance tests.

The detailed L6 design is documented in `docs/specs/20260529-l6_story_acceptance.md`.

Stories live under `tests/stories/` as versioned Markdown artifacts with scalar front matter.

The current runners use Playwright for the visible Web UI story and the OpenKit MCP facade for the deterministic Goal Mode, Task Mode, Chat Mode, workspace portability, and recovery stories. They do not call an external AI model, require real Codex credentials, or use provider quota.

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

Run the real Codex Goal Mode L6 preflight manually:

```bash
pnpm -w test:stories:real-codex
```

That command is skipped by default.

It writes preflight evidence and redaction notes only when `OPENKIT_L6_REAL_CODEX=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_L6_GOAL_REPO_ROOT`, and `OPENKIT_L6_EVIDENCE_DIR` are set.

If `OPENKIT_L6_CODEX_OAUTH_ACCOUNT_DIR` is omitted, it uses `/Users/m5pro/nano-data/server/files/oauth/openai-codex/accounts/default` for this developer machine.

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

It writes redacted evidence only when `OPENKIT_L6_TASK_REAL_WORKER=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, `OPENKIT_L6_TASK_NANOCORE_URL`, `OPENKIT_L6_TASK_REPO_ROOT`, `OPENKIT_L6_TASK_CODEX_AUTH_JSON`, and `OPENKIT_L6_EVIDENCE_DIR` are set.

If the local sandbox cannot bind localhost or launch Chromium, rerun the affected command in a permitted environment before changing product code.

## Files

- `story-metadata.mjs`: scalar front matter parser and metadata validator.
- `story-metadata.test.mjs`: parser and validator tests.
- `real-codex-goal-mode-runner.mjs`: opt-in real Codex Goal Mode L6 preflight runner that records evidence setup without running in default gates.
- `real-codex-goal-mode-runner.test.mjs`: skip, opt-in, default account-slot, and evidence-file coverage for the real Codex preflight path.
- `pi-ai-real-provider-runner.mjs`: opt-in real provider gateway L6 runner for public Chat Completions, streaming, capability usage evidence, and redaction checks against an existing NanoCore deployment.
- `pi-ai-real-provider-runner.test.mjs`: skip, opt-in, story metadata, fake gateway, and evidence-file coverage for the real provider runner.
- `task-mode-real-worker-runner.mjs`: opt-in real OpenShell/Codex Task Mode L6 runner against an existing NanoCore deployment.
- `task-mode-real-worker-runner.test.mjs`: skip, opt-in, story metadata, and prerequisite coverage for the real Task Mode runner.
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
