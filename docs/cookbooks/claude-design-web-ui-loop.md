# Claude Design + Claude Code Web UI Loop

Use this cookbook when building or changing OpenKit Web UI screens through the Claude Design ↔ Claude Code loop. It is the operational source of truth for how a design request becomes finalized design and then implemented, agent-first, web UI.

This cookbook owns the **workflow**. The **stack** it targets (React, Zustand, React Router, TanStack Query, Adobe Spectrum tokens on Tailwind, React Aria Components, A2UI, no daisyUI) is owned by [`docs/specs/20260710-web_ui_rebuild_stack.md`](../specs/20260710-web_ui_rebuild_stack.md). Read that spec first.

## Policy

- Lean on agents as much as possible. A human states intent and approves at two gates; agents do the intake, design authoring, doc reconciliation, implementation, and verification in between.
- Keep the Web UI a projection over stable NanoCore/App API contracts. If a requested design needs a capability the kernel does not yet support, **stop and go protocol-first**: `docs/specs` → `packages/protocol` → `apps/nanocore` → `apps/web`, per the root `AGENTS.md`. Do not design UI for capabilities the kernel cannot back.
- The design source of truth is split by design: **`DESIGN.md` owns durable intent** (IA, layout, interaction, accessibility rules); **Claude Design owns the living visual/interactive form**. They are kept in bidirectional sync through the token bridge, component inventory, and flow list.
- Consume the server only through `@openkit/core-client` sub-clients. Follow test-first development.

## Prerequisites

- Claude Design is connected in Claude Code. The user runs `/design` themselves (it is a built-in Claude Code command; agents cannot invoke it). Confirm `login` and that the OpenKit project + Adobe Spectrum design system are present.
- The token-bridge source file exists (or is created in the first run) per the stack spec: it maps Spectrum tokens to OpenKit semantic Tailwind theme tokens and backs both the Claude Design side and the code side.

## `/design` capability caveat (read before automating)

`/design` advertises `login`, `import`, `create`, `export`, and `sync`. The exact surface exposed to the agent (how much design authoring vs. only import/export/sync) MUST be confirmed by running `/design` once. This cookbook documents an **ideal agent-driven path** and a **fallback path**; use whichever the confirmed surface supports, and record the confirmed surface in the run notes.

## The Loop

### Phase 1 — Intake (agent)

1. The user states the need in Claude Code, attaching screenshots/references.
2. The agent reads the relevant context before proposing anything: `DESIGN.md`, the owning specs (start from `20260710-web_ui_rebuild_stack.md` and `20260628-web_product_surface_projection.md`), the existing components under `apps/web/src`, and the real API/protocol surface via `@openkit/core-client` and `docs/core/protocol.md`.
3. The agent produces a short **design brief / context pack**: the domain semantics involved (which workspace/thread/turn/item/approval/artifact/agent-session states and flows), which capabilities are real vs. absent, the screens/states to cover, and the Spectrum tokens/primitives in play. This brief is what makes Claude Design produce a semantically correct design rather than a merely attractive one.
4. If the brief reveals a capability gap, invoke the protocol-first rule and stop the UI loop until the contract exists.

### Phase 2 — Author the design in Claude Design (agent, with fallback)

- **Ideal path:** the agent uses the confirmed `/design` verbs (`create`/`import`/`sync`) to author or update the design in Claude Design from the brief, the Spectrum system, and the screenshots. The design MUST be authored in the shared Spectrum tokens so exported markup already speaks the bridge vocabulary.
- **Fallback path (if `/design` does not expose agent authoring):** the agent prepares a precise design instruction doc plus assets and the user applies them in Claude Design; or the agent drives the Claude Design web UI through browser automation for read/trigger steps. Browser automation is acceptable for reading and export, but is fragile for canvas authoring — prefer the instruction-doc fallback for authoring.

### Phase 3 — Human finalize (gate 1, user)

- The user opens Claude Design, reviews and adjusts, and finalizes the frames. This is a required human gate. Nothing proceeds to implementation from a non-finalized design.

### Phase 4 — Pull back and reconcile docs (agent)

1. The agent pulls the finalized design via `/design` `export`/`sync` (tokens, structure, frames, and any handoff bundle).
2. If Spectrum tokens changed, the agent updates the single token-bridge source file (both sides update from one place).
3. The agent reconciles **durable, decided** intent into `DESIGN.md` — only decisions that constrain future implementation; exploratory pixel details stay in Claude Design. The agent updates the sync ledger entry: which Claude Design frame ↔ which `DESIGN.md` section ↔ which component/flow changed.

### Phase 5 — Implement (agent)

- Test-first. Build from the primitive tier (React Aria Components + Spectrum-tokened Tailwind) up to screens; wire data through `@openkit/core-client` + TanStack Query; render generative regions through the A2UI renderer + OpenKit component mapping.
- Use the handoff bundle as the **structural spec** (layout, spacing, composition, states), not as production code to paste. Atoms (button, badge, field, theme/preview cards) may be near-direct; data-driven screens are re-implemented behind the same look.

### Phase 6 — Fidelity gate and verify (gate 2, agent + human)

- **Fidelity gate:** visual-regression each implemented screen against its finalized Claude Design frame (screenshot diff within tolerance). This is how "1:1" is *proven*, not asserted.
- Run L0–L6, the token-parity check, and accessibility checks (axe + keyboard/focus). L6 stories guard behavior.
- A human approves at the gate. Then commit per the repository sequence (protocol → nanocore → web when protocol changed), separate commits, Conventional Commits.

## Suggested agent orchestration

To keep the loop agent-first, split work across sub-agents with human approval only at the two gates:

- an **intake/research agent** for Phase 1 (reads docs/code/API, writes the brief);
- an **implementation agent** for Phase 5 (test-first build against the brief + handoff bundle);
- a **verification agent** for Phase 6 (fidelity gate, L0–L6, token parity, a11y).

The main agent orchestrates, owns Phase 4 doc reconciliation, and routes the two human gates.

## Tools and commands

- `/design` — user-run in Claude Code: `login`, `import`, `create`, `export`, `sync` (confirm surface once).
- `Read` over `DESIGN.md`, `docs/specs/*`, `apps/web/src`, `@openkit/core-client`, `docs/core/protocol.md` for intake.
- `pnpm --filter @openkit/web dev | test | typecheck | build`; `pnpm --filter @openkit/web e2e:stories` for L6.
- Playwright for the visual-regression fidelity gate; `biome` for lint/format.

## Notes

- Keep DESIGN.md as durable intent, never a pixel spec; keep Claude Design as the living visuals; the token bridge is the reconciliation anchor.
- "Fully unattended" is a non-goal. The realistic shape is agent-automated work with two human gates: finalize-in-Claude-Design and the fidelity gate before merge.
- When the confirmed `/design` surface or the A2UI/Spectrum tooling changes materially, update this cookbook and the stack spec together.
