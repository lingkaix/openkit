# AGENTS — @openkit/web

Read the sibling [`README.md`](./README.md) first for purpose, scope, stack,
commands, and structure. This file only records local agent execution rules that
are not already covered by the root `AGENTS.md` or the README.

## Local rules

- **Design authority is the accepted owning specifications plus `DESIGN.md`** (repo root), using the applicable existing Claude Design references named by the design ledger. Do not treat the board inventory as a page-admission catalog or require a dedicated frame for every surface. Do not invent layout, interaction, color, or component behavior here; if existing references do not settle new visual intent, update the owning design guidance first.
- **Semantic tokens only.** Component markup uses the bridge tokens (Tailwind
  utilities like `bg-canvas`, `text-fg`, `rounded-ok`, or the `--*` semantic
  vars). Never reference a raw Spectrum palette value or a hard-coded
  hex/spacing/radius literal. The theme-invariant brand quad + worker hues are
  the only allowed literals.
- **Behavior from React Aria.** Interactive primitives wrap `react-aria-components`;
  never reimplement focus, keyboard, or ARIA on a decorative `div`.
- **Server state via TanStack Query over `@openkit/core-client`;** UI-only state
  via Zustand. Never duplicate server state into Zustand.
- **Test-first** for behavior changes (root `AGENTS.md` clauses [TEST-002] and [TEST-009]); prefer the lowest layer that
  proves the invariant. Keep the token-bridge parity test green.
- **Surfaces ahead of their kernel contract remain unpublished** (DESIGN.md §11) — keep internal review implementations out of public navigation and routing, and do not wire their actions as if live.
