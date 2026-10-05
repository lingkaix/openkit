---
status: Accepted
date: "2026-10-05"
decider: Engineer
---
# Transcript Item Exact-Value Guard

## Decision

Extend NanoCore's exact-value credential protection to canonical Item admission of worker transcript content. Every matched injected sensitive value is replaced with the fixed marker before the Item is created, and a match does not reject the reply. The comparison set and session loopback windowed digest check retain their existing owners; [Worker Control Protocol](../specs/20260703-worker_control_protocol.md#exact-value-protection-at-transcript-item-admission) owns Item coverage and missing-evidence behavior.

## Reason

OpenKit injected these values and knows them exactly, while [Vault](../core/vault.md) forbids secret material in Item logs. Protecting that known set does not conflict with the [2026-09-24 sensitive-data ruling](20260924-sensitive_data_handled_outside_the_system.md), whose use-dependent processing and residual exposure remain outside this system. Pattern heuristics would hide ordinary replies. Source: the engineer's 2026-10-05 ruling on LB-01, reproduced in the builder brief build-item-credential-guard; the execution-layer boundary audit supplies implementation evidence, not design authority.

## Rejected Alternatives

- Pattern heuristics at Item admission: credential-looking ordinary content must remain visible, and this change does not authorize generic DLP.
- Rejecting the whole reply on a match: the Item must still be created with the known value replaced.
- No Core-side guard: best-effort Sandbox Integration redaction does not discharge NanoCore's canonical admission responsibility or Vault's Item prohibition.

## Revisit When

The engineer changes the injected-value protection boundary or accepts a new transcript Item kind carrying worker-produced content.

## Affected Owners

- [Worker Control Protocol](../specs/20260703-worker_control_protocol.md)
- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md)
- [Work Resource Interaction Model](../specs/20260713-work_resource_interaction_model.md)
- [Vault](../core/vault.md)
