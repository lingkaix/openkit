---
name: OpenKit Web UI
kind: design.md
status: Accepted
updated: 2026-10-09
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
    surface-card:   "--surface-card"                      # card on canvas (hairline, no shadow; DESIGN.md §7)
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
  appearance:                         # mode x style, all from Spectrum 2 tokens (see §4.5)
    mode:
      system: "follows the OS light or dark preference (default)"
      light:  "light color scheme"
      dark:   "dark color scheme"
    style:
      spectrum: "Spectrum 2 neutral grays, blue accent (default)"
      classic:  "Paper in light (warm grays, green accent), Noir in dark (warm near-black, gold accent)"
  worker-hue:                         # each named worker keeps ONE hue in both schemes
    Scout:  seafoam
    Quill:  purple
    Ledger: indigo
    Pixel:  orange
    You:    blue        # human = circle avatar
  typography:
    family-sans: "Source Sans 3"     # open substitute for Adobe Clean; self-hosted (OFL)
    family-code: "Source Code Pro"   # self-hosted (OFL)
    base:        "14px desktop · 17px touch (Spectrum 2 font-size-100)"
    scale:       "Spectrum 2 font-size ramp, desktop and mobile scales"
    weights:     "400 / 500 / 700 / 800"
  radius:
    sm: "4px"   # chips, checkboxes, swatches
    default: "8px"   # cards, inputs, menus, nav items, kanban cards
    lg: "10px"  # item cards, dialogs, generic page cards
    xl: "16px"  # composer, user message bubble
    full: "9999px"   # pills (buttons, chips, avatars, phases)
  spacing:
    scale: "2 · 4 · 8 · 12 · 16 · 24 · 32 · 40 · 48 · 64 (px, Spectrum ramp)"
    control-height: "24 sm · 32 md (default) · 40 lg desktop; 30 · 40 · 50 touch"
    min-touch: "44px hit area on a coarse pointer (drawn size follows the scale)"
  layout:
    min-viewport: "600×600 (desktop workbench floor — see §3.4 / §12)"
    posture: "desktop-first, responsive, NOT mobile-first"
  icons:
    set: "Spectrum workflow icons, baked as tintable data-URI masks (--ic-*)"
    render: "monochrome, currentColor tint, 18px default (16 sm / 20 lg)"
  logo:                               # see §8.2
    mark: "Orbit vortex O (three open bands) + three four-point stars"
    sizes: "golden ladder L(n) = 20 × √φ^n; every logo size is one step"
    gold: "mark #FFD65E → #FFC233 → #EE9F00 · stars #FFD860 → #F7B400 · wordmark #FFC53D → #EA9C00"
    wordmark: "the mark is the O of OpenKit; Nunito SemiBold 600, outlined"
    motion: "loader (full motion, loading) · standby (stars only, waiting / idle)"
    assets: "apps/web/public/brand/ · favicons in apps/web/public/"
---

# OpenKit — Design Guide (DESIGN.md)

This is the durable, canonical design guide for the OpenKit Web UI. It states design **intent** so future implementation, redesign, and AI-generated surfaces preserve the product's shape rather than re-deriving it. When code and this file disagree on presentation design, **this file is the source of truth**; accepted specifications remain the sole owners of product behavior. The Claude Design project (`7579f69f-4474-492b-bf09-b85e2ac9f56c`) is the living visual canvas that holds a non-exhaustive board inventory, the `openkit.css` reference implementation, and `themes.css`. A board is a visual-language and design-element reference, not a catalog entry that admits or excludes a product surface. The rationale behind this guide is captured inline — via the `(D-0xx)` citations and the **Decision record** in §18 — so this file stands on its own.

Read this alongside three files it depends on: [`docs/product-vision.md`](docs/product-vision.md) (why the product exists), [`README.md`](README.md) (the NanoCore-first / end-user Agent Skill + CLI-first posture and work model), and [`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md) (the implementation stack and the token-bridge contract this guide's tokens feed).

> **Not a pixel spec.** Keep this file as durable intent; keep Claude Design as the living visuals; keep the token bridge (§4.6) as the reconciliation anchor between them. Exploratory pixel detail stays in Claude Design, not here.

---

## 1. Overview — what OpenKit is, and what the UI must be

OpenKit is an **agent workspace**: a place to delegate real work to a team of agents, supervise it, preserve its artifacts and history, and improve the human + agents system over time. It coordinates mature agent runtimes (Codex, OpenCode, Pi Agent) through a small **Core**; it is not itself another agent runtime.

The product backbone is a single durable hierarchy:

```
Workspace → Thread → Turn → Item[]   (+ Artifact as a first-class durable output)
```

Everything the UI shows is a projection of that hierarchy. The interface's job is to answer, at a glance: who is responsible for what; how far the current work has progressed; what communication and handoffs happened between agents; which artifacts are done and which are in flight; and **when the human needs to step in, and when they can just watch the result.**

**The UI is a supervisor's instrument, not a chat toy and not a marketing page.** The first screen is the usable workbench. No landing page, hero section, or walkthrough shell precedes the product. It should feel like a dense, calm, professional tool — *capable but neat*.

**Posture note (2026):** the current implementation is NanoCore-first and the primary end-user agent path is remote MCP with its guide. The Web UI is the *visible follower* over stable NanoCore read models. The design must therefore make work legible **regardless of which channel initiated it** (see §9.7), and must stay honest when the Core it follows is unreachable (see §9.12, §11).

---

## 2. Design principles

These are the yardsticks. Every new surface is measured against them.

1. **Weak interaction by default; strong intervention always one gesture away.** (D-009, the strategic bet.) Agents proceed silently on an approved plan; the system pulls the human in only at key points (approval gates, blocked work, review); the human can walk in at any time (steer bar, card → thread). **The test for any proposal:** *does it ask the user for more ongoing involvement, or less — while keeping intervention cheap?* More = wrong direction. This exists because the productivity leap is **1:N supervision** (one person, five goals), not 1:1 chat, and because agent capability only grows — betting on per-card babysitting is betting on today's model defects.

2. **Capable but neat.** Carry conversation, artifacts, config, and supervision without clutter. Maximize useful screen area. Prefer tone shifts, grouping, and compact spacing over heavy borders and framed-in-framed cards.

3. **One info stream at a time.** Tabs/lenses over master-detail. A supervisor glances in and out; side-by-side density serves the high-frequency intervener we explicitly bet against (D-009).

4. **Legible, gateable, interruptible = trust.** The bottleneck to delegation is trust, not capability. Make work visible, make consequential actions gateable, and let the human interrupt at will.

5. **Plain language over jargon.** "Needs you," "Ready / Working / Needs attention." Non-technical end users are first-class; diagnostics and logs live behind progressive disclosure (D-003, D-004).

6. **Status is text + semantic color, never color alone.** (Accessibility and clarity.)

7. **Auditable by construction.** Every artifact and action answers "why" — traceable to a plan step, an initiator, and a time (D-010 #5).

8. **Small, durable, honest.** Don't ship inactive/decorative controls (no dead search box). Don't invent surfaces the kernel can't back — where a designed surface runs ahead of its kernel contract, keep it out of published navigation and routing until the contract is stable (see §11).

---

## 3. Information architecture & app shell

Two persistent regions, plus one optional auxiliary:

```
┌──────────┬─────────────────────────────────────┬───────────────┐
│ LEFT     │ MAIN (centered, single column)       │ AUX (optional)│
│ sidebar  │  ┌ compact stacked header ─────────┐ │  mirror/index │
│ 240px    │  │ crumbs · phase stepper · actions │ │  artifacts /  │
│          │  └──────────────────────────────────┘ │  approvals /  │
│ nav +    │                                        │  log — never  │
│ context  │  vertical flow: conversation …         │  required     │
│          │  ┌ composer dock (bottom) ──────────┐  │  48px collapsed│
│ Settings │  └──────────────────────────────────┘  │  strip        │
└──────────┴─────────────────────────────────────┴───────────────┘
```

### 3.1 Left sidebar — navigation & persistent context (240px)

Two modes; never mix them.

**App mode (default), WEB-UX B2.** The desktop sidebar and the phone drawer render the same content.
- **Brand row:** the OpenKit mark (§8.2) only. Search is not in the brand row; it is the Search row below.
- **Top block, in this order:** New (`/new`, ⌃N / ⌘N), Search (opens the global search palette, ⌃K / ⌘K), Needs you, Personal Assistant (`/assistant`), Artifacts, Knowledge, and Automations. New is the only work creation control in persistent chrome. Needs you carries a **needs-you count badge** (`ok-nav-count`) for the selected Workspace only, because `attention.list` reads one Workspace. The shell renders no persistent Search strip above routed main content.
- **Workspace groups:** one group per Workspace the caller belongs to. The selected Workspace comes first and is open; the others follow alphabetically and are closed. A closed group makes no read; it reads `conversation.navigation` when it opens. Each group has a header label with a disclosure chevron and a ⋯ menu, and holds **one Thread list**: no Assistant, Tasks or Goals headings and no split by type. Chat, Task and Goal are activities shown by the row glyph, not durable Thread kinds, so the shell must not infer or display a false partition.
- **Thread rows:** each row links to `/w/:workspaceId/t/:threadId`; the open Thread has `aria-current="page"`. The glyph shows the activity (Chat, Task, Goal, or Needs repair when the activity is unknown). Each row has one trailing indicator, in this order: the attention dot (Needs you), the unread reply count, then a working or Waiting for response spinner. A hover or focus tooltip and `aria-describedby` give the full name and description. A Task nests one level under its Goal by `thread.parentThreadId`; a deeper row flattens under its top ancestor and reads "via <parent>". Arrow keys move between rows and expand or collapse a parent. A group shows 15 top-level rows, then "Show N more". A failed read keeps the last rows and shows "Thread status unavailable" with "Retry Threads". Conversation navigation projects current or latest activity from authorized Goal, Turn, and Agent records. Active Goal context takes precedence; an unassigned Core Turn remains unknown. Working or actionable conversations sort before idle ones; within each bucket, actual Item/Turn/Goal activity sorts newest first with a stable Thread-id tie-breaker. Thread creation is the baseline for an empty conversation; renaming alone is not conversation activity. The navigation read model is a derived view, contains only visible active Threads, and introduces no durable kind or inferred Goal hierarchy. Unread reply counts project the authenticated User's receipts under the [User-owned Read Receipts owner](docs/specs/20260628-web_product_surface_projection.md#user-owned-read-receipts); a navigation read never advances those receipts.
- **Group ⋯ menu:** **Places:** Workspace settings, Members (general Workspaces only), then Catalog, Workspace changes, Recovery, Archived threads, Vault, and Usage & audit. **New:** New Thread here (the selected-Workspace starter at `/new`), New Task, and New Goal. **Show:** All, Chats, Tasks, or Goals, as single-select menu radio items. Choosing a place or a New item selects that Workspace first.
- **Footer:** New workspace follows the groups. The account row (avatar and Account, with Profile and Appearance) and the Settings gear sit at the foot. No destination is duplicated elsewhere in the sidebar, and the sidebar never scrolls horizontally.

**Settings mode:** the brand row and the selected-Workspace picker remain fixed while the navigation body swaps to a **Back to app** action and explicit scope groups. **Workspace** contains General when the selected Workspace is validated; General uses this same Settings shell at `/workspace`. **User** contains Account, Appearance, My admin access, New workspace, and Portability; **Server** contains Configuration and Models and providers; **Administration** contains Access tokens and Diagnostics. Appearance holds the persisted theme, an always-visible live preview, and the full component gallery as a collapsed **All components** disclosure; `/settings/appearance/components` opens it expanded and the retired `/settings/debug` address redirects to Diagnostics with a link to it. Catalog, Workspace changes, Recovery, Vault, and Usage & audit remain operational destinations in each Workspace group's ⋯ menu. Combining navigation does not combine authorization: General still reads and edits only the selected Workspace, while User and deployment categories retain their existing scopes. Settings categories are interactive navigation with an accessible current-page state and never create a second Settings sidebar inside the main panel.

**Names (one label per concept, WEB-UX B1).** The UI uses exactly these labels; the surfaces registry (`apps/web/src/app/surfaces.ts`) carries the same titles, and a banned-word test over `apps/web/src/**/*.tsx` string literals and JSX text keeps the replaced words out of daily UI (Details and Diagnostics may show records as they are).

| Concept | UI label | Replaces |
| --- | --- | --- |
| Personal conversation with the Core Assistant | Personal Assistant | Assistant, Chat, Personal Assistant (mixed) |
| Human attention queue | Needs you | Action Center, Overview (formerly "Mission control", D-003) |
| Thread | Thread in docs; a row shows only its name | Conversation |
| Activity type | Chat · Task · Goal | Worker Task |
| Unknown activity | Needs repair | Activity type unknown |
| Logical model route | Model | Logical model |
| Reasoning effort | Thinking (Low / Medium / High) | Effort |
| Timeline lens | Summary / All activity | Work / Full |
| Component gallery | Appearance > All components | Debug, Components, Developer tools |
| Admin evidence and snapshots | Diagnostics | Debug |
| Gateway admin | Models and providers | Gateway |

Banned in daily UI: ID strings, hashes, config file paths, "admission", "counted from records", "deterministic", "revision protected", "logical", and the replaced labels above.

**Routes (WEB-UX B1).** One route per destination; old addresses redirect and keep their search and hash.

| Destination | Route | Old address (redirects) |
| --- | --- | --- |
| Needs you | `/needs-you` | `/attention` |
| Personal Assistant | `/assistant`: opens the caller's personal-Workspace Assistant Thread with the documented `thread.create` opener (no message, no Turn) | `/chat` |
| New | `/new`: the selected-Workspace starter. Its first message goes to the caller's private Assistant Timeline in that Workspace, resolved by the documented private `thread.create` opener (Core gets or creates it). It is never picked from navigation rows, so it never reaches a shared Chat or a private Knowledge Manager Thread | — |
| Thread | `/w/:workspaceId/t/:threadId`: one route for Chat, Task and Goal; the page adapts to the activity | `/chat/:w/:t`, `/tasks/:w/:t`, `/goals/:w/:t` |
| Goal Artifact review | `/w/:workspaceId/t/:threadId/artifacts/:artifactId` | `/goals/:w/:t/artifacts/:a` |
| Search | `/search?q=` (palette via ⌃K / ⌘K) | — |

The Thread route takes its activity from the opener (a sidebar row, a redirected typed address, a new Goal), then from the navigation row, then Chat; the activity stays fixed for the visit.

### 3.2 Main panel — the focused work surface

- **Centered, single column, top-to-bottom.** Avoid left/right content splits inside the main panel unless a workflow *genuinely* needs comparison.
- **Compact stacked header** (~52px): breadcrumbs → current context, the goal **phase stepper** (§9.5) where relevant, and right-aligned actions.
- **Thread title bars are scarce space.** Preserve the longest practical Thread name before secondary state. Compact icon-only actions are preferred when the symbol is established and every control supplies an accessible name plus a hover and keyboard-focus hint. Rename, Archive, and Side panel use 20px non-shrinking glyphs in 32px square controls with zero horizontal padding. Rename and Archive sit immediately beside the Thread name because they act on it; the optional Side panel toggle occupies the far-right edge, leaving the center available for future Worker counts, Goal status, and other Thread state.
- **Conversation column** caps at ~760px, centered, `20px` gap between items.
- **Composer docked at the bottom** of every active work surface — the rule is: *on every surface, the bottom bar is where you talk to the AI* (D-007).

### 3.3 Right Side panel — optional auxiliary index, never required

The **Side panel** only mirrors and indexes Thread auxiliary information. Its current Chat projection is the Thread's Artifact and file-change index, not the global Artifact inventory; future accepted projections may add approvals, activity, Worker, or Goal context without making the panel canonical. D-006: turning it off must never block a core action. Its Approvals tab reads "Approve in conversation" and points back to the Thread; it carries "you *can* look," never "you *must* do." The Thread header toggles the panel. The conversation region keeps a 32rem minimum width within the supported workbench. The 15rem panel docks beside it only when the Thread container is at least 47rem wide; below that threshold it overlays the right side without changing the conversation or composer width. The non-modal panel includes its own Close control, which returns focus to the header toggle.

Because the rail is optional, **required actions surface through three non-rail channels** (D-006), by urgency: **(1) in-thread inline** (primary) — approval / needs-review cards grow next to the work (board 04); **(2) global queue + counts** — the Needs you queue + nav/workspace count badges; **(3) light toast** — transient, dismissible notice for background events, with a "View" action back to the source, never blocking.

### 3.4 Viewport floor — desktop workbench, 600×600

OpenKit is a **productivity/supervision tool**, so the design prioritizes the desktop workbench that shows the most information at once. **The supported minimum viewport is 600×600.** At widths below 800px, the left navigation defaults to closed and opens through a top navigation button as an overlay drawer, preserving the main column's readable width. At 800px and above it remains a persistent sidebar. The shell, centered main column, and composer dock must remain usable and free of horizontal overflow at the supported floor. See §12 for the full responsive contract (responsive, but **not** mobile-first).

---

## 4. Color & the theme system

OpenKit derives all color from **Adobe Spectrum 2** semantic tokens. Component markup references *semantic* tokens (surface / text / accent / status / skeleton), **never** raw palette swatches (`--spectrum-gray-200`, `--spectrum-red-100`, …) and never hard-coded hex. This single discipline is what lets the light and dark schemes swap cleanly under the same markup.

### 4.1 Core semantic roles

Values come from `@adobe/spectrum-tokens` (pinned exactly) through the generated bridge (§4.6). Light / dark below.

| Role | Token | Spectrum 2 source | Light / dark | Use |
|---|---|---|---|---|
| Accent | `--accent-background-color-default` | accent-background-color-default | `#3B63FB` / `#4069FD` | primary buttons, focus, send |
| Accent text | `--accent-content-color-default` | accent-content-color-default | `#3B63FB` / `#5681FF` | links, active nav text |
| On-accent | `--text-color-on-accent` | white | `#FFFFFF` | text/icon on accent fills (Noir: dark ink on gold) |
| On-negative | `--text-color-on-negative` | white | `#FFFFFF` | text/icon on the negative fill, every style |
| Text primary | `--text-color-primary` | heading-color | `#131313` / `#F2F2F2` | headings, key copy |
| Text default | `--text-color-default` | neutral-content-color-default | `#292929` / `#DBDBDB` | body |
| Text secondary | `--text-color-secondary` | neutral-subdued-content-color-default | `#505050` / `#AFAFAF` | supporting, meta, icons |
| Canvas | `--surface-page` | background-base-color | `#FFFFFF` / `#111111` | app background |
| Card | `--surface-card` | background-layer-2-color | `#FFFFFF` / `#222222` | cards on canvas |
| Sunken | `--surface-sunken` | background-layer-1-color | `#F8F8F8` / `#1B1B1B` | sidebar, chips, user bubble |
| Separator | `--separator-color` | gray-200 | `#E1E1E1` / `#323232` | hairlines |
| Border | `--border-color-default` | gray-300 | `#DADADA` / `#393939` | control borders |
| Selected | `--highlight-selected` | accent at 10% | | active nav, selection tint |
| Hover overlay | `--overlay-hover` | transparent-black-75 / transparent-white-75 | | row / item hover |
| Skeleton | `--surface-skeleton` | gray-200 | | loading placeholders (§9.12) |

### 4.2 Status colors — the status vocabulary

Status is **always text + semantic color**. Five families, mapped to a fixed vocabulary so the same state always reads the same way. A StatusLight (§9.3) draws the family's ink step as its dot beside default-color text; a Badge uses the Spectrum 2 subtle status background with a readable ink step of the same family; both resolve per color scheme (§4.5), so the *meaning* is constant while the *look* follows the scheme.

| Family | Words it owns |
|---|---|
| **Informative** (blue family) | Running · Executing · In progress · Streaming |
| **Notice** (orange family) | Needs review · Awaiting approval · Awaiting plan approval · Blocked |
| **Positive** (green family) | Done · Completed · Approved · Ready |
| **Negative** (red family) | Failed · Rejected · Error |
| **Neutral** (gray family) | Idle · Paused · Draft · Queued · Cancelled |

Do not invent new status hues, and do not reuse a family for a meaning outside its column.

### 4.3 Worker identity hues

Human = **circle** avatar with initials. Worker agent = **rounded-square** avatar with initials. Each named worker keeps **one hue on every surface and in both color schemes**; the step adapts to the scheme so initials stay readable (brand + identity never shift):

- **Scout → seafoam**, **Quill → purple**, **Ledger → indigo**, **Pixel → orange**, **You → blue**.

The canonical roster is **four workers** (Scout / Quill / Ledger / Pixel) plus the human (SW), kept consistent across all sample data (D-005).

### 4.4 Prohibitions

No decorative gradients, blurred/bokeh backgrounds, floating orbs, or hero compositions. No hard-coded stone/slate text classes. **No raw Spectrum global tokens and no ad-hoc hex, spacing, or radius literals in component markup** — only bridge-produced semantic tokens (§4.6). This is enforced mechanically by the token-parity check in the rebuild-stack spec.

### 4.5 Appearance: mode × style

Appearance has two independent choices (engineer decision 2026-11-18). **Mode** picks the color scheme; **Style** picks the look. Every scheme-dependent semantic token is a `light-dark()` value, so it resolves from the element's `color-scheme`; every style value comes from `@adobe/spectrum-tokens` through the generator (§4.6). Worker-identity hues and status families are the same in every style; the OpenKit logo (§8.2) is the same everywhere.

- **Mode.** **System** (default): the root declares `color-scheme: light dark` and follows the operating system's preference; `<meta name="color-scheme" content="light dark">` makes native controls and scrollbars follow too. **Light** / **Dark**: the user's override sets `data-color-scheme` on the document root.
- **Style.** **Spectrum** (default): Spectrum 2 neutral grays and the blue accent. **Classic**: **Paper** in light mode (warm gray layers with a paper page one step below white and lighter sheets, pine-green accent from the Spectrum green ramp) and **Noir** in dark mode (warm near-black layers on the Spectrum dark scale, gold accent from the Spectrum yellow ramp with dark text on it). Classic sets `data-style="classic"` on the root, so under System it follows the OS like Spectrum. Warm grays keep the OKLCH lightness of each Spectrum gray step and take the Spectrum brown hue at a small fixed chroma; text, borders, fills and layers all use them. Negative fills keep white text in every style.

**Switching model.** Both choices live in **Settings → Appearance** as compact sample cards with accessible radio labels: Mode (System shows light and dark halves in the current style) and Style (each card shows the schemes the current mode can show). They persist locally (`openkit-theme`) and restore on reload; earlier stored themes migrate (Spectrum becomes Light, Paper becomes Classic in Light, Noir becomes Classic in Dark). The choice never lives in a global header or on the sign-in page. Previews that must show a fixed scheme or style (the sample cards, the gallery's "Light and dark side by side" option) pin their own subtree with `.ok-scheme-light` / `.ok-scheme-dark` and `.ok-style-spectrum` / `.ok-style-classic` and never change the stored choice.

### 4.6 Token bridge (the reconciliation anchor)

A single bridge source file maps Spectrum tokens (global + semantic) to the OpenKit semantic theme consumed by code, and is the one place both color schemes are expressed for the app: `scripts/gen-tokens.mjs` writes `src/styles/spectrum.generated.css` (allowlisted Spectrum 2 tokens as `light-dark()` values, plus the Classic style: warm grays derived from the Spectrum gray and brown ramps and `--s2-classic-*` role values) from the pinned `@adobe/spectrum-tokens` package, and `src/styles/tokens.css` maps the semantic roles onto it. The **same values back both sides** of the design loop — the Spectrum design authored in Claude Design and the Tailwind theme compiled into `apps/web`. Component code consumes only these semantic tokens. Contract, parity test, and layer boundaries are owned by [`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md).

---

## 5. Typography

- **Sans:** `Source Sans 3` (open substitute for Adobe Clean); `Source Code Pro` for code, diffs, IDs, and protocol values.
- **Self-hosted.** Both families ship with the app as variable fonts (`@fontsource-variable`, SIL OFL 1.1) with `font-display: swap`; no font CDN.
- **Two scales, from the token package.** Sizes are Spectrum 2 `font-size-*` tokens with a desktop and a mobile value; the mobile value applies on a coarse pointer (`pointer: coarse`), not by viewport width. Body/UI 14px desktop, 17px touch (`font-size-100`); detail 12/15 (`font-size-75`); prose 16/19 (`font-size-200`); headings 18 · 22 · 28 desktop, 22 · 27 · 34 touch (S2 `heading-size-xs` · `-m` · `-l`). Type is compact and proportional to the surface: large headings only for page/section identity; smaller headings inside panels, sidebars, and repeated items.
- **Weights:** 400 body · 500 medium (nav, labels) · 700 bold (small headings, chips, buttons) · 800 heading weight (`font-heading`: every heading at a heading size — page, dialog and section titles, empty-state titles — and the wordmark). S2 sets `heading-sans-serif-font-weight` to extra-bold; the token test pins it. There is no 600 and no separate extra-bold utility (the surface-guard unit test fails on `font-semibold` / `font-extrabold`, and on a heading-sized heading without `font-heading`).
- **Line height:** heading 1.23 · UI 1.3 · body 1.5.
- **Letter spacing 0**, except all-caps eyebrows/kickers/section labels at `0.06em`. Never scale font size with viewport width.

Conversation message bodies (user bubble, assistant text, report) use prose (16 desktop / 19 touch) in the timeline and the preview; UI chrome stays at body size.

Key roles: page and dialog title `22px/800` (27 touch, S2 heading M); display `28px/800`; item-card title `14px/700`; body `14px/1.5`; meta & detail `12px`; micro labels / chips / counts `11px/700`; eyebrows `11px/700 uppercase +0.06em`.

---

## 6. Spacing, sizing & shape

- **Spacing ramp (px):** 2 · 4 · 8 · 12 · 16 · 24 · 32 · 40 · 48 · 64. Compact by default; group with tone and spacing, not boxes.
- **Control heights** are Spectrum 2 `component-height-*` tokens: S 24 · **M 32 (default)** · L 40 on desktop; 30 · 40 · 50 on a coarse pointer. Buttons, Pickers, text fields, nav rows and Tabs draw at the token height; dense contexts (card actions, inline approvals, toolbars) use S; L is for a rare emphasized call to action.
- **Hit area:** on a coarse pointer every button and link gets a centered 44×44px minimum hit area from a transparent pseudo-element, so the drawn control keeps its scale while touch stays at least 44px. A fine pointer keeps the drawn size (S2 desktop). Neighbouring controls keep at least 8px between them on touch, and small ones enough that the 44px areas do not overlap (ActionGroup). No global minimum height on buttons or inputs, and no 44px height override on a control (the scale-guard unit test fails on `h-11` / `size-11` / `min-w-11`; the composer action row is the one listed exception until slice B3).
- **Pill buttons:** side padding is the S2 pill edge-to-text token for the size (12 · 16 · 20 desktop, 15 · 20 · 25 touch). Minimum width is 3 × the height (S2's floor is 2.25 ×), so a one- or two-word label stays a slim pill, never a near-circle; the floor applies to plain-text labels only, not to icon buttons or toggles (a segmented choice such as Work | Full). Radius stays full (height / 2). Button sizes live in the CSS components layer, so a call site's utility can still override them.
- **Radius:** 4 chips/swatches · **8 cards, inputs, menus, nav, kanban cards** · 10 item/dialog cards · 16 composer & user bubble · full (pill) for buttons, chips, avatars, phase pills. Radii come from Spectrum's corner scale expressed as bridge tokens only — no ad-hoc literals.
- **Borders:** 1px default control border; 2px emphasized/selected/focus.
- Use stable dimensions for fixed-format controls (theme cards, composer, counters, badges); dynamic content must not resize surrounding layout.

---

## 7. Elevation & motion

- **Elevation is for floating layers only.** Resting cards, the decision card and Kanban cards have **no shadow**: they separate by tone (`layer-1`) or a hairline. Menus / popovers / toasts `0 4px 12px rgba(0,0,0,.14)`; dragged items lift; modals `0 12px 40px rgba(0,0,0,.24)`. In dark mode menus and dialogs also draw a 1px border (S2 popover border opacity 0 light / 1 dark). The surface-guard unit test allows `shadow-ok-card` only in the composer until slice B3.
- **Motion is quick and confident:** 130ms micro (hover/press), 160ms control, 190ms overlays, on `cubic-bezier(0.45,0,0.4,1)`. No long, showy transitions. **Motion guard:** under `prefers-reduced-motion: reduce` a base-layer rule ends every transition and animation at once (state changes stay, movement goes); e2e `surfaces.spec.ts` measures it.
- **Focus outline:** S2 keyboard focus is a 2px solid outline in the focus color, 2px off the control, always visible for keyboard use. It is an `outline`, never a box-shadow ring, so it survives forced colors and never paints a gap in the canvas color. Switch and radio draw it on their drawn control; a composite field (composer box) draws it on the box when its textarea has keyboard focus.

---

## 8. Iconography & logo

### 8.1 UI icons

- **Spectrum workflow icons**, monochrome, single-path, tinted with `currentColor`. Sizes are the S2 `workflow-icon-size` tokens: small 16 · medium 20 · large 22 on desktop, 18 · 24 · 28 on a coarse pointer. An icon without an explicit size follows its control: S controls (ActionButton / Button `sm`, the context tag) carry small icons, M controls medium, L controls large.
- Icons are baked as **tintable data-URI mask variables** (`--ic-*`); each `.ok-i` reads `--i:var(--ic-name)` (D-013 — external SVG mask files were tainted by the preview serve endpoint and rendered as solid squares; do not reintroduce them).
- In the implemented app, **Iconify + Remix Icon** is the runtime icon stack (unchanged from the prior app and confirmed by the rebuild-stack spec). Do not handcraft new SVGs when an appropriate icon exists. Icon-only controls must carry an accessible label.

### 8.2 The OpenKit logo

The logo is a brand asset, not a UI icon: it is gold in every theme and never takes `currentColor` (D-015). The generator (`apps/web/scripts/generate-brand.mjs`) owns every coordinate; this section owns the concept, the number system, and the rules the generator implements. Never hand-edit a generated asset; change the generator and regenerate.

**Concept.** A rotating vortex, read as a galaxy, a black hole, or a magic gate, forms the **O** of OpenKit: three nested open bands of different widths turn inward. A big four-point star sits in the outer band's opening, and two small stars circle the O toward the lower left. The feel is friendly and reliable, yet lively and imaginative: no sharp points anywhere (round band caps; the stars carry a thin round-join stroke that softens their tips), even spacing, and a loose, non-mechanical star rhythm.

**Number system.** Every logo size is one step of a golden ladder, `L(n) = 20 × √φ^n` with `√φ ≈ 1.27202`, so every two steps multiply by φ. Ladder values: L(2) 32.36 · L(1) 25.44 · L(0) 20.00 · L(−1) 15.72 · L(−2) 12.36 · L(−3) 9.72 · L(−4) 7.64 · L(−5) 6.01 · L(−6) 4.72 · L(−7) 3.71.

| Element | Step | Size |
| --- | --- | --- |
| O outer radius | L(2) | 32.36 |
| Big star half-height | L(0) | 20.00 |
| Lower-left star half-height | L(−4) | 7.64 |
| Upper star half-height | L(−5) | 6.01 |
| Outer, middle, inner band width | L(−4), L(−5), L(−6) | 7.64, 6.01, 4.72 |
| Radial space between bands | L(−7) | 3.71 |
| Big and lower-left star clearance to the bands | L(−7) | 3.71 |
| Upper star clearance to the bands | L(−5) | 6.01 |

These relations follow: the O radius is φ × the big star; each band is one step thinner than the band outside it, and the space between bands is the next step down; the two small stars have the sizes of the outer and middle bands; the big star and the lower-left star sit exactly one band space away from the bands, so they belong to the same rhythm as the bands.

**Fixed geometry (not sizes).**

- **Band openings:** 80°, 105°, and 150°, outer to inner, centred at 9:51, 5:30, and 1:30 on a clock face. The outer opening faces the big star so the star sits in its mouth; each opening is about 120° counter-clockwise from the one outside it. Inner openings stay off 12, 3, 6, and 9 o'clock, where the inner band reads as a glyph (a smile, a C, a horseshoe, or an @).
- **Spin:** each band runs clockwise from its opening and drifts inward by 2.4% of the O radius along its length, so the set reads as an inward spin.
- **Stars:** upright four-point stars with height : width = 20 : 15.5. Each side is a cubic Bézier whose control points sit 0.3 along its own tip and 0.07 toward the next tip. The stars sit at 9:51 (big), 8:12 (lower-left), and 11:51 (upper). Each star moves inward along its clock ray until its outline is its clearance away from the real band outline.

**Color.** The mark uses one diagonal gradient across the O, `#FFD65E` → `#FFC233` → `#EE9F00` from top left to bottom right. Each star uses `#FFD860` → `#F7B400`. In the wordmark, one vertical ramp from cap height `#FFC53D` to baseline `#EA9C00` covers both the O and the letters, so the O reads as a letter. Opaque assets use white (`#FFFFFF`) or the Noir canvas (`#1E1B14`).

**Wordmark.** The mark is the O, followed by "penKit" in Nunito SemiBold (600, SIL OFL 1.1). At this weight, the letters' stems match the visual weight of the bands. The O's outer diameter is 1.08 × cap height; at 1.32 × it read as an icon placed before a word. The O sits on the baseline with a 2% cap-height overshoot. The O-to-p distance is Nunito's own O-to-p ink gap (12.8 per 100 px of font size). Shipped assets carry the letters as outlines, so no asset depends on a web font.

**Small sizes.** The full mark is for 48 px and larger. Below 48 px, use the **small mark**: the bands and the big star, without the two small stars. A 16 px raster shows the bands only.

**Motion.** There are two animations, each for its own kind of scene. Both are pure CSS inside the SVG, with no script, so they work in `<img>`, as a CSS background, and inline.

- **Loader (full motion), for loading.** It plays an entrance once, then repeats a loop until it is removed.
- **Standby (stars only), for waiting and idle.** The vortex stays still and the three stars light one after another, in a loop.

The bands turn clockwise about the O centre, one full turn each, from the inside out. The stars light from the biggest to the smallest. The stars are dark while the bands turn, because the big star sits inside the outer band's mouth.

| Loader entrance (plays once) | Inner band | Middle band | Outer band | Big star | Lower-left star | Upper star |
| --- | --- | --- | --- | --- | --- | --- |
| Fade in | 0.00–0.60 s | 0.15–0.75 s | 0.30–0.90 s | — | — | — |
| Turn | 0.00–1.20 s | 0.15–1.35 s | 0.30–1.50 s | — | — | — |
| Light | — | — | — | 1.40–1.85 s | 1.60–2.05 s | 1.80–2.25 s |

| Loader loop, 3.2 s cycle (starts at 2.25 s) | Time in cycle |
| --- | --- |
| Full logo holds | 0.00–0.95 s |
| Stars go out together | 0.95–1.20 s |
| Inner, middle, outer band turn | 0.95–2.15 s, 1.10–2.30 s, 1.25–2.45 s |
| Big, lower-left, upper star light | 2.35–2.80 s, 2.55–3.00 s, 2.75–3.20 s |

- **Easing.** A band turn uses `cubic-bezier(0.45, 0, 0.2, 1)` and a band fade-in uses `cubic-bezier(0.25, 0.1, 0.25, 1)`. A star lights in two stages. First it rises for 0.25 s on `cubic-bezier(0.2, 0.7, 0.3, 1)`: opacity 0 → 1, scale 0.3 → 1.08, rotation −30° → 0°. Then it settles to scale 1 for 0.20 s on `cubic-bezier(0.4, 0, 0.6, 1)`. A star goes out in 0.25 s on `cubic-bezier(0.4, 0, 1, 1)`: opacity → 0, scale → 0.6.
- **Standby** uses the loader loop's cycle with opacity only. The bands stay visible and still. The stars hold, go out, and fade in at 2.35 s, 2.55 s, and 2.75 s (0.25 s each), every 3.2 s.
- **Reduced motion.** The loader follows `prefers-reduced-motion`. Under reduced motion, its bands fade in without turning, and then it runs the standby loop, so loading still shows progress without movement. Standby is opacity-only, so it is safe under every motion setting.

**Usage.**

- **Loader.** Use it for app-level loading before any content shape exists. Today that is the Web boot splash, which shows before the bundle mounts. Data loading inside a surface keeps skeletons (§9.12); never use the logo as a control spinner.
- **Standby.** Use it for waiting and idle states. No current surface uses it; a surface that adopts it records that here.
- **Logo motion and §7.** Logo motion is a brand moment and is exempt from the UI motion durations in §7. It never applies to controls.
- **Sidebar.** The sidebar brand row shows the static wordmark (§3.1).

**Asset kit.** The kit lives in `apps/web/public/brand/`:

- Square mark: transparent, white, and Noir backgrounds (SVG, plus 512 px PNG).
- Horizontal wordmark: transparent, white, and Noir backgrounds (SVG and PNG).
- Small mark (SVG).
- `openkit-loader.svg` and `openkit-standby.svg`.

The favicons live in `apps/web/public/`:

- `favicon.svg`: the small mark.
- `favicon.ico`: 16 px bands only, plus 32 px and 48 px small mark.
- `apple-touch-icon.png`: 180 px, full mark on the Noir canvas.

Regenerate the kit with `pnpm --filter @openkit/web brand:generate`. A unit test fails when the committed SVGs differ from the generator output.

---

## 9. Components & patterns

The component set below is also the **A2UI catalog seed** (D-011): generated surfaces may only compose whitelisted OpenKit primitives, always styled by us — a generated surface is indistinguishable from built UI except for a "Generated" tag. All class names are prefixed `ok-`.

### 9.1 Conversation items
- **User message** (`ok-msg-user`): soft sunken bubble, 16px radius, with a name and circular initials avatar. The authenticated human's messages and identity row align right and carry a You marker; other humans align left.
- **Assistant message** (`ok-msg-assistant`): left-aligned calm *unboxed* flow with a square avatar and a small identity meta row (avatar · author · time · optional `via` channel tag). Assistant report text renders Markdown with scoped semantic typography for headings, lists, links, quotes, and code. Headings start below the page heading; wide code and tables scroll within the message. Raw HTML stays literal, images remain text rather than loading external resources, and links cannot execute code. Human messages and raw diagnostic/evidence content remain verbatim; rendering never changes the stored message.
- **Item card** (`ok-item-card`): in-stream system events — mode transitions, task status, approvals, results. Two looks: a **decision** (needs your input, an approval request) is the one boxed item, a 10px card on `layer-1` with no border and no shadow, actions under the text; every other item is an unboxed **row** (20px kind icon in the family ink, title, meta). `data-item-look` exposes the look. Never louder than needed.

### 9.2 Composer (`ok-composer`)
This section is the visual projection of the observable Composer contract owned by `docs/specs/20260831-unified_conversation_composer.md`; that specification decides behavior when the two differ.

The Composer is one friendly rounded container with 16px radius, card surface, faint shadow, a visually spacious upper text-entry region, and one lower action row. The text-entry region is the first content inside the container, with no title or mode-label row above it. The larger chat starter and bottom-docked Thread form use the same component; exact sizing, growth, scrolling, and keyboard behavior are defined only by `docs/specs/20260831-unified_conversation_composer.md`.

The lower action row follows one fixed visual order: attachment `+`, conversation-target selector, flexible spacer, logical-model selector, and circular accent send button. `+` opens the existing Artifact reference and attachment upload chooser, with access to pre-send Advanced settings for an explicit Worker environment choice when starting Task work. Advanced settings default to a new environment; retained-environment provenance, eligibility and submission behavior are owned by the Composer specification. The target selector may show built-in Assistant, a running Coordinator, the Workspace Knowledge Manager, pinned warm workers, running worker Threads, and `New Shard + Worker`; that last label creates a new Task execution Thread and does not create a durable Shard entity. The model selector shows only logical model IDs and product-safe labels admitted for the selected target; it never exposes a Provider profile, Provider-native model, account slot, private route, Sandbox, Harness, process, or AgentSession identity.

Selected Artifacts and attachments appear as removable context chips between the text region and lower action row without changing their canonical owners. Enabled state, accessibility, failure retention, and keyboard behavior follow the owning Composer specification rather than being duplicated here.

### 9.3 Buttons, status, fields
- **Buttons** are Spectrum 2 pills in three sizes (§6: `sm` 24, `md` 32 default, `lg` 40 desktop) for the actions of a view or dialog. Roles: `accent` = the one main action of a view (at most one visible per view; `data-variant` exposes the role to the e2e check), `primary` = a strong neutral action, `secondary` = Cancel / Not now / Back, `negative` = only the confirmation step of a destructive action. Each role has `fill` and `outline` styles (secondary defaults to outline, the others to fill), plus a **disabled** state (disabled bg/content/border tokens). A Button never stretches across its container except in a phone dialog footer.
- **ButtonGroup**: Buttons 16px apart, wrapping; `align="end"` for dialog footers.
- **ActionButton**: toolbar, inline and repeated row commands (Copy, Retry, Open, More, composer tools) are ActionButtons, not Buttons: 8px radius, medium weight, the same S/M/L heights, S2 edge-to-text padding; `isQuiet` has no fill until hover (rows, headers, inline), the default has a gray fill (toolbars). Icon-only is square and carries a `title` hint.
- **ToggleButton**: an ActionButton with a selected state (a lens, Pin, Follow, a rating); `aria-pressed` follows the selection. Selected = neutral `primary` fill; a quiet toggle in a list selects with the row tint.
- **ActionGroup**: related ActionButtons or ToggleButtons in one labelled row, 8px apart. On a coarse pointer, `sm` controls sit 14px apart so their 44px hit areas do not overlap (§6).
- **Disclosure**: a section toggle (Notebook history, Maintain) is a quiet start-aligned ActionButton with a chevron and `aria-expanded`, never a full-width pill.
- **StatusLight**: a colored dot plus plain text in default text color, no fill (S2 StatusLight). The dot is the status family's ink (≥3:1 against the surface, §4.2); the word carries the meaning. Dot 10px medium / 8px small on desktop (12 / 10 touch). Lifecycle and health states use StatusLight, not a filled pill.
- **Badge**: a small filled label for counts and short categorical facts (a backend kind, `3 files`, `New`), 20px minimum height, 4px radius; `CountBadge` is the round count pill that renders nothing at 0.
- **Tag**: a gray, non-interactive label for context and provenance (composer context, `via Slack` channel attribution, §9.7); 24px high, small icon, truncates with the full value in its title.
- **Tooltip**: React Aria Tooltip on hover and keyboard focus, inverse fill (the toast tokens), at most 160px wide on desktop (200 touch); a short supplement, never the only place a fact lives. Icon-only controls get theirs from `title`.
- **Fields**: TextField, Picker (a single choice from a list; formerly Select), Switch and RadioGroup at the M height (32 desktop, 40 touch), 8px radius; default / focus / with-value / invalid / disabled states. In one form row a TextField, a Picker and an M Button share one height. **Labels** sit above the control in 12px regular muted text (`ok-field-label`), never bold; help and error text sit below in 12px. **Switch** track 26×16 (34×20 touch) with an inset handle; **Radio** circle 14px (18 touch), selected = thick accent ring; RadioGroup `look="cards"` keeps the card choice (theme pickers). Picker options show the selection with the row tint and bold text, no check glyph. Native controls or React Aria equivalents — never decorative divs.

### 9.4 Avatars, nav rows, count badges
Circle (human) / rounded-square (worker) avatars per §4.3, default and `sm` sizes. Nav items, workspace rows, thread rows, and workspace sub-items share one quiet row grammar (hover = `overlay-hover`, active = `selected` tint + accent text + bold). **Count badges** (`ok-nav-count`) mark required work outside the rail.

Conversation hover/focus hints are compact, non-interactive previews: show at most three title lines with contained overflow and keep the activity/state description separate. Prefer placement beside the rail (below the row when rows span the viewport, under 800px), constrain the hint to the viewport, and let pointer input pass through so adjacent navigation rows remain clickable. Keep the complete title in the row's accessible name and the conversation itself.

### 9.5 Goal phase stepper (`ok-phases`) — D-009
Replaces the lone status chip in the goal header: **Draft › Plan › Execute › Review**, current phase lit (informative, or notice if it's a gate). Blocked / paused detail stays on chips *inside* the content, never on the stepper. Present on goal boards 05 / 05b / 05c / 06 / 21.

### 9.6 Turn separators (`ok-turn-sep`)
A light labeled divider that groups the items of one **Turn** (a bounded execution step/attempt) without boxing the stream. Quiet by default; can carry a one-line note. Reflects the `Thread → Turn → Item` work model.

### 9.7 Channel attribution (`ok-via`) — D-008 → channel
Every item can say **where** it came from: a quiet `via remote MCP` / `via Slack` tag next to the initiator. This makes the Web UI the single visible layer for work driven from *any* channel.

### 9.8 Kanban (goal board lens, `ok-kanban`)
250px borderless columns on `layer-1` (10px radius; the header is the title plus a count Badge), 8px-radius shadowless cards with title + worker avatar + meta. **Drag = command, never free arrangement** (D-007): within-column = reprioritize; To do → In progress = "start now"; dragging into Done is forbidden (use the card menu's "Skip this step"). Card menu: Prioritize / Reassign / Skip / Pause. Cards open **back into the conversation** — the board indexes the thread, never a parallel world.

### 9.9 Artifact rows (`ok-artifact-row`)
Icon · name · meta (mono diff `+/−`, time). Artifacts are first-class durable outputs; a completed turn always leaves visible evidence of output, reachable from the main flow (board 12 adds a provenance rail: created-by, plan step, versions, evidence + a review gate).

Thread Artifact references expose View content in both the stream and side index. Both entry points distinguish saved outputs with their recorded version from file-change records with their change kind; titles and paths wrap in full instead of truncating. Specific Artifact types come from loaded content, never guesses from the title. Inspection reads the referenced Workspace and Artifact, displays only a matching version, and provides loading, retry and close controls. Workspace-change Artifacts show recorded paths and available text diff with full escaped content; recorded review status is historical evidence, not current decision authority.

### 9.10 Toast (`ok-toast`)
The only floating layer. Dark, ≥340px, bottom-center, with a "View" action and a close button. Transient, dismissible, non-blocking — for events that finished while the user was elsewhere (D-006 #3). The toast inverts the canvas: a dark fill on the light scheme and a light fill on the dark scheme.

### 9.11 Page scaffolding
`ok-page` (centered, ≤1080px, 24px gap), `ok-page-title` (22/800, S2 heading M), `ok-page-sub`, `ok-eyebrow`, `ok-card` (generic 10px card: hairline border, card fill, **no shadow**), `ok-list-row` (hairline-separated table rows). Cards are for repeated items, modals, and meaningful grouped controls — **not** for every page section, and never cards inside cards. Every hand-rolled card carries `ok-card` so the e2e nested-card query (`.ok-card .ok-card`) covers it; it is 0 on every main route.

### 9.12 System states and action outcomes — first-class

Because the Web UI is a *visible follower* over NanoCore read models, every data-backed surface MUST define what it shows when it is not in the populated, happy state. These are first-class patterns, not afterthoughts, and they resolve from semantic tokens only (never raw palette).

- **Loading (`ok-skeleton`).** Neutral placeholder bars on `--surface-skeleton`, shaped like the content they precede (a few lines for a card; rows for a list). Used while a read model is in flight. No spinners as the primary loading device.
- **Empty (`ok-empty`).** A calm centered block: a soft round glyph, a short title ("Nothing here yet"), one line of plain guidance, and a single primary action ("New chat"). First-run onboarding (board 18) is the app-level case of this pattern. Empty means the read succeeded and returned nothing; data that is unavailable, denied, or failed to load uses the error or disconnected treatment, never the empty one.
- **Error (InLineAlert).** An S2 in-line alert (2px family border, family icon at the end of the heading row, card fill): negative for a failure, notice for a blocked state the user can clear, informative for guidance. It carries a plain message and, when the owning operation allows a safe retry, a **Try again** action. Errors are stated in plain language; never a raw stack trace in the main flow (technical detail folds into Diagnostics, §13). A failed action keeps the user's relevant input for correction, except fields that the owning contract clears, such as secret material. **One alert per cause:** when several rows fail for the same reason (a locked Vault behind every provider's account list), the surface shows one alert naming the affected items and the one way out, not one banner per row.
- **Disconnected.** The specific, important error case: NanoCore is unreachable ("Couldn't reach NanoCore."). Because the whole app follows NanoCore, a disconnected state must be **globally legible** (a persistent, quiet banner/affordance), while per-surface content degrades to its `ok-error` or last-known read model rather than blanking out. Reconnect is retryable and does not lose the user's place.
- **Action outcomes.** An action the user starts shows a visible pending state until its owner settles it, then a plain success or failure. When the outcome is unknown, for example after a transport failure, the surface says so and offers only the inspection or retry that the operation's identity and effect contract allows.
- **Disabled.** Individual controls can use disabled bg/content/border tokens; a whole surface without a stable backing contract is unpublished rather than exposed as inactive product UI (§11).

### 9.13 Per-surface state matrix

Every Tier-A surface (§11) must specify all applicable states below before it is considered design-complete. "—" means the state does not apply to that surface.

| Surface | Loading | Empty | Error | Disconnected |
|---|---|---|---|---|
| Chat starter / thread (01–03) | skeleton stream | "Start a chat…" | inline banner on send failure | global banner; composer disabled with reason |
| Task thread (04) | skeleton items | — (always has the initiating turn) | inline banner | global banner; approvals read-only |
| Goal plan / live / thread / board / completed (05/05b/05c/06/21) | skeleton plan + stepper | plan not yet drafted | inline banner; plan stays visible on mutation failure | global banner; steer bar disabled |
| Artifact review (12) | skeleton preview + rail | no artifacts yet | banner + retry | global banner; review actions read-only |
| Needs you (07) | skeleton queue | "You're all caught up" | banner + retry | global banner; counts marked stale |
| Agents (08) | skeleton cards | no agents configured | banner + retry | global banner; readiness marked stale |
| Automations (references 09/11/22) | definition and history row skeletons | no schedules; create paused for an existing Thread | safe inline denial/conflict; preserve draft; explicit refetch; never replay an unknown write | global banner; last-known reads stay distinct and changes are disabled |
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
| Automations | 09 Automations + 11 Components + 22 Themes | Board 09 supplies a compact repeated schedule list beside the create panel. Board 11 supplies form fields, status chips, action groups, confirmation dialogs, focus and loading treatments; board 22 supplies semantic theme parity. Show fixed intervals, responsible user and definition lifecycle before expandable bounded occurrence/range history. Keep admission, scheduler and execution outcomes separate. The recurring owner and Web projection specification own authority, lifecycle and failure behavior. |
| Account access | 18 First run + 10 Settings + 11 Components + 22 Themes | Board 18 supplies the pre-workspace empty-state posture and centered entry focus; board 10 supplies compact form density and the Account placement for the authenticated action; board 11 supplies the existing name/email/password fields, buttons, inline status, disabled, and focus treatments; board 22 supplies light and dark scheme parity. Use neutral OpenKit account wording, the §3.4 viewport floor, and the §9.12-9.13 visual states. The Web projection specification owns admission, refetch, failure, privacy, and copy-truthfulness behavior. |
| Workspace members and invitations | 10 Settings + 11 Components + 22 Themes | Board 10 supplies selected-Workspace owner-management and account-level **My invitations** placements. Board 11 supplies compact rows, grouped-list semantics, menus, dialogs, confirmation, status, skeleton, and focus treatments; board 22 supplies theme parity. Keep the current owner and effective role legible before secondary metadata and collapse row actions into an accessible menu when space tightens. The Web projection and multi-user specifications own reachability, operations, lifecycle, errors, and privacy. |
| Thread Plane 1 Material workbench | 05c Goal thread + 12 Artifact review + 11 Components + 22 Themes | Board 05c supplies the Thread shell, lens posture, narrative continuity, and persistent steer composer; board 12 supplies precise review, provenance, comparison, and decision density; board 11 supplies tabs, editor, diff, revision controls, banners, and focus treatments; board 22 supplies theme parity. Keep Thread and Material as lenses rather than a permanent master-detail split, and let editor or comparison regions scroll internally. |

### 9.15 Overlays, tabs and data surfaces (S2)
- **Dialog** (`ok-dialog`, `Modal` + `Dialog` + `DialogFooter`): title in S2 heading M (22 / 27 touch) at the heading weight, optional quiet close ActionButton beside it; 10px radius, modal shadow, 24px padding; S2 standard widths **S 400 · M 480 (default) · L 640**, minimum 288. The footer is a right-aligned ButtonGroup at the end of the body: `secondary` Cancel before the one main action, 16px apart. Below the 800px shell break the dialog is a **full-height sheet** (no radius, no shadow), and the footer stacks full-width Buttons with the main action on top. Only `primitives/Dialog.tsx` and the app shell drawer use `ModalOverlay` (surface-guard unit test).
- **Popover and Menu** (`ok-popover`, `ok-menu-item`): 8px radius, menu shadow, 8px inset (S2 popover edge-to-content). Rows are M height (32 / 40) with an optional icon, a one-line description and a **shortcut slot** at the end; groups are titled **sections** split by a hairline. A row is named by its label; the description and shortcut reach assistive tech as its description. Pickers and composer menus share the popover.
- **Tabs** (`ok-tab-list`, `ok-tab`): no box behind the list; tabs 32 / 40 high, 24 / 30 apart (S2 compact tab item); the selected tab is bold strong text over a **2px indicator**; a hairline under the row.
- **Table** (`ok-table-row`, `ok-table-cell`): the S2 TableView look — **no outer box**; a 12px bold subdued header row; rows 40 / 50 with hairline separators and a hover tint; 12px cell padding, 16px at the table edges. Row commands live in one quiet **⋯ menu** in a last, unlabeled column (`rowActions`).
- **Progress and Meter** (`ok-progress-track`, `ok-meter-track`): a 12px label row with the value in muted text, then a rounded track; `size` **M 6 / 8 (default)** or **S 4 / 5** (S2 `progress-bar-thickness-*`, `meter-thickness-*`).

---

## 10. Interaction patterns (the weak-interaction system)

Ordered by how the D-010 roadmap prioritizes them.

1. **Needs you = home of 1:N supervision.** The default question is "where am I needed," not "how is this one goal." "Needs you" leads the page, sorted by waiting time; everything else is ambient awareness. Target: open once a day, clear every interrupt in ~90 seconds, close.
2. **Interrupts decidable without opening the goal.** Every "Needs you" row carries enough context to Approve / Skip / one-line-reply inline. Entering the goal is the fallback, not the required path.
3. **Catch-up card ("since you last looked").** A returning user's thread tops with an agent-written delta: done / blocked / next / plan changes (board 05c).
4. **Three lenses on one goal, one dataset** (D-008): **Thread** (time) · **Plan** (structure, live status chips) · **Board** (parallelism). Switching is free and loses no context. Default view follows the goal's phase: drafting / awaiting-plan-approval → Thread; executing → Plan (live); Board is always opt-in. Thread alone degrades gracefully to "a very capable conversation."
5. **Plan approval gate** (D-005): the trust contract before delegation. Pre-approval, every step reads **Planned**; execution chips appear only after approval. **Autonomy dials** sit at this gate (D-010 #4) — per-goal grants for which actions ask first (spend, send, delete) vs. auto-pass (read). The dial *is* the migration path from strong to weak interaction.
6. **Steer bar** = the bottom composer on goal surfaces; its replies live in the Thread lens. Intervention channel always open.
7. **Multiplayer: skeleton, not muscle** (D-008). Every instruction / approval / message carries an **initiator** now ("Approved by SW"); presence, @mentions, roles, and conflict resolution are deferred. The Thread view *is* the multiplayer surface; single-player is its degenerate case.
8. **Generative UI = A2UI** (D-011). A producer submits declarative JSON through Core admission; the client renders whitelisted OpenKit primitives by default, with one admitted PluginWidget delegate for isolated MCP Apps HTML. Arbitrary code cannot execute in the host DOM. In-thread presentations are **thread items**; saved reusable views retain separate definition identity under the Generative UI contract; user-visible action outcomes use existing attributed history; three states, no dead ends: **streaming skeleton → rendered → plain-content fallback** (an unknown component degrades to content, never a surprise executable frame; an admitted delegate has its own local failure and safe-load retry state). *The internal review surface remains unpublished until its Generative UI contract and implementation support publication (§11); only Kernel-backed views also depend on Kernel.*
9. **Reach while away** (D-010 #6, future mechanic): interrupts travel out (notifications / email digest) and are actionable in place.

---

## 11. Build scope — project accepted contracts, gate what the kernel can't back yet

Product-surface admission comes from accepted owning specifications, not from the presence or absence of a Claude Design board. The board inventory below is a bounded audit of the visual references and internal review surfaces present when this guide was reconciled; it is intentionally non-exhaustive and is not a functional-completeness checklist. The UI must stay **honest** (Principle 8): a surface whose kernel/protocol contract is not yet stable remains available only as an internal review implementation and is absent from published navigation and routing, never presented as inactive product UI or wired as if it were live. When its contract stabilizes, the surface moves to Tier A and receives its intended navigation placement as one coherent change. Traceability of each surface to its contract is owned by [`docs/specs/20260628-web_product_surface_projection.md`](docs/specs/20260628-web_product_surface_projection.md); the [Web delivery issue](https://github.com/lingkaix/openkit/issues/954) tracks deferred surfaces.

The current 24 reference boards (01–22, with 05b/05c) and their audited build tier:

**Tier A — live or current build target (kernel-backed today):**
- **Chat:** 01 starter · 02 thread · 03 thread + aux rail.
- **Task:** 04 task thread (inline approval-card pattern).
- **Goals:** 05 plan / approval gate · 05b plan live · 05c thread (catch-up + attribution + turn separators) · 06 board (kanban lens) · 12 artifact review · 21 goal completed. Goal development is frozen pending the Goal Mode Redesign ([decision](docs/decisions/20260928-goal_freeze_and_export_backup_boundary.md)); these surfaces stay published and unchanged until that Redesign reconsiders them.
- **Workspace:** 07 Needs you · 08 Agents · 14 Knowledge (minimal slice) · 18 First run · 19 Repositories (live selected-Workspace repository resources, diagnostics, durable push records, and the existing approval-gated push workflow). Worker-proposed-file Workspace Sync review→apply UX remains deferred and is not part of board 19's Tier-A scope; this tier classification does not claim browser proof or a real external push.
- **Channels:** 16 Channels now projects current-user Discord pairing, revocation, and delivery observations through the accepted Pending Request contract. Use board 16 rows with board 10 settings density, existing primitives, and the states in §9.12–9.13.
- **Automations:** 09 list and paused-create form with fixed intervals, revision-bound lifecycle controls and bounded persisted history (references 09/11/22), in selected-Workspace compact navigation.
- **Settings:** 10 Settings core · 15 Vault (read-only Workspace Vault references, grants, and use evidence) · 17 Usage & audit (read-only selected-Workspace capability usage, Workspace audit events, and Workspace permission decisions) · 20 Models and providers (Providers composing subscription accounts and Provider profiles, Models with effective metadata and its sources, and model routes with ordered targets and failover, behind the bounded deployment-admin gate) · 11 Components in Appearance → All components (every primitive and the native Generative UI catalog, rendered from fixtures, with no server data, visible to every user and rendered only when expanded) and Administration → Diagnostics (selected-Workspace evidence and package snapshots, and the home for future contract-backed inspection panels). Specimens and server inspection never share a page.
- **Reference-backed completion surfaces:** server-mode sign-up, sign-in, and sign-out (18/10/11/22), Workspace members and invitations (10/11/22), and the Thread Plane 1 Material workbench (05c/12/11/22). Their accepted specifications admit behavior; §9.14 owns only their deterministic visual composition.

**Tier B — built, unpublished (contract not yet stable):**

None.

**Tier C — deferred (needs prerequisite design first):**
- 13 Generative UI / A2UI: Chat Items of type `generative-ui-reference` already render in live Chat through the native A2UI host. The native-catalog specimens in Appearance → All components are design-review fixtures, not this shell. The standalone fixture shell and its three-state fallback remain an internal review implementation, omitted from published navigation and routing, until the independent interaction, persistence, and current-authority contract supports publication; Kernel-backed views additionally need the Kernel backend.
- A cross-goal board (D-001): deferred — its job overlaps Needs you.

---

## 12. Responsive behavior (desktop-first, not mobile-first)

OpenKit is a productivity and supervision tool; the design **optimizes for the desktop workbench** that surfaces the most information at once. It is **responsive but not mobile-first.**

- **Supported floor: 600×600.** The shell, centered main column, and composer dock stay usable and free of horizontal overflow down to 600×600. Below 800px the left navigation is a modal overlay drawer, closed initially and opened by a labelled top button. Escape, outside dismissal, an explicit close control, or selecting a navigation destination closes it; focus is contained while open and restored on dismissal. Resizing to at least 800px restores the persistent sidebar and dismisses the drawer; returning to a narrow viewport starts closed. App and Settings use this same shell behavior. The Thread auxiliary panel overlays rather than compressing the conversation when their combined minimum widths do not fit (§3.3); the main column keeps a readable width and never splits.
- **No horizontal overflow** at any supported size. Wide content (tables, kanban, diagrams, code) scrolls inside its own container; the page body never scrolls sideways.
- **Text fits** inside buttons, cards, theme previews, badges, and rows. Base typography uses overflow-wrap anywhere so long IDs and unspaced words wrap without expanding flex/grid minimum widths; ordinary words retain normal wrapping. Narrative and pre-wrapped JSON inherit it. Explicit whitespace-pre code/editor regions and wide tables retain their own horizontal scrolling. Compact context chips and selected labels truncate within their controls while preserving full accessible text and readable expanded choices. Never hide overflowing narrative content.
- **Below the floor / true mobile is out of scope for v1.** A phone-class layout is not a current deliverable; do not compromise desktop density to chase it. If a mobile form is pursued later it gets its own design pass (and pairs with the deferred Tauri packaging in `docs/product-vision.md`), rather than a mobile-first reflow of these surfaces.

---

## 13. Accessibility

- **State = text + semantic color**, never color alone (turn status, approval, agent health, artifact status, connection).
- Icon-only controls carry accessible labels; navigation regions carry clear `aria-label`s (Primary workspace navigation, Workspace threads, Settings sections, Conversation workspace).
- Collapsible workspace controls use stable generic labels ("Collapse/Expand workspace threads") so row names stay unambiguous.
- Native controls (button / input / select / checkbox / textarea) or **React Aria Components** — never decorative divs. Keyboard focus is always visible (§7).
- Every flow is operable by keyboard, and every control has an accessible name and state. A state change that matters to the current task, such as a pending action settling, a failure, or a disconnect, is announced to assistive technology, not only shown.
- Focus management fits the surface: a modal dialog or modal drawer contains focus and restores it on dismissal (§12), while a non-modal overlay such as the Side panel returns focus to its trigger when closed (§3.3) without trapping it.
- Progressive disclosure for anything technical: the Agents drawer opens to plain-language diagnostics first; logs/traces fold under a further "View details" (D-004). Diagnostics owns the protocol snapshot + event timeline and stays single-column.

---

## 14. Content & voice

- **Plain, calm, sentence-case.** "Needs you," "Approve in conversation," "Ready / Working / Needs attention." Prefer nouns a non-technical operator understands.
- Don't pad with filler. Every stat, icon, and row earns its place.

---

## 15. Do's and Don'ts

**Do**
- Start on the working surface; keep the main panel centered and vertical.
- Surface required work in-thread and in the Needs you queue + counts.
- Use the fixed status vocabulary, fixed worker hues, and the two appearance styles (§4.5).
- Define loading / empty / error / disconnected states and action outcomes for every data-backed surface (§9.12–9.13).
- Keep the phase stepper for lifecycle, StatusLights for point-in-time state.
- Let cards open back into the conversation; keep the rail as a mirror.
- Reference semantic bridge tokens only; keep not-yet-backed surfaces unpublished.

**Don't**
- Add a landing page, hero, or marketing empty shell.
- Split the main panel left/right without a real comparison need.
- Make the right rail (or any single channel) *required* for a core action.
- Put Settings in top-right chrome, or a second Settings sidebar in the main panel.
- Ship inactive/decorative controls, or wire a not-yet-backed surface as if live.
- Use color alone for state, raw palette tokens, ad-hoc hex/radius/spacing, decorative gradients, emoji, or handcrafted icons where a Spectrum/Remix icon exists.
- Let drag freely rearrange board cards, or allow a manual drag into Done.
- Compromise desktop density to chase a mobile-first reflow.

---

## 16. Implementation stack (summary; spec is authoritative)

The rebuilt `apps/web` is React + Vite, with **React Aria Components** for accessible behavior, **Adobe Spectrum tokens projected into Tailwind CSS v4** for styling (the token bridge, §4.6), **Zustand** for UI state, **TanStack Query** for server state over `@openkit/core-client`, **React Router** for routing, **A2UI** for generative surfaces (live Chat Items; the fixture shell is deferred, §11), and **Iconify + Remix Icon** for icons. SolidJS, daisyUI, and the old 35-theme catalog are removed. The full stack contract, layer boundaries, token-parity test, and rollout are owned by [`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md).

---

## 17. References

- Product direction — [`docs/product-vision.md`](docs/product-vision.md)
- Work model and NanoCore-first / end-user Agent Skill + CLI-first posture — [`README.md`](README.md)
- Implementation stack + token bridge — [`docs/specs/20260710-web_ui_rebuild_stack.md`](docs/specs/20260710-web_ui_rebuild_stack.md)
- Product-surface projection / traceability — [`docs/specs/20260628-web_product_surface_projection.md`](docs/specs/20260628-web_product_surface_projection.md)
- Deferred Web surfaces — [Web delivery](https://github.com/lingkaix/openkit/issues/954)
- Design→code workflow — [`docs/cookbooks/claude-design-web-ui-loop.md`](docs/cookbooks/claude-design-web-ui-loop.md)
- Decision record (rationale, internalized) — §18 of this guide
- Living visual canvas — Claude Design project `7579f69f-4474-492b-bf09-b85e2ac9f56c`
- Adobe Spectrum — https://spectrum.adobe.com/ · React Aria — https://react-spectrum.adobe.com/react-aria/ · A2UI — https://a2ui.org/
- `design.md` convention — https://github.com/google-labs-code/design.md

---

## 18. Decision record (D-001 … D-015)

The reasoning behind the guidance above, kept inline so this guide stands on its own. Newest first; each entry states the question, the decision, and why. The body cites these as `(D-0xx)`.

**D-015 · The OpenKit logo: an Orbit vortex O with three stars, sized on a golden ladder.** The four-tile quad brand mark is replaced by the logo in §8.2: three nested open bands of different widths form the O of OpenKit, the outer opening faces a big four-point star, and two small stars circle toward the lower left. Every size is a step of `L(n) = 20 × √φ^n`. The logo is gold in both color schemes. Motion has two forms by scene: a full-motion loader for loading, and a stars-only standby for waiting and idle, which is also the loader's reduced-motion form. *Why:* across twelve design rounds the engineer chose this over the Galaxy (wound arms) and Whirl directions, and chose the golden ladder over the Fibonacci and perfect-fourth ladders; the brief is friendly and reliable yet lively and imaginative, the mark doubles as the O so the wordmark reads as one word, and one ratio for every size gives the mark a numerical order the eye feels without measuring.

**D-014 · Boards are non-exhaustive visual references, not surface admission.** A current, contract-backed surface may compose deterministic visual intent from existing boards, tokens, themes, primitives, layout, density, states, responsive rules, and accessibility without receiving a dedicated Claude Design frame. Server-mode account access composes 18/10/11/22, members and invitations compose 10/11/22, and the Plane 1 Material workbench composes 05c/12/11/22. A new frame is required only when those sources leave genuinely new or ambiguous visual language, and every implementation still receives final human fidelity review. *Why:* behavior is admitted only by accepted specifications, while the visual canvas deliberately remains a reusable, non-exhaustive reference library.

**D-013 · Close the NanoCore-first surface gaps.** Added **Repositories** (a workspace owns repos; link → sync state → review→apply gate with an evidence bundle, distinct from artifact review because it lands a *change into a repo*), **AI interface** (makes the NanoCore-first, end-user Agent Skill + CLI-first posture visible), and **Goal completed** (the terminal state: verification evidence + follow-up decisions). *Why:* express what the Core already does before inventing new concepts; apply/attribution extend auditability (D-010 #5) to the code layer.

**D-012 · Audit the bounded vision surfaces.** Added artifact review, generative UI, knowledge, vault, channels, usage/audit, and first run; paid the phase-stepper, catch-up-card, inline-decidable-interrupt, and attribution debts on the boards in that audit. *Why:* make the then-current product direction visually inspectable; this bounded audit did not make the board set an admission catalog or require one dedicated board for every future contract-backed surface (D-014).

**D-011 · Generative UI = A2UI.** A producer submits declarative JSON through Core admission; the client renders whitelisted OpenKit primitives by default and a generic PluginWidget delegates specialized interaction to isolated MCP Apps HTML. Resource identity, bridge capabilities, and Core effects are governed; arbitrary code cannot execute in the host DOM. In-thread presentations are thread items; reusable views retain their own saved definition identity; user-visible action outcomes use existing attributed history; three states, no dead ends (streaming skeleton → rendered → plain-content fallback). *Why:* matches Core security boundaries, keeps the frontend small, and pairs with the NanoCore-first posture. The review shell remains unpublished until the independent Generative UI contract and implementation support publication (§10.8, §11 Tier C). Only Kernel-backed views additionally depend on Kernel. Plugins own specialized maps/canvases/timelines inside the delegate; layout, native siblings, accessibility, and authorized action routing remain with OpenKit. Start with A2UI v0.9 and target eventual v1.0 compatibility without waiting for upstream release.

**D-010 · The weak-interaction roadmap.** Six improvements, priority order: Needs you as the 1:N supervision home; interrupts decidable without opening the goal; the catch-up card; autonomy dials; auditable decisions; reach-while-away. *Why:* apply the D-009 yardstick to the whole product (§10).

**D-009 · ⭐ The strategic bet — weak interaction wins.** Chose *weak interaction* (delegate a large task, supervise, occasionally steer; 1:N) over *strong interaction* (continuous 1:1 per-card chat). *Why,* in order of weight: (1) **economics** — strong interaction caps at 1:1; 1:N supervision is the real productivity leap, and attention is the one resource that never gets cheaper; (2) **the capability curve moves one way** — autonomous task lengths keep growing, so betting on per-card babysitting bets on today's model defects; (3) **but trust, not capability, is today's bottleneck** — so the winning form is *interrupt-driven*: silent by default, pulled in at gates/blocks/review, walk-in anytime. Corollaries: tabs over master-detail for goal views; adopt the phase stepper. This is the yardstick for every future UI debate (Principle 1).

**D-008 · Goal Thread view; multiplayer-ready data, single-player UI.** Goal mode gets a **Thread** lens isomorphic with chat/task threads, so it degrades gracefully to "a very capable conversation"; the default lens follows the goal's phase. Every instruction/approval/message carries an **initiator** now ("Approved by SW"); presence, @mentions, roles, and conflict resolution are deferred. *Why:* the steer bar needs a home for its replies, and the Thread view *is* the multiplayer surface — single-player is its degenerate case, so no separate "Slack UI" is ever needed; Plan/Board are state projections and thus multiplayer-safe by construction.

**D-007 · Kanban is a lens, not a place.** The board is an opt-in projection of goal data; the default execution view is **Plan (live)**. Steer bar at the bottom; cards open back into the conversation; **drag = command** (reprioritize, or "start now"), never free arrangement, and never a manual drag into Done (use "Skip this step"). *Why:* the board's unique value is showing parallelism, but it must never become a parallel world that competes with the thread.

**D-006 · Required actions never live only in the right rail.** Surfaced through three non-rail channels by urgency: in-thread inline (primary), the Needs you queue + count badges, and a light toast. The rail only mirrors/indexes. *Why:* turning the rail off must never block a core action (§3.3).

**D-005 · The sample-data canon.** Four workers — Scout / Quill / Ledger / Pixel — plus the human (SW); goal step 6 "Final review with you" returns to the human with an "In review" chip. *Why:* one consistent canon across every board.

**D-004 · Agents-page depth.** Surface plain-language readiness ("Ready / Working / Needs attention"); technical diagnostics sit behind progressive disclosure ("View details"). *Why:* non-technical users are first-class and must not be confronted with logs.

**D-003 · "Overview," not "Mission control."** *Why:* plainer, Spectrum-calm, and better for non-technical users; the concept (global orchestration view) is unchanged. *Superseded in WEB-UX B1:* the surface is named **Needs you** (§3.1 Names).

**D-002 · One Settings gear, no identity row.** *Why:* identity is not re-asserted on every page — full account info lives inside Settings.

**D-001 · Kanban stays single-goal (open / deferred).** A workspace-level cross-goal board is deferred because its job overlaps Needs you. *Why:* avoid a second status lens until real usage shows the need (§11 Tier C).
