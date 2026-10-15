---
status: Accepted
date: "2026-10-15"
decider: Coordinator and Consultant under engineer delegation
---
# Identifier Owner Declarations And Local User Authority

## Decision

P14 D1 permits UUIDv5 declarations only for producers whose accepted owners already supply the derivation and its complete inputs, trigger and retry/recovery semantics. Deterministic code alone is insufficient. Kind registration does not admit an undeclared producer. Independent allocation remains UUIDv7.

D3 permits complete JSON names and discriminators for active owner-backed producers. Explicit accepted ActorRef and owner-scope projections take precedence over inferred encodings. D4 resolves the implicit local human through one generated canonical User in the existing identity authority. It permits no per-boot allocation, replacement on missing authority, or separate lookup registry.

These realizations change no effect, admission trigger, retry, recovery operation or durable authority beyond the accepted local once-only allocation. Allocating owners retain exact names and lifecycle criteria. This record grants no reset effect or implementation-stage dispatch.

## Reason

Source: P14/coordinator-decisions.md and its adopted independent Consultant conditions in P14/consultant.md, both dated 2026-10-15 in the coordinator's backlog-20261015 working record. The coordinator selected D1, D3 and D4; the Consultant agreed with D1's per-producer authority condition and agreed with D3 and D4. The engineer's delegated acceptance permits their agreement to settle this bounded realization. P14/plan.md records the adopted conditions; proposed per-owner requests supply no authority themselves.

The accepted one-identifier decision selects output encoding while preserving owner inputs and lifecycle. Explicit names make that constraint implementable without treating deterministic code as design authority. One persisted local User applies once-only allocation and restart continuity to the existing identity owner. Missing authority must remain a failure rather than silently creating a different principal.

## Rejected Alternatives

- Blanket UUIDv5 admission from deterministic code would bypass each allocating owner's design authority.
- Fresh randomness as a derivation input would disguise independent allocation and would not preserve retry identity.
- A fixed local singleton, per-boot User, or separate lookup registry would conflict with canonical once-only User authority.
- Replacement identity on missing local state would conceal lost authority and could change ownership during recovery.

## Revisit When

Revisit if an accepted allocating owner does not supply a proposed derivation, its complete inputs or its lifecycle. A new governing derivation requires separate acceptance. Revisit local initialization if existing authority cannot distinguish fresh deployment from missing state; this decision admits no new initialization marker.

## Affected Owners

- [Core Identity](../core/identity.md)
- [Core AgentSession](../core/agent-session.md)
- [Core Protocol](../core/protocol.md)
- [Config And Identity Contract](../specs/20260628-nanocore_config_identity_contract.md)
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [Capability Usage Gateway Foundation](../specs/20260704-capability_usage_gateway_foundation.md)
