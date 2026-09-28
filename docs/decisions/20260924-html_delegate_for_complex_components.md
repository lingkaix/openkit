---
status: Accepted
date: "2026-09-24"
decider: Engineer
supersedes: docs/decisions/20260909-mixed_generative_rendering.md
---
# An HTML Delegate Is Reserved For Components The Native Set Cannot Compose

## Decision

Declarative generative UI uses one shared Core admission and action boundary, standard Apps SDK and MCP tool and UI-resource semantics, A2UI to organize the whole surface, OpenKit native components by default, and one isolated MCP Apps HTML delegate for specialized plugin interactions such as maps, timelines, and canvases. The first version concentrates on A2UI; the architecture keeps room and an interface for the HTML delegate, which is not yet implemented. The Generative UI Interaction specification owns the rule.

## Reason

The engineer gave the reason on 2026-09-24, summarized here from Chinese: some complex components cannot be composed from the default component set, or composing them from it would add complexity, so an interface for HTML rendering is kept for them. The design drew on the Apps SDK used by Codex and on other open-source projects.

Source: the engineer's answer of 2026-09-24 to the landing's report, summarized above and noted in change record 202609231611190001-engineering_governance_landing; the original selection is in change record 202609081810390001-generative_kernel_ui_design.

## Rejected Alternatives

- A2UI rendering alone, with HTML iframe hosting and full MCP Apps host conformance not selected. The engineer's earlier selection, replaced by this one because some components cannot be composed from the native set.

## Revisit When

When the acceptance proof of exact host conformance for the HTML delegate fails, or native components cannot serve a class of specialized interaction.

## Affected Owners

- docs/specs/20260908-generative_ui_interaction.md
- docs/core/generative-apps.md
- docs/specs/20260710-web_ui_rebuild_stack.md
