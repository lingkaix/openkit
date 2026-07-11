# OpenKit Design Guide

## Purpose

This file is the durable UI/UX design guide for OpenKit. It follows the spirit of Stitch's `DESIGN.md` guidance by making product design intent explicit, stable, and easy for future implementation work to preserve.

## Product Shape

OpenKit is a local-first AI workbench for repeated workspace, session, thread, approval, artifact, and configuration workflows. The interface should feel like a dense professional tool, not a marketing page, dashboard demo, or decorative chat clone.

The first screen must be the usable workbench. Do not add a landing page, hero section, explanatory walkthrough, or marketing-style empty shell in front of the product workflow.

## Information Architecture

The app shell has two primary regions: a sticky full-height left sidebar and a centered main panel. The left sidebar is the navigation context, and the main panel is the focused work surface.

In the app workspace view, the left sidebar belongs to shortcut, workspace, and thread navigation. It should keep Chat, Dashboard, Automations, and New workspace shortcuts pinned near the top, show workspace rows with collapsible nested thread lists below them, and keep a full-width Settings entry pinned to the bottom.

When Settings is active, the same left sidebar becomes the Settings sidebar. It should replace workspace and thread content with a Back to app action and Settings categories such as General, Appearance, Configuration, Memory, and Diagnostics.

Do not place a second Settings sidebar inside the main panel. Settings category navigation belongs in the primary left sidebar so the main panel can stay centered and single-column.

Configuration, debug, runtime, protocol version, theme selection, agent defaults, diagnostics, and similar options belong in Settings. They should not compete with workspace and thread navigation in the app workspace sidebar.

Do not keep separate workbench pages for agent dashboards, artifact inventories, approval queues, or protocol inspectors unless they are backed by real navigation and server functionality. Current artifacts and approvals belong in the main session flow, while debug inspection belongs in Settings Diagnostics.

The sidebar follows the protocol hierarchy in `docs/core/protocol.md`: workspace rows represent workspace-level state, nested thread rows represent thread-level state, thread dashboards summarize turns, session status, and artifacts, and item logs expose the ordered thread or session item history when the user asks for detail.

## Main Panel

The main panel should be centered and arranged from top to bottom. Avoid left/right content splits inside the main panel unless a specific workflow genuinely requires comparison.

The main panel can have its own compact header for current thread, workspace, and status context. This header should be stacked vertically rather than split into left and right information groups.

Conversation, composer, approvals, artifacts, memory, and configuration sections should appear as a vertical flow. Users should be able to scan downward without jumping between columns.

Chat is the default workspace entry. It should look like a minimal centered starter surface with a large question, compact composer, selected-workspace row, and lightweight suggestion rows. It is where a user starts a thread in the currently selected workspace.

Thread and workspace dashboards should be centered, single-column surfaces. A workspace dashboard summarizes workspace status, thread count, artifacts, memory, agents, and default execution context. A thread dashboard summarizes basic thread information, session status, current turn state, artifacts, and the bottom composer.

The composer belongs at the bottom of the active work surface so users can review status and logs first, then continue the workflow without moving to another region.

Use stable dimensions and responsive constraints for fixed-format controls, lists, theme cards, composer controls, counters, and status badges. Dynamic content must not resize the surrounding layout unexpectedly.

## Sidebar Design

The sidebar should be quiet, compact, and task-focused. It is for navigation and persistent context, not for dense debug panels or secondary dashboards.

Use icon and text rows for core actions where text improves recognition. Use icon-only controls only when the meaning is standard and an accessible label is present.

Use Iconify with Remix Icon for compact action and navigation icons. Do not handcraft new SVG icons when an appropriate Remix Icon exists.

Settings should include a clear Back to app action. This makes Settings feel like a mode of the workbench instead of another panel nested inside the workspace.

Settings sidebar categories are interactive navigation, not static labels. Selecting General, Appearance, Configuration, Memory, or Diagnostics should show one focused single-column section in the main panel and mark the active category with an accessible current-page state.

The app workspace sidebar is always full height on desktop and sticks to the viewport. Its top shortcut group is for primary product destinations, its middle region scrolls through workspaces and nested threads, and its bottom region contains the full-width Settings command.

Do not place Settings in the top-right chrome. Top-right global controls should stay removed unless they operate on the current main panel and cannot live in the sidebar or Settings.

Workspace rows open the workspace dashboard. Thread rows open the thread dashboard. Collapsing a workspace hides only its nested threads and must not remove the workspace row itself.

A right item log sidebar may open from the thread dashboard for ordered conversation, turn, and item history. It is an on-demand detail panel, not a permanent third column. When open on desktop, it should be full height, sticky to the viewport like the left sidebar, and independently scrollable so log review does not move the main work surface.

## Visual System

Use soft surface separation instead of dense one-pixel grid boxes around every element. Prefer background tone shifts, grouping, hierarchy, and compact spacing over heavy borders.

The app should maximize useful screen area. Avoid large gutters, nested cards, decorative wrappers, and repeated framed containers inside framed containers.

Cards are appropriate for repeated items, modals, compact tool surfaces, and meaningful grouped controls. Do not style every page section as a floating card, and do not put cards inside cards.

Use Adobe Spectrum's corner-radius scale as the source for cards, panels, theme previews, rows, and buttons, expressed as token-bridge radius tokens. Keep radii compact and consistent; do not introduce ad-hoc radius literals outside the bridge tokens.

Avoid decorative gradients, blurred ornamental backgrounds, bokeh, floating orbs, and marketing-style hero compositions. The product should feel clear, calm, and operational.

Typography should be compact and proportional to the surface. Reserve large headings for page or major section identity, and use smaller headings inside panels, sidebars, and repeated items.

Do not scale font size with viewport width. Letter spacing should stay at `0` unless the local component already uses a deliberate compact label style.

## Theme System

OpenKit uses semantic theme tokens derived from the Adobe Spectrum design system instead of hard-coded palette classes. Spectrum tokens are the source of visual truth and are projected into a Tailwind theme through the single token-bridge source file described in [`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md). The root app applies the selected theme variant by swapping the active token set (via a root data attribute or class).

Theme options are the Spectrum-defined variants (light and dark, plus any brand variant), not a large catalog of unrelated themes. The Settings page should expose the available variants through compact visual preview cards.

Theme preview cards should show base surface tone plus primary, accent, and neutral samples. Each theme option must have an accessible button label.

The selected theme should persist locally and restore on reload. Theme switching belongs in Settings, not in the global workbench header.

Avoid hard-coded color families such as fixed stone or slate text classes in app markup. Use only the semantic theme tokens produced by the token bridge, such as the surface/background steps, foreground/text steps, `primary`, `accent`, `neutral`, `info`, `success`, `warning`, and `error`. Raw Spectrum global tokens and hard-coded color, spacing, or radius literals must not appear in component markup.

## Interaction Patterns

The app should optimize common repeated workflows: choose workspace, choose thread, start a turn, review streamed output, respond to approvals, inspect artifacts, update settings, and return to work.

Search should not appear until the server supports it. Do not ship inactive or decorative search controls.

Settings should organize controls by category. General covers workspace identity and defaults, Appearance covers theme choice, Configuration covers protocol and runtime policy, Memory covers editable context, and Diagnostics covers health, debug state, and repair actions.

The Chat shortcut is the default entry for starting a normal workspace thread. The Dashboard shortcut is for all-workspace status. The Automations shortcut is reserved for cron jobs and scheduled workspace runs once nanocore exposes server-backed automation endpoints. The New workspace shortcut owns workspace creation instead of embedding creation controls inside the workspace list.

Quick chat should become a server-backed special workspace mode for simple answers such as weather, definitions, counts, and lightweight internal status questions. It should use the LLM plus nanocore internal tools only, avoid spawning extra agents, and return fast results without polluting normal workspace thread history.

Settings should avoid showing every category at once. The active category should be easy to scan without requiring users to scroll past unrelated configuration, theme, memory, or diagnostic controls.

Diagnostics should stay single-column. It can show health counters, event timelines, and protocol snapshots, but it should not recreate the older split inspector page.

Approval actions should stay visible in the main vertical workflow when they are relevant to the current thread. Users should not need a separate right panel to resolve the current work path.

Artifacts should remain reachable from the main vertical workflow after a turn creates them. A completed turn should leave visible evidence of output.

## Responsive Behavior

The layout must avoid horizontal overflow on desktop and mobile. The main panel should preserve readable width on large screens and collapse cleanly to one column on small screens.

On mobile, the sidebar and main panel may stack, but Settings must still clearly show Back to app and category navigation before the main settings content.

Text must fit inside buttons, cards, theme previews, badges, and rows. Long names should wrap or truncate deliberately without overlapping adjacent UI.

## Accessibility

Icon-only controls must include accessible labels. Navigation regions should have clear `aria-label` values such as Primary workspace navigation, Workspace threads, Settings sections, and Conversation workspace.

Collapsible workspace thread controls should use stable generic labels such as Collapse workspace threads and Expand workspace threads so workspace row names remain unambiguous for assistive technology and tests.

Interactive controls should be native buttons, inputs, selects, checkboxes, and textareas, or the React Aria Components primitives that provide equivalent accessible semantics. Do not replace standard controls with decorative divs.

State indicators should use text plus semantic color, not color alone. Examples include turn status, approval status, agent health, artifact status, and connection state.

## Implementation Guardrails

Design changes in `apps/web` should be test-first. Tests should cover layout structure, navigation placement, theme availability, persistence, responsive rails, and critical workflow continuity.

Run web lint, typecheck, tests, build, and full repository verification before handoff. Browser checks should cover desktop and mobile overflow, Settings navigation placement, theme preview count, and primary workflow visibility.

Build on the rebuilt Web UI stack: React with React Aria Components for accessible behavior, Adobe Spectrum tokens projected into Tailwind for styling, and A2UI for generative surfaces, as defined in [`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md). Keep the existing Iconify with Remix Icon pattern for icons. Do not introduce a different design system, component framework, or icon stack without a specific architectural reason recorded in that spec.

## Current Decisions

The global head bar is removed. Information formerly placed there belongs either in the left sidebar or in the active main panel header.

The main panel header is local to the main panel. It is compact, stacked, and focused on the current workspace or thread context.

The old right auxiliary panel is no longer part of the active design direction. Current-thread approvals, artifacts, and inspector-relevant output should appear in the vertical main workflow or in Settings when they are configuration-oriented.

Settings uses the primary left sidebar for categories. The main Settings content is single-column and centered.

The left sidebar has two modes: app workspace navigation and Settings navigation. Do not mix workspace/thread lists with Settings categories in the same sidebar state.

Settings category buttons now switch the main panel between focused sections. General is the default section, Appearance owns the theme selector (Spectrum light, dark, and any brand variant), Configuration owns protocol and debug mode state, Memory owns the memory editor, and Diagnostics owns health counters.

Diagnostics now owns the protocol snapshot and event timeline. Stale mock workbench pages for agents, artifact previews, approval policy samples, and inspector views are removed until nanocore exposes real product behavior for those surfaces.

The app sidebar now follows the workspace-thread protocol hierarchy. Chat, Dashboard, Automations, and New workspace stay at the top; workspaces and collapsible threads occupy the scrollable middle; Settings is a full-width bottom command.

Workspace dashboard selection opens a centered workspace status summary. Thread selection opens a centered thread dashboard with session status, turn controls, artifacts, and an on-demand right item log for conversation items.

Chat replaces the old Home label. It opens a centered Codex-like starter where the user can begin a thread in the selected workspace.

## References

- Stitch DESIGN.md overview: https://stitch.withgoogle.com/docs/design-md/overview
- Web UI rebuild stack spec: [`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md)
- Adobe Spectrum design system: https://spectrum.adobe.com/
- React Aria Components: https://react-spectrum.adobe.com/react-aria/
- A2UI generative UI standard: https://a2ui.org/
