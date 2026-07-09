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
title: Complete a local worker turn from the Web UI
persona: Product evaluator using a clean local OpenKit workspace
entrypoint: web
default_tool: playwright
timeout_seconds: 300
requires_real_provider: false
requires_real_codex: false
---
```

The body should include purpose, preconditions, setup, user-visible steps, expected outcomes, deterministic assertions, evidence to collect, cleanup, and failure triage notes.

Long stories should include checkpoints so an executor can collect evidence before the final outcome.

## Execution Model

A story with a matching adapter in `tests/story-runner/` is deterministic and can run through `pnpm -w test:stories` or `pnpm -w test:stories:deterministic`.

A story without a matching adapter is an agentic story candidate. An AI agent may execute it manually or through a future agentic runner by reading the Markdown and operating the visible UI.

Do not generate or commit a deterministic adapter as a side effect of running an agentic story.

When a story becomes stable, high-value, and cheap enough to repeat, add a deterministic adapter as a normal reviewed code change.

The real Codex Goal Mode story has a manual preflight command:

```bash
pnpm -w test:stories:real-codex
```

The command skips by default and requires explicit real Codex plus provider quota opt-in before it writes evidence setup files.

The real OpenShell/Codex Task Mode story has a manual runner:

```bash
pnpm -w test:stories:real-task-mode
```

The command skips by default and requires explicit real worker plus provider quota opt-in before it calls an existing NanoCore deployment.

The real pi-ai provider gateway story has a manual runner:

```bash
pnpm -w test:stories:real-provider
```

The command skips by default and requires explicit real provider plus provider quota opt-in before it calls an existing NanoCore deployment.

For agentic-only story edits, run `pnpm -w check:repo` at minimum and make sure the story metadata still matches the required shape.

The deterministic MCP stories have a direct command:

```bash
pnpm -w test:stories:mcp
```

## Authoring Rules

- Write stories in English Markdown.
- Keep user-visible steps focused on product behavior, not implementation internals.
- Put technical bootstrapping in `Setup`, not in the user-visible flow.
- Use fake secret markers only, never real credentials or private account data.
- Mark real-provider stories with `requires_real_provider: true`.
- Mark real-Codex or real-subscription stories with `requires_real_codex: true`.
- Keep deterministic assertions machine-checkable whenever practical.
- Require every confirmed deterministic L6 defect to be reduced into L1-L5 regression coverage.

## Current Stories

- `chat-mode-mcp-smoke.story.md`: deterministic MCP-backed Chat Mode acceptance flow covering knowledge-backed answers, bounded clarification, read-only repository file-list and file-read answers, Action Center projection, Task Mode handoff, and Goal Mode handoff.
- `goal-mode-real-codex-release.story.md`: agentic-only opt-in release validation for a real Codex Goal Mode run against a disposable local repository.
- `goal-mode-mcp-smoke.story.md`: deterministic MCP-backed Goal Mode acceptance flow covering status, diagnostics, repository linking, plan approval, one bounded step, Action Center, evidence, and artifact reads.
- `openkit-local-self-check.story.md`: deterministic local Web/NanoCore self-check flow backed by `tests/story-runner/openkit-local-self-check.spec.ts`.
- `pi-ai-gateway-real-provider.story.md`: opt-in real-provider validation for NanoCore public gateway routing through pi-ai, backed by `tests/story-runner/pi-ai-real-provider-runner.mjs`.
- `recovery-mcp-smoke.story.md`: deterministic MCP-backed recovery acceptance flow covering interrupted worker reads, pending input edit/follow-up/cancel, and checkpoint retry.
- `task-mode-real-worker-release.story.md`: opt-in MCP-backed real OpenShell/Codex Task Mode validation against an existing NanoCore deployment and disposable repository.
- `task-mode-mcp-smoke.story.md`: deterministic MCP-backed Task Mode acceptance flow covering `openkit.start_task`, bounded self-check work, Action Center gates, artifact completion, and Task-to-Goal escalation.
- `worker-mcp-governed-tool-use.story.md`: agentic-only Worker MCP acceptance story covering governed tool calls, approval-required tools, audit evidence, usage rows, and credential redaction.
- `workspace-portability-release.story.md`: deterministic MCP-backed release acceptance story covering workspace export, cross-deployment import, repository re-binding, lineage evidence, and redaction checks, with vault reference re-binding retained for the full agentic seeded path.
