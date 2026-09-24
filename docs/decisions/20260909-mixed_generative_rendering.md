---
status: Superseded
superseded-by: docs/decisions/20260924-html_delegate_for_complex_components.md
date: "2026-09-09"
decider: Engineer
---
# Generative UI Uses Native A2UI Rendering With One Isolated HTML Delegate

## Decision

Declarative generative UI uses one shared Core admission and action boundary, standard Apps SDK and MCP tool and UI-resource semantics, A2UI to organize the whole surface, OpenKit native components by default, and one isolated MCP Apps HTML delegate for specialized plugin interactions such as maps, timelines, and canvases. The engineer selected this mixed scope after first selecting A2UI rendering alone. The Generative UI Interaction specification owns the rule.

## Reason

Not recorded. The engineer's later explicit design replaced the earlier A2UI-only first-host scope without a stated reason. Ask the engineer before changing this rule, and record the answer in a new record that supersedes this one.

Source: change record 202609081810390001-generative_kernel_ui_design.

## Rejected Alternatives

- A2UI rendering alone, with HTML iframe hosting and full MCP Apps host conformance not selected. The engineer's earlier selection, replaced by this one.

## Revisit When

When the acceptance proof of exact host conformance for the HTML delegate fails, or native components cannot serve a class of specialized interaction.

## Affected Owners

- docs/specs/20260908-generative_ui_interaction.md
- docs/core/generative-apps.md
- docs/specs/20260710-web_ui_rebuild_stack.md
