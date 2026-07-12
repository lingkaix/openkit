# Core Docs

Read `README.md` first. This file contains only local agent execution rules for core docs.

## Local Agent Rules

- Keep one aspect per document.
- Write in English.
- Keep these docs conceptual and implementation-neutral.
- Treat `docs/core/` as the canonical promoted model. Do not use archived `Superseded`, `Retired`, or `Rejected` specs as active decision logs.
- Before editing a core document, identify which aspect owns the terms being changed by checking the README term index.
- Define each canonical concept in exactly one owner document. Other core documents may project that concept into their aspect, but they must not redefine it.
- Replace duplicated concept definitions with cross-references to the canonical owner and keep only the aspect-specific projection.
- Keep or add an explicit owns / does-not-own boundary near the top of each aspect file when making substantial edits.
- Preserve distinct sections or equivalent content for purpose, principles, boundaries and non-goals, invariants, relationships to other core aspects, and abstract realization notes.
- Do not add `Open Points`, `Open Questions`, `Related Specs`, or direct `docs/specs/` references to core documents.
- Resolve stable decisions directly in core text; move unresolved or implementation-facing questions to specs, change records, roadmap, or working logs.
- Keep product-level mission, positioning, audience, and broad product direction in `docs/product-vision.md`; core aspect files should contain module-level principles only.
- When a spec promotes durable semantics, update the owning core aspect or record why the idea remains spec-only.
- Promote ideas into this folder only after the concept is clear enough to become part of the core model.
- Do not add implementation-specific fields before the abstract model is agreed.
- Prefer additive, versionable concepts.
- Keep adapter-native details out of core docs unless they are examples clearly marked as non-normative.
- Use README-defined requirement keywords when a sentence expresses a stable requirement.
- Do not add, remove, split, or merge core aspect documents without updating the README required aspect set, term index, and reading order.
- Split knowledge and agent-session into separate docs. Knowledge is reusable workspace understanding and learning; agent-session is runtime continuity.
- Split permissions and sandbox into separate docs. Permissions are authorization and policy decision semantics; sandbox is execution isolation and runtime environment design.
