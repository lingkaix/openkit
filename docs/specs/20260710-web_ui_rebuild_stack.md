# Web UI Rebuild Stack

Status: Accepted
Implementation: Not Started

## Owns

- The implementation stack for the rebuilt OpenKit Web UI: UI framework, client state, routing, server-state access pattern, styling engine, design-system source, accessible behavior layer, generative-UI standard, and component-architecture posture.
- The **token-bridge contract** that makes an Adobe Spectrum design in Claude Design map to Tailwind-implemented code at high visual fidelity.
- The reconciliation deltas that `DESIGN.md` must absorb because of this stack change.
- The current implementation projection of the rebuilt `apps/web`.

## Does Not Own

- Kernel, protocol, App API, workflow, storage, permission, capability, or knowledge semantics. Those stay owned by `docs/core/*` and their protocol/runtime specs.
- The Web UI product-surface posture and the minimum contract-backed product areas, which are owned by [`20260628-web_product_surface_projection.md`](./20260628-web_product_surface_projection.md).
- Information architecture, layout, sidebar model, and interaction rules, which remain owned by `DESIGN.md`. This spec only records the deltas that `DESIGN.md` must absorb; it does not redefine the IA.
- The design→code collaboration workflow, which is owned by the cookbook [`docs/cookbooks/claude-design-web-ui-loop.md`](../cookbooks/claude-design-web-ui-loop.md).

## Core References

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/protocol.md`
- `docs/product-vision.md`

## Summary

The OpenKit Web UI is being fully rebuilt. This spec records the target implementation stack and the contracts that keep the rebuild coherent.

The stack moves from SolidJS + daisyUI to **React** with **Zustand** (UI/client state), **React Router** (routing), and **TanStack Query** (server-state over `@openkit/core-client`). The visual design language becomes **Adobe Spectrum**, projected as design tokens into a **Tailwind CSS v4** theme, with accessible behavior supplied by **React Aria Components** (Adobe's own headless implementation of Spectrum behavior). **daisyUI is removed.** Generative, agent-declared UI is rendered through the **A2UI** open standard using its official React renderer.

The decisive constraint is that most implementation work is performed by AI agents. The stack is therefore chosen for ecosystem density (more reliable agent output), for standards whose reference implementations are React (A2UI, React Aria), and for the tightest possible design-to-code fidelity with a Spectrum design authored in Claude Design.

## Goals / Non-goals

### Goals

- Define one clean target stack for the rebuilt Web UI so agents scaffold and build against a single, unambiguous contract.
- Maximize agent-authored code reliability by standing on the ecosystem with the highest training-data density and the most maintained standard renderers.
- Make an Adobe Spectrum design faithfully implementable on Tailwind at low long-term maintenance cost.
- Keep the Web UI a projection over stable NanoCore/App API contracts, consumed only through `@openkit/core-client`.
- Establish a token bridge so the same token values back both the Claude Design (Spectrum) side and the code (Tailwind theme) side.

### Non-goals

- Do not preserve any Solid, daisyUI, or 35-theme behavior. This is an internal rebuild with no backward-compatibility obligation.
- Do not redefine kernel, protocol, App API, or product-surface semantics here.
- Do not specify screen-level layouts, copy, or route trees. Those follow `DESIGN.md` and the design loop.
- Do not adopt the full heavyweight React Spectrum component library as the default; the default is React Aria behavior + Spectrum tokens + thin OpenKit-styled wrappers.

## Background

`apps/web` is a small SolidJS SPA (Vite, Tailwind v4, daisyUI, Iconify/Remix, CodeMirror, Zod) that consumes the server only through the composed `@openkit/core-client` sub-clients. Because the data layer is already abstracted behind `core-client`, a view-layer rebuild — including a framework change — is contained: `core-client` and the protocol package are unaffected.

Two forces drive the specific choices. First, the product intends to lean heavily on agents to write the UI, so the ecosystem where agents are most reliable and where standard renderers are maintained matters more than raw runtime simplicity. Second, the team has selected Adobe Spectrum as the visual language; Spectrum's own accessible behaviors are published as React Aria Components, and its tokens are published as a token package, which together give React a uniquely direct path to Spectrum fidelity on Tailwind.

## Decision

The rebuilt `apps/web` MUST use the following stack.

- **UI framework: React.** React replaces SolidJS. Rationale: agent-authored code reliability (training-data density), and alignment with the standards and libraries below whose reference implementations are React.
- **Client/UI state: Zustand.** Zustand owns ephemeral and cross-component UI state only.
- **Server state: TanStack Query.** All reads and mutations that flow through `@openkit/core-client` MUST be managed as TanStack Query queries/mutations (caching, invalidation, streaming subscriptions). Server state MUST NOT be duplicated into Zustand.
- **Routing: React Router.**
- **Styling engine: Tailwind CSS v4** via the `@tailwindcss/vite` plugin, CSS-first configuration (`@import "tailwindcss";`), no legacy `tailwind.config.*` unless a documented need arises.
- **Design-system source: Adobe Spectrum.** Spectrum design tokens are the source of visual truth. They are projected into a Tailwind theme via the token bridge (below). Component visuals MUST reference semantic theme tokens, never hard-coded palette values.
- **Accessible behavior layer: React Aria Components** (`react-aria-components`). OpenKit primitives wrap React Aria behavior and apply Spectrum-tokened Tailwind styling. This is the default; the full React Spectrum component library is not the default.
- **daisyUI: removed.** daisyUI cannot be Spectrum-faithful and conflicts with React Aria. Its "low maintenance" only holds when its generic look is acceptable, which it is not here.
- **Generative UI: A2UI.** Agent-declared UI is expressed as A2UI declarative JSON and rendered with A2UI's official React renderer over the shared web-core, mapped to OpenKit's Spectrum-tokened component set. Target the stable `v0.9.x` family and track the `v1.0` release candidate.
- **Icons: Iconify with Remix Icon (unchanged).** Keep the existing icon pattern; do not introduce a new icon stack. Do not handcraft SVG icons when an appropriate Remix Icon exists.
- **Dependencies are direct.** The Adobe Spectrum token package and the A2UI React renderer are direct dependencies of `apps/web`, not vendored snapshots. A vendored snapshot is a fallback only if a licensing or stability issue later requires it.
- **Rebuild is in place.** `apps/web` is rebuilt in place on the new stack; no parallel `web-next` app is created.
- **Data access boundary unchanged:** the Web UI consumes the server only through the composed `@openkit/core-client` sub-clients.

## Contract / Expected Behavior

### Token-bridge contract

- There MUST be a single source file that maps Adobe Spectrum tokens (global + alias/semantic) to OpenKit semantic Tailwind theme tokens: surface/background steps, foreground/text steps, primary/accent/neutral, `info`/`success`/`warning`/`error`, border tones, corner radii, spacing scale, and the type ramp.
- The **same token values MUST back both sides** of the design loop: the Spectrum design authored in Claude Design and the Tailwind theme compiled into code. When Spectrum tokens change, the bridge file is the single point of update.
- Component code MUST consume only the semantic theme tokens produced by the bridge. Raw Spectrum global tokens and hard-coded color/spacing/radius literals MUST NOT appear in component markup.
- A parity check (see Testing Strategy) MUST verify that computed theme token values match the Spectrum token source, so drift is caught mechanically.

### Layer boundaries

- Server state lives in TanStack Query; UI state lives in Zustand; the two MUST NOT overlap for the same datum.
- OpenKit component primitives MUST derive interaction and accessibility behavior from React Aria Components rather than reimplementing focus, keyboard, and ARIA semantics by hand.
- Generative surfaces MUST render through the A2UI renderer + OpenKit component mapping; they MUST NOT execute arbitrary agent-provided code.

## Proposed Design

The component architecture is three layered tiers.

1. **Token + theme tier.** The token-bridge source file plus the Tailwind theme it produces. This is the shared vocabulary with Claude Design.
2. **Primitive tier.** OpenKit primitives (button, field, select, dialog, menu, tabs, table, badge, tooltip, etc.) = React Aria Components behavior + Spectrum-tokened Tailwind styling. Each primitive maps to one Spectrum component and one Claude Design frame. Heavy widgets that are framework-agnostic (CodeMirror-based editors, diff/tree views) are wrapped here.
3. **Screen tier.** Screens compose primitives, read/write data via `core-client` + TanStack Query, and follow the IA and interaction rules in `DESIGN.md`. Generative regions embed the A2UI renderer.

### DESIGN.md reconciliation deltas

`DESIGN.md` keeps all stack-agnostic guidance (two-region shell, centered single-column main panel, sidebar model, interaction patterns, accessibility, responsive rules). The following sections MUST be updated to match this stack; until then `DESIGN.md` contradicts current guidance:

- **Theme System.** Replace "all 35 built-in daisyUI themes / `themes: all`" and daisyUI-named tokens (`base-100`…) with the Spectrum-derived semantic theme produced by the token bridge. Theme selection, if retained, is over Spectrum-defined light/dark (and any brand) variants, not the daisyUI theme catalog.
- **Visual System.** Reconcile the fixed "8px maximum radius" rule with Spectrum's corner-radius scale (adopt Spectrum's radii as the source, expressed as bridge tokens).
- **Implementation Guardrails.** Replace "use the repository's existing Solid, daisyUI, Iconify, and Remix Icon patterns" with React, React Aria Components, Spectrum tokens on Tailwind, and the icon decision (see Open Questions).
- **References.** Add Adobe Spectrum, React Aria Components, and A2UI; the daisyUI reference is superseded.

These deltas are recorded here; applying them to `DESIGN.md` is the first rollout step below.

## Current Implementation Projection

- Target: `apps/web` rebuilt in place on the new stack.
- Unaffected: `packages/core-client` and `packages/protocol` are framework-agnostic and require no change for the view-layer rebuild.
- Superseded operational guidance: [`docs/cookbooks/spa-solid-vite.md`](../cookbooks/spa-solid-vite.md) no longer describes the Web UI default and is deprecated in favor of a React + Spectrum + Tailwind scaffold cookbook.
- New operational guidance: the design→code workflow is owned by [`docs/cookbooks/claude-design-web-ui-loop.md`](../cookbooks/claude-design-web-ui-loop.md).

## Alternatives Considered

- **Stay on SolidJS.** Simpler mental model and better raw runtime performance, and it is the current codebase. Rejected as the default because the deciding context is agent-authored code and reliance on external standards: agents produce React more reliably (denser training data), A2UI's maintained renderer and React Aria (Adobe's own Spectrum behavior) are React, and maintaining Solid adapters for an evolving A2UI standard and Spectrum behaviors is a recurring tax paid where agents are weakest. Solid remains the better choice only for human-authored, performance-critical, low-ecosystem-dependency apps.
- **Keep daisyUI, retint toward Spectrum.** Lowest component-build effort, but daisyUI component anatomy is not Spectrum and cannot reach Spectrum fidelity; it would also fight React Aria. Rejected.
- **Adopt full React Spectrum component library.** Highest out-of-the-box Spectrum fidelity, but heavy, opinionated, and works against the Tailwind-based, low-maintenance goal. Rejected as default; React Aria + tokens gives Spectrum fidelity with a Tailwind implementation. May be selectively used for complex widgets (see Deferred Work).
- **A2UI on a custom Solid renderer over web-core.** Possible since A2UI is framework-agnostic, but the official maintained renderer is React; a Solid renderer is ongoing DIY maintenance against a moving standard. Rejected together with the framework decision.

## Consequences

- Positive: the Claude Design (Spectrum) → code (React Aria + Spectrum tokens) gap is minimized because both sides use Adobe's own behavior layer and tokens, which is what makes the automated design loop able to converge. Agent output reliability improves. A2UI and heavy-component ecosystems are first-class.
- Negative: React has more runtime overhead than Solid; streaming item logs and large lists MUST use virtualization. The rebuild requires porting tests from `@solidjs/testing-library` to React Testing Library and re-expressing reactive logic. The team takes on A2UI standard-churn tracking.

## Rollout / Migration Plan

Internal development: no backward-compatibility layers are preserved; the clean target wins.

1. Apply the DESIGN.md reconciliation deltas above so design guidance and this spec agree.
2. Author the React + Spectrum + Tailwind scaffold cookbook and deprecate `spa-solid-vite.md` for the Web UI default.
3. Scaffold the rebuilt `apps/web`; establish the token-bridge source file and the primitive tier before screens.
4. Rebuild screens behind the L6 stories so the acceptance surface guards behavior continuity through the migration; wire data via `core-client` + TanStack Query.
5. Remove Solid/daisyUI dependencies and dead assets once screens reach parity; move superseded Web slice specs/cookbook guidance to their retired/superseded locations with replacement links.
6. Commit per the repository sequence: when a design needs a capability NanoCore/protocol lacks, change `packages/protocol` → `apps/nanocore` → `apps/web` in that order, each committed separately.

## Testing Strategy / Acceptance Criteria

- `pnpm --filter @openkit/web typecheck`, `test`, and `build` pass; L0–L6 pass, with L6 stories green through each ported screen.
- **Token parity test:** computed theme token values match the Spectrum token source; no hard-coded palette/radius/spacing literals in component markup (lint or test enforced).
- **Fidelity gate:** visual-regression of each implemented screen against its finalized Claude Design frame is within tolerance (see the cookbook for the gate mechanics).
- Accessibility: React Aria-backed primitives pass automated a11y checks (e.g., axe) and keyboard/focus assertions.
- No `solid-js`, `vite-plugin-solid`, `@solidjs/*`, or `daisyui` remain in `apps/web` dependencies after step 5.

## Risks & Mitigations

- **A2UI standard churn (v0.9 → v1.0 RC).** Pin a version, isolate the renderer behind an OpenKit mapping layer, and treat renderer upgrades as scoped changes.
- **Spectrum token/behavior availability and licensing.** The Spectrum token package, React Aria, and the A2UI renderer are direct dependencies; confirm their licenses are compatible before adoption and fall back to a vendored snapshot only if a licensing or stability issue arises (see `20260522-vendor_snapshot_packages.md`).
- **React performance for streaming/large logs.** Mandate list virtualization and memoization on high-frequency surfaces.
- **`/design` autonomy is unverified.** The design loop must have a manual/browser fallback; the cookbook documents both paths.

## Open Questions

- [Non-blocking] A2UI version pin and the trigger for adopting the `v1.0` release candidate.
- [Non-blocking] Where, if anywhere, to selectively adopt full React Spectrum components for complex widgets instead of custom React Aria + Tailwind.

Resolved: icons stay on Iconify + Remix Icon; `apps/web` is rebuilt in place; the Spectrum token package and A2UI renderer are direct dependencies. These are recorded in the Decision section.

## Deferred / Future Work

- Packaging the SPA into the Tauri desktop shell described in `docs/product-vision.md`.
- A shared A2UI component catalog reused across generative surfaces.
- Selective React Spectrum adoption for the heaviest widgets if custom primitives prove costly.

## Links

- Product-surface posture: [`20260628-web_product_surface_projection.md`](./20260628-web_product_surface_projection.md)
- Client boundary: [`20260528-core_client_boundary.md`](./20260528-core_client_boundary.md)
- Test model: [`20260529-test_strategy.md`](./20260529-test_strategy.md), [`20260529-l6_story_acceptance.md`](./20260529-l6_story_acceptance.md)
- AI-native coordination surface: [`20260713-openkit_agent_skill_interface.md`](./20260713-openkit_agent_skill_interface.md)
- Design guide: [`../../DESIGN.md`](../../DESIGN.md)
- Design→code workflow: [`../cookbooks/claude-design-web-ui-loop.md`](../cookbooks/claude-design-web-ui-loop.md)
- Superseded scaffold: [`../cookbooks/spa-solid-vite.md`](../cookbooks/spa-solid-vite.md)
- External: Adobe Spectrum design system; React Aria Components (`react-aria-components`); A2UI (`https://a2ui.org/`, `https://github.com/google/a2ui`); Claude Design (`https://claude.ai/design`).
