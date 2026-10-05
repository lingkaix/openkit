---
status: Accepted
date: "2026-10-05"
decider: Engineer
---
# First-Release Lifecycle And Verification Scope

## Decision

On 2026-10-05 the engineer approved the reduced runtime lifecycle route from the independent challenge of the larger lifecycle proposal. Option B means evidence values on the existing Harness and Turn barrier under the [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md), without a new boundary specification. One static adapter declaration, bound to the adapter and image digest and checked by Core, replaces runtime-name admission. Work lands as one shared change followed by per-adapter changes in any order, rather than the full milestone program.

The execution-layer findings retain their existing owners. LB-02, the structural-retention producer gap, wires the existing structural collector. LB-06, native inference-hint parsing in the generic Gateway, moves the existing Codex parser to the adapter side and keeps the existing hint type. LB-08A, contradictory OpenShell internalization assignments, reconciles the three sentences to the engineer's division: NanoHost owns native projection and transport; Core owns authorization and acceptance. Native policy rendering moves to NanoHost; refresh-status poller relocation is deferred until after release. Lifecycle budgets use one default table in code; the affected owner text states only monotonic deadlines, propagation of remaining time, reserved cleanup time, and no local extension of a Core lease. Existing separately owned drain and outage criteria remain with their owners.

Before the first release, fault verification consists of the existing shared heartbeat and barrier regressions plus a small number of cases for observed failure modes: a Pending Request lease case, a lost Harness poll response case, and a held `session.inspect` result case. Scripted peers for all four native protocols, the C1 through C12 scenario matrix, and the physical full chain move after release. These targeted cases establish their observed failure classifications; they do not claim to diagnose an unknown historical cause.

Dual-architecture real-host qualification of the NanoHost distribution runs only on GitHub-hosted `ubuntu-24.04` and `ubuntu-24.04-arm` runners, for each release and pre-release. The release CI pipeline tests and confirms distribution qualification at release and pre-release time. An engineer-provided amd64 machine serves as a development platform, rather than a distribution qualification host. Both distribution architectures remain in scope.

The release still requires that the platform does not crash and that data is neither lost nor corrupted, together with the [release exit criterion](20261005-release_exit_criterion.md). This ruling narrows the approved local full-chain fault-injection harness and the release gates of the convergence measure that also moved A2 onto the product installation path, while A2 deployment through the product installation path and A2 dogfooding continue. It does not remove A2 dogfooding or waive the release exit criterion. The broader fault program and poller relocation become post-release work.

## Reason

Faithful English rendering of the engineer's words: as long as the platform does not crash and data is not corrupted, OpenKit should fail fast and ship the release quickly so that more bugs and defects surface in real use, rather than build perfect and exhaustive tests. The reduced route addresses demonstrated lifecycle seams with existing owners and mechanisms. Release-time hosted qualification retains both NanoHost distribution targets while separating that proof from the development machine and continued A2 use.

Source: the engineer's 2026-10-05 rulings reproduced in the writer brief write-decisions-1005; the runtime lifecycle consultation and its independent challenge, and the amd64 NanoHost research, are supporting analysis rather than acceptance of an implementation.

## Rejected Alternatives

- The full M0 through M8 lifecycle program with a new boundary specification: its additional state dimensions, qualification machinery, sequencing and owner relocation exceed the reduced first-release route.
- The C1 through C12 matrix with scripted four-protocol peers before release: the engineer chose existing shared regressions and a few observed-failure cases, leaving the broader program after release.
- An engineer-provided host for distribution qualification: the selected qualification environment is the two GitHub-hosted runner targets; the supplied amd64 machine is for development.
- An arm64-only first release: the ruling retains amd64 and arm64 distribution qualification rather than narrowing the target set.

The explanations above describe the trade-offs of the ruling and supporting analysis; they are not additional quoted engineer statements.

## Revisit When

Proposed revisit conditions, not a separate engineer ruling: targeted regressions and real use expose a recurring failure that requires the deferred harness, hosted runners cannot provide trustworthy target-native distribution evidence, or a demonstrated defect requires moving the poller. Changes to release scope or qualification timing return to the engineer.

## Affected Owners

- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md): later lifecycle landings amend shared evidence and budget text where behavior changes, using this existing boundary owner.
- [Worker Control Protocol](../specs/20260703-worker_control_protocol.md): later landings align affected Harness and Turn-barrier evidence; existing heartbeat, drain and outage criteria remain here.
- [Work Data Retention Format](../specs/20260921-work_data_retention_format.md): LB-02 restores the existing producer obligation without adding a new criterion.
- [Worker Runtime Subagent Provenance](../specs/20260711-worker_runtime_subagent_provenance.md): LB-06 restores the existing adapter-owned mapping without replacing the hint contract.
- [OpenShell Mechanism Internalization](../specs/20260703-openshell_mechanism_internalization.md): the later LB-08A landing reconciles the three contradictory layer assignments and records the deferred polling relocation accurately.
- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md): later landings align native projection ownership and the distribution qualification environment and timing.
- [Test Strategy](../specs/20260529-test_strategy.md): later verification landings align first-release targeted coverage and post-release fault work.
- [Release Management](../specs/20260829-release_management.md): the release landing amends qualification timing and the narrowed convergence measures while retaining the release exit criterion and A2 dogfooding.
