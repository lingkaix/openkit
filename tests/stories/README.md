# L6 Stories

This directory contains versioned Markdown story artifacts for OpenKit L6 story acceptance.

Stories describe realistic user-intent workflows. They are not executable test code by themselves.

The detailed L6 model is documented in `docs/specs/20260529-l6_story_acceptance.md`.

## File Shape

Story files use the `*.story.md` suffix.

Each story must start with scalar front matter that the story runner can parse without a YAML dependency:

```yaml
---
id: story-web-local-turn
title: Inspect a local workspace from the Web UI
persona: Product evaluator using a clean local OpenKit workspace
entrypoint: web
default_tool: playwright
timeout_seconds: 300
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20260628-web_product_surface_projection.md, docs/core/vault.md
---
```

`contracts` is one comma-separated scalar line naming the owning Core and specification documents whose behavior the story accepts.

The front matter is scalar key-value lines with a closed field set, not YAML. The L6 specification owns the one-step switch trigger to a real YAML parser; do not add partial YAML syntax to the scalar parser.

The body section list is normative and owned by `docs/specs/20260529-l6_story_acceptance.md`. Required sections: `Purpose`, `Preconditions`, `User-visible Steps`, `Expected Outcomes`, `Deterministic Assertions`, and `Failure Triage Notes`. Allowed when needed: `Setup`, `Required Opt-in Environment Variables`, `Evidence To Collect`, and `Cleanup`. No other body section is allowed.

Long stories should name intermediate capture points inside `Evidence To Collect` so the orchestrator collects evidence before the final outcome.

## Execution Model

A story with a matching adapter in `tests/story-runner/` is deterministic and can run through `pnpm -w test:stories` or `pnpm -w test:stories:deterministic`.

A story without a matching adapter is an agentic story candidate. An AI agent may execute it manually or through a future agentic runner by reading the Markdown and operating the visible UI.

Do not generate or commit a deterministic adapter as a side effect of running an agentic story.

When a story becomes stable, high-value, and cheap enough to repeat, add a deterministic adapter as a normal reviewed code change.

The real OpenShell/Codex Task Mode story has a manual runner:

```bash
pnpm -w test:stories:real-task-mode
```

The command skips by default and requires explicit real worker plus provider quota opt-in, an existing NanoCore URL and local data root, an exact A1-built worker image reference, a clean disposable repository, and a writable evidence directory. It creates a dedicated acceptance workspace and exercises the public App API through Core Client.

The A1 NanoCore restart reconnection story has a manual runner:

```bash
pnpm -w test:stories:a1-restart
```

The command skips by default and requires `OPENKIT_L6_A1_RESTART=1`, `OPENKIT_L6_ALLOW_PROVIDER_QUOTA=1`, a fresh `OPENKIT_L6_NANOCORE_DATA_ROOT`, and a disposable repository at `OPENKIT_L6_TASK_REPO_ROOT`. The runner directly kills and restarts only local NanoCore, waits for completion through the public API, and compares the public backend handle before and after restart. The externally managed stock OpenShell Gateway stays available throughout the run without a fork or patch.

The real pi-ai provider gateway story has a manual runner:

```bash
pnpm -w test:stories:real-provider
```

The command skips by default and requires explicit real provider plus provider quota opt-in before it calls an existing NanoCore deployment.

For agentic-only story edits, run `pnpm -w check:repo` at minimum; it validates every story against the normative schema through `scripts/validate-story-schema.mjs`: the closed front matter field set, contract-reference existence, repository-unique ids, and the body section list.

## Authoring Rules

- Write stories in English Markdown.
- Keep user-visible steps focused on product behavior, not implementation internals.
- Put technical bootstrapping in `Setup`, not in the user-visible flow.
- Use fake secret markers only, never real credentials or private account data.
- Mark real-provider stories with `requires_real_provider: true`.
- Mark real-Codex or real-subscription stories with `requires_real_codex: true`.
- Keep deterministic assertions machine-checkable whenever practical, and make each assertion name the evidence or product record that decides it.
- Do not write verdict-shaped assertions such as "the run executes and passes"; execution and skip semantics are owned by the L6 specification.
- Declare the owning contract documents in the `contracts` front matter line.
- Require every confirmed deterministic L6 defect to be reduced into L1-L5 regression coverage.

## Current Stories

- `nanocore-restart-reconnection.story.md`: opt-in Core Client acceptance story for one real remote OpenShell/Codex Task that reconnects, completes, and cleans its original public backend handle after a local NanoCore restart.
- `openkit-agent-skill-progressive-discovery.story.md`: agentic-only real Codex acceptance flow proving progressive Skill loading, CLI operation discovery and description, one workspace mutation, and durable public readback without MCP or a dedicated runner.
- `openkit-local-self-check.story.md`: deterministic local Web/NanoCore Workspace, Thread, and diagnostics self-check backed by `tests/story-runner/openkit-local-self-check.spec.ts`.
- `pi-ai-gateway-real-provider.story.md`: opt-in real-provider validation for NanoCore public gateway routing through pi-ai, backed by `tests/story-runner/pi-ai-real-provider-runner.mjs`.
- `task-mode-real-worker-release.story.md`: opt-in App API and Core Client real OpenShell/Codex Task Mode validation against an existing NanoCore deployment and disposable repository.
- `worker-mcp-governed-tool-use.story.md`: agentic-only Worker MCP acceptance story covering governed tool calls, approval-required tools, audit evidence, usage rows, and credential redaction.
