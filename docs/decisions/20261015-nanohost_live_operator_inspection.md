---
status: Accepted
date: "2026-10-15"
decider: Engineer, through the coordinator on a Consultant-reviewed proposal
---
# Live NanoHost Inspection Through The Operator Channel

## Decision

Accept option C: use a bounded, read-only live NanoHost coordinator inspection through the independently authenticated operator channel, with nullable stored `physicalEpoch` on the existing server-admin runtime-target read for correlation only. [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md#live-operator-inspection) owns the inspection, process and connection binding, measurements and failure semantics. The observation trusts the selected operator channel and host OS; compromised host root is outside its guarantee. It grants no runtime, scheduling, credential or host-control authority and adds no runtime SSH fallback or automatic repair.

## Reason

On 2026-10-15 the coordinator accepted option C with Astra Consultant agreement and assigned the P02, P12 and P29 surfaces. An operator must establish that the actual running coordinator and its current native connection belong to the intended machine and verified release before a dependent effect. Stored state, configuration, historical logs, installed pathnames and version labels cannot prove that. The accepted join combines a fresh caller nonce, process incarnations, live NanoHost and Gateway executable-image measurements, effective unit state, verified archive attribution and the exact current ready identity, deployment, allocated generation and Epoch. A same-Epoch reconnect changes the connection correlation. The server field supplies correlation without replacing independent host evidence or expanding enrollment and attestation authority. This is an operator and OS trust guarantee, not hardware attestation.

Scrutiny source: Astra AGREED in consultant-wave1.md, section "P29 host observation", reviewing option C in P29-host-observation-proposal.md. The coordinator accepted that proposal and directed this owner amendment. The final P29-host-observation-contract.md supplies the unchanged consumer interface; these source names identify the accepted scrutiny, not additional behavioral authority.

## Rejected Alternatives

- A new server-mediated challenge and public observation API: introduces a larger product and enrollment trust design, while a server-mediated reply alone cannot defeat a malicious NanoCore without an independently accepted signing design.
- An operator probe without the stored Epoch projection: does not supply the chosen minimal public witness for the exact current connection join.
- Configuration, historical evidence or installed-path measurements alone: cannot prove the current coordinator, its running images or its native connection.
- Automatic repair, reenrollment, restart or retry after uncertain evidence: cannot establish the missing proof and is outside this read-only inspection.

## Revisit When

The operator channel or host OS can no longer be trusted, the allocated connection generation cannot be proved locally, or exact-build host observations show that process replacement, connection transitions or effective unit changes cannot be detected within the bounded inspection. A requirement for malicious-host resistance or hardware attestation needs a new accepted trust design; uncertainty does not relax the current stop condition.

## Affected Owners

- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
- [Deployment Host Requirements](../specs/20260909-deployment_host_requirements.md), for the existing machine identity digest.
- [Release Management](../specs/20260829-release_management.md), for separately owned archive attribution and joined release evidence.
