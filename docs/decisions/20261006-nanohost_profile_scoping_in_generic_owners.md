---
status: Accepted
date: "2026-10-06"
decider: Engineer
---
# NanoHost Profile Scoping In Generic Owners

## Decision

Scope the concrete NanoHost proof mechanisms in the scheduler, scale, and boot owners to the NanoHost profile, including their acceptance criteria. Preserve the generic safety predicates and existing NanoHost proof, credential, verification, reconnect, and cleanup ownership. This clarification admits no other backend or alternative proof contract; those require acceptance in the affected existing owners. The preparation-ordering reading is confirmed without a text amendment.

## Reason

The engineer approved this amendment on 2026-10-06 with 「两点我都同意。」. Translated, the engineer's approval: "I agree with both points." The first point is this amendment. Its reason is as the coordinator presented it: the paper-adapter probe and independent Consultant findings summarized below.

The documentation-only paper-adapter probe tested the accepted four operations and three dispositions against managed agents, our image on a sandbox vendor, and SSH-only resident machines. Its mappings supported that semantic boundary without qualifying any backend. The independent Consultant found that unqualified NanoHost proof requirements in the generic owners could make their concrete mechanisms mandatory in generic Core coordination. The Consultant proposed one scoping paragraph per owner and judged that the existing attempt-before-preparation and operation-before-effect rules already settle preparation ordering. The probe and Consultant reports are uncommitted research at `temp/research/2026-10-06-backend-port-probe/report.md` and `temp/research/2026-10-06-backend-port-probe/consult.md`. These paths record provenance, not behavioral authority. This clarification follows the [execution-backend decision](20261006-execution_backend_port_in_nanocore.md).

## Rejected Alternatives

- Leave the mechanism scope implicit: a literal rebuild could put NanoHost proof fields and backend-family branches into generic coordination.
- Rewrite the concrete NanoHost clauses or design alternative proofs now: neither is needed to delimit the existing profile, and the probe establishes no alternative qualification.
- Amend preparation ordering: the existing owners already require durable attempt inputs and operation identity before the first effect; the apparent ambiguity is a reading hazard rather than a missing rule.

## Revisit When

An actual backend proposal needs an alternative proof contract, or a rebuild or implementation check shows that the scoping paragraphs drop a generic predicate or leave NanoHost proof parsing in generic coordination. Such evidence reopens the affected owners; it does not admit a backend or weaken required proof by itself.

## Affected Owners

- [Durable Scheduler Design](../specs/20260703-durable_scheduler_design.md#summary)
- [Runtime Scheduling And Scale](../specs/20260703-runtime_scheduling_scale.md#summary)
- [NanoCore Bootstrap, Readiness, And Recovery](../specs/20260704-nanocore_bootstrap_readiness.md#contract--expected-behavior)
