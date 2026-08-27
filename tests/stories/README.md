# L6 Stories

This directory contains versioned Markdown story artifacts for OpenKit L6 story acceptance.

Stories describe realistic user-intent workflows. They are not executable test code by themselves.

The detailed L6 model is documented in `docs/specs/20260529-l6_story_acceptance.md`.

## File Shape

A story is one Markdown document with the `*.story.md` suffix, in one of exactly two shapes:

```
tests/stories/<name>.story.md              # no assets
tests/stories/<name>/<file>.story.md       # assets live beside it
tests/stories/<name>/fake-accounts.json
```

The Markdown document is always the story. A directory only holds the fixtures, sample inputs, or fake data that one story needs; it holds no committed executable, and nothing in it overrides the document. `scripts/validate-story-schema.mjs` enforces both shapes.

Each story must start with scalar front matter that the schema validator can parse without a YAML dependency:

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

There is no `mode` or `runner` field. Every L6 story is agent-first by definition, so the mode would restate the layer and a committed runner would contradict it.

The front matter is scalar key-value lines with a closed field set, not YAML. The L6 specification owns the one-step switch trigger to a real YAML parser; do not add partial YAML syntax to the scalar parser.

The body section list is normative and owned by `docs/specs/20260529-l6_story_acceptance.md`. Required sections: `Purpose`, `Preconditions`, `User-visible Steps`, `Expected Outcomes`, `Deterministic Assertions`, and `Failure Triage Notes`. Allowed when needed: `Setup`, `Required Opt-in Environment Variables`, `Evidence To Collect`, and `Cleanup`. No other body section is allowed.

Long stories should name intermediate capture points inside `Evidence To Collect` so the stage manager collects evidence before the final outcome.

## Admission

L6 is agent-first by definition. An actor exercises the intent knowing only what a real user would know, and what that unconstrained attempt reveals is the whole reason the layer exists. One satisfiability test, owned by `docs/specs/20260529-l6_story_acceptance.md`, decides whether a story belongs here:

> Every assertion in an L6 story must be satisfiable by a competent actor that knows only the persona and the sole user ask.

Bounds and prohibitions (`only X`, `no Y`, `at most N`, `not before Z`) are satisfiable, as are assertions over product records and their ordering. An exact call sequence, an exact call count, a fixed call order, or a no-retry rule is not — an actor could satisfy it only by being told the trajectory, which the actor context rules forbid.

**A story containing such an assertion does not belong in L6.** Its proof is mechanical, which is what L3 NanoCore black-box integration and L4 Web browser end-to-end tests exist for. Move it there as ordinary test code and delete the story document; do not keep both.

A story body must contain no fenced code block. Committed executable detail in story prose is the observable symptom of feeding the actor its own trajectory through Setup.

## Execution Model

Stories are not part of the mechanical test suite. There is no committed runner, no adapter, and no per-story command: adding a story adds nothing to `package.json` and no CI target. A story runs when a stage manager is asked to run it, using the roles in the L6 specification.

When a run needs a throwaway script, the actor or stage manager writes it during the run and discards it with the rest of the disposable state. Such a script is never committed, never named by the story, and never reused. Wanting to commit one means the proof is mechanical, which returns the story to Admission above.

Story documents are still validated mechanically. `pnpm -w check:repo` runs `scripts/validate-story-schema.mjs` over every story: the two on-disk shapes, the closed front matter field set, contract-reference existence, repository-unique ids, the body section list, the no-fenced-code rule, and the no-committed-executable rule for asset directories.

## Authoring Rules

- Write stories in English Markdown.
- Keep user-visible steps focused on product behavior, not implementation internals.
- Put technical bootstrapping in `Setup`, not in the user-visible flow.
- Use fake secret markers only, never real credentials or private account data.
- Mark real-provider stories with `requires_real_provider: true`.
- Mark real-Codex or real-subscription stories with `requires_real_codex: true`.
- Apply the Admission test to the assertions you wrote, and state that argument in the admitting change record's entry gate.
- Keep deterministic assertions machine-checkable whenever practical, and make each assertion name the evidence or product record that decides it.
- Assert outcomes, not trajectories. If you find yourself writing the actor's steps into the assertions, the proof is mechanical and belongs at a lower layer.
- Do not write verdict-shaped assertions such as "the run executes and passes"; execution and skip semantics are owned by the L6 specification.
- Declare the owning contract documents in the `contracts` front matter line.
- Require every confirmed deterministic L6 defect to be reduced into L1-L5 regression coverage.

## Current Stories

Admitted L6 stories:

- `openkit-agent-skill-progressive-discovery.story.md`: real Codex acceptance flow proving progressive Skill loading, CLI operation discovery and description, one workspace mutation, and durable public readback without MCP.
- `worker-mcp-governed-tool-use.story.md`: Worker MCP acceptance covering governed tool calls, approval-required tools, audit evidence, usage rows, and credential redaction.
