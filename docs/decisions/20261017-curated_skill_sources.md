---
status: Accepted
date: "2026-10-17"
decider: Engineer and coordinator
---
# Curated Skill Sources

## Decision

Recommend [Anthropic Skills](https://github.com/anthropics/skills), [OpenAI Skills](https://github.com/openai/skills), and the [OpenKit repository Skills folder](https://github.com/lingkaix/openkit/tree/main/skills). The user chooses a source and one Skill, explicitly loads it through the existing catalog import, and chooses whether to use or update its retained version. Custom sources remain available under the same admission contract.

A recommendation is descriptive source metadata. It creates no installed entry, current selection, permission or background work. Loading from the Web source form retains an inactive version; the existing Use action selects it. Updates retain ordinary immutable versions, candidates, human decisions and pins. An App release does not load or update Skills automatically, and there is no release-bundled Skill feature.

OpenKit does not provide a generic Skill-authoring system. Users may select an authoring Skill from a source they choose. The unlanded openkit-bwm-author product package is removed from this increment; its general candidate lifecycle regression remains a test fixture. A future OpenKit-fitted BWM Meta-Skill requires its separate coordinator brief. B01 school-admissions intake and HTTP MCP stubs remain external validation artifacts.

## Reason

The engineer selected these three curated sources and explicit user choice at about 03:20 UTC on 2026-10-17, after excluding a generic OpenKit Skill author at about 03:05 UTC. The coordinator's 04:25 UTC RESUME assignment confirms the scope and defers Meta-Skill v1. Existing source admission and retained catalog authority serve this need without a new loader, registry or durable lifecycle.

## Rejected Alternatives

- Installing or updating recommended Skills with every App release would remove the required user choice.
- A separate source registry or loader would duplicate existing catalog admission without a present need.
- Shipping a generic OpenKit author would retain the product scope that the engineer excluded.

## Revisit When

Revisit when the engineer accepts another curated source or a separate authoring requirement. The future BWM Meta-Skill needs its own brief and does not reopen generic authoring by itself.

## Affected Owners

- [Skill Catalog Versioning And Pinning](../specs/20260711-skill_catalog_versioning_pinning.md)
- [Web Product Surface Projection](../specs/20260628-web_product_surface_projection.md)
