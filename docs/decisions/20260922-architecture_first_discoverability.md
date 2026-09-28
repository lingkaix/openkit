---
status: Accepted
date: "2026-09-22"
decider: Engineer
---
# Code Architecture Decides Whether Agents Can Work Efficiently

## Decision

Engineering-quality governance starts from the codebase's architecture and discoverability, not from more instructions. Related capabilities are gathered one by one into cohesive deep modules without changing behavior, with DDD and BDD applied in moderation and redundant code removed by ablation. A module is judged deep when callers must know fewer internal concepts, call orders, and compensation steps; a synonym facade does not count. Filesystem grouping, names, and entry points form the agent's working map, and guides point to the owning module and its real callers without a second API catalog. Before adding a capability similar to an existing one, an agent finds the nearest existing capability through guides and code search, checks its real callers, and states why it reuses it or why it does not apply. The engineer decides business semantics, module responsibilities, key seams, and governing trade-offs; agents implement inside those decisions without approval for each item, and an important interface change is first shown as a short call example with its errors and side effects.

## Reason

The engineer's words, translated from Chinese: "We need to gather related functions one by one into one deep module without affecting functionality, apply BDD and DDD reasonably, and remove redundant code through ablation experiments." The engineer treated a turn-status defect, already fixed, as a sign of code starting to rot, and named the cause: "in an ever larger codebase, agents cannot always accurately find code that already implements a given function." The engineer also stated the direction that what most affects AI programming output is neither the prompt nor AGENTS.md but the codebase itself, whose architecture decides whether AI can work in it efficiently, that the interface is left to the engineer's taste while implementation goes to AI and tests, and that an agent should be treated like a newcomer who joins twenty times a day.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, pilot direction; the pilot itself is change record 202609220000000001-engineering_quality_pilot.

## Rejected Alternatives

- Adding more principles to AGENTS.md alone. Rejected; existing principles already covered the ideas and prose cannot prove effect.
- A repository-wide domain, service, and repository layering. Rejected as high risk without present need.
- Clone detection and lint cleanup alone. Rejected as blind to semantic duplication; kept as an aid.
- Guides and prompts alone. Rejected because they cannot repair scattered responsibility.

## Revisit When

A discovery probe shows that agents find and correctly reuse existing capabilities without further consolidation, or consolidation repeatedly yields no caller simplification.

## Affected Owners

- docs/engineering-doctrine.md
- docs/roles/builder.md
- docs/roles/reviewer.md
- AGENTS.md
