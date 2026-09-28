---
status: Accepted
date: "2026-09-24"
decider: Engineer, on a Consultant-reviewed proposal
supersedes: docs/decisions/20260923-harness_neutral_roles.md
---
# Roles Live Only In The Documents And Are Dispatched By Prompt

## Decision

Role contracts are harness-neutral Markdown under docs/roles/, one file per role with a README index, and they exist nowhere else: no harness keeps a copy or an adapter of a role, and the project registers no named subagents. Every harness receives a role through a dispatch prompt that names the role file; the dispatched agent reads root AGENTS.md and then its role file before task work, and a primary chooses the role from the README index when it scopes, plans, and dispatches. docs/agent-harnesses.md owns the prompt template, the model bound to each tier in each harness, and what each harness enforces; the primary resolves the model and sets real restrictions at launch, because a role is guidance, not authorization or containment. The rest of the earlier decision carries forward unchanged: roles state an abstract capability tier, frontier, standard, or fast, with the same minimums; model family and context size are separate attributes; each concrete model name appears in one place; OpenCode is not supported; default compositions are starting points, not pipelines; there is no advisor role, and a Consultant declares its gap and stance; and a standard primary in degraded mode calls a frontier context at the same objective triggers.

## Reason

The engineer did not approve of role definitions placed in Codex, Claude Code, and Grok Build folders: they create duplicated information and files, burden maintenance, and are not flexible for other agent runtimes. The engineer wanted the roles only in the documents, readable by any agent acting in a role, and findable by a primary or Orchestrator when it scopes, plans, and dispatches. A Consultant running GPT-6 astra recommended keeping separate role files for selective loading, removing all adapters, and dispatching by prompt with launch-time model and restriction choices; the engineer accepted this on 2026-09-24, including the loss of named subagents and automatic per-role model binding.

Source: the engineer's answers of 2026-09-24 to the landing's report, noted in change record 202609231611190001-engineering_governance_landing; the earlier decision is recorded there as ruling R-007.

## Rejected Alternatives

- Thin adapters per harness that set the model and point to the role file. Rejected because they multiply files per harness and must change with every role.
- One merged document for all roles. Rejected because an agent in one role would load every other role's procedures.

## Revisit When

A harness can only run a role reliably through a registered definition, or launch-time model and restriction choices prove error-prone in observed dispatches.

## Affected Owners

- AGENTS.md
- docs/agent-harnesses.md
- docs/roles/README.md
- docs/documentation-model.md
- docs/change-execution.md
