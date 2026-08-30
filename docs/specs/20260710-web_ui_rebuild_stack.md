---
status: Accepted
implementation: Partial
---
# Web UI Rebuild Stack

## Owns

- The implementation stack for the rebuilt OpenKit Web UI: UI framework, client state, routing, server-state access pattern, styling engine, design-system source, accessible behavior layer, generative-UI standard, and component-architecture posture.
- The **token-bridge contract** that makes an Adobe Spectrum design in Claude Design map to Tailwind-implemented code at high visual fidelity.
- The reconciliation deltas that `DESIGN.md` must absorb because of this stack change.
- The current implementation projection of the rebuilt `apps/web`.
- The component and state-placement boundary for the shared unified conversation Composer.

## Does Not Own

- Kernel, protocol, App API, workflow, storage, permission, capability, or knowledge semantics. Those stay owned by `docs/core/*` and their protocol/runtime specs.
- The Web UI product-surface posture and the minimum contract-backed product areas, which are owned by [`20260628-web_product_surface_projection.md`](./20260628-web_product_surface_projection.md).
- Information architecture, layout, sidebar model, and ordinary interaction rules remain owned by `DESIGN.md`. The unified Composer is the explicit exception: `docs/specs/20260831-unified_conversation_composer.md` owns its observable interaction contract, while `DESIGN.md` supplies only the visual projection and tokens.
- The design→code collaboration workflow, which is owned by the cookbook [`docs/cookbooks/claude-design-web-ui-loop.md`](../cookbooks/claude-design-web-ui-loop.md).

## Core References

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/protocol.md`

## Intent

- `docs/product-vision.md`

## Summary

The OpenKit Web UI is being fully rebuilt. This spec records the target implementation stack and the contracts that keep the rebuild coherent.

The stack moves from SolidJS + daisyUI to **React** with **Zustand** (UI/client state), **React Router** (routing), and **TanStack Query** (server-state over `@openkit/core-client`). The visual design language becomes **Adobe Spectrum**, projected as design tokens into a **Tailwind CSS v4** theme, with accessible behavior supplied by **React Aria Components** (Adobe's own headless implementation of Spectrum behavior). **daisyUI is removed.** The official A2UI React renderer and Adobe Spectrum token package remain required target dependencies; the current local substitutes are recorded below and keep this specification `Partial`.

The decisive constraint is that most implementation work is performed by AI agents. The stack is therefore chosen for ecosystem density (more reliable agent output), for standards whose reference implementations are React (A2UI, React Aria), and for tight design-to-code fidelity with the applicable Spectrum visual references. A finalized Claude Design frame is an implementation oracle only when the surface is frame-backed; otherwise the oracle is the accepted reference composition recorded in `DESIGN.md`.

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

Before the rebuild, `apps/web` was a small SolidJS SPA (Vite, Tailwind v4, daisyUI, Iconify/Remix, CodeMirror, Zod) that consumed the server only through the composed `@openkit/core-client` sub-clients. The abstracted data layer kept the framework change contained: `core-client` and the protocol package remained unaffected.

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
- **Delivery posture:** the Web UI is a professional-workspace SPA that may later ship inside a desktop application shell, so bundle byte size and Vite chunk-size warnings are informational rather than release acceptance predicates; add a size or loading budget only when an accepted measured transfer, parse, startup, or interaction objective requires one.

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
- The shared Composer keeps only its editable draft, selected target reference, selected logical model, selected Artifact references, pending local file import, and retry request identity in component or UI state. Target catalogs and accepted submissions are server state owned by TanStack Query and `@openkit/core-client`; neither is copied into Zustand.

### Unified Composer component boundary

The existing `Composer` primitive remains the sole starter and active-Thread input component. It expands its current textarea and submit callback rather than adding a second Composer implementation. Native textarea measurement and CSS provide bounded auto-growth; React Aria controls provide the Artifact, target, logical-model, and Send interactions. No new UI dependency, form framework, upload framework, editor, or browser persistence owner is added.

The primitive renders the observable two-region contract owned by `docs/specs/20260831-unified_conversation_composer.md`, applies the visual tokens projected by `DESIGN.md`, and emits one structured value containing text, target reference, logical-model preference, and ordered Artifact references. Screen adapters own target-catalog queries, supported local-file import through the existing Core Client, starter Thread creation, structured submission, navigation to the receiving Workspace and Thread, and exact cache invalidation. The primitive never calls NanoCore, resolves defaults, joins runtime state, or interprets target references.

Draft state survives a failed mutation and clears only on accepted submission. It does not survive a page reload because no accepted requirement justifies browser persistence. A catalog refresh may update labels and availability while preserving the exact selected reference; a missing or incompatible selection remains visibly invalid until the User chooses again.

## Proposed Design

The component architecture is three layered tiers.

1. **Token + theme tier.** The token-bridge source file plus the Tailwind theme it produces. This is the shared vocabulary with Claude Design.
2. **Primitive tier.** OpenKit primitives (button, field, select, dialog, menu, tabs, table, badge, tooltip, etc.) = React Aria Components behavior + Spectrum-tokened Tailwind styling. Each primitive maps to the applicable Spectrum component behavior and semantic tokens; board 11 is the shared component reference rather than an admission requirement for one dedicated frame per primitive. Heavy widgets that are framework-agnostic (CodeMirror-based editors, diff/tree views) are wrapped here.
3. **Screen tier.** Screens compose primitives, read/write data via `core-client` + TanStack Query, and follow the IA and interaction rules in `DESIGN.md`. Generative regions embed the A2UI renderer.

### DESIGN.md reconciliation deltas

`DESIGN.md` keeps all stack-agnostic guidance (two-region shell, centered single-column main panel, sidebar model, interaction patterns, accessibility, responsive rules). Its current guidance reflects these stack deltas:

- **Theme System.** Replace "all 35 built-in daisyUI themes / `themes: all`" and daisyUI-named tokens (`base-100`…) with the Spectrum-derived semantic theme produced by the token bridge. Theme selection, if retained, is over Spectrum-defined light/dark (and any brand) variants, not the daisyUI theme catalog.
- **Visual System.** Reconcile the fixed "8px maximum radius" rule with Spectrum's corner-radius scale (adopt Spectrum's radii as the source, expressed as bridge tokens).
- **Implementation Guardrails.** Replace "use the repository's existing Solid, daisyUI, Iconify, and Remix Icon patterns" with React, React Aria Components, Spectrum tokens on Tailwind, and the icon decision (see Open Questions).
- **References.** Add Adobe Spectrum, React Aria Components, and A2UI; the daisyUI reference is superseded.

These deltas remain recorded here as the stack-owned source for the reconciled `DESIGN.md` projection.

## Current Implementation Projection

- Current: `apps/web` is rebuilt in place with React, Zustand, React Router, TanStack Query, Tailwind CSS v4, React Aria Components, and the existing Iconify/Remix pattern.
- Current Composer divergence: `apps/web/src/primitives/Composer.tsx` is text-only, uses fixed textarea rows, places Send beside the textarea, and exposes neither the accepted lower action row nor structured draft output.
- Partial stack conformance: `apps/web/src/screens/generative/` contains a custom local A2UI-like declarative renderer and whitelist catalog rather than the official A2UI React renderer, and `apps/web/src/styles/tokens.css` is a hand-maintained Spectrum-derived semantic bridge rather than a projection sourced from Adobe's token package.
- Missing direct dependencies: `apps/web/package.json` and the lockfile contain neither the official A2UI React renderer nor the Adobe Spectrum token package.
- Unaffected: `packages/core-client` and `packages/protocol` are framework-agnostic and require no change for the view-layer rebuild.
- Retired operational guidance: [`docs/cookbooks/spa-solid-vite.md`](../cookbooks/spa-solid-vite.md) is a retirement stub that points at this stack and the design→code cookbook.
- Current operational guidance: the design→code workflow is owned by [`docs/cookbooks/claude-design-web-ui-loop.md`](../cookbooks/claude-design-web-ui-loop.md).

## Alternatives Considered

- **Stay on SolidJS.** At decision time this offered a simpler mental model and better raw runtime performance. Rejected as the default because the deciding context is agent-authored code and reliance on external standards: agents produce React more reliably (denser training data), A2UI's maintained renderer and React Aria (Adobe's own Spectrum behavior) are React, and maintaining Solid adapters for an evolving A2UI standard and Spectrum behaviors is a recurring tax paid where agents are weakest. Solid remains the better choice only for human-authored, performance-critical, low-ecosystem-dependency apps.
- **Keep daisyUI, retint toward Spectrum.** Lowest component-build effort, but daisyUI component anatomy is not Spectrum and cannot reach Spectrum fidelity; it would also fight React Aria. Rejected.
- **Adopt full React Spectrum component library.** Highest out-of-the-box Spectrum fidelity, but heavy, opinionated, and works against the Tailwind-based, low-maintenance goal. Rejected as default; React Aria + tokens gives Spectrum fidelity with a Tailwind implementation. May be selectively used for complex widgets (see Deferred Work).
- **A2UI on a custom Solid renderer over web-core.** Possible since A2UI is framework-agnostic, but the official maintained renderer is React; a Solid renderer is ongoing DIY maintenance against a moving standard. Rejected together with the framework decision.

## Consequences

- Positive: the Claude Design (Spectrum) → code (React Aria + Spectrum tokens) gap is minimized because both sides use Adobe's own behavior layer and tokens, which is what makes the automated design loop able to converge. Agent output reliability improves. A2UI and heavy-component ecosystems are first-class.
- Negative: React has more runtime overhead than Solid; streaming item logs and large lists MUST use virtualization. The rebuild requires porting tests from `@solidjs/testing-library` to React Testing Library and re-expressing reactive logic. The team takes on A2UI standard-churn tracking.

## Rollout / Migration Plan

Internal development: no backward-compatibility layers are preserved; the clean target wins.

1. Keep the `DESIGN.md` projection aligned with the reconciliation deltas above.
2. Author the React + Spectrum + Tailwind scaffold cookbook and deprecate `spa-solid-vite.md` for the Web UI default.
3. Scaffold the rebuilt `apps/web`; establish the token-bridge source file and the primitive tier before screens.
4. Rebuild screens behind the lowest sufficient L1-L5 checks so the acceptance surface guards behavior continuity through the migration; wire data via `core-client` + TanStack Query. Admit agent-first L6 verification only when a distinct real-agent, real-environment, or other L6-only risk cannot be represented below L6.
5. Remove Solid/daisyUI dependencies and dead assets once screens reach parity; move superseded Web slice specs/cookbook guidance to their retired/superseded locations with replacement links.
6. Commit per the repository sequence: when a design needs a capability NanoCore/protocol lacks, change `packages/protocol` → `apps/nanocore` → `apps/web` in that order, each committed separately.

## Testing Strategy / Acceptance Criteria

- `pnpm --filter @openkit/web typecheck`, `test`, and `build` pass, together with the applicable L1-L5 checks. Agent-first L6 verification is required only for a distinct admitted L6 risk; ordinary screen completion does not create an L6 obligation.
- **Token parity test:** computed theme token values match the Spectrum token source; no hard-coded palette/radius/spacing literals in component markup (lint or test enforced).
- **Fidelity gate:** every implemented screen receives final human fidelity review. A frame-backed surface is compared against its finalized Claude Design frame, including visual-regression evidence when the harness is available. A reference-backed surface is reviewed against `DESIGN.md`, its owning specifications, the recorded reference-board composition, shared tokens and themes, applicable primitives, layout and density rules, required states, and accessibility; it makes no 1:1 frame claim.
- Accessibility: React Aria-backed primitives pass automated a11y checks (e.g., axe) and keyboard/focus assertions.
- Composer checks cover one shared primitive on starter and active-Thread surfaces, bounded textarea growth with a fixed action row, Enter and Shift+Enter behavior, accessible icon and selector names, pending-import state, exact failure retention, and no duplicate submit.
- No `solid-js`, `vite-plugin-solid`, `@solidjs/*`, or `daisyui` remain in `apps/web` dependencies after step 5.

## Risks & Mitigations

- **A2UI standard churn (v0.9 → v1.0 RC).** Pin a version, isolate the renderer behind an OpenKit mapping layer, and treat renderer upgrades as scoped changes.
- **Spectrum token/behavior availability and licensing.** The Spectrum token package, React Aria, and the A2UI renderer are direct dependencies; confirm their licenses are compatible before adoption and fall back to a vendored snapshot only if a licensing or stability issue arises (see `20260522-vendor_snapshot_packages.md`).
- **React performance for streaming/large logs.** Mandate list virtualization and memoization on high-frequency surfaces.
- **`/design` autonomy is unverified.** The design loop must have a manual/browser fallback; the cookbook documents both paths.

## Open Questions

- [Non-blocking] A2UI version pin and the trigger for adopting the `v1.0` release candidate.
- [Non-blocking] Where, if anywhere, to selectively adopt full React Spectrum components for complex widgets instead of custom React Aria + Tailwind.

Resolved target: icons stay on Iconify + Remix Icon; `apps/web` is rebuilt in place; the Spectrum token package and A2UI renderer must become direct dependencies before stack conformance is complete. These decisions are recorded in the Decision section.

## Deferred / Future Work

- Packaging the SPA into the Tauri desktop shell described in `docs/product-vision.md`.
- A shared A2UI component catalog reused across generative surfaces.
- Selective React Spectrum adoption for the heaviest widgets if custom primitives prove costly.

## Stack-Conformance Backlog

This backlog records current divergence and does not authorize dependency or implementation work. Activation requires a separately frozen change under the repository dependency procedure after exact package identity, compatible version, license, and migration shape are verified.

- Replace the custom local A2UI-like renderer with the official A2UI React renderer while preserving the existing OpenKit whitelist mapping and plain-content fallback.
- Add the Adobe Spectrum token package as a direct Web dependency and make the semantic Tailwind bridge derive from that package rather than from hand-maintained copied values.

This specification may return to `Implemented` only when both direct dependencies are present in `apps/web/package.json` and the lockfile, production imports use the official renderer and package-backed token source, focused renderer and token-parity checks pass, and the replaced local ownership is removed rather than retained as a parallel implementation.

## Links

- Product-surface posture: [`20260628-web_product_surface_projection.md`](./20260628-web_product_surface_projection.md)
- Client boundary: [`20260528-core_client_boundary.md`](./20260528-core_client_boundary.md)
- Test model: [`20260529-test_strategy.md`](./20260529-test_strategy.md), [`20260529-l6_story_acceptance.md`](./20260529-l6_story_acceptance.md)
- AI-native coordination surface: [`20260713-openkit_agent_skill_interface.md`](./20260713-openkit_agent_skill_interface.md)
- Design guide: [`../../DESIGN.md`](../../DESIGN.md)
- Design→code workflow: [`../cookbooks/claude-design-web-ui-loop.md`](../cookbooks/claude-design-web-ui-loop.md)
- Retired scaffold stub: [`../cookbooks/spa-solid-vite.md`](../cookbooks/spa-solid-vite.md)
- External: Adobe Spectrum design system; React Aria Components (`react-aria-components`); A2UI (`https://a2ui.org/`, `https://github.com/google/a2ui`); Claude Design (`https://claude.ai/design`).
