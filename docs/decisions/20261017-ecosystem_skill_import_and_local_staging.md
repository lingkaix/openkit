---
status: Accepted
date: "2026-10-17"
decider: Engineer and coordinator
---
# Ecosystem Skill Import And Local Staging

## Decision

Follow the pinned MIT vercel-labs/skills source, discovery and frontmatter conventions so ordinary ecosystem repositories need no OpenKit manifest or payload rewrite. Port the required stateless behavior with its license notice instead of invoking the upstream CLI at runtime. NanoCore retains catalog authority, immutable versions, current authorization, review, Audit and selection.

Permit the administrator CLI to bundle the existing stateless source parser, discovery, bounded local staging and tree validator for caller-local Skill upload. The exception includes no catalog storage, authority, publication, network acquisition or runtime implementation. Local staging sends one ordinary public import containing the selected tree; it does not send a caller-local path for Core to read.

## Reason

The engineer selected vercel-labs/skills as the reference on 2026-10-16 at 15:40 UTC and confirmed that an OpenKit implementation may follow its design at 16:15 UTC. The coordinator approved the narrow local CLI helper exception at 17:47 UTC. The coordinator's P20 handoff to L-GO on 2026-10-17 explicitly preserves both approvals. This record retains those accepted decisions; it introduces no broader exception.

The upstream CLI has no supported library entry and includes behavior that OpenKit does not need at runtime. Reusing only stateless admission helpers gives local uploads the same bounded tree semantics without duplicating catalog authority or requiring a NanoCore checkout in the installed CLI. The retained snapshot remains the version authority; a source locator is provenance and an explicit refresh input.

## Rejected Alternatives

- Running npx skills during product use would introduce upstream CLI execution and telemetry into an import that needs only acquisition and validation.
- Copying catalog storage or publication into the CLI would create another authority for version lifecycle and review.
- Sending local paths to Core would confuse the caller's filesystem with the server's filesystem.
- Requiring an OpenKit manifest would reject ordinary ecosystem packages that the engineer required OpenKit to accept unchanged.

## Revisit When

Revisit if the upstream project provides a supported stateless library that satisfies the same bounds and licensing requirements, or if an accepted product requirement needs behavior outside the listed helper exception.

## Affected Owners

- [Skill Catalog Versioning And Pinning](../specs/20260711-skill_catalog_versioning_pinning.md)
- [Agent Operator Skill](../specs/20260910-agent_operator_skill.md)
