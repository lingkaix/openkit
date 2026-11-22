---
status: Accepted
implementation: Implemented
kind: topology
aspect: architecture
---
# Web UI Rebuild Stack

This specification owns the Web UI implementation stack and the token bridge.

## Scope

Owns the framework, client state, routing, server-state access, styling, the Spectrum token bridge, accessible behavior, the A2UI renderer posture, and Composer state placement.

Does not own product-surface workflows. [Web Product Surface](20260628-web_product_surface_projection.md) owns them.

Does not own Composer interaction. [Unified Conversation Composer](20260831-unified_conversation_composer.md) owns it.

Does not own the design-to-code workflow. [The design loop](../cookbooks/claude-design-web-ui-loop.md) owns it.

Core: [Architecture](../core/architecture.md).

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
- **Generative UI: A2UI.** Agent-declared UI is expressed as A2UI declarative JSON and rendered with A2UI's official React renderer over the shared web-core, mapped to OpenKit's Spectrum-tokened component set. The direct packages are `@a2ui/react` and `@a2ui/web_core` at 0.15.0. Production imports use protocol `v0_9`. Package version and protocol version are distinct. Eventual `v1.0` compatibility is not a current release wait. A2UI organizes native components and one generic PluginWidget for specialized, registered MCP Apps HTML. Web owns isolated iframe hosting and standard bridge integration; Plugin code never runs in the host DOM. Presentation, action, resource identity, host capability boundaries, and saved-view behavior are owned separately by [Generative UI Interaction](20260908-generative_ui_interaction.md); Kernel is not a prerequisite for UI over existing sources.
- **Icons: Iconify with Remix Icon (unchanged).** Keep the existing icon pattern; do not introduce a new icon stack. Do not handcraft SVG icons when an appropriate Remix Icon exists.
- **Dependencies are direct.** The A2UI React renderer is a direct dependency. The Adobe Spectrum token package is also required as a direct dependency, not a vendored snapshot. A vendored snapshot is a fallback only if a licensing or stability issue later requires it.
- **Rebuild is in place.** `apps/web` is rebuilt in place on the new stack; no parallel `web-next` app is created.
- **Data access boundary unchanged:** the Web UI consumes the server only through the composed `@openkit/core-client` sub-clients.
- **Delivery posture:** the Web UI is a professional-workspace SPA whose Desktop shell is deferred beyond v0.1.0, so bundle byte size and Vite chunk-size warnings are informational rather than release acceptance predicates; add a size or loading budget only when an accepted measured transfer, parse, startup, or interaction objective requires one.

## Contract / Expected Behavior

### Token-bridge contract

- Spectrum values MUST come from the exactly pinned `@adobe/spectrum-tokens` package through one generated file (`apps/web/src/styles/spectrum.generated.css`, written by `apps/web/scripts/gen-tokens.mjs` from an allowlist, light and dark as `light-dark()` values). There MUST be a single semantic source file (`apps/web/src/styles/tokens.css`) that maps those values to OpenKit semantic Tailwind theme tokens: surface/background steps, foreground/text steps, primary/accent/neutral, `info`/`success`/`warning`/`error`, border tones, corner radii, spacing scale, and the type ramp.
- The **same token values MUST back both sides** of the design loop: the Spectrum design authored in Claude Design and the Tailwind theme compiled into code. When Spectrum tokens change, the package pin is the single point of update: bump it, regenerate, and review the component gallery.
- Component code MUST consume only the semantic theme tokens produced by the bridge. Raw Spectrum global tokens and hard-coded color/spacing/radius literals MUST NOT appear in component markup.
- A parity check MUST verify that the generated file matches the pinned package output and that every semantic role resolves to a generated Spectrum token in both color schemes, so drift is caught mechanically.

### Layer boundaries

- Server state lives in TanStack Query; UI state lives in Zustand; the two MUST NOT overlap for the same datum.
- OpenKit component primitives MUST derive interaction and accessibility behavior from React Aria Components rather than reimplementing focus, keyboard, and ARIA semantics by hand.
- Generative surfaces MUST render through A2UI and the OpenKit mapping. The admitted PluginWidget component MAY delegate a region to registered MCP Apps HTML through the isolated host and standard bridge; no arbitrary agent-provided code may execute in the host DOM. Unknown components MUST NOT trigger an iframe fallback. Isolation, resource identity, current-authority actions, accessibility, local failure, and bridge conformance require the Generative UI contract before publication.
- The shared Composer keeps the editable `ComposerDraft`, including local files and the request identity, in component state. Target catalogs and accepted submissions are server state owned by TanStack Query and `@openkit/core-client`; neither is copied into Zustand.

### Unified Composer component boundary

The existing `Composer` primitive remains the sole starter and active-Thread input component. It expands its current textarea and submit callback rather than adding a second Composer implementation. Native textarea measurement and CSS provide bounded auto-growth; React Aria controls provide the Artifact, target, logical-model, conditional reasoning-effort, and Send interactions. No new UI dependency, form framework, upload framework, editor, or browser persistence owner is added.

The primitive renders the observable two-region contract owned by `docs/specs/20260831-unified_conversation_composer.md`, applies the visual tokens projected by `DESIGN.md`, and emits one `ComposerDraft`. Screen adapters own target-catalog queries, file digest and submission, starter Thread creation, structured submission, navigation to the receiving Workspace and Thread, and exact cache invalidation. The primitive never calls NanoCore, resolves defaults, joins runtime state, or interprets target references.

Draft state survives a failed mutation and clears only on accepted submission. It does not survive a page reload because no accepted requirement justifies browser persistence. A catalog refresh may update labels and availability while preserving the exact selected reference; a missing or incompatible selection remains visibly invalid until the User chooses again.


### Component tiers

1. Token and theme. The bridge file and the Tailwind theme.
2. Primitives. React Aria behavior plus Spectrum-tokened Tailwind. Board 11 is the shared component reference.
3. Screens. Screens compose primitives and read through `@openkit/core-client` and TanStack Query.

Corner radius follows the Spectrum scale in the bridge. There is no 8 px maximum and no 35-theme catalog. SolidJS and daisyUI are not compatibility targets.

Desktop application work, including a Tauri shell, stays beyond v0.1.0 under [D08](../decisions/20261015-discord_first_and_desktop_deferred.md). Virtualization is added only after a measured list problem. Full React Spectrum is not the default.

## Acceptance

Every implemented screen receives a final human fidelity review. A frame-backed surface is compared with its finalized frame, including visual-regression evidence when that evidence is available. A reference-backed surface is reviewed against `DESIGN.md`, its owning specifications, the recorded reference composition, shared tokens and themes, applicable primitives, layout and density, required states, and accessibility. A reference-backed review makes no 1:1 frame claim.

Remaining Spectrum and renderer work stays under the existing dependency procedure. Exact package identity, version, license, and migration shape are verified before any activation. This specification does not activate that work. Conformance requires production use of the package-backed renderer and token source, focused renderer and token parity, and removal of the replaced parallel ownership.

## Implementation

- `apps/web/src/`
- `apps/web/src/styles/`
- `apps/web/src/primitives/`
- `apps/web/src/generative/`
- Token bridge: `@adobe/spectrum-tokens` is an exactly pinned direct dependency of `apps/web`. `apps/web/scripts/gen-tokens.mjs` writes `apps/web/src/styles/spectrum.generated.css`, and `apps/web/src/styles/tokens.css` maps it to semantic roles. `apps/web/test/spectrum-tokens.test.ts` checks that the generated file matches the pinned package output, and `apps/web/src/test/tokens.test.ts` checks that every semantic role resolves to a generated token in both color schemes.

## Implementation Gaps

None.

## Decisions

- [Discord first and desktop deferred](../decisions/20261015-discord_first_and_desktop_deferred.md)
