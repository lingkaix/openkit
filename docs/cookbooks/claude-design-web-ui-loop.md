# Claude Design + Claude Code Web UI Loop

Use this cookbook when building or changing OpenKit Web UI screens through the Claude Design ↔ Claude Code loop. It is the operational source of truth for how a design request becomes finalized design and then implemented, agent-first, web UI.

This cookbook owns the **workflow**. The **stack** it targets (React, Zustand, React Router, TanStack Query, Adobe Spectrum tokens on Tailwind, React Aria Components, A2UI, no daisyUI) is owned by [`docs/specs/20260710-web_ui_rebuild_stack.md`](../specs/20260710-web_ui_rebuild_stack.md). Read that spec first.

## Policy

- Lean on agents as much as possible. A human states intent and performs final fidelity review; agents do the intake, reference selection or design authoring, doc reconciliation, implementation, and verification in between. Frame-backed work adds a human design-finalization gate before implementation.
- Keep the Web UI a projection over stable NanoCore/App API contracts. If a requested design needs a capability the kernel does not yet support, **stop and go protocol-first**: `docs/specs` → `packages/protocol` → `apps/nanocore` → `apps/web`, per the root `AGENTS.md`. Do not design UI for capabilities the kernel cannot back.
- The design source of truth is split by design: **`DESIGN.md` owns durable intent** (IA, layout, interaction, accessibility rules), accepted specifications own behavior, and **Claude Design supplies living visual/interactive references**. Its board inventory is non-exhaustive: a surface may be frame-backed by one finalized frame or reference-backed by a composition of existing boards, tokens, themes, primitives, layout and density rules, states, and accessibility guidance.
- Consume the server only through `@openkit/core-client` sub-clients. Follow test-first development.

## Prerequisites

- For frame-backed work or work that needs a new visual-language decision, Claude Design is connected in Claude Code. The user runs `/design` themselves (it is a built-in Claude Code command; agents cannot invoke it). Confirm `login` and that the OpenKit project + Adobe Spectrum design system are present. Reference-backed work proceeds from the durable `DESIGN.md` composition; use the living Claude Design project or an engineer-supplied authorized export only when actual canvas inspection is needed.
- The token-bridge source file exists (or is created in the first run) per the stack spec: it maps Spectrum tokens to OpenKit semantic Tailwind theme tokens and backs both the Claude Design side and the code side.

## `/design` capability caveat (read before automating)

`/design` advertises `login`, `import`, `create`, `export`, and `sync`. The exact surface exposed to the agent (how much design authoring vs. only import/export/sync) MUST be confirmed by running `/design` once. This cookbook documents an **ideal agent-driven path** and a **fallback path**; use whichever the confirmed surface supports, and record the confirmed surface in the run notes.

## The Loop

### Phase 1 — Intake (agent)

1. The user states the need in Claude Code, attaching screenshots/references.
2. The agent reads the relevant context before proposing anything: `DESIGN.md`, the owning specs (start from `20260710-web_ui_rebuild_stack.md` and `20260628-web_product_surface_projection.md`), the existing components under `apps/web/src`, and the real API/protocol surface via `@openkit/core-client` and `docs/core/protocol.md`.
3. The agent produces a short **design brief / context pack**: the domain semantics involved (which Workspace, Thread, Turn, Item, Approval, Artifact, and AgentSession states and flows), which capabilities are real vs. absent, the screens/states to cover, and the Spectrum tokens/primitives in play. This brief is what makes Claude Design produce a semantically correct design rather than a merely attractive one.
4. The agent classifies the surface as **reference-backed** when existing `DESIGN.md` guidance and board references deterministically cover its visual language, or **frame-backed** when one finalized frame already owns its layout. Author a new frame only when a current, contract-backed surface has unresolved or ambiguous visual language that the existing reference set cannot settle.
5. If the brief reveals a capability gap, invoke the protocol-first rule and stop the UI loop until the contract exists.

### Phase 2 — Resolve the visual oracle (agent, conditional authoring)

- **Reference-backed path:** record the exact existing boards and `DESIGN.md` sections that supply shell, layout, density, primitives, themes, system states, accessibility, and responsive behavior. The ledger must be deterministic enough for two implementers to compose the same surface, but it does not claim that any one board is a 1:1 screen specification.
- **Frame-backed path:** use the existing finalized frame. If Phase 1 established a genuinely unresolved visual-language need, the agent uses the confirmed `/design` verbs (`create`/`import`/`sync`) to author or update a design from the brief, Spectrum system, and references. The design MUST use the shared Spectrum tokens.
- **Authoring fallback:** if `/design` does not expose agent authoring, prepare a precise design instruction document plus assets for the user, or use browser automation for read and export steps. Prefer the instruction-document path over fragile canvas automation.

### Phase 3 — Human finalize a new or changed frame (conditional gate, user)

- This phase applies only when Phase 2 authored or materially changed a Claude Design frame. The user reviews, adjusts, and finalizes that frame before it becomes an implementation oracle. Reference-backed work skips this gate because its oracle is the accepted composition ledger, not an unfinalized frame.

### Phase 4 — Reconcile durable intent and the oracle ledger (agent)

1. For frame-backed work, the agent pulls the finalized design via `/design` `export`/`sync` when needed. Reference-backed work uses the durable composition in `DESIGN.md` and does not require a board export or create export evidence for the target surface.
2. If Spectrum tokens changed, the agent updates the single token-bridge source file so both visual references and code resolve from one semantic vocabulary.
3. The agent reconciles **durable, decided** intent into `DESIGN.md` and records whether the surface is frame-backed or reference-backed. A frame-backed ledger entry maps the finalized frame to the owning sections and flows. A reference-backed entry names the exact board composition plus the applicable tokens, themes, primitives, layout, density, states, responsive, and accessibility rules. Exploratory pixel detail stays outside `DESIGN.md`.

### Phase 5 — Implement (agent)

- Test-first. Build from the primitive tier (React Aria Components + Spectrum-tokened Tailwind) up to screens; wire data through `@openkit/core-client` + TanStack Query; render generative regions through the A2UI renderer + OpenKit component mapping.
- Use the applicable oracle as structural guidance, not as production code to paste. For frame-backed work that is the finalized handoff bundle. For reference-backed work it is the composition ledger plus the named design sources. Atoms (button, badge, field, theme/preview cards) may be near-direct; data-driven screens are re-implemented behind the same visual language.

### Phase 6 — Fidelity gate and verify (agent + human)

- **Universal fidelity gate:** a human reviews every implemented surface for conformance with `DESIGN.md`, the owning specifications, shared tokens and themes, primitives, layout and density rules, system states, responsive behavior, and accessibility. Frame-backed surfaces additionally compare against the finalized frame, using screenshot diff when available. Reference-backed surfaces compare against their recorded board composition and make no 1:1 frame claim.
- Run the applicable L1-L5 automated gates, the token-parity check, and accessibility checks (axe + keyboard/focus). Execute agent-first L6 only when a distinct admitted risk requires real-agent or real-environment evidence unavailable below L6.
- A human approves at the gate. Then commit per the repository sequence (protocol → nanocore → web when protocol changed), separate commits, Conventional Commits.

## Suggested agent orchestration

When material-work governance calls for separate roles, split the work at these seams:

- an **intake/research agent** for Phase 1 (reads docs/code/API, writes the brief);
- an **implementation agent** for Phase 5 (test-first build against the brief and applicable oracle);
- a **verification agent** for Phase 6 (fidelity gate, applicable L1-L5, any distinctly admitted L6, token parity, a11y).

The main agent orchestrates, owns Phase 4 doc reconciliation, routes the universal final fidelity gate, and routes the conditional frame-finalization gate when Phase 2 authored or changed a frame.

## Tools and commands

- `/design` — user-run in Claude Code: `login`, `import`, `create`, `export`, `sync` (confirm surface once).
- `Read` over `DESIGN.md`, `docs/specs/*`, `apps/web/src`, `@openkit/core-client`, `docs/core/protocol.md` for intake.
- `pnpm --filter @openkit/web dev | test | typecheck | build`; `pnpm -w test:e2e:web` for the self-contained L4 browser gate.
- Playwright for frame-backed visual-regression evidence when available; the reference-composition ledger and human review for reference-backed fidelity; `biome` for lint/format.

## Notes

- Keep DESIGN.md as durable intent, never a pixel spec; keep Claude Design as a non-exhaustive visual-reference canvas; the token bridge and oracle ledger are the reconciliation anchors.
- "Fully unattended" is a non-goal. Every surface receives human fidelity review before merge; new or materially changed frames also require human finalization before implementation.
- When the confirmed `/design` surface or the A2UI/Spectrum tooling changes materially, update this cookbook and the stack spec together.
