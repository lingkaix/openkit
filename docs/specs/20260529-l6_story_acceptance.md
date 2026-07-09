# L6 Story Acceptance Testing

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the L6 story acceptance layer, including story artifact structure, deterministic story adapters, future agentic story execution, evidence expectations, metadata rules, and the rule that confirmed L6 defects must reduce into L1-L5 regression coverage.

## Does Not Own

This spec does not own the full L0-L6 test strategy, Web UI component design, NanoCore test harness implementation, provider credentials, release gate policy, or concrete story content beyond the L6 contract.

## Core References

- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/communication.md`
- `docs/core/audit.md`

## Summary

L6 story acceptance is the OpenKit testing layer for realistic product intent validation.

It exists because OpenKit is an agent workflow product, and many important failures only appear when a user moves through a long, stateful, multi-step workflow in the real UI.

L6 should be agent-first for exploratory and long-flow acceptance, deterministic where a story becomes stable enough to automate, and strict about reducing confirmed defects into lower-level regression coverage.

The current repository implementation includes deterministic Web and MCP slices plus opt-in real Codex, real worker, and real-provider preflight slices: Markdown story artifacts live in `tests/stories/`, executable deterministic adapters and preflight runners live in `tests/story-runner/`, and `pnpm -w test:stories` runs the metadata parser tests plus the current deterministic story adapters.

The deterministic MCP slice now covers Goal Mode, Task Mode escalation, Chat Mode, workspace portability, and recovery controls. `tests/stories/goal-mode-mcp-smoke.story.md` validates the Goal Mode planning, approval, step, evidence, Action Center, and artifact read path through the MCP facade. `tests/stories/task-mode-mcp-smoke.story.md` validates the Task Mode MCP entry point and Task-to-Goal escalation path. `tests/stories/chat-mode-mcp-smoke.story.md` validates Chat Mode knowledge-backed answering, clarification gates, Action Center projection, and Goal Mode handoff through the same facade. `tests/stories/workspace-portability-release.story.md` validates cross-deployment workspace export/import, repository re-binding, lineage evidence, and redaction checks through a deterministic MCP runner, while vault reference re-binding remains part of the full agentic seeded path until a public setup path can seed workspace vault references without private test hooks. `tests/stories/recovery-mcp-smoke.story.md` validates interrupted worker recovery reads, pending input edit/follow-up/cancel actions, and interrupted checkpoint retry through the MCP facade.

The V1 implementation is complete for the accepted deterministic and opt-in preflight L6 contract. A future agentic executor remains deferred product work and does not block the current story artifact, metadata, deterministic adapter, MCP runner, explicit opt-in, evidence, and release-policy contract.

## Goals

- Validate complete user-intent workflows that cross UI, NanoCore, protocol events, approvals, questions, artifacts, diagnostics, and runtime feedback loops.
- Let AI agents execute long or exploratory stories through the visible product UI when fixed Playwright scripts would be brittle or too expensive to maintain.
- Preserve deterministic story adapters for stable, high-value acceptance flows that should be repeatable.
- Keep story files as versioned, reviewable repository artifacts instead of one-off prompts.
- Collect enough browser, server, network, transcript, and assertion evidence to debug failures after the run.
- Require every confirmed product bug found by L6 to become a deterministic regression test at the lowest practical layer from L1 through L5.
- Keep L6 out of automatic PR and tag release gates unless a future release policy explicitly promotes selected stories.

## Non-goals

- Do not make L6 a replacement for unit, contract, NanoCore e2e, Web e2e, or smoke tests.
- Do not require every story to have a hand-written Playwright adapter.
- Do not let subjective AI judgement alone pass a blocking acceptance story.
- Do not let an agent mutate backend state directly during the user-flow portion of a story.
- Do not require real OpenAI credentials, real Codex login, ChatGPT subscription auth, browser profile state, or provider quota for the default deterministic story suite.
- Do not run L6 by default on pull requests, ordinary branch pushes, or version tags.

## Background

L0 through L5 cover static quality, package behavior, cross-package contracts, NanoCore process behavior, Web browser e2e behavior, and artifact smoke confidence.

Those layers are deliberately deterministic and should catch known regressions as early and cheaply as possible.

They are not enough to answer whether a real user can complete a complex OpenKit workflow comfortably and correctly.

For example, a long workflow may technically pass component tests and browser e2e, while still having unclear wait states, confusing approval copy, broken recovery paths, missing diagnostics, stale artifact previews, or state transitions that are correct at the API layer but hard to understand from the UI.

L6 is the layer that asks an agent to behave like a product evaluator, follow a scenario, interact only through visible user surfaces except for declared setup and cleanup, and report whether the product satisfies the scenario intent.

## Core Decision

OpenKit L6 has two execution modes that share the same story artifact format.

Deterministic stories have explicit executable adapters under `tests/story-runner/`.

Agentic stories may have no dedicated adapter; an AI agent reads the story and executes it dynamically through Playwright or Chrome DevTools MCP.

The default long-term model is agent-first.

A story should only be converted into a deterministic adapter when the workflow is stable, important enough to repeat frequently, and expressible as resilient visible-UI operations.

Confirmed defects found by either mode must be reduced into L1, L2, L3, L4, or L5 regression coverage whenever the defect is deterministic.

Experience findings that are not deterministic bugs should become product issues, specs, or change records with supporting L6 evidence.

## Terminology

Story means a versioned Markdown artifact that describes one realistic user workflow.

Executor means the mechanism that performs the story.

Deterministic adapter means a committed Playwright test that maps one story to fixed visible-UI operations and assertions.

Agentic executor means an AI-operated runner that reads a story, decides how to operate the browser within the story constraints, captures evidence, and reports results.

Evidence bundle means the collection of trace, screenshots, logs, network records, story metadata, transcript, assertion summary, and triage notes produced by a story run.

Oracle means a pass/fail signal that is machine-checkable, such as visible DOM state, URL state, persisted API state, protocol events, artifact existence, terminal turn status, or absence of secret leakage.

Subjective finding means an agent observation about usability, clarity, product intent, or workflow quality that is useful but not sufficient by itself for a blocking pass/fail decision.

## Story Artifact Model

Story artifacts live under `tests/stories/`.

Each committed story must be Markdown with a scalar front matter block followed by human-readable sections.

The front matter is the machine-readable contract.

The body is the human and agent-readable acceptance specification.

The current parser intentionally supports only scalar front matter values and does not depend on YAML.

The required metadata fields are:

```yaml
id: story-web-local-turn
title: Complete a local worker turn from the Web UI
persona: Product evaluator using a clean local OpenKit workspace
entrypoint: web
default_tool: playwright
timeout_seconds: 300
requires_real_provider: false
requires_real_codex: false
```

`id` must be unique across committed stories.

`title` should be a concise human-readable workflow name.

`persona` defines the role the executor should simulate.

`entrypoint` defines the product surface to start from, such as `web`, `staging`, `desktop`, or a future hosted environment.

`default_tool` defines the preferred operation tool, currently `playwright` for deterministic runs and likely `playwright` or `chrome_devtools_mcp` for agentic runs.

`timeout_seconds` defines the story-level execution budget.

`requires_real_provider` must be `true` only when the story consumes real inference provider credentials or quota.

`requires_real_codex` must be `true` only when the story requires a real Codex host, login, subscription, or local installation state.

Future metadata may add fields such as `executor`, `risk`, `tags`, `environment`, `evidence_profile`, or `flake_policy`.

Because OpenKit is in active internal development, metadata changes should choose the clean target, but migrations must update all committed stories and adapters in the same change.

## Required Story Body Sections

Each story body should contain these sections unless there is a documented reason to omit one.

`Purpose` describes the user intent and product behavior being evaluated.

`Preconditions` describes required product capabilities and environmental assumptions.

`Setup` describes allowed non-user setup actions such as starting NanoCore, creating disposable data roots, seeding fixtures, or enabling deterministic executors.

`User-visible Steps` describes the workflow the executor must perform through visible UI surfaces.

`Expected Outcomes` describes what the user should be able to observe after the workflow.

`Deterministic Assertions` lists the machine-checkable oracles required for pass/fail.

`Evidence To Collect` lists required traces, screenshots, logs, transcripts, summaries, and redaction expectations.

`Cleanup` describes process shutdown, data cleanup, fixture cleanup, and credential cleanup.

`Failure Triage Notes` describes how to classify failures and how to reduce confirmed defects into lower-level regression tests.

Long stories should include checkpoints.

Each checkpoint should state the visible milestone, required evidence, and failure interpretation.

Checkpoints prevent a long story from producing only a vague final failure after many minutes of work.

## Execution Modes

### Deterministic Mode

Deterministic mode is used when a story has a matching adapter in `tests/story-runner/`.

The adapter reads the story file, validates metadata, starts the required isolated stack, operates the declared product entrypoint, records assertions, attaches or writes story evidence, and relies on the entrypoint's native trace or smoke output for failure evidence.

The current browser-backed deterministic story is `tests/stories/openkit-local-self-check.story.md`.

Its adapter is `tests/story-runner/openkit-local-self-check.spec.ts`.

It starts an isolated NanoCore and Web stack, enables the deterministic internal self-check executor, creates a workspace, creates a thread, submits a turn, grants an approval, answers a question, opens an artifact, and verifies diagnostics redaction.

The current MCP-backed deterministic stories are `tests/stories/goal-mode-mcp-smoke.story.md`, `tests/stories/task-mode-mcp-smoke.story.md`, `tests/stories/chat-mode-mcp-smoke.story.md`, `tests/stories/workspace-portability-release.story.md`, and `tests/stories/recovery-mcp-smoke.story.md`. Their adapters start built NanoCore on disposable local data roots, use the built OpenKit MCP registry against the public App API, avoid real provider and real Codex dependencies, and write optional evidence summaries when the relevant evidence directory environment variable is set.

Deterministic mode is appropriate for stable acceptance flows, release confidence checks, workflows where fixed accessible selectors are reliable, and MCP-first dogfooding loops that intentionally validate the AI Interface rather than the browser UI.

It is not the preferred form for every L6 story.

If a workflow becomes too long, too exploratory, or too sensitive to UI layout choices, it should stay agentic unless a smaller stable subset can be converted into deterministic L4 or deterministic L6 coverage.

### Agentic Mode

Agentic mode is used when an AI agent executes the story directly from the Markdown body.

The agent reads the front matter and story sections, starts or receives the target environment, operates the visible UI through the allowed browser tool, captures evidence at checkpoints, and writes a structured report.

Agentic mode is appropriate for long product workflows, exploratory acceptance, dogfooding sessions, release-candidate review, UX validation, and flows where human-like judgement is valuable.

The agent may adapt to minor UI differences, recover from benign timing issues, and inspect evidence sources that a fixed Playwright test would not normally inspect.

The agent must not use hidden implementation shortcuts during the user-flow portion.

Allowed setup and cleanup shortcuts must be listed in the story.

The agent may use APIs, filesystem checks, logs, or database snapshots only for declared setup, cleanup, or evidence collection.

Agentic mode can produce subjective findings, but a blocking pass/fail result must still include deterministic oracles where practical.

## Story Discovery And Execution Selection

A story may be in one of three states.

`documented` means the Markdown story exists but has not yet been executed by an automated runner.

`agentic` means the story is intended for an AI executor and may not have a deterministic adapter.

`deterministic` means the story has a committed adapter and can be run by `pnpm -w test:stories`.

The repository should not require every story to advance to deterministic state.

The L6 catalog should make it obvious which stories are deterministic and which are agentic-only.

Until a catalog file exists, the mapping is implicit: stories with matching adapters under `tests/story-runner/` are deterministic or opt-in preflight stories, and other story files are agentic candidates. The current MCP runner command `pnpm -w test:stories:mcp` runs all deterministic MCP stories.

A future catalog may be added if the number of stories grows enough to require filtering by tag, environment, risk, or release target.

## Agentic Executor Responsibilities

The agentic executor should load story metadata, validate required fields, and reject stories that require unavailable real provider or real Codex capabilities.

It should prepare the declared environment, preferably using disposable data roots and dynamic ports.

It should run the workflow through the visible UI, not through private API calls.

It should checkpoint progress after every material state transition.

It should preserve a transcript of goals, actions, observations, assertions, and deviations.

It should attach browser evidence such as trace, screenshot, console output, and network summary when available.

It should attach server evidence such as process logs, health responses, selected protocol events, and redacted error output when available.

It should produce a final report with pass/fail status, deterministic assertion results, subjective findings, suspected layer, reproduction notes, and recommended lower-layer regression coverage.

It should stop the environment and clean temporary state even when the story fails.

## Deterministic Adapter Responsibilities

A deterministic adapter should read its source story and validate metadata before running the flow.

It should operate through accessible selectors and user-visible labels whenever practical.

It should avoid direct API calls except for setup, cleanup, or evidence checks explicitly allowed by the story.

It should attach the story artifact to the Playwright report.

It should attach a concise assertion summary to the Playwright report.

It should rely on Playwright trace retention, screenshots, and browser diagnostics for failure evidence.

It should keep implementation detail out of the story body.

If the adapter needs product-specific helpers, those helpers should be generic enough to serve multiple stories or remain narrowly scoped to the story-runner boundary.

## Tooling Boundaries

Playwright is the default deterministic execution tool.

Playwright is also acceptable as the browser-control tool for agentic execution when the agent can drive it interactively or through a structured tool wrapper.

Chrome DevTools MCP is acceptable for agentic execution when the story benefits from an existing browser profile, authenticated local state, live debugging, or direct browser inspection.

The executor should prefer isolated browser contexts for deterministic and release-candidate stories.

The executor may use a real profile only when the story explicitly requires it and the run is manual.

The executor must not rely on browser extensions, previous local storage, or existing cookies unless the story explicitly says so.

The executor must not leak secrets into screenshots, transcripts, logs, reports, committed files, or uploaded artifacts.

## Environment Policy

Default L6 runs should use local deterministic services.

NanoCore should start with a disposable data root.

Web should start against the NanoCore instance on a dynamic localhost port.

The deterministic self-check executor should be used when the story does not require real Codex or real provider behavior.

Stories requiring real provider credentials must be marked with `requires_real_provider: true`.

Stories requiring real Codex, a host installation, ChatGPT subscription auth, or browser profile login must be marked with `requires_real_codex: true`.

Manual runs may target staging or release-candidate environments, but the story must state which environment is valid.

Network access should be disabled or unnecessary by default.

Quota-consuming runs should be explicitly invoked and reported separately from deterministic story runs.

## Evidence Requirements

Every L6 run should preserve the story file version.

Every L6 run should preserve a final assertion summary.

Agentic runs should preserve an agent transcript.

Browser-based runs should preserve screenshots on failure.

Browser-based runs should preserve traces when the tool supports them.

Browser-based runs should preserve console and network summaries when practical.

Server-backed runs should preserve process exit reasons, relevant logs, health responses, and redacted error output.

Runs that produce artifacts should record artifact ids or visible artifact titles.

Runs that involve protocol streaming should preserve enough event evidence to connect UI observations to server behavior.

Evidence must be redacted before upload or publication.

Fake secret markers are acceptable for testing redaction, but real secrets must not appear in story files, reports, committed fixtures, or CI artifacts.

## Pass And Fail Semantics

A story passes when all required deterministic assertions pass and no blocking contradiction to the story intent is observed.

A story fails when a required deterministic assertion fails.

A story fails when the agent cannot complete the workflow because the product blocks, loops, crashes, hides required controls, loses required state, or exposes secrets.

A story may produce non-blocking findings when the workflow completes but the agent observes usability, copy, latency, accessibility, or recoverability issues.

A subjective finding should not fail a blocking story unless it contradicts an explicit expected outcome or deterministic assertion.

If the environment fails before the product workflow begins, the result should be classified as environment failure rather than product failure.

If the browser tool fails independently of the product, the result should be classified as tool failure.

If the product behavior is ambiguous because the story lacks a clear oracle, the result should be classified as inconclusive and the story should be tightened before it is used as a release signal.

## Defect Reduction Policy

L6 is allowed to discover broad product failures, but it should not become the only place where known bugs are checked.

When L6 finds a deterministic bug, the follow-up change must add the lowest-layer regression test that can catch it.

Use L1 for pure logic, reducers, parsers, components, redaction helpers, and small state transitions.

Use L2 for schema, protocol, route payload, client parsing, and cross-package drift.

Use L3 for NanoCore process, HTTP, SSE, auth, storage, worker, and persistence boundaries.

Use L4 for browser-visible UI behavior that must be proven in a real browser.

Use L5 for boot, packaging, staging, health, and shallow artifact availability failures.

Keep the original L6 story when it still provides useful end-to-end product intent coverage, but do not rely on it as the only regression guard for a known deterministic defect.

## CI And Release Policy

L6 does not run automatically on pull requests.

L6 does not run automatically on ordinary branch pushes.

L6 does not run automatically on version tags in the current policy.

Pull requests run the lightweight repository check.

Version tags run the release gate through L0-L3 and L5.

Deterministic L6 runs through manual workflow dispatch with the `deterministic-stories` or `full` selection.

Local deterministic L6 runs use `pnpm -w test:stories` or the explicit `pnpm -w test:stories:deterministic` alias.

Local full validation uses `pnpm -w verify:full`, which includes deterministic story acceptance.

Agentic L6 should remain manually triggered until the executor is reliable enough and the selected story subset is cheap enough to justify scheduled or release-candidate automation.

If future release policy promotes any L6 story to an automatic gate, that story should be deterministic or have a tightly constrained agentic runner with stable evidence and low flake rate.

## Current Implementation

The committed stories are `tests/stories/openkit-local-self-check.story.md`, `tests/stories/goal-mode-mcp-smoke.story.md`, `tests/stories/task-mode-mcp-smoke.story.md`, `tests/stories/chat-mode-mcp-smoke.story.md`, `tests/stories/workspace-portability-release.story.md`, `tests/stories/recovery-mcp-smoke.story.md`, `tests/stories/goal-mode-real-codex-release.story.md`, `tests/stories/task-mode-real-worker-release.story.md`, `tests/stories/pi-ai-gateway-real-provider.story.md`, and `tests/stories/worker-mcp-governed-tool-use.story.md`.

The metadata parser is `tests/story-runner/story-metadata.mjs`.

The parser tests are `tests/story-runner/story-metadata.test.mjs`.

The first deterministic Web adapter is `tests/story-runner/openkit-local-self-check.spec.ts`.

The deterministic Goal Mode MCP runner is `tests/story-runner/goal-mode-mcp-smoke-runner.mjs`.

The Goal Mode MCP runner tests are `tests/story-runner/goal-mode-mcp-smoke-runner.test.mjs`.

The deterministic Task Mode MCP runner is `tests/story-runner/task-mode-mcp-smoke-runner.mjs`.

The Task Mode MCP runner tests are `tests/story-runner/task-mode-mcp-smoke-runner.test.mjs`.

The deterministic Chat Mode MCP runner is `tests/story-runner/chat-mode-mcp-smoke-runner.mjs`.

The Chat Mode MCP runner tests are `tests/story-runner/chat-mode-mcp-smoke-runner.test.mjs`.

The deterministic workspace portability MCP runner is `tests/story-runner/workspace-portability-mcp-runner.mjs`.

The workspace portability MCP runner tests are `tests/story-runner/workspace-portability-mcp-runner.test.mjs`.

The deterministic Recovery MCP runner is `tests/story-runner/recovery-mcp-smoke-runner.mjs`.

The Recovery MCP runner tests are `tests/story-runner/recovery-mcp-smoke-runner.test.mjs`.

The opt-in real Codex preflight runner is `tests/story-runner/real-codex-goal-mode-runner.mjs`.

The real Codex preflight runner tests are `tests/story-runner/real-codex-goal-mode-runner.test.mjs`.

The opt-in real Task Mode worker runner is `tests/story-runner/task-mode-real-worker-runner.mjs`.

The real Task Mode worker runner tests are `tests/story-runner/task-mode-real-worker-runner.test.mjs`.

The opt-in pi-ai real-provider gateway runner is `tests/story-runner/pi-ai-real-provider-runner.mjs`.

The pi-ai real-provider runner tests are `tests/story-runner/pi-ai-real-provider-runner.test.mjs`.

The stack helper is `tests/story-runner/web-stack.mjs`.

The Playwright config is `apps/web/playwright.stories.config.ts`.

The root deterministic story commands are `pnpm -w test:stories` and `pnpm -w test:stories:deterministic`.

The root deterministic MCP story command is `pnpm -w test:stories:mcp`.

The root opt-in real Codex preflight command is `pnpm -w test:stories:real-codex`.

The root opt-in real provider command is `pnpm -w test:stories:real-provider`.

The root opt-in real Task Mode worker command is `pnpm -w test:stories:real-task-mode`.

The Web package story command is `pnpm --filter @openkit/web e2e:stories`.

The current deterministic Web story starts a local stack, creates a workspace, creates a thread, sends a simulated turn, grants an approval, answers a question, opens an artifact, and verifies diagnostics redaction.

The current deterministic Goal Mode MCP story builds the required packages, starts a temporary NanoCore plus MCP stdio server through the existing smoke harness, reads status and diagnostics, links a disposable repository, creates a thread, starts Goal Mode, drafts and approves a plan, runs one bounded step, resolves deterministic approval or question gates, creates an evidence bundle, and reads the produced artifact when present.

The current deterministic Task Mode, Chat Mode, workspace portability, and recovery MCP stories exercise the same public AI Interface path for Task escalation, knowledge-backed Chat answers, Goal handoff, workspace export/import, repository re-binding, lineage evidence, recovery controls, and redaction checks.

The current implementation deliberately does not call an external AI model.

It exists to prove the story artifact, parser, execution entrypoint, isolated environment, report attachment, and CI/manual wiring before the agentic executor is added.

The current real Codex and real Task Mode worker stories are agentic-only and opt-in.
Their preflight runners validate metadata, explicit real Codex or real worker opt-ins, the disposable repository path, and the evidence directory before writing preflight evidence and redaction notes.
They do not run in default gates and must not consume real worker or host-side resources unless the operator explicitly enables them.

The current pi-ai real-provider story is opt-in and quota-gated.
Its runner validates story metadata, explicit provider opt-in, target NanoCore URL, provider configuration, evidence output, capability usage evidence, and redaction checks.
It remains separate from default deterministic L6 gates.

## Proposed Agentic Runner Shape

A future agentic runner should treat the story Markdown as the primary instruction contract.

It should have a small CLI entrypoint such as `pnpm -w test:stories:agentic -- --story tests/stories/<id>.story.md`.

It should support a dry-run mode that validates metadata and prints required environment capabilities without opening a browser.

It should support an evidence directory argument for local and CI artifact collection.

It should reject real-provider and real-Codex stories unless the matching explicit opt-in flags are present.

It should write a machine-readable result file with story id, executor, environment, started time, duration, status, assertion results, evidence paths, and triage classification.

It should write a human-readable Markdown report with observations, screenshots or trace links, suspected issue layer, and recommended regression target.

It should use the existing deterministic metadata parser unless the schema evolves enough to justify a package-local parser module.

It should reuse the existing isolated Web/NanoCore stack helper where possible for local stories.

It should avoid generating committed deterministic adapters during normal execution.

If the agent identifies a story that should become deterministic, it should propose or implement that adapter as a normal code change with tests and review, not as a side effect of the story run.

## Story Authoring Guidelines

Write stories from the user's perspective.

Keep implementation details out of the user-visible steps.

Name visible controls, visible states, expected text, and required artifacts when those names are part of the product contract.

Use setup sections for technical environment details.

Use deterministic assertions for anything that should affect pass/fail.

Use subjective findings for workflow quality, confusion, recoverability, and product-intent observations.

Prefer one complete user intent per story.

Split a story when the setup, persona, environment, or failure triage would become unclear.

Keep long stories checkpointed rather than artificially short.

Do not put real credentials, real secrets, or private account data in story files.

Do not encode fragile pixel positions or layout assumptions unless the story is specifically about visual layout.

## Example Agentic Story Skeleton

```markdown
---
id: story-web-agentic-release-review
title: Review a release-candidate workflow from the Web UI
persona: Product evaluator validating a release candidate
entrypoint: web
default_tool: playwright
timeout_seconds: 900
requires_real_provider: false
requires_real_codex: false
---

# Review A Release-Candidate Workflow From The Web UI

## Purpose

Verify that a product evaluator can complete the full local OpenKit workflow from workspace creation through artifact inspection and diagnostics review without relying on hidden implementation shortcuts.

## Preconditions

- NanoCore can boot with a disposable data root.
- Web can boot against the NanoCore instance.
- The deterministic self-check executor is enabled.

## Setup

- Start NanoCore in local mode with a temporary data root.
- Start Web against that NanoCore instance.
- Use a fresh browser context.

## User-visible Steps

1. Open the Web UI root route.
2. Create a workspace for the release-candidate review.
3. Create a thread for the review task.
4. Submit a self-check task that should exercise approvals, questions, output, and artifact creation.
5. Respond to every user-facing gate through the UI.
6. Inspect the produced artifact.
7. Open diagnostics and review visible health and redaction states.

## Checkpoints

- Workspace creation is visible.
- Thread dashboard is visible.
- The turn enters a running or streamed state.
- Approval UI is visible and can be granted.
- Question UI is visible and can be answered.
- Artifact view is reachable.
- Diagnostics view is reachable and redacted.

## Deterministic Assertions

- The workspace name is visible.
- The thread title is visible.
- The turn reaches a terminal success state.
- The artifact view renders the answer supplied by the evaluator.
- Diagnostics do not contain raw secret markers.

## Evidence To Collect

- Browser trace on failure.
- Screenshots at each checkpoint.
- Agent transcript.
- Assertion summary.
- Redacted server logs.

## Cleanup

- Stop Web and NanoCore.
- Remove the temporary data root.

## Failure Triage Notes

Reduce confirmed deterministic failures into L1-L5 regression tests and keep subjective workflow findings as product follow-up items.
```

## Risks And Mitigations

Risk: Agentic stories become non-reproducible narrative reports.

Mitigation: Require versioned stories, constrained tools, deterministic assertions, checkpoint evidence, and structured result files.

Risk: L6 duplicates L4 Web e2e.

Mitigation: Keep L4 focused on stable browser regression paths and keep L6 focused on realistic product intent, long workflows, exploratory acceptance, and agent judgement.

Risk: Agentic execution hides real bugs by adapting too much.

Mitigation: Require explicit pass/fail oracles, record deviations, and fail when the product blocks a required user-visible path.

Risk: Story files become vague prompts.

Mitigation: Enforce metadata validation, required body sections, checkpoints for long stories, and evidence requirements.

Risk: Real provider or real Codex stories consume quota or leak host state.

Mitigation: Gate them with explicit metadata and opt-in flags, keep them out of default CI, and record their evidence separately.

Risk: Deterministic adapters become expensive to maintain.

Mitigation: Convert only stable, high-value stories; keep most exploratory long flows agentic; move smaller known regressions down to L1-L5.

Risk: L6 failures do not lead to durable fixes.

Mitigation: Require defect reduction into the lowest practical deterministic layer before closing confirmed product bugs.

## Rollout Plan

1. Keep the current deterministic story runner as the smoke test for the L6 infrastructure itself.
2. Add a story catalog or metadata report when the number of stories grows beyond what directory naming makes obvious.
3. Add one agentic executor prototype that can run a single story manually and write structured evidence.
4. Keep the current real Codex Goal Mode story as the first agentic-only long workflow and add one or two additional agentic-only stories only when they have clear evidence value.
5. Review the evidence quality and flake rate before scheduling any agentic story automation.
6. Promote only stable and cheap L6 stories into deterministic adapters or explicit release-candidate manual gates.
7. Keep updating `docs/specs/20260529-test_strategy.md` only for the high-level layer policy and keep detailed L6 behavior in this spec.

## Resolved Decisions

- The first long agentic-only workflow is the opt-in real Codex Goal Mode release-validation story; additional agentic-only stories should be selected by risk, workflow length, evidence value, and inability to express the flow cheaply as deterministic Playwright.
- Do not add an explicit `executor` metadata field until the first agentic runner or story catalog needs it; when added, update all committed stories, parser tests, and adapters in the same change.
- Agentic runs should produce both a machine-readable JSON result and a human-readable Markdown report; Playwright or browser attachments are supporting evidence, not the primary result contract.
- Manual local runs require the baseline evidence profile: story version, assertion summary, transcript when agentic, redaction notes, and any available browser or server failure artifacts.
- Release-candidate, staging, real-provider, or real-Codex runs require a stronger evidence profile: checkpoint screenshots or traces when available, server logs, selected protocol or item history, artifact references, environment opt-in record, final state summary, and explicit secret-redaction scan notes.
- Selected agentic stories remain manual until the executor proves stable, cheap, and low-flake; scheduled or release-candidate automation may be introduced only for a constrained story subset with stable evidence and a stop rule for repeated flakes.

## Deferred Work

- Add the first agentic executor prototype that can run one story manually and write the JSON plus Markdown result files.
- Add an `executor`, `risk`, `tags`, `environment`, or `evidence_profile` metadata extension only when story selection or execution routing needs it.
- Add a story catalog or metadata report when directory naming no longer makes story state and execution mode obvious.

## Related Docs

- `docs/specs/20260529-test_strategy.md`
- `tests/stories/README.md`
- `tests/story-runner/README.md`
- `tests/stories/openkit-local-self-check.story.md`
- `tests/stories/goal-mode-real-codex-release.story.md`
- `tests/story-runner/real-codex-goal-mode-runner.mjs`
- `apps/web/playwright.stories.config.ts`
- `README.md`
- `apps/web/README.md`
