---
status: Accepted
date: "2026-10-15"
decider: Coordinator and Consultant under engineer delegation
---
# Skill Read Operation Invocation

## Decision

Acceptance of the #144 selected-Skills family requires each model-requested `skill.read` to use a definition-derived Tool and native Operation Invocation. The operation is release-authored and internal-only. Trusted assembly for the command-initiated Assistant Turn binds the exact retained Skill read closure. Public JSON, HTTP, OpenAPI, Core Client, CLI, remote MCP and Worker projections cannot expose or invoke it.

Operation Definition owns the private definition, exact implementation join, strict schemas, description, read-only posture and existing primary admission. Resource Integration retains selection, bounds, provenance, current resource and audience checks, and read failures. Trusted context must match the retained closure before content access. No runtime registration, durable binding store, retry, receipt or broader execution authority is added.

## Reason

Source: the coordinator's 2026-10-15 23:49Z skill-read invocation entry in later-routing.md and independent Astra Consultant 4cb436be's AGREED WITH CONDITIONS verdict in consultant-144-skill-read-invocation.md, both in the backlog-20261015 working record. The coordinator accepted option 2 with all conditions and withdrew provisional option 1. Conditions 3 and 4 provide the exact owner text. Their acceptance extends the existing public-definition and JSON-join contract to this bounded private operation; it does not claim the binding already exists.

Invoking the outer conversation command does not prove per-read invocation. The retained read closure already owns snapshot access and resource checks, so it remains the handler implementation behind the shared mechanism. Definition-derived projection and native invocation preserve one semantic schema and the existing effect boundaries without introducing a public endpoint or Skill-specific dispatch in the shared engine.

## Rejected Alternatives

- Outer-command invocation alone would leave each Skill read outside the accepted family cutover.
- A direct model Tool call to the read closure would bypass the required native invocation path.
- A public operation would broaden reachability without accepted authority.
- A separate handler or independently authored Tool schema would duplicate semantic ownership.
- Runtime registration or a durable binding store has no demonstrated need for this release-authored private binding.

## Revisit When

Return for a governing decision before exempting per-Tool invocation, adding a public capability or broadening Assistant admission. Keep the complete #144 delivery unit held for integrated acceptance. Required proofs include the real command-to-read path, refusal before content access on invalid context or authority, retained selection, evidence before model dispatch, correct inference accounting and zero duplicate effects. This decision supplies no implementation or family acceptance.

## Affected Owners

- [Operation Definition](../specs/20261002-operation_definition.md)
- [Internal Agent Resource Integration](../specs/20260909-internal_agent_resource_integration.md)
