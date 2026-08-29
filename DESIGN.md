---
name: OpenKit Web UI
kind: design.md
status: Accepted
updated: 2026-08-01
canonical: this file (repo root) is the single source of truth for OpenKit Web UI design
sources:
  - docs/product-vision.md                        # why the product exists
  - README.md                                     # NanoCore-first / end-user Agent Skill + CLI-first posture, work model
  - docs/specs/20260710-web_ui_rebuild_stack.md   # implementation stack + token-bridge contract
  - docs/specs/20260628-web_product_surface_projection.md  # projection boundary / minimum contract-backed areas
  - Claude Design project 7579f69f-4474-492b-bf09-b85e2ac9f56c (living visual canvas)
  - Adobe Spectrum 2 semantic design tokens (source of visual truth)

tokens:
  color-roles:                        # semantic roles — the ONLY things markup may reference (see §4)
    accent:         "--accent-background-color-default"   # primary action, active nav, focus, send
    on-accent:      "--text-color-on-accent"
    text-primary:   "--text-color-primary"                # headings, key copy
    text-default:   "--text-color-default"                # body
    text-secondary: "--text-color-secondary"              # supporting, meta, icons
    surface-page:   "--surface-page"                      # app canvas
    surface-card:   "--surface-card"                      # card on canvas (+ shadow, not border)
    surface-sunken: "--surface-sunken"                    # sidebar, chips, user bubble
    layer-1:        "--background-layer-1-color"          # aux rail, kanban columns
    separator:      "--separator-color"                   # hairline dividers
    border:         "--border-color-default"              # control borders
    selected:       "--highlight-selected"                # active nav / selection tint
    overlay-hover:  "--overlay-hover"                     # row / item hover
    surface-skeleton: "--surface-skeleton"                # loading placeholders (NEW §9.12 — never raw palette)
  status:                             # text + semantic color, fixed vocabulary (see §4.2)
    informative: running · executing · in progress · streaming
    notice:      needs review · awaiting approval · awaiting plan approval · blocked
    positive:    done · completed · approved · ready
    negative:    failed · rejected · error
    neutral:     idle · paused · draft · queued · cancelled
  themes:                             # three shipped themes (see §4.5)
    spectrum: "light · Spectrum blue accent · neutral gray ramp (default)"
    paper:    "light · warm paper canvas · deep pine-green accent"
    noir:     "dark · warm charcoal canvas · gold accent"
  worker-hue:                         # each named worker keeps ONE hue across every theme
    Scout:  seafoam
    Quill:  purple
    Ledger: indigo
    Pixel:  orange
    You:    blue        # human = circle avatar
  typography:
    family-sans: "Source Sans 3"     # open substitute for Adobe Clean
    family-code: "Source Code Pro"
    base:        "14px"
    scale:       "1.125 modular"
    weights:     "400 / 500 / 700 / 800"
  radius:
    sm: "4px"   # chips, checkboxes, swatches
    default: "8px"   # cards, inputs, menus, nav items, kanban cards
    lg: "10px"  # item cards, dialogs, generic page cards
    xl: "16px"  # composer, user message bubble
    full: "9999px"   # pills (buttons, chips, avatars, phases)
  spacing:
    scale: "2 · 4 · 8 · 12 · 16 · 24 · 32 · 40 · 48 · 64 (px, Spectrum ramp)"
    control-height: "28 sm · 32 md (default) · 40 lg"
    min-touch: "44px"
  layout:
    min-viewport: "800×600 (desktop workbench floor — see §3.4 / §12)"
    posture: "desktop-first, responsive, NOT mobile-first"
  icons:
    set: "Spectrum workflow icons, baked as tintable data-URI masks (--ic-*)"
    render: "monochrome, currentColor tint, 18px default (16 sm / 20 lg)"
---

# OpenKit — Design Guide (DESIGN.md)

This is the durable, canonical design guide for the OpenKit Web UI. It states design **intent** so future implementation, redesign, and AI-generated surfaces preserve the product's shape rather than re-deriving it. When code and this file disagree on presentation design, **this file is the source of truth**; accepted specifications remain the sole owners of product behavior. The Claude Design project (`7579f69f-4474-492b-bf09-b85e2ac9f56c`) is the living visual canvas that holds a non-exhaustive board inventory, the `openkit.css` reference implementation, and `themes.css`. A board is a visual-language and design-element reference, not a catalog entry that admits or excludes a product surface. The rationale behind this guide is captured inline — via the `(D-0xx)` citations and the **Decision record** in §18 — so this file stands on its own.

Read this alongside three files it depends on: [`docs/product-vision.md`](docs/product-vision.md)
(why the product exists), [`README.md`](README.md) (the NanoCore-first / end-user
Agent Skill + CLI-first posture and work model), and [`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md)
(the implementation stack and the token-bridge contract this guide's tokens feed).

> **Not a pixel spec.** Keep this file as durable intent; keep Claude Design as
> the living visuals; keep the token bridge (§4.6) as the reconciliation anchor
> between them. Exploratory pixel detail stays in Claude Design, not here.

---

## 1. Overview — what OpenKit is, and what the UI must be

OpenKit is an **agent workspace**: a place to delegate real work to a team of
agents, supervise it, preserve its artifacts and history, and improve the
human + agents system over time. It coordinates mature agent runtimes (Codex,
OpenCode, Pi Agent) through a small **Core**; it is not itself another agent
runtime.

The product backbone is a single durable hierarchy:

```
Workspace → Thread → Turn → Item[]   (+ Artifact as a first-class durable output)
```

Everything the UI shows is a projection of that hierarchy. The interface's job
is to answer, at a glance: who is responsible for what; how far the current work
has progressed; what communication and handoffs happened between agents; which
artifacts are done and which are in flight; and **when the human needs to step
in, and when they can just watch the result.**

**The UI is a supervisor's instrument, not a chat toy and not a marketing page.**
The first screen is the usable workbench. No landing page, hero section, or
walkthrough shell precedes the product. It should feel like a dense, calm,
professional tool — *capable but neat*.

**Posture note (2026):** the current implementation is NanoCore-first and the
primary end-user agent path is one `openkit` Skill with its bundled CLI. The Web
UI is the *visible follower* over stable NanoCore read models. The design must therefore make work
legible **regardless of which channel initiated it** (see §9.7), and must stay
honest when the Core it follows is unreachable (see §9.12, §11).

---

## 2. Design principles

These are the yardsticks. Every new surface is measured against them.

1. **Weak interaction by default; strong intervention always one gesture away.**
   (D-009, the strategic bet.) Agents proceed silently on an approved plan; the
   system pulls the human in only at key points (approval gates, blocked work,
   review); the human can walk in at any time (steer bar, card → thread).
   **The test for any proposal:** *does it ask the user for more ongoing
   involvement, or less — while keeping intervention cheap?* More = wrong
   direction. This exists because the productivity leap is **1:N supervision**
   (one person, five goals), not 1:1 chat, and because agent capability only
   grows — betting on per-card babysitting is betting on today's model defects.

2. **Capable but neat.** Carry conversation, artifacts, config, and supervision
   without clutter. Maximize useful screen area. Prefer tone shifts, grouping,
   and compact spacing over heavy borders and framed-in-framed cards.

3. **One info stream at a time.** Tabs/lenses over master-detail. A supervisor
   glances in and out; side-by-side density serves the high-frequency
   intervener we explicitly bet against (D-009).

4. **Legible, gateable, interruptible = trust.** The bottleneck to delegation is
   trust, not capability. Make work visible, make consequential actions
   gateable, and let the human interrupt at will.

5. **Plain language over jargon.** "Overview," "Needs you," "Ready / Working /
   Needs attention." Non-technical end users are first-class; diagnostics and
   logs live behind progressive disclosure (D-003, D-004).

6. **Status is text + semantic color, never color alone.** (Accessibility and
   clarity.)

7. **Auditable by construction.** Every artifact and action answers "why" —
   traceable to a plan step, an initiator, and a time (D-010 #5).

8. **Small, durable, honest.** Don't ship inactive/decorative controls (no dead search box). Don't invent surfaces the kernel can't back — where a designed surface runs ahead of its kernel contract, keep it out of published navigation and routing until the contract is stable (see §11).

---

## 3. Information architecture & app shell

Two persistent regions, plus one optional auxiliary:

```
┌──────────┬─────────────────────────────────────┬───────────────┐
│ LEFT     │ MAIN (centered, single column)       │ AUX (optional)│
│ sidebar  │  ┌ compact stacked header ─────────┐ │  mirror/index │
│ 264px    │  │ crumbs · phase stepper · actions │ │  artifacts /  │
│          │  └──────────────────────────────────┘ │  approvals /  │
│ nav +    │                                        │  log — never  │
│ context  │  vertical flow: conversation …         │  required     │
│          │  ┌ composer dock (bottom) ──────────┐  │  48px collapsed│
│ Settings │  └──────────────────────────────────┘  │  strip        │
└──────────┴─────────────────────────────────────┴───────────────┘
```

### 3.1 Left sidebar — navigation & persistent context (264px)

Two modes; never mix them.

**App mode (default):**
- **Brand mark** (4-tile quad: blue / seafoam / indigo / orange) + wordmark, top.
- **Pinned destinations:** Overview, Chat, Automations, New workspace. Overview
  carries a global **needs-you count badge** (`ok-nav-count`).
- **Knowledge** (D-012).
- **Scrollable middle:** workspace rows, each collapsible to reveal nested thread
  rows; a workspace with pending work shows a per-workspace count badge.
  **Repositories** is a pinned sub-item of a workspace (a workspace *owns* repos),
  and **Workspace settings** links directly to the selected Workspace's General settings.
- **Footer:** a single full-width **Settings** command. No stacked user-identity
  row — identity lives inside Settings (D-002).

**Settings mode:** the same sidebar swaps to a **Back to app** action + published Settings categories: Account (including My invitations and Sign out), General, Appearance, Vault, Usage & audit, and Debug (D-012, D-013). Deployment Configuration and Diagnostics remain absent until the separate server-admin Web surface has an accepted credential path; Channels and AI interface remain unpublished. Settings categories are interactive nav with an accessible current-page state — never a second Settings sidebar inside the main panel.

Naming: the home surface is **Overview** (formerly "Mission control") — plainer,
Spectrum-calm, better for non-technical users (D-003).

### 3.2 Main panel — the focused work surface

- **Centered, single column, top-to-bottom.** Avoid left/right content splits
  inside the main panel unless a workflow *genuinely* needs comparison.
- **Compact stacked header** (~52px): breadcrumbs → current context, the goal
  **phase stepper** (§9.5) where relevant, and right-aligned actions.
- **Conversation column** caps at ~760px, centered, `20px` gap between items.
- **Composer docked at the bottom** of every active work surface — the rule is:
  *on every surface, the bottom bar is where you talk to the AI* (D-007).

### 3.3 Right auxiliary rail — optional index, never required

The rail only **mirrors and indexes** (artifacts, approvals, activity log). D-006:
turning it off must never block a core action. Its Approvals tab reads "Approve in
conversation" and points back to the thread; it carries "you *can* look," never
"you *must* do." It collapses to a 48px icon strip.

Because the rail is optional, **required actions surface through three non-rail
channels** (D-006), by urgency: **(1) in-thread inline** (primary) — approval /
needs-review cards grow next to the work (board 04); **(2) global queue + counts**
— the Overview "Needs you" queue + nav/workspace count badges; **(3) light toast**
— transient, dismissible notice for background events, with a "View" action back
to the source, never blocking.

### 3.4 Viewport floor — desktop workbench, 800×600

OpenKit is a **productivity/supervision tool**, so the design prioritizes the
desktop workbench that shows the most information at once. **The supported
minimum viewport is 800×600.** The three-region shell, the centered main column,
and the composer dock must remain usable and free of horizontal overflow at that
floor. See §12 for the full responsive contract (responsive, but **not**
mobile-first).

---

## 4. Color & the theme system

OpenKit derives all color from **Adobe Spectrum 2** semantic tokens. Component
markup references *semantic* tokens (surface / text / accent / status / skeleton),
**never** raw palette swatches (`--spectrum-gray-200`, `--spectrum-red-100`, …)
and never hard-coded hex. This single discipline is what lets three themes swap
cleanly under the same markup.

### 4.1 Core semantic roles (Spectrum light reference)

| Role | Token | Light value | Use |
|---|---|---|---|
| Accent | `--accent-background-color-default` | `#0265DC` | primary buttons, active nav, focus, send |
| On-accent | `--text-color-on-accent` | `#FFFFFF` | text/icon on accent fills |
| Text primary | `--text-color-primary` | `#000000` | headings, key copy |
| Text default | `--text-color-default` | `#222222` | body |
| Text secondary | `--text-color-secondary` | `#464646` | supporting, meta, icons |
| Canvas | `--surface-page` | `#FFFFFF` | app background |
| Card | `--surface-card` | `#FFFFFF` + shadow | cards on canvas |
| Sunken | `--surface-sunken` | `#F8F8F8` | sidebar, chips, user bubble |
| Layer 1 | `--background-layer-1-color` | `#FDFDFD` | aux rail, kanban columns |
| Separator | `--separator-color` | `#E6E6E6` | hairlines |
| Border | `--border-color-default` | `#D5D5D5` | control borders |
| Selected | `--highlight-selected` | accent @10% | active nav, selection tint |
| Hover overlay | `--overlay-hover` | `rgba(0,0,0,.04)` | row / item hover |
| Skeleton | `--surface-skeleton` | `#E6E6E6` | loading placeholders (§9.12) |

### 4.2 Status colors — the status vocabulary

Status is **always text + semantic color**. Five families, mapped to a fixed
vocabulary so the same state always reads the same way. Chips resolve their tint
from Spectrum status steps that each theme retints (§4.5), so the *meaning* is
constant while the *look* follows the theme.

| Family | Words it owns |
|---|---|
| **Informative** (blue family) | Running · Executing · In progress · Streaming |
| **Notice** (orange family) | Needs review · Awaiting approval · Awaiting plan approval · Blocked |
| **Positive** (green family) | Done · Completed · Approved · Ready |
| **Negative** (red family) | Failed · Rejected · Error |
| **Neutral** (gray family) | Idle · Paused · Draft · Queued · Cancelled |

Do not invent new status hues, and do not reuse a family for a meaning outside
its column.

### 4.3 Worker identity hues

Human = **circle** avatar with initials. Worker agent = **rounded-square**
avatar with initials. Each named worker keeps **one hue on every surface and in
every theme** (brand + identity never shift):

- **Scout → seafoam**, **Quill → purple**, **Ledger → indigo**, **Pixel → orange**, **You → blue**.

The canonical roster is **four workers** (Scout / Quill / Ledger / Pixel) plus
the human (SW), kept consistent across all sample data (D-005).

### 4.4 Prohibitions

No decorative gradients, blurred/bokeh backgrounds, floating orbs, or hero
compositions. No hard-coded stone/slate text classes. **No raw Spectrum global
tokens and no ad-hoc hex, spacing, or radius literals in component markup** — only
bridge-produced semantic tokens (§4.6). This is enforced mechanically by the
token-parity check in the rebuild-stack spec.

### 4.5 The three themes

OpenKit ships **three color themes**. All three are scoped overrides of the *same*
semantic tokens, applied by a class/attribute on the app root (`.ok-app` or the
document root). Nothing applied → the stock Spectrum light theme. Worker-identity
hues and the brand quad stay constant across all three; only surfaces, text,
borders, accent, and the status tint steps retint.

1. **Spectrum** — *the default, light.* Neutral Spectrum gray ramp, Spectrum blue
   accent (`#0265DC`). The reference look; also available as an explicit
   `.ok-theme-spectrum` reset so a Spectrum preview can render correctly *inside*
   a page already scoped to another theme (e.g. the Settings theme picker).
2. **Paper** — *light, cozy/relaxed (`.ok-theme-paper`).* A warm aged-paper canvas
   (`#E6DDC7`), low-chroma warm ramp, warm near-black ink (`#322F1E`), and a deep
   **pine-green** accent (`#2E5D45`). Cards lift one warm step off the paper via
   hairline + soft shadow rather than stark white. Status hues are kept (they read
   as meaning on the warm canvas). Row/hover overlays are warmed so they never go
   cool-gray.
3. **Noir** — *the dark theme (`.ok-theme-noir`).* A warm charcoal canvas
   (`#1E1B14`, never pure black), a **gold** ink ramp (body `#D4B15A`, headings
   `#EBCE7A`) and a **gold** accent (`#C6A24C`, hover lifts brighter per dark-mode
   convention), with dark ink on gold fills. Status tints are retuned to a warm
   auxiliary palette (grey-blue informative, bright-yellow notice, yellow-green
   positive, dusty-rose negative) so chips/glyphs/phase pills stay legible and in
   harmony with the gold instead of fighting it. `color-scheme: dark`.

**Switching model.** Theme choice lives in **Settings → Appearance**, shown as
compact preview cards (base surface + accent + a couple of status/neutral
samples), each with an accessible button label. The selection persists locally
and restores on reload. Theme switching never lives in a global header. The
reference implementation is `themes.css` in the Claude Design project; the token
bridge (§4.6) is where the same values enter the compiled Tailwind theme
(`apps/web/src/styles`).

### 4.6 Token bridge (the reconciliation anchor)

A single bridge source file maps Spectrum tokens (global + semantic) to the
OpenKit semantic theme consumed by code, and is the one place the three themes are
expressed for the app. The **same values back both sides** of the design loop —
the Spectrum design authored in Claude Design and the Tailwind theme compiled into
`apps/web`. Component code consumes only these semantic tokens. Contract, parity
test, and layer boundaries are owned by
[`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md).

---

## 5. Typography

- **Sans:** `Source Sans 3` (open substitute for Adobe Clean); `Source Code Pro`
  for code, diffs, IDs, and protocol values.
- **Base 14px** UI size on a **1.125 modular scale**. Type is compact and
  proportional to the surface: large headings only for page/section identity;
  smaller headings inside panels, sidebars, and repeated items.
- **Weights:** 400 body · 500 medium (nav, labels) · 700 bold (headings, chips,
  buttons) · 800 extra-bold (page titles, wordmark).
- **Line height:** heading 1.23 · UI 1.3 · body 1.5.
- **Letter spacing 0**, except all-caps eyebrows/kickers/section labels at
  `0.06em`. Never scale font size with viewport width.

Key roles: page title `26px/800`; item-card title `14px/700`; body `14px/1.5`;
meta & detail `12px`; micro labels / chips / counts `11px/700`; eyebrows
`11px/700 uppercase +0.06em`.

---

## 6. Spacing, sizing & shape

- **Spacing ramp (px):** 2 · 4 · 8 · 12 · 16 · 24 · 32 · 40 · 48 · 64. Compact by
  default; group with tone and spacing, not boxes.
- **Control heights:** 28 (sm) · **32 (md, default)** · 40 (lg). Minimum touch
  target 44px.
- **Radius:** 4 chips/swatches · **8 cards, inputs, menus, nav, kanban cards** ·
  10 item/dialog cards · 16 composer & user bubble · full (pill) for buttons,
  chips, avatars, phase pills. Radii come from Spectrum's corner scale expressed
  as bridge tokens only — no ad-hoc literals.
- **Borders:** 1px default control border; 2px emphasized/selected/focus.
- Use stable dimensions for fixed-format controls (theme cards, composer,
  counters, badges); dynamic content must not resize surrounding layout.

---

## 7. Elevation & motion

- **Elevation is subtle.** Resting cards `0 1px 4px rgba(0,0,0,.09)`; menus /
  popovers / toasts `0 4px 12px rgba(0,0,0,.14)`; dragged items lift more; modals
  `0 12px 40px rgba(0,0,0,.24)`. Prefer soft shadow + tone over borders.
- **Motion is quick and confident:** 130ms micro (hover/press), 160ms control,
  190ms overlays, on `cubic-bezier(0.45,0,0.4,1)`. No long, showy transitions.
- **Focus ring:** 2px accent ring, 2px offset — always visible for keyboard use.

---

## 8. Iconography

- **Spectrum workflow icons**, monochrome, single-path, tinted with
  `currentColor`. Sizes 18px default, 16 sm, 20 lg.
- Icons are baked as **tintable data-URI mask variables** (`--ic-*`); each `.ok-i`
  reads `--i:var(--ic-name)` (D-013 — external SVG mask files were tainted by the
  preview serve endpoint and rendered as solid squares; do not reintroduce them).
- In the implemented app, **Iconify + Remix Icon** is the runtime icon stack
  (unchanged from the prior app and confirmed by the rebuild-stack spec). Do not
  handcraft new SVGs when an appropriate icon exists. Icon-only controls must
  carry an accessible label.

---

## 9. Components & patterns

The component set below is also the **A2UI catalog seed** (D-011): generated
surfaces may only compose whitelisted OpenKit primitives, always styled by us — a
generated surface is indistinguishable from built UI except for a "Generated" tag.
All class names are prefixed `ok-`.

### 9.1 Conversation items
- **User message** (`ok-msg-user`): right-aligned soft sunken bubble, 16px radius.
- **Assistant message** (`ok-msg-assistant`): calm *unboxed* flow with a small
  identity meta row (avatar · author · time · optional `via` channel tag).
- **Item card** (`ok-item-card`): soft 10px card for in-stream system events —
  mode transitions, task status, approvals, results. An `ok-item-glyph`
  (informative/notice/positive/neutral) badges its kind. Never louder than needed.

### 9.2 Composer (`ok-composer`)
The friendly rounded input (16px radius, card surface, faint shadow). Holds
context **chips** (workspace, mode, model) and a circular accent **send** button.
Larger on the chat starter; docked at the bottom elsewhere.

### 9.3 Buttons, chips, controls
- **Buttons** are Spectrum pills, 32px: `accent` (primary), `outline`
  (secondary), `negative` / `negative-outline`, `quiet`, and `sm`, plus a
  **disabled** state (disabled bg/content/border tokens).
- **Status chip** (`ok-chip`): pill, 20px, optional dot, text + semantic color
  per §4.2.
- **Context chip** (`ok-ctx-chip`): pill, sunken, for composer context.
- **Fields** (`ok-input`, `ok-field`, `ok-switch`): 32px controls, 8px radius,
  accent focus; default / focus / with-value / disabled states. Native controls or
  React Aria equivalents — never decorative divs.

### 9.4 Avatars, nav rows, count badges
Circle (human) / rounded-square (worker) avatars per §4.3, default and `sm` sizes.
Nav items, workspace rows, thread rows, and workspace sub-items share one quiet row
grammar (hover = `overlay-hover`, active = `selected` tint + accent text + bold).
**Count badges** (`ok-nav-count`) mark required work outside the rail.

### 9.5 Goal phase stepper (`ok-phases`) — D-009
Replaces the lone status chip in the goal header: **Draft › Plan › Execute ›
Review**, current phase lit (informative, or notice if it's a gate). Blocked /
paused detail stays on chips *inside* the content, never on the stepper. Present on
goal boards 05 / 05b / 05c / 06 / 21.

### 9.6 Turn separators (`ok-turn-sep`)
A light labeled divider that groups the items of one **Turn** (a bounded execution
step/attempt) without boxing the stream. Quiet by default; can carry a one-line
note. Reflects the `Thread → Turn → Item` work model.

### 9.7 Channel attribution (`ok-via`) — D-008 → channel
Every item can say **where** it came from: a quiet `via openkit Skill` / `via
Slack` tag next to the initiator. This makes the Web UI the single visible layer
for work driven from *any* channel.

### 9.8 Kanban (goal board lens, `ok-kanban`)
250px columns on `layer-1`, 8px-radius cards with title + worker avatar + meta.
**Drag = command, never free arrangement** (D-007): within-column = reprioritize;
To do → In progress = "start now"; dragging into Done is forbidden (use the card
menu's "Skip this step"). Card menu: Prioritize / Reassign / Skip / Pause. Cards
open **back into the conversation** — the board indexes the thread, never a
parallel world.

### 9.9 Artifact rows (`ok-artifact-row`)
Icon · name · meta (mono diff `+/−`, time). Artifacts are first-class durable
outputs; a completed turn always leaves visible evidence of output, reachable from
the main flow (board 12 adds a provenance rail: created-by, plan step, versions,
evidence + a review gate).

### 9.10 Toast (`ok-toast`)
The only floating layer. Dark, ≥340px, bottom-center, with a "View" action and a
close button. Transient, dismissible, non-blocking — for events that finished while
the user was elsewhere (D-006 #3). Under Noir the toast keeps an explicit dark fill
(the gold ramp would otherwise invert it).

### 9.11 Page scaffolding
`ok-page` (centered, ≤1080px, 24px gap), `ok-page-title` (26/800), `ok-page-sub`,
`ok-eyebrow`, `ok-card` (generic 10px card), `ok-list-row` (hairline-separated
table rows). Cards are for repeated items, modals, and meaningful grouped controls
— **not** for every page section, and never cards inside cards.

### 9.12 System states (loading / empty / error / disconnected) — first-class

Because the Web UI is a *visible follower* over NanoCore read models, every
data-backed surface MUST define what it shows when it is not in the populated,
happy state. These are first-class patterns, not afterthoughts, and they resolve
from semantic tokens only (never raw palette).

- **Loading (`ok-skeleton`).** Neutral placeholder bars on `--surface-skeleton`,
  shaped like the content they precede (a few lines for a card; rows for a list).
  Used while a read model is in flight. No spinners as the primary loading device.
- **Empty (`ok-empty`).** A calm centered block: a soft round glyph, a short
  title ("Nothing here yet"), one line of plain guidance, and a single primary
  action ("New chat"). First-run onboarding (board 18) is the app-level case of
  this pattern.
- **Error (`ok-error`).** An inline banner (negative family) with a plain message
  and a **Try again** action. Errors are recoverable and stated in plain language;
  never a raw stack trace in the main flow (technical detail folds into
  Diagnostics, §13).
- **Disconnected.** The specific, important error case: NanoCore is
  unreachable ("Couldn't reach NanoCore."). Because the whole app follows
  NanoCore, a disconnected state must be **globally legible** (a persistent, quiet
  banner/affordance), while per-surface content degrades to its `ok-error` or
  last-known read model rather than blanking out. Reconnect is retryable and does
  not lose the user's place.
- **Disabled.** Individual controls can use disabled bg/content/border tokens; a whole surface without a stable backing contract is unpublished rather than exposed as inactive product UI (§11).

### 9.13 Per-surface state matrix

Every Tier-A surface (§11) must specify all applicable states below before it is
considered design-complete. "—" means the state does not apply to that surface.

| Surface | Loading | Empty | Error | Disconnected |
|---|---|---|---|---|
| Chat starter / thread (01–03) | skeleton stream | "Start a chat…" | inline banner on send failure | global banner; composer disabled with reason |
| Task thread (04) | skeleton items | — (always has the initiating turn) | inline banner | global banner; approvals read-only |
| Goal plan / live / thread / board / completed (05/05b/05c/06/21) | skeleton plan + stepper | plan not yet drafted | inline banner; plan stays visible on mutation failure | global banner; steer bar disabled |
| Artifact review (12) | skeleton preview + rail | no artifacts yet | banner + retry | global banner; review actions read-only |
| Overview / Action Center (07) | skeleton queue | "You're all caught up" | banner + retry | global banner; counts marked stale |
| Agents (08) | skeleton cards | no agents configured | banner + retry | global banner; readiness marked stale |
| Knowledge (14) | skeleton list | no entries yet | banner + retry | global banner; save disabled |
| Settings + sub-pages (10/15/16/17/20) | skeleton form | — | inline field/save error | global banner; save disabled |
| First run (18) | — | *is* the empty state | connect-runtime error inline | connect step shows retry |
| Account access (references 18/10/11/22) | stable form geometry | initial access form | inline status region without layout shift | persistent NanoCore banner; committing action disabled with reason |
| Workspace members and account-level My invitations (references 10/11/22) | Workspace management and My invitations row skeletons | owner remains visible; "No invitations" | preserve row geometry; inline status and retry placement | rows remain readable but stale; mutations disabled |
| Thread Plane 1 Material workbench (references 05c/12/11/22) | material header, editor, revision, and review skeletons | explicit Open material or New material entry when authorized | preserve draft and accepted revision; inline failure | draft and last-known revision remain visible; handoff state stale and mutations disabled |

### 9.14 Reference-backed surface composition

Claude Design boards are a non-exhaustive reference library. A surface is **frame-backed** only when one finalized frame is explicitly named as its implementation oracle. A surface is **reference-backed** when the ledger below composes existing visual-language references with this guide's tokens, themes, primitives, layout, density, system states, responsive rules, and accessibility requirements. Reference-backed work does not claim 1:1 fidelity to any one board and does not require a new target frame.

Accepted specifications alone own product behavior, operations, authority, lifecycle, conflict, privacy, and failure semantics. The reference composition below determines visual intent only. If those sources leave a genuinely new or ambiguous visual-language decision, author and human-finalize a new frame before implementation; the absence of a dedicated frame by itself is not ambiguity.

| Surface | Reference composition | Deterministic visual intent |
|---|---|---|
| Account access | 18 First run + 10 Settings + 11 Components + 22 Themes | Board 18 supplies the pre-workspace empty-state posture and centered entry focus; board 10 supplies compact form density and the Account placement for the authenticated action; board 11 supplies the existing name/email/password fields, buttons, inline status, disabled, and focus treatments; board 22 supplies Spectrum, Paper, and Noir parity. Use neutral OpenKit account wording, the §3.4 viewport floor, and the §9.12-9.13 visual states. The Web projection specification owns admission, refetch, failure, privacy, and copy-truthfulness behavior. |
| Workspace members and invitations | 10 Settings + 11 Components + 22 Themes | Board 10 supplies selected-Workspace owner-management and account-level **My invitations** placements. Board 11 supplies compact rows, grouped-list semantics, menus, dialogs, confirmation, status, skeleton, and focus treatments; board 22 supplies theme parity. Keep the current owner and effective role legible before secondary metadata and collapse row actions into an accessible menu when space tightens. The Web projection and multi-user specifications own reachability, operations, lifecycle, errors, and privacy. |
| Thread Plane 1 Material workbench | 05c Goal thread + 12 Artifact review + 11 Components + 22 Themes | Board 05c supplies the Thread shell, lens posture, narrative continuity, and persistent steer composer; board 12 supplies precise review, provenance, comparison, and decision density; board 11 supplies tabs, editor, diff, revision controls, banners, and focus treatments; board 22 supplies theme parity. Keep Thread and Material as lenses rather than a permanent master-detail split, and let editor or comparison regions scroll internally. |

---

## 10. Interaction patterns (the weak-interaction system)

Ordered by how the D-010 roadmap prioritizes them.

1. **Overview = home of 1:N supervision.** The default question is "where am I
   needed," not "how is this one goal." "Needs you" leads the page, sorted by
   waiting time; everything else is ambient awareness. Target: open once a day,
   clear every interrupt in ~90 seconds, close.
2. **Interrupts decidable without opening the goal.** Every "Needs you" row carries
   enough context to Approve / Skip / one-line-reply inline. Entering the goal is
   the fallback, not the required path.
3. **Catch-up card ("since you last looked").** A returning user's thread tops with
   an agent-written delta: done / blocked / next / plan changes (board 05c).
4. **Three lenses on one goal, one dataset** (D-008): **Thread** (time) · **Plan**
   (structure, live status chips) · **Board** (parallelism). Switching is free and
   loses no context. Default view follows the goal's phase: drafting /
   awaiting-plan-approval → Thread; executing → Plan (live); Board is always
   opt-in. Thread alone degrades gracefully to "a very capable conversation."
5. **Plan approval gate** (D-005): the trust contract before delegation. Pre-approval,
   every step reads **Planned**; execution chips appear only after approval.
   **Autonomy dials** sit at this gate (D-010 #4) — per-goal grants for which
   actions ask first (spend, send, delete) vs. auto-pass (read). The dial *is* the
   migration path from strong to weak interaction.
6. **Steer bar** = the bottom composer on goal surfaces; its replies live in the
   Thread lens. Intervention channel always open.
7. **Multiplayer: skeleton, not muscle** (D-008). Every instruction / approval /
   message carries an **initiator** now ("Approved by SW"); presence, @mentions,
   roles, and conflict resolution are deferred. The Thread view *is* the
   multiplayer surface; single-player is its degenerate case.
8. **Generative UI = A2UI in-thread** (D-011). Agent sends declarative JSON; the client renders whitelisted OpenKit primitives — no iframes, no arbitrary code. Surfaces are **thread items**; actions flow back as attributed items; three states, no dead ends: **streaming skeleton → rendered → plain-content fallback** (an unknown component degrades to content, never an error card or embedded frame). *The internal review surface remains unpublished until its kernel/policy contract lands (§11).*
9. **Reach while away** (D-010 #6, future mechanic): interrupts travel out
   (notifications / email digest) and are actionable in place.

---

## 11. Build scope — project accepted contracts, gate what the kernel can't back yet

Product-surface admission comes from accepted owning specifications, not from the presence or absence of a Claude Design board. The board inventory below is a bounded audit of the visual references and internal review surfaces present when this guide was reconciled; it is intentionally non-exhaustive and is not a functional-completeness checklist. The UI must stay **honest** (Principle 8): a surface whose kernel/protocol contract is not yet stable remains available only as an internal review implementation and is absent from published navigation and routing, never presented as inactive product UI or wired as if it were live. When its contract stabilizes, the surface moves to Tier A and receives its intended navigation placement as one coherent change. Traceability of each surface to its contract is owned by [`docs/specs/20260628-web_product_surface_projection.md`](docs/specs/20260628-web_product_surface_projection.md); deferral rationale is in [`docs/roadmap.md`](docs/roadmap.md).

The current 24 reference boards (01–22, with 05b/05c) and their audited build tier:

**Tier A — live or current build target (kernel-backed today):**
- **Chat:** 01 starter · 02 thread · 03 thread + aux rail.
- **Task:** 04 task thread (inline approval-card pattern).
- **Goals:** 05 plan / approval gate · 05b plan live · 05c thread (catch-up +
  attribution + turn separators) · 06 board (kanban lens) · 12 artifact review ·
  21 goal completed.
- **Workspace:** 07 Overview / Action Center · 08 Agents · 14 Knowledge (minimal slice) · 18 First run · 19 Repositories (live selected-Workspace repository resources, diagnostics, durable push records, and the existing approval-gated push workflow). Worker-proposed-file Workspace Sync review→apply UX remains deferred and is not part of board 19's Tier-A scope; this tier classification does not claim browser proof or a real external push.
- **Settings:** 10 Settings core · 15 Vault (read-only Workspace Vault references, grants, and use evidence) · 17 Usage & audit (read-only selected-Workspace capability usage, Workspace audit events, and Workspace permission decisions) · 11 Debug (developer component catalog and the home for future contract-backed inspection panels).
- **Reference-backed completion surfaces:** server-mode sign-up, sign-in, and sign-out (18/10/11/22), Workspace members and invitations (10/11/22), and the Thread Plane 1 Material workbench (05c/12/11/22). Their accepted specifications admit behavior; §9.14 owns only their deterministic visual composition.

**Tier B — built, unpublished (contract not yet stable):**
- 09 Automations (the automation facade is non-executing), 16 Channels, and 20 AI interface (provider-subscription status requires a separate server-admin Web authorization path). Retain their internal review implementations, but omit them from published navigation and routing until their contracts stabilize.

**Tier C — deferred (needs prerequisite design first):**
- 13 Generative UI / A2UI (post-v1: needs the render/safety + Generative-Kernel data-plane design). Retain the in-thread render *shell* and three-state fallback as an internal review implementation, but omit the surface from published navigation and routing.
- A cross-goal board (D-001): deferred — its job overlaps Overview.

---

## 12. Responsive behavior (desktop-first, not mobile-first)

OpenKit is a productivity and supervision tool; the design **optimizes for the
desktop workbench** that surfaces the most information at once. It is
**responsive but not mobile-first.**

- **Supported floor: 800×600.** The three-region shell, centered main column, and
  composer dock stay usable and free of horizontal overflow down to 800×600. At
  narrower widths the aux rail collapses to its 48px strip first, then the left
  sidebar collapses to icons; the main column keeps a readable width and never
  splits.
- **No horizontal overflow** at any supported size. Wide content (tables, kanban,
  diagrams, code) scrolls inside its own container; the page body never scrolls
  sideways.
- **Text fits** inside buttons, cards, theme previews, badges, and rows — wrap or
  truncate deliberately, never overlap.
- **Below the floor / true mobile is out of scope for v1.** A phone-class layout
  is not a current deliverable; do not compromise desktop density to chase it. If
  a mobile form is pursued later it gets its own design pass (and pairs with the
  deferred Tauri packaging in `docs/product-vision.md`), rather than a mobile-first
  reflow of these surfaces.

---

## 13. Accessibility

- **State = text + semantic color**, never color alone (turn status, approval,
  agent health, artifact status, connection).
- Icon-only controls carry accessible labels; navigation regions carry clear
  `aria-label`s (Primary workspace navigation, Workspace threads, Settings
  sections, Conversation workspace).
- Collapsible workspace controls use stable generic labels ("Collapse/Expand
  workspace threads") so row names stay unambiguous.
- Native controls (button / input / select / checkbox / textarea) or **React Aria
  Components** — never decorative divs. Keyboard focus is always visible (§7).
- Progressive disclosure for anything technical: the Agents drawer opens to
  plain-language diagnostics first; logs/traces fold under a further "View details"
  (D-004). Diagnostics owns the protocol snapshot + event timeline and stays
  single-column.

---

## 14. Content & voice

- **Plain, calm, sentence-case.** "Overview," "Needs you," "Approve in
  conversation," "Ready / Working / Needs attention." Prefer nouns a non-technical
  operator understands.
- Don't pad with filler. Every stat, icon, and row earns its place.

---

## 15. Do's and Don'ts

**Do**
- Start on the working surface; keep the main panel centered and vertical.
- Surface required work in-thread and in the Overview queue + counts.
- Use the fixed status vocabulary, fixed worker hues, and the three named themes.
- Define loading / empty / error / disconnected for every data-backed surface (§9.12–9.13).
- Keep the phase stepper for lifecycle, chips for point-in-time state.
- Let cards open back into the conversation; keep the rail as a mirror.
- Reference semantic bridge tokens only; keep not-yet-backed surfaces unpublished.

**Don't**
- Add a landing page, hero, or marketing empty shell.
- Split the main panel left/right without a real comparison need.
- Make the right rail (or any single channel) *required* for a core action.
- Put Settings in top-right chrome, or a second Settings sidebar in the main panel.
- Ship inactive/decorative controls, or wire a not-yet-backed surface as if live.
- Use color alone for state, raw palette tokens, ad-hoc hex/radius/spacing,
  decorative gradients, emoji, or handcrafted icons where a Spectrum/Remix icon exists.
- Let drag freely rearrange board cards, or allow a manual drag into Done.
- Compromise desktop density to chase a mobile-first reflow.

---

## 16. Implementation stack (summary; spec is authoritative)

The rebuilt `apps/web` is React + Vite, with **React Aria Components** for
accessible behavior, **Adobe Spectrum tokens projected into Tailwind CSS v4** for
styling (the token bridge, §4.6), **Zustand** for UI state, **TanStack Query** for
server state over `@openkit/core-client`, **React Router** for routing, **A2UI**
for generative surfaces (deferred, §11), and **Iconify + Remix Icon** for icons.
SolidJS, daisyUI, and the old 35-theme catalog are removed. The full stack
contract, layer boundaries, token-parity test, and rollout are owned by
[`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md).

---

## 17. References

- Product direction — [`docs/product-vision.md`](docs/product-vision.md)
- Work model and NanoCore-first / end-user Agent Skill + CLI-first posture — [`README.md`](README.md)
- Implementation stack + token bridge — [`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md)
- Product-surface projection / traceability — [`docs/specs/20260628-web_product_surface_projection.md`](docs/specs/20260628-web_product_surface_projection.md)
- Deferral roadmap — [`docs/roadmap.md`](docs/roadmap.md)
- Design→code workflow — [`docs/cookbooks/claude-design-web-ui-loop.md`](docs/cookbooks/claude-design-web-ui-loop.md)
- Decision record (rationale, internalized) — §18 of this guide
- Living visual canvas — Claude Design project `7579f69f-4474-492b-bf09-b85e2ac9f56c`
- Adobe Spectrum — https://spectrum.adobe.com/ · React Aria — https://react-spectrum.adobe.com/react-aria/ · A2UI — https://a2ui.org/
- `design.md` convention — https://github.com/google-labs-code/design.md

---

## 18. Decision record (D-001 … D-014)

The reasoning behind the guidance above, kept inline so this guide stands on its
own. Newest first; each entry states the question, the decision, and why. The
body cites these as `(D-0xx)`.

**D-014 · Boards are non-exhaustive visual references, not surface admission.** A current, contract-backed surface may compose deterministic visual intent from existing boards, tokens, themes, primitives, layout, density, states, responsive rules, and accessibility without receiving a dedicated Claude Design frame. Server-mode account access composes 18/10/11/22, members and invitations compose 10/11/22, and the Plane 1 Material workbench composes 05c/12/11/22. A new frame is required only when those sources leave genuinely new or ambiguous visual language, and every implementation still receives final human fidelity review. *Why:* behavior is admitted only by accepted specifications, while the visual canvas deliberately remains a reusable, non-exhaustive reference library.

**D-013 · Close the NanoCore-first surface gaps.** Added **Repositories** (a
workspace owns repos; link → sync state → review→apply gate with an evidence
bundle, distinct from artifact review because it lands a *change into a repo*),
**AI interface** (makes the NanoCore-first, end-user Agent Skill + CLI-first
posture visible), and **Goal completed** (the terminal state: verification
evidence + follow-up decisions). *Why:* express what the Core already does before
inventing new concepts; apply/attribution extend auditability (D-010 #5) to the
code layer.

**D-012 · Audit the bounded vision surfaces.** Added artifact review, generative UI, knowledge, vault, channels, usage/audit, and first run; paid the phase-stepper, catch-up-card, inline-decidable-interrupt, and attribution debts on the boards in that audit. *Why:* make the then-current product direction visually inspectable; this bounded audit did not make the board set an admission catalog or require one dedicated board for every future contract-backed surface (D-014).

**D-011 · Generative UI = A2UI.** The agent sends declarative JSON; the client renders only whitelisted OpenKit primitives — no iframes, no arbitrary code. Surfaces are thread items; actions flow back as attributed items; three states, no dead ends (streaming skeleton → rendered → plain-content fallback). *Why:* matches Core security boundaries, keeps the frontend small, and pairs with the NanoCore-first posture. The review shell remains unpublished until its kernel/policy contract lands (§10.8, §11 Tier C).

**D-010 · The weak-interaction roadmap.** Six improvements, priority order:
Overview as the 1:N supervision home; interrupts decidable without opening the
goal; the catch-up card; autonomy dials; auditable decisions; reach-while-away.
*Why:* apply the D-009 yardstick to the whole product (§10).

**D-009 · ⭐ The strategic bet — weak interaction wins.** Chose *weak interaction*
(delegate a large task, supervise, occasionally steer; 1:N) over *strong
interaction* (continuous 1:1 per-card chat). *Why,* in order of weight: (1)
**economics** — strong interaction caps at 1:1; 1:N supervision is the real
productivity leap, and attention is the one resource that never gets cheaper; (2)
**the capability curve moves one way** — autonomous task lengths keep growing, so
betting on per-card babysitting bets on today's model defects; (3) **but trust,
not capability, is today's bottleneck** — so the winning form is *interrupt-driven*:
silent by default, pulled in at gates/blocks/review, walk-in anytime. Corollaries:
tabs over master-detail for goal views; adopt the phase stepper. This is the
yardstick for every future UI debate (Principle 1).

**D-008 · Goal Thread view; multiplayer-ready data, single-player UI.** Goal mode
gets a **Thread** lens isomorphic with chat/task threads, so it degrades
gracefully to "a very capable conversation"; the default lens follows the goal's
phase. Every instruction/approval/message carries an **initiator** now
("Approved by SW"); presence, @mentions, roles, and conflict resolution are
deferred. *Why:* the steer bar needs a home for its replies, and the Thread view
*is* the multiplayer surface — single-player is its degenerate case, so no
separate "Slack UI" is ever needed; Plan/Board are state projections and thus
multiplayer-safe by construction.

**D-007 · Kanban is a lens, not a place.** The board is an opt-in projection of
goal data; the default execution view is **Plan (live)**. Steer bar at the
bottom; cards open back into the conversation; **drag = command** (reprioritize,
or "start now"), never free arrangement, and never a manual drag into Done (use
"Skip this step"). *Why:* the board's unique value is showing parallelism, but it
must never become a parallel world that competes with the thread.

**D-006 · Required actions never live only in the right rail.** Surfaced through
three non-rail channels by urgency: in-thread inline (primary), the Overview
queue + count badges, and a light toast. The rail only mirrors/indexes. *Why:*
turning the rail off must never block a core action (§3.3).

**D-005 · The sample-data canon.** Four workers — Scout / Quill / Ledger / Pixel
— plus the human (SW); goal step 6 "Final review with you" returns to the human
with an "In review" chip. *Why:* one consistent canon across every board.

**D-004 · Agents-page depth.** Surface plain-language readiness ("Ready /
Working / Needs attention"); technical diagnostics sit behind progressive
disclosure ("View details"). *Why:* non-technical users are first-class and must
not be confronted with logs.

**D-003 · "Overview," not "Mission control."** *Why:* plainer, Spectrum-calm,
and better for non-technical users; the concept (global orchestration view) is
unchanged.

**D-002 · One Settings footer, no identity row.** *Why:* identity is not
re-asserted on every page — full account info lives inside Settings.

**D-001 · Kanban stays single-goal (open / deferred).** A workspace-level
cross-goal board is deferred because its job overlaps Overview. *Why:* avoid a
second status lens until real usage shows the need (§11 Tier C).
