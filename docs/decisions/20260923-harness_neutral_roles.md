---
status: Superseded
superseded-by: docs/decisions/20260924-prompt_dispatched_roles.md
date: "2026-09-23"
decider: Engineer
---
# Roles Are Harness-Neutral And Bound To Models By Capability Tier

## Decision

Role contracts move from the Codex-specific .codex/agents/ files to harness-neutral Markdown under docs/roles/, one file per role with a README index. Roles state an abstract capability tier instead of a model name: frontier (the strongest available model, which carries judgment), standard (a strong general model), or fast (a cheap, quick model). Model family and context size are separate attributes. Minimums: the primary of material work, Consultant, and Auditor are frontier; a Reviewer is at least the tier of the producer it reviews and preferably of a different model family for consequential work; builder, test author, researcher, and writer are standard, and a builder may be fast when the task is bounded, its writable paths are explicit, and checking the result is cheaper than producing it. A platform reference, docs/agent-harnesses.md, owns harness enforcement facts, known quirks, and dispatch methods, and each concrete model name appears in one place only. Codex, Claude Code, and Grok Build get thin adapters that set the model and point to the role contract. Cursor CLI, PI through Herdr, and DeepSeek Harness receive prompt dispatch that names the role file. OpenCode is not supported. Default role compositions per task class are starting points, not pipelines. There is no separate advisor role: a Consultant declares which gap it fills, freshness, independence, or capability, and its stance, challenging or guiding. When frontier capacity is short, a standard primary calls a frontier context at objective triggers: a Safety Kernel concern, a seam between different owners, a failing check still unexplained after one Reframe, or an ambiguous specification.

## Reason

The engineer wants a flexible, agent-native workflow that uses several model families, sizes, and harnesses while following the engineering principles, and the Codex-only role location blocked other runtimes. The existing role text was already almost entirely neutral Markdown. A strong primary with cheap, bounded delegates puts the weak link where checks catch its errors, while a weak primary asking a strong advisor leaves the information channel under the control of the weaker model, which is poor at judging when and what to ask. The engineer added that delegation also preserves the primary's context window, so side tasks and their detail should return as conclusions with resolvable evidence pointers. The engineer corrected the harness list: no OpenCode, and add Grok Build and DeepSeek Harness. DeepSeek Harness loads the project AGENTS.md but no project-scoped named agent directory was found, so it uses prompt dispatch until verified otherwise.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-007.

## Rejected Alternatives

- Keeping role text inside each harness's own format, or generating it per harness. Rejected; one neutral contract with thin pointers needs no generator.
- A separate advisor role. Rejected because advisor and Consultant perform the same function and differ only in the gap they fill.
- Model names inside role contracts. Rejected because models change weekly and would be restated in many places.
- A fixed pipeline per tier. Rejected; the existing rule that roles are capabilities remains.

## Revisit When

A harness gains or loses a project agent registry, the capability tiers stop matching available models, or task evidence shows a preset composition repeatedly adds no change to artifact, belief, or decision.

## Affected Owners

- AGENTS.md
- docs/change-execution.md
- docs/roles/README.md
- docs/agent-harnesses.md
