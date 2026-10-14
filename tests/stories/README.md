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

There is no `mode` or `runner` field. Every L6 story is agent-first by definition, so the mode would restate the layer and a per-story runner would prescribe its trajectory.

The front matter is scalar key-value lines with a closed field set, not YAML. The L6 specification owns the one-step switch trigger to a real YAML parser; do not add partial YAML syntax to the scalar parser.

The body section list is normative and owned by `docs/specs/20260529-l6_story_acceptance.md`. Required sections are `Intent`, `Starting World`, `Outcome Predicates`, `Perturbations`, `Integrity Invariants`, and `Failure Triage Notes`. Allowed sections are `Setup`, `Required Opt-in Environment Variables`, `Evidence To Collect`, and `Cleanup`. No other body section is allowed. A story states an outcome. A story does not state actor steps.

Long stories should name intermediate capture points inside `Evidence To Collect` so the stage manager collects evidence before the final outcome.

## Admission

L6 is agent-first by definition. An actor exercises the intent knowing only what a real user would know, and what that unconstrained attempt reveals is the whole reason the layer exists. One satisfiability test, owned by `docs/specs/20260529-l6_story_acceptance.md`, decides whether a story belongs here:

> Every outcome predicate in an L6 story must be satisfiable by a competent actor that knows only the persona and the sole user ask.

Bounds and prohibitions (`only X`, `no Y`, `at most N`, `not before Z`) are satisfiable, as are outcome predicates over product records and their ordering. An exact call sequence, an exact call count, a fixed call order, or a no-retry rule is not satisfiable from a persona and an ask alone.

**A story containing such an outcome predicate does not belong in L6.** Its proof is mechanical, which is what L3 NanoCore black-box integration and L4 Web browser end-to-end tests exist for. Move it there as ordinary test code and delete the story document; do not keep both.

A story body must contain no fenced code block. Committed executable detail in story prose is the observable symptom of feeding the actor its own trajectory through Setup.

## Execution Model

Stories are not part of the mechanical test suite. There is no per-story runner, adapter or command: adding a story adds nothing to `package.json` and no CI target. A story runs when a stage manager is asked to run it, using the roles in the L6 specification.

Use the existing public clients and shared setup/collection support. A one-off script may remain disposable; repeated generic preparation or evidence collection may be maintained under its existing support owner without prescribing the Actor's solution or creating private state. Ordinary L6 defaults to the persistent-deployment modes; a distinct cold/destructive condition selects its own fixture. See `docs/cookbooks/persistent-live-acceptance.md`.

Story documents are still validated mechanically. `pnpm -w check:repo` runs `scripts/validate-story-schema.mjs` over every story: the two on-disk shapes, the closed front matter field set, contract-reference existence, repository-unique ids, the body section list, the no-fenced-code rule, and the no-committed-executable rule for asset directories.

## Authoring Rules

- Write stories in English Markdown.
- Keep the actor's ask on the outcome. Do not write actor steps.
- Put technical bootstrapping in `Setup`. The actor receives only the persona and the ask.
- Use fake secret markers only, never real credentials or private account data.
- Mark real-provider stories with `requires_real_provider: true`.
- Set `requires_real_codex: true` only when the story requires a real Codex runtime. `docs/specs/20260529-l6_story_acceptance.md` states that a real Codex requirement uses explicit opt-in metadata.
- Apply the Admission test to the assertions you wrote, and state that argument in the admitting change record's entry gate.
- Keep outcome predicates machine-checkable whenever practical, and make each predicate name the evidence or product record that decides it.
- State outcomes, not trajectories. If a predicate needs the actor's steps, the proof is mechanical and belongs at a lower layer.
- Do not write verdict-shaped assertions such as "the run executes and passes"; execution and skip semantics are owned by the L6 specification.
- Declare the owning contract documents in the `contracts` front matter line.
- Require every confirmed deterministic L6 defect to be reduced into L1-L5 regression coverage.

## Current Stories

Admitted L6 stories:

- `first-install-from-release-assets.story.md`: Install a published release on an empty machine. The operator installs that release and checks that it is ready to use.
- `persistent-deployment-prerelease-update.story.md`: Update a persistent deployment to the published prerelease. The operator updates the deployment, keeps carried-forward work readable, and verifies required accounts after any disclosed pre-stable reset.
- `provider-credential-subscription-reply.story.md`: Configure one provider and receive one reply. The operator connects one provider, stores its credential, attaches one subscription, and gets one ordinary reply.
- `issue-and-revoke-workspace-access.story.md`: Issue workspace access and then revoke it. The operator grants access that can start a thread, checks that look-only access cannot, and then withdraws the changing access.
- `external-agent-grounded-record.story.md`: Explain a recorded result through the remote connection. A team member asks an outside agent to explain the designated thread's latest completed result.
- `goal-completion-with-plan-approval.story.md`: Finish one goal with an approved plan and one worker task. The responsible person gets one small piece of work done, approves the plan, and accepts the result.
- `issue-to-reviewed-merge.story.md`: Fix a designated issue and merge the reviewed pull request. The maintainer asks for that fix and merge, and allows only the branch work, the pull request, and the merge.
- `capture-knowledge-and-cite-it.story.md`: Save a source and cite it in an answer. The user saves a source and gets an answer that cites the published entry.
- `review-diagnostics-and-health.story.md`: Review health and diagnostics. The operator checks health and diagnostics and asks that they reveal no raw secret.
- `accounted-outcome-during-restart-or-update.story.md`: Finish work that is interrupted by a restart or an update. The maintainer asks a worker to post one note and to say whether it was posted.
